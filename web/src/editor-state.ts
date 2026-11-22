import type {
  ConfigChange,
  ConfigFormat,
  ConfigFormSchema,
  FieldSpec,
  FieldType,
  FileVersion,
  Locale,
  PathSegment,
  SavePreview,
} from "../../shared/schema.ts";
import { isForbiddenKey, isHexColor } from "../../shared/validation.ts";
import { translate } from "./i18n/index.tsx";

const MAX_REGEX_PATTERN_LENGTH = 512;
const MAX_REGEX_TEST_VALUE_LENGTH = 4_096;
const MAX_REGEX_GROUP_DEPTH = 6;
const MAX_REGEX_UNBOUNDED_QUANTIFIERS = 20;
const MAX_REGEX_BRACE_BOUND = 1_000;

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
  _customKeys: ReadonlySet<string> | undefined,
  status: FieldStatusFilter,
): FieldSpec[] {
  if (status === "all") return [...fields];
  return fields.filter((field) => {
    const key = fieldKey(field);
    if (status === "modified") {
      return isFieldModified(field, values[key]);
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

/**
 * Returns true when at least one field has an actual uncommitted change or
 * invalid JSON draft. An added custom field whose value was cleared back to
 * `undefined` without errors does not falsely keep the editor dirty.
 */
export function isEditorDirty(fields: readonly FieldSpec[], values: EditorValues): boolean {
  return fields.some((field) => isFieldModified(field, values[fieldKey(field)]));
}

/**
 * Reconciles in-memory schema and editor draft state after a `SavePreview` is
 * committed to disk. Only keys actually present in `savePreview.operations`
 * advance their on-disk baseline; any unwritten in-memory edits or unsaved
 * custom fields are preserved intact so `dirty` is never falsely cleared.
 */
export function reconcileSavedState(
  schema: ConfigFormSchema,
  values: EditorValues,
  customFields: readonly FieldSpec[],
  savePreview: SavePreview,
  savedVersion: FileVersion,
): {
  schema: ConfigFormSchema;
  values: EditorValues;
  customFields: FieldSpec[];
  hasRemainingDirty: boolean;
} {
  const savedValues = new Map(
    savePreview.operations.map((operation) => [JSON.stringify(operation.segments), operation.value]),
  );

  const nextValues: EditorValues = {};
  const nextFields: FieldSpec[] = schema.fields.map((field) => {
    const key = fieldKey(field);
    if (savedValues.has(key)) {
      const updatedField: FieldSpec = { ...field, value: savedValues.get(key) };
      nextValues[key] = initialFieldEditorValue(updatedField);
      return updatedField;
    }
    nextValues[key] = values[key];
    return field;
  });

  const nextCustomFields: FieldSpec[] = [];
  for (const field of customFields) {
    const key = fieldKey(field);
    if (savedValues.has(key)) {
      const writtenValue = savedValues.get(key);
      if (writtenValue !== undefined) {
        const promoted: FieldSpec = { ...field, value: writtenValue };
        nextFields.push(promoted);
        nextValues[key] = initialFieldEditorValue(promoted);
      }
      continue;
    }
    nextCustomFields.push(field);
    nextValues[key] = values[key];
  }

  const nextSchema: ConfigFormSchema = {
    ...schema,
    fields: nextFields,
    rawText: savePreview.output,
    version: savedVersion,
  };
  const combinedFields = [...nextFields, ...nextCustomFields];
  return {
    schema: nextSchema,
    values: nextValues,
    customFields: nextCustomFields,
    hasRemainingDirty: isEditorDirty(combinedFields, nextValues),
  };
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
    if (field.pattern && value.length <= MAX_REGEX_TEST_VALUE_LENGTH && isSafeRegexPattern(field.pattern)) {
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

/**
 * Resolves a search hit target (`focusPath` / `focusSegments`) to either an
 * exact `FieldSpec` or its deepest enclosing parent `FieldSpec` when the target
 * leaf lives inside a collapsed JSON/object/array field (e.g. `scripts.test` ->
 * `scripts` in `package.json`).
 */
export function resolveFocusField(
  fields: readonly FieldSpec[],
  focusPath: string,
  focusSegments?: readonly PathSegment[],
): FieldSpec | undefined {
  if (focusSegments?.length) {
    const exactKey = JSON.stringify(focusSegments);
    const exactBySegments = fields.find((field) => fieldKey(field) === exactKey);
    if (exactBySegments) return exactBySegments;
  }
  const exactByPath = fields.find((field) => field.path === focusPath);
  if (exactByPath) return exactByPath;

  if (focusSegments?.length) {
    let bestAncestor: FieldSpec | undefined;
    for (const field of fields) {
      if (isStrictSegmentPrefix(field.segments, focusSegments)) {
        if (!bestAncestor || field.segments.length > bestAncestor.segments.length) {
          bestAncestor = field;
        }
      }
    }
    if (bestAncestor) return bestAncestor;
  }

  let bestByPath: FieldSpec | undefined;
  for (const field of fields) {
    if (
      focusPath.length > field.path.length
      && (focusPath.startsWith(`${field.path}.`) || focusPath.startsWith(`${field.path}[`))
    ) {
      if (!bestByPath || field.path.length > bestByPath.path.length) {
        bestByPath = field;
      }
    }
  }
  return bestByPath;
}

function isStrictSegmentPrefix(prefix: readonly PathSegment[], full: readonly PathSegment[]): boolean {
  return prefix.length < full.length && prefix.every((part, idx) => part === full[idx]);
}

/**
 * Static linear-time ReDoS guard for regex patterns sourced from untrusted
 * `$schema` files or AI inference. Rejects overly long patterns, backreferences,
 * nested quantifiers (star-height > 1), repeated alternation groups, and
 * consecutive unbounded wildcard sequences.
 */
export function isSafeRegexPattern(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;
  interface GroupFrame {
    hasQuantifier: boolean;
    hasAlternation: boolean;
    isLookaround: boolean;
  }
  const stack: GroupFrame[] = [];
  let lastToken: "none" | "atom" | "group" | "quantifier" = "none";
  let lastAtomWasDot = false;
  let lastClosedGroup: GroupFrame | undefined;
  let unboundedCount = 0;
  let prevWasWildcardRepeat = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      if (i + 1 >= pattern.length) return false;
      const next = pattern[i + 1]!;
      if ((next >= "1" && next <= "9") || next === "k") return false;
      i += 1;
      lastToken = "atom";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "[") {
      let closed = false;
      for (i += 1; i < pattern.length; i += 1) {
        if (pattern[i] === "\\") {
          i += 1;
          continue;
        }
        if (pattern[i] === "]") {
          closed = true;
          break;
        }
      }
      if (!closed) return false;
      lastToken = "atom";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "(") {
      if (stack.length >= MAX_REGEX_GROUP_DEPTH) return false;
      let isLookaround = false;
      if (pattern[i + 1] === "?") {
        if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) {
          isLookaround = true;
          i += 3;
        } else if (pattern.startsWith("(?=", i) || pattern.startsWith("(?!", i)) {
          isLookaround = true;
          i += 2;
        } else if (pattern.startsWith("(?:", i)) {
          i += 2;
        } else if (pattern.startsWith("(?<", i)) {
          const endName = pattern.indexOf(">", i + 3);
          if (endName < 0) return false;
          i = endName;
        }
      }
      stack.push({ hasQuantifier: false, hasAlternation: false, isLookaround });
      lastToken = "none";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === ")") {
      const closed = stack.pop();
      if (!closed) return false;
      if (closed.isLookaround && closed.hasQuantifier) return false;
      if (closed.hasQuantifier && stack.length > 0) {
        stack.at(-1)!.hasQuantifier = true;
      }
      lastClosedGroup = closed;
      lastToken = "group";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "|") {
      if (stack.length > 0) stack.at(-1)!.hasAlternation = true;
      lastToken = "none";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "?" && lastToken === "quantifier") {
      // Lazy quantifier suffix (`*?`, `+?`, `{m,n}?`)
      continue;
    }

    let quant: { min: number; max: number; isUnbounded: boolean } | undefined;
    if (ch === "*") {
      quant = { min: 0, max: Number.POSITIVE_INFINITY, isUnbounded: true };
    } else if (ch === "+") {
      quant = { min: 1, max: Number.POSITIVE_INFINITY, isUnbounded: true };
    } else if (ch === "?") {
      quant = { min: 0, max: 1, isUnbounded: false };
    } else if (ch === "{") {
      const braceMatch = pattern.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (braceMatch) {
        const min = Number(braceMatch[1]);
        const hasComma = braceMatch[0].includes(",");
        const max = !hasComma
          ? min
          : braceMatch[2]
            ? Number(braceMatch[2])
            : Number.POSITIVE_INFINITY;
        if (!Number.isFinite(min) || (Number.isFinite(max) && max < min)) return false;
        quant = { min, max, isUnbounded: !Number.isFinite(max) };
        i += braceMatch[0].length - 1;
      }
    }

    if (quant) {
      if (lastToken === "none" || lastToken === "quantifier") return false;
      if (quant.min > MAX_REGEX_BRACE_BOUND || (Number.isFinite(quant.max) && quant.max > MAX_REGEX_BRACE_BOUND)) {
        return false;
      }
      if (quant.isUnbounded) {
        unboundedCount += 1;
        if (unboundedCount > MAX_REGEX_UNBOUNDED_QUANTIFIERS) return false;
      }
      const repeatsMultiple = quant.isUnbounded || quant.max > 1;
      if (lastToken === "group" && lastClosedGroup && repeatsMultiple) {
        const highRepeat = quant.isUnbounded || quant.max > 5;
        if (lastClosedGroup.hasQuantifier && highRepeat) return false;
        if (lastClosedGroup.hasAlternation && highRepeat) return false;
      }
      if (repeatsMultiple && stack.length > 0) {
        stack.at(-1)!.hasQuantifier = true;
      }
      if (lastToken === "atom" && lastAtomWasDot && quant.isUnbounded) {
        if (prevWasWildcardRepeat) return false;
        prevWasWildcardRepeat = true;
      } else {
        prevWasWildcardRepeat = false;
      }
      lastToken = "quantifier";
      lastAtomWasDot = false;
      continue;
    }

    lastToken = "atom";
    lastAtomWasDot = ch === ".";
    if (ch !== ".") prevWasWildcardRepeat = false;
  }

  return stack.length === 0;
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
