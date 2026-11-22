import { useEffect, useMemo, useState } from "preact/hooks";
import { collectSecretsFromFields } from "../../../shared/diff.ts";
import type { ConfigFormSchema, FieldSpec, SavePreview } from "../../../shared/schema.ts";
import { SECRET_KEY_PATTERN, valueContainsSecret } from "../../../shared/validation.ts";
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

  const { secretKeys, secretValues } = useMemo(
    () => collectSecretsFromFields(fields, savePreview.changes),
    [fields, savePreview.changes],
  );

  const changeSecretFlags = useMemo(
    () => savePreview.changes.map((change) => {
      const field = fields.find((item) => item.path === change.path);
      return Boolean(
        field?.secret
        || field?.type === "secret"
        || SECRET_KEY_PATTERN.test(change.path)
        || valueContainsSecret(change.before)
        || valueContainsSecret(change.after),
      );
    }),
    [fields, savePreview.changes],
  );
  const hasAnySecret = changeSecretFlags.some(Boolean) || secretKeys.length > 0 || secretValues.length > 0;

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
        {(hasAnySecret || (tab === "unified" && matchesActiveSchema)) && (
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
          {savePreview.changes.map((change, idx) => {
            const field = fields.find((item) => item.path === change.path);
            const secret = changeSecretFlags[idx] === true;
            const maskValue = secret && !revealSecrets;
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
                  <span>{maskValue && change.before !== undefined ? "••••••••" : formatDisplayValue(change.before, locale)}</span>
                  <Icon name="arrow-left" class="diff-arrow"/>
                  <strong>{maskValue && change.after !== undefined ? "••••••••" : formatDisplayValue(change.after, locale)}</strong>
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
          format={savePreview.format}
          maskSecrets={!revealSecrets}
          secretKeys={secretKeys}
          secretValues={secretValues}
        />
      )}
    </Modal>
  );
}
