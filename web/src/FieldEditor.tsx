import { useEffect, useRef, useState } from "preact/hooks";
import type { FieldAssistResult, FieldSpec } from "../../shared/schema.ts";
import { isHexColor6 } from "../../shared/validation.ts";
import {
  effectiveValue,
  enumValueEqual,
  fieldKey,
  isFieldModified,
  isInactiveExamplePlaceholder,
  type EditorValues,
} from "./editor-state.ts";
import { StructuredArrayControl, StructuredObjectControl } from "./components/StructuredControls.tsx";
import { Icon } from "./icons.tsx";
import { SourceBadge } from "./ui.tsx";

export function FieldEditor({
  fileKey,
  fields,
  customKeys,
  values,
  errors,
  onChange,
  onResetField,
  onDeleteField,
  onOpenAddKey,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  aiAvailable = false,
  onExplain,
  disabled = false,
}: {
  fileKey?: string;
  fields: FieldSpec[];
  customKeys?: ReadonlySet<string>;
  values: EditorValues;
  errors: Map<string, string>;
  onChange: (field: FieldSpec, value: unknown, options?: { coalesce?: boolean }) => void;
  onResetField?: (field: FieldSpec) => void;
  onDeleteField?: (field: FieldSpec) => void;
  onOpenAddKey?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  aiAvailable?: boolean;
  onExplain?: (field: FieldSpec) => Promise<FieldAssistResult>;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  useEffect(() => {
    setQuery("");
  }, [fileKey]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFields = normalizedQuery
    ? fields.filter((field) => [field.label, field.path, field.description, field.group]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery))
    : fields;
  const groups = groupFields(visibleFields);
  const controlIds = new Map(fields.map((field, index) => [fieldKey(field), `field-${index}`]));
  return (
    <div class="field-editor" aria-busy={disabled}>
      <div class="field-toolbar">
        <label class="field-search">
          <Icon name="search" size={15}/>
          <input
            value={query}
            disabled={disabled}
            placeholder="搜索字段名称、路径或说明"
            aria-label="搜索字段名称、路径或说明"
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query && <button type="button" class="icon-button" disabled={disabled} onClick={() => setQuery("")} aria-label="清空字段筛选"><Icon name="x" size={14}/></button>}
        </label>
        <div class="field-toolbar__actions">
          <span class="field-toolbar__count">
            {visibleFields.length === fields.length ? `${fields.length} 个配置项` : `${visibleFields.length} / ${fields.length} 个配置项`}
          </span>
          {onUndo && onRedo && (
            <div class="toolbar-history">
              <button
                type="button"
                class="icon-button"
                disabled={disabled || !canUndo}
                onClick={onUndo}
                aria-label="撤销"
                title="撤销 (Ctrl+Z)"
              >
                <Icon name="undo" size={15}/>
              </button>
              <button
                type="button"
                class="icon-button"
                disabled={disabled || !canRedo}
                onClick={onRedo}
                aria-label="重做"
                title="重做 (Ctrl+Y)"
              >
                <Icon name="redo" size={15}/>
              </button>
            </div>
          )}
          {onOpenAddKey && (
            <button
              type="button"
              class="toolbar-add-key"
              disabled={disabled}
              onClick={onOpenAddKey}
            >
              <Icon name="plus" size={14}/>
              <span>新增配置项</span>
            </button>
          )}
        </div>
      </div>

      {groups.length ? <div class="field-groups">
        {groups.map(([name, groupedFields]) => (
          <section class="form-card" key={name}>
            <header class="form-card__header">
              <div>
                <h2>{name}</h2>
                <p>{groupedFields.length} 个配置项</p>
              </div>
            </header>
            <div class="form-card__body">
              {groupedFields.map((field) => {
                const key = fieldKey(field);
                return (
                  <FieldRow
                    key={key}
                    field={field}
                    isCustom={Boolean(customKeys?.has(key))}
                    value={values[key]}
                    error={errors.get(key)}
                    controlId={controlIds.get(key) ?? `field-${key}`.replace(/[^\w-]/g, "-")}
                    disabled={disabled}
                    aiAvailable={aiAvailable}
                    onExplain={onExplain ? () => onExplain(field) : undefined}
                    onChange={(value, coalesce) => onChange(field, value, { coalesce })}
                    onReset={onResetField ? () => onResetField(field) : undefined}
                    onDelete={onDeleteField ? () => onDeleteField(field) : undefined}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div> : (
        <div class="field-filter-empty">
          <Icon name="search"/>
          <span>没有匹配的字段</span>
          <button type="button" disabled={disabled} onClick={() => setQuery("")}>清空筛选</button>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field,
  isCustom,
  value,
  error,
  controlId,
  disabled,
  aiAvailable,
  onExplain,
  onChange,
  onReset,
  onDelete,
}: {
  field: FieldSpec;
  isCustom: boolean;
  value: unknown;
  error?: string;
  controlId: string;
  disabled: boolean;
  aiAvailable: boolean;
  onExplain?: () => Promise<FieldAssistResult>;
  onChange: (value: unknown, coalesce?: boolean) => void;
  onReset?: () => void;
  onDelete?: () => void;
}) {
  const [assist, setAssist] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "success"; result: FieldAssistResult }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const evidenceTitle = field.evidence
    .map((item) => `${item.property}: ${item.source} (${Math.round(item.confidence * 100)}%)`)
    .join("\n");
  async function requestAssist(): Promise<void> {
    if (!onExplain || assist.status === "loading") return;
    setAssist({ status: "loading" });
    try {
      setAssist({ status: "success", result: await onExplain() });
    } catch (error) {
      setAssist({ status: "error", message: error instanceof Error ? error.message : "AI 字段解释失败" });
    }
  }

  function handleChange(nextValue: unknown, coalesce = false): void {
    onChange(nextValue, coalesce);
  }

  const currentEffective = effectiveValue(value);
  const modified = isCustom || isFieldModified(field, value);
  const markedDeleted = !isCustom && field.value !== undefined && currentEffective === undefined;
  const canDelete = isCustom || field.value !== undefined;
  const inactiveExampleRequired = isInactiveExamplePlaceholder(field, currentEffective);

  return (
    <div
      class={`field-row ${field.confidence < 0.7 ? "field-row--suggested" : ""} ${error ? "field-row--error" : ""} ${modified && !error ? "field-row--modified" : ""} ${markedDeleted ? "field-row--deleted" : ""}`}
    >
      <div class="field-row__meta">
        <div class="field-row__title">
          <label for={controlId}>{field.label}</label>
          {isCustom && <span class="field-badge field-badge--added">新增</span>}
          {markedDeleted && <span class="field-badge field-badge--deleted">待删除</span>}
          {field.required && !markedDeleted && (
            <span
              class="required-mark"
              title={inactiveExampleRequired ? "来自示例文件的建议必填项，未在当前配置中启用" : "必填"}
            >
              {inactiveExampleRequired ? "建议填写" : "必填"}
            </span>
          )}
        </div>
        <code>{field.path}</code>
        <div class="field-row__meta-bottom">
          <div title={evidenceTitle}><SourceBadge source={field.source} confidence={field.confidence}/></div>
        </div>
      </div>
      <div class="field-row__content">
        <div class="field-description-line">
          {field.description ? (
            <p id={`${controlId}-description`} class="field-description">{field.description}</p>
          ) : (
            <span class="field-description-spacer"/>
          )}
          <div class="field-row__quick-actions">
            {modified && !isCustom && onReset && (
              <button
                type="button"
                class="field-action-btn"
                disabled={disabled}
                onClick={onReset}
                title={markedDeleted ? "取消删除并恢复原值" : "恢复此字段原始值"}
              >
                <Icon name="undo" size={12}/>
                <span>{markedDeleted ? "取消删除" : "恢复原值"}</span>
              </button>
            )}
            {canDelete && !markedDeleted && onDelete && (
              <button
                type="button"
                class="field-action-btn field-action-btn--danger"
                disabled={disabled}
                onClick={onDelete}
                title={isCustom ? "移除此新增配置项" : "标记删除此配置项"}
              >
                <Icon name="trash" size={12}/>
                <span>删除</span>
              </button>
            )}
            {aiAvailable && onExplain && !isCustom && (
              <button
                type="button"
                class="field-ai-button"
                disabled={disabled || assist.status === "loading"}
                onClick={() => void requestAssist()}
                title="让已配置的 AI 解释这个字段并给出填写建议"
              >
                <Icon name={assist.status === "loading" ? "loader" : "sparkles"} class={assist.status === "loading" ? "spin" : undefined} size={13}/>
                <span>{assist.status === "loading" ? "分析中" : assist.status === "success" ? "再次询问" : "AI 解读"}</span>
              </button>
            )}
          </div>
        </div>
        <FieldControl
          id={controlId}
          field={field}
          value={value}
          error={error}
          descriptionId={field.description ? `${controlId}-description` : undefined}
          disabled={disabled}
          onChange={handleChange}
        />
        {error && <p class="field-error" id={`${controlId}-error`}><Icon name="warning" size={14}/>{error}</p>}
        {!error && field.default !== undefined && (
          <div class="field-hint">
            <span>默认值：<code>{field.secret || field.type === "secret" ? "••••••••" : formatCompact(field.default)}</code></span>
            {effectiveValue(value) === undefined && !field.secret && field.type !== "secret" && (
              <button type="button" class="field-default-button" disabled={disabled} onClick={() => handleChange(cloneDefault(field.default))}>使用默认值</button>
            )}
          </div>
        )}
        {assist.status === "success" && (
          <div class="field-ai-result" role="status" aria-live="polite">
            <div class="field-ai-result__heading"><Icon name="sparkles" size={14}/><strong>AI 字段解读</strong></div>
            <p>{assist.result.explanation}</p>
            {assist.result.recommendation && <p><b>填写建议：</b>{assist.result.recommendation}</p>}
            {assist.result.caution && <p class="field-ai-result__caution"><b>注意：</b>{assist.result.caution}</p>}
          </div>
        )}
        {assist.status === "error" && (
          <div class="field-ai-result field-ai-result--error" role="alert">
            <span>{assist.message}</span>
            {onExplain && <button type="button" onClick={() => void requestAssist()} disabled={disabled}>重试</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldControl({
  id,
  field,
  value,
  error,
  descriptionId,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: unknown;
  error?: string;
  descriptionId?: string;
  disabled: boolean;
  onChange: (value: unknown, coalesce?: boolean) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [numberText, setNumberText] = useState(() => formatNumberInput(value));
  const lastNumberValue = useRef<unknown>(value);
  useEffect(() => {
    if (Object.is(value, lastNumberValue.current)) return;
    lastNumberValue.current = value;
    setNumberText(formatNumberInput(value));
  }, [value, field.type]);
  const describedBy = [descriptionId, error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;

  if (field.type === "boolean") {
    const checked = value === true;
    const state = value === undefined ? "未设置" : checked ? "已启用" : "已关闭";
    return (
      <div class="boolean-control">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-label={`${field.label}：${state}`}
          class={`switch-control ${checked ? "switch-control--on" : ""} ${value === undefined ? "switch-control--unset" : ""}`}
          disabled={disabled}
          onClick={() => onChange(value === undefined ? true : !checked)}
        >
          <span class="switch-control__track"><i/></span>
          <span>{state}</span>
        </button>
        <button
          type="button"
          class="boolean-control__reset"
          disabled={disabled || value === undefined}
          onClick={() => onChange(undefined)}
          aria-label={`${field.label}设为未设置`}
        >重置</button>
      </div>
    );
  }

  if (field.type === "enum") {
    const options = field.enum ?? [];
    const exactIndex = options.findIndex((option) => Object.is(option, value));
    const selectedIndex = exactIndex >= 0
      ? exactIndex
      : options.findIndex((option) => enumValueEqual(option, value));
    const hasNonPresetValue = value !== undefined && selectedIndex < 0;
    const selectValue = selectedIndex >= 0
      ? String(selectedIndex)
      : hasNonPresetValue
        ? "__non_preset__"
        : "";
    return (
      <div class="select-wrap">
        <select
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          value={selectValue}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onChange={(event) => {
            if (event.currentTarget.value === "__non_preset__") return;
            if (event.currentTarget.value === "") {
              onChange(undefined);
              return;
            }
            const index = Number(event.currentTarget.value);
            onChange(Number.isSafeInteger(index) && index >= 0 ? options[index] : undefined);
          }}
        >
          <option value="">请选择</option>
          {hasNonPresetValue && (
            <option value="__non_preset__">
              {`${value === "" ? "（空字符串）" : formatCompact(value)} — 当前值（非预设）`}
            </option>
          )}
          {options.map((option, index) => (
            <option value={String(index)} key={`${typeof option}:${String(option)}:${index}`}>
              {option === "" ? "（空字符串）" : String(option)}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={16}/>
      </div>
    );
  }

  if (field.type === "array") {
    return (
      <StructuredArrayControl
        id={id}
        field={field}
        value={value}
        error={error}
        describedBy={describedBy}
        disabled={disabled}
        onChange={(next) => onChange(next, false)}
      />
    );
  }

  if (field.type === "json") {
    return (
      <StructuredObjectControl
        id={id}
        field={field}
        value={value}
        error={error}
        describedBy={describedBy}
        disabled={disabled}
        onChange={(next) => onChange(next, false)}
      />
    );
  }

  if (field.type === "color") {
    // The native picker only understands six-digit opaque colors. Keep it
    // disabled for shorthand/alpha values so opening the picker cannot
    // silently replace a value that the text input can preserve.
    const pickerEnabled = value === undefined || value === "" || isHexColor6(value);
    const color = pickerEnabled && isHexColor6(value) ? value : "#2563eb";
    return (
      <div class="color-control">
        <input id={`${id}-picker`} type="color" value={color} title={pickerEnabled ? "选择颜色" : "当前颜色包含简写或透明度，请使用文本输入"} aria-label={`${field.label}颜色选择器`} aria-describedby={describedBy} disabled={disabled || !pickerEnabled} onInput={(event) => onChange(event.currentTarget.value)}/>
        <input id={id} class={`control ${error ? "control--error" : ""}`} value={String(value ?? "")} aria-describedby={describedBy} aria-invalid={Boolean(error)} aria-required={field.required} disabled={disabled} onInput={(event) => onChange(event.currentTarget.value)} placeholder="#2563eb"/>
      </div>
    );
  }

  if (field.type === "secret") {
    return (
      <div class="input-with-action">
        <input
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          type={revealed ? "text" : "password"}
          value={String(value ?? "")}
          placeholder={field.placeholder || "输入敏感值"}
          autocomplete="off"
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value, true)}
        />
        <button type="button" class="icon-button" disabled={disabled} onClick={() => setRevealed(!revealed)} aria-label={revealed ? "隐藏内容" : "显示内容"}>
          <Icon name={revealed ? "eye-off" : "eye"}/>
        </button>
      </div>
    );
  }

  if (field.type === "number" || field.type === "integer") {
    const current = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    // 上下界都已知且跨度不大的整数用滑块；端口号那种上万的跨度滑块反而更难对准，仍走数字输入框。
    const { minimum, maximum } = field;
    const slidable = field.type === "integer"
      && typeof minimum === "number" && Number.isSafeInteger(minimum)
      && typeof maximum === "number" && Number.isSafeInteger(maximum)
      && maximum > minimum && maximum - minimum <= 1000;
    if (slidable) {
      return (
        <div class={`range-control ${error ? "range-control--error" : ""}`}>
          <input
            id={id}
            type="range"
            min={minimum}
            max={maximum}
            step={1}
            value={current ?? minimum}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            aria-required={field.required}
            aria-valuetext={current === undefined ? "未设置" : String(current)}
            disabled={disabled}
            onInput={(event) => onChange(event.currentTarget.valueAsNumber)}
            onClick={(event) => {
              if (current === undefined) onChange(event.currentTarget.valueAsNumber);
            }}
            onKeyDown={(event) => {
              if (current === undefined && ["ArrowLeft", "ArrowDown", "Home", "PageDown", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                onChange(minimum);
              }
            }}
          />
          <b class="range-control__value">{current ?? "—"}</b>
          <button
            type="button"
            class="boolean-control__reset range-control__reset"
            disabled={disabled || current === undefined}
            onClick={() => onChange(undefined)}
            aria-label={`${field.label}设为未设置`}
          >重置</button>
        </div>
      );
    }
    return (
      <input
        id={id}
        class={`control ${error ? "control--error" : ""}`}
        type="text"
        inputMode={field.type === "integer" ? "numeric" : "decimal"}
        value={numberText}
        placeholder={field.placeholder}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
        disabled={disabled}
        onInput={(event) => {
          const raw = event.currentTarget.value;
          setNumberText(raw);
          if (!raw.trim()) {
            lastNumberValue.current = undefined;
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          const valid = Number.isFinite(parsed)
            && (field.type !== "integer" || Number.isSafeInteger(parsed))
            && (field.type !== "number" || !Number.isInteger(parsed) || Number.isSafeInteger(parsed));
          lastNumberValue.current = valid ? parsed : raw;
          onChange(valid ? parsed : raw, true);
        }}
        onBlur={() => {
          const parsed = Number(numberText);
          if (numberText.trim() && Number.isFinite(parsed)
            && (field.type !== "integer" || Number.isSafeInteger(parsed))
            && (field.type !== "number" || !Number.isInteger(parsed) || Number.isSafeInteger(parsed))) {
            setNumberText(String(parsed));
          }
        }}
      />
    );
  }

  return (
    <input
      id={id}
      class={`control ${error ? "control--error" : ""}`}
      type="text"
      value={String(value ?? "")}
      placeholder={field.placeholder}
      minlength={field.minLength}
      maxlength={field.maxLength}
      aria-describedby={describedBy}
      aria-invalid={Boolean(error)}
      aria-required={field.required}
      disabled={disabled}
      onInput={(event) => onChange(event.currentTarget.value, true)}
    />
  );
}

function groupFields(fields: FieldSpec[]): Array<[string, FieldSpec[]]> {
  const groups = new Map<string, FieldSpec[]>();
  for (const field of fields) {
    const name = field.group || "常规";
    const current = groups.get(name) ?? [];
    current.push(field);
    groups.set(name, current);
  }
  return [...groups.entries()];
}

function formatCompact(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text && text.length > 80 ? `${text.slice(0, 77)}…` : text ?? String(value);
}

function cloneDefault(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function formatNumberInput(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}
