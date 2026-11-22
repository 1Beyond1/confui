import type { RestoreBackupPreview } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { UnifiedDiffView } from "./UnifiedDiffView.tsx";

export function RestoreBackupModal({
  preview,
  restoring,
  onClose,
  onConfirm,
}: {
  preview: RestoreBackupPreview;
  restoring: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { locale, t } = useI18n();
  const backupTime = new Date(preview.backupModifiedAt).toLocaleString(locale);
  const identical = preview.currentText === preview.backupText;

  return (
    <Modal
      title={t("restoreModal.title")}
      description={t("restoreModal.desc", { file: preview.file, time: backupTime })}
      width="760px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={restoring}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            icon="history"
            busy={restoring}
            disabled={restoring || identical}
            onClick={onConfirm}
          >
            {t("restoreModal.confirm")}
          </Button>
        </>
      )}
    >
      {identical ? (
        <div class="modal-warning">
          <Icon name="info"/>
          <span>{t("restoreModal.identical")}</span>
        </div>
      ) : (
        <UnifiedDiffView
          oldText={preview.currentText}
          newText={preview.backupText}
          fileName={`${preview.file} ← ${preview.file}.bak`}
        />
      )}
    </Modal>
  );
}
