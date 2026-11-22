import { useEffect, useMemo, useState } from "preact/hooks";
import type { ConfigFormSchema, FieldSpec, SavePreview } from "../../../shared/schema.ts";
import { SECRET_KEY_PATTERN } from "../../../shared/validation.ts";
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
  const [revealSecrets, setRevealSecrets] = useState(false);
  const matchesActiveSchema = Boolean(schema && schema.file === savePreview.file);
  const fields = matchesActiveSchema ? (allFields ?? schema?.fields ?? []) : [];

  useEffect(() => {
    setTab("fields");
    setRevealSecrets(false);
  }, [savePreview]);

  const { secretKeys, secretValues } = useMemo(() => {
    const keys = new Set<string>();
    const values = new Set<string>();
    const pushValue = (value: unknown) => {
      if (typeof value === "string" && value.length >= 6) values.add(value);
    };
    const secretPaths = new Set<string>();
    for (const field of fields) {
      if (!field.secret && field.type !== "secret") continue;
      secretPaths.add(field.path);
      keys.add(field.path);
      const leaf = field.segments.at(-1);
      if (typeof leaf === "string" && leaf.trim()) keys.add(leaf);
      pushValue(field.value);
    }
    for (const change of savePreview.changes) {
      if (!secretPaths.has(change.path)) continue;
      pushValue(change.before);
      pushValue(change.after);
    }
    return { secretKeys: [...keys], secretValues: [...values] };
  }, [fields, savePreview.changes]);

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

      <div class="save-diff-toolbar">
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
          {matchesActiveSchema && (
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
          )}
        </div>
        {tab === "unified" && matchesActiveSchema && (
          <button
            type="button"
            class="save-diff-secret-btn"
            aria-pressed={revealSecrets}
            onClick={() => setRevealSecrets((current) => !current)}
          >
            <Icon name={revealSecrets ? "eye-off" : "eye"} size={14}/>
            <span>{revealSecrets ? t("diff.hideSecrets") : t("diff.showSecrets")}</span>
          </button>
        )}
      </div>

      {tab === "fields" ? (
        <div class="diff-list">
          {savePreview.changes.map((change) => {
            const field = fields.find((item) => item.path === change.path);
            const secret = field?.secret || field?.type === "secret" || SECRET_KEY_PATTERN.test(change.path);
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
          maskSecrets={!revealSecrets}
          secretKeys={secretKeys}
          secretValues={secretValues}
        />
      )}
    </Modal>
  );
}
