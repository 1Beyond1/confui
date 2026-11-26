import type { ConfigFormat, DocumentSecretMeta, FieldSpec, PathSegment, SaveChangePreview } from "./schema.ts";
import {
  AUTH_BEARER_BASIC_RE,
  AUTH_DIGEST_RE,
  AUTH_TOKEN_HEADER_RE,
  collectSecretStrings,
  containsSecretValuePattern,
  JWT_TOKEN_RE,
  PEM_BEGIN_RE,
  PEM_END_RE,
  SECRET_KEY_FRAGMENT,
  SECRET_KEY_PATTERN,
  SLACK_WEBHOOK_RE,
  URL_CREDENTIALS_RE,
  valueContainsSecret,
  VENDOR_TOKEN_RE,
} from "./validation.ts";

export type DiffLineKind = "context" | "add" | "remove";

export const DIFF_SECRET_MASK = "••••••••";

export interface DocumentLineSecrets {
  /** 1-based inclusive start line for this document section. */
  startLine: number;
  /** Optional 1-based exclusive end line for this document section. */
  endLine?: number;
  secretKeys?: readonly string[];
  secretValues?: readonly string[];
}

export interface MaskUnifiedDiffOptions {
  /** Optional format hint (e.g. `properties`, `toml`, `yaml`, `jsonc`) for format-accurate masking. */
  format?: ConfigFormat;
  /** Full original text before hunk splitting (used to precompute multi-line secret state). */
  oldText?: string;
  /** Full updated text before hunk splitting (used to precompute multi-line secret state). */
  newText?: string;
  /** Extra key names (e.g. leaf names or paths of schema-marked secret fields). */
  secretKeys?: readonly string[];
  /** Explicit known secret values (length >= 6) used as fallback redaction for multi-line values. */
  secretValues?: readonly string[];
  /** Optional per-document secret scopes (used for multi-document YAML isolation). */
  documentSecrets?: readonly DocumentLineSecrets[];
  /** Optional per-document secret scopes specific to `oldText` (when old/new doc line ranges differ). */
  oldDocumentSecrets?: readonly DocumentLineSecrets[];
  /** Optional per-document secret scopes specific to `newText` (when old/new doc line ranges differ). */
  newDocumentSecrets?: readonly DocumentLineSecrets[];
  /** Replacement mask string (defaults to `••••••••`). */
  mask?: string;
}

export interface MaskedUnifiedDiffResult {
  diff: UnifiedDiffResult;
  maskedLineCount: number;
}

export interface MaskedDocumentLinesResult {
  lines: string[];
  maskedLineFlags: boolean[];
  maskedLineCount: number;
}

export interface DiffLine {
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface UnifiedDiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_LCS_CELLS = 2_500_000;

/**
 * Remembers the full source texts that produced a `UnifiedDiffResult` without
 * polluting its serializable shape, so `maskUnifiedDiff(diff)` always has
 * complete multi-line secret state even across truncated hunks.
 */
const diffSourceTexts = new WeakMap<UnifiedDiffResult, { oldText: string; newText: string }>();

/**
 * Computes line-level unified diff hunks between two texts using LCS with
 * common prefix/suffix trimming and a safe fallback for very large edits.
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): UnifiedDiffResult {
  if (oldText === newText) {
    const empty: UnifiedDiffResult = { hunks: [], added: 0, removed: 0, truncated: false };
    diffSourceTexts.set(empty, { oldText, newText });
    return empty;
  }
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);

  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < minLen - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix);
  const newMid = newLines.slice(prefix, newLines.length - suffix);

  let ops: DiffLine[] = [];
  let truncated = false;

  for (let i = 0; i < prefix; i += 1) {
    ops.push({ kind: "context", oldLine: i + 1, newLine: i + 1, text: oldLines[i]! });
  }

  if (oldMid.length * newMid.length <= MAX_LCS_CELLS) {
    ops.push(...diffLcs(oldMid, newMid, prefix + 1, prefix + 1));
  } else {
    truncated = true;
    for (let i = 0; i < oldMid.length; i += 1) {
      ops.push({ kind: "remove", oldLine: prefix + i + 1, text: oldMid[i]! });
    }
    for (let j = 0; j < newMid.length; j += 1) {
      ops.push({ kind: "add", newLine: prefix + j + 1, text: newMid[j]! });
    }
  }

  for (let i = 0; i < suffix; i += 1) {
    const oldIdx = oldLines.length - suffix + i;
    const newIdx = newLines.length - suffix + i;
    ops.push({ kind: "context", oldLine: oldIdx + 1, newLine: newIdx + 1, text: oldLines[oldIdx]! });
  }

  let added = 0;
  let removed = 0;
  for (const line of ops) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "remove") removed += 1;
  }

  const hunks = groupIntoHunks(ops, contextLines);
  const result: UnifiedDiffResult = { hunks, added, removed, truncated };
  diffSourceTexts.set(result, { oldText, newText });
  return result;
}

export function formatUnifiedDiffText(
  oldText: string,
  newText: string,
  fileName: string,
  contextLines = 3,
): string {
  const { hunks } = computeUnifiedDiff(oldText, newText, contextLines);
  if (!hunks.length) return "";
  const out: string[] = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      const marker = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
      out.push(`${marker}${line.text}`);
    }
  }
  return out.join("\n");
}

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines;
}

function diffLcs(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldBase: number,
  newBase: number,
): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;
  const cols = n + 1;
  const dp = new Uint32Array((m + 1) * cols);

  for (let i = m - 1; i >= 0; i -= 1) {
    const row = i * cols;
    const nextRow = (i + 1) * cols;
    for (let j = n - 1; j >= 0; j -= 1) {
      if (oldLines[i] === newLines[j]) {
        dp[row + j] = dp[nextRow + j + 1]! + 1;
      } else {
        const down = dp[nextRow + j]!;
        const right = dp[row + j + 1]!;
        dp[row + j] = down >= right ? down : right;
      }
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      result.push({ kind: "context", oldLine: oldBase + i, newLine: newBase + j, text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j]! >= dp[i * cols + j + 1]!) {
      result.push({ kind: "remove", oldLine: oldBase + i, text: oldLines[i]! });
      i += 1;
    } else {
      result.push({ kind: "add", newLine: newBase + j, text: newLines[j]! });
      j += 1;
    }
  }
  while (i < m) {
    result.push({ kind: "remove", oldLine: oldBase + i, text: oldLines[i]! });
    i += 1;
  }
  while (j < n) {
    result.push({ kind: "add", newLine: newBase + j, text: newLines[j]! });
    j += 1;
  }
  return result;
}

function groupIntoHunks(ops: readonly DiffLine[], contextLines: number): DiffHunk[] {
  const changeIndices: number[] = [];
  for (let i = 0; i < ops.length; i += 1) {
    if (ops[i]!.kind !== "context") changeIndices.push(i);
  }
  if (!changeIndices.length) return [];

  const ranges: Array<[number, number]> = [];
  for (const idx of changeIndices) {
    const start = Math.max(0, idx - contextLines);
    const end = Math.min(ops.length - 1, idx + contextLines);
    const prev = ranges.at(-1);
    if (prev && start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      ranges.push([start, end]);
    }
  }

  return ranges.map(([start, end]) => {
    const slice = ops.slice(start, end + 1);
    const firstOld = slice.find((line) => line.oldLine !== undefined)?.oldLine ?? 1;
    const firstNew = slice.find((line) => line.newLine !== undefined)?.newLine ?? 1;
    let oldCount = 0;
    let newCount = 0;
    for (const line of slice) {
      if (line.kind !== "add") oldCount += 1;
      if (line.kind !== "remove") newCount += 1;
    }
    return {
      oldStart: oldCount === 0 ? Math.max(0, firstOld - 1) : firstOld,
      oldCount,
      newStart: newCount === 0 ? Math.max(0, firstNew - 1) : firstNew,
      newCount,
      lines: slice,
    };
  });
}

const INLINE_KEY_VALUE_SECRET_RE = new RegExp(
  `(["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*[=:]\\s*)("""(?:[^\\\\]|\\\\.)*?"""|'''[\\s\\S]*?'''|"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'|\`[^\`]*\`|[^\\s,;}\\]]+)`,
  "gi",
);
const INLINE_SECRET_CONTAINER_RE = new RegExp(
  `(["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*[=:]\\s*)([\\[{])`,
  "gi",
);
const INLINE_PEM_SINGLE_LINE_RE = /(-----BEGIN (?:(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----)([\s\S]*?)(-----END (?:(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----)/g;
const YAML_BLOCK_SCALAR_RE = /^[|>](?:[-+]?\d*|\d*[-+])?(?:\s+#.*)?$/;
const KV_LINE_RE = /^(\s*(?:export\s+|-\s+)?)((?:"[^"]*"|'[^']*'|[^:=#\r\n]+?))(\s*[:=]\s*)(.*)$/;
const PROPERTIES_KV_LINE_RE = /^(\s*)((?:\\.|[^:=\s#!])+?)(\s*(?:[:=]|\s)\s*)(.*)$/;
const WHITESPACE_SECRET_KV_RE = /^(\s*)((?:\\.|[A-Za-z_][\w.-]*))(\s+)(\S.*)$/;
const YAML_SEQ_ITEM_RE = /^(\s*-\s+)(.*)$/;
const COMMENT_LINE_RE = /^\s*(?:#|;|\/\/|\/\*|\*\/)/;
const NPMRC_KEY_LINE_RE = /^\s*\/\/[^\s=\r\n]+\/[^=\r\n]*=/;
const AUTH_SCHEME_VALUE_RE = /^((?:Bearer|Basic|Digest|Token|ApiKey|API-Key|JWT|OAuth)\s+)(.+)$/i;

interface MaskConfig {
  mask: string;
  format?: ConfigFormat;
  extraKeys: ReadonlySet<string>;
  extraValues: readonly string[];
}

interface DocumentMaskState {
  inPemBlock: boolean;
  yamlBlockIndent: number | undefined;
  yamlSecretSubtreeIndent: number | undefined;
  tomlTripleQuote: '"""' | "'''" | undefined;
  envMultilineQuote: '"' | "'" | "`" | undefined;
  secretContainerStack: Array<"array" | "object">;
  inBackslashContinuation: boolean;
}

function createInitialState(): DocumentMaskState {
  return {
    inPemBlock: false,
    yamlBlockIndent: undefined,
    yamlSecretSubtreeIndent: undefined,
    tomlTripleQuote: undefined,
    envMultilineQuote: undefined,
    secretContainerStack: [],
    inBackslashContinuation: false,
  };
}

function buildMaskConfig(options: MaskUnifiedDiffOptions): MaskConfig {
  const mask = options.mask ?? DIFF_SECRET_MASK;
  const extraKeys = new Set(
    (options.secretKeys ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const extraValues = [...new Set((options.secretValues ?? []).filter((v) => v.length >= 6))]
    .sort((left, right) => right.length - left.length);
  return { mask, format: options.format, extraKeys, extraValues };
}

/**
 * Recursively collects schema-marked and nested secret key names and string
 * values (scalars, arrays, nested objects, and multi-line sub-lines) from
 * `FieldSpec` lists and optional `SaveChangePreview` entries.
 */
export function collectSecretsFromFields(
  fields: readonly FieldSpec[],
  changes?: readonly SaveChangePreview[],
): { secretKeys: string[]; secretValues: string[] } {
  const keys = new Set<string>();
  const values = new Set<string>();
  const secretPaths = new Set<string>();

  function collectNested(value: unknown, insideSecret: boolean, depth = 0): void {
    if (depth > 16 || value === undefined || value === null) return;
    if (typeof value === "string") {
      if (insideSecret || containsSecretValuePattern(value)) {
        collectSecretStrings(value, values);
      }
      return;
    }
    if (Array.isArray(value)) {
      if (insideSecret) {
        collectSecretStrings(value, values);
        return;
      }
      for (const item of value) collectNested(item, false, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
        const keySecret = insideSecret || SECRET_KEY_PATTERN.test(k);
        if (keySecret && k.trim()) keys.add(k);
        collectNested(item, keySecret, depth + 1);
      }
    }
  }

  for (const field of fields) {
    const isFieldSecret = Boolean(field.secret || field.type === "secret" || SECRET_KEY_PATTERN.test(field.path));
    if (isFieldSecret) {
      secretPaths.add(field.path);
      keys.add(field.path);
      const leaf = field.segments.at(-1);
      if (typeof leaf === "string" && leaf.trim()) keys.add(leaf);
    }
    collectNested(field.value, isFieldSecret);
  }

  for (const change of changes ?? []) {
    const isChangeSecret = secretPaths.has(change.path) || SECRET_KEY_PATTERN.test(change.path);
    if (isChangeSecret) {
      keys.add(change.path);
      const lastSegment = change.path.split(".").at(-1)?.trim();
      if (lastSegment) keys.add(lastSegment);
    }
    collectNested(change.before, isChangeSecret);
    collectNested(change.after, isChangeSecret);
  }

  return { secretKeys: [...keys], secretValues: [...values] };
}

export interface YamlDocumentSecretScopeInput {
  documentIndex: number;
  secretKeys?: readonly string[];
  secretValues?: readonly string[];
}

/**
 * Scans 1-based `[startLine, endLine)` document line ranges in a YAML file
 * without requiring Node APIs, handling UTF-8 BOM, leading `---`, empty docs
 * (`---\n---`), and `...` end-of-document boundaries.
 */
export function scanYamlDocumentLineRanges(
  text: string,
): Array<{ documentIndex: number; startLine: number; endLine?: number }> {
  const clean = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = clean.replace(/\r\n/g, "\n").split("\n");
  const starts: number[] = [];
  let seenDocBodyOrMarker = false;
  let afterDocEnd = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNumber = i + 1;
    const trimmed = line.trim();

    if (/^---(?:[ \t]|$)/.test(line)) {
      starts.push(starts.length === 0 ? 1 : lineNumber);
      seenDocBodyOrMarker = true;
      afterDocEnd = false;
      continue;
    }

    if (/^\.\.\.(?:[ \t]|$)/.test(line)) {
      if (starts.length === 0 && seenDocBodyOrMarker) {
        starts.push(1);
      }
      afterDocEnd = true;
      continue;
    }

    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("%")) {
      continue;
    }

    if (starts.length === 0) {
      starts.push(1);
      seenDocBodyOrMarker = true;
      afterDocEnd = false;
    } else if (afterDocEnd) {
      starts.push(lineNumber);
      seenDocBodyOrMarker = true;
      afterDocEnd = false;
    }
  }

  if (starts.length === 0) return [{ documentIndex: 0, startLine: 1 }];
  return starts.map((startLine, idx) => ({
    documentIndex: idx,
    startLine: idx === 0 ? 1 : startLine,
    endLine: starts[idx + 1],
  }));
}

/**
 * Maps per-document secret metadata onto exact line ranges computed from the
 * target YAML text (`oldText` or `newText`), preventing cross-document secret
 * leaks and cross-document false masking even when edits shift line numbers.
 */
export function buildYamlDocumentLineSecrets(
  text: string,
  documentSecrets: readonly YamlDocumentSecretScopeInput[],
  extraByDocument?: ReadonlyMap<number, { secretKeys?: readonly string[]; secretValues?: readonly string[] }>,
): DocumentLineSecrets[] | undefined {
  if (!documentSecrets.length) return undefined;
  const ranges = scanYamlDocumentLineRanges(text);
  if (ranges.length <= 1 && documentSecrets.length <= 1) return undefined;

  const metaByDoc = new Map(documentSecrets.map((entry) => [entry.documentIndex, entry]));
  const docCountMismatch = ranges.length !== documentSecrets.length;
  let unionKeys: string[] | undefined;
  let unionVals: string[] | undefined;
  if (docCountMismatch) {
    const allKeys = new Set<string>();
    const allVals = new Set<string>();
    for (const entry of documentSecrets) {
      for (const k of entry.secretKeys ?? []) allKeys.add(k);
      for (const v of entry.secretValues ?? []) allVals.add(v);
    }
    if (extraByDocument) {
      for (const extra of extraByDocument.values()) {
        for (const k of extra.secretKeys ?? []) allKeys.add(k);
        for (const v of extra.secretValues ?? []) allVals.add(v);
      }
    }
    unionKeys = [...allKeys];
    unionVals = [...allVals];
  }

  return ranges.map((range) => {
    if (docCountMismatch) {
      return {
        startLine: range.startLine,
        endLine: range.endLine,
        secretKeys: unionKeys ?? [],
        secretValues: unionVals ?? [],
      };
    }
    const meta = metaByDoc.get(range.documentIndex);
    const extra = extraByDocument?.get(range.documentIndex);
    const keys = new Set<string>(meta?.secretKeys ?? []);
    const vals = new Set<string>(meta?.secretValues ?? []);
    for (const k of extra?.secretKeys ?? []) keys.add(k);
    for (const v of extra?.secretValues ?? []) vals.add(v);
    return {
      startLine: range.startLine,
      endLine: range.endLine,
      secretKeys: [...keys],
      secretValues: [...vals],
    };
  });
}

function formatDiffSecretPath(segments: readonly PathSegment[]): string {
  return segments
    .map((segment, index) => {
      if (typeof segment === "number") return `[${segment}]`;
      if (/^[A-Za-z_$][\w$-]*$/.test(segment)) return `${index ? "." : ""}${segment}`;
      return `[${JSON.stringify(segment)}]`;
    })
    .join("");
}

function isPathPrefixOrEqual(prefix: string, target: string): boolean {
  return target === prefix || target.startsWith(`${prefix}.`) || target.startsWith(`${prefix}[`);
}

/**
 * Determines whether a `SaveChangePreview` entry represents a secret field
 * (combining active `fields`, key/value heuristics, and target YAML document
 * schema metadata such as `writeOnly: true` / `format: "password"`).
 */
export function isSaveChangeSecret(
  change: SaveChangePreview,
  fields: readonly FieldSpec[],
  docMeta?: Pick<DocumentSecretMeta, "secretPaths" | "secretKeys" | "secretValues">,
): boolean {
  const field = fields.find((item) => item.path === change.path);
  if (
    field?.secret
    || field?.type === "secret"
    || SECRET_KEY_PATTERN.test(change.path)
    || valueContainsSecret(change.before)
    || valueContainsSecret(change.after)
  ) {
    return true;
  }
  if (!docMeta) return false;

  const formattedPaths = (docMeta.secretPaths ?? []).map(formatDiffSecretPath);
  for (const sp of formattedPaths) {
    if (isPathPrefixOrEqual(sp, change.path) || isPathPrefixOrEqual(change.path, sp)) {
      return true;
    }
  }

  const lowerPath = change.path.toLowerCase();
  const leaf = change.path.split(".").at(-1)?.trim().toLowerCase();
  for (const key of docMeta.secretKeys ?? []) {
    const lowerKey = key.trim().toLowerCase();
    if (!lowerKey) continue;
    if (lowerKey === lowerPath || (formattedPaths.length === 0 && leaf && lowerKey === leaf)) {
      return true;
    }
  }

  const secretVals = new Set((docMeta.secretValues ?? []).filter((v) => v.length >= 6));
  if (secretVals.size > 0) {
    if (typeof change.before === "string" && secretVals.has(change.before)) return true;
    if (typeof change.after === "string" && secretVals.has(change.after)) return true;
  }
  return false;
}

/**
 * Masks all lines of a complete configuration document in a single linear pass,
 * preserving multi-line secret state (YAML block scalars, YAML secret subtrees,
 * PEM private key blocks, TOML triple-quoted strings, multi-line JSON/TOML
 * secret arrays/objects, and `.properties` backslash continuations).
 */
export function maskDocumentLines(
  text: string,
  options: MaskUnifiedDiffOptions = {},
): MaskedDocumentLinesResult {
  const baseConfig = buildMaskConfig(options);
  const rawLines = text.replace(/\r\n/g, "\n").split("\n");
  const scopedSections = options.documentSecrets?.length
    ? [...options.documentSecrets]
      .sort((left, right) => left.startLine - right.startLine)
      .map((section) => ({
        startLine: section.startLine,
        endLine: section.endLine,
        config: buildMaskConfig({
          format: options.format,
          mask: options.mask,
          secretKeys: [...(options.secretKeys ?? []), ...(section.secretKeys ?? [])],
          secretValues: [...(options.secretValues ?? []), ...(section.secretValues ?? [])],
        }),
      }))
    : undefined;

  let state = createInitialState();
  let activeSectionIdx = -1;
  const maskedLines: string[] = new Array(rawLines.length);
  const maskedLineFlags: boolean[] = new Array(rawLines.length);
  let maskedLineCount = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i] ?? "";
    let config = baseConfig;
    if (scopedSections) {
      const lineNumber = i + 1;
      let matchedIdx = -1;
      for (let s = 0; s < scopedSections.length; s += 1) {
        const sec = scopedSections[s]!;
        if (lineNumber >= sec.startLine && (sec.endLine === undefined || lineNumber < sec.endLine)) {
          matchedIdx = s;
        }
      }
      if (matchedIdx !== activeSectionIdx) {
        if (activeSectionIdx !== -1 && matchedIdx !== -1) {
          state = createInitialState();
        }
        activeSectionIdx = matchedIdx;
      }
      if (matchedIdx >= 0) {
        config = scopedSections[matchedIdx]!.config;
      }
    }
    const result = maskLineWithState(rawLine, state, config);
    maskedLines[i] = result.text;
    maskedLineFlags[i] = result.masked;
    if (result.masked) maskedLineCount += 1;
  }

  return { lines: maskedLines, maskedLineFlags, maskedLineCount };
}

/**
 * Redacts sensitive values inside computed Unified Diff hunks AFTER diffing, so
 * changed secret lines remain visible as `-` / `+` hunks without exposing
 * plaintext credentials during screen sharing or review.
 *
 * Precomputes multi-line secret state across the complete `oldText` and
 * `newText` BEFORE mapping hunk lines, eliminating cross-hunk truncation leaks.
 */
export function maskUnifiedDiff(
  diff: UnifiedDiffResult,
  options: MaskUnifiedDiffOptions = {},
): MaskedUnifiedDiffResult {
  const sources = diffSourceTexts.get(diff);
  const oldText = options.oldText ?? sources?.oldText;
  const newText = options.newText ?? sources?.newText;

  if (oldText !== undefined && newText !== undefined) {
    const oldDocSecrets = options.oldDocumentSecrets ?? options.documentSecrets;
    const newDocSecrets = options.newDocumentSecrets ?? options.documentSecrets;
    const oldMasked = maskDocumentLines(
      oldText,
      oldDocSecrets ? { ...options, documentSecrets: oldDocSecrets } : options,
    );
    const newMasked = maskDocumentLines(
      newText,
      newDocSecrets ? { ...options, documentSecrets: newDocSecrets } : options,
    );
    let maskedLineCount = 0;

    const hunks: DiffHunk[] = diff.hunks.map((hunk) => {
      const lines = hunk.lines.map((line) => {
        let nextText = line.text;
        let wasMasked = false;
        if (line.kind === "remove" && line.oldLine !== undefined && line.oldLine >= 1 && line.oldLine <= oldMasked.lines.length) {
          nextText = oldMasked.lines[line.oldLine - 1]!;
          wasMasked = oldMasked.maskedLineFlags[line.oldLine - 1] === true;
        } else if (line.kind === "add" && line.newLine !== undefined && line.newLine >= 1 && line.newLine <= newMasked.lines.length) {
          nextText = newMasked.lines[line.newLine - 1]!;
          wasMasked = newMasked.maskedLineFlags[line.newLine - 1] === true;
        } else if (line.kind === "context") {
          const oldIdx = line.oldLine !== undefined ? line.oldLine - 1 : -1;
          const newIdx = line.newLine !== undefined ? line.newLine - 1 : -1;
          const oldWasMasked = oldIdx >= 0 && oldIdx < oldMasked.maskedLineFlags.length && oldMasked.maskedLineFlags[oldIdx] === true;
          const newWasMasked = newIdx >= 0 && newIdx < newMasked.maskedLineFlags.length && newMasked.maskedLineFlags[newIdx] === true;
          if (oldWasMasked) {
            nextText = oldMasked.lines[oldIdx]!;
            wasMasked = true;
          } else if (newWasMasked) {
            nextText = newMasked.lines[newIdx]!;
            wasMasked = true;
          }
        }
        if (wasMasked) maskedLineCount += 1;
        return nextText === line.text ? line : { ...line, text: nextText };
      });
      return { ...hunk, lines };
    });

    return {
      diff: { ...diff, hunks },
      maskedLineCount,
    };
  }

  // Fallback for synthetic UnifiedDiffResult without backing full texts
  const config = buildMaskConfig(options);
  let maskedLineCount = 0;
  const hunks: DiffHunk[] = diff.hunks.map((hunk) => {
    const state = createInitialState();
    const lines = hunk.lines.map((line) => {
      const result = maskLineWithState(line.text, state, config);
      if (result.masked) maskedLineCount += 1;
      return result.text === line.text ? line : { ...line, text: result.text };
    });
    return { ...hunk, lines };
  });

  return {
    diff: { ...diff, hunks },
    maskedLineCount,
  };
}

function maskLineWithState(
  text: string,
  state: DocumentMaskState,
  config: MaskConfig,
): { text: string; masked: boolean } {
  const { mask, format, extraKeys, extraValues } = config;
  const indent = text.match(/^\s*/)?.[0] ?? "";
  const indentLen = indent.length;

  // 1. Active PEM private key block
  const hasPemBegin = PEM_BEGIN_RE.test(text);
  const hasPemEnd = PEM_END_RE.test(text);
  if (hasPemBegin && !hasPemEnd) {
    state.inPemBlock = true;
    // Track an unclosed ENV quoted assignment opening on the same line as the PEM header
    // (e.g. `PRIVATE_KEY="-----BEGIN PRIVATE KEY-----`) so any trailing secret lines after
    // `-----END ...-----` before the closing quote stay masked.
    if (!state.envMultilineQuote && (format === "env" || format === undefined)) {
      const openedQuote = detectUnclosedEnvQuotePrefix(text, format, extraKeys);
      if (openedQuote) state.envMultilineQuote = openedQuote;
    }
    const match = text.match(PEM_BEGIN_RE);
    if (match && match.index !== undefined) {
      const endOfHeader = match.index + match[0].length;
      const tail = text.slice(endOfHeader);
      if (tail.trim()) {
        const maskedText = `${text.slice(0, endOfHeader)}${mask}`;
        return { text: maskedText, masked: maskedText !== text };
      }
    }
    return { text, masked: false };
  }
  if (state.inPemBlock) {
    if (hasPemEnd) {
      state.inPemBlock = false;
      const match = text.match(PEM_END_RE);
      if (match && match.index !== undefined) {
        const beforeEnd = text.slice(0, match.index);
        const endMarker = match[0];
        let afterEnd = text.slice(match.index + endMarker.length);
        if (state.envMultilineQuote) {
          const quote = state.envMultilineQuote;
          const closeIdx = findClosingQuote(afterEnd, -1, quote, quote === '"');
          if (closeIdx >= 0) {
            state.envMultilineQuote = undefined;
            const beforeClose = afterEnd.slice(0, closeIdx);
            const afterClose = afterEnd.slice(closeIdx + 1);
            const maskedBeforeClose = beforeClose.trim() ? `${beforeClose.match(/^\s*/)?.[0] ?? ""}${mask}` : beforeClose;
            if (isAllowedQuotedScalarTail(afterClose, format ?? "env")) {
              afterEnd = `${maskedBeforeClose}${quote}${applyFallbackRedactions(afterClose, mask, extraValues)}`;
            } else {
              const trailingWs = afterClose.match(/\s*$/)?.[0] ?? "";
              afterEnd = `${maskedBeforeClose}${quote}${mask}${trailingWs}`;
            }
          } else if (afterEnd.trim()) {
            afterEnd = `${afterEnd.match(/^\s*/)?.[0] ?? ""}${mask}`;
          }
        }
        const maskedBefore = beforeEnd.trim() ? `${indent}${mask}` : beforeEnd;
        const combined = `${maskedBefore}${endMarker}${afterEnd}`;
        return { text: combined, masked: combined !== text };
      }
      return { text, masked: false };
    }
    const maskedText = text.trim() ? `${indent}${mask}` : text;
    return { text: maskedText, masked: maskedText !== text };
  }

  // 2. Active TOML multi-line triple-quoted secret string
  if (state.tomlTripleQuote) {
    const delim = state.tomlTripleQuote;
    const closing = findClosingTripleQuote(text, 0, delim);
    if (!closing) {
      const maskedText = text.trim() ? `${indent}${mask}` : text;
      return { text: maskedText, masked: maskedText !== text };
    }
    state.tomlTripleQuote = undefined;
    const before = text.slice(0, closing.closeStart);
    const after = text.slice(closing.closeEnd);
    const maskedBefore = before.trim() ? `${before.match(/^\s*/)?.[0] ?? ""}${mask}` : before;
    let maskedAfter = after;
    if (state.secretContainerStack.length > 0 && after) {
      const container = maskSecretContainerLine(after, mask, state.secretContainerStack, format);
      state.secretContainerStack = container.nextStack;
      if (container.openedTripleQuote) state.tomlTripleQuote = container.openedTripleQuote;
      maskedAfter = container.text;
    }
    const combined = applyFallbackRedactions(`${maskedBefore}${delim}${maskedAfter}`, mask, extraValues);
    return { text: combined, masked: combined !== text };
  }

  // 2b. Active ENV multi-line quoted secret string (`"..."`, `'...'`, `` `...` ``)
  if (state.envMultilineQuote) {
    const quote = state.envMultilineQuote;
    const closeIdx = findClosingQuote(text, -1, quote, quote === '"');
    if (closeIdx < 0) {
      const maskedText = text.trim() ? `${indent}${mask}` : text;
      return { text: maskedText, masked: maskedText !== text };
    }
    state.envMultilineQuote = undefined;
    const before = text.slice(0, closeIdx);
    const after = text.slice(closeIdx + 1);
    const maskedBefore = before.trim() ? `${before.match(/^\s*/)?.[0] ?? ""}${mask}` : before;
    let combined: string;
    if (isAllowedQuotedScalarTail(after, format ?? "env")) {
      combined = applyFallbackRedactions(`${maskedBefore}${quote}${after}`, mask, extraValues);
    } else {
      const trailingWs = after.match(/\s*$/)?.[0] ?? "";
      combined = `${maskedBefore}${quote}${mask}${trailingWs}`;
    }
    return { text: combined, masked: combined !== text };
  }

  // 3. Active `.properties` / backslash line continuation under a secret key
  if (state.inBackslashContinuation) {
    const continues = hasTrailingBackslashContinuation(text);
    state.inBackslashContinuation = continues;
    if (!text.trim()) return { text, masked: false };
    if (continues) {
      const beforeSlash = text.slice(0, -1);
      const maskedText = beforeSlash.trim() ? `${indent}${mask}\\` : text;
      return { text: maskedText, masked: maskedText !== text };
    }
    const maskedText = `${indent}${mask}`;
    return { text: maskedText, masked: maskedText !== text };
  }

  // 4. Active YAML literal/folded block scalar (`|` / `>`)
  if (state.yamlBlockIndent !== undefined) {
    if (!text.trim()) return { text, masked: false };
    if (indentLen > state.yamlBlockIndent) {
      const maskedText = `${indent}${mask}`;
      return { text: maskedText, masked: maskedText !== text };
    }
    state.yamlBlockIndent = undefined;
  }

  // 5. Active multi-line secret bracketed container (`[...]` / `{...}`)
  if (state.secretContainerStack.length > 0) {
    const container = maskSecretContainerLine(text, mask, state.secretContainerStack, format);
    state.secretContainerStack = container.nextStack;
    if (container.openedTripleQuote) state.tomlTripleQuote = container.openedTripleQuote;
    const output = applyFallbackRedactions(container.text, mask, extraValues);
    return { text: output, masked: output !== text };
  }

  // 6. Active YAML secret subtree (`api_keys:\n  - ...` or `credentials:\n  child: ...`)
  let forcedSecretBySubtree = false;
  if (state.yamlSecretSubtreeIndent !== undefined) {
    if (!text.trim() || /^\s*#/.test(text)) {
      const output = applyFallbackRedactions(text, mask, extraValues);
      return { text: output, masked: output !== text };
    }
    if (indentLen <= state.yamlSecretSubtreeIndent) {
      state.yamlSecretSubtreeIndent = undefined;
    } else {
      forcedSecretBySubtree = true;
    }
  }

  // 7. Full-line comments: never treat as KV assignments, still redact leaked patterns/values.
  // In INI / `.npmrc`, `//host/:_authToken=...` starts with `//` and is a real key assignment, NOT a comment.
  const isCommentLine = format === "ini"
    ? /^\s*[#;]/.test(text)
    : format === "properties"
      ? /^\s*[#!]/.test(text)
      : format === "yaml" || format === "toml" || format === "env"
        ? /^\s*#/.test(text)
        : COMMENT_LINE_RE.test(text) && !NPMRC_KEY_LINE_RE.test(text);
  if (isCommentLine) {
    const output = applyFallbackRedactions(text, mask, extraValues);
    return { text: output, masked: output !== text };
  }

  let output = text;
  const kv = matchKeyValueLine(text, format, extraKeys);
  if (kv) {
    const unquotedKey = unquoteAndUnescapeKey(kv.rawKey, format);
    const keyWithoutIniArray = unquotedKey.endsWith("[]") ? unquotedKey.slice(0, -2) : unquotedKey;
    const lowerKey = keyWithoutIniArray.toLowerCase();
    const isExplicitKey = extraKeys.has(lowerKey) || extraKeys.has(unquotedKey.toLowerCase());
    const isPatternKey = SECRET_KEY_PATTERN.test(keyWithoutIniArray);

    if (forcedSecretBySubtree || isExplicitKey || isPatternKey) {
      output = maskSecretAssignment(kv.prefix, kv.rawKey, kv.separator, kv.rest, indentLen, state, config);
    }
  } else if (forcedSecretBySubtree) {
    const seqMatch = text.match(YAML_SEQ_ITEM_RE);
    if (seqMatch) {
      const [, seqPrefix = "", seqRest = ""] = seqMatch;
      output = maskSecretAssignment(seqPrefix, "", "", seqRest, indentLen, state, config);
    } else if (text.trim()) {
      output = `${indent}${mask}`;
    }
  }

  output = applyFallbackRedactions(output, mask, extraValues);
  return { text: output, masked: output !== text };
}

function maskSecretAssignment(
  prefix: string,
  rawKey: string,
  separator: string,
  rest: string,
  indentLen: number,
  state: DocumentMaskState,
  config: MaskConfig,
): string {
  const { mask, format, extraValues } = config;
  const trimmedRest = rest.trim();
  const isNpmrcKey = Boolean(rawKey.trim().startsWith("//"));

  // `.npmrc` scoped credential lines (`//host/:_authToken=...`, `//host/:_password=...`)
  // are always single-line raw credentials; mask the entire assigned value immediately.
  if (isNpmrcKey) {
    if (!trimmedRest) return `${prefix}${rawKey}${separator}${rest}`;
    const maskedRest = maskAssignedValue(rest, mask, { format, extraValues, rawKey });
    return `${prefix}${rawKey}${separator}${maskedRest}`;
  }

  // TOML triple-quoted string (`"""..."""` or `'''...'''`)
  if (
    (format === "toml" || format === undefined)
    && (trimmedRest.startsWith('"""') || trimmedRest.startsWith("'''"))
  ) {
    const leadingWs = rest.match(/^\s*/)?.[0] ?? "";
    const delim: '"""' | "'''" = trimmedRest.startsWith('"""') ? '"""' : "'''";
    const afterOpen = trimmedRest.slice(3);
    const closing = findClosingTripleQuote(trimmedRest, 3, delim);
    if (closing) {
      const inner = trimmedRest.slice(3, closing.closeStart);
      const tail = trimmedRest.slice(closing.closeEnd);
      if (isAllowedQuotedScalarTail(tail, format ?? "toml")) {
        if (inner.length === 0) {
          return `${prefix}${rawKey}${separator}${rest}`;
        }
        return `${prefix}${rawKey}${separator}${leadingWs}${delim}${mask}${delim}${tail}`;
      }
      // Suspicious non-comment tail after closing triple quote (e.g. `""""""real_secret`): mask entire rest.
      const body = rest.slice(leadingWs.length);
      const trailingWs = body.match(/\s*$/)?.[0] ?? "";
      return `${prefix}${rawKey}${separator}${leadingWs}${mask}${trailingWs}`;
    }
    state.tomlTripleQuote = delim;
    const maskedOpenTail = afterOpen.trim() ? mask : afterOpen;
    return `${prefix}${rawKey}${separator}${leadingWs}${delim}${maskedOpenTail}`;
  }

  // ENV multi-line quoted string (`"..."`, `'...'`, `` `...` ``) that does not close on line 1
  if (
    (format === "env" || (format === undefined && separator.includes("=")))
    && (trimmedRest.startsWith('"') || trimmedRest.startsWith("'") || trimmedRest.startsWith("`"))
  ) {
    const leadingWs = rest.match(/^\s*/)?.[0] ?? "";
    const body = rest.slice(leadingWs.length);
    const quote = body[0] as '"' | "'" | "`";
    const closeIdx = findClosingQuote(body, 0, quote, quote === '"');
    if (closeIdx < 0) {
      state.envMultilineQuote = quote;
      const afterOpen = body.slice(1);
      const maskedOpenTail = afterOpen.trim() ? mask : afterOpen;
      return `${prefix}${rawKey}${separator}${leadingWs}${quote}${maskedOpenTail}`;
    }
  }

  // YAML literal/folded block scalar (`|` / `>`)
  if (YAML_BLOCK_SCALAR_RE.test(trimmedRest)) {
    state.yamlBlockIndent = indentLen;
    return `${prefix}${rawKey}${separator}${rest}`;
  }

  // `.properties` / backslash line continuation (`key = part1\` or `key = \`)
  if (hasTrailingBackslashContinuation(rest) && !isClosedQuotedScalar(trimmedRest)) {
    state.inBackslashContinuation = true;
    const beforeSlash = rest.slice(0, -1);
    if (!beforeSlash.trim()) {
      return `${prefix}${rawKey}${separator}${rest}`;
    }
    const leadingWs = beforeSlash.match(/^\s*/)?.[0] ?? "";
    return `${prefix}${rawKey}${separator}${leadingWs}${mask}\\`;
  }

  // Inline or multi-line bracketed container (`[...]` / `{...}`)
  if (trimmedRest.startsWith("[") || trimmedRest.startsWith("{")) {
    const container = maskSecretContainerLine(rest, mask, [], format);
    if (container.nextStack.length > 0) state.secretContainerStack = container.nextStack;
    if (container.openedTripleQuote) state.tomlTripleQuote = container.openedTripleQuote;
    return `${prefix}${rawKey}${separator}${container.text}`;
  }

  // YAML empty mapping value starting an indented secret block/sequence
  if (separator.includes(":") && (!trimmedRest || trimmedRest.startsWith("#"))) {
    if (state.yamlSecretSubtreeIndent === undefined) {
      state.yamlSecretSubtreeIndent = indentLen;
    }
    return `${prefix}${rawKey}${separator}${rest}`;
  }

  if (!trimmedRest) {
    return `${prefix}${rawKey}${separator}${rest}`;
  }

  const maskedRest = maskAssignedValue(rest, mask, { format, extraValues, rawKey });
  return `${prefix}${rawKey}${separator}${maskedRest}`;
}

function matchIniKeyValueLine(
  text: string,
): { prefix: string; rawKey: string; separator: string; rest: string } | undefined {
  let escaped = false;
  let firstColon: number | undefined;
  let sepIndex: number | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "=") {
      if (firstColon !== undefined && /\s/.test(text[firstColon + 1] ?? "")) {
        sepIndex = firstColon;
      } else {
        sepIndex = index;
      }
      break;
    }
    if (ch === ":" && firstColon === undefined && !text.startsWith("//", index + 1)) {
      firstColon = index;
    }
  }
  if (sepIndex === undefined) sepIndex = firstColon;
  if (sepIndex === undefined) return undefined;
  const before = text.slice(0, sepIndex);
  const prefix = before.match(/^\s*/)?.[0] ?? "";
  const keyWithTrailing = before.slice(prefix.length);
  const rawKey = keyWithTrailing.replace(/\s+$/, "");
  if (!rawKey) return undefined;
  const keyTrailingWs = keyWithTrailing.slice(rawKey.length);
  const after = text.slice(sepIndex + 1);
  const valueLeadingWs = after.match(/^\s*/)?.[0] ?? "";
  return {
    prefix,
    rawKey,
    separator: `${keyTrailingWs}${text[sepIndex]!}${valueLeadingWs}`,
    rest: after.slice(valueLeadingWs.length),
  };
}

function matchKeyValueLine(
  text: string,
  format: ConfigFormat | undefined,
  extraKeys: ReadonlySet<string>,
): { prefix: string; rawKey: string; separator: string; rest: string } | undefined {
  if (format === "ini" || NPMRC_KEY_LINE_RE.test(text)) {
    return matchIniKeyValueLine(text);
  }
  if (format === "properties") {
    const propMatch = text.match(PROPERTIES_KV_LINE_RE);
    if (propMatch) {
      return {
        prefix: propMatch[1] ?? "",
        rawKey: propMatch[2] ?? "",
        separator: propMatch[3] ?? "",
        rest: propMatch[4] ?? "",
      };
    }
    return undefined;
  }

  const kvMatch = text.match(KV_LINE_RE);
  if (kvMatch) {
    return {
      prefix: kvMatch[1] ?? "",
      rawKey: kvMatch[2] ?? "",
      separator: kvMatch[3] ?? "",
      rest: kvMatch[4] ?? "",
    };
  }

  // Whitespace-separated `.properties`-style secret line when format is unspecified
  const wsMatch = text.match(WHITESPACE_SECRET_KV_RE);
  if (wsMatch) {
    const rawKey = wsMatch[2] ?? "";
    const rest = wsMatch[4] ?? "";
    if (!rest.startsWith(":") && !rest.startsWith("=")) {
      const key = unquoteAndUnescapeKey(rawKey, "properties");
      if (SECRET_KEY_PATTERN.test(key) || extraKeys.has(key.toLowerCase())) {
        return {
          prefix: wsMatch[1] ?? "",
          rawKey,
          separator: wsMatch[3] ?? " ",
          rest,
        };
      }
    }
  }
  return undefined;
}

function unquoteAndUnescapeKey(rawKey: string, format: ConfigFormat | undefined): string {
  const trimmed = rawKey.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (format === "properties" || trimmed.includes("\\")) {
    return trimmed.replace(/\\(.)/g, "$1");
  }
  return trimmed;
}

function findClosingTripleQuote(
  text: string,
  startIndex: number,
  delim: '"""' | "'''",
): { closeStart: number; closeEnd: number } | undefined {
  const quoteChar = delim[0]!;
  const allowEscape = delim === '"""';
  for (let i = startIndex; i <= text.length - 3; i += 1) {
    if (allowEscape && text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text.startsWith(delim, i)) {
      // TOML allows up to 2 extra quote chars immediately before the closing triple quote.
      let runEnd = i + 3;
      while (runEnd < text.length && text[runEnd] === quoteChar && runEnd - i < 5) {
        runEnd += 1;
      }
      return { closeStart: runEnd - 3, closeEnd: runEnd };
    }
  }
  return undefined;
}

function hasTrailingBackslashContinuation(line: string): boolean {
  let slashes = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function isClosedQuotedScalar(trimmed: string): boolean {
  if (trimmed.length < 2) return false;
  const q = trimmed[0];
  if (q !== '"' && q !== "'" && q !== "`") return false;
  const end = findClosingQuote(trimmed, 0, q, q !== "`");
  return end > 0 && end === trimmed.length - 1;
}

function detectUnclosedEnvQuotePrefix(
  text: string,
  format: ConfigFormat | undefined,
  extraKeys: ReadonlySet<string>,
): '"' | "'" | "`" | undefined {
  const kv = matchKeyValueLine(text, format, extraKeys);
  if (!kv || !kv.separator.includes("=")) return undefined;
  const trimmedRest = kv.rest.trim();
  if (!trimmedRest) return undefined;
  if (format === undefined && (trimmedRest.startsWith('"""') || trimmedRest.startsWith("'''"))) {
    return undefined;
  }
  const quote = trimmedRest[0];
  if (quote !== '"' && quote !== "'" && quote !== "`") return undefined;
  const closeIdx = findClosingQuote(trimmedRest, 0, quote, quote === '"');
  return closeIdx < 0 ? quote : undefined;
}

function findClosingQuote(text: string, openIdx: number, quote: string, allowEscape: boolean): number {
  for (let index = openIdx + 1; index < text.length; index += 1) {
    const ch = text[index];
    if (allowEscape && ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === quote) return index;
  }
  return -1;
}

function isAllowedQuotedScalarTail(tail: string, format?: ConfigFormat): boolean {
  if (!tail || /^\s*$/.test(tail)) return true;
  if (format === "properties") return false;
  if (format === "json") {
    return /^\s*,?\s*$/.test(tail);
  }
  if (format === "jsonc") {
    return /^\s*,?\s*(?:\/\/.*|\/\*(?:(?!\*\/).)*\*\/\s*)?$/.test(tail);
  }
  if (format === "toml") {
    return /^\s*(?:#.*)?$/.test(tail);
  }
  if (format === "yaml") {
    return /^\s*,?\s*$/.test(tail) || /^\s*,?\s+#.*$/.test(tail);
  }
  if (format === "env" || format === "ini") {
    return /^\s+#.*$/.test(tail);
  }
  // Unspecified format: allow optional trailing comma and/or legal inline comment (`#`, `//`, `/* ... */`).
  return /^\s*,?\s*$/.test(tail)
    || /^\s*,\s*(?:#|\/\/).*$/.test(tail)
    || /^\s+(?:#|\/\/).*$/.test(tail)
    || /^\s*,?\s*\/\*(?:(?!\*\/).)*\*\/\s*$/.test(tail);
}

function maskAssignedValue(
  rest: string,
  mask: string,
  options: { format?: ConfigFormat; extraValues?: readonly string[]; rawKey?: string } = {},
): string {
  const { format, extraValues = [], rawKey } = options;
  const trimmed = rest.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") return rest;

  const leadingWs = rest.match(/^\s*/)?.[0] ?? "";
  const body = rest.slice(leadingWs.length);
  const trailingWs = body.match(/\s*$/)?.[0] ?? "";

  // `.npmrc` scoped credential lines (`//host/:_authToken=...`, `//host/:_password=...`)
  // must mask the entire value before quote handling so leading `""` or `"tok1" tok2`
  // can never bypass masking.
  const isNpmrcKey = Boolean(rawKey?.trim().startsWith("//"));
  if (isNpmrcKey) {
    return `${leadingWs}${mask}${trailingWs}`;
  }

  const quote = body.charAt(0);

  // Quoted scalar value ("...", '...', `...`) preserving quotes, auth scheme, commas, and legal trailing comments.
  // Never treat quotes as delimiters in Java `.properties`, and reject arbitrary non-comment tails
  // (e.g. `password=""real_secret` or `api_key="a"real_tail`) by masking the entire `rest`.
  if (format !== "properties" && (quote === '"' || quote === "'" || quote === "`")) {
    const allowEscape = quote !== "`" && !((format === "toml" || format === "env") && quote === "'");
    const end = findClosingQuote(body, 0, quote, allowEscape);
    if (end >= 1) {
      const tail = body.slice(end + 1);
      if (isAllowedQuotedScalarTail(tail, format)) {
        if (end === 1) return rest; // Empty quoted string "" or '' with only whitespace/comma/comment tail
        const inner = body.slice(1, end);
        const authInside = inner.match(AUTH_SCHEME_VALUE_RE);
        const maskedInner = authInside ? `${authInside[1]}${mask}` : mask;
        return `${leadingWs}${quote}${maskedInner}${quote}${tail}`;
      }
      return `${leadingWs}${mask}${trailingWs}`;
    }
    const inner = body.slice(1);
    const authInside = inner.match(AUTH_SCHEME_VALUE_RE);
    const maskedInner = authInside ? `${authInside[1]}${mask}` : mask;
    return `${leadingWs}${quote}${maskedInner}${quote}`;
  }

  // Unquoted scalar value: compute inline comment boundary safely without splitting inside values
  let commentIdx = findSafeInlineCommentIndex(body, format);
  if (commentIdx >= 0 && extraValues.length > 0) {
    for (const secretValue of extraValues) {
      const idx = body.indexOf(secretValue);
      if (idx >= 0 && idx + secretValue.length > commentIdx) {
        commentIdx = -1;
        break;
      }
    }
  }

  const valuePart = commentIdx >= 0 ? body.slice(0, commentIdx) : body;
  const commentPart = commentIdx >= 0 ? body.slice(commentIdx) : "";
  const trailingMatch = format === "ini" || format === "env" || format === "properties"
    ? valuePart.match(/^(.+?)(\s*)$/)
    : valuePart.match(/^(.+?)(\s*,?\s*)$/);
  if (!trailingMatch) return rest;
  const coreValue = trailingMatch[1]!.trim();
  if (!coreValue || coreValue === "null" || coreValue === "~") return rest;

  // Preserve leading Authorization scheme (Bearer / Basic / Digest / Token ...) and mask entire credential payload
  const authMatch = coreValue.match(AUTH_SCHEME_VALUE_RE);
  if (authMatch) {
    return `${leadingWs}${authMatch[1]}${mask}${trailingMatch[2]}${commentPart}`;
  }
  return `${leadingWs}${mask}${trailingMatch[2]}${commentPart}`;
}

function findSafeInlineCommentIndex(text: string, format?: ConfigFormat): number {
  if (format === "properties") return -1;
  const hashIdx = format === "json" || format === "jsonc" ? -1 : text.search(/\s+#/);
  // `//` is only an inline comment in JSONC (and JSONC strings are always quoted).
  let slashIdx = -1;
  if (format === "jsonc") {
    slashIdx = text.search(/\s+\/\//);
  } else if (format === undefined) {
    const candidate = text.search(/\s+\/\//);
    if (candidate > 0) {
      const before = text.slice(0, candidate).trim().replace(/,$/, "").trim();
      if (/^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/.test(before)) {
        slashIdx = candidate;
      }
    }
  }
  if (hashIdx >= 0 && slashIdx >= 0) return Math.min(hashIdx, slashIdx);
  return Math.max(hashIdx, slashIdx);
}

/**
 * Masks all non-empty scalar values inside a bracketed secret container line
 * (`[...]` / `{...}`) across JSON, JSONC, TOML, and YAML flow syntax while
 * preserving object keys, brackets, commas, quotes, and comments.
 */
function maskSecretContainerLine(
  line: string,
  mask: string,
  initialStack: readonly ("array" | "object")[],
  format?: ConfigFormat,
): { text: string; nextStack: Array<"array" | "object">; openedTripleQuote?: '"""' | "'''" } {
  const stack: Array<"array" | "object"> = [...initialStack];
  let out = "";
  let i = 0;

  while (i < line.length) {
    const ch = line[i]!;

    // Inline comment ends the container tokens on this line
    if (
      (ch === "#" && format !== "json" && format !== "jsonc" && (i === 0 || /\s/.test(line[i - 1] ?? "")))
      || (ch === "/" && line[i + 1] === "/" && (format === "jsonc" || (format === undefined && (i === 0 || /\s/.test(line[i - 1] ?? "")))))
    ) {
      out += line.slice(i);
      break;
    }

    if (ch === "[") {
      stack.push("array");
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "{") {
      stack.push("object");
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "]" || ch === "}") {
      stack.pop();
      out += ch;
      i += 1;
      continue;
    }

    if (stack.length === 0) {
      out += ch;
      i += 1;
      continue;
    }

    const inObject = stack.at(-1) === "object";

    // Preserve whitespace and structural punctuation
    if (/[\s,]/.test(ch) || (inObject && (ch === ":" || ch === "="))) {
      out += ch;
      i += 1;
      continue;
    }

    // TOML triple-quoted element inside container
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const delim: '"""' | "'''" = line.startsWith('"""', i) ? '"""' : "'''";
      const closing = findClosingTripleQuote(line, i + 3, delim);
      if (closing) {
        const inner = line.slice(i + 3, closing.closeStart);
        out += inner.length === 0 ? `${delim}${delim}` : `${delim}${mask}${delim}`;
        i = closing.closeEnd;
        continue;
      }
      const afterOpen = line.slice(i + 3);
      out += afterOpen.trim() ? `${delim}${mask}` : `${delim}${afterOpen}`;
      return { text: out, nextStack: stack, openedTripleQuote: delim };
    }

    // Quoted string token (either object key or secret value)
    if (ch === '"' || ch === "'" || ch === "`") {
      const allowEscape = ch !== "`" && !(format === "toml" && ch === "'");
      const end = findClosingQuote(line, i, ch, allowEscape);
      if (end < 0) {
        out += `${ch}${mask}${ch}`;
        break;
      }
      const token = line.slice(i, end + 1);
      const isObjectKey = inObject && isFollowedByKeySeparator(line, end + 1);
      if (isObjectKey || end === i + 1) {
        out += token;
      } else {
        const inner = line.slice(i + 1, end);
        const authInside = inner.match(AUTH_SCHEME_VALUE_RE);
        out += authInside ? `${ch}${authInside[1]}${mask}${ch}` : `${ch}${mask}${ch}`;
      }
      i = end + 1;
      continue;
    }

    // Unquoted token (bare object key, YAML flow scalar, number, boolean, null)
    let end = i;
    while (end < line.length && !/[\s,[\]{}]/.test(line[end]!)) {
      if (inObject && (line[end] === ":" || line[end] === "=") && !line.startsWith("://", end)) break;
      if (line[end] === "#" && (end === 0 || /\s/.test(line[end - 1] ?? ""))) break;
      if (line[end] === "/" && line[end + 1] === "/" && (end === 0 || /\s/.test(line[end - 1] ?? ""))) break;
      end += 1;
    }
    const token = line.slice(i, end);
    const isObjectKey = inObject && isFollowedByKeySeparator(line, end);
    if (isObjectKey || !token || token === "null" || token === "~") {
      out += token;
    } else {
      out += mask;
    }
    i = end;
  }

  return { text: out, nextStack: stack };
}

function isFollowedByKeySeparator(text: string, index: number): boolean {
  let j = index;
  while (j < text.length && /\s/.test(text[j]!)) j += 1;
  if (text[j] === "=") return true;
  return text[j] === ":" && !text.startsWith("://", j);
}

function applyFallbackRedactions(line: string, mask: string, extraValues: readonly string[]): string {
  let output = applyPatternRedactions(line, mask);
  for (const secretValue of extraValues) {
    if (output.includes(secretValue)) {
      output = output.split(secretValue).join(mask);
    }
  }
  return output;
}

function maskInlineSecretContainers(line: string, mask: string): string {
  INLINE_SECRET_CONTAINER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let result = "";
  let lastIndex = 0;

  while ((match = INLINE_SECRET_CONTAINER_RE.exec(line)) !== null) {
    const containerStart = match.index + match[1]!.length;
    const endIdx = findMatchingContainerEnd(line, containerStart);
    const sliceEnd = endIdx >= 0 ? endIdx + 1 : line.length;
    const masked = maskSecretContainerLine(line.slice(containerStart, sliceEnd), mask, []);
    result += line.slice(lastIndex, containerStart) + masked.text;
    lastIndex = sliceEnd;
    INLINE_SECRET_CONTAINER_RE.lastIndex = sliceEnd;
  }

  if (lastIndex === 0) return line;
  return result + line.slice(lastIndex);
}

function findMatchingContainerEnd(line: string, startIdx: number): number {
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let i = startIdx; i < line.length; i += 1) {
    const ch = line[i]!;
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote !== "`") {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth <= 0) return i;
    }
  }
  return -1;
}

function applyPatternRedactions(line: string, mask: string): string {
  return maskInlineSecretContainers(line, mask)
    .replace(INLINE_PEM_SINGLE_LINE_RE, `$1${mask}$3`)
    .replace(URL_CREDENTIALS_RE, `$1${mask}:${mask}@`)
    .replace(AUTH_DIGEST_RE, `$1${mask}`)
    .replace(AUTH_BEARER_BASIC_RE, `$1${mask}`)
    .replace(AUTH_TOKEN_HEADER_RE, `$1${mask}`)
    .replace(INLINE_KEY_VALUE_SECRET_RE, (_match, prefix: string, value: string) => {
      if (value.includes(mask)) return `${prefix}${value}`;
      if (/auth(?:orization)?/i.test(prefix) && /^(?:Bearer|Basic|Digest|Token|ApiKey|API-Key|JWT|OAuth)$/i.test(value)) {
        return `${prefix}${value}`;
      }
      if (/^(?:[|>])(?:[-+]\d*|\d*[-+]?)?$/.test(value.trim())) return `${prefix}${value}`;
      if (value === '""' || value === "''" || value === '""""""' || value === "''''''" || value === "null" || value === "~") {
        return `${prefix}${value}`;
      }
      if (value.startsWith('"""') && value.endsWith('"""')) return `${prefix}"""${mask}"""`;
      if (value.startsWith("'''") && value.endsWith("'''")) return `${prefix}'''${mask}'''`;
      const quote = value.at(0);
      return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}${mask}${quote}` : mask}`;
    })
    .replace(VENDOR_TOKEN_RE, mask)
    .replace(SLACK_WEBHOOK_RE, `https://hooks.slack.com/services/${mask}`)
    .replace(JWT_TOKEN_RE, mask);
}
