import type { ConfigFormSchema, SavePreview } from "../../../shared/schema.ts";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { formatDisplayValue } from "../value-display.ts";

export function SaveConfirmModal({
  savePreview,
  schema,
  saving,
  onClose,
  onConfirm,
}: {
  savePreview: SavePreview;
  schema?: ConfigFormSchema;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="确认保存更改"
      description={`将更新 ${savePreview.file}，保存前会自动创建 .bak 备份。`}
      width="680px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>返回编辑</Button>
          <Button variant="primary" icon="save" busy={saving} disabled={saving} onClick={onConfirm}>
            确认保存 {savePreview.changes.length} 项
          </Button>
        </>
      )}
    >
      {savePreview.warnings.map((warning) => (
        <div class="modal-warning" key={warning}>
          <Icon name="warning"/>
          <span>{warning}</span>
        </div>
      ))}
      <div class="diff-list">
        {savePreview.changes.map((change) => {
          const field = schema?.fields.find((item) => item.path === change.path);
          const secret = field?.secret || field?.type === "secret";
          return (
            <div class="diff-item" key={change.path}>
              <div>
                <strong>{field?.label || change.path}</strong>
                <code>{change.path}</code>
              </div>
              <div class="diff-values">
                <span>{secret ? "••••••••" : formatDisplayValue(change.before)}</span>
                <Icon name="arrow-left" class="diff-arrow"/>
                <strong>{secret ? "••••••••" : formatDisplayValue(change.after)}</strong>
              </div>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
