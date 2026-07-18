import { useState } from "preact/hooks";
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
}: {
  fields: FieldSpec[];
  values: EditorValues;
  errors: Map<string, string>;
  onChange: (field: FieldSpec, value: unknown) => void;
}) {
  const groups = groupFields(fields);
  return (
    <div class="field-groups">
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
  onChange,
}: {
  field: FieldSpec;
  value: unknown;
  error?: string;
  controlId: string;
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
        {field.description && <p class="field-description">{field.description}</p>}
        <FieldControl id={controlId} field={field} value={value} error={error} onChange={onChange}/>
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
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const describedBy = error ? `${id}-error` : undefined;

  if (field.type === "boolean") {
    const checked = value === true;
    return (
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        class={`switch-control ${checked ? "switch-control--on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span class="switch-control__track"><i/></span>
        <span>{checked ? "已启用" : "未启用"}</span>
      </button>
    );
  }

  if (field.type === "enum") {
    return (
      <div class="select-wrap">
        <select
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          value={value === undefined || value === null ? "" : String(value)}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          onChange={(event) => {
            const selected = field.enum?.find((item) => String(item) === event.currentTarget.value);
            onChange(event.currentTarget.value === "" ? undefined : selected ?? event.currentTarget.value);
          }}
        >
          <option value="">请选择</option>
          {field.enum?.map((option) => <option value={String(option)} key={String(option)}>{String(option)}</option>)}
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
          onInput={(event) => onChange(parseJsonDraft(event.currentTarget.value))}
        />
      </div>
    );
  }

  if (field.type === "color") {
    const color = typeof value === "string" && /^#[\da-f]{6}$/i.test(value) ? value : "#2563eb";
    return (
      <div class="color-control">
        <input id={`${id}-picker`} type="color" value={color} onInput={(event) => onChange(event.currentTarget.value)}/>
        <input id={id} class="control" value={String(value ?? "")} aria-invalid={Boolean(error)} aria-required={field.required} onInput={(event) => onChange(event.currentTarget.value)} placeholder="#2563eb"/>
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
          onInput={(event) => onChange(event.currentTarget.value)}
        />
        <button type="button" class="icon-button" onClick={() => setRevealed(!revealed)} aria-label={revealed ? "隐藏内容" : "显示内容"}>
          <Icon name={revealed ? "eye-off" : "eye"}/>
        </button>
      </div>
    );
  }

  if (field.type === "number" || field.type === "integer") {
    return (
      <input
        id={id}
        class={`control ${error ? "control--error" : ""}`}
        type="number"
        step={field.type === "integer" ? 1 : "any"}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === "number" && Number.isFinite(value) ? value : ""}
        placeholder={field.placeholder}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
        onInput={(event) => onChange(event.currentTarget.value === "" ? undefined : event.currentTarget.valueAsNumber)}
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
