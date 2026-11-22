import { lstat } from "node:fs/promises";
import type {
  ConfigFile,
  ConfigFormat,
  PathSegment,
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
import { formatPath, resolveExistingProjectPath } from "./paths.ts";
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

/**
 * Concurrently searches readable configuration files in a project by key path,
 * non-sensitive values, and comments. Enforces strict concurrency, total-byte,
 * and result-count budgets; skips oversized/unsupported/symlink files; and
 * strictly redacts secret field hits so only their locations are reported.
 */
export async function searchProjectConfigs(
  root: string,
  query: string,
  options: ProjectSearchOptions = {},
): Promise<ProjectSearchResult> {
  if (typeof root !== "string" || !root.trim()) {
    throw new ConfuiError("INVALID_INPUT", "项目路径不能为空");
  }
  if (typeof query !== "string" || query.length > MAX_QUERY_CHARS || query.includes("\0")) {
    throw new ConfuiError("INVALID_INPUT", "搜索关键词无效");
  }
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query: "",
      hits: [],
      searchedFiles: 0,
      skippedFiles: 0,
      truncated: false,
    };
  }

  const limit = clampInt(options.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxTotalBytes = clampInt(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1_024, MAX_TOTAL_BYTES_CAP);
  const concurrency = clampInt(options.concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
  const needle = trimmed.toLowerCase();

  const scanned = await scanProject(root);
  const openable: ConfigFile[] = [];
  let skippedFiles = 0;
  for (const file of scanned.files) {
    if (file.status === "ready" || file.status === "large") openable.push(file);
    else skippedFiles += 1;
  }

  let searchedFiles = 0;
  let bytesBudgetUsed = 0;
  let truncated = false;
  const collected: ProjectSearchHit[] = [];

  let cursor = 0;
  const workerCount = Math.min(concurrency, openable.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < openable.length) {
      if (collected.length >= limit) {
        truncated = true;
        return;
      }
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
        const resolved = await resolveExistingProjectPath(scanned.root, file.path);
        const info = await lstat(resolved.path);
        if (info.isSymbolicLink() || !info.isFile()) {
          skippedFiles += 1;
          continue;
        }
        const snapshot = await readTextSnapshot(resolved.path);
        assertEditableSyntax(file.path, snapshot.text);
        const parsed = parseConfig(snapshot.text, file.format);
        searchedFiles += 1;

        const fileHits = searchSingleFile(file, snapshot.text, parsed, needle, limit);
        for (const hit of fileHits) {
          if (collected.length >= limit) {
            truncated = true;
            break;
          }
          collected.push(hit);
        }
      } catch {
        skippedFiles += 1;
      }
    }
  });

  await Promise.all(workers);

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
  maxHits: number,
): ProjectSearchHit[] {
  const hits: ProjectSearchHit[] = [];
  const rawLines = rawText.replace(/\r\n/g, "\n").split("\n");
  let visitedLeaves = 0;

  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (hits.length >= maxHits || visitedLeaves >= MAX_LEAVES_PER_FILE) return;
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
          if (hits.length >= maxHits || visitedLeaves >= MAX_LEAVES_PER_FILE) return;
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
        line: findLineForPath(rawLines, segments, file.format),
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
        line: findLineForPath(rawLines, segments, file.format),
        matchKind: "value",
        preview: truncateSnippet(valStr, 120),
        secret: false,
      });
    }
  }

  visit(parsed, [], 0);

  if (hits.length < maxHits) {
    const comments = extractFileComments(rawText, file.format);
    for (const comment of comments) {
      if (hits.length >= maxHits) break;
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

  // YAML, TOML, ENV, INI: quote-aware `#` (and `;` for INI) comments
  const markers = format === "ini" ? ["#", ";"] : ["#"];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const comment = findHashComment(line, markers);
    if (comment) comments.push({ line: i + 1, text: comment });
  }
  return comments;
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

function findLineForPath(
  lines: readonly string[],
  segments: readonly PathSegment[],
  format: ConfigFormat,
): number | undefined {
  const leaf = String(segments.at(-1) ?? "");
  if (!leaf) return undefined;
  const escapedLeaf = escapeRegExp(leaf);
  const fullPath = formatPath(segments);

  if (format === "properties") {
    const propRe = new RegExp(`^\\s*${escapeRegExp(fullPath)}\\s*[:=]`);
    const idx = lines.findIndex((line) => propRe.test(line));
    if (idx >= 0) return idx + 1;
  }

  // If nested (e.g. INI/TOML section `[server]` or YAML/JSON parent block), try narrowing after parent line.
  let startIndex = 0;
  if (segments.length > 1) {
    const parent = String(segments[0] ?? "");
    if (parent) {
      const parentRe = format === "ini" || format === "toml"
        ? new RegExp(`^\\s*\\[${escapeRegExp(parent)}(?:\\.|\\])`)
        : new RegExp(`^\\s*["']?${escapeRegExp(parent)}["']?\\s*[:=]`);
      const parentIdx = lines.findIndex((line) => parentRe.test(line));
      if (parentIdx >= 0) startIndex = parentIdx;
    }
  }

  const keyRe = format === "env"
    ? new RegExp(`^\\s*(?:export\\s+)?${escapedLeaf}\\s*=`)
    : new RegExp(`^\\s*(?:-\\s+)?["']?${escapedLeaf}["']?\\s*[:=]`);

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
