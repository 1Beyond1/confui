import type { ConfigChange, ConfigFormat, FieldSpec, FieldType, Locale, PathSegment } from "../../shared/schema.ts";
import { isForbiddenKey, isHexColor } from "../../shared/validation.ts";
import { translate } from "./i18n/index.tsx";

export interface JsonDraft {
  __confuiJsonDraft: true;
  text: string;
  parsed: unknown;
  error?: string;
}

export type EditorValues = Record<string, unknown>;
export type FieldStatusFilter = "all" | "modified" | "error" | "required";

export function filterFieldsByStatus(
  fields: readonly FieldSpec[],
  values: EditorValues,
  errors: ReadonlyMap<string, string>,
  customKeys: ReadonlySet<string> | undefined,
  status: FieldStatusFilter,
): FieldSpec[] {
  if (status === "all") return [...fields];
  return fields.filter((field) => {
    const key = fieldKey(field);
    if (status === "modified") {
      return Boolean(customKeys?.has(key)) || isFieldModified(field, values[key]);
    }
    if (status === "error") {
      return errors.has(key);
    }
    if (status === "required") {
      return field.required === true;
    }
    return true;
  });
}

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

export function validateField(
  field: FieldSpec,
  editorValue: unknown,
  format?: ConfigFormat,
  locale: Locale = "zh-CN",
): string | undefined {
  if (isJsonDraft(editorValue) && editorValue.error) return translate(locale, "validation.jsonSyntax");
  const value = effectiveValue(editorValue);
  if (
    field.required
    && (value === undefined || value === null || value === "")
    && !isInactiveExamplePlaceholder(field, value)
  ) {
    return translate(locale, "validation.required");
  }
  const explicitJson = isJsonDraft(editorValue) && editorValue.text.trim() !== "";
  if (field.type === "array" && (explicitJson || value !== undefined && value !== null)) {
    if (!Array.isArray(value)) return translate(locale, "validation.arrayExpected");
    if (format === "ini") {
      if (value.length === 0) return translate(locale, "validation.iniEmptyArray");
      if (!value.every(isIniScalarValue)) return translate(locale, "validation.iniScalarArray");
    }
  }
  if (field.type === "json" && (explicitJson || value !== undefined && value !== null) && (value === null || Array.isArray(value) || typeof value !== "object")) {
    return translate(locale, "validation.objectExpected");
  }
  if (value === undefined || value === null || value === "") return undefined;
  if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number") return translate(locale, "validation.numberExpected");
    if (!Number.isFinite(value)) return translate(locale, "validation.numberExpected");
    if (field.type === "integer") {
      if (!Number.isInteger(value)) return translate(locale, "validation.integerExpected");
      if (!Number.isSafeInteger(value)) return translate(locale, "validation.safeIntegerExpected");
    }
    if (field.type === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return translate(locale, "validation.numberSafeRange");
    }
    if (field.minimum !== undefined && value < field.minimum) return translate(locale, "validation.minimum", { min: field.minimum });
    if (field.maximum !== undefined && value > field.maximum) return translate(locale, "validation.maximum", { max: field.maximum });
  }
  if (field.type === "boolean" && typeof value !== "boolean") return translate(locale, "validation.booleanExpected");
  if (field.type === "enum" && field.enum?.length && !field.enum.some((option) => enumValueEqual(option, value))) {
    return translate(locale, "validation.enumExpected");
  }
  if (typeof value === "string") {
    if (field.type === "color" && !isHexColor(value)) return translate(locale, "validation.colorExpected");
    if (field.minLength !== undefined && value.length < field.minLength) return translate(locale, "validation.minLength", { min: field.minLength });
    if (field.maxLength !== undefined && value.length > field.maxLength) return translate(locale, "validation.maxLength", { max: field.maxLength });
    if (field.pattern) {
      try {
        if (!new RegExp(field.pattern).test(value)) return translate(locale, "validation.pattern");
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
  locale: Locale = "zh-CN",
): Map<string, string> {
  const errors = new Map<string, string>();
  for (const field of fields) {
    const error = validateField(field, values[fieldKey(field)], format, locale);
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
  locale: Locale = "zh-CN",
): { segments: PathSegment[]; error?: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) return { segments: [], error: translate(locale, "validation.keyRequired") };
  if (trimmed.includes("\0") || trimmed.length > 512) {
    return { segments: [], error: translate(locale, "validation.keyInvalid") };
  }

  let segments: string[];
  if (format === "env") {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
      return { segments: [], error: translate(locale, "validation.keyEnvInvalid") };
    }
    segments = [trimmed];
  } else if (format === "properties") {
    segments = [trimmed];
  } else {
    segments = trimmed.split(".").map((part) => part.trim());
    if (segments.some((part) => !part)) {
      return { segments: [], error: translate(locale, "validation.keyEmptySegment") };
    }
  }

  if (segments.length > 32) {
    return { segments: [], error: translate(locale, "validation.keyTooDeep") };
  }
  if (segments.some(isForbiddenKey)) {
    return { segments: [], error: translate(locale, "validation.keyForbidden") };
  }

  const candidateKey = JSON.stringify(segments);
  for (const existing of existingFields) {
    if (fieldKey(existing) === candidateKey) {
      return { segments: [], error: translate(locale, "validation.keyExists") };
    }
    if (isStrictSegmentPrefix(existing.segments, segments) || isStrictSegmentPrefix(segments, existing.segments)) {
      return { segments: [], error: translate(locale, "validation.keyParentConflict", { path: existing.path }) };
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

/**
 * Returns true when keyboard focus or event target resides inside a native text
 * editing element (`<input>`, `<textarea>`, or `[contenteditable]`) so global
 * `Ctrl+Z` / `Ctrl+Y` undo shortcuts never hijack native input editing.
 */
export function isEditableKeyboardTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const node = target as {
    tagName?: unknown;
    isContentEditable?: unknown;
    parentElement?: unknown;
    closest?: (selector: string) => unknown;
    getAttribute?: (name: string) => string | null;
  };
  const element = typeof node.tagName === "string" ? node : (node.parentElement as typeof node | undefined);
  if (!element || typeof element !== "object") return false;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.getAttribute === "function") {
    const attr = element.getAttribute("contenteditable");
    if (attr !== null && attr.toLowerCase() !== "false") return true;
  }
  if (typeof element.closest === "function") {
    if (element.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) {
      return true;
    }
  }
  return false;
}
