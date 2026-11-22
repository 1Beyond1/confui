import { parse as parseTomlLib, stringify as stringifyTomlLib, TomlDate } from "smol-toml";
import type { ConfigChange, PathSegment } from "../../shared/schema.ts";
import { setSafeProperty } from "../../shared/validation.ts";
import { ConfuiError } from "../errors.ts";
import { deleteAtPath, getAtPath, setAtPath } from "../paths.ts";
import { isRecordObject, normalizeLineEndings } from "./common.ts";
import type { UpdateConfigResult } from "./types.ts";

const TOML_DELETE = Symbol("toml-delete");

export function parseToml(source: string): unknown {
  // Keep ordinary integers as numbers but retain valid TOML integers
  // beyond JavaScript's safe range as BigInt instead of rejecting them.
  return parseTomlLib(source, { integersAsBigInt: "asNeeded" });
}

export function stringifyToml(value: Record<string, unknown>): string {
  return stringifyTomlLib(value);
}

export function updateToml(source: string, changes: readonly ConfigChange[]): UpdateConfigResult {
  // `smol-toml` uses TomlDate instances to retain whether a value is a
  // local date/time or an offset date/time. structuredClone turns those
  // into ordinary Date objects, so stringifyToml would silently rewrite
  // offsets and local values even when an unrelated key was edited.
  // Parsing already gives us a fresh tree; mutate that private tree.
  const next = parseToml(source);
  for (const change of changes) {
    if (change.value === undefined) deleteAtPath(next, change.segments);
    else applyTomlChange(next, change.segments, change.value);
  }
  return {
    output: normalizeLineEndings(stringifyToml(next as Record<string, unknown>), source),
    warnings: [
      "TOML 保存会重新排版文件；键和值会保留，但原有注释可能无法完整保留。",
    ],
  };
}

export function applyTomlChange(target: unknown, segments: readonly PathSegment[], value: unknown): void {
  const current = getAtPath(target, segments);
  const converted = coerceTomlValue(current, value, segments, true);
  if (converted === TOML_DELETE) {
    deleteAtPath(target, segments);
    return;
  }
  setAtPath(target, segments, converted);
}

export function coerceTomlValue(
  current: unknown,
  value: unknown,
  segments: readonly PathSegment[],
  allowUnset: boolean,
): unknown | typeof TOML_DELETE {
  if (current instanceof TomlDate && typeof value === "string") {
    const text = value.trim();
    if (!text) {
      if (allowUnset) return TOML_DELETE;
      throw new ConfuiError("SAVE_ERROR", "TOML 日期或时间不能为空", `${segments.join(".")}：请填写有效的 TOML 日期或时间。`);
    }
    let date: TomlDate;
    try {
      date = new TomlDate(text);
    } catch {
      throw new ConfuiError("SAVE_ERROR", "TOML 日期或时间格式无效", `${segments.join(".")}：请填写有效的 TOML 日期或时间。`);
    }
    if (!date.isValid()) {
      throw new ConfuiError("SAVE_ERROR", "TOML 日期或时间格式无效", `${segments.join(".")}：请填写有效的 TOML 日期或时间。`);
    }
    return date;
  }
  if (typeof current === "bigint" && typeof value === "string") {
    const text = value.trim();
    if (!text) {
      if (allowUnset) return TOML_DELETE;
      throw new ConfuiError("SAVE_ERROR", "TOML 大整数不能为空", `${segments.join(".")}：请填写整数。`);
    }
    const match = text.match(/^([+-]?)(?:(\d(?:_?\d)*)|(0x[0-9a-f](?:_?[0-9a-f])*)|(0o[0-7](?:_?[0-7])*)|(0b[01](?:_?[01])*))$/i);
    if (!match) {
      throw new ConfuiError("SAVE_ERROR", "TOML 大整数格式无效", `${segments.join(".")}：请填写整数。`);
    }
    try {
      const literal = match[2] ?? match[3] ?? match[4] ?? match[5];
      if (!literal) throw new Error("missing integer literal");
      const integer = BigInt(literal.replace(/_/g, ""));
      return match[1] === "-" ? -integer : integer;
    } catch {
      throw new ConfuiError("SAVE_ERROR", "TOML 大整数格式无效", `${segments.join(".")}：请填写整数。`);
    }
  }
  if (typeof current === "number" && !Number.isFinite(current) && typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) {
      if (allowUnset) return TOML_DELETE;
      throw new ConfuiError("SAVE_ERROR", "TOML 特殊浮点值不能为空", `${segments.join(".")}：请填写 inf、-inf 或 nan。`);
    }
    const special = text === "inf" || text === "+inf"
      ? Infinity
      : text === "-inf"
        ? -Infinity
        : text === "nan" || text === "+nan" || text === "-nan"
          ? Number.NaN
          : undefined;
    if (special === undefined) {
      throw new ConfuiError("SAVE_ERROR", "TOML 特殊浮点格式无效", `${segments.join(".")}：请填写 inf、-inf 或 nan。`);
    }
    return special;
  }
  if (Array.isArray(current) && Array.isArray(value)) {
    return value.map((item, index) => {
      // TOML arrays are homogeneous, but the renderer represents parser-only
      // values such as BigInt, TomlDate and inf/-inf as strings. When a user
      // appends an item there is no value at that index to identify the type;
      // use the first existing item as the type witness instead of silently
      // turning the new item into a TOML string.
      const currentItem = current[index] ?? current[0];
      const converted = coerceTomlValue(currentItem, item, [...segments, index], false);
      if (converted === TOML_DELETE) {
        throw new ConfuiError("SAVE_ERROR", "TOML 数组中的日期或特殊数值不能为空");
      }
      return converted;
    });
  }
  if (isRecordObject(current) && isRecordObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = coerceTomlValue(current[key], item, [...segments, key], false);
      if (converted === TOML_DELETE) continue;
      setSafeProperty(result, key, converted);
    }
    return result;
  }
  return value;
}
