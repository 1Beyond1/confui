import { basename } from "node:path";
import type {
  ConfigFormSchema,
  DocumentSecretMeta,
  FieldSpec,
  InferOptions,
  Locale,
  PathSegment,
  YamlDocumentSummary,
} from "../../shared/schema.ts";
import { collectSecretStrings, containsSecretValuePattern, isSensitiveKey } from "../../shared/validation.ts";
import type { AIProvider } from "../ai/provider.ts";
import { AI_FILE_LIMIT, readTextSnapshot } from "../files.ts";
import { assertEditableSyntax, detectFormat, parseConfig, parseYamlDocuments, type ParsedYamlDocument } from "../formats.ts";
import { stripBom } from "../formats/common.ts";
import { formatPath, getAtPath, resolveExistingProjectPath } from "../paths.ts";
import { inferAIFields } from "./ai.ts";
import { inferCommentFields } from "./comments.ts";
import { isSecretPath, toEditorValue } from "./common.ts";
import { inferExampleFields } from "./examples.ts";
import { inferHeuristicFields, maskDocumentSecrets, maskSecrets } from "./heuristic.ts";
import { extractSchemaDirective, inferJsonSchemaFields } from "./json-schema.ts";
import { inferKnownFields } from "./known.ts";
import { MAX_FORM_FIELDS, mergeCandidates } from "./merge.ts";
import { inferReadmeFields } from "./readme.ts";
import type { FieldCandidate } from "./types.ts";

export interface InferenceContext extends InferOptions {
  ai?: AIProvider;
  githubToken?: string;
  /** Opt-in remote SchemaStore lookup (strictly disabled by default). */
  enableSchemaStore?: boolean;
  /** Local disk cache directory for 7-day SchemaStore caching. */
  schemaStoreCacheDir?: string;
  /** Optional custom fetch implementation (primarily for tests). */
  schemaFetcher?: typeof fetch;
}

export async function inferConfig(
  root: string,
  relativeFile: string,
  options: InferenceContext = {},
): Promise<ConfigFormSchema> {
  const resolved = await resolveExistingProjectPath(root, relativeFile);
  const projectRoot = resolved.root;
  const absolutePath = resolved.path;
  const format = detectFormat(relativeFile);
  if (!format) throw new Error("不支持这个配置文件格式");
  const { text, version } = await readTextSnapshot(absolutePath);
  assertEditableSyntax(relativeFile, text);
  const cleanText = stripBom(text);

  let parsed: unknown;
  let yamlDocuments: YamlDocumentSummary[] | undefined;
  let parsedYamlDocs: ParsedYamlDocument[] | undefined;
  let activeDocumentIndex: number | undefined;
  let schemaDirectiveText = cleanText;

  if (format === "yaml") {
    const docs = parseYamlDocuments(text);
    if (docs.length > 1) {
      parsedYamlDocs = docs;
      const requested = options.documentIndex ?? 0;
      const clamped = Number.isSafeInteger(requested) && requested >= 0 && requested < docs.length
        ? requested
        : 0;
      activeDocumentIndex = clamped;
      yamlDocuments = docs.map((doc) => ({
        index: doc.index,
        label: doc.label,
        kind: doc.kind,
        name: doc.name,
        profile: doc.profile,
        startLine: doc.startLine,
        keyCount: doc.keyCount,
      }));
      const activeDoc = docs[clamped]!;
      parsed = activeDoc.value;
      const docSlice = cleanText.slice(activeDoc.spanStart, activeDoc.spanEnd);
      // Prefer a document-specific `# yaml-language-server: $schema=...` directive,
      // falling back to a file-header directive when absent.
      schemaDirectiveText = extractSchemaDirective(docSlice, "yaml") ? docSlice : cleanText;
    } else {
      parsed = docs[0]!.value;
    }
  } else {
    parsed = parseConfig(text, format);
  }

  const warnings: string[] = [];
  const candidates: FieldCandidate[] = [];

  const locale: Locale = options.locale === "en-US" ? "en-US" : "zh-CN";
  const known = inferKnownFields(basename(relativeFile), parsed, format, locale);
  const collapsedPrefixes = known
    .filter((candidate) => candidate.type === "json" && candidate.value !== undefined)
    .map((candidate) => candidate.segments);
  const heuristicResult = inferHeuristicFields(parsed);
  const heuristic = heuristicResult.fields.filter((candidate) =>
    !collapsedPrefixes.some((prefix) => isDescendantPath(candidate.segments, prefix)),
  );
  if (heuristicResult.truncated) warnings.push("当前配置字段过多，结构推断已达到安全上限；表单只展示有限字段。");
  candidates.push(...heuristic, ...known);

  // These sources do not depend on one another. Running them together is
  // especially useful for projects whose `$schema` is remote: otherwise a
  // schema request and example-file scan add their latency one after another.
  const normalizedRelative = relativeFile.replace(/\\/g, "/");
  const supportsSchema = format === "json" || format === "jsonc" || format === "yaml" || format === "toml";
  const schemaPromise = supportsSchema
    ? inferJsonSchemaFields(absolutePath, projectRoot, parsed, options.schemaFetcher ?? fetch, {
      format,
      rawText: schemaDirectiveText,
      relativeFile: normalizedRelative,
      enableSchemaStore: options.enableSchemaStore === true,
      schemaStoreCacheDir: options.schemaStoreCacheDir,
      locale,
    })
    : Promise.resolve({ fields: [], warnings: [], truncated: false, schemaStore: undefined });
  const examplesPromise = inferExampleFields(absolutePath, projectRoot, format);
  const [schema, examples] = await Promise.all([schemaPromise, examplesPromise]);
  candidates.push(...schema.fields);
  warnings.push(...schema.warnings);
  if (schema.truncated) warnings.push("JSON Schema 字段过多，已停止继续展开其余字段。");
  candidates.push(...examples.fields);
  if (examples.truncated) warnings.push("示例文件字段过多，已停止继续展开其余字段。");

  // Local AST/CST comment extraction across all 6 formats (strictly sanitized via maskDocumentSecrets).
  const secretValuesSet = new Set<string>();
  collectNestedSecretValues(parsed, secretValuesSet);
  for (const candidate of candidates) {
    const actual = candidate.value !== undefined ? candidate.value : getAtPath(parsed, candidate.segments);
    if (actual === undefined) continue;
    if (candidate.secret === true || candidate.type === "secret" || isSecretPath(candidate.segments)) {
      collectSecretStrings(actual, secretValuesSet);
    } else if (candidate.itemFields?.length && Array.isArray(actual)) {
      collectItemFieldSecrets(actual, candidate.itemFields, secretValuesSet);
    }
  }
  const existingPaths = uniquePaths(candidates.map((candidate) => candidate.segments));
  const commentFields = inferCommentFields(text, format, {
    documentIndex: activeDocumentIndex ?? 0,
    locale,
    existingPaths,
    secretValues: [...secretValuesSet],
  });
  candidates.push(...commentFields);

  const knownPaths = uniquePaths(candidates.map((candidate) => candidate.segments));
  const readme = await inferReadmeFields(
    projectRoot,
    options.githubUrl,
    options.githubToken,
    knownPaths,
    format,
  );
  candidates.push(...readme.fields);
  if (readme.warning) warnings.push(readme.warning);
  if (readme.truncated) warnings.push("README 中可识别字段过多，已停止继续解析其余内容。");

  const preMerged = mergeCandidates(candidates);
  const unresolvedPaths = preMerged.fields
    .filter((field) => !field.description)
    .map((field) => field.segments);
  const secretPaths = uniquePaths([
    ...candidates
      .filter((candidate) => candidate.secret === true || candidate.type === "secret")
      .map((candidate) => candidate.segments),
    ...preMerged.fields
      .filter((field) => field.secret === true || field.type === "secret")
      .map((field) => field.segments),
  ]);
  if (options.ai && version.size <= AI_FILE_LIMIT && unresolvedPaths.length) {
    try {
      candidates.push(...await inferAIFields({
        provider: options.ai,
        file: relativeFile,
        format,
        maskedValue: maskSecrets(parsed, [], { secretPaths }),
        availablePaths: unresolvedPaths,
        readmeContext: maskDocumentSecrets(readme.text),
        exampleContext: examples.context,
        locale,
      }));
    } catch (error) {
      const prefix = locale === "en-US" ? "AI analysis skipped: " : "AI 分析已跳过：";
      warnings.push(`${prefix}${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (options.ai && version.size > AI_FILE_LIMIT && unresolvedPaths.length) {
    warnings.push(locale === "en-US" ? "File exceeds 1 MB; AI analysis was skipped." : "文件超过 1 MB，已跳过 AI 分析");
  }

  const merged = mergeCandidates(candidates);
  const fields = hydrateFieldValues(merged.fields, parsed);
  if (merged.truncated) {
    warnings.push(`字段数量较多（共 ${merged.totalFieldCount} 项），仅展示优先级最高的前 ${MAX_FORM_FIELDS} 项；其余内容仍保留在原始文件中。`);
  }
  if (!fields.length) warnings.push("没有发现可转换为表单的字段，可在原始内容中检查文件");

  let documentSecrets: DocumentSecretMeta[] | undefined;
  if (format === "yaml" && parsedYamlDocs && parsedYamlDocs.length > 1) {
    const fileHasHeaderDirective = Boolean(extractSchemaDirective(cleanText, "yaml"));
    const activeHadSchema = schema.fields.length > 0 || Boolean(schema.schemaStore);
    documentSecrets = await Promise.all(
      parsedYamlDocs.map(async (doc) => {
        if (doc.index === activeDocumentIndex) {
          return buildDocumentSecretMeta(doc.index, doc.startLine, doc.value, fields);
        }
        const docSlice = cleanText.slice(doc.spanStart, doc.spanEnd);
        const docDirective = extractSchemaDirective(docSlice, "yaml");
        const hasInlineSchema = doc.value !== null
          && typeof doc.value === "object"
          && typeof (doc.value as Record<string, unknown>).$schema === "string";
        let docSchemaFields: FieldCandidate[] = [];
        if (docDirective || hasInlineSchema || fileHasHeaderDirective || activeHadSchema || options.enableSchemaStore === true) {
          const siblingSchema = await inferJsonSchemaFields(
            absolutePath,
            projectRoot,
            doc.value,
            options.schemaFetcher ?? fetch,
            {
              format: "yaml",
              rawText: docDirective ? docSlice : cleanText,
              relativeFile: normalizedRelative,
              enableSchemaStore: options.enableSchemaStore === true,
              schemaStoreCacheDir: options.schemaStoreCacheDir,
              locale,
            },
          );
          docSchemaFields = siblingSchema.fields;
        }
        return buildDocumentSecretMeta(doc.index, doc.startLine, doc.value, docSchemaFields);
      }),
    );
  }

  return {
    file: normalizedRelative,
    kind: basename(relativeFile),
    format,
    fields,
    sources: merged.sources,
    writable: fields.length > 0,
    warnings: [...new Set(warnings)],
    exampleFiles: examples.files,
    readmeSource: readme.source,
    schemaStore: schema.schemaStore,
    yamlDocuments,
    activeDocumentIndex,
    ...(documentSecrets ? { documentSecrets } : {}),
    version,
    rawText: text,
  };
}

function buildDocumentSecretMeta(
  documentIndex: number,
  startLine: number,
  parsed: unknown,
  docFields: readonly {
    segments: PathSegment[];
    secret?: boolean;
    type?: FieldSpec["type"];
    itemFields?: FieldSpec["itemFields"];
  }[],
): DocumentSecretMeta {
  const pathList: PathSegment[][] = [];
  const seenPaths = new Set<string>();
  const keySet = new Set<string>();
  const valueSet = new Set<string>();

  const addSecretPath = (segments: readonly PathSegment[], value?: unknown): void => {
    if (!segments.length) return;
    const key = JSON.stringify(segments);
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      pathList.push([...segments]);
    }
    keySet.add(formatPath(segments));
    const leaf = segments.at(-1);
    if (typeof leaf === "string" && leaf.trim()) keySet.add(leaf);
    if (value !== undefined) collectSecretStrings(value, valueSet);
  };

  for (const field of docFields) {
    const actual = getAtPath(parsed, field.segments);
    if (field.secret === true || field.type === "secret") {
      addSecretPath(field.segments, actual);
    } else if (field.itemFields?.length && Array.isArray(actual)) {
      for (let i = 0; i < actual.length; i += 1) {
        const item = actual[i];
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        for (const itemSpec of field.itemFields) {
          if (itemSpec.secret === true || itemSpec.type === "secret") {
            const propVal = (item as Record<string, unknown>)[itemSpec.key];
            if (propVal !== undefined) {
              addSecretPath([...field.segments, i, itemSpec.key], propVal);
            }
          }
        }
      }
    }
  }

  collectNestedSecretValues(parsed, valueSet);
  return {
    documentIndex,
    startLine,
    secretPaths: pathList,
    secretKeys: [...keySet],
    secretValues: [...valueSet],
  };
}

export function collectNestedSecretValues(
  value: unknown,
  out: Set<string>,
  insideSecret = false,
  depth = 0,
  state = { nodes: 0 },
): void {
  if (depth > 16 || state.nodes >= 4_000 || value === undefined || value === null) return;
  state.nodes += 1;
  if (typeof value === "string") {
    if (insideSecret || containsSecretValuePattern(value)) {
      collectSecretStrings(value, out);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (insideSecret) {
      collectSecretStrings(value, out);
      return;
    }
    for (const item of value) {
      if (state.nodes >= 4_000) return;
      collectNestedSecretValues(item, out, false, depth + 1, state);
    }
    return;
  }
  if (typeof value === "object" && !(value instanceof Date)) {
    for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
      if (state.nodes >= 4_000) return;
      const keySecret = insideSecret || isSensitiveKey(k);
      collectNestedSecretValues(item, out, keySecret, depth + 1, state);
    }
  }
}

function collectItemFieldSecrets(
  items: readonly unknown[],
  itemFields: readonly NonNullable<FieldSpec["itemFields"]>[number][],
  out: Set<string>,
): void {
  const secretKeys = itemFields.filter((spec) => spec.secret === true || spec.type === "secret").map((spec) => spec.key);
  if (!secretKeys.length) return;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    for (const key of secretKeys) {
      const val = record[key];
      if (val !== undefined) collectSecretStrings(val, out);
    }
  }
}

function hydrateFieldValues(fields: readonly FieldSpec[], parsed: unknown): FieldSpec[] {
  return fields.map((field) => {
    if (field.value !== undefined) return field;
    const actual = getAtPath(parsed, field.segments);
    if (actual === undefined) return field;
    return { ...field, value: toEditorValue(actual) };
  });
}

function uniquePaths(paths: readonly (readonly (string | number)[])[]): Array<Array<string | number>> {
  const seen = new Set<string>();
  const result: Array<Array<string | number>> = [];
  for (const segments of paths) {
    const key = JSON.stringify(segments);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([...segments]);
  }
  return result;
}

function isDescendantPath(path: readonly (string | number)[], prefix: readonly (string | number)[]): boolean {
  return path.length > prefix.length && prefix.every((segment, index) => path[index] === segment);
}
