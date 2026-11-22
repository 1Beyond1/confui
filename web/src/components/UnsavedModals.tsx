import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";

export function UnsavedConfigModal({
  kind,
  changeCount,
  onCancel,
  onDiscard,
  onSaveAndContinue,
}: {
  kind?: string;
  changeCount: number;
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndContinue: () => void;
}) {
  return (
    <Modal
      title="还有未保存的更改"
      description="离开当前文件前，选择如何处理这些更改。"
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>继续编辑</Button>
          <Button variant="danger" onClick={onDiscard}>放弃更改</Button>
          <Button variant="primary" icon="save" onClick={onSaveAndContinue}>保存后继续</Button>
        </>
      )}
    >
      <div class="unsaved-summary">
        <span><Icon name="file"/></span>
        <div>
          <strong>{kind}</strong>
          <p>{changeCount} 项更改尚未写入文件</p>
        </div>
      </div>
    </Modal>
  );
}

export function UnsavedSettingsModal({
  onCancel,
  onDiscard,
}: {
  onCancel: () => void;
  onDiscard: () => void;
}) {
  return (
    <Modal
      title="设置尚未保存"
      description="离开设置页会丢弃刚才的修改。"
      onClose={onCancel}
      footer={(
        <>
          <Button onClick={onCancel}>返回设置</Button>
          <Button variant="danger" onClick={onDiscard}>放弃并继续</Button>
        </>
      )}
    >
      <div class="unsaved-summary">
        <span><Icon name="settings"/></span>
        <div>
          <strong>Confui 设置</strong>
          <p>供应商、安全或外观选项已发生变化</p>
        </div>
      </div>
    </Modal>
  );
}
