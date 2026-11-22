export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  totalHeightPx: number;
}

export interface TextMatchSegment {
  text: string;
  matchIndex?: number;
}

export interface MatchRange {
  start: number;
  end: number;
}

/**
 * Computes the visible row slice `[startIndex, endIndex)` and spacer heights
 * for a fixed-row-height virtual scroll container, taking optional vertical
 * container padding into account.
 */
export function computeVirtualWindow(
  totalLines: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 24,
  paddingTop = 0,
  paddingBottom = paddingTop,
): VirtualWindow {
  const safeTotal = Math.max(0, Math.trunc(totalLines));
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewport = Math.max(safeRowHeight, viewportHeight);
  const safePadTop = Math.max(0, paddingTop);
  const safePadBottom = Math.max(0, paddingBottom);
  const contentHeightPx = safeTotal * safeRowHeight;
  const totalHeightPx = contentHeightPx + safePadTop + safePadBottom;
  if (safeTotal === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx: 0,
    };
  }
  const maxScroll = Math.max(0, totalHeightPx - safeViewport);
  const clampedScroll = Math.max(0, Math.min(scrollTop, maxScroll));
  const effectiveScroll = Math.max(0, clampedScroll - safePadTop);
  const firstVisible = Math.min(safeTotal - 1, Math.floor(effectiveScroll / safeRowHeight));
  const visibleCount = Math.ceil(safeViewport / safeRowHeight);
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(safeTotal, firstVisible + visibleCount + overscan);
  return {
    startIndex,
    endIndex,
    topSpacerPx: startIndex * safeRowHeight,
    bottomSpacerPx: (safeTotal - endIndex) * safeRowHeight,
    totalHeightPx,
  };
}

/**
 * Computes the vertical scroll offset that centers `targetLineIndex` (0-based)
 * within the viewport, accounting for vertical padding and clamped to valid
 * scroll bounds.
 */
export function computeCenteredScrollTop(
  targetLineIndex: number,
  viewportHeight: number,
  rowHeight: number,
  totalLines: number,
  paddingTop = 0,
  paddingBottom = paddingTop,
): number {
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewport = Math.max(safeRowHeight, viewportHeight);
  const safeTotal = Math.max(0, Math.trunc(totalLines));
  if (safeTotal === 0) return 0;
  const safePadTop = Math.max(0, paddingTop);
  const safePadBottom = Math.max(0, paddingBottom);
  const clampedIndex = Math.max(0, Math.min(safeTotal - 1, Math.trunc(targetLineIndex)));
  const totalHeightPx = safeTotal * safeRowHeight + safePadTop + safePadBottom;
  const maxScroll = Math.max(0, totalHeightPx - safeViewport);
  const ideal = safePadTop + clampedIndex * safeRowHeight - safeViewport / 2 + safeRowHeight / 2;
  return Math.max(0, Math.min(maxScroll, Math.round(ideal)));
}

/**
 * Estimates the maximum monospace character-cell width across all lines in a
 * file so virtualized raw views can maintain a stable horizontal scroll width
 * even when long lines scroll out of the mounted window.
 */
export function computeMaxLineCharWidth(lines: readonly string[]): number {
  let max = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const width = measureMonoLineWidth(lines[i] ?? "");
    if (width > max) max = width;
  }
  return max;
}

function measureMonoLineWidth(line: string): number {
  let width = 0;
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (code === 9) {
      width += 4;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < line.length) {
      // Surrogate pair (e.g. emoji / supplementary CJK)
      width += 2;
      i += 1;
    } else if (isWideCodeUnit(code)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function isWideCodeUnit(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  );
}

/**
 * Finds all non-overlapping case-insensitive matches of `needle` inside `line`,
 * returning exact UTF-16 `[start, end)` ranges in the ORIGINAL `line`. Correctly
 * handles multi-code-unit case-folding expansions (such as U+0130 `İ` -> `i\u0307`)
 * so highlights never drift off target characters.
 */
export function findLineMatchRanges(line: string, needle: string): MatchRange[] {
  if (!needle || !line) return [];
  const lowerNeedle = needle.toLowerCase();
  if (!lowerNeedle) return [];

  // Fast path: pure ASCII has guaranteed 1:1 UTF-16 code-unit correspondence.
  if (!/[^\x00-\x7f]/.test(line) && !/[^\x00-\x7f]/.test(needle)) {
    const lowerLine = line.toLowerCase();
    const ranges: MatchRange[] = [];
    let cursor = 0;
    while (cursor <= lowerLine.length - lowerNeedle.length) {
      const hit = lowerLine.indexOf(lowerNeedle, cursor);
      if (hit < 0) break;
      ranges.push({ start: hit, end: hit + lowerNeedle.length });
      cursor = hit + lowerNeedle.length;
    }
    return ranges;
  }

  // General Unicode path: build folded string + exact original UTF-16 span map.
  let folded = "";
  const origStarts: number[] = [];
  const origEnds: number[] = [];
  for (let i = 0; i < line.length; ) {
    const cp = line.codePointAt(i)!;
    const charLen = cp > 0xffff ? 2 : 1;
    const origStart = i;
    const origEnd = i + charLen;
    const lowerPiece = line.slice(origStart, origEnd).toLowerCase();
    folded += lowerPiece;
    for (let k = 0; k < lowerPiece.length; k += 1) {
      origStarts.push(origStart);
      origEnds.push(origEnd);
    }
    i = origEnd;
  }

  const ranges: MatchRange[] = [];
  let cursor = 0;
  while (cursor <= folded.length - lowerNeedle.length) {
    const hit = folded.indexOf(lowerNeedle, cursor);
    if (hit < 0) break;
    const start = origStarts[hit]!;
    const end = origEnds[hit + lowerNeedle.length - 1]!;
    ranges.push({ start, end });
    cursor = hit + lowerNeedle.length;
  }
  return ranges;
}

/** Splits `line` into highlighted match segments using exact original UTF-16 ranges. */
export function segmentLineMatches(
  line: string,
  needle: string,
  firstMatchIndex: number,
): TextMatchSegment[] {
  const ranges = findLineMatchRanges(line, needle);
  if (!ranges.length) return [{ text: line }];
  const parts: TextMatchSegment[] = [];
  let cursor = 0;
  let matchIndex = firstMatchIndex;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({ text: line.slice(cursor, range.start) });
    }
    parts.push({ text: line.slice(range.start, range.end), matchIndex });
    matchIndex += 1;
    cursor = range.end;
  }
  if (cursor < line.length) {
    parts.push({ text: line.slice(cursor) });
  }
  return parts;
}
