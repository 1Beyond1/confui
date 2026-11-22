import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  ConfigFile,
  ConfigFormSchema,
  FieldSpec,
  ProjectScanResult,
  ProjectSearchHit,
  SearchMatchKind,
} from "../../../shared/schema.ts";
import {
  buildDeepFieldIndex,
  type DeepFieldEntry,
  type DeepFieldKind,
  type EditorValues,
} from "../editor-state.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { FORMAT_SHORT_LABELS } from "../utils/format.ts";

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  keywords?: string;
  shortcut?: string;
  icon: IconName;
  disabled?: boolean;
  run: () => void;
}

type PaletteEntry =
  | { kind: "deep"; id: string; deep: DeepFieldEntry }
  | { kind: "hit"; id: string; hit: ProjectSearchHit }
  | { kind: "file"; id: string; file: ConfigFile }
  | { kind: "command"; id: string; command: PaletteCommand };

export function CommandPalette({
  project,
  activeSchema,
  activeFields,
  activeValues,
  openableFiles,
  commands,
  onClose,
  onSelectFile,
  onSelectSearchHit,
  onSelectDeepField,
}: {
  project?: ProjectScanResult;
  activeSchema?: ConfigFormSchema;
  activeFields?: readonly FieldSpec[];
  activeValues?: EditorValues;
  openableFiles: readonly ConfigFile[];
  commands: readonly PaletteCommand[];
  onClose: () => void;
  onSelectFile: (file: ConfigFile) => void;
  onSelectSearchHit: (hit: ProjectSearchHit) => void;
  onSelectDeepField?: (entry: DeepFieldEntry) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProjectSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchSeq = useRef(0);
  const inFlightRootRef = useRef<string>();

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (inFlightRootRef.current) {
        const rootToCancel = inFlightRootRef.current;
        inFlightRootRef.current = undefined;
        void window.confui.searchProject(rootToCancel, "");
      }
    };
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!project || !trimmed) {
      searchSeq.current += 1;
      if (inFlightRootRef.current) {
        const rootToCancel = inFlightRootRef.current;
        inFlightRootRef.current = undefined;
        void window.confui.searchProject(rootToCancel, "");
      }
      setHits([]);
      setSearching(false);
      setTruncated(false);
      setSearchError(undefined);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(undefined);
    const timer = window.setTimeout(() => {
      inFlightRootRef.current = project.root;
      void window.confui.searchProject(project.root, trimmed, { limit: 40 }).then((response) => {
        if (seq !== searchSeq.current) return;
        inFlightRootRef.current = undefined;
        setSearching(false);
        if (!response.ok) {
          setHits([]);
          setTruncated(false);
          setSearchError(response.error.detail || response.error.message);
          return;
        }
        setHits(response.data.hits);
        setTruncated(response.data.truncated);
      });
    }, 160);
    return () => window.clearTimeout(timer);
  }, [project, query]);

  const normalized = query.trim().toLowerCase();

  const deepIndex = useMemo(() => {
    if (!activeSchema || !activeFields?.length || !activeValues) return [];
    return buildDeepFieldIndex(activeFields, activeValues);
  }, [activeSchema, activeFields, activeValues]);

  const matchingDeepFields = useMemo(() => {
    if (!normalized || !deepIndex.length) return [];
    // Prioritize nested paths & array cards in the active file (plus top-level matches).
    const scored: Array<{ entry: DeepFieldEntry; rank: number }> = [];
    for (const entry of deepIndex) {
      const pathLower = entry.path.toLowerCase();
      const labelLower = entry.label.toLowerCase();
      const descLower = (entry.description ?? "").toLowerCase();
      const valLower = entry.searchableValue.toLowerCase(); // Always "" for secret entries!
      if (pathLower === normalized) {
        scored.push({ entry, rank: 0 });
      } else if (pathLower.includes(normalized)) {
        scored.push({ entry, rank: entry.kind === "card" || entry.kind === "nested" ? 1 : 2 });
      } else if (labelLower.includes(normalized)) {
        scored.push({ entry, rank: 3 });
      } else if (valLower && valLower.includes(normalized)) {
        scored.push({ entry, rank: 4 });
      } else if (descLower && descLower.includes(normalized)) {
        scored.push({ entry, rank: 5 });
      }
    }
    scored.sort((a, b) => a.rank - b.rank || a.entry.path.localeCompare(b.entry.path, "en", { numeric: true }));
    return scored.slice(0, 18).map((item) => item.entry);
  }, [deepIndex, normalized]);

  const matchingFiles = useMemo(() => {
    if (!project || !normalized) return [];
    return openableFiles
      .filter((file) => file.path.toLowerCase().includes(normalized))
      .slice(0, 10);
  }, [project, openableFiles, normalized]);

  const matchingCommands = useMemo(() => {
    const enabled = commands.filter((cmd) => !cmd.disabled);
    if (!normalized) return enabled;
    return enabled.filter((cmd) =>
      [cmd.label, cmd.description, cmd.keywords, cmd.shortcut]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    );
  }, [commands, normalized]);

  const entries = useMemo<PaletteEntry[]>(() => {
    const list: PaletteEntry[] = [];
    for (let i = 0; i < matchingDeepFields.length; i += 1) {
      const deep = matchingDeepFields[i]!;
      list.push({ kind: "deep", id: `deep:${deep.path}:${i}`, deep });
    }
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i]!;
      list.push({
        kind: "hit",
        id: `hit:${hit.file}:${hit.documentIndex ?? ""}:${hit.path ?? ""}:${hit.line ?? 0}:${hit.matchKind}:${i}`,
        hit,
      });
    }
    for (const file of matchingFiles) {
      list.push({ kind: "file", id: `file:${file.path}`, file });
    }
    for (const command of matchingCommands) {
      list.push({ kind: "command", id: `cmd:${command.id}`, command });
    }
    return list;
  }, [matchingDeepFields, hits, matchingFiles, matchingCommands]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, matchingDeepFields.length, hits.length, matchingFiles.length, matchingCommands.length]);

  useEffect(() => {
    const item = listRef.current?.querySelector<HTMLElement>(`[data-palette-index="${activeIndex}"]`);
    item?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function executeEntry(entry: PaletteEntry): void {
    onClose();
    if (entry.kind === "deep") {
      onSelectDeepField?.(entry.deep);
    } else if (entry.kind === "hit") {
      onSelectSearchHit(entry.hit);
    } else if (entry.kind === "file") {
      onSelectFile(entry.file);
    } else {
      entry.command.run();
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (!entries.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % entries.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + entries.length) % entries.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(entries.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = entries[activeIndex];
      if (chosen) executeEntry(chosen);
    }
  }

  function matchKindLabel(kind: SearchMatchKind): string {
    switch (kind) {
      case "path": return t("palette.matchPath");
      case "value": return t("palette.matchValue");
      case "comment": return t("palette.matchComment");
    }
  }

  function deepKindLabel(kind: DeepFieldKind): string {
    switch (kind) {
      case "card": return t("palette.deepKindCard");
      case "nested": return t("palette.deepKindNested");
      case "field": return t("palette.deepKindField");
    }
  }

  const deepStart = 0;
  const hitStart = matchingDeepFields.length;
  const fileStart = hitStart + hits.length;
  const cmdStart = fileStart + matchingFiles.length;

  return (
    <div
      class="modal-backdrop palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.ariaLabel")}
        onKeyDown={handleKeyDown}
      >
        <div class="palette__input-wrap">
          <Icon name={searching ? "loader" : "search"} size={17} class={searching ? "spin" : undefined}/>
          <input
            ref={inputRef}
            class="palette__input"
            value={query}
            placeholder={project ? t("palette.placeholderWithProject") : t("palette.placeholderNoProject")}
            aria-label={t("palette.ariaLabel")}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query && (
            <button
              type="button"
              class="icon-button"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label={t("common.clear")}
            >
              <Icon name="x" size={14}/>
            </button>
          )}
          <kbd class="palette__kbd">Esc</kbd>
        </div>

        <div ref={listRef} class="palette__results" role="listbox" aria-label={t("palette.resultsAria")}>
          {searchError && (
            <div class="palette__notice palette__notice--error" role="alert">
              <Icon name="warning" size={14}/>
              <span>{searchError}</span>
            </div>
          )}

          {matchingDeepFields.length > 0 && activeSchema && (
            <div class="palette__section">
              <div class="palette__section-title">
                <span>{t("palette.sectionDeepFields", { count: matchingDeepFields.length })}</span>
              </div>
              {matchingDeepFields.map((deep, idx) => {
                const flatIndex = deepStart + idx;
                const entry = entries[flatIndex]!;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeIndex}
                    data-palette-index={flatIndex}
                    class={`palette__item ${flatIndex === activeIndex ? "active" : ""}`}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => executeEntry(entry)}
                  >
                    <span class="palette__cmd-icon">
                      <Icon name={deep.kind === "card" ? "layers" : "code"} size={14}/>
                    </span>
                    <span class="palette__item-body">
                      <span class="palette__item-head">
                        <strong class="palette__hit-path">{deep.path}</strong>
                        <span class={`palette__kind palette__kind--${deep.kind === "card" ? "path" : "value"}`}>
                          {deepKindLabel(deep.kind)}
                        </span>
                        {deep.secret && (
                          <span class="palette__secret-badge" title={t("palette.secretRedactedHint")}>
                            <Icon name="shield" size={11}/>
                            <span>{t("diff.secretsMaskedBadge")}</span>
                          </span>
                        )}
                      </span>
                      <span class="palette__item-sub">
                        <span class="palette__deep-label">{deep.label}</span>
                        {deep.preview && <span class="palette__hit-preview">{deep.preview}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {hits.length > 0 && (
            <div class="palette__section">
              <div class="palette__section-title">
                <span>{t("palette.sectionSearch", { count: hits.length })}</span>
                {truncated && <small>{t("palette.truncated")}</small>}
              </div>
              {hits.map((hit, idx) => {
                const flatIndex = hitStart + idx;
                const entry = entries[flatIndex]!;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeIndex}
                    data-palette-index={flatIndex}
                    class={`palette__item ${flatIndex === activeIndex ? "active" : ""}`}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => executeEntry(entry)}
                  >
                    <span class={`format-icon format-icon--${hit.format}`}>{FORMAT_SHORT_LABELS[hit.format]}</span>
                    <span class="palette__item-body">
                      <span class="palette__item-head">
                        <strong class="palette__hit-path">
                          {hit.path ?? t("palette.commentLine", { line: hit.line ?? 1 })}
                        </strong>
                        <span class={`palette__kind palette__kind--${hit.matchKind}`}>
                          {matchKindLabel(hit.matchKind)}
                        </span>
                        {hit.documentIndex !== undefined && (
                          <span class="palette__doc-badge">
                            {hit.documentLabel || t("editor.yamlDocFallback", { index: hit.documentIndex + 1 })}
                          </span>
                        )}
                        {hit.secret && (
                          <span class="palette__secret-badge" title={t("palette.secretRedactedHint")}>
                            <Icon name="shield" size={11}/>
                            <span>{t("diff.secretsMaskedBadge")}</span>
                          </span>
                        )}
                      </span>
                      <span class="palette__item-sub">
                        <code class="palette__hit-file">{hit.file}{hit.line ? `:${hit.line}` : ""}</code>
                        <span class="palette__hit-preview">{hit.preview}</span>
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {matchingFiles.length > 0 && (
            <div class="palette__section">
              <div class="palette__section-title">
                <span>{t("palette.sectionFiles")}</span>
              </div>
              {matchingFiles.map((file, idx) => {
                const flatIndex = fileStart + idx;
                const entry = entries[flatIndex]!;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeIndex}
                    data-palette-index={flatIndex}
                    class={`palette__item ${flatIndex === activeIndex ? "active" : ""}`}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => executeEntry(entry)}
                  >
                    <span class={`format-icon format-icon--${file.format}`}>{FORMAT_SHORT_LABELS[file.format]}</span>
                    <span class="palette__item-body">
                      <strong>{file.path.split("/").at(-1)}</strong>
                      <span class="palette__item-sub"><code>{file.path}</code></span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {matchingCommands.length > 0 && (
            <div class="palette__section">
              <div class="palette__section-title">
                <span>{t("palette.sectionCommands")}</span>
              </div>
              {matchingCommands.map((command, idx) => {
                const flatIndex = cmdStart + idx;
                const entry = entries[flatIndex]!;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="option"
                    aria-selected={flatIndex === activeIndex}
                    data-palette-index={flatIndex}
                    class={`palette__item palette__item--cmd ${flatIndex === activeIndex ? "active" : ""}`}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => executeEntry(entry)}
                  >
                    <span class="palette__cmd-icon"><Icon name={command.icon} size={15}/></span>
                    <span class="palette__item-body">
                      <strong>{command.label}</strong>
                      {command.description && <span class="palette__item-sub"><span>{command.description}</span></span>}
                    </span>
                    {command.shortcut && <kbd class="palette__kbd">{command.shortcut}</kbd>}
                  </button>
                );
              })}
            </div>
          )}

          {!entries.length && !searching && (
            <div class="palette__empty">
              <Icon name="search"/>
              <span>{t("palette.empty")}</span>
            </div>
          )}
        </div>

        <footer class="palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("palette.hintNavigate")}</span>
          <span><kbd>Enter</kbd> {t("palette.hintSelect")}</span>
          <span><kbd>Esc</kbd> {t("palette.hintClose")}</span>
        </footer>
      </section>
    </div>
  );
}
