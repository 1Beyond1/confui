import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseDocument,
  stringify as stringifyYamlLib,
  type Document,
} from "yaml";
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
  const doc = parseYamlDocument(source);
  const value = doc.toJS({ maxAliasCount: 100 }) ?? {};
  assertNoCircularReferences(value);
  return value;
}

export function stringifyYaml(value: unknown, originalText = ""): string {
  const indent = detectYamlIndent(originalText);
  return stringifyYamlLib(value, { indent, lineWidth: 100, aliasDuplicateObjects: false });
}

export function updateYaml(source: string, changes: readonly ConfigChange[]): UpdateConfigResult {
  const doc = parseYamlDocument(source);
  const currentTree = doc.toJS({ maxAliasCount: 100 }) ?? {};
  assertNoCircularReferences(currentTree);

  const crossesAlias = changes.some((change) => pathCrossesAlias(doc, change.segments));
  if (crossesAlias) {
    return fallbackUpdateYaml(source, currentTree, changes, "本次保存涉及 YAML 锚点别名展开，已重新排版文件（键和值已保留，部分注释可能调整）。");
  }

  // Coerce all values upfront so validation errors throw deterministically before mutating CST.
  const prepared: Array<{ segments: readonly PathSegment[]; value: unknown | typeof YAML_DELETE }> = [];
  for (const change of changes) {
    if (change.value === undefined) {
      prepared.push({ segments: change.segments, value: YAML_DELETE });
      continue;
    }
    const current = getAtPath(currentTree, change.segments);
    const converted = coerceYamlValue(current, change.value, change.segments, true);
    prepared.push({ segments: change.segments, value: converted });
  }

  try {
    const indent = detectYamlIndent(source);
    for (const item of prepared) {
      if (item.value === YAML_DELETE) {
        doc.deleteIn(item.segments);
      } else {
        applyCstUpdate(doc, item.segments, item.value);
      }
    }
    const rawOutput = doc.toString({ indent, lineWidth: 100 });
    const normalized = normalizeLineEndings(rawOutput, source);
    // Verify the serialized document still parses cleanly without errors or cycles.
    parseYaml(normalized);
    return { output: normalized, warnings: [] };
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    return fallbackUpdateYaml(source, currentTree, changes, "本次保存涉及复杂 YAML 结构，已重新排版文件（键和值已保留，原有注释可能无法完整保留）。");
  }
}

function parseYamlDocument(source: string): Document {
  const doc = parseDocument(source, { merge: true, uniqueKeys: false });
  if (doc.errors.length > 0) {
    throw new ConfuiError("PARSE_ERROR", "无法解析这个配置文件", doc.errors[0]!.message);
  }
  return doc;
}

function fallbackUpdateYaml(
  source: string,
  currentTree: unknown,
  changes: readonly ConfigChange[],
  warning: string,
): UpdateConfigResult {
  // Detach shared YAML alias object references before mutating so editing one
  // aliased path does not silently overwrite the anchor or sibling aliases.
  const next = cloneWithoutSharedRefs(currentTree);
  for (const change of changes) {
    if (change.value === undefined) deleteAtPath(next, change.segments);
    else applyYamlChange(next, change.segments, change.value);
  }
  return {
    output: normalizeLineEndings(stringifyYaml(next, source), source),
    warnings: [warning],
  };
}

function cloneWithoutSharedRefs(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneWithoutSharedRefs);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    setSafeProperty(result, key, cloneWithoutSharedRefs(item));
  }
  return result;
}

function applyCstUpdate(doc: Document, segments: readonly PathSegment[], value: unknown): void {
  if (!segments.length) return;
  if (doc.contents === null || doc.contents === undefined) {
    doc.contents = doc.createNode(typeof segments[0] === "number" ? [] : {});
  }
  const existing = doc.getIn(segments, true);
  if (isScalar(existing) && isYamlScalarJsValue(value)) {
    const prevType = existing.type;
    existing.value = value instanceof Date ? value.toISOString() : value;
    // Clear string quoting style when changing a quoted string to a non-string scalar.
    if (typeof value !== "string" && (prevType === "QUOTE_DOUBLE" || prevType === "QUOTE_SINGLE")) {
      existing.type = undefined;
    }
    return;
  }

  const normalizedValue = value instanceof Date ? value.toISOString() : value;
  const nextNode = doc.createNode(normalizedValue);
  if (isNode(existing)) {
    if (existing.comment) nextNode.comment = existing.comment;
    if (existing.commentBefore) nextNode.commentBefore = existing.commentBefore;
    if (existing.spaceBefore) nextNode.spaceBefore = existing.spaceBefore;
  }
  doc.setIn(segments, nextNode);
}

function isYamlScalarJsValue(value: unknown): boolean {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
    || value instanceof Date;
}

function pathCrossesAlias(doc: Document, segments: readonly PathSegment[]): boolean {
  let current: unknown = doc.contents;
  for (const segment of segments) {
    if (isAlias(current)) return true;
    if (isMap(current)) {
      const pair = current.items.find((item) => {
        if (!isPair(item)) return false;
        const keyVal = isScalar(item.key) ? item.key.value : item.key;
        return keyVal === segment;
      });
      if (!pair) {
        // Also check merge keys (`<<: *alias`) where the edited key might originate from an alias.
        const hasMerge = current.items.some((item) => {
          if (!isPair(item)) return false;
          const keyVal = isScalar(item.key) ? item.key.value : item.key;
          return keyVal === "<<" && (isAlias(item.value) || isSeq(item.value));
        });
        return hasMerge;
      }
      current = pair.value;
    } else if (isSeq(current) && typeof segment === "number") {
      current = current.items[segment];
    } else {
      return isAlias(current) || (!isCollection(current) && current !== null && current !== undefined);
    }
  }
  return isAlias(current);
}

function detectYamlIndent(source: string): number {
  let minIndent = Number.POSITIVE_INFINITY;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = line.match(/^( +)(?=\S)/);
    if (match?.[1]) {
      const len = match[1].length;
      if (len >= 2 && len < minIndent) minIndent = len;
    }
  }
  if (!Number.isFinite(minIndent)) return 2;
  return Math.min(8, Math.max(2, minIndent));
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
