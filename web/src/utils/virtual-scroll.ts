export interface VirtualWindow {
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  totalHeightPx: number;
}

/**
 * Computes the visible row slice `[startIndex, endIndex)` and spacer heights
 * for a fixed-row-height virtual scroll container.
 */
export function computeVirtualWindow(
  totalLines: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight: number,
  overscan = 24,
): VirtualWindow {
  const safeTotal = Math.max(0, Math.trunc(totalLines));
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewport = Math.max(safeRowHeight, viewportHeight);
  const totalHeightPx = safeTotal * safeRowHeight;
  if (safeTotal === 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      totalHeightPx: 0,
    };
  }
  const clampedScroll = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeightPx - safeViewport)));
  const firstVisible = Math.floor(clampedScroll / safeRowHeight);
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
 * within the viewport, clamped to valid scroll bounds.
 */
export function computeCenteredScrollTop(
  targetLineIndex: number,
  viewportHeight: number,
  rowHeight: number,
  totalLines: number,
): number {
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewport = Math.max(safeRowHeight, viewportHeight);
  const safeTotal = Math.max(0, Math.trunc(totalLines));
  const clampedIndex = Math.max(0, Math.min(safeTotal - 1, Math.trunc(targetLineIndex)));
  const maxScroll = Math.max(0, safeTotal * safeRowHeight - safeViewport);
  const ideal = clampedIndex * safeRowHeight - safeViewport / 2 + safeRowHeight / 2;
  return Math.max(0, Math.min(maxScroll, Math.round(ideal)));
}
