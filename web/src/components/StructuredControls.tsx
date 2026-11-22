import { useState } from "preact/hooks";
import type { FieldSpec } from "../../../shared/schema.ts";
import { isForbiddenKey, setSafeProperty } from "../../../shared/validation.ts";
import {
  createJsonDraft,
  isFlatScalarObject,
  isJsonDraft,
  isScalarArray,
  parseJsonDraft,
} from "../editor-state.ts";
import { Icon } from "../icons.tsx";

export interface StructuredControlProps {
  id: string;
  field: FieldSpec;
  value: unknown;
  error?: string;
  describedBy?: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
}

export function StructuredArrayControl({
  id,
  field,
  value,
  error,
  describedBy,
  disabled,
  onChange,
}: StructuredControlProps) {
  const draft = isJsonDraft(value)
    ? value
    : createJsonDraft(value);
  const parsed = draft.error ? undefined : draft.parsed;
  const visualEligible = !draft.error && (parsed === undefined || isScalarArray(parsed));
  const [jsonMode, setJsonMode] = useState(!visualEligible);
  const useJson = jsonMode || !visualEligible;

  const items: Array<string | number | boolean | null> = Array.isArray(parsed) && isScalarArray(parsed)
    ? parsed
    : [];
  const allNumeric = items.length > 0 && items.every((item) => typeof item === "number");

  function emitArray(next: Array<string | number | boolean | null>): void {
    onChange(createJsonDraft(next));
  }

  function updateItem(index: number, raw: string): void {
    const prev = items[index];
    let nextVal: string | number | boolean | null = raw;
    if (typeof prev === "number" || allNumeric) {
      const trimmed = raw.trim();
      const num = Number(trimmed);
      if (trimmed !== "" && Number.isFinite(num) && (!Number.isInteger(num) || Number.isSafeInteger(num))) {
        nextVal = num;
      }
    } else if (typeof prev === "boolean") {
      if (raw === "true") nextVal = true;
      else if (raw === "false") nextVal = false;
    }
    const next = [...items];
    next[index] = nextVal;
    emitArray(next);
  }

  function moveItem(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    emitArray(next);
  }

  function removeItem(index: number): void {
    const next = items.filter((_, i) => i !== index);
    emitArray(next);
  }

  function addItem(): void {
    const nextVal = allNumeric ? 0 : "";
    emitArray([...items, nextVal]);
  }

  return (
    <div class="code-control structured-control">
      <div class="code-control__bar">
        <div class="structured-control__title">
          <span>{useJson ? "JSON" : "LIST"}</span>
          <small>{useJson ? "数组源码" : `${items.length} 项`}</small>
        </div>
        <button
          type="button"
          class="structured-mode-toggle"
          disabled={disabled || (!useJson ? false : !visualEligible)}
          title={!visualEligible && useJson ? "包含嵌套对象或格式有误，仅支持 JSON 源码编辑" : undefined}
          onClick={() => setJsonMode(!useJson)}
        >
          <Icon name={useJson ? "layers" : "code"} size={13}/>
          <span>{useJson ? "可视化列表" : "JSON 源码"}</span>
        </button>
      </div>
      {useJson ? (
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
      ) : (
        <div class="structured-list" id={id} aria-describedby={describedBy}>
          {items.length === 0 ? (
            <div class="structured-empty">暂无列表项，点击下方按钮添加</div>
          ) : (
            items.map((item, index) => (
              <div class="structured-row" key={index}>
                <span class="structured-row__index">{index + 1}</span>
                {typeof item === "boolean" ? (
                  <button
                    type="button"
                    class={`switch-control structured-bool ${item ? "switch-control--on" : ""}`}
                    role="switch"
                    aria-checked={item}
                    disabled={disabled}
                    onClick={() => {
                      const next = [...items];
                      next[index] = !item;
                      emitArray(next);
                    }}
                  >
                    <span class="switch-control__track"><i/></span>
                    <span>{item ? "true" : "false"}</span>
                  </button>
                ) : (
                  <input
                    class="control structured-row__input"
                    type="text"
                    inputMode={typeof item === "number" ? "decimal" : undefined}
                    value={item === null ? "" : String(item)}
                    placeholder={item === null ? "null" : "输入值"}
                    disabled={disabled}
                    aria-label={`${field.label} 第 ${index + 1} 项`}
                    onInput={(event) => updateItem(index, event.currentTarget.value)}
                  />
                )}
                <div class="structured-row__actions">
                  <button
                    type="button"
                    class="icon-button"
                    disabled={disabled || index === 0}
                    onClick={() => moveItem(index, -1)}
                    aria-label="上移"
                    title="上移"
                  >
                    <Icon name="arrow-up" size={14}/>
                  </button>
                  <button
                    type="button"
                    class="icon-button"
                    disabled={disabled || index === items.length - 1}
                    onClick={() => moveItem(index, 1)}
                    aria-label="下移"
                    title="下移"
                  >
                    <Icon name="arrow-down" size={14}/>
                  </button>
                  <button
                    type="button"
                    class="icon-button structured-row__delete"
                    disabled={disabled}
                    onClick={() => removeItem(index)}
                    aria-label="删除此项"
                    title="删除此项"
                  >
                    <Icon name="trash" size={14}/>
                  </button>
                </div>
              </div>
            ))
          )}
          <div class="structured-footer">
            <button type="button" class="structured-add-btn" disabled={disabled} onClick={addItem}>
              <Icon name="plus" size={14}/>
              <span>添加一项</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function StructuredObjectControl({
  id,
  field,
  value,
  error,
  describedBy,
  disabled,
  onChange,
}: StructuredControlProps) {
  const draft = isJsonDraft(value)
    ? value
    : createJsonDraft(value);
  const parsed = draft.error ? undefined : draft.parsed;
  const visualEligible = !draft.error && (parsed === undefined || isFlatScalarObject(parsed));
  const [jsonMode, setJsonMode] = useState(!visualEligible);
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [kvError, setKvError] = useState<string>();
  const useJson = jsonMode || !visualEligible;

  const entries: Array<[string, string | number | boolean | null]> = parsed && isFlatScalarObject(parsed)
    ? Object.entries(parsed)
    : [];

  function emitRecord(nextEntries: Array<[string, string | number | boolean | null]>): void {
    const record: Record<string, unknown> = {};
    for (const [k, v] of nextEntries) {
      setSafeProperty(record, k, v);
    }
    onChange(createJsonDraft(record));
  }

  function updateEntryValue(index: number, raw: string): void {
    const [key, prev] = entries[index]!;
    let nextVal: string | number | boolean | null = raw;
    if (typeof prev === "number") {
      const num = Number(raw.trim());
      if (raw.trim() !== "" && Number.isFinite(num) && (!Number.isInteger(num) || Number.isSafeInteger(num))) {
        nextVal = num;
      }
    } else if (typeof prev === "boolean") {
      if (raw === "true") nextVal = true;
      else if (raw === "false") nextVal = false;
    }
    const next = [...entries];
    next[index] = [key, nextVal];
    emitRecord(next);
  }

  function updateEntryKey(index: number, nextKey: string): void {
    const trimmed = nextKey.trim();
    if (!trimmed || isForbiddenKey(trimmed)) {
      setKvError("键名不能为空，且不能使用 __proto__ / prototype / constructor");
      return;
    }
    if (entries.some(([k], i) => i !== index && k === trimmed)) {
      setKvError(`键名 "${trimmed}" 已存在`);
      return;
    }
    setKvError(undefined);
    const next = [...entries];
    next[index] = [trimmed, entries[index]![1]];
    emitRecord(next);
  }

  function removeEntry(index: number): void {
    setKvError(undefined);
    emitRecord(entries.filter((_, i) => i !== index));
  }

  function addEntry(): void {
    const trimmed = newKey.trim();
    if (!trimmed) {
      setKvError("请输入键名");
      return;
    }
    if (isForbiddenKey(trimmed)) {
      setKvError("键名不能使用 __proto__ / prototype / constructor");
      return;
    }
    if (entries.some(([k]) => k === trimmed)) {
      setKvError(`键名 "${trimmed}" 已存在`);
      return;
    }
    setKvError(undefined);
    emitRecord([...entries, [trimmed, newVal]]);
    setNewKey("");
    setNewVal("");
  }

  return (
    <div class="code-control structured-control">
      <div class="code-control__bar">
        <div class="structured-control__title">
          <span>{useJson ? "JSON" : "KEY / VALUE"}</span>
          <small>{useJson ? "对象源码" : `${entries.length} 个键值`}</small>
        </div>
        <button
          type="button"
          class="structured-mode-toggle"
          disabled={disabled || (!useJson ? false : !visualEligible)}
          title={!visualEligible && useJson ? "包含嵌套对象或格式有误，仅支持 JSON 源码编辑" : undefined}
          onClick={() => setJsonMode(!useJson)}
        >
          <Icon name={useJson ? "layers" : "code"} size={13}/>
          <span>{useJson ? "键值表" : "JSON 源码"}</span>
        </button>
      </div>
      {useJson ? (
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
      ) : (
        <div class="structured-list" id={id} aria-describedby={describedBy}>
          {entries.length === 0 ? (
            <div class="structured-empty">暂无键值项，可在下方新增</div>
          ) : (
            entries.map(([key, val], index) => (
              <div class="structured-kv-row" key={`${key}-${index}`}>
                <input
                  class="control structured-kv-row__key"
                  type="text"
                  value={key}
                  disabled={disabled}
                  aria-label={`${field.label} 键 ${key}`}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== key) updateEntryKey(index, event.currentTarget.value);
                  }}
                />
                <input
                  class="control structured-kv-row__val"
                  type="text"
                  value={val === null ? "" : String(val)}
                  placeholder={val === null ? "null" : "值"}
                  disabled={disabled}
                  aria-label={`${field.label} 值 ${key}`}
                  onInput={(event) => updateEntryValue(index, event.currentTarget.value)}
                />
                <button
                  type="button"
                  class="icon-button structured-row__delete"
                  disabled={disabled}
                  onClick={() => removeEntry(index)}
                  aria-label={`删除 ${key}`}
                  title="删除"
                >
                  <Icon name="trash" size={14}/>
                </button>
              </div>
            ))
          )}
          <div class="structured-kv-add">
            <input
              class="control"
              type="text"
              value={newKey}
              placeholder="新键名"
              disabled={disabled}
              onInput={(event) => setNewKey(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addEntry(); } }}
            />
            <input
              class="control"
              type="text"
              value={newVal}
              placeholder="值"
              disabled={disabled}
              onInput={(event) => setNewVal(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addEntry(); } }}
            />
            <button type="button" class="structured-add-btn" disabled={disabled} onClick={addEntry}>
              <Icon name="plus" size={14}/>
              <span>添加</span>
            </button>
          </div>
          {kvError && <p class="field-error structured-kv-error"><Icon name="warning" size={13}/>{kvError}</p>}
        </div>
      )}
    </div>
  );
}
