import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { collectSecretsFromFields, maskDocumentLines } from "../../../shared/diff.ts";
import type { ConfigFormSchema, FieldSpec } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { SourceBadge } from "../ui.tsx";
import { FORMAT_LABELS } from "../utils/format.ts";
import { computeCenteredScrollTop, computeVirtualWindow } from "../utils/virtual-scroll.ts";

interface TextSegment {
  text: string;
  matchIndex?: number;
}

const RAW_LINE_HEIGHT = 22;
const RAW_OVERSCAN_LINES = 28;
const DEFAULT_VIEWPORT_HEIGHT = 520;

export function RawViewer({
  schema,
  fields,
  focusLine,
}: {
  schema: ConfigFormSchema;
  fields?: readonly FieldSpec[];
  focusLine?: { line: number; token: number };
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const [highlightedLine, setHighlightedLine] = useState<number>();
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const codeContainerRef = useRef<HTMLDivElement>(null);

  const rawLines = useMemo(
    () => schema.rawText.replace(/\r\n/g, "\n").split("\n"),
    [schema.rawText],
  );

  const { secretKeys, secretValues } = useMemo(
    () => collectSecretsFromFields(fields ?? schema.fields),
    [fields, schema.fields],
  );

  const maskedDoc = useMemo(
    () => maskDocumentLines(schema.rawText, { format: schema.format, secretKeys, secretValues }),
    [schema.rawText, schema.format, secretKeys, secretValues],
  );

  const displayLines = revealSecrets ? rawLines : maskedDoc.lines;
  const hasSensitiveContent = maskedDoc.maskedLineCount > 0 || secretKeys.length > 0;

  useEffect(() => {
    setQuery("");
    setActiveMatch(0);
    setHighlightedLine(undefined);
    setRevealSecrets(false);
    setScrollTop(0);
    if (codeContainerRef.current) codeContainerRef.current.scrollTop = 0;
  }, [schema.file]);

  useEffect(() => {
    if (focusLine?.token) setRevealSecrets(false);
  }, [focusLine?.token]);

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

  const trimmedQuery = query.trim();
  const { totalMatches, matchLines, lineMatchStart } = useMemo(() => {
    const starts = new Int32Array(displayLines.length);
    starts.fill(-1);
    if (!trimmedQuery) {
      return { totalMatches: 0, matchLines: [] as number[], lineMatchStart: starts };
    }
    const lowerNeedle = trimmedQuery.toLocaleLowerCase();
    const linesOfMatches: number[] = [];
    let count = 0;
    for (let i = 0; i < displayLines.length; i += 1) {
      const lowerLine = displayLines[i]!.toLocaleLowerCase();
      let cursor = 0;
      let firstOnLine = -1;
      while (cursor < lowerLine.length) {
        const hit = lowerLine.indexOf(lowerNeedle, cursor);
        if (hit < 0) break;
        if (firstOnLine < 0) firstOnLine = count;
        linesOfMatches.push(i);
        count += 1;
        cursor = hit + lowerNeedle.length;
      }
      starts[i] = firstOnLine;
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
    const height = container?.clientHeight || viewportHeight;
    const nextTop = computeCenteredScrollTop(targetLineIdx, height, RAW_LINE_HEIGHT, rawLines.length);
    if (container) container.scrollTop = nextTop;
    setScrollTop(nextTop);
    const frame = window.requestAnimationFrame(() => {
      const mark = codeContainerRef.current?.querySelector<HTMLElement>(`[data-match-index="${activeMatch}"]`);
      mark?.scrollIntoView({ block: "nearest", inline: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeMatch, totalMatches, matchLines, rawLines.length, viewportHeight]);

  useEffect(() => {
    if (!focusLine?.line) return;
    const targetLineIdx = Math.max(0, Math.min(rawLines.length - 1, focusLine.line - 1));
    setHighlightedLine(targetLineIdx + 1);
    const container = codeContainerRef.current;
    const height = container?.clientHeight || viewportHeight;
    const nextTop = computeCenteredScrollTop(targetLineIdx, height, RAW_LINE_HEIGHT, rawLines.length);
    if (container) container.scrollTop = nextTop;
    setScrollTop(nextTop);
    const timer = window.setTimeout(() => {
      setHighlightedLine((current) => (current === targetLineIdx + 1 ? undefined : current));
    }, 2_600);
    return () => window.clearTimeout(timer);
  }, [focusLine?.line, focusLine?.token, rawLines.length, viewportHeight]);

  const virtualWindow = useMemo(
    () => computeVirtualWindow(rawLines.length, scrollTop, viewportHeight, RAW_LINE_HEIGHT, RAW_OVERSCAN_LINES),
    [rawLines.length, scrollTop, viewportHeight],
  );

  const gutterWidth = Math.max(48, String(rawLines.length).length * 8 + 22);

  function stepMatch(delta: number): void {
    if (!totalMatches) return;
    setActiveMatch((current) => (current + delta + totalMatches) % totalMatches);
  }

  const visibleIndices: number[] = [];
  for (let idx = virtualWindow.startIndex; idx < virtualWindow.endIndex; idx += 1) {
    visibleIndices.push(idx);
  }

  return (
    <div id="editor-panel-raw" class="raw-page page-wide" role="tabpanel" aria-labelledby="editor-tab-raw">
      <div class="raw-notice">
        <Icon name="info"/>
        <span>{t("raw.notice")}</span>
        <SourceBadge source="heuristic"/>
      </div>
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
                <button type="button" class="icon-button" onClick={() => setQuery("")} aria-label={t("raw.clearSearch")}>
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
          class="raw-code-scroll"
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <div class="raw-lines" role="code" aria-label={schema.file}>
            {virtualWindow.topSpacerPx > 0 && (
              <div class="raw-spacer" style={{ height: `${virtualWindow.topSpacerPx}px` }} aria-hidden="true"/>
            )}
            {visibleIndices.map((lineIndex) => {
              const lineText = displayLines[lineIndex] ?? "";
              const startMatch = lineMatchStart[lineIndex] ?? -1;
              const segments = startMatch >= 0 && trimmedQuery
                ? segmentLine(lineText, trimmedQuery, startMatch)
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

function segmentLine(line: string, needle: string, firstMatchIndex: number): TextSegment[] {
  const lowerNeedle = needle.toLocaleLowerCase();
  const lowerLine = line.toLocaleLowerCase();
  const parts: TextSegment[] = [];
  let cursor = 0;
  let matchIndex = firstMatchIndex;
  while (cursor < line.length) {
    const hit = lowerLine.indexOf(lowerNeedle, cursor);
    if (hit < 0) {
      parts.push({ text: line.slice(cursor) });
      break;
    }
    if (hit > cursor) parts.push({ text: line.slice(cursor, hit) });
    parts.push({ text: line.slice(hit, hit + needle.length), matchIndex });
    matchIndex += 1;
    cursor = hit + needle.length;
  }
  if (!parts.length) parts.push({ text: "" });
  return parts;
}
