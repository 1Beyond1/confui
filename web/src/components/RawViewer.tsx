import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ConfigFormSchema } from "../../../shared/schema.ts";
import { Icon } from "../icons.tsx";
import { SourceBadge } from "../ui.tsx";
import { FORMAT_LABELS } from "../utils/format.ts";

interface TextSegment {
  text: string;
  matchIndex?: number;
}

export function RawViewer({ schema }: { schema: ConfigFormSchema }) {
  const [query, setQuery] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const codeContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setQuery("");
    setActiveMatch(0);
  }, [schema.file]);

  const { lines, totalMatches } = useMemo(() => {
    const rawLines = schema.rawText.replace(/\r\n/g, "\n").split("\n");
    const needle = query.trim();
    if (!needle) {
      return {
        lines: rawLines.map((line) => [{ text: line }] as TextSegment[]),
        totalMatches: 0,
      };
    }
    const lowerNeedle = needle.toLocaleLowerCase();
    let count = 0;
    const segmented = rawLines.map((line) => {
      const lowerLine = line.toLocaleLowerCase();
      const parts: TextSegment[] = [];
      let cursor = 0;
      while (cursor < line.length) {
        const hit = lowerLine.indexOf(lowerNeedle, cursor);
        if (hit < 0) {
          parts.push({ text: line.slice(cursor) });
          break;
        }
        if (hit > cursor) parts.push({ text: line.slice(cursor, hit) });
        parts.push({ text: line.slice(hit, hit + needle.length), matchIndex: count });
        count += 1;
        cursor = hit + needle.length;
      }
      if (!parts.length) parts.push({ text: "" });
      return parts;
    });
    return { lines: segmented, totalMatches: count };
  }, [schema.rawText, query]);

  useEffect(() => {
    setActiveMatch(0);
  }, [query]);

  useEffect(() => {
    if (!totalMatches) return;
    const mark = codeContainerRef.current?.querySelector<HTMLElement>(`[data-match-index="${activeMatch}"]`);
    mark?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeMatch, totalMatches]);

  function stepMatch(delta: number): void {
    if (!totalMatches) return;
    setActiveMatch((current) => (current + delta + totalMatches) % totalMatches);
  }

  return (
    <div id="editor-panel-raw" class="raw-page page-wide" role="tabpanel" aria-labelledby="editor-tab-raw">
      <div class="raw-notice">
        <Icon name="info"/>
        <span>原始内容用于核对格式和注释；请回到表单进行安全修改。</span>
        <SourceBadge source="heuristic"/>
      </div>
      <section class="raw-card">
        <header>
          <div class="raw-card__title">
            <span>{schema.file}</span>
            <small>{FORMAT_LABELS[schema.format]} · {lines.length} 行 · 只读</small>
          </div>
          <div class="raw-search">
            <label class="raw-search__input">
              <Icon name="search" size={14}/>
              <input
                value={query}
                placeholder="页内搜索关键词"
                aria-label="页内搜索关键词"
                onInput={(event) => setQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    stepMatch(event.shiftKey ? -1 : 1);
                  }
                }}
              />
              {query && (
                <button type="button" class="icon-button" onClick={() => setQuery("")} aria-label="清空搜索">
                  <Icon name="x" size={13}/>
                </button>
              )}
            </label>
            {query.trim() && (
              <span class="raw-search__count" role="status">
                {totalMatches > 0 ? `${activeMatch + 1} / ${totalMatches}` : "0 匹配"}
              </span>
            )}
            <div class="raw-search__nav">
              <button
                type="button"
                class="icon-button"
                disabled={totalMatches === 0}
                onClick={() => stepMatch(-1)}
                aria-label="上一处匹配"
                title="上一处匹配 (Shift+Enter)"
              >
                <Icon name="chevron-down" size={14} class="icon-rotate-180"/>
              </button>
              <button
                type="button"
                class="icon-button"
                disabled={totalMatches === 0}
                onClick={() => stepMatch(1)}
                aria-label="下一处匹配"
                title="下一处匹配 (Enter)"
              >
                <Icon name="chevron-down" size={14}/>
              </button>
            </div>
          </div>
        </header>
        <div ref={codeContainerRef} class="raw-code-scroll">
          <div class="raw-lines" role="code" aria-label={schema.file}>
            {lines.map((segments, lineIndex) => (
              <div class="raw-line" key={lineIndex}>
                <span class="raw-line-num" aria-hidden="true">{lineIndex + 1}</span>
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
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
