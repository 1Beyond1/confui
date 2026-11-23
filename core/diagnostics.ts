import { findNodeAtLocation, parseTree, type Node as JsoncNode } from "jsonc-parser";
import { lstat } from "node:fs/promises";
import { relative } from "node:path";
import type {
  ConfigFile,
  ConfigFormat,
  DiagnosticCategory,
  DiagnosticSeverity,
  FieldSpec,
  Locale,
  PathSegment,
  ProjectDiagnosticIssue,
  ProjectDiagnosticsOptions,
  ProjectDiagnosticsResult,
  ProjectScanResult,
} from "../shared/schema.ts";
import { maskDocumentLines } from "../shared/diff.ts";
import {
  containsSecretValuePattern,
  isForbiddenKey,
  isHexColor,
  isSafeRegexPattern,
} from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";
import { HARD_FILE_LIMIT, readTextSnapshot } from "./files.ts";
import { assertEditableSyntax, parseConfig, parseYamlDocuments } from "./formats.ts";
import { extractBaseName, stripBom } from "./formats/common.ts";
import { isSecretPath } from "./inference/common.ts";
import { findExampleFiles } from "./inference/examples.ts";
import { maskDocumentSecrets } from "./inference/heuristic.ts";
import { extractSchemaDirective, inferJsonSchemaFields } from "./inference/json-schema.ts";
import { inferKnownFields } from "./inference/known.ts";
import { readLimitedUtf8File } from "./inference/limited-text.ts";
import { mergeCandidates } from "./inference/merge.ts";
import type { FieldCandidate } from "./inference/types.ts";
import { ensurePathInsideProject, formatPath, getAtPath, pathKey, resolveExistingProjectPath, safeJoin } from "./paths.ts";
import { scanProject } from "./scanner.ts";
import { findLineForPath } from "./search.ts";

const DEFAULT_MAX_ISSUES = 500;
const MAX_ISSUES_CAP = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES_CAP = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 12;
const EXAMPLE_MAX_BYTES = 512 * 1024;
const MAX_WALK_DEPTH = 16;
const MAX_LEAVES_PER_DOC = 4_000;
const MAX_EXAMPLE_LEAVES = 2_000;
const MAX_REGEX_TEST_VALUE_LENGTH = 4_096;

const URL_STYLE_SECRET_KEY_RE = /(?:^|[._-])(?:url|uri|dsn|connection[._-]?string)(?:$|[._-])|(?:url|uri|dsn)$/i;
const PLACEHOLDER_OR_MASK_RE = /^(?:\*{2,}|•+|x{3,}|<[^>]+>|\$\{[^}]+\}|\$[A-Z_][A-Z0-9_]*|\{\{[^}]+\}\}|%\([^)]+\)s|(?:your|my|change|replace|insert|example|sample|dummy|mock|test|fake|placeholder|todo|redacted|masked)[_-]?.*|changeme|secret|password|token|none|null|n\/a|tbd)$/i;

export interface DiagnoseProjectRuntimeOptions extends ProjectDiagnosticsOptions {
  /** Optional abort signal for single-flight cancellation from main process. */
  signal?: AbortSignal;
  /** Optional already-scanned project snapshot. */
  preScanned?: Pick<ProjectScanResult, "root" | "files">;
  /** Opt-in remote SchemaStore lookup (strictly off by default). */
  enableSchemaStore?: boolean;
  /** Local disk cache directory for SchemaStore schemas. */
  schemaStoreCacheDir?: string;
  /** Custom fetch implementation (primarily for tests). */
  schemaFetcher?: typeof fetch;
}

interface ParsedDocSlice {
  index?: number;
  label?: string;
  value: unknown;
  sliceText: string;
  directiveText: string;
  lineOffset: number;
}

/**
 * Concurrently inspects all readable configuration files in a project and
 * reports categorized health diagnostics:
 *   1. `parse-error` — syntax/parsing failures (sanitized error details)
 *   2. `schema-violation` — JSON Schema / built-in template constraint violations
 *   3. `missing-from-example` — keys defined in companion `.env.example` / `*.example` files missing from the active config
 *   4. `plaintext-secret` — suspected plaintext secrets (location & key name ONLY; never returns secret values)
 */
export async function diagnoseProject(
  root: string,
  options: DiagnoseProjectRuntimeOptions = {},
): Promise<ProjectDiagnosticsResult> {
  if (typeof root !== "string" || !root.trim() || root.includes("\0")) {
    throw new ConfuiError("INVALID_INPUT", "项目路径无效");
  }
  const startedAt = Date.now();
  const locale: Locale = options.locale === "en-US" ? "en-US" : "zh-CN";
  const maxIssues = clampInt(options.maxIssues, DEFAULT_MAX_ISSUES, 1, MAX_ISSUES_CAP);
  const maxTotalBytes = clampInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1_024, MAX_TOTAL_BYTES_CAP);
  const concurrency = clampInt(options.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const signal = options.signal;

  if (signal?.aborted) {
    return emptyDiagnosticsResult(root, Date.now() - startedAt);
  }

  const scanned = options.preScanned ?? await scanProject(root);
  if (signal?.aborted) {
    return emptyDiagnosticsResult(scanned.root, Date.now() - startedAt);
  }

  const openable: ConfigFile[] = [];
  let skippedFiles = 0;
  for (const file of scanned.files) {
    if (file.status === "ready" || file.status === "large") openable.push(file);
    else skippedFiles += 1;
  }

  let scannedFiles = 0;
  let bytesBudgetUsed = 0;
  let truncated = false;
  const collected: ProjectDiagnosticIssue[] = [];
  const collectCap = Math.min(maxIssues * 4, MAX_ISSUES_CAP * 2);

  let cursor = 0;
  const workerCount = Math.min(concurrency, openable.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < openable.length) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      const file = openable[index];
      if (!file) return;

      if (file.size > HARD_FILE_LIMIT || bytesBudgetUsed + file.size > maxTotalBytes) {
        skippedFiles += 1;
        truncated = true;
        continue;
      }
      bytesBudgetUsed += file.size;

      try {
        // Check lexical path BEFORE realpath so symlinks/junctions are genuinely rejected.
        const lexicalPath = safeJoin(scanned.root, file.path);
        const lexicalInfo = await lstat(lexicalPath);
        if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile()) {
          skippedFiles += 1;
          continue;
        }
        const resolved = await resolveExistingProjectPath(scanned.root, file.path);
        if (!samePath(resolved.path, lexicalPath)) {
          skippedFiles += 1;
          continue;
        }
        if (signal?.aborted) return;

        const snapshot = await readTextSnapshot(resolved.path);
        if (signal?.aborted) return;

        try {
          assertEditableSyntax(file.path, snapshot.text);
        } catch {
          skippedFiles += 1;
          continue;
        }

        scannedFiles += 1;
        const fileIssues = await diagnoseSingleFile({
          projectRoot: scanned.root,
          file,
          absolutePath: resolved.path,
          rawText: snapshot.text,
          locale,
          enableSchemaStore: options.enableSchemaStore === true,
          schemaStoreCacheDir: options.schemaStoreCacheDir,
          schemaFetcher: options.schemaFetcher ?? fetch,
          signal,
        });
        if (signal?.aborted) return;

        for (const issue of fileIssues) {
          if (collected.length < collectCap) {
            collected.push(issue);
          } else {
            truncated = true;
            break;
          }
        }
      } catch {
        skippedFiles += 1;
      }
    }
  });

  await Promise.all(workers);

  if (signal?.aborted) {
    return emptyDiagnosticsResult(scanned.root, Date.now() - startedAt);
  }

  const severityOrder: Record<DiagnosticSeverity, number> = {
    error: 0,
    warning: 1,
    info: 2,
  };
  const categoryOrder: Record<DiagnosticCategory, number> = {
    "parse-error": 0,
    "schema-violation": 1,
    "missing-from-example": 2,
    "plaintext-secret": 3,
  };
  collected.sort((left, right) =>
    severityOrder[left.severity] - severityOrder[right.severity]
    || categoryOrder[left.category] - categoryOrder[right.category]
    || left.file.localeCompare(right.file, "en", { numeric: true, sensitivity: "base" })
    || (left.documentIndex ?? -1) - (right.documentIndex ?? -1)
    || (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER)
    || (left.path ?? "").localeCompare(right.path ?? "", "en", { numeric: true, sensitivity: "base" }),
  );

  if (collected.length > maxIssues) {
    truncated = true;
  }
  const issues = collected.slice(0, maxIssues);

  const summary = {
    errors: 0,
    warnings: 0,
    infos: 0,
    byCategory: {
      parseError: 0,
      schemaViolation: 0,
      missingFromExample: 0,
      plaintextSecret: 0,
    },
  };
  for (const issue of issues) {
    if (issue.severity === "error") summary.errors += 1;
    else if (issue.severity === "warning") summary.warnings += 1;
    else summary.infos += 1;

    if (issue.category === "parse-error") summary.byCategory.parseError += 1;
    else if (issue.category === "schema-violation") summary.byCategory.schemaViolation += 1;
    else if (issue.category === "missing-from-example") summary.byCategory.missingFromExample += 1;
    else summary.byCategory.plaintextSecret += 1;
  }

  return {
    root: scanned.root,
    scannedFiles,
    skippedFiles,
    truncated,
    durationMs: Math.max(0, Date.now() - startedAt),
    summary,
    issues,
  };
}

interface SingleFileDiagContext {
  projectRoot: string;
  file: ConfigFile;
  absolutePath: string;
  rawText: string;
  locale: Locale;
  enableSchemaStore: boolean;
  schemaStoreCacheDir?: string;
  schemaFetcher: typeof fetch;
  signal?: AbortSignal;
}

async function diagnoseSingleFile(ctx: SingleFileDiagContext): Promise<ProjectDiagnosticIssue[]> {
  const { projectRoot, file, absolutePath, rawText, locale, signal } = ctx;
  const isEn = locale === "en-US";
  const cleanText = stripBom(rawText);
  const issues: ProjectDiagnosticIssue[] = [];
  let seq = 0;
  const nextId = (category: DiagnosticCategory, docIndex?: number, path?: string): string =>
    `${file.path}:${docIndex ?? 0}:${category}:${path ?? "file"}:${seq++}`;

  // 1. Parse document(s) — catch syntax errors cleanly without leaking nearby secrets.
  let docs: ParsedDocSlice[];
  try {
    if (file.format === "yaml") {
      const yamlDocs = parseYamlDocuments(cleanText);
      const isMulti = yamlDocs.length > 1;
      docs = yamlDocs.map((doc) => {
        const sliceText = isMulti ? cleanText.slice(doc.spanStart, doc.spanEnd) : cleanText;
        let lineOffset = 0;
        if (isMulti) {
          for (let pos = 0; pos < doc.spanStart && pos < cleanText.length; pos += 1) {
            if (cleanText.charCodeAt(pos) === 10) lineOffset += 1;
          }
        }
        const directiveText = isMulti && extractSchemaDirective(sliceText, "yaml") ? sliceText : cleanText;
        return {
          index: isMulti ? doc.index : undefined,
          label: isMulti ? doc.label : undefined,
          value: doc.value,
          sliceText,
          directiveText,
          lineOffset,
        };
      });
    } else {
      const parsed = parseConfig(cleanText, file.format);
      docs = [{
        value: parsed,
        sliceText: cleanText,
        directiveText: cleanText,
        lineOffset: 0,
      }];
    }
  } catch (error) {
    const rawDetail = error instanceof ConfuiError
      ? (error.detail || error.message)
      : error instanceof Error
        ? error.message
        : String(error);
    const safeDetail = sanitizeDiagnosticText(rawDetail, file.format);
    const line = extractErrorLineNumber(rawDetail);
    issues.push({
      id: nextId("parse-error"),
      file: file.path,
      format: file.format,
      severity: "error",
      category: "parse-error",
      ...(line !== undefined ? { line } : {}),
      message: isEn
        ? `Failed to parse ${file.format.toUpperCase()} syntax`
        : `${file.format.toUpperCase()} 语法解析失败`,
      ...(safeDetail ? { detail: safeDetail } : {}),
    });
    return issues;
  }

  // Load companion example files once per config file (for `missing-from-example`).
  const companionExamples = await loadCompanionExamples(absolutePath, projectRoot, file.format, signal);
  if (signal?.aborted) return issues;

  const baseName = extractBaseName(file.path);
  const lowerBase = baseName.toLowerCase();
  const isTsConfig = lowerBase === "tsconfig.json" || lowerBase === "jsconfig.json";
  const supportsSchema = file.format === "json" || file.format === "jsonc" || file.format === "yaml" || file.format === "toml";

  for (const doc of docs) {
    if (signal?.aborted) return issues;
    const locator = createLineLocator(file.format, doc.sliceText, doc.lineOffset);
    const docMeta = doc.index !== undefined
      ? { documentIndex: doc.index, ...(doc.label ? { documentLabel: doc.label } : {}) }
      : {};

    // 2. JSON Schema & built-in template validation (`schema-violation`)
    const candidates: FieldCandidate[] = [];
    const knownFields = inferKnownFields(baseName, doc.value, file.format, locale);
    candidates.push(...knownFields);

    if (supportsSchema) {
      const schemaRes = await inferJsonSchemaFields(
        absolutePath,
        projectRoot,
        doc.value,
        ctx.schemaFetcher,
        {
          format: file.format,
          rawText: doc.directiveText,
          relativeFile: file.path,
          enableSchemaStore: ctx.enableSchemaStore,
          schemaStoreCacheDir: ctx.schemaStoreCacheDir,
          locale,
        },
      );
      candidates.push(...schemaRes.fields);
    }

    const mergedSpecs = candidates.length > 0 ? mergeCandidates(candidates).fields : [];
    const schemaSecretPathKeys = new Set<string>();
    for (const spec of mergedSpecs) {
      if (spec.secret === true || spec.type === "secret") {
        schemaSecretPathKeys.add(pathKey(spec.segments));
      }
      if (spec.itemFields?.length) {
        const arrVal = getAtPath(doc.value, spec.segments);
        if (Array.isArray(arrVal)) {
          for (let i = 0; i < arrVal.length; i += 1) {
            for (const itemSpec of spec.itemFields) {
              if (itemSpec.secret === true || itemSpec.type === "secret") {
                schemaSecretPathKeys.add(pathKey([...spec.segments, i, itemSpec.key]));
              }
            }
          }
        }
      }

      const violation = validateDiagnosticField(spec, doc.value, file.format, locale, isTsConfig);
      if (violation) {
        issues.push({
          id: nextId("schema-violation", doc.index, spec.path),
          file: file.path,
          format: file.format,
          severity: "error",
          category: "schema-violation",
          path: spec.path,
          segments: [...spec.segments],
          line: locator.locate(spec.segments),
          ...docMeta,
          message: violation.message,
          ...(violation.detail ? { detail: violation.detail } : {}),
        });
      }
    }

    // 3. Missing keys relative to companion `.env.example` / `*.example` (`missing-from-example`)
    if (companionExamples.length > 0 && (doc.index === undefined || doc.index === 0)) {
      const reportedMissing = new Set<string>();
      for (const example of companionExamples) {
        const exampleLeaves = flattenLeafEntries(example.parsed, MAX_EXAMPLE_LEAVES);
        for (const [leafKey, leaf] of exampleLeaves) {
          if (reportedMissing.has(leafKey)) continue;
          const actual = getAtPath(doc.value, leaf.segments);
          if (actual !== undefined) continue;
          reportedMissing.add(leafKey);
          const exampleName = extractBaseName(example.relativePath) || example.relativePath;
          issues.push({
            id: nextId("missing-from-example", doc.index, leaf.path),
            file: file.path,
            format: file.format,
            severity: "warning",
            category: "missing-from-example",
            path: leaf.path,
            segments: [...leaf.segments],
            sourceFile: example.relativePath,
            ...docMeta,
            message: isEn
              ? `Missing key "${leaf.path}" defined in ${exampleName}`
              : `缺少示例文件 ${exampleName} 中定义的配置项 ${leaf.path}`,
            detail: isEn
              ? `Defined in companion template ${example.relativePath}`
              : `定义于配套模板 ${example.relativePath}`,
          });
        }
      }
    }

    // 4. Plaintext suspected secret detection (`plaintext-secret`) — location & key name ONLY!
    const docLeaves = flattenLeafEntries(doc.value, MAX_LEAVES_PER_DOC);
    for (const [leafKey, leaf] of docLeaves) {
      const isMarkedSecret = isSecretPath(leaf.segments)
        || schemaSecretPathKeys.has(leafKey)
        || isAncestorSecretMarked(leaf.segments, schemaSecretPathKeys);
      const detection = detectPlaintextSecret(leaf.segments, leaf.value, isMarkedSecret);
      if (!detection) continue;
      issues.push({
        id: nextId("plaintext-secret", doc.index, leaf.path),
        file: file.path,
        format: file.format,
        severity: "info",
        category: "plaintext-secret",
        path: leaf.path,
        segments: [...leaf.segments],
        line: locator.locate(leaf.segments),
        ...docMeta,
        message: detection === "pattern"
          ? (isEn
            ? `Field "${leaf.path}" matches a plaintext credential pattern (value omitted)`
            : `字段 ${leaf.path} 疑似包含明文密钥或凭据特征（值已隐藏）`)
          : (isEn
            ? `Sensitive field "${leaf.path}" appears to hold a plaintext secret (value omitted)`
            : `敏感字段 ${leaf.path} 疑似配置了明文凭据（值已隐藏）`),
        detail: isEn
          ? "Avoid committing plaintext secrets; use environment injection or redacted export when sharing."
          : "请确认是否需要注入环境变量或加入 .gitignore，分享前请使用脱敏导出。",
      });
    }
  }

  return issues;
}

interface CompanionExample {
  relativePath: string;
  parsed: unknown;
}

async function loadCompanionExamples(
  configAbsolutePath: string,
  projectRoot: string,
  format: ConfigFormat,
  signal?: AbortSignal,
): Promise<CompanionExample[]> {
  const examplePaths = await findExampleFiles(configAbsolutePath);
  if (!examplePaths.length) return [];
  const results: CompanionExample[] = [];
  for (const examplePath of examplePaths) {
    if (signal?.aborted) break;
    try {
      const info = await lstat(examplePath);
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const safePath = await ensurePathInsideProject(projectRoot, examplePath);
      if (!samePath(safePath, examplePath)) continue;
      const text = await readLimitedUtf8File(safePath, {
        maxBytes: EXAMPLE_MAX_BYTES,
        overflow: "reject",
      });
      await ensurePathInsideProject(projectRoot, examplePath);
      const parsed = parseConfig(text, format, { documentIndex: 0 });
      results.push({
        relativePath: relative(projectRoot, safePath).replace(/\\/g, "/"),
        parsed,
      });
    } catch {
      // Ignore unreadable or syntactically broken example templates.
    }
  }
  return results;
}

function validateDiagnosticField(
  spec: FieldSpec,
  rootValue: unknown,
  format: ConfigFormat,
  locale: Locale,
  isTsConfig: boolean,
): { message: string; detail?: string } | undefined {
  const isEn = locale === "en-US";
  const rawValue = getAtPath(rootValue, spec.segments);
  const isFlat = format === "env" || format === "ini" || format === "properties";

  if (rawValue === undefined || rawValue === null || rawValue === "") {
    if (!spec.required) return undefined;
    // Only flag nested required properties when their enclosing parent object actually exists.
    const parent = spec.segments.length === 1
      ? rootValue
      : getAtPath(rootValue, spec.segments.slice(0, -1));
    if (parent === null || parent === undefined || typeof parent !== "object" || Array.isArray(parent)) {
      return undefined;
    }
    return {
      message: isEn
        ? `Missing required field "${spec.path}"`
        : `缺少必填配置项 ${spec.path}`,
      detail: formatSourceDetail(spec.source, locale),
    };
  }

  if (spec.type === "array") {
    if (!Array.isArray(rawValue)) {
      return {
        message: isEn
          ? `Field "${spec.path}" must be an array`
          : `字段 ${spec.path} 类型不匹配：期望数组`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    return undefined;
  }

  if (spec.type === "json") {
    if (typeof rawValue !== "object" || Array.isArray(rawValue) || rawValue instanceof Date) {
      return {
        message: isEn
          ? `Field "${spec.path}" must be an object`
          : `字段 ${spec.path} 类型不匹配：期望对象`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    return undefined;
  }

  if (spec.type === "boolean") {
    const validBool = typeof rawValue === "boolean"
      || (isFlat && typeof rawValue === "string" && /^(?:true|false|1|0|yes|no|on|off)$/i.test(rawValue.trim()));
    if (!validBool) {
      return {
        message: isEn
          ? `Field "${spec.path}" must be a boolean`
          : `字段 ${spec.path} 类型不匹配：期望布尔值`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    return undefined;
  }

  if (spec.type === "integer" || spec.type === "number") {
    let numeric: number | undefined;
    if (typeof rawValue === "number") {
      numeric = rawValue;
    } else if (isFlat && typeof rawValue === "string" && rawValue.trim() !== "") {
      const parsed = Number(rawValue.trim());
      if (Number.isFinite(parsed)) numeric = parsed;
    }
    if (numeric === undefined || !Number.isFinite(numeric)) {
      return {
        message: isEn
          ? `Field "${spec.path}" must be a ${spec.type}`
          : `字段 ${spec.path} 类型不匹配：期望${spec.type === "integer" ? "整数" : "数字"}`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    if (spec.type === "integer" && (!Number.isInteger(numeric) || !Number.isSafeInteger(numeric))) {
      return {
        message: isEn
          ? `Field "${spec.path}" must be a valid integer`
          : `字段 ${spec.path} 必须为有效整数`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    if (spec.minimum !== undefined && numeric < spec.minimum) {
      return {
        message: isEn
          ? `Field "${spec.path}" is below minimum (${spec.minimum})`
          : `字段 ${spec.path} 小于允许的最小值 ${spec.minimum}`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    if (spec.maximum !== undefined && numeric > spec.maximum) {
      return {
        message: isEn
          ? `Field "${spec.path}" exceeds maximum (${spec.maximum})`
          : `字段 ${spec.path} 超过允许的最大值 ${spec.maximum}`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    return undefined;
  }

  if (spec.type === "enum" && spec.enum?.length) {
    const caseInsensitive = isTsConfig && spec.source === "known-template";
    const matched = spec.enum.some((option) => enumMatches(option, rawValue, caseInsensitive));
    if (!matched) {
      return {
        message: isEn
          ? `Field "${spec.path}" is not one of the allowed enum values`
          : `字段 ${spec.path} 的值不在允许的枚举列表中`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    return undefined;
  }

  if (spec.type === "color") {
    if (typeof rawValue !== "string" || !isHexColor(rawValue)) {
      return {
        message: isEn
          ? `Field "${spec.path}" must be a valid hex color`
          : `字段 ${spec.path} 必须为有效的十六进制颜色`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
  }

  if ((spec.type === "string" || spec.type === "secret") && !isFlat && typeof rawValue !== "string") {
    return {
      message: isEn
        ? `Field "${spec.path}" must be a string`
        : `字段 ${spec.path} 类型不匹配：期望字符串`,
      detail: formatSourceDetail(spec.source, locale),
    };
  }

  if (typeof rawValue === "string") {
    if (spec.minLength !== undefined && rawValue.length < spec.minLength) {
      return {
        message: isEn
          ? `Field "${spec.path}" is shorter than minLength (${spec.minLength})`
          : `字段 ${spec.path} 长度少于最小限制（${spec.minLength}）`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    if (spec.maxLength !== undefined && rawValue.length > spec.maxLength) {
      return {
        message: isEn
          ? `Field "${spec.path}" exceeds maxLength (${spec.maxLength})`
          : `字段 ${spec.path} 长度超过最大限制（${spec.maxLength}）`,
        detail: formatSourceDetail(spec.source, locale),
      };
    }
    if (spec.pattern && rawValue.length <= MAX_REGEX_TEST_VALUE_LENGTH && isSafeRegexPattern(spec.pattern)) {
      try {
        if (!new RegExp(spec.pattern).test(rawValue)) {
          return {
            message: isEn
              ? `Field "${spec.path}" does not match required pattern`
              : `字段 ${spec.path} 不符合要求的正则表达式格式`,
            detail: formatSourceDetail(spec.source, locale),
          };
        }
      } catch {
        // Ignore invalid third-party schema regexes.
      }
    }
  }

  return undefined;
}

function detectPlaintextSecret(
  segments: readonly PathSegment[],
  value: unknown,
  isMarkedSecret: boolean,
): "pattern" | "key" | undefined {
  const strings = extractScalarStrings(value);
  if (!strings.length) return undefined;

  for (const str of strings) {
    const trimmed = str.trim();
    if (!trimmed || isPlaceholderOrMask(trimmed)) continue;
    if (containsSecretValuePattern(trimmed)) return "pattern";
  }

  if (!isMarkedSecret) return undefined;

  const pathText = formatPath(segments);
  const leafName = String(segments.at(-1) ?? "");
  const isUrlKey = URL_STYLE_SECRET_KEY_RE.test(leafName) || URL_STYLE_SECRET_KEY_RE.test(pathText);
  if (isUrlKey) {
    // Plain URLs without embedded credentials (e.g. `postgres://localhost:5432/app`) are not plaintext secrets.
    return undefined;
  }

  for (const str of strings) {
    const trimmed = str.trim();
    if (trimmed.length < 4 || isPlaceholderOrMask(trimmed)) continue;
    // Ignore file paths pointing to mounted key files (e.g. `/run/secrets/db_password`, `./certs/key.pem`)
    if (/^(?:\.{0,2}\/|~\/|[A-Za-z]:\\)/.test(trimmed) && !/\s/.test(trimmed)) continue;
    return "key";
  }

  return undefined;
}

function extractScalarStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

function isPlaceholderOrMask(trimmed: string): boolean {
  if (!trimmed) return true;
  if (PLACEHOLDER_OR_MASK_RE.test(trimmed)) return true;
  if (/^\$\{[^{}]+\}$/.test(trimmed) || /^\{\{[^{}]+\}\}$/.test(trimmed)) return true;
  if (/^<[^<>]+>$/.test(trimmed)) return true;
  return false;
}

interface LeafEntry {
  segments: PathSegment[];
  path: string;
  value: unknown;
}

function flattenLeafEntries(parsed: unknown, maxLeaves: number): Map<string, LeafEntry> {
  const leaves = new Map<string, LeafEntry>();
  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (leaves.size >= maxLeaves) return;
    if (
      current !== null
      && typeof current === "object"
      && !Array.isArray(current)
      && !(current instanceof Date)
    ) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length > 0 && depth < MAX_WALK_DEPTH) {
        for (const [key, child] of entries) {
          if (key === "$schema" || isForbiddenKey(key)) continue;
          visit(child, [...segments, key], depth + 1);
          if (leaves.size >= maxLeaves) return;
        }
        return;
      }
    }
    if (
      Array.isArray(current)
      && current.length > 0
      && depth < MAX_WALK_DEPTH
      && current.some((item) => item !== null && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date))
    ) {
      for (let i = 0; i < current.length; i += 1) {
        visit(current[i], [...segments, i], depth + 1);
        if (leaves.size >= maxLeaves) return;
      }
      return;
    }
    if (!segments.length) return;
    leaves.set(pathKey(segments), {
      segments,
      path: formatPath(segments),
      value: current,
    });
  }
  visit(parsed, [], 0);
  return leaves;
}

function isAncestorSecretMarked(segments: readonly PathSegment[], markedKeys: ReadonlySet<string>): boolean {
  for (let len = 1; len < segments.length; len += 1) {
    if (markedKeys.has(pathKey(segments.slice(0, len)))) return true;
  }
  return false;
}

function createLineLocator(format: ConfigFormat, rawSlice: string, lineOffset: number): {
  locate: (segments: readonly PathSegment[]) => number | undefined;
} {
  const normalized = rawSlice.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  let cachedTree: JsoncNode | null | undefined;
  return {
    locate(segments: readonly PathSegment[]): number | undefined {
      let localLine: number | undefined;
      if (format === "json" || format === "jsonc") {
        if (cachedTree === undefined) {
          cachedTree = parseTree(normalized) ?? null;
        }
        if (cachedTree) {
          const node = findNodeAtLocation(cachedTree, [...segments]);
          if (node) {
            const offset = node.parent?.type === "property" ? node.parent.offset : node.offset;
            let line = 1;
            for (let i = 0; i < offset && i < normalized.length; i += 1) {
              if (normalized.charCodeAt(i) === 10) line += 1;
            }
            localLine = line;
          }
        }
      }
      if (localLine === undefined) {
        localLine = findLineForPath(lines, segments, format);
      }
      return localLine !== undefined ? localLine + lineOffset : undefined;
    },
  };
}

function enumMatches(option: string | number, value: unknown, caseInsensitive: boolean): boolean {
  if (Object.is(option, value)) return true;
  if (caseInsensitive && typeof option === "string" && typeof value === "string") {
    return option.toLowerCase() === value.toLowerCase();
  }
  if (typeof option === "number" && typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value)) && Number(value) === option;
  }
  if (typeof option === "string" && typeof value === "number") {
    return Number.isFinite(Number(option)) && Number(option) === value;
  }
  return false;
}

function formatSourceDetail(source: FieldSpec["source"], locale: Locale): string {
  const isEn = locale === "en-US";
  switch (source) {
    case "json-schema": return isEn ? "Rule source: JSON Schema" : "规则来源：JSON Schema";
    case "schemastore": return isEn ? "Rule source: SchemaStore" : "规则来源：SchemaStore";
    case "known-template": return isEn ? "Rule source: Built-in Template" : "规则来源：内置模板";
    default: return isEn ? `Rule source: ${source}` : `规则来源：${source}`;
  }
}

function sanitizeDiagnosticText(text: string, format?: ConfigFormat): string {
  const lineMasked = maskDocumentLines(text, { format, mask: "***" }).lines.join(" ");
  const scrubbed = maskDocumentSecrets(lineMasked).replace(/\s+/g, " ").trim();
  return scrubbed.length > 260 ? `${scrubbed.slice(0, 259)}…` : scrubbed;
}

function extractErrorLineNumber(detail: string): number | undefined {
  const match = detail.match(/\bline\s+(\d+)\b/i) ?? detail.match(/第\s*(\d+)\s*行/);
  if (!match?.[1]) return undefined;
  const line = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(line) && line >= 1 ? line : undefined;
}

function emptyDiagnosticsResult(root: string, durationMs: number): ProjectDiagnosticsResult {
  return {
    root,
    scannedFiles: 0,
    skippedFiles: 0,
    truncated: false,
    durationMs: Math.max(0, durationMs),
    summary: {
      errors: 0,
      warnings: 0,
      infos: 0,
      byCategory: {
        parseError: 0,
        schemaViolation: 0,
        missingFromExample: 0,
        plaintextSecret: 0,
      },
    },
    issues: [],
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
