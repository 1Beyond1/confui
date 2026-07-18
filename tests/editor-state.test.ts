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
});
