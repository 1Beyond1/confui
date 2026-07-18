import type { ConfigChange, FieldSpec } from "../../shared/schema.ts";

export interface JsonDraft {
  __confuiJsonDraft: true;
  text: string;
  parsed: unknown;
  error?: string;
}

export type EditorValues = Record<string, unknown>;

export function fieldKey(field: Pick<FieldSpec, "segments">): string {
  return JSON.stringify(field.segments);
}

export function initializeEditorValues(fields: readonly FieldSpec[]): EditorValues {
  return Object.fromEntries(fields.map((field) => {
    // Defaults are guidance, not implicit edits. Fields discovered only in an
    // example file must stay empty until the user chooses to add them.
    const value = normalizeEditorValue(field, field.value);
    return [fieldKey(field), needsJsonEditor(field)
      ? createJsonDraft(value)
      : value];
  }));
}

export function createJsonDraft(value: unknown): JsonDraft {
  return {
    __confuiJsonDraft: true,
    text: value === undefined ? "" : JSON.stringify(value, null, 2),
    parsed: value,
  };
}

export function parseJsonDraft(text: string): JsonDraft {
  if (!text.trim()) return { __confuiJsonDraft: true, text, parsed: undefined };
  try {
    return { __confuiJsonDraft: true, text, parsed: JSON.parse(text) };
  } catch (error) {
    return {
      __confuiJsonDraft: true,
      text,
      parsed: undefined,
      error: error instanceof Error ? error.message : "JSON 格式错误",
    };
  }
}

export function isJsonDraft(value: unknown): value is JsonDraft {
  return value !== null && typeof value === "object" && (value as JsonDraft).__confuiJsonDraft === true;
}

export function effectiveValue(value: unknown): unknown {
  return isJsonDraft(value) ? value.parsed : value;
}

export function collectChanges(fields: readonly FieldSpec[], values: EditorValues): ConfigChange[] {
  return fields.flatMap((field) => {
    const value = effectiveValue(values[fieldKey(field)]);
    const original = normalizeEditorValue(field, field.value);
    return deepEqual(value, original) ? [] : [{ segments: [...field.segments], value }];
  });
}

export function validateField(field: FieldSpec, editorValue: unknown): string | undefined {
  if (isJsonDraft(editorValue) && editorValue.error) return "JSON 格式有误，请修正后再保存";
  const value = effectiveValue(editorValue);
  if (field.required && (value === undefined || value === null || value === "")) return "这是必填项";
  const explicitJson = isJsonDraft(editorValue) && editorValue.text.trim() !== "";
  if (field.type === "array" && (explicitJson || value !== undefined && value !== null) && !Array.isArray(value)) {
    return "请输入 JSON 数组";
  }
  if (field.type === "json" && (explicitJson || value !== undefined && value !== null) && (value === null || Array.isArray(value) || typeof value !== "object")) {
    return "请输入 JSON 对象";
  }
  if (value === undefined || value === null || value === "") return undefined;
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number") return "请输入有效数字";
    if (!Number.isFinite(value)) return "请输入有效数字";
    if (field.type === "integer" && !Number.isInteger(value)) return "请输入整数";
    if (field.minimum !== undefined && value < field.minimum) return `不能小于 ${field.minimum}`;
    if (field.maximum !== undefined && value > field.maximum) return `不能大于 ${field.maximum}`;
  }
  if (field.type === "boolean" && typeof value !== "boolean") return "请使用开关选择布尔值";
  if (field.type === "enum" && field.enum?.length && !field.enum.some((option) => String(option) === String(value))) {
    return "请选择列表中的有效选项";
  }
  if (typeof value === "string") {
    if (field.type === "color" && !/^#[\da-f]{3,8}$/i.test(value)) return "请输入有效的十六进制颜色";
    if (field.minLength !== undefined && value.length < field.minLength) return `至少需要 ${field.minLength} 个字符`;
    if (field.maxLength !== undefined && value.length > field.maxLength) return `最多允许 ${field.maxLength} 个字符`;
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) return "内容不符合此字段要求的格式";
      } catch {
        // Invalid third-party schema patterns should not block editing.
      }
    }
  }
  return undefined;
}

export function validationErrors(fields: readonly FieldSpec[], values: EditorValues): Map<string, string> {
  const errors = new Map<string, string>();
  for (const field of fields) {
    const error = validateField(field, values[fieldKey(field)]);
    if (error) errors.set(fieldKey(field), error);
  }
  return errors;
}

export function needsJsonEditor(field: FieldSpec): boolean {
  return field.type === "array" || field.type === "json";
}

function normalizeEditorValue(field: Pick<FieldSpec, "type">, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (field.type === "boolean") {
    if (/^(?:true|1|yes|on)$/i.test(trimmed)) return true;
    if (/^(?:false|0|no|off)$/i.test(trimmed)) return false;
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(trimmed);
    if (trimmed && Number.isFinite(number) && (field.type !== "integer" || Number.isInteger(number))) return number;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
