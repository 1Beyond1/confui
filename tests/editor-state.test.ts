import { describe, expect, it } from "vitest";
import type { FieldSpec } from "../shared/schema.ts";
import {
  collectChanges,
  fieldKey,
  initializeEditorValues,
  parseJsonDraft,
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
});
