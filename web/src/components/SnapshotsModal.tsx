import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { buildYamlDocumentLineSecrets, collectSecretsFromFields } from "../../../shared/diff.ts";
import type {
  ConfigFormat,
  DocumentSecretMeta,
  FieldSpec,
  FileVersion,
  SnapshotRestorePreview,
  SnapshotSummary,
} from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { errorMessage, formatBytes } from "../utils/format.ts";
import { UnifiedDiffView } from "./UnifiedDiffView.tsx";

export function SnapshotsModal({
  projectRoot,
  file,
  format,
  currentVersion,
  fields,
  documentSecrets,
  activeDocumentIndex,
  activeFileDirty,
  onClose,
  onRestored,
  onToast,
}: {
  projectRoot: string;
  file: string;
  format: ConfigFormat;
  currentVersion: FileVersion;
  fields?: readonly FieldSpec[];
  documentSecrets?: readonly DocumentSecretMeta[];
  activeDocumentIndex?: number;
  activeFileDirty: boolean;
  onClose: () => void;
  onRestored: (restoredFile: string, backupPath: string) => void;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
}) {
  const { locale, t } = useI18n();
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [labelInput, setLabelInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [restorePreview, setRestorePreview] = useState<SnapshotRestorePreview>();
  const [restoring, setRestoring] = useState(false);
  const [deletingId, setDeletingId] = useState<string>();
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [error, setError] = useState<string>();

  const mountedRef = useRef(true);
  const loadingListRef = useRef(true);
  const listSeqRef = useRef(0);
  const previewSeqRef = useRef(0);

  const busy = creating || restoring || deletingId !== undefined;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listSeqRef.current += 1;
      previewSeqRef.current += 1;
    };
  }, []);

  async function refreshList(preferredId?: string): Promise<void> {
    const seq = ++listSeqRef.current;
    loadingListRef.current = true;
    setLoadingList(true);
    setError(undefined);
    try {
      const response = await window.confui.listSnapshots(projectRoot, file);
      if (!mountedRef.current || seq !== listSeqRef.current) return;
      if (!response.ok) {
        setError(response.error.detail || response.error.message);
        return;
      }
      setSnapshots(response.data);
      setSelectedId((prev) => {
        if (preferredId && response.data.some((item) => item.id === preferredId)) return preferredId;
        if (prev && response.data.some((item) => item.id === prev)) return prev;
        return response.data[0]?.id;
      });
    } catch (err) {
      if (!mountedRef.current || seq !== listSeqRef.current) return;
      setError(errorMessage(err, t("common.actionFailed")));
    } finally {
      if (mountedRef.current && seq === listSeqRef.current) {
        loadingListRef.current = false;
        setLoadingList(false);
      }
    }
  }

  useEffect(() => {
    setSelectedId(undefined);
    setRestorePreview(undefined);
    setRevealSecrets(false);
    void refreshList();
  }, [projectRoot, file]);

  useEffect(() => {
    if (!selectedId) {
      setRestorePreview(undefined);
      setLoadingPreview(false);
      return;
    }
    const seq = ++previewSeqRef.current;
    setLoadingPreview(true);
    setRevealSecrets(false);
    setError(undefined);
    void window.confui.previewSnapshotRestore(projectRoot, file, selectedId, currentVersion).then((response) => {
      if (!mountedRef.current || seq !== previewSeqRef.current) return;
      setLoadingPreview(false);
      if (!response.ok) {
        setRestorePreview(undefined);
        setError(response.error.detail || response.error.message);
        return;
      }
      setRestorePreview(response.data);
    }).catch((err) => {
      if (!mountedRef.current || seq !== previewSeqRef.current) return;
      setLoadingPreview(false);
      setRestorePreview(undefined);
      setError(errorMessage(err, t("common.actionFailed")));
    });
  }, [projectRoot, file, selectedId, currentVersion]);

  const { secretKeys, secretValues } = useMemo(
    () => collectSecretsFromFields(fields ?? []),
    [fields],
  );

  const { oldDocumentSecrets, newDocumentSecrets } = useMemo(() => {
    if (!restorePreview || format !== "yaml" || !documentSecrets || documentSecrets.length <= 1) {
      return { oldDocumentSecrets: undefined, newDocumentSecrets: undefined };
    }
    const extraByDocument = new Map<number, { secretKeys: string[]; secretValues: string[] }>([
      [activeDocumentIndex ?? 0, { secretKeys, secretValues }],
    ]);
    return {
      oldDocumentSecrets: buildYamlDocumentLineSecrets(restorePreview.currentText, documentSecrets, extraByDocument),
      newDocumentSecrets: buildYamlDocumentLineSecrets(restorePreview.snapshotText, documentSecrets, extraByDocument),
    };
  }, [restorePreview, format, documentSecrets, activeDocumentIndex, secretKeys, secretValues]);

  async function handleCreateSnapshot(event?: Event): Promise<void> {
    event?.preventDefault();
    const trimmed = labelInput.trim();
    if (!trimmed || busy) return;
    setCreating(true);
    setError(undefined);
    try {
      const response = await window.confui.saveSnapshot(projectRoot, file, trimmed);
      if (!mountedRef.current) return;
      if (!response.ok) throw new Error(response.error.detail || response.error.message);
      setLabelInput("");
      onToast(t("snapshots.createdToast", { label: response.data.label }), "success");
      // Invalidate any stale initial refreshList() so it cannot clobber the newly saved snapshot.
      const listWasInFlight = loadingListRef.current;
      listSeqRef.current += 1;
      setSnapshots((prev) => [response.data, ...prev.filter((item) => item.id !== response.data.id)]);
      setSelectedId(response.data.id);
      if (listWasInFlight) {
        void refreshList(response.data.id);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err, t("common.actionFailed")));
    } finally {
      if (mountedRef.current) setCreating(false);
    }
  }

  async function handleDeleteSnapshot(item: SnapshotSummary): Promise<void> {
    if (busy) return;
    setDeletingId(item.id);
    setError(undefined);
    try {
      const response = await window.confui.deleteSnapshot(projectRoot, item.id);
      if (!mountedRef.current) return;
      if (!response.ok) throw new Error(response.error.detail || response.error.message);
      const listWasInFlight = loadingListRef.current;
      listSeqRef.current += 1;
      setSnapshots((prev) => {
        const next = prev.filter((snap) => snap.id !== item.id);
        setSelectedId((current) => (current === item.id ? next[0]?.id : current));
        return next;
      });
      if (listWasInFlight) {
        void refreshList();
      }
      onToast(t("snapshots.deletedToast", { label: item.label }), "info");
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err, t("common.actionFailed")));
    } finally {
      if (mountedRef.current) setDeletingId(undefined);
    }
  }

  async function handleConfirmRestore(): Promise<void> {
    if (!restorePreview || busy || activeFileDirty) return;
    if (restorePreview.currentText === restorePreview.snapshotText) return;
    setRestoring(true);
    setError(undefined);
    try {
      const response = await window.confui.saveConfig(projectRoot, restorePreview.savePreview);
      if (!mountedRef.current) return;
      if (!response.ok) throw new Error(response.error.detail || response.error.message);
      onRestored(restorePreview.file, response.data.backupPath);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(errorMessage(err, t("common.actionFailed")));
    } finally {
      if (mountedRef.current) setRestoring(false);
    }
  }

  const identical = Boolean(restorePreview && restorePreview.currentText === restorePreview.snapshotText);

  return (
    <Modal
      title={t("snapshots.title")}
      description={t("snapshots.desc", { file })}
      width="880px"
      closeDisabled={busy}
      onClose={() => { if (!busy) onClose(); }}
      footer={(
        <>
          <Button onClick={() => { if (!busy) onClose(); }} disabled={busy}>
            {t("common.close")}
          </Button>
          <Button
            variant="primary"
            icon="history"
            busy={restoring}
            disabled={busy || loadingPreview || !restorePreview || identical || activeFileDirty}
            onClick={() => void handleConfirmRestore()}
          >
            {t("snapshots.restoreAction")}
          </Button>
        </>
      )}
    >
      <form class="snapshot-create-bar" onSubmit={(event) => void handleCreateSnapshot(event)}>
        <input
          class="control"
          value={labelInput}
          maxlength={120}
          disabled={busy}
          placeholder={t("snapshots.labelPlaceholder")}
          aria-label={t("snapshots.labelAria")}
          onInput={(event) => setLabelInput(event.currentTarget.value)}
        />
        <Button
          type="submit"
          variant="primary"
          icon="plus"
          busy={creating}
          disabled={busy || !labelInput.trim()}
        >
          {t("snapshots.createButton")}
        </Button>
      </form>

      <div class="snapshot-storage-note">
        <Icon name="shield" size={13}/>
        <span>{t("snapshots.storageNote")}</span>
      </div>

      {activeFileDirty && (
        <div class="modal-warning" role="status">
          <Icon name="info"/>
          <span>{t("snapshots.dirtyHint")}</span>
        </div>
      )}

      {error && (
        <div class="modal-warning compare-error" role="alert">
          <Icon name="warning"/>
          <span>{error}</span>
        </div>
      )}

      {loadingList ? (
        <div class="compare-loading">
          <Icon name="loader" class="spin"/>
          <span>{t("snapshots.loadingList")}</span>
        </div>
      ) : snapshots.length === 0 ? (
        <div class="diag-empty">
          <span class="diag-empty__icon"><Icon name="archive" size={20}/></span>
          <strong>{t("snapshots.emptyTitle")}</strong>
          <p>{t("snapshots.emptyDesc")}</p>
        </div>
      ) : (
        <div class="snapshot-layout">
          <div class="snapshot-list" role="listbox" aria-label={t("snapshots.listAria")}>
            {snapshots.map((item) => {
              const selected = item.id === selectedId;
              const isDeleting = deletingId === item.id;
              return (
                <div
                  key={item.id}
                  class={`snapshot-item ${selected ? "active" : ""}`}
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    disabled={busy}
                    class="snapshot-item__main"
                    onClick={() => setSelectedId(item.id)}
                  >
                    <div class="snapshot-item__head">
                      <strong>{item.label}</strong>
                      {item.encrypted && (
                        <span class="snapshot-enc-tag" title={t("snapshots.encryptedTooltip")}>
                          <Icon name="shield" size={11}/>
                        </span>
                      )}
                    </div>
                    <div class="snapshot-item__meta">
                      <span>{new Date(item.createdAt).toLocaleString(locale)}</span>
                      <span>·</span>
                      <span>{formatBytes(item.size)}</span>
                      <span>·</span>
                      <code>{item.sha256.slice(0, 8)}</code>
                    </div>
                  </button>
                  <button
                    type="button"
                    class="icon-button snapshot-item__delete"
                    disabled={busy}
                    title={t("snapshots.deleteTooltip")}
                    aria-label={t("snapshots.deleteAria", { label: item.label })}
                    onClick={() => void handleDeleteSnapshot(item)}
                  >
                    <Icon name={isDeleting ? "loader" : "trash"} size={14} class={isDeleting ? "spin" : undefined}/>
                  </button>
                </div>
              );
            })}
          </div>

          <div class="snapshot-preview-pane">
            {loadingPreview ? (
              <div class="compare-loading">
                <Icon name="loader" class="spin"/>
                <span>{t("snapshots.loadingPreview")}</span>
              </div>
            ) : restorePreview ? (
              identical ? (
                <div class="modal-warning">
                  <Icon name="info"/>
                  <span>{t("snapshots.identicalHint")}</span>
                </div>
              ) : (
                <UnifiedDiffView
                  oldText={restorePreview.currentText}
                  newText={restorePreview.snapshotText}
                  fileName={`${restorePreview.file} ← ${restorePreview.snapshotLabel}`}
                  format={restorePreview.format}
                  maskSecrets={!revealSecrets}
                  secretKeys={secretKeys}
                  secretValues={secretValues}
                  oldDocumentSecrets={oldDocumentSecrets}
                  newDocumentSecrets={newDocumentSecrets}
                  onToggleRevealSecrets={() => setRevealSecrets((current) => !current)}
                />
              )
            ) : (
              <div class="udiff-empty">{t("snapshots.selectHint")}</div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
