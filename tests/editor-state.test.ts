import { describe, expect, it } from "vitest";
import type { ConfigFormSchema, FieldSpec, FileVersion, SavePreview } from "../shared/schema.ts";
import {
  collectChanges,
  createCustomFieldSpec,
  createJsonDraft,
  fieldKey,
  filterFieldsByStatus,
  initializeEditorValues,
  isEditorDirty,
  isSafeRegexPattern,
  parseJsonDraft,
  reconcileSavedState,
  validationErrors,
} from "../web/src/editor-state.ts";

function field(patch: Partial<FieldSpec>): FieldSpec {
  return {
    path: "featureFlag",
    segments: ["featureFlag"],
    label: "Feature Flag",
    type: "string",
    source: "example",
    confidence: 0.8,
    evidence: [],
    ...patch,
  };
}

describe("editor state", () => {
  it("shows an example default as guidance without turning it into an implicit edit", () => {
    const fields = [field({ value: undefined, default: "enabled" })];
    const values = initializeEditorValues(fields);
    expect(values[fieldKey(fields[0]!)]).toBeUndefined();
    expect(collectChanges(fields, values)).toEqual([]);
  });

  it("blocks invalid JSON and required empty fields", () => {
    const json = field({ path: "items", segments: ["items"], type: "array", required: true, value: [] });
    const values = initializeEditorValues([json]);
    values[fieldKey(json)] = parseJsonDraft("[invalid");
    expect(validationErrors([json], values).get(fieldKey(json))).toContain("JSON");
  });

  it("coerces documented flat-file scalars without creating implicit changes", () => {
    const enabled = field({ path: "ENABLED", segments: ["ENABLED"], type: "boolean", value: "true" });
    const port = field({ path: "PORT", segments: ["PORT"], type: "integer", value: "3000" });
    const values = initializeEditorValues([enabled, port]);

    expect(values[fieldKey(enabled)]).toBe(true);
    expect(values[fieldKey(port)]).toBe(3000);
    expect(collectChanges([enabled, port], values)).toEqual([]);
    values[fieldKey(port)] = 8080;
    expect(collectChanges([enabled, port], values)).toEqual([{ segments: ["PORT"], value: 8080 }]);
  });

  it("validates JSON shape, enum membership and color values", () => {
    const list = field({ path: "items", segments: ["items"], type: "array", value: [] });
    const mode = field({ path: "mode", segments: ["mode"], type: "enum", enum: ["safe", "fast"], value: "safe" });
    const color = field({ path: "color", segments: ["color"], type: "color", value: "#ffffff" });
    const values = initializeEditorValues([list, mode, color]);
    values[fieldKey(list)] = parseJsonDraft("null");
    values[fieldKey(mode)] = "unknown";
    values[fieldKey(color)] = "rgb(0, 0, 0)";
    const errors = validationErrors([list, mode, color], values);
    expect(errors.get(fieldKey(list))).toBe("请输入 JSON 数组");
    expect(errors.get(fieldKey(mode))).toBe("请选择列表中的有效选项");
    expect(errors.get(fieldKey(color))).toBe("请输入有效的十六进制颜色");
  });

  it("accepts only standard CSS hex color lengths", () => {
    const color = field({ path: "color", segments: ["color"], type: "color" });

    expect(validationErrors([color], { [fieldKey(color)]: "#12345" }).get(fieldKey(color)))
      .toBe("请输入有效的十六进制颜色");
    expect(validationErrors([color], { [fieldKey(color)]: "#1234567" }).get(fieldKey(color)))
      .toBe("请输入有效的十六进制颜色");
    expect(validationErrors([color], { [fieldKey(color)]: "#1234" }).has(fieldKey(color))).toBe(false);
    expect(validationErrors([color], { [fieldKey(color)]: "#12345678" }).has(fieldKey(color))).toBe(false);
  });

  it("keeps enum types distinct and allows an empty-string option", () => {
    const mixed = field({ path: "mode", segments: ["mode"], type: "enum", enum: [1, "1", ""] });

    expect(validationErrors([mixed], { [fieldKey(mixed)]: 1 }).size).toBe(0);
    expect(validationErrors([mixed], { [fieldKey(mixed)]: "1" }).size).toBe(0);
    expect(validationErrors([mixed], { [fieldKey(mixed)]: "" }).size).toBe(0);
    expect(validationErrors([mixed], { [fieldKey(mixed)]: true }).get(fieldKey(mixed))).toBe("请选择列表中的有效选项");

    const flatFileEnum = field({ path: "MODE", segments: ["MODE"], type: "enum", enum: [1, 2], value: "1" });
    const flatValues = initializeEditorValues([flatFileEnum]);
    expect(flatValues[fieldKey(flatFileEnum)]).toBe(1);
    expect(validationErrors([flatFileEnum], flatValues)).toEqual(new Map());
    expect(collectChanges([flatFileEnum], flatValues)).toEqual([]);
    flatValues[fieldKey(flatFileEnum)] = 2;
    expect(collectChanges([flatFileEnum], flatValues)).toEqual([{ segments: ["MODE"], value: 2 }]);
    flatValues[fieldKey(flatFileEnum)] = 1;
    expect(collectChanges([flatFileEnum], flatValues)).toEqual([]);
  });

  it("aligns INI array validation with backend scalar-array constraints", () => {
    const tags = field({ path: "app.tags", segments: ["app", "tags"], type: "array", value: ["one"] });
    const values = initializeEditorValues([tags]);
    values[fieldKey(tags)] = parseJsonDraft("[]");
    expect(validationErrors([tags], values, "ini").get(fieldKey(tags))).toContain("空数组");
    expect(validationErrors([tags], values, "json").size).toBe(0);

    values[fieldKey(tags)] = parseJsonDraft('[{"nested":true}]');
    expect(validationErrors([tags], values, "ini").get(fieldKey(tags))).toContain("INI 数组只支持");
  });

  it("rejects integer-valued numbers outside JavaScript's safe range", () => {
    const integer = field({ path: "requestId", segments: ["requestId"], type: "integer" });
    const number = field({ path: "count", segments: ["count"], type: "number" });

    expect(validationErrors([integer], { [fieldKey(integer)]: Number.MAX_SAFE_INTEGER + 1 })
      .get(fieldKey(integer))).toBe("请输入安全范围内的整数");
    expect(validationErrors([number], { [fieldKey(number)]: Number.MAX_SAFE_INTEGER + 1 })
      .get(fieldKey(number))).toBe("整数超过 JavaScript 安全范围，无法安全保存");
  });

  it("does not let untouched example placeholders block saving, while still enforcing existing or schema required fields", () => {
    const examplePlaceholder = field({
      path: "STRIPE_KEY",
      segments: ["STRIPE_KEY"],
      required: true,
      value: undefined,
      placeholder: "<your-stripe-key>",
      source: "readme",
      evidence: [
        { property: "description", source: "readme", confidence: 0.8 },
        { property: "required", source: "example", confidence: 0.82 },
      ],
    });
    const existingRequired = field({
      path: "API_KEY",
      segments: ["API_KEY"],
      required: true,
      value: "live-key",
      source: "example",
      evidence: [{ property: "required", source: "example", confidence: 0.82 }],
    });
    const schemaRequired = field({
      path: "PORT",
      segments: ["PORT"],
      type: "integer",
      required: true,
      value: undefined,
      source: "json-schema",
      evidence: [{ property: "required", source: "json-schema", confidence: 0.995 }],
    });
    const otherField = field({
      path: "HOST",
      segments: ["HOST"],
      value: "localhost",
      source: "heuristic",
    });

    const values = initializeEditorValues([examplePlaceholder, existingRequired, otherField]);
    values[fieldKey(otherField)] = "0.0.0.0";
    // Untouched example placeholder must not block saving another modified field.
    expect(validationErrors([examplePlaceholder, existingRequired, otherField], values).size).toBe(0);

    // Clearing an existing required field must still block saving.
    values[fieldKey(existingRequired)] = "";
    expect(validationErrors([examplePlaceholder, existingRequired, otherField], values).get(fieldKey(existingRequired)))
      .toBe("这是必填项");

    // Actively typing an empty value into the example placeholder triggers required validation.
    values[fieldKey(examplePlaceholder)] = "";
    expect(validationErrors([examplePlaceholder], values).get(fieldKey(examplePlaceholder))).toBe("这是必填项");

    // Schema-declared required fields remain enforced even when absent from the file.
    const schemaValues = initializeEditorValues([schemaRequired]);
    expect(validationErrors([schemaRequired], schemaValues).get(fieldKey(schemaRequired))).toBe("这是必填项");
  });

  it("blocks ReDoS patterns from untrusted schemas/AI while preserving valid pattern validation", () => {
    // Dangerous nested quantifier / overlapping alternation / backreference / oversized patterns
    expect(isSafeRegexPattern("(a+)+$")).toBe(false);
    expect(isSafeRegexPattern("(a*)*$")).toBe(false);
    expect(isSafeRegexPattern("([a-zA-Z]+)*$")).toBe(false);
    expect(isSafeRegexPattern("(a|aa)+$")).toBe(false);
    expect(isSafeRegexPattern("(\\w|\\d)+$")).toBe(false);
    expect(isSafeRegexPattern("(a+)\\1")).toBe(false);
    expect(isSafeRegexPattern("a".repeat(600))).toBe(false);
    expect(isSafeRegexPattern(".*.*x")).toBe(false);

    // Safe real-world schema patterns remain allowed
    expect(isSafeRegexPattern("^[a-z0-9-]+$")).toBe(true);
    expect(isSafeRegexPattern("^\\d{1,3}(\\.\\d{1,3}){3}$")).toBe(true);
    expect(isSafeRegexPattern("^https?://.+")).toBe(true);
    expect(isSafeRegexPattern("^[A-Za-z_][A-Za-z0-9_]*$")).toBe(true);

    // Adversarial ReDoS payload against validateField returns immediately without hanging
    const redosField = field({ path: "slug", segments: ["slug"], pattern: "(a+)+$" });
    const evilInput = `${"a".repeat(32)}!`;
    const started = performance.now();
    const errs = validationErrors([redosField], { [fieldKey(redosField)]: evilInput });
    expect(performance.now() - started).toBeLessThan(100);
    expect(errs.size).toBe(0);

    // Valid pattern still rejects invalid input and accepts valid input
    const slugField = field({ path: "slug", segments: ["slug"], pattern: "^[a-z0-9-]+$" });
    expect(validationErrors([slugField], { [fieldKey(slugField)]: "BAD SLUG" }).get(fieldKey(slugField))).toBeDefined();
    expect(validationErrors([slugField], { [fieldKey(slugField)]: "good-slug-1" }).size).toBe(0);
  });

  it("never forges unwritten in-memory edits as saved during partial sync reconciliation", () => {
    const portField = field({ path: "PORT", segments: ["PORT"], type: "integer", value: 3000 });
    const logField = field({ path: "LOG_LEVEL", segments: ["LOG_LEVEL"], type: "string", value: "info" });
    const baseVersion: FileVersion = { mtimeMs: 1, size: 30, hash: "a".repeat(64) };
    const nextVersion: FileVersion = { mtimeMs: 2, size: 32, hash: "b".repeat(64) };
    const schema: ConfigFormSchema = {
      file: ".env",
      kind: "env",
      format: "env",
      fields: [portField, logField],
      sources: [],
      writable: true,
      warnings: [],
      exampleFiles: [],
      version: baseVersion,
      rawText: "PORT=3000\nLOG_LEVEL=info\n",
    };

    const customField = createCustomFieldSpec(["UNSAVED_CUSTOM"], "string", "Custom");
    const values = {
      ...initializeEditorValues([portField, logField]),
      [fieldKey(portField)]: 9999, // User edited PORT in-memory, NOT included in partial sync
      [fieldKey(customField)]: "draft-only",
    };

    // Partial SavePreview writes ONLY LOG_LEVEL=warn to disk (PORT stays 3000 on disk!)
    const partialPreview: SavePreview = {
      projectRoot: "/tmp/proj",
      file: ".env",
      format: "env",
      changes: [{ path: "LOG_LEVEL", before: "info", after: "warn" }],
      operations: [{ segments: ["LOG_LEVEL"], value: "warn" }],
      output: "PORT=3000\nLOG_LEVEL=warn\n",
      warnings: [],
      expectedVersion: baseVersion,
    };

    const reconciled = reconcileSavedState(schema, values, [customField], partialPreview, nextVersion);
    // LOG_LEVEL advanced to its disk value "warn"
    expect(reconciled.schema.fields.find((f) => f.path === "LOG_LEVEL")?.value).toBe("warn");
    expect(reconciled.values[fieldKey(logField)]).toBe("warn");
    // PORT on-disk baseline MUST remain 3000 while draft editor value remains 9999!
    expect(reconciled.schema.fields.find((f) => f.path === "PORT")?.value).toBe(3000);
    expect(reconciled.values[fieldKey(portField)]).toBe(9999);
    // Unsaved custom field MUST NOT be dropped
    expect(reconciled.customFields).toHaveLength(1);
    expect(reconciled.values[fieldKey(customField)]).toBe("draft-only");
    // Editor MUST remain dirty with both unwritten changes intact
    expect(reconciled.hasRemainingDirty).toBe(true);
    const remainingChanges = collectChanges([...reconciled.schema.fields, ...reconciled.customFields], reconciled.values);
    expect(remainingChanges).toEqual([
      { segments: ["PORT"], value: 9999 },
      { segments: ["UNSAVED_CUSTOM"], value: "draft-only" },
    ]);
  });

  it("does not mark an empty cleared custom field as dirty when there are no writable changes", () => {
    const existing = field({ path: "PORT", segments: ["PORT"], type: "integer", value: 3000 });
    const emptyCustom = createCustomFieldSpec(["EXTRA_JSON"], "json", "Custom");
    const stringCustom = createCustomFieldSpec(["EXTRA_STR"], "string", "Custom");
    const fields = [existing, emptyCustom];

    // Custom JSON field cleared back to empty text (parsed === undefined, no error)
    const clearedValues = {
      ...initializeEditorValues([existing]),
      [fieldKey(emptyCustom)]: createJsonDraft(undefined),
    };
    expect(collectChanges(fields, clearedValues)).toEqual([]);
    expect(isEditorDirty(fields, clearedValues)).toBe(false);
    expect(filterFieldsByStatus(fields, clearedValues, new Map(), new Set([fieldKey(emptyCustom)]), "modified")).toEqual([]);

    // Custom JSON field with syntax error IS dirty
    const invalidValues = {
      ...initializeEditorValues([existing]),
      [fieldKey(emptyCustom)]: parseJsonDraft("{bad"),
    };
    expect(isEditorDirty(fields, invalidValues)).toBe(true);

    // Custom string field with explicit empty string "" IS a real writable change
    const strValues = {
      ...initializeEditorValues([existing]),
      [fieldKey(stringCustom)]: "",
    };
    expect(collectChanges([existing, stringCustom], strValues)).toEqual([{ segments: ["EXTRA_STR"], value: "" }]);
    expect(isEditorDirty([existing, stringCustom], strValues)).toBe(true);
  });
});
