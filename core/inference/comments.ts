import * as ini from "ini";
import { createScanner, parseTree, SyntaxKind, type Node as JsoncNode, type ParseError } from "jsonc-parser";
import { isCollection, isMap, isNode, isPair, isScalar, isSeq } from "yaml";
import type { ConfigFormat, Locale, PathSegment } from "../../shared/schema.ts";
import { isForbiddenKey } from "../../shared/validation.ts";
import { stripBom } from "../formats/common.ts";
import { splitEnvValueAndComment } from "../formats/env.ts";
import { matchIniAssignment, parseIniSection, splitIniValueAndComment } from "../formats/ini.ts";
import { groupPropertyLines, joinPropertyLines, unescapeProperty } from "../formats/properties.ts";
import { scanTomlLines } from "../formats/toml.ts";
import { parseYamlDocuments } from "../formats/yaml.ts";
import { pathKey } from "../paths.ts";
import { maskDocumentSecrets } from "./heuristic.ts";
import type { FieldCandidate } from "./types.ts";

const MAX_COMMENTS = 2_000;
const MAX_COMMENT_CHARS = 500;
const MAX_WALK_DEPTH = 8;

const PRAGMA_LINE_RE = /^(?:yaml-language-server\s*:|:\s*schema\b|eslint-disable|eslint-enable|prettier-ignore|biome-ignore|@ts-(?:ignore|expect-error|nocheck|check)\b|noinspection\b|fmt\s*:\s*(?:on|off)|type\s*:\s*ignore|cspell\s*:|shellcheck\b|rubocop\s*:|pylint\s*:|flake8\s*:|noqa\b)/i;
const DECORATIVE_LINE_RE = /^[-=*#_~+./\\|:\s]{2,}$/;

export interface ExtractedComment {
  segments: PathSegment[];
  comment: string;
  leading?: string;
  trailing?: string;
}

export interface ExtractCommentsOptions {
  /** Zero-based document index when extracting comments from multi-document YAML. */
  documentIndex?: number;
  /** Optional known secret values (length >= 6) from the parsed file to redact if echoed inside comments. */
  secretValues?: readonly string[];
}

export interface InferCommentFieldsOptions extends ExtractCommentsOptions {
  locale?: Locale;
  /**
   * Optional list of candidate paths already discovered in the file.
   * When supplied, comments on container ancestors (strict prefixes of an
   * expanded child field) are skipped so they never collapse child fields
   * during candidate merging.
   */
  existingPaths?: readonly (readonly PathSegment[])[];
}

/**
 * Extracts leading and trailing inline comments mapped to exact configuration
 * paths across all 6 supported formats with zero network access. Every comment
 * is sanitized through `maskDocumentSecrets` before leaving this module so
 * credentials embedded inside comments can never leak into descriptions or UI.
 */
export function extractCommentMap(
  rawText: string,
  format: ConfigFormat,
  options: ExtractCommentsOptions = {},
): Map<string, ExtractedComment> {
  const source = stripBom(rawText);
  if (!source.trim()) return new Map();

  const secretValues = [...new Set((options.secretValues ?? []).filter((v) => v.length >= 6))]
    .sort((left, right) => right.length - left.length);

  let rawEntries: RawCommentEntry[];
  switch (format) {
    case "yaml":
      rawEntries = extractYamlComments(source, options.documentIndex ?? 0);
      break;
    case "json":
    case "jsonc":
      rawEntries = extractJsoncComments(source);
      break;
    case "toml":
      rawEntries = extractTomlComments(source);
      break;
    case "env":
      rawEntries = extractEnvComments(source);
      break;
    case "ini":
      rawEntries = extractIniComments(source);
      break;
    case "properties":
      rawEntries = extractPropertiesComments(source);
      break;
  }

  const map = new Map<string, ExtractedComment>();
  for (const entry of rawEntries) {
    if (map.size >= MAX_COMMENTS) break;
    if (!entry.segments.length || entry.segments.some((s) => typeof s === "string" && isForbiddenKey(s))) continue;
    const leading = sanitizeCommentBlock(entry.leading, secretValues);
    const trailing = sanitizeCommentBlock(entry.trailing, secretValues);
    const combined = combineLeadingAndTrailing(leading, trailing);
    if (!combined) continue;
    const key = pathKey(entry.segments);
    if (!map.has(key)) {
      map.set(key, {
        segments: [...entry.segments],
        comment: combined,
        leading,
        trailing,
      });
    }
  }
  return map;
}

/**
 * Converts local file comments into high-confidence `comment` field candidates
 * for the Confui inference pipeline.
 */
export function inferCommentFields(
  rawText: string,
  format: ConfigFormat,
  options: InferCommentFieldsOptions = {},
): FieldCandidate[] {
  const comments = extractCommentMap(rawText, format, options);
  if (!comments.size) return [];

  const locale: Locale = options.locale === "en-US" ? "en-US" : "zh-CN";
  const detail = locale === "en-US"
    ? "Extracted from local config file comments"
    : "提取自原配置文件中的本地注释";
  const existingPaths = options.existingPaths;
  const existingKeySet = existingPaths
    ? new Set(existingPaths.map((segments) => pathKey(segments)))
    : undefined;

  const candidates: FieldCandidate[] = [];
  let order = 5_000;
  for (const [key, entry] of comments) {
    if (existingPaths && existingKeySet) {
      // Never emit a comment for a container ancestor whose children are already expanded fields.
      if (existingPaths.some((candidatePath) => isStrictPrefix(entry.segments, candidatePath))) {
        continue;
      }
      // Only enrich paths actually present in the discovered field set.
      if (!existingKeySet.has(key)) {
        continue;
      }
    }
    candidates.push({
      segments: [...entry.segments],
      description: entry.comment,
      source: "comment",
      confidence: 0.94,
      detail,
      order: order++,
    });
  }
  return candidates;
}

interface RawCommentEntry {
  segments: PathSegment[];
  leading?: string;
  trailing?: string;
}

/* -------------------------------------------------------------------------- */
/* 1. YAML CST comment extraction (`yaml` v2 `commentBefore` / `comment`)     */
/* -------------------------------------------------------------------------- */

function extractYamlComments(source: string, documentIndex: number): RawCommentEntry[] {
  let docs;
  try {
    docs = parseYamlDocuments(source);
  } catch {
    return [];
  }
  const target = docs[documentIndex];
  if (!target?.document.contents) return [];

  const lineIndex = buildLineStartIndex(source);
  const lines = source.split(/\r?\n/);
  const entries: RawCommentEntry[] = [];

  function walk(node: unknown, prefix: PathSegment[], depth: number): void {
    if (entries.length >= MAX_COMMENTS || depth > MAX_WALK_DEPTH) return;

    if (isMap(node)) {
      for (let pairIdx = 0; pairIdx < node.items.length; pairIdx += 1) {
        if (entries.length >= MAX_COMMENTS) return;
        const pair = node.items[pairIdx];
        if (!isPair(pair) || !isScalar(pair.key)) continue;
        const keyText = String(pair.key.value ?? "");
        if (!keyText || keyText === "$schema" || isForbiddenKey(keyText)) continue;

        const segments: PathSegment[] = [...prefix, keyText];
        const keyRange = pair.key.range;
        const keyLine = keyRange ? offsetToLineIndex(lineIndex, keyRange[0]) : undefined;

        // Leading comment from CST `key.commentBefore` or parent map's `commentBefore` (for first child key).
        let leading: string | undefined;
        if (pair.key.commentBefore) {
          leading = extractLastContiguousCommentParagraph(pair.key.commentBefore, lines, keyLine);
        } else if (pairIdx === 0 && node.commentBefore && keyLine !== undefined) {
          // `yaml` v2 attaches comments immediately above a map's first key onto `map.commentBefore`,
          // which may also start with the parent key's inline comment. Filter to lines strictly above
          // the first key with no intervening blank line.
          leading = extractLeadingHashLinesAbove(lines, keyLine);
        }

        // Trailing inline comment: lives on `pair.value.comment` for scalars or `pair.key.comment` for empty values,
        // or on the key's own line for map/seq values (`server: # inline`).
        let trailing: string | undefined;
        if (isNode(pair.value) && !isCollection(pair.value) && pair.value.comment) {
          trailing = pair.value.comment;
        } else if (pair.key.comment) {
          trailing = pair.key.comment;
        } else if (isCollection(pair.value) && keyLine !== undefined) {
          trailing = extractInlineYamlCommentOnLine(lines[keyLine] ?? "");
        }

        if (leading || trailing) {
          entries.push({ segments, leading, trailing });
        }

        if (isCollection(pair.value)) {
          walk(pair.value, segments, depth + 1);
        }
      }
      return;
    }

    if (isSeq(node)) {
      for (let idx = 0; idx < node.items.length; idx += 1) {
        if (entries.length >= MAX_COMMENTS) return;
        const item = node.items[idx];
        if (isCollection(item)) {
          walk(item, [...prefix, idx], depth + 1);
        }
      }
    }
  }

  walk(target.document.contents, [], 0);
  return entries;
}

function extractLastContiguousCommentParagraph(
  cstComment: string,
  lines: readonly string[],
  keyLine: number | undefined,
): string | undefined {
  if (keyLine !== undefined && keyLine > 0 && !(lines[keyLine - 1] ?? "").trim()) {
    // Blank line immediately before the key separates any earlier file/section header comment.
    return undefined;
  }
  const paragraphs = cstComment.split(/\r?\n[ \t]*\r?\n/);
  const last = paragraphs.at(-1)?.trim();
  return last || undefined;
}

function extractLeadingHashLinesAbove(lines: readonly string[], keyLine: number): string | undefined {
  const collected: string[] = [];
  for (let i = keyLine - 1; i >= 0; i -= 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) break;
    if (!trimmed.startsWith("#")) break;
    collected.push(trimmed.slice(1));
  }
  if (!collected.length) return undefined;
  collected.reverse();
  return collected.join("\n");
}

function extractInlineYamlCommentOnLine(line: string): string | undefined {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
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
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1] ?? ""))) {
      return line.slice(i + 1);
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* 2. JSONC / JSON lexical comment extraction (`jsonc-parser` scanner + tree) */
/* -------------------------------------------------------------------------- */

interface JsoncCommentToken {
  offset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  text: string;
}

function extractJsoncComments(source: string): RawCommentEntry[] {
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree) return [];

  const lineIndex = buildLineStartIndex(source);
  const scanner = createScanner(source, false);
  const comments: JsoncCommentToken[] = [];
  const tokenLinesWithCode = new Set<number>();

  while (true) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EOF) break;
    if (kind === SyntaxKind.LineCommentTrivia || kind === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset();
      const length = scanner.getTokenLength();
      const raw = scanner.getTokenValue();
      const text = kind === SyntaxKind.LineCommentTrivia
        ? raw.replace(/^\/\//, "")
        : stripBlockCommentDelimiters(raw);
      comments.push({
        offset,
        endOffset: offset + length,
        startLine: offsetToLineIndex(lineIndex, offset),
        endLine: offsetToLineIndex(lineIndex, Math.max(offset, offset + length - 1)),
        text,
      });
    } else if (kind !== SyntaxKind.Trivia && kind !== SyntaxKind.LineBreakTrivia) {
      const startLine = offsetToLineIndex(lineIndex, scanner.getTokenOffset());
      tokenLinesWithCode.add(startLine);
    }
  }

  if (!comments.length) return [];

  // Index standalone leading comments by their end line and inline trailing comments by their line.
  const trailingByLine = new Map<number, JsoncCommentToken[]>();
  const standaloneByEndLine = new Map<number, JsoncCommentToken>();
  for (const token of comments) {
    if (tokenLinesWithCode.has(token.startLine)) {
      const list = trailingByLine.get(token.startLine) ?? [];
      list.push(token);
      trailingByLine.set(token.startLine, list);
    } else {
      standaloneByEndLine.set(token.endLine, token);
    }
  }

  const entries: RawCommentEntry[] = [];

  function walk(node: JsoncNode, prefix: PathSegment[], depth: number): void {
    if (entries.length >= MAX_COMMENTS || depth > MAX_WALK_DEPTH) return;

    if (node.type === "object" && node.children) {
      for (const prop of node.children) {
        if (entries.length >= MAX_COMMENTS) return;
        if (prop.type !== "property" || !prop.children || prop.children.length < 2) continue;
        const keyNode = prop.children[0]!;
        const valNode = prop.children[1]!;
        const keyName = typeof keyNode.value === "string" ? keyNode.value : "";
        if (!keyName || keyName === "$schema" || isForbiddenKey(keyName)) continue;

        const segments: PathSegment[] = [...prefix, keyName];
        const keyStartLine = offsetToLineIndex(lineIndex, keyNode.offset);
        const valEndLine = offsetToLineIndex(lineIndex, Math.max(valNode.offset, valNode.offset + valNode.length - 1));

        // Only attach standalone comments on preceding lines when this property key
        // is the first non-whitespace token on its line (so `"server": { "port": 3000 }`
        // never steals a leading comment that belongs to `"server"`).
        const keyIsFirstOnLine = source.slice(lineIndex[keyStartLine] ?? 0, keyNode.offset).trim() === "";
        const leadingParts: string[] = [];
        if (keyIsFirstOnLine) {
          let cursorLine = keyStartLine - 1;
          while (cursorLine >= 0) {
            const commentToken = standaloneByEndLine.get(cursorLine);
            if (!commentToken) break;
            leadingParts.push(commentToken.text);
            cursorLine = commentToken.startLine - 1;
          }
          leadingParts.reverse();
        }
        const leading = leadingParts.length ? leadingParts.join("\n") : undefined;

        // Inline trailing comment on the property's value end line, separated from
        // the value by only whitespace and an optional comma (so `"server": { "port": 3000 } // note`
        // attaches to `"server"` rather than `"port"`).
        const valEndOffset = valNode.offset + valNode.length;
        const inlineOnValLine = (trailingByLine.get(valEndLine) ?? []).find(
          (tok) => tok.offset >= valEndOffset && /^[\s,]*$/.test(source.slice(valEndOffset, tok.offset)),
        );
        const trailing = inlineOnValLine?.text;

        if (leading || trailing) {
          entries.push({ segments, leading, trailing });
        }

        if (valNode.type === "object" || valNode.type === "array") {
          walk(valNode, segments, depth + 1);
        }
      }
      return;
    }

    if (node.type === "array" && node.children) {
      for (let idx = 0; idx < node.children.length; idx += 1) {
        if (entries.length >= MAX_COMMENTS) return;
        const item = node.children[idx]!;
        if (item.type === "object" || item.type === "array") {
          walk(item, [...prefix, idx], depth + 1);
        }
      }
    }
  }

  walk(tree, [], 0);
  return entries;
}

function stripBlockCommentDelimiters(raw: string): string {
  const inner = raw.replace(/^\/\*/, "").replace(/\*\/$/, "");
  return inner
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* 3. TOML comment extraction (`scanTomlLines`)                               */
/* -------------------------------------------------------------------------- */

function extractTomlComments(source: string): RawCommentEntry[] {
  const lines = source.split(/\r?\n/);
  const scan = scanTomlLines(lines);
  if (!scan) return [];

  const entries: RawCommentEntry[] = [];

  // Map each section header line to its array-table element index when `isArray` is true.
  const arrayTableCounters = new Map<string, number>();
  const sectionResolvedPath: Array<{ start: number; end: number; path: PathSegment[] }> = [];
  for (const section of scan.sections) {
    let resolved: PathSegment[];
    if (section.isArray) {
      const id = pathKey(section.path);
      const idx = arrayTableCounters.get(id) ?? 0;
      arrayTableCounters.set(id, idx + 1);
      resolved = [...section.path, idx];
    } else {
      resolved = [...section.path];
    }
    sectionResolvedPath.push({ start: section.headerLine, end: section.endLine, path: resolved });

    // Also capture comments directly above a non-array `[section]` header (useful for collapsed json objects).
    if (!section.isArray && entries.length < MAX_COMMENTS) {
      const leading = collectLeadingLines(lines, section.headerLine, ["#"]);
      const trailing = extractTomlHeaderTrailingComment(lines[section.headerLine] ?? "");
      if (leading || trailing) {
        entries.push({ segments: resolved, leading, trailing });
      }
    }
  }

  for (const assignment of scan.assignments) {
    if (entries.length >= MAX_COMMENTS) break;
    let segments: PathSegment[] = [...assignment.fullPath];
    if (assignment.inArrayTable) {
      const enclosing = sectionResolvedPath.find(
        (sec) => assignment.startLine > sec.start && assignment.startLine <= sec.end,
      );
      if (enclosing) {
        const baseLen = enclosing.path.length - 1;
        const leafParts = assignment.fullPath.slice(baseLen);
        segments = [...enclosing.path, ...leafParts];
      }
    }
    const leading = collectLeadingLines(lines, assignment.startLine, ["#"]);
    const trailing = assignment.trailingComment
      ? assignment.trailingComment.replace(/^\s*#/, "")
      : undefined;
    if (leading || trailing) {
      entries.push({ segments, leading, trailing });
    }
  }

  return entries;
}

function extractTomlHeaderTrailingComment(line: string): string | undefined {
  const closeIdx = line.lastIndexOf("]");
  if (closeIdx < 0) return undefined;
  const after = line.slice(closeIdx + 1);
  const hashIdx = after.indexOf("#");
  return hashIdx >= 0 ? after.slice(hashIdx + 1) : undefined;
}

/* -------------------------------------------------------------------------- */
/* 4. ENV comment extraction                                                  */
/* -------------------------------------------------------------------------- */

function extractEnvComments(source: string): RawCommentEntry[] {
  const lines = source.split(/\r?\n/);
  const entries: RawCommentEntry[] = [];
  const pending: string[] = [];

  for (const line of lines) {
    if (entries.length >= MAX_COMMENTS) break;
    const trimmed = line.trim();
    if (!trimmed) {
      pending.length = 0;
      continue;
    }
    if (trimmed.startsWith("#")) {
      pending.push(trimmed.slice(1));
      continue;
    }
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1]) {
      const leading = pending.length ? pending.join("\n") : undefined;
      const rawComment = splitEnvValueAndComment(match[2] ?? "").comment;
      const trailing = rawComment ? rawComment.replace(/^\s*#/, "") : undefined;
      if (leading || trailing) {
        entries.push({ segments: [match[1]], leading, trailing });
      }
    }
    pending.length = 0;
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* 5. INI / .editorconfig / .npmrc comment extraction                         */
/* -------------------------------------------------------------------------- */

function extractIniComments(source: string): RawCommentEntry[] {
  const lines = source.split(/\r?\n/);
  const entries: RawCommentEntry[] = [];
  const pending: string[] = [];
  let section: string[] = [];

  for (const line of lines) {
    if (entries.length >= MAX_COMMENTS) break;
    const trimmed = line.trim();
    if (!trimmed) {
      pending.length = 0;
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith(";")) {
      pending.push(trimmed.slice(1));
      continue;
    }
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*(?:[#;].*)?$/);
    if (sectionMatch?.[1]) {
      section = parseIniSection(sectionMatch[1]);
      pending.length = 0;
      continue;
    }
    const assignment = matchIniAssignment(line);
    if (assignment) {
      const rawKey = ini.unsafe(assignment.rawKey);
      const key = rawKey.length > 2 && rawKey.endsWith("[]") ? rawKey.slice(0, -2) : rawKey;
      if (key) {
        const leading = pending.length ? pending.join("\n") : undefined;
        const rawComment = splitIniValueAndComment(assignment.rawValue).comment;
        const trailing = rawComment ? rawComment.replace(/^\s*[#;]/, "") : undefined;
        if (leading || trailing) {
          entries.push({ segments: [...section, key], leading, trailing });
        }
      }
    }
    pending.length = 0;
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* 6. Java .properties comment extraction                                     */
/* -------------------------------------------------------------------------- */

function extractPropertiesComments(source: string): RawCommentEntry[] {
  const lines = source.split(/\r?\n/);
  const groups = groupPropertyLines(lines);
  const entries: RawCommentEntry[] = [];
  const pending: string[] = [];

  for (const group of groups) {
    if (entries.length >= MAX_COMMENTS) break;
    const logical = joinPropertyLines(group)[0] ?? "";
    const trimmed = logical.trim();
    if (!trimmed) {
      pending.length = 0;
      continue;
    }
    if (trimmed.startsWith("#") || trimmed.startsWith("!")) {
      pending.push(trimmed.slice(1));
      continue;
    }
    const match = logical.match(/^\s*((?:\\.|[^:=\s])+?)\s*(?:[:=]|\s)\s*(.*)$/);
    if (match?.[1] && pending.length) {
      const key = unescapeProperty(match[1]);
      if (key) {
        entries.push({ segments: [key], leading: pending.join("\n") });
      }
    }
    pending.length = 0;
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* Shared sanitization & helpers                                              */
/* -------------------------------------------------------------------------- */

function collectLeadingLines(
  lines: readonly string[],
  targetLine: number,
  markers: readonly string[],
): string | undefined {
  const collected: string[] = [];
  for (let i = targetLine - 1; i >= 0; i -= 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed) break;
    const marker = markers.find((m) => trimmed.startsWith(m));
    if (!marker) break;
    collected.push(trimmed.slice(marker.length));
  }
  if (!collected.length) return undefined;
  collected.reverse();
  return collected.join("\n");
}

function sanitizeCommentBlock(
  raw: string | undefined,
  secretValues: readonly string[],
): string | undefined {
  if (!raw) return undefined;
  // Run `maskDocumentSecrets` on the full multi-line comment block FIRST so
  // multi-line PEM keys, DSNs, Bearer/Digest tokens, and `key=secret` examples
  // are neutralized before any further processing.
  let masked = maskDocumentSecrets(raw);
  for (const secret of secretValues) {
    if (masked.includes(secret)) {
      masked = masked.split(secret).join("***");
    }
  }

  const cleanedLines: string[] = [];
  for (const line of masked.split(/\r?\n/)) {
    const rawTrimmed = line.trim();
    if (!rawTrimmed) continue;
    const trimmed = rawTrimmed === "***"
      ? "***"
      : rawTrimmed.replace(/^(?:[#;!/]+|\*(?!\*\*))+\s*/, "").trim();
    if (!trimmed) continue;
    if (PRAGMA_LINE_RE.test(trimmed)) continue;
    if (trimmed !== "***" && DECORATIVE_LINE_RE.test(trimmed)) continue;
    cleanedLines.push(trimmed);
  }
  if (!cleanedLines.length) return undefined;
  const joined = cleanedLines.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return undefined;
  return joined.slice(0, MAX_COMMENT_CHARS);
}

function combineLeadingAndTrailing(
  leading: string | undefined,
  trailing: string | undefined,
): string | undefined {
  if (leading && trailing) {
    if (leading.toLowerCase().includes(trailing.toLowerCase())) return leading;
    return `${leading} — ${trailing}`.slice(0, MAX_COMMENT_CHARS);
  }
  return leading ?? trailing;
}

function buildLineStartIndex(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function offsetToLineIndex(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lineStarts[mid]! <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(0, high);
}

function isStrictPrefix(prefix: readonly PathSegment[], full: readonly PathSegment[]): boolean {
  return prefix.length < full.length && prefix.every((segment, index) => segment === full[index]);
}
