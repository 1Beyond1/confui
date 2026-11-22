import * as yaml from "js-yaml";
import type { ConfigChange, PathSegment } from "../../shared/schema.ts";
import { setSafeProperty } from "../../shared/validation.ts";
import { ConfuiError } from "../errors.ts";
import { deleteAtPath, getAtPath, setAtPath } from "../paths.ts";
import { isRecordObject, normalizeLineEndings } from "./common.ts";
import type { UpdateConfigResult } from "./types.ts";

const YAML_DELETE = Symbol("yaml-delete");
const YAML_TIMESTAMP_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]*(?:Z|[+-]\d{1,2}(?::\d{2})?))?)?$/;
const YAML_FINITE_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseYaml(source: string): unknown {
  const value = yaml.load(source) ?? {};
  assertNoCircularReferences(value);
  return value;
}

export function stringifyYaml(value: unknown): string {
  return yaml.dump(value, { indent: 2, noRefs: true, lineWidth: 100, sortKeys: false });
}

export function updateYaml(source: string, changes: readonly ConfigChange[]): UpdateConfigResult {
  const next = parseYaml(source);
  for (const change of changes) {
    if (change.value === undefined) deleteAtPath(next, change.segments);
    else applyYamlChange(next, change.segments, change.value);
  }
  return {
    output: normalizeLineEndings(stringifyYaml(next), source),
    warnings: [
      "YAML 保存会重新排版文件；键和值会保留，但原有注释可能无法完整保留。",
    ],
  };
}

/**
 * YAML aliases can describe a cyclic object graph even though the source is
 * valid YAML. The form editor and the serializers operate on JSON-like trees;
 * rejecting only cycles keeps shared (but acyclic) aliases usable and avoids a
 * later renderer crash or an opaque "circular structure" save error.
 */
export function assertNoCircularReferences(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit: boolean }> = [{ value, exit: false }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.value === null || typeof item.value !== "object") continue;
    if (item.exit) {
      active.delete(item.value);
      continue;
    }
    if (active.has(item.value)) throw new ConfuiError("PARSE_ERROR", "YAML 配置包含循环引用，当前无法安全编辑");
    active.add(item.value);
    stack.push({ value: item.value, exit: true });
    const children = Array.isArray(item.value)
      ? item.value
      : Object.values(item.value as Record<string, unknown>);
    for (const child of children) stack.push({ value: child, exit: false });
  }
}

function applyYamlChange(target: unknown, segments: readonly PathSegment[], value: unknown): void {
  const current = getAtPath(target, segments);
  const converted = coerceYamlValue(current, value, segments, true);
  if (converted === YAML_DELETE) {
    deleteAtPath(target, segments);
    return;
  }
  setAtPath(target, segments, converted);
}

export function coerceYamlValue(
  current: unknown,
  value: unknown,
  segments: readonly PathSegment[],
  allowUnset: boolean,
): unknown | typeof YAML_DELETE {
  if (current instanceof Date && typeof value === "string") {
    const text = value.trim();
    if (!text) {
      if (allowUnset) return YAML_DELETE;
      throw new ConfuiError("SAVE_ERROR", "YAML 日期或时间不能为空", `${segments.join(".")}：请填写有效的 ISO 日期或时间。`);
    }
    if (!YAML_TIMESTAMP_RE.test(text)) {
      throw new ConfuiError("SAVE_ERROR", "YAML 日期或时间格式无效", `${segments.join(".")}：请填写有效的 ISO 日期或时间。`);
    }
    const parsedDate = new Date(text);
    if (!Number.isFinite(parsedDate.getTime())) {
      throw new ConfuiError("SAVE_ERROR", "YAML 日期或时间格式无效", `${segments.join(".")}：请填写有效的 ISO 日期或时间。`);
    }
    return parsedDate;
  }
  if (typeof current === "number" && !Number.isFinite(current) && typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) {
      if (allowUnset) return YAML_DELETE;
      throw new ConfuiError("SAVE_ERROR", "YAML 特殊浮点值不能为空", `${segments.join(".")}：请填写 .inf、-.inf、.nan 或有限数字。`);
    }
    const special = text === "inf" || text === "+inf" || text === ".inf" || text === "+.inf"
      ? Infinity
      : text === "-inf" || text === "-.inf"
        ? -Infinity
        : text === "nan" || text === ".nan" || text === "+nan" || text === "-nan"
          ? Number.NaN
          : undefined;
    if (special !== undefined) return special;
    if (YAML_FINITE_NUMBER_RE.test(text)) {
      const numeric = Number(text);
      if (Number.isFinite(numeric)) return numeric;
    }
    throw new ConfuiError("SAVE_ERROR", "YAML 特殊浮点格式无效", `${segments.join(".")}：请填写 .inf、-.inf、.nan 或有限数字。`);
  }
  if (Array.isArray(current) && Array.isArray(value)) {
    const homogeneousWitness = current.length > 0 && (
      current.every((item) => item instanceof Date)
      || current.every((item) => typeof item === "number" && !Number.isFinite(item))
    )
      ? current[0]
      : undefined;
    return value.map((item, index) => {
      const currentItem = index < current.length ? current[index] : homogeneousWitness;
      const converted = coerceYamlValue(currentItem, item, [...segments, index], false);
      if (converted === YAML_DELETE) {
        throw new ConfuiError("SAVE_ERROR", "YAML 数组中的日期或特殊数值不能为空");
      }
      return converted;
    });
  }
  if (isRecordObject(current) && isRecordObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const converted = coerceYamlValue(current[key], item, [...segments, key], false);
      if (converted === YAML_DELETE) continue;
      setSafeProperty(result, key, converted);
    }
    return result;
  }
  return value;
}
