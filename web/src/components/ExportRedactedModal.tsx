import { useEffect, useState } from "preact/hooks";
import type { PathSegment, RedactedExportPreview } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { errorMessage } from "../utils/format.ts";

export function ExportRedactedModal({
  projectRoot,
  file,
  secretPaths,
  onClose,
  onToast,
}: {
  projectRoot: string;
  file: string;
  secretPaths: PathSegment[][];
  onClose: () => void;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
}) {
  const { t } = useI18n();
  const [preview, setPreview] = useState<RedactedExportPreview>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void window.confui.previewRedactedExport(projectRoot, file, secretPaths).then((response) => {
      if (cancelled) return;
      setLoading(false);
      if (!response.ok) {
        setError(response.error.detail || response.error.message);
        return;
      }
      setPreview(response.data);
    });
    return () => { cancelled = true; };
  }, [projectRoot, file, secretPaths]);

  async function handleCopy(): Promise<void> {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.content);
      setCopied(true);
      onToast(t("exportModal.copiedToast"), "success");
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      onToast(t("exportModal.copyFailed"), "error");
    }
  }

  async function handleSaveFile(): Promise<void> {
    if (!preview || saving) return;
    setSaving(true);
    try {
      const result = await window.confui.saveRedactedExport(projectRoot, file, secretPaths);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (result.data.savedPath) {
        const savedName = result.data.savedPath.split(/[\\/]/).at(-1) ?? preview.suggestedFileName;
        onToast(t("exportModal.savedToast", { file: savedName }), "success");
        onClose();
      }
    } catch (err) {
      onToast(errorMessage(err, t("common.actionFailed")), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={t("exportModal.title")}
      description={t("exportModal.desc", { file })}
      width="760px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>{t("common.close")}</Button>
          <Button
            icon={copied ? "check" : "copy"}
            disabled={loading || !preview || saving}
            onClick={() => void handleCopy()}
          >
            {copied ? t("exportModal.copied") : t("exportModal.copy")}
          </Button>
          <Button
            variant="primary"
            icon="download"
            busy={saving}
            disabled={loading || !preview || saving}
            onClick={() => void handleSaveFile()}
          >
            {t("exportModal.saveAs")}
          </Button>
        </>
      )}
    >
      {error && (
        <div class="modal-warning compare-error" role="alert">
          <Icon name="warning"/>
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div class="compare-loading">
          <Icon name="loader" class="spin"/>
          <span>{t("exportModal.loading")}</span>
        </div>
      )}

      {preview && !loading && (
        <div class="export-preview">
          <div class="export-preview__meta">
            <span class="local-pill">
              <Icon name="shield" size={13}/>
              <span>{t("exportModal.redactedCount", { count: preview.redactedCount })}</span>
            </span>
            <code>{preview.suggestedFileName}</code>
          </div>
          <pre class="export-preview__code" aria-label={preview.suggestedFileName}>{preview.content}</pre>
        </div>
      )}
    </Modal>
  );
}
