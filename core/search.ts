import { findNodeAtLocation, parseTree, type Node as JsoncNode } from "jsonc-parser";
import { lstat } from "node:fs/promises";
import type {
  ConfigFile,
  ConfigFormat,
  PathSegment,
  ProjectScanResult,
  ProjectSearchHit,
  ProjectSearchOptions,
  ProjectSearchResult,
  SearchMatchKind,
} from "../shared/schema.ts";
import { isForbiddenKey } from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";
import { HARD_FILE_LIMIT, readTextSnapshot } from "./files.ts";
import { assertEditableSyntax, parseConfig } from "./formats.ts";
import { isSecretPath, toEditorValue } from "./inference/common.ts";
import { maskDocumentSecrets } from "./inference/heuristic.ts";
import { formatPath, resolveExistingProjectPath, safeJoin } from "./paths.ts";
import { scanProject } from "./scanner.ts";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES_CAP = 32 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;
const MAX_QUERY_CHARS = 500;
const MAX_WALK_DEPTH = 16;
const MAX_LEAVES_PER_FILE = 6_000;
const SECRET_MASK = "••••••••";
const YAML_BLOCK_HEADER_RE = /^(?:\s*(?:-\s+)?(?:(?:"[^"]*"|'[^']*'|[^:#\r\n]+?)\s*:\s*)|(?:\s*-\s+))[|>](?:[-+]?\d*|\d*[-+])?(?:\s+#.*)?$/;

export interface SearchProjectRuntimeOptions extends ProjectSearchOptions {
  /** Optional abort signal for single-flight cancellation from the main process. */
  signal?: AbortSignal;
  /** Optional already-scanned project snapshot to avoid rescanning the filesystem per keystroke. */
  preScanned?: Pick<ProjectScanResult, "root" | "files">;
}

/**
 * Concurrently searches readable configuration files in a project by key path,
 * non-sensitive values, and comments. Enforces strict concurrency, total-byte,
 * cancellation, and result-count budgets; skips oversized/unsupported/symlink
 * files; strictly redacts secret field hits; and ranks all collected matches
 * (`path > value > comment`) BEFORE truncating to `limit`.
 */
export async function searchProjectConfigs(
  root: string,
  query: string,
  options: SearchProjectRuntimeOptions = {},
): Promise<ProjectSearchResult> {
  if (typeof root !== "string" || !root.trim()) {
    throw new ConfuiError("INVALID_INPUT", "项目路径不能为空");
  }
  if (typeof query !== "string" || query.length > MAX_QUERY_CHARS || query.includes("\0")) {
    throw new ConfuiError("INVALID_INPUT", "搜索关键词无效");
  }
  const trimmed = query.trim();
  if (!trimmed || options.signal?.aborted) {
    return {
      query: trimmed,
      hits: [],
      searchedFiles: 0,
      skippedFiles: 0,
      truncated: false,
    };
  }

  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxTotalBytes = clampInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1_024, MAX_TOTAL_BYTES_CAP);
  const concurrency = clampInt(options.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const maxBucketHits = Math.max(limit * 25, 2_500);
  const needle = trimmed.toLowerCase();
  const signal = options.signal;

  const scanned = options.preScanned ?? await scanProject(root);
  if (signal?.aborted) {
    return { query: trimmed, hits: [], searchedFiles: 0, skippedFiles: 0, truncated: false };
  }

  const openable: ConfigFile[] = [];
  let skippedFiles = 0;
  for (const file of scanned.files) {
    if (file.status === "ready" || file.status === "large") openable.push(file);
    else skippedFiles += 1;
  }

  let searchedFiles = 0;
  let bytesBudgetUsed = 0;
  let truncated = false;
  const pathHits: ProjectSearchHit[] = [];
  const valueHits: ProjectSearchHit[] = [];
  const commentHits: ProjectSearchHit[] = [];

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
        // Check the lexical path BEFORE realpath so symlinks are genuinely detected and skipped.
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

        assertEditableSyntax(file.path, snapshot.text);
        const parsed = parseConfig(snapshot.text, file.format);
        searchedFiles += 1;

        const needComments = pathHits.length + valueHits.length <= limit;
        const fileHits = searchSingleFile(file, snapshot.text, parsed, needle, needComments);
        for (const hit of fileHits) {
          if (hit.matchKind === "path") {
            const isExact = hit.path?.toLowerCase() === needle;
            if (pathHits.length < maxBucketHits || isExact) {
              pathHits.push(hit);
            } else {
              truncated = true;
            }
          } else if (hit.matchKind === "value") {
            if (valueHits.length < maxBucketHits) {
              valueHits.push(hit);
            } else {
              truncated = true;
            }
          } else {
            if (commentHits.length < maxBucketHits) {
              commentHits.push(hit);
            } else {
              truncated = true;
            }
          }
        }
      } catch {
        skippedFiles += 1;
      }
    }
  });

  await Promise.all(workers);

  if (signal?.aborted) {
    return {
      query: trimmed,
      hits: [],
      searchedFiles: 0,
      skippedFiles: 0,
      truncated: false,
    };
  }

  const collected = [...pathHits, ...valueHits, ...commentHits];
  const kindOrder: Record<SearchMatchKind, number> = {
    path: 0,
    value: 1,
    comment: 2,
  };
  collected.sort((left, right) => {
    const kindDiff = kindOrder[left.matchKind] - kindOrder[right.matchKind];
    if (kindDiff !== 0) return kindDiff;
    const leftExact = left.path?.toLowerCase() === needle ? 0 : 1;
    const rightExact = right.path?.toLowerCase() === needle ? 0 : 1;
    if (leftExact !== rightExact) return leftExact - rightExact;
    return left.file.localeCompare(right.file, "en", { numeric: true, sensitivity: "base" })
      || (left.line ?? 0) - (right.line ?? 0)
      || (left.path ?? "").localeCompare(right.path ?? "", "en", { numeric: true, sensitivity: "base" });
  });

  if (collected.length > limit) {
    truncated = true;
  }

  return {
    query: trimmed,
    hits: collected.slice(0, limit),
    searchedFiles,
    skippedFiles,
    truncated,
  };
}

function searchSingleFile(
  file: ConfigFile,
  rawText: string,
  parsed: unknown,
  needle: string,
  includeComments: boolean,
): ProjectSearchHit[] {
  const hits: ProjectSearchHit[] = [];
  const normalizedText = rawText.replace(/\r\n/g, "\n");
  const rawLines = normalizedText.split("\n");
  let visitedLeaves = 0;
  let cachedJsonTree: JsoncNode | null | undefined;

  function locateLine(segments: readonly PathSegment[]): number | undefined {
    if (file.format === "json" || file.format === "jsonc") {
      if (cachedJsonTree === undefined) {
        cachedJsonTree = parseTree(normalizedText) ?? null;
      }
      if (cachedJsonTree) {
        const line = findJsonLineForPath(normalizedText, cachedJsonTree, segments);
        if (line !== undefined) return line;
      }
    }
    return findLineForPath(rawLines, segments, file.format);
  }

  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (visitedLeaves >= MAX_LEAVES_PER_FILE) return;
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
          if (visitedLeaves >= MAX_LEAVES_PER_FILE) return;
        }
        return;
      }
    }

    if (!segments.length) return;
    visitedLeaves += 1;

    const path = formatPath(segments);
    const editorVal = toEditorValue(current);
    const valStr = formatSearchableValue(editorVal);
    const secretByKey = isSecretPath(segments);
    const secretByContent = valStr.length > 0 && maskDocumentSecrets(valStr) !== valStr;
    const secret = secretByKey || secretByContent;

    if (path.toLowerCase().includes(needle)) {
      hits.push({
        file: file.path,
        format: file.format,
        path,
        segments: [...segments],
        line: locateLine(segments),
        matchKind: "path",
        preview: secret ? SECRET_MASK : truncateSnippet(valStr || "(empty)", 120),
        secret,
      });
      return;
    }

    // Never match or expose values of sensitive fields or credential-shaped values.
    if (!secret && valStr && valStr.toLowerCase().includes(needle)) {
      hits.push({
        file: file.path,
        format: file.format,
        path,
        segments: [...segments],
        line: locateLine(segments),
        matchKind: "value",
        preview: truncateSnippet(valStr, 120),
        secret: false,
      });
    }
  }

  visit(parsed, [], 0);

  if (includeComments) {
    const comments = extractFileComments(normalizedText, file.format);
    for (const comment of comments) {
      const sanitized = maskDocumentSecrets(comment.text).trim();
      if (!sanitized) continue;
      if (sanitized.toLowerCase().includes(needle)) {
        hits.push({
          file: file.path,
          format: file.format,
          line: comment.line,
          matchKind: "comment",
          preview: truncateSnippet(sanitized, 140),
          secret: false,
        });
      }
    }
  }

  return hits;
}

export function extractFileComments(
  text: string,
  format: ConfigFormat,
): Array<{ line: number; text: string }> {
  if (format === "json") return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const comments: Array<{ line: number; text: string }> = [];

  if (format === "jsonc") {
    let inBlock = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      let inString = false;
      let escaped = false;
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j];
        const next = line[j + 1];
        if (inBlock) {
          const endIdx = line.indexOf("*/", j);
          if (endIdx >= 0) {
            const body = line.slice(j, endIdx).replace(/^\s*\*?\s*/, "").trim();
            if (body) comments.push({ line: i + 1, text: body });
            inBlock = false;
            j = endIdx + 1;
            continue;
          }
          const body = line.slice(j).replace(/^\s*\*?\s*/, "").trim();
          if (body) comments.push({ line: i + 1, text: body });
          break;
        }
        if (inString) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            continue;
          }
          if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') {
          inString = true;
          continue;
        }
        if (ch === "/" && next === "/") {
          const body = line.slice(j + 2).trim();
          if (body) comments.push({ line: i + 1, text: body });
          break;
        }
        if (ch === "/" && next === "*") {
          inBlock = true;
          j += 1;
        }
      }
    }
    return comments;
  }

  if (format === "properties") {
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (trimmed.startsWith("#") || trimmed.startsWith("!")) {
        const body = trimmed.slice(1).trim();
        if (body) comments.push({ line: i + 1, text: body });
      }
    }
    return comments;
  }

  if (format === "yaml") {
    let yamlBlockIndent: number | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (yamlBlockIndent !== undefined) {
        if (!line.trim()) continue;
        if (indent > yamlBlockIndent) continue;
        yamlBlockIndent = undefined;
      }
      const comment = findHashComment(line, ["#"]);
      if (comment) comments.push({ line: i + 1, text: comment });
      if (YAML_BLOCK_HEADER_RE.test(line)) {
        yamlBlockIndent = indent;
      }
    }
    return comments;
  }

  if (format === "toml") {
    let tomlTriple: '"""' | "'''" | undefined;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const scan = scanTomlLineForComment(line, tomlTriple);
      tomlTriple = scan.nextTriple;
      if (scan.comment) comments.push({ line: i + 1, text: scan.comment });
    }
    return comments;
  }

  // ENV, INI: quote-aware `#` (and `;` for INI) comments
  const markers = format === "ini" ? ["#", ";"] : ["#"];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const comment = findHashComment(line, markers);
    if (comment) comments.push({ line: i + 1, text: comment });
  }
  return comments;
}

function scanTomlLineForComment(
  line: string,
  initialTriple: '"""' | "'''" | undefined,
): { comment?: string; nextTriple: '"""' | "'''" | undefined } {
  let triple = initialTriple;
  let singleQuote: '"' | "'" | undefined;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (triple) {
      if (triple === '"""') {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
      }
      if (line.startsWith(triple, i)) {
        const quoteChar = triple[0]!;
        let runEnd = i + 3;
        while (runEnd < line.length && line[runEnd] === quoteChar && runEnd - i < 5) {
          runEnd += 1;
        }
        triple = undefined;
        i = runEnd - 1;
      }
      continue;
    }

    if (singleQuote) {
      if (singleQuote === '"') {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
      }
      if (ch === singleQuote) singleQuote = undefined;
      continue;
    }

    if (line.startsWith('"""', i)) {
      triple = '"""';
      i += 2;
      continue;
    }
    if (line.startsWith("'''", i)) {
      triple = "'''";
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      singleQuote = ch;
      continue;
    }
    if (ch === "#") {
      const body = line.slice(i + 1).trim();
      return { comment: body || undefined, nextTriple: undefined };
    }
  }

  return { nextTriple: triple };
}

function findHashComment(line: string, markers: readonly string[]): string | undefined {
  let quote: string | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (markers.includes(ch) && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      const body = line.slice(i + 1).trim();
      return body || undefined;
    }
  }
  return undefined;
}

function findJsonLineForPath(
  normalizedText: string,
  tree: JsoncNode,
  segments: readonly PathSegment[],
): number | undefined {
  const node = findNodeAtLocation(tree, [...segments]);
  if (!node) return undefined;
  const offset = node.parent?.type === "property" ? node.parent.offset : node.offset;
  let line = 1;
  for (let i = 0; i < offset && i < normalizedText.length; i += 1) {
    if (normalizedText.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

export function findLineForPath(
  lines: readonly string[],
  segments: readonly PathSegment[],
  format: ConfigFormat,
): number | undefined {
  const leaf = String(segments.at(-1) ?? "");
  if (!leaf) return undefined;
  const escapedLeaf = escapeRegExp(leaf);
  const fullPath = formatPath(segments);

  if (format === "properties") {
    const propRe = new RegExp(`^\\s*${escapeRegExp(fullPath)}\\s*(?:[:=]|\\s)`);
    const idx = lines.findIndex((line) => propRe.test(line));
    if (idx >= 0) return idx + 1;
  }

  if (format === "env") {
    const envRe = new RegExp(`^\\s*(?:export\\s+)?${escapedLeaf}\\s*=`);
    const idx = lines.findIndex((line) => envRe.test(line));
    return idx >= 0 ? idx + 1 : undefined;
  }

  if (format === "yaml") {
    const yamlLine = findYamlLineForPath(lines, segments);
    if (yamlLine !== undefined) return yamlLine;
  }

  if (format === "toml" || format === "ini") {
    const sectionedLine = findSectionedLineForPath(lines, segments, format);
    if (sectionedLine !== undefined) return sectionedLine;
  }

  // Fallback progressive narrowing across ancestor segments
  let startIndex = 0;
  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const ancestor = String(segments[depth] ?? "");
    if (!ancestor) continue;
    const ancestorRe = format === "ini" || format === "toml"
      ? new RegExp(`^\\s*\\[+[^\\]]*\\b${escapeRegExp(ancestor)}\\b`)
      : new RegExp(`^\\s*(?:-\\s+)?["']?${escapeRegExp(ancestor)}["']?\\s*[:=]`);
    for (let i = startIndex; i < lines.length; i += 1) {
      if (ancestorRe.test(lines[i] ?? "")) {
        startIndex = i;
        break;
      }
    }
  }

  const keyRe = new RegExp(`^\\s*(?:-\\s+)?["']?${escapedLeaf}["']?\\s*[:=]`);
  for (let i = startIndex; i < lines.length; i += 1) {
    if (keyRe.test(lines[i] ?? "")) return i + 1;
  }
  if (startIndex > 0) {
    for (let i = 0; i < startIndex; i += 1) {
      if (keyRe.test(lines[i] ?? "")) return i + 1;
    }
  }
  return undefined;
}

function findYamlLineForPath(lines: readonly string[], segments: readonly PathSegment[]): number | undefined {
  const target = segments.map((segment) => String(segment));
  const stack: Array<{ indent: number; key: string }> = [];
  let yamlBlockIndent: number | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const leadingIndent = line.match(/^\s*/)?.[0].length ?? 0;
    if (yamlBlockIndent !== undefined) {
      if (leadingIndent > yamlBlockIndent) continue;
      yamlBlockIndent = undefined;
    }

    const match = line.match(/^(\s*)(-\s+)?((?:"[^"]*"|'[^']*'|[^:#\r\n]+?))\s*:(?:\s*(.*))?$/);
    if (!match) continue;
    const [, spaces = "", dash = "", rawKey = "", rest = ""] = match;
    const keyIndent = spaces.length + dash.length;
    const key = unquoteSimple(rawKey.trim());

    while (stack.length > 0 && stack.at(-1)!.indent >= keyIndent) {
      stack.pop();
    }
    stack.push({ indent: keyIndent, key });

    if (stack.length === target.length && stack.every((item, idx) => item.key === target[idx])) {
      return i + 1;
    }

    // Inline flow mapping on parent line, e.g. `api: { port: 3000 }`
    if (
      rest.trim().startsWith("{")
      && stack.length === target.length - 1
      && stack.every((item, idx) => item.key === target[idx])
    ) {
      const leafRe = new RegExp(`(?:^|[{,\\s])["']?${escapeRegExp(target.at(-1)!)}["']?\\s*:`);
      if (leafRe.test(rest)) return i + 1;
    }

    if (YAML_BLOCK_HEADER_RE.test(line)) {
      yamlBlockIndent = leadingIndent;
    }
  }
  return undefined;
}

function findSectionedLineForPath(
  lines: readonly string[],
  segments: readonly PathSegment[],
  format: "toml" | "ini",
): number | undefined {
  const target = segments.map((segment) => String(segment));
  let currentSection: string[] = [];
  let tomlTriple: '"""' | "'''" | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (format === "toml" && tomlTriple) {
      tomlTriple = scanTomlLineForComment(line, tomlTriple).nextTriple;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || (format === "ini" && trimmed.startsWith(";"))) {
      continue;
    }

    if (format === "toml") {
      const headerMatch = trimmed.match(/^\[\[?\s*(.+?)\s*\]\]?\s*(?:#.*)?$/);
      if (headerMatch?.[1]) {
        currentSection = splitTomlKeyPath(headerMatch[1]);
        continue;
      }
      const assignMatch = line.match(/^\s*((?:"[^"]*"|'[^']*'|[^=#\r\n]+?))\s*=\s*(.*)$/);
      if (assignMatch?.[1]) {
        const keyParts = splitTomlKeyPath(assignMatch[1].trim());
        const full = [...currentSection, ...keyParts];
        if (full.length === target.length && full.every((part, idx) => part === target[idx])) {
          return i + 1;
        }
        // Inline table, e.g. `api = { port = 3000 }` under `[services]`
        const rhs = assignMatch[2] ?? "";
        if (
          rhs.trim().startsWith("{")
          && full.length === target.length - 1
          && full.every((part, idx) => part === target[idx])
        ) {
          const leafRe = new RegExp(`(?:^|[{,\\s])["']?${escapeRegExp(target.at(-1)!)}["']?\\s*=`);
          if (leafRe.test(rhs)) return i + 1;
        }
        tomlTriple = scanTomlLineForComment(line, undefined).nextTriple;
      }
      continue;
    }

    // INI
    const iniSection = trimmed.match(/^\[([^\]]+)\]\s*(?:[#;].*)?$/);
    if (iniSection?.[1]) {
      currentSection = iniSection[1].split(".").map((part) => part.trim()).filter(Boolean);
      continue;
    }
    const iniAssign = line.match(/^\s*([^:=#;\r\n]+?)\s*[:=]/);
    if (iniAssign?.[1]) {
      const rawKey = iniAssign[1].trim();
      const key = rawKey.endsWith("[]") ? rawKey.slice(0, -2) : rawKey;
      const full = [...currentSection, key];
      if (full.length === target.length && full.every((part, idx) => part === target[idx])) {
        return i + 1;
      }
    }
  }
  return undefined;
}

function splitTomlKeyPath(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (quote) {
      if (escaped) {
        current += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (ch === quote) {
        quote = undefined;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      const trimmed = current.trim();
      if (trimmed) parts.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = current.trim();
  if (tail) parts.push(tail);
  return parts;
}

function unquoteSimple(raw: string): string {
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function formatSearchableValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function truncateSnippet(text: string, maxLength: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
