import { useState } from "preact/hooks";
import type { ConfigFormat, FieldSpec, FieldType, PathSegment } from "../../../shared/schema.ts";
import {
  allowedCustomFieldTypes,
  defaultValueForType,
  validateNewKeyPath,
} from "../editor-state.ts";
import { fieldTypeLabel, useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";

export function AddKeyModal({
  format,
  existingFields,
  onClose,
  onAdd,
}: {
  format: ConfigFormat;
  existingFields: readonly FieldSpec[];
  onClose: () => void;
  onAdd: (segments: PathSegment[], type: FieldType, initialValue: unknown) => void;
}) {
  const { locale, t } = useI18n();
  const allowedTypes = allowedCustomFieldTypes(format);
  const [rawPath, setRawPath] = useState("");
  const [type, setType] = useState<FieldType>(allowedTypes[0] ?? "string");
  const [initialText, setInitialText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const pathCheck = validateNewKeyPath(rawPath, format, existingFields, locale);

  let valueError: string | undefined;
  let parsedInitial: unknown = defaultValueForType(type);
  if (type === "string" || type === "secret") {
    parsedInitial = initialText;
  } else if (type === "boolean") {
    parsedInitial = initialText === "true";
  } else if (type === "integer" || type === "number") {
    const trimmed = initialText.trim();
    if (!trimmed) {
      parsedInitial = 0;
    } else {
      const num = Number(trimmed);
      if (!Number.isFinite(num) || (type === "integer" && !Number.isSafeInteger(num))) {
        valueError = type === "integer" ? t("addKeyModal.invalidInt") : t("addKeyModal.invalidNum");
      } else {
        parsedInitial = num;
      }
    }
  } else if (type === "array") {
    parsedInitial = format === "ini" ? ["item"] : [];
  } else if (type === "json") {
    parsedInitial = {};
  }

  function handleSubmit(): void {
    setSubmitted(true);
    if (pathCheck.error || valueError || !pathCheck.segments.length) return;
    onAdd(pathCheck.segments, type, parsedInitial);
    onClose();
  }

  const placeholder = format === "env"
    ? t("addKeyModal.placeholderEnv")
    : format === "properties"
      ? t("addKeyModal.placeholderProperties")
      : format === "ini"
        ? t("addKeyModal.placeholderIni")
        : t("addKeyModal.placeholderNested");

  return (
    <Modal
      title={t("addKeyModal.title")}
      description={t("addKeyModal.desc")}
      width="500px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            variant="primary"
            icon="plus"
            disabled={Boolean((submitted || rawPath.trim()) && (pathCheck.error || valueError))}
            onClick={handleSubmit}
          >
            {t("addKeyModal.submit")}
          </Button>
        </>
      )}
    >
      <div class="add-key-form">
        <div class="setting-field">
          <label for="add-key-path">{t("addKeyModal.pathLabel")}</label>
          <input
            id="add-key-path"
            class={`control ${(submitted || rawPath.trim()) && pathCheck.error ? "control--error" : ""}`}
            value={rawPath}
            placeholder={placeholder}
            onInput={(event) => setRawPath(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") handleSubmit(); }}
          />
          {(submitted || rawPath.trim()) && pathCheck.error && (
            <p class="field-error"><Icon name="warning" size={14}/>{pathCheck.error}</p>
          )}
        </div>

        <div class="setting-field">
          <label for="add-key-type">{t("addKeyModal.typeLabel")}</label>
          <div class="select-wrap">
            <select
              id="add-key-type"
              class="control"
              value={type}
              onChange={(event) => {
                const nextType = event.currentTarget.value as FieldType;
                setType(nextType);
                setInitialText(nextType === "boolean" ? "false" : "");
              }}
            >
              {allowedTypes.map((item) => (
                <option key={item} value={item}>{fieldTypeLabel(locale, item)}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={16}/>
          </div>
        </div>

        {(type === "string" || type === "secret" || type === "integer" || type === "number") && (
          <div class="setting-field">
            <label for="add-key-value">{t("addKeyModal.initialValueLabel")}</label>
            <input
              id="add-key-value"
              class={`control ${valueError ? "control--error" : ""}`}
              type={type === "secret" ? "password" : "text"}
              value={initialText}
              placeholder={type === "integer" || type === "number" ? "0" : t("addKeyModal.valuePlaceholderEmpty")}
              onInput={(event) => setInitialText(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") handleSubmit(); }}
            />
            {valueError && <p class="field-error"><Icon name="warning" size={14}/>{valueError}</p>}
          </div>
        )}

        {type === "boolean" && (
          <div class="setting-field">
            <label for="add-key-bool">{t("addKeyModal.initialBoolLabel")}</label>
            <div class="select-wrap">
              <select
                id="add-key-bool"
                class="control"
                value={initialText || "false"}
                onChange={(event) => setInitialText(event.currentTarget.value)}
              >
                <option value="false">{t("addKeyModal.boolFalse")}</option>
                <option value="true">{t("addKeyModal.boolTrue")}</option>
              </select>
              <Icon name="chevron-down" size={16}/>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
