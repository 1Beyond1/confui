import { useEffect, useRef, useState } from "preact/hooks";
import type { FieldSpec } from "../../shared/schema.ts";
import {
  fieldKey,
  isJsonDraft,
  parseJsonDraft,
  type EditorValues,
} from "./editor-state.ts";
import { Icon } from "./icons.tsx";
import { SourceBadge } from "./ui.tsx";

export function FieldEditor({
  fields,
  values,
  errors,
  onChange,
  disabled = false,
}: {
  fields: FieldSpec[];
  values: EditorValues;
  errors: Map<string, string>;
  onChange: (field: FieldSpec, value: unknown) => void;
  disabled?: boolean;
}) {
  const groups = groupFields(fields);
  return (
    <div class="field-groups" aria-busy={disabled}>
      {groups.map(([name, groupFields]) => (
        <section class="form-card" key={name}>
          <header class="form-card__header">
            <div>
              <h2>{name}</h2>
              <p>{groupFields.length} 个配置项</p>
            </div>
          </header>
          <div class="form-card__body">
            {groupFields.map((field, index) => {
              const key = fieldKey(field);
              return (
                <FieldRow
                  key={key}
                  field={field}
                  value={values[key]}
                  error={errors.get(key)}
                  controlId={`field-${name}-${index}`.replace(/[^\w-]/g, "-")}
                  disabled={disabled}
                  onChange={(value) => onChange(field, value)}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function FieldRow({
  field,
  value,
  error,
  controlId,
  disabled,
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  error?: string;
  controlId: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const evidenceTitle = field.evidence
    .map((item) => `${item.property}: ${item.source} (${Math.round(item.confidence * 100)}%)`)
    .join("\n");
  return (
    <div class={`field-row ${field.confidence < 0.7 ? "field-row--suggested" : ""} ${error ? "field-row--error" : ""}`}>
      <div class="field-row__meta">
        <div class="field-row__title">
          <label for={controlId}>{field.label}</label>
          {field.required && <span class="required-mark" title="必填">必填</span>}
        </div>
        <code>{field.path}</code>
        <div title={evidenceTitle}><SourceBadge source={field.source} confidence={field.confidence}/></div>
      </div>
      <div class="field-row__content">
        {field.description && <p id={`${controlId}-description`} class="field-description">{field.description}</p>}
        <FieldControl
          id={controlId}
          field={field}
          value={value}
          error={error}
          descriptionId={field.description ? `${controlId}-description` : undefined}
          disabled={disabled}
          onChange={onChange}
        />
        {error && <p class="field-error" id={`${controlId}-error`}><Icon name="warning" size={14}/>{error}</p>}
        {!error && field.default !== undefined && (
          <p class="field-hint">默认值：<code>{field.secret || field.type === "secret" ? "••••••••" : formatCompact(field.default)}</code></p>
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
  onChange: (value: unknown) => void;
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
    const selectedIndex = options.findIndex((option) => Object.is(option, value));
    return (
      <div class="select-wrap">
        <select
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          value={selectedIndex >= 0 ? String(selectedIndex) : ""}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onChange={(event) => {
            if (event.currentTarget.value === "") {
              onChange(undefined);
              return;
            }
            const index = Number(event.currentTarget.value);
            onChange(Number.isSafeInteger(index) && index >= 0 ? options[index] : undefined);
          }}
        >
          <option value="">请选择</option>
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

  if (field.type === "array" || field.type === "json") {
    const draft = isJsonDraft(value) ? value : { text: value === undefined ? "" : JSON.stringify(value, null, 2) };
    return (
      <div class="code-control">
        <div class="code-control__bar"><span>JSON</span><small>{field.type === "array" ? "数组" : "对象"}</small></div>
        <textarea
          id={id}
          class={`control control--code ${error ? "control--error" : ""}`}
          value={draft.text}
          rows={Math.min(14, Math.max(4, draft.text.split("\n").length + 1))}
          spellcheck={false}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onInput={(event) => onChange(parseJsonDraft(event.currentTarget.value))}
        />
      </div>
    );
  }

  if (field.type === "color") {
    const color = typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : "#2563eb";
    return (
      <div class="color-control">
        <input id={`${id}-picker`} type="color" value={color} aria-label={`${field.label}颜色选择器`} aria-describedby={describedBy} disabled={disabled} onInput={(event) => onChange(event.currentTarget.value)}/>
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
          onInput={(event) => onChange(event.currentTarget.value)}
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
      && typeof minimum === "number" && Number.isFinite(minimum)
      && typeof maximum === "number" && Number.isFinite(maximum)
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
          />
          <b class="range-control__value">{current ?? "—"}</b>
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
          const valid = Number.isFinite(parsed) && (field.type !== "integer" || Number.isInteger(parsed));
          lastNumberValue.current = valid ? parsed : raw;
          onChange(valid ? parsed : raw);
        }}
        onBlur={() => {
          const parsed = Number(numberText);
          if (numberText.trim() && Number.isFinite(parsed) && (field.type !== "integer" || Number.isInteger(parsed))) {
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
      onInput={(event) => onChange(event.currentTarget.value)}
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

function formatNumberInput(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}
