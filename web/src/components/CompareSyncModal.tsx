import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  CompareConfigOptions,
  CompareEntryStatus,
  ConfigCompareResult,
  ConfigEnvGroup,
  ConfigFile,
  PathSegment,
  SavePreview,
} from "../../../shared/schema.ts";
import { SECRET_KEY_PATTERN, valueContainsSecret } from "../../../shared/validation.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { errorMessage } from "../utils/format.ts";
import { formatDisplayValue } from "../value-display.ts";

type CompareFilter = "actionable" | "missing" | "different" | "all";

export function CompareSyncModal({
  projectRoot,
  openableFiles,
  envGroups,
  activeFilePath,
  activeDocumentIndex,
  activeFileDirty = false,
  onClose,
  onPreviewReady,
}: {
  projectRoot: string;
  openableFiles: readonly ConfigFile[];
  envGroups: readonly ConfigEnvGroup[];
  activeFilePath?: string;
  activeDocumentIndex?: number;
  activeFileDirty?: boolean;
  onClose: () => void;
  onPreviewReady: (preview: SavePreview) => void;
}) {
  const { locale, t } = useI18n();
  const initialPair = useMemo(
    () => pickInitialPair(openableFiles, envGroups, activeFilePath),
    [openableFiles, envGroups, activeFilePath],
  );
  const [sourceFile, setSourceFile] = useState(initialPair.source);
  const [targetFile, setTargetFile] = useState(initialPair.target);
  const [sourceDocIndex, setSourceDocIndex] = useState<number>(
    initialPair.source === activeFilePath ? (activeDocumentIndex ?? 0) : 0,
  );
  const [targetDocIndex, setTargetDocIndex] = useState<number>(
    initialPair.target === activeFilePath ? (activeDocumentIndex ?? 0) : 0,
  );
  const [filter, setFilter] = useState<CompareFilter>("actionable");
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [result, setResult] = useState<ConfigCompareResult>();
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const mountedRef = useRef(true);
  const syncSeqRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      syncSeqRef.current += 1;
    };
  }, []);

  const sourceIsYaml = useMemo(
    () => openableFiles.find((file) => file.path === sourceFile)?.format === "yaml",
    [openableFiles, sourceFile],
  );
  const targetIsYaml = useMemo(
    () => openableFiles.find((file) => file.path === targetFile)?.format === "yaml",
    [openableFiles, targetFile],
  );

  function buildCompareOptions(): CompareConfigOptions | undefined {
    if (!sourceIsYaml && !targetIsYaml) return undefined;
    return {
      ...(sourceIsYaml ? { sourceDocumentIndex: sourceDocIndex } : {}),
      ...(targetIsYaml ? { targetDocumentIndex: targetDocIndex } : {}),
    };
  }

  useEffect(() => {
    if (!sourceFile || !targetFile || sourceFile === targetFile) {
      setResult(undefined);
      setError(undefined);
      setSelected(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    setRevealSecrets(false);
    const compareOptions = buildCompareOptions();
    void window.confui.compareConfigs(projectRoot, sourceFile, targetFile, compareOptions).then((response) => {
      if (cancelled) return;
      setLoading(false);
      if (!response.ok) {
        setResult(undefined);
        setError(response.error.detail || response.error.message);
        return;
      }
      setResult(response.data);
      // Pre-select missing keys by default so one-click fill works immediately.
      const defaultSelected = new Set(
        response.data.entries
          .filter((entry) => entry.status === "missing-in-target")
          .map((entry) => JSON.stringify(entry.segments)),
      );
      setSelected(defaultSelected);
    });
    return () => { cancelled = true; };
  }, [projectRoot, sourceFile, targetFile, sourceDocIndex, targetDocIndex, sourceIsYaml, targetIsYaml]);

  const visibleEntries = useMemo(() => {
    if (!result) return [];
    return result.entries.filter((entry) => {
      if (filter === "all") return true;
      if (filter === "missing") return entry.status === "missing-in-target";
      if (filter === "different") return entry.status === "different";
      return entry.status === "missing-in-target" || entry.status === "different";
    });
  }, [result, filter]);

  const syncableEntries = useMemo(
    () => (result?.entries ?? []).filter((entry) => entry.status === "missing-in-target" || entry.status === "different"),
    [result],
  );

  function toggleEntry(segments: PathSegment[]): void {
    const key = JSON.stringify(segments);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectMissingOnly(): void {
    if (!result) return;
    setSelected(new Set(
      result.entries
        .filter((entry) => entry.status === "missing-in-target")
        .map((entry) => JSON.stringify(entry.segments)),
    ));
  }

  function selectAllSyncable(): void {
    setSelected(new Set(syncableEntries.map((entry) => JSON.stringify(entry.segments))));
  }

  function swapPair(): void {
    setSourceFile(targetFile);
    setTargetFile(sourceFile);
    setSourceDocIndex(targetDocIndex);
    setTargetDocIndex(sourceDocIndex);
  }

  function selectSourceFile(nextFile: string): void {
    setSourceFile(nextFile);
    setSourceDocIndex(nextFile === activeFilePath ? (activeDocumentIndex ?? 0) : 0);
  }

  function selectTargetFile(nextFile: string): void {
    setTargetFile(nextFile);
    setTargetDocIndex(nextFile === activeFilePath ? (activeDocumentIndex ?? 0) : 0);
  }

  const isTargetActiveDirty = Boolean(activeFileDirty && activeFilePath && targetFile === activeFilePath);
  const isSourceActiveDirty = Boolean(
    activeFileDirty && activeFilePath && sourceFile === activeFilePath && !isTargetActiveDirty,
  );

  async function handlePreviewSync(): Promise<void> {
    if (!result || selected.size === 0 || syncing || isTargetActiveDirty) return;
    const segmentsList = syncableEntries
      .filter((entry) => selected.has(JSON.stringify(entry.segments)))
      .map((entry) => entry.segments);
    if (!segmentsList.length) return;
    const seq = ++syncSeqRef.current;
    setSyncing(true);
    setError(undefined);
    try {
      const syncOptions: CompareConfigOptions | undefined =
        result.sourceDocumentIndex !== undefined || result.targetDocumentIndex !== undefined
          ? {
            ...(result.sourceDocumentIndex !== undefined ? { sourceDocumentIndex: result.sourceDocumentIndex } : {}),
            ...(result.targetDocumentIndex !== undefined ? { targetDocumentIndex: result.targetDocumentIndex } : {}),
          }
          : buildCompareOptions();
      const response = await window.confui.previewSyncConfig(
        projectRoot,
        result.sourceFile,
        result.targetFile,
        segmentsList,
        result.targetVersion,
        syncOptions,
      );
      if (!mountedRef.current || seq !== syncSeqRef.current) return;
      if (!response.ok) throw new Error(response.error.detail || response.error.message);
      onPreviewReady(response.data);
    } catch (err) {
      if (!mountedRef.current || seq !== syncSeqRef.current) return;
      setError(errorMessage(err, t("common.actionFailed")));
    } finally {
      if (mountedRef.current && seq === syncSeqRef.current) {
        setSyncing(false);
      }
    }
  }

  function statusLabel(status: CompareEntryStatus): string {
    switch (status) {
      case "missing-in-target": return t("compare.statusMissing");
      case "different": return t("compare.statusDifferent");
      case "only-in-target": return t("compare.statusOnlyTarget");
      case "same": return t("compare.statusSame");
    }
  }

  return (
    <Modal
      title={t("compare.title")}
      description={t("compare.desc")}
      width="860px"
      closeDisabled={syncing}
      onClose={() => { if (!syncing) onClose(); }}
      footer={(
        <>
          <Button onClick={() => { if (!syncing) onClose(); }} disabled={syncing}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            icon="compare"
            busy={syncing}
            disabled={syncing || loading || !result || selected.size === 0 || isTargetActiveDirty}
            onClick={() => void handlePreviewSync()}
          >
            {t("compare.applySelected", { count: selected.size })}
          </Button>
        </>
      )}
    >
      {envGroups.length > 0 && (
        <div class="compare-groups">
          <span class="compare-groups__label">{t("compare.envGroupsLabel")}</span>
          <div class="compare-groups__pills">
            {envGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                disabled={syncing}
                class={`compare-group-pill ${group.files.includes(sourceFile) && group.files.includes(targetFile) ? "active" : ""}`}
                onClick={() => {
                  const first = group.files[0];
                  const second = group.files[1];
                  if (first && second) {
                    selectSourceFile(first);
                    selectTargetFile(second);
                  }
                }}
              >
                <span>{group.label}</span>
                <small>{group.files.length}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      <div class="compare-selectors">
        <div class="setting-field">
          <label for="compare-source">{t("compare.sourceLabel")}</label>
          <div class="select-wrap">
            <select
              id="compare-source"
              class="control"
              value={sourceFile}
              disabled={syncing}
              onChange={(event) => selectSourceFile(event.currentTarget.value)}
            >
              {openableFiles.map((file) => (
                <option key={file.path} value={file.path}>{file.path}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={16}/>
          </div>
          {result?.sourceFile === sourceFile && result.sourceYamlDocuments && result.sourceYamlDocuments.length > 1 && (
            <div class="select-wrap" style={{ marginTop: "6px" }}>
              <select
                aria-label={t("compare.sourceDocLabel")}
                class="control"
                value={String(sourceDocIndex)}
                disabled={syncing}
                onChange={(event) => setSourceDocIndex(Number(event.currentTarget.value) || 0)}
              >
                {result.sourceYamlDocuments.map((doc) => (
                  <option key={doc.index} value={String(doc.index)}>
                    #{doc.index + 1} · {doc.label || t("editor.yamlDocFallback", { index: doc.index + 1 })}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={16}/>
            </div>
          )}
        </div>
        <button
          type="button"
          class="icon-button compare-swap-btn"
          disabled={syncing}
          onClick={swapPair}
          title={t("compare.swap")}
          aria-label={t("compare.swap")}
        >
          <Icon name="swap" size={16}/>
        </button>
        <div class="setting-field">
          <label for="compare-target">{t("compare.targetLabel")}</label>
          <div class="select-wrap">
            <select
              id="compare-target"
              class="control"
              value={targetFile}
              disabled={syncing}
              onChange={(event) => selectTargetFile(event.currentTarget.value)}
            >
              {openableFiles.map((file) => (
                <option key={file.path} value={file.path}>{file.path}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={16}/>
          </div>
          {result?.targetFile === targetFile && result.targetYamlDocuments && result.targetYamlDocuments.length > 1 && (
            <div class="select-wrap" style={{ marginTop: "6px" }}>
              <select
                aria-label={t("compare.targetDocLabel")}
                class="control"
                value={String(targetDocIndex)}
                disabled={syncing}
                onChange={(event) => setTargetDocIndex(Number(event.currentTarget.value) || 0)}
              >
                {result.targetYamlDocuments.map((doc) => (
                  <option key={doc.index} value={String(doc.index)}>
                    #{doc.index + 1} · {doc.label || t("editor.yamlDocFallback", { index: doc.index + 1 })}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" size={16}/>
            </div>
          )}
        </div>
      </div>

      {sourceFile === targetFile && (
        <div class="modal-warning">
          <Icon name="info"/>
          <span>{t("compare.sameFileHint")}</span>
        </div>
      )}

      {isTargetActiveDirty && (
        <div class="modal-warning compare-error" role="alert">
          <Icon name="warning"/>
          <span>{t("compare.targetDirtyBlocked", { file: targetFile })}</span>
        </div>
      )}

      {isSourceActiveDirty && (
        <div class="modal-warning" role="status">
          <Icon name="info"/>
          <span>{t("compare.sourceDirtyHint", { file: sourceFile })}</span>
        </div>
      )}

      {error && (
        <div class="modal-warning compare-error" role="alert">
          <Icon name="warning"/>
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div class="compare-loading">
          <Icon name="loader" class="spin"/>
          <span>{t("compare.loading")}</span>
        </div>
      )}

      {result && !loading && (
        <>
          <div class="compare-toolbar">
            <div class="compare-filters" role="tablist">
              <button
                type="button"
                class={filter === "actionable" ? "active" : ""}
                onClick={() => setFilter("actionable")}
              >
                {t("compare.filterActionable", { count: result.summary.missingInTarget + result.summary.different })}
              </button>
              <button
                type="button"
                class={filter === "missing" ? "active" : ""}
                onClick={() => setFilter("missing")}
              >
                {t("compare.filterMissing", { count: result.summary.missingInTarget })}
              </button>
              <button
                type="button"
                class={filter === "different" ? "active" : ""}
                onClick={() => setFilter("different")}
              >
                {t("compare.filterDifferent", { count: result.summary.different })}
              </button>
              <button
                type="button"
                class={filter === "all" ? "active" : ""}
                onClick={() => setFilter("all")}
              >
                {t("compare.filterAll", { count: result.entries.length })}
              </button>
            </div>
            <div class="compare-toolbar__actions">
              <button type="button" class="field-action-btn" onClick={selectMissingOnly} disabled={result.summary.missingInTarget === 0}>
                {t("compare.selectMissing")}
              </button>
              <button type="button" class="field-action-btn" onClick={selectAllSyncable} disabled={syncableEntries.length === 0}>
                {t("compare.selectAllDiff")}
              </button>
              <button type="button" class="field-action-btn" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                {t("common.clear")}
              </button>
              <button
                type="button"
                class="save-diff-secret-btn"
                aria-pressed={revealSecrets}
                onClick={() => setRevealSecrets((current) => !current)}
              >
                <Icon name={revealSecrets ? "eye-off" : "eye"} size={13}/>
                <span>{revealSecrets ? t("diff.hideSecrets") : t("diff.showSecrets")}</span>
              </button>
            </div>
          </div>

          {visibleEntries.length === 0 ? (
            <div class="udiff-empty">{t("compare.noEntries")}</div>
          ) : (
            <div class="compare-list">
              {visibleEntries.map((entry) => {
                const key = JSON.stringify(entry.segments);
                const syncable = entry.status === "missing-in-target" || entry.status === "different";
                const checked = selected.has(key);
                const isSecret = Boolean(
                  entry.secret
                  || SECRET_KEY_PATTERN.test(entry.path)
                  || valueContainsSecret(entry.sourceValue)
                  || valueContainsSecret(entry.targetValue),
                );
                const maskVal = isSecret && !revealSecrets;
                const sourceText = !entry.hasSource
                  ? t("common.unset")
                  : maskVal
                    ? "••••••••"
                    : formatDisplayValue(entry.sourceValue, locale);
                const targetText = !entry.hasTarget
                  ? t("common.unset")
                  : maskVal
                    ? "••••••••"
                    : formatDisplayValue(entry.targetValue, locale);
                return (
                  <label class={`compare-row ${syncable ? "compare-row--syncable" : ""}`} key={key}>
                    <span class="compare-row__check">
                      {syncable ? (
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleEntry(entry.segments)}
                        />
                      ) : (
                        <span class="compare-row__spacer"/>
                      )}
                    </span>
                    <div class="compare-row__key">
                      <div class="diff-item__head">
                        <span class={`diff-badge compare-badge--${entry.status}`}>{statusLabel(entry.status)}</span>
                        {isSecret && (
                          <span class="compare-secret-tag" title={t("diff.secretsMaskedHint")}>
                            <Icon name="shield" size={11}/>
                          </span>
                        )}
                      </div>
                      <code title={entry.path}>{entry.path}</code>
                    </div>
                    <div class="compare-row__values">
                      <span class="compare-val compare-val--source" title={maskVal ? undefined : sourceText}>{sourceText}</span>
                      <Icon name="arrow-right" size={14} class="compare-arrow"/>
                      <span class="compare-val compare-val--target" title={maskVal ? undefined : targetText}>{targetText}</span>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function pickInitialPair(
  openableFiles: readonly ConfigFile[],
  envGroups: readonly ConfigEnvGroup[],
  activeFilePath?: string,
): { source: string; target: string } {
  const target = activeFilePath && openableFiles.some((f) => f.path === activeFilePath)
    ? activeFilePath
    : openableFiles[0]?.path ?? "";

  if (target) {
    const group = envGroups.find((item) => item.files.includes(target));
    if (group) {
      const sibling = group.files.find((path) => path !== target);
      if (sibling) return { source: sibling, target };
    }
  }
  const fallbackSource = openableFiles.find((file) => file.path !== target)?.path ?? target;
  return { source: fallbackSource, target };
}
