import type { RestoreBackupPreview } from "../../../shared/schema.ts";
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
  const backupTime = new Date(preview.backupModifiedAt).toLocaleString();
  const identical = preview.currentText === preview.backupText;

  return (
    <Modal
      title="从 .bak 备份恢复"
      description={`将用 ${preview.file}.bak（备份于 ${backupTime}）原子替换当前文件，并把当前内容暂存为新的 .bak。`}
      width="760px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={restoring}>取消</Button>
          <Button
            variant="primary"
            icon="history"
            busy={restoring}
            disabled={restoring || identical}
            onClick={onConfirm}
          >
            确认恢复备份
          </Button>
        </>
      )}
    >
      {identical ? (
        <div class="modal-warning">
          <Icon name="info"/>
          <span>当前文件内容与 .bak 备份完全一致，无需恢复。</span>
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
