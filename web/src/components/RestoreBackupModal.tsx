import { useEffect, useMemo, useState } from "preact/hooks";
import { collectSecretsFromFields } from "../../../shared/diff.ts";
import type { FieldSpec, RestoreBackupPreview } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { UnifiedDiffView } from "./UnifiedDiffView.tsx";

export function RestoreBackupModal({
  preview,
  fields,
  restoring,
  onClose,
  onConfirm,
}: {
  preview: RestoreBackupPreview;
  fields?: readonly FieldSpec[];
  restoring: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { locale, t } = useI18n();
  const [revealSecrets, setRevealSecrets] = useState(false);
  useEffect(() => {
    setRevealSecrets(false);
  }, [preview]);
  const { secretKeys, secretValues } = useMemo(
    () => collectSecretsFromFields(fields ?? []),
    [fields],
  );
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
          format={preview.format}
          maskSecrets={!revealSecrets}
          secretKeys={secretKeys}
          secretValues={secretValues}
          onToggleRevealSecrets={() => setRevealSecrets((current) => !current)}
        />
      )}
    </Modal>
  );
}
