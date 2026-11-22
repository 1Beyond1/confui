import { useState } from "preact/hooks";
import type { ConfigFormSchema, FieldSpec, SavePreview } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
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
  const { locale, t } = useI18n();
  const [tab, setTab] = useState<DiffTab>("fields");
  const fields = allFields ?? schema?.fields ?? [];

  return (
    <Modal
      title={t("saveModal.title")}
      description={t("saveModal.desc", { file: savePreview.file })}
      width="760px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose} disabled={saving}>{t("saveModal.back")}</Button>
          <Button variant="primary" icon="save" busy={saving} disabled={saving} onClick={onConfirm}>
            {t("saveModal.confirm", { count: savePreview.changes.length })}
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
          <span>{t("saveModal.tabFields", { count: savePreview.changes.length })}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "unified"}
          class={tab === "unified" ? "active" : ""}
          onClick={() => setTab("unified")}
        >
          <Icon name="code" size={14}/>
          <span>{t("saveModal.tabUnified")}</span>
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
            const kindLabel = kind === "added"
              ? t("saveModal.badgeAdded")
              : kind === "removed"
                ? t("saveModal.badgeRemoved")
                : t("saveModal.badgeModified");
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
                  <span>{secret && change.before !== undefined ? "••••••••" : formatDisplayValue(change.before, locale)}</span>
                  <Icon name="arrow-left" class="diff-arrow"/>
                  <strong>{secret && change.after !== undefined ? "••••••••" : formatDisplayValue(change.after, locale)}</strong>
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
