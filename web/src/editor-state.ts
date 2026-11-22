import type { ConfigChange, ConfigFormat, FieldSpec, FieldType, PathSegment } from "../../shared/schema.ts";
import { isForbiddenKey, isHexColor } from "../../shared/validation.ts";

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

export function isInactiveExamplePlaceholder(field: FieldSpec, value: unknown): boolean {
  if (field.value !== undefined) return false;
  if (value !== undefined) return false;
  const requiredEvidence = field.evidence.find((item) => item.property === "required");
  const requiredSource = requiredEvidence?.source ?? field.source;
  return requiredSource === "example";
}

export function validateField(field: FieldSpec, editorValue: unknown, format?: ConfigFormat): string | undefined {
  if (isJsonDraft(editorValue) && editorValue.error) return "JSON 格式有误，请修正后再保存";
  const value = effectiveValue(editorValue);
  if (
    field.required
    && (value === undefined || value === null || value === "")
    && !isInactiveExamplePlaceholder(field, value)
  ) {
    return "这是必填项";
  }
  const explicitJson = isJsonDraft(editorValue) && editorValue.text.trim() !== "";
  if (field.type === "array" && (explicitJson || value !== undefined && value !== null)) {
    if (!Array.isArray(value)) return "请输入 JSON 数组";
    if (format === "ini") {
      if (value.length === 0) return "INI 不支持空数组；如需移除该配置项请清空输入框";
      if (!value.every(isIniScalarValue)) return "INI 数组只支持字符串、数字、布尔值或 null";
    }
  }
  if (field.type === "json" && (explicitJson || value !== undefined && value !== null) && (value === null || Array.isArray(value) || typeof value !== "object")) {
    return "请输入 JSON 对象";
  }
  if (value === undefined || value === null || value === "") return undefined;
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number") return "请输入有效数字";
    if (!Number.isFinite(value)) return "请输入有效数字";
    if (field.type === "integer") {
      if (!Number.isInteger(value)) return "请输入整数";
      if (!Number.isSafeInteger(value)) return "请输入安全范围内的整数";
    }
    if (field.type === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return "整数超过 JavaScript 安全范围，无法安全保存";
    }
    if (field.minimum !== undefined && value < field.minimum) return `不能小于 ${field.minimum}`;
    if (field.maximum !== undefined && value > field.maximum) return `不能大于 ${field.maximum}`;
  }
  if (field.type === "boolean" && typeof value !== "boolean") return "请使用开关选择布尔值";
  if (field.type === "enum" && field.enum?.length && !field.enum.some((option) => enumValueEqual(option, value))) {
    return "请选择列表中的有效选项";
  }
  if (typeof value === "string") {
    if (field.type === "color" && !isHexColor(value)) return "请输入有效的十六进制颜色";
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

export function validationErrors(
  fields: readonly FieldSpec[],
  values: EditorValues,
  format?: ConfigFormat,
): Map<string, string> {
  const errors = new Map<string, string>();
  for (const field of fields) {
    const error = validateField(field, values[fieldKey(field)], format);
    if (error) errors.set(fieldKey(field), error);
  }
  return errors;
}

export function needsJsonEditor(field: FieldSpec): boolean {
  return field.type === "array" || field.type === "json";
}

/** Match numeric enum options with values read as strings by flat formats. */
export function enumValueEqual(option: string | number, value: unknown): boolean {
  if (Object.is(option, value)) return true;
  if (typeof option === "number" && typeof value === "string" && value.trim() !== "") {
    return Number.isFinite(Number(value)) && Number(value) === option;
  }
  if (typeof option === "string" && typeof value === "number") {
    return Number.isFinite(Number(option)) && Number(option) === value;
  }
  return false;
}

function isIniScalarValue(value: unknown): boolean {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function normalizeEditorValue(field: Pick<FieldSpec, "type" | "enum">, value: unknown): unknown {
  if (value instanceof Date) {
    try {
      return value.toISOString();
    } catch {
      return value;
    }
  }
  if (field.type === "enum" && field.enum?.length) {
    if (field.enum.some((option) => Object.is(option, value))) return value;
    const matched = field.enum.find((option) => enumValueEqual(option, value));
    if (matched !== undefined) return matched;
  }
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (field.type === "boolean") {
    if (/^(?:true|1|yes|on)$/i.test(trimmed)) return true;
    if (/^(?:false|0|no|off)$/i.test(trimmed)) return false;
  }
  if (field.type === "number" || field.type === "integer") {
    const number = Number(trimmed);
    if (trimmed && Number.isFinite(number)
      && (field.type !== "integer" || Number.isSafeInteger(number))
      && (field.type === "integer" || !Number.isInteger(number) || Number.isSafeInteger(number))) return number;
  }
  return value;
}

export function initialFieldEditorValue(field: FieldSpec): unknown {
  const value = normalizeEditorValue(field, field.value);
  return needsJsonEditor(field) ? createJsonDraft(value) : value;
}

export function isFieldModified(field: FieldSpec, editorValue: unknown): boolean {
  if (isJsonDraft(editorValue) && editorValue.error) return true;
  const value = effectiveValue(editorValue);
  const original = normalizeEditorValue(field, field.value);
  return !deepEqual(value, original);
}

export function isEditableScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function isScalarArray(value: unknown): value is Array<string | number | boolean | null> {
  return Array.isArray(value) && value.every(isEditableScalar);
}

export function isFlatScalarObject(value: unknown): value is Record<string, string | number | boolean | null> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(isEditableScalar);
}

export function allowedCustomFieldTypes(format: ConfigFormat): FieldType[] {
  if (format === "env" || format === "properties") {
    return ["string", "integer", "number", "boolean", "secret"];
  }
  if (format === "ini") {
    return ["string", "integer", "number", "boolean", "secret", "array"];
  }
  return ["string", "integer", "number", "boolean", "secret", "array", "json"];
}

export function defaultValueForType(type: FieldType): unknown {
  switch (type) {
    case "boolean": return false;
    case "integer":
    case "number": return 0;
    case "array": return [];
    case "json": return {};
    case "color": return "#2563eb";
    default: return "";
  }
}

export function validateNewKeyPath(
  rawPath: string,
  format: ConfigFormat,
  existingFields: readonly FieldSpec[],
): { segments: PathSegment[]; error?: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) return { segments: [], error: "请输入配置项键名" };
  if (trimmed.includes("\0") || trimmed.length > 512) {
    return { segments: [], error: "键名包含无效字符或长度超限" };
  }

  let segments: string[];
  if (format === "env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      return { segments: [], error: "ENV 键名只允许字母、数字和下划线，且不能以数字开头" };
    }
    segments = [trimmed];
  } else if (format === "properties") {
    segments = [trimmed];
  } else {
    segments = trimmed.split(".").map((part) => part.trim());
    if (segments.some((part) => !part)) {
      return { segments: [], error: "路径中不能包含空白段，例如连续的点号" };
    }
  }

  if (segments.length > 32) {
    return { segments: [], error: "嵌套层级过多" };
  }
  if (segments.some(isForbiddenKey)) {
    return { segments: [], error: "键名不能使用 __proto__、prototype 或 constructor" };
  }

  const candidateKey = JSON.stringify(segments);
  for (const existing of existingFields) {
    if (fieldKey(existing) === candidateKey) {
      return { segments: [], error: "该配置项已存在" };
    }
    if (isStrictSegmentPrefix(existing.segments, segments) || isStrictSegmentPrefix(segments, existing.segments)) {
      return { segments: [], error: `与已有路径 ${existing.path} 存在父子冲突` };
    }
  }
  return { segments };
}

export function createCustomFieldSpec(
  segments: readonly PathSegment[],
  type: FieldType,
  group = "自定义",
): FieldSpec {
  const path = segments
    .map((segment, index) => (typeof segment === "number" ? `[${segment}]` : `${index ? "." : ""}${segment}`))
    .join("");
  const leaf = String(segments.at(-1) ?? path);
  return {
    path,
    segments: [...segments],
    label: leaf,
    type,
    secret: type === "secret" || undefined,
    group,
    value: undefined,
    source: "heuristic",
    confidence: 1,
    evidence: [],
  };
}

function isStrictSegmentPrefix(prefix: readonly PathSegment[], full: readonly PathSegment[]): boolean {
  return prefix.length < full.length && prefix.every((part, idx) => part === full[idx]);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
