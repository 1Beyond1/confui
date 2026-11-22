import { useState } from "preact/hooks";
import type { ConfigFormSchema, FieldSpec, SavePreview } from "../../../shared/schema.ts";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { formatDisplayValue } from "../value-display.ts";
import { UnifiedDiffView } from "./UnifiedDiffView.tsx";

type DiffTab = "fields" | "unified";

export function SaveConfirmModal({
  savePreview,
  schema,
  allFields,
  saving,
  onClose,
  onConfirm,
}: {
  savePreview: SavePreview;
  schema?: ConfigFormSchema;
  allFields?: readonly FieldSpec[];
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [tab, setTab] = useState<DiffTab>("fields");
  const fields = allFields ?? schema?.fields ?? [];

  return (
    <Modal
      title="确认保存更改"
      description={`将更新 ${savePreview.file}，保存前会自动创建 .bak 备份。`}
      width="760px"
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

      <div class="save-diff-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "fields"}
          class={tab === "fields" ? "active" : ""}
          onClick={() => setTab("fields")}
        >
          <Icon name="layers" size={14}/>
          <span>逐字段差异 ({savePreview.changes.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "unified"}
          class={tab === "unified" ? "active" : ""}
          onClick={() => setTab("unified")}
        >
          <Icon name="code" size={14}/>
          <span>Unified Diff 源码</span>
        </button>
      </div>

      {tab === "fields" ? (
        <div class="diff-list">
          {savePreview.changes.map((change) => {
            const field = fields.find((item) => item.path === change.path);
            const secret = field?.secret || field?.type === "secret";
            const kind = change.before === undefined
              ? "added"
              : change.after === undefined
                ? "removed"
                : "modified";
            const kindLabel = kind === "added" ? "新增" : kind === "removed" ? "删除" : "修改";
            return (
              <div class="diff-item" key={change.path}>
                <div>
                  <div class="diff-item__head">
                    <span class={`diff-badge diff-badge--${kind}`}>{kindLabel}</span>
                    <strong>{field?.label || change.path}</strong>
                  </div>
                  <code>{change.path}</code>
                </div>
                <div class="diff-values">
                  <span>{secret && change.before !== undefined ? "••••••••" : formatDisplayValue(change.before)}</span>
                  <Icon name="arrow-left" class="diff-arrow"/>
                  <strong>{secret && change.after !== undefined ? "••••••••" : formatDisplayValue(change.after)}</strong>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <UnifiedDiffView
          oldText={schema?.rawText ?? ""}
          newText={savePreview.output}
          fileName={savePreview.file}
        />
      )}
    </Modal>
  );
}
