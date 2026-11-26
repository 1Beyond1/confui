import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { collectSecretsFromFields, maskDocumentLines, type DocumentLineSecrets } from "../../../shared/diff.ts";
import type { ConfigFormSchema, FieldSpec } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { SourceBadge } from "../ui.tsx";
import { FORMAT_LABELS } from "../utils/format.ts";
import {
  computeCenteredScrollTop,
  computeMaxLineCharWidth,
  computeVirtualWindow,
  findLineMatchRanges,
  segmentLineMatches,
} from "../utils/virtual-scroll.ts";

const RAW_LINE_HEIGHT = 22;
const RAW_PADDING_Y = 12;
const RAW_OVERSCAN_LINES = 28;
const DEFAULT_VIEWPORT_HEIGHT = 520;
const SEARCH_DEBOUNCE_MS = 140;

export function RawViewer({
  schema,
  fields,
  focusLine,
  onConsumeFocusLine,
}: {
  schema: ConfigFormSchema;
  fields?: readonly FieldSpec[];
  focusLine?: { line: number; token: number };
  onConsumeFocusLine?: (token: number) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [highlightedLine, setHighlightedLine] = useState<number>();
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const viewportHeightRef = useRef(viewportHeight);
  viewportHeightRef.current = viewportHeight;
  const codeContainerRef = useRef<HTMLDivElement>(null);
  const handledFocusTokenRef = useRef<number>();
  const highlightTimerRef = useRef<number>();

  const rawLines = useMemo(
    () => schema.rawText.replace(/\r\n/g, "\n").split("\n"),
    [schema.rawText],
  );

  const activeSecrets = useMemo(
    () => collectSecretsFromFields(fields ?? schema.fields),
    [fields, schema.fields],
  );

  const documentSecrets = useMemo<DocumentLineSecrets[] | undefined>(() => {
    if (schema.format !== "yaml" || !schema.yamlDocuments || schema.yamlDocuments.length <= 1) {
      return undefined;
    }
    const activeDocIdx = schema.activeDocumentIndex ?? 0;
    const byDoc = new Map((schema.documentSecrets ?? []).map((entry) => [entry.documentIndex, entry]));
    return schema.yamlDocuments.map((doc, idx) => {
      const nextDoc = schema.yamlDocuments![idx + 1];
      const meta = byDoc.get(doc.index);
      const keys = new Set<string>(meta?.secretKeys ?? []);
      const vals = new Set<string>(meta?.secretValues ?? []);
      if (doc.index === activeDocIdx) {
        for (const k of activeSecrets.secretKeys) keys.add(k);
        for (const v of activeSecrets.secretValues) vals.add(v);
      }
      return {
        startLine: idx === 0 ? 1 : doc.startLine,
        endLine: nextDoc?.startLine,
        secretKeys: [...keys],
        secretValues: [...vals],
      };
    });
  }, [schema.format, schema.yamlDocuments, schema.activeDocumentIndex, schema.documentSecrets, activeSecrets]);

  const maskedDoc = useMemo(
    () => maskDocumentLines(
      schema.rawText,
      documentSecrets
        ? { format: schema.format, documentSecrets }
        : { format: schema.format, secretKeys: activeSecrets.secretKeys, secretValues: activeSecrets.secretValues },
    ),
    [schema.rawText, schema.format, documentSecrets, activeSecrets],
  );

  const displayLines = revealSecrets ? rawLines : maskedDoc.lines;
  const displayParseError = useMemo(() => {
    if (!schema.parseError) return undefined;
    const firstLine = schema.parseError
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? schema.parseError;
    if (revealSecrets) return firstLine;
    return maskDocumentLines(firstLine, { format: schema.format }).lines.join(" ");
  }, [schema.parseError, schema.format, revealSecrets]);
  const hasSensitiveContent = maskedDoc.maskedLineCount > 0
    || activeSecrets.secretKeys.length > 0
    || Boolean(documentSecrets?.some((sec) => (sec.secretKeys?.length ?? 0) > 0 || (sec.secretValues?.length ?? 0) > 0));
  const maxLineChars = useMemo(() => computeMaxLineCharWidth(displayLines), [displayLines]);

  useEffect(() => {
    setQuery("");
    setDebouncedQuery("");
    setActiveMatch(0);
    setHighlightedLine(undefined);
    setRevealSecrets(false);
    setScrollTop(0);
    if (codeContainerRef.current) {
      codeContainerRef.current.scrollTop = 0;
      codeContainerRef.current.scrollLeft = 0;
    }
  }, [schema.file]);

  useEffect(() => {
    if (focusLine?.token) setRevealSecrets(false);
  }, [focusLine?.token]);

  useEffect(() => {
    if (!query.trim()) {
      setDebouncedQuery("");
      return;
    }
    const timer = window.setTimeout(() => setDebouncedQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const container = codeContainerRef.current;
    if (!container) return;
    const updateHeight = () => {
      if (container.clientHeight > 0) setViewportHeight(container.clientHeight);
    };
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const trimmedQuery = debouncedQuery.trim();
  const { totalMatches, matchLines, lineMatchStart } = useMemo(() => {
    const starts = new Int32Array(displayLines.length);
    starts.fill(-1);
    if (!trimmedQuery) {
      return { totalMatches: 0, matchLines: [] as number[], lineMatchStart: starts };
    }
    const linesOfMatches: number[] = [];
    let count = 0;
    for (let i = 0; i < displayLines.length; i += 1) {
      const ranges = findLineMatchRanges(displayLines[i]!, trimmedQuery);
      if (ranges.length > 0) {
        starts[i] = count;
        for (let r = 0; r < ranges.length; r += 1) {
          linesOfMatches.push(i);
          count += 1;
        }
      }
    }
    return { totalMatches: count, matchLines: linesOfMatches, lineMatchStart: starts };
  }, [displayLines, trimmedQuery]);

  useEffect(() => {
    setActiveMatch(0);
  }, [trimmedQuery]);

  useEffect(() => {
    if (!totalMatches) return;
    const targetLineIdx = matchLines[activeMatch];
    if (targetLineIdx === undefined) return;
    const container = codeContainerRef.current;
    const height = container?.clientHeight || viewportHeightRef.current;
    const nextTop = computeCenteredScrollTop(
      targetLineIdx,
      height,
      RAW_LINE_HEIGHT,
      displayLines.length,
      RAW_PADDING_Y,
      RAW_PADDING_Y,
    );
    if (container) container.scrollTop = nextTop;
    setScrollTop(nextTop);
    const frame = window.requestAnimationFrame(() => {
      const scroller = codeContainerRef.current;
      const mark = scroller?.querySelector<HTMLElement>(`[data-match-index="${activeMatch}"]`);
      if (!scroller || !mark) return;
      // Scroll strictly within the raw viewer's own scroll container without touching outer ancestors.
      const scrollerRect = scroller.getBoundingClientRect();
      const markRect = mark.getBoundingClientRect();
      const markLeftInContent = markRect.left - scrollerRect.left + scroller.scrollLeft;
      const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const targetLeft = Math.max(
        0,
        Math.min(maxScrollLeft, Math.round(markLeftInContent - scroller.clientWidth / 2 + markRect.width / 2)),
      );
      scroller.scrollLeft = targetLeft;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMatch, totalMatches, matchLines, displayLines.length]);

  useEffect(() => () => {
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    if (!focusLine?.line || focusLine.token === handledFocusTokenRef.current) return;
    handledFocusTokenRef.current = focusLine.token;
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
    const targetLineIdx = Math.max(0, Math.min(displayLines.length - 1, focusLine.line - 1));
    setHighlightedLine(targetLineIdx + 1);
    const container = codeContainerRef.current;
    const height = container?.clientHeight || viewportHeightRef.current;
    const nextTop = computeCenteredScrollTop(
      targetLineIdx,
      height,
      RAW_LINE_HEIGHT,
      displayLines.length,
      RAW_PADDING_Y,
      RAW_PADDING_Y,
    );
    if (container) container.scrollTop = nextTop;
    setScrollTop(nextTop);
    onConsumeFocusLine?.(focusLine.token);
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = undefined;
      setHighlightedLine((current) => (current === targetLineIdx + 1 ? undefined : current));
    }, 2_600);
  }, [focusLine?.line, focusLine?.token, displayLines.length, onConsumeFocusLine]);

  const virtualWindow = useMemo(
    () => computeVirtualWindow(
      displayLines.length,
      scrollTop,
      viewportHeight,
      RAW_LINE_HEIGHT,
      RAW_OVERSCAN_LINES,
      RAW_PADDING_Y,
      RAW_PADDING_Y,
    ),
    [displayLines.length, scrollTop, viewportHeight],
  );

  const gutterWidth = Math.max(48, String(displayLines.length).length * 8 + 22);
  const stableMinWidth = maxLineChars > 0
    ? `calc(${gutterWidth + 40}px + ${maxLineChars}ch)`
    : undefined;

  function stepMatch(delta: number): void {
    if (query.trim() && query !== debouncedQuery) {
      setDebouncedQuery(query);
      return;
    }
    if (!totalMatches) return;
    setActiveMatch((current) => (current + delta + totalMatches) % totalMatches);
  }

  const visibleIndices: number[] = [];
  for (let idx = virtualWindow.startIndex; idx < virtualWindow.endIndex; idx += 1) {
    visibleIndices.push(idx);
  }

  return (
    <div id="editor-panel-raw" class="raw-page page-wide" role="tabpanel" aria-labelledby="editor-tab-raw">
      {displayParseError ? (
        <div class="raw-notice raw-notice--error" role="alert">
          <Icon name="warning"/>
          <span>{t("raw.parseErrorNotice", { error: displayParseError })}</span>
        </div>
      ) : (
        <div class="raw-notice">
          <Icon name="info"/>
          <span>{t("raw.notice")}</span>
          <SourceBadge source="heuristic"/>
        </div>
      )}
      <section class="raw-card">
        <header>
          <div class="raw-card__title">
            <span>{schema.file}</span>
            <small>{t("raw.meta", { format: FORMAT_LABELS[schema.format], lines: displayLines.length })}</small>
            {!revealSecrets && maskedDoc.maskedLineCount > 0 && (
              <span class="udiff__masked-pill" title={t("diff.secretsMaskedHint")}>
                <Icon name="shield" size={12}/>
                <span>{t("diff.secretsMaskedBadge")}</span>
              </span>
            )}
          </div>
          <div class="raw-search">
            {hasSensitiveContent && (
              <button
                type="button"
                class="udiff__secret-toggle"
                aria-pressed={revealSecrets}
                onClick={() => setRevealSecrets((current) => !current)}
              >
                <Icon name={revealSecrets ? "eye-off" : "eye"} size={13}/>
                <span>{revealSecrets ? t("diff.hideSecrets") : t("diff.showSecrets")}</span>
              </button>
            )}
            <label class="raw-search__input">
              <Icon name="search" size={14}/>
              <input
                value={query}
                placeholder={t("raw.searchPlaceholder")}
                aria-label={t("raw.searchPlaceholder")}
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    stepMatch(event.shiftKey ? -1 : 1);
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  class="icon-button"
                  onClick={() => {
                    setQuery("");
                    setDebouncedQuery("");
                  }}
                  aria-label={t("raw.clearSearch")}
                >
                  <Icon name="x" size={13}/>
                </button>
              )}
            </label>
            {trimmedQuery && (
              <span class="raw-search__count" role="status">
                {totalMatches > 0 ? `${activeMatch + 1} / ${totalMatches}` : t("raw.noMatches")}
              </span>
            )}
            <div class="raw-search__nav">
              <button
                type="button"
                class="icon-button"
                disabled={totalMatches === 0}
                onClick={() => stepMatch(-1)}
                aria-label={t("raw.prevMatch")}
                title={t("raw.prevMatchTitle")}
              >
                <Icon name="chevron-down" size={14} class="icon-rotate-180"/>
              </button>
              <button
                type="button"
                class="icon-button"
                disabled={totalMatches === 0}
                onClick={() => stepMatch(1)}
                aria-label={t("raw.nextMatch")}
                title={t("raw.nextMatchTitle")}
              >
                <Icon name="chevron-down" size={14}/>
              </button>
            </div>
          </div>
        </header>
        <div
          ref={codeContainerRef}
          class="raw-viewer raw-code-scroll"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div class="raw-lines" style={stableMinWidth ? { minWidth: stableMinWidth } : undefined} role="code" aria-label={schema.file}>
            {virtualWindow.topSpacerPx > 0 && (
              <div class="raw-spacer" style={{ height: `${virtualWindow.topSpacerPx}px` }} aria-hidden="true"/>
            )}
            {visibleIndices.map((lineIndex) => {
              const lineText = displayLines[lineIndex] ?? "";
              const startMatch = lineMatchStart[lineIndex] ?? -1;
              const segments = startMatch >= 0 && trimmedQuery
                ? segmentLineMatches(lineText, trimmedQuery, startMatch)
                : [{ text: lineText }];
              return (
                <div
                  class={`raw-line ${highlightedLine === lineIndex + 1 ? "raw-line--highlighted" : ""}`}
                  data-line-number={lineIndex + 1}
                  key={lineIndex}
                >
                  <span class="raw-line-num" style={{ minWidth: `${gutterWidth}px`, width: `${gutterWidth}px` }} aria-hidden="true">
                    {lineIndex + 1}
                  </span>
                  <span class="raw-line-code">
                    {segments.map((seg, segIndex) =>
                      seg.matchIndex !== undefined ? (
                        <mark
                          key={segIndex}
                          data-match-index={seg.matchIndex}
                          class={`raw-match ${seg.matchIndex === activeMatch ? "raw-match--active" : ""}`}
                        >
                          {seg.text}
                        </mark>
                      ) : (
                        <span key={segIndex}>{seg.text}</span>
                      ),
                    )}
                  </span>
                </div>
              );
            })}
            {virtualWindow.bottomSpacerPx > 0 && (
              <div class="raw-spacer" style={{ height: `${virtualWindow.bottomSpacerPx}px` }} aria-hidden="true"/>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
