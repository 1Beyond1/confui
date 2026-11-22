import { SECRET_KEY_FRAGMENT } from "./validation.ts";

export type DiffLineKind = "context" | "add" | "remove";

export const DIFF_SECRET_MASK = "••••••••";

export interface MaskUnifiedDiffOptions {
  /** Extra key names (e.g. leaf names or paths of schema-marked secret fields). */
  secretKeys?: readonly string[];
  /** Explicit known secret values (length >= 6) used as fallback redaction for multi-line values. */
  secretValues?: readonly string[];
  /** Replacement mask string (defaults to `••••••••`). */
  mask?: string;
}

export interface MaskedUnifiedDiffResult {
  diff: UnifiedDiffResult;
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
 * Computes line-level unified diff hunks between two texts using LCS with
 * common prefix/suffix trimming and a safe fallback for very large edits.
 */
export function computeUnifiedDiff(
  oldText: string,
  newText: string,
  contextLines = 3,
): UnifiedDiffResult {
  if (oldText === newText) return { hunks: [], added: 0, removed: 0, truncated: false };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

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
  return { hunks, added, removed, truncated };
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

function splitLines(text: string): string[] {
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

const DEFAULT_SECRET_KEY_RE = new RegExp(SECRET_KEY_FRAGMENT, "i");
const PEM_BEGIN_RE = /-----BEGIN (?:(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----/;
const PEM_END_RE = /-----END (?:(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----/;
const URL_CREDENTIALS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s]+)@/gi;
const AUTH_SCHEME_RE = /(\b(?:Bearer|Basic|Digest)\s+)[^\s"',;]+/gi;
const INLINE_KEY_VALUE_SECRET_RE = new RegExp(
  `(["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*[=:]\\s*)("[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'|\`[^\`]*\`|[^\\s,;}\\]#]+)`,
  "gi",
);
const VENDOR_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9_-]{12,}|g2a_[A-Za-z0-9_-]{12,}|ark-[A-Za-z0-9-]{16,}|xai-[A-Za-z0-9_-]{12,}|pplx-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{12,}|r8_[A-Za-z0-9]{12,}|npm_[A-Za-z0-9]{20,})\b/g;
const SLACK_WEBHOOK_RE = /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi;
const JWT_TOKEN_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const YAML_BLOCK_SCALAR_RE = /^[|>](?:[-+]?\d*|\d*[-+])?(?:\s+#.*)?$/;
const KV_LINE_RE = /^(\s*(?:export\s+|-\s+)?)((?:"[^"]*"|'[^']*'|[^:=#\r\n]+?))(\s*[:=]\s*)(.*)$/;

/**
 * Redacts sensitive values inside computed Unified Diff hunks AFTER diffing, so
 * changed secret lines remain visible as `-` / `+` hunks without exposing
 * plaintext credentials during screen sharing or review.
 */
export function maskUnifiedDiff(
  diff: UnifiedDiffResult,
  options: MaskUnifiedDiffOptions = {},
): MaskedUnifiedDiffResult {
  const mask = options.mask ?? DIFF_SECRET_MASK;
  const extraKeys = new Set(
    (options.secretKeys ?? [])
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const extraValues = [...new Set((options.secretValues ?? []).filter((v) => v.length >= 6))]
    .sort((left, right) => right.length - left.length);

  let maskedLineCount = 0;
  const hunks: DiffHunk[] = diff.hunks.map((hunk) => {
    let yamlBlockIndent: number | undefined;
    let inPemBlock = false;
    const lines = hunk.lines.map((line) => {
      const result = maskDiffLine(line.text, {
        mask,
        extraKeys,
        extraValues,
        yamlBlockIndent,
        inPemBlock,
      });
      yamlBlockIndent = result.yamlBlockIndent;
      inPemBlock = result.inPemBlock;
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

interface LineMaskContext {
  mask: string;
  extraKeys: ReadonlySet<string>;
  extraValues: readonly string[];
  yamlBlockIndent: number | undefined;
  inPemBlock: boolean;
}

function maskDiffLine(
  text: string,
  context: LineMaskContext,
): { text: string; masked: boolean; yamlBlockIndent: number | undefined; inPemBlock: boolean } {
  const { mask, extraKeys, extraValues } = context;
  let { yamlBlockIndent, inPemBlock } = context;

  if (PEM_BEGIN_RE.test(text)) {
    return { text, masked: false, yamlBlockIndent: undefined, inPemBlock: true };
  }
  if (PEM_END_RE.test(text)) {
    return { text, masked: false, yamlBlockIndent: undefined, inPemBlock: false };
  }
  if (inPemBlock) {
    const indent = text.match(/^\s*/)?.[0] ?? "";
    const maskedText = text.trim() ? `${indent}${mask}` : text;
    return { text: maskedText, masked: maskedText !== text, yamlBlockIndent: undefined, inPemBlock: true };
  }

  const indentLen = text.match(/^\s*/)?.[0].length ?? 0;
  if (yamlBlockIndent !== undefined && text.trim()) {
    if (indentLen > yamlBlockIndent) {
      const maskedText = `${text.slice(0, indentLen)}${mask}`;
      return { text: maskedText, masked: maskedText !== text, yamlBlockIndent, inPemBlock };
    }
    yamlBlockIndent = undefined;
  }

  let output = text;
  const kvMatch = text.match(KV_LINE_RE);
  if (kvMatch) {
    const [, prefix = "", rawKey = "", separator = "", rest = ""] = kvMatch;
    const unquotedKey = rawKey.trim().replace(/^["']|["']$/g, "");
    const lowerKey = unquotedKey.toLowerCase();
    const isExplicitKey = extraKeys.has(lowerKey);
    const isPatternKey = DEFAULT_SECRET_KEY_RE.test(unquotedKey);

    if (isExplicitKey || isPatternKey) {
      const trimmedRest = rest.trim();
      if (YAML_BLOCK_SCALAR_RE.test(trimmedRest)) {
        yamlBlockIndent = indentLen;
      } else if (trimmedRest && !trimmedRest.startsWith("{") && !trimmedRest.startsWith("[")) {
        const maskedRest = maskAssignedValue(rest, mask);
        output = `${prefix}${rawKey}${separator}${maskedRest}`;
      }
    }
  }

  output = applyPatternRedactions(output, mask);

  for (const secretValue of extraValues) {
    if (output.includes(secretValue)) {
      output = output.split(secretValue).join(mask);
    }
  }

  return {
    text: output,
    masked: output !== text,
    yamlBlockIndent,
    inPemBlock,
  };
}

function maskAssignedValue(rest: string, mask: string): string {
  const trimmed = rest.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") return rest;

  // Preserve leading Authorization scheme (Bearer / Basic / Digest)
  const authMatch = rest.match(/^(\s*(?:["'])?(?:Bearer|Basic|Digest)\s+)([^\s"',;#]+)(.*)$/i);
  if (authMatch) {
    return `${authMatch[1]}${mask}${authMatch[3]}`;
  }

  // Quoted scalar value ("...", '...', `...`) preserving quotes, commas and comments
  const quote = rest.charAt(0);
  if (quote === '"' || quote === "'" || quote === "`") {
    let end = -1;
    for (let index = 1; index < rest.length; index += 1) {
      const ch = rest[index];
      if (ch === "\\" && quote !== "`") {
        index += 1;
        continue;
      }
      if (ch === quote) {
        end = index;
        break;
      }
    }
    if (end === 1) return rest; // Empty quoted string "" or ''
    if (end > 1) {
      return `${quote}${mask}${quote}${rest.slice(end + 1)}`;
    }
    return `${quote}${mask}${quote}`;
  }

  // Unquoted scalar value: preserve trailing comma and inline comments (# / //)
  const commentIdx = findInlineCommentIndex(rest);
  const valuePart = commentIdx >= 0 ? rest.slice(0, commentIdx) : rest;
  const commentPart = commentIdx >= 0 ? rest.slice(commentIdx) : "";
  const trailingMatch = valuePart.match(/^(.+?)(\s*,?\s*)$/);
  if (!trailingMatch) return rest;
  const coreValue = trailingMatch[1]!.trim();
  if (!coreValue || coreValue === "null" || coreValue === "~") return rest;
  return `${mask}${trailingMatch[2]}${commentPart}`;
}

function findInlineCommentIndex(text: string): number {
  const hashIdx = text.search(/\s+#/);
  const slashIdx = text.search(/\s+\/\//);
  if (hashIdx >= 0 && slashIdx >= 0) return Math.min(hashIdx, slashIdx);
  return Math.max(hashIdx, slashIdx);
}

function applyPatternRedactions(line: string, mask: string): string {
  return line
    .replace(URL_CREDENTIALS_RE, `$1${mask}:${mask}@`)
    .replace(AUTH_SCHEME_RE, `$1${mask}`)
    .replace(INLINE_KEY_VALUE_SECRET_RE, (_match, prefix: string, value: string) => {
      if (value.includes(mask)) return `${prefix}${value}`;
      if (/auth(?:orization)?/i.test(prefix) && /^(?:Bearer|Basic|Digest)$/i.test(value)) {
        return `${prefix}${value}`;
      }
      if (/^(?:[|>])(?:[-+]\d*|\d*[-+]?)?$/.test(value.trim())) return `${prefix}${value}`;
      if (value === '""' || value === "''" || value === "null" || value === "~") return `${prefix}${value}`;
      const quote = value.at(0);
      return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}${mask}${quote}` : mask}`;
    })
    .replace(VENDOR_TOKEN_RE, mask)
    .replace(SLACK_WEBHOOK_RE, `https://hooks.slack.com/services/${mask}`)
    .replace(JWT_TOKEN_RE, mask);
}
