import { useState } from "preact/hooks";
import type { ConfigFormat, FieldSpec, FieldType, PathSegment } from "../../../shared/schema.ts";
import {
  allowedCustomFieldTypes,
  defaultValueForType,
  validateNewKeyPath,
} from "../editor-state.ts";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";

const TYPE_LABELS: Record<FieldType, string> = {
  string: "字符串 (string)",
  integer: "整数 (integer)",
  number: "数字 (number)",
  boolean: "布尔开关 (boolean)",
  secret: "敏感值 (secret)",
  array: "列表 / 数组 (array)",
  json: "键值对象 (object)",
  enum: "枚举 (enum)",
  color: "颜色 (color)",
};

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
  const allowedTypes = allowedCustomFieldTypes(format);
  const [rawPath, setRawPath] = useState("");
  const [type, setType] = useState<FieldType>(allowedTypes[0] ?? "string");
  const [initialText, setInitialText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const pathCheck = validateNewKeyPath(rawPath, format, existingFields);

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
        valueError = type === "integer" ? "请输入有效整数" : "请输入有效数字";
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
    ? "例如 APP_DEBUG"
    : format === "properties"
      ? "例如 app.retry.count"
      : format === "ini"
        ? "例如 server.timeout"
        : "例如 server.timeout（支持点号嵌套）";

  return (
    <Modal
      title="新增配置项"
      description="按当前文件格式校验键名，确认后会添加到表单并纳入差异预览。"
      width="500px"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            icon="plus"
            disabled={Boolean((submitted || rawPath.trim()) && (pathCheck.error || valueError))}
            onClick={handleSubmit}
          >
            添加到表单
          </Button>
        </>
      )}
    >
      <div class="add-key-form">
        <div class="setting-field">
          <label for="add-key-path">配置项路径</label>
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
          <label for="add-key-type">数据类型</label>
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
                <option key={item} value={item}>{TYPE_LABELS[item]}</option>
              ))}
            </select>
            <Icon name="chevron-down" size={16}/>
          </div>
        </div>

        {(type === "string" || type === "secret" || type === "integer" || type === "number") && (
          <div class="setting-field">
            <label for="add-key-value">初始值</label>
            <input
              id="add-key-value"
              class={`control ${valueError ? "control--error" : ""}`}
              type={type === "secret" ? "password" : "text"}
              value={initialText}
              placeholder={type === "integer" || type === "number" ? "0" : "留空则写入空字符串"}
              onInput={(event) => setInitialText(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") handleSubmit(); }}
            />
            {valueError && <p class="field-error"><Icon name="warning" size={14}/>{valueError}</p>}
          </div>
        )}

        {type === "boolean" && (
          <div class="setting-field">
            <label for="add-key-bool">初始状态</label>
            <div class="select-wrap">
              <select
                id="add-key-bool"
                class="control"
                value={initialText || "false"}
                onChange={(event) => setInitialText(event.currentTarget.value)}
              >
                <option value="false">false（关闭）</option>
                <option value="true">true（启用）</option>
              </select>
              <Icon name="chevron-down" size={16}/>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
