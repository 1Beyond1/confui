import { useEffect, useMemo, useState } from "preact/hooks";
import {
  buildYamlDocumentLineSecrets,
  collectSecretsFromFields,
  isSaveChangeSecret,
} from "../../../shared/diff.ts";
import type { ConfigFormSchema, FieldSpec, SavePreview } from "../../../shared/schema.ts";
import { collectSecretStrings } from "../../../shared/validation.ts";
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
  const targetDocIndex = savePreview.documentIndex ?? 0;
  const matchesActiveDocument = matchesActiveSchema
    && targetDocIndex === (schema?.activeDocumentIndex ?? 0);
  const fields = matchesActiveDocument ? (allFields ?? schema?.fields ?? []) : [];
  const targetDocMeta = matchesActiveSchema
    ? schema?.documentSecrets?.find((item) => item.documentIndex === targetDocIndex)
    : undefined;

  useEffect(() => {
    setTab("fields");
    setRevealSecrets(false);
  }, [savePreview]);

  const changeSecretFlags = useMemo(
    () => savePreview.changes.map((change) => isSaveChangeSecret(change, fields, targetDocMeta)),
    [fields, savePreview.changes, targetDocMeta],
  );

  const { secretKeys, secretValues } = useMemo(() => {
    const base = collectSecretsFromFields(fields, savePreview.changes);
    const keySet = new Set<string>(base.secretKeys);
    const valSet = new Set<string>(base.secretValues);
    if (targetDocMeta) {
      for (const k of targetDocMeta.secretKeys) keySet.add(k);
      for (const v of targetDocMeta.secretValues) valSet.add(v);
    }
    for (let i = 0; i < savePreview.changes.length; i += 1) {
      if (!changeSecretFlags[i]) continue;
      const change = savePreview.changes[i]!;
      keySet.add(change.path);
      const leaf = change.path.split(".").at(-1)?.trim();
      if (leaf) keySet.add(leaf);
      collectSecretStrings(change.before, valSet);
      collectSecretStrings(change.after, valSet);
    }
    return { secretKeys: [...keySet], secretValues: [...valSet] };
  }, [fields, savePreview.changes, targetDocMeta, changeSecretFlags]);

  const { oldDocumentSecrets, newDocumentSecrets } = useMemo(() => {
    if (
      !matchesActiveSchema
      || savePreview.format !== "yaml"
      || !schema?.documentSecrets
      || schema.documentSecrets.length <= 1
    ) {
      return { oldDocumentSecrets: undefined, newDocumentSecrets: undefined };
    }
    const extraByDocument = new Map<number, { secretKeys: string[]; secretValues: string[] }>();
    const addExtra = (docIdx: number, keys: readonly string[], vals: readonly string[]): void => {
      const existing = extraByDocument.get(docIdx) ?? { secretKeys: [], secretValues: [] };
      existing.secretKeys.push(...keys);
      existing.secretValues.push(...vals);
      extraByDocument.set(docIdx, existing);
    };
    const activeDocIdx = schema.activeDocumentIndex ?? 0;
    const activeCollected = collectSecretsFromFields(allFields ?? schema.fields);
    addExtra(activeDocIdx, activeCollected.secretKeys, activeCollected.secretValues);
    addExtra(targetDocIndex, secretKeys, secretValues);
    return {
      oldDocumentSecrets: buildYamlDocumentLineSecrets(schema.rawText, schema.documentSecrets, extraByDocument),
      newDocumentSecrets: buildYamlDocumentLineSecrets(savePreview.output, schema.documentSecrets, extraByDocument),
    };
  }, [
    matchesActiveSchema,
    savePreview.format,
    savePreview.output,
    schema?.documentSecrets,
    schema?.activeDocumentIndex,
    schema?.fields,
    schema?.rawText,
    allFields,
    targetDocIndex,
    secretKeys,
    secretValues,
  ]);

  const hasDocSecrets = Boolean(
    oldDocumentSecrets?.some((sec) => (sec.secretKeys?.length ?? 0) > 0 || (sec.secretValues?.length ?? 0) > 0)
    || newDocumentSecrets?.some((sec) => (sec.secretKeys?.length ?? 0) > 0 || (sec.secretValues?.length ?? 0) > 0),
  );
  const hasAnySecret = changeSecretFlags.some(Boolean)
    || secretKeys.length > 0
    || secretValues.length > 0
    || hasDocSecrets;

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
          oldDocumentSecrets={oldDocumentSecrets}
          newDocumentSecrets={newDocumentSecrets}
        />
      )}
    </Modal>
  );
}
