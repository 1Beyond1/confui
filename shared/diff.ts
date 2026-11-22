export type DiffLineKind = "context" | "add" | "remove";

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
