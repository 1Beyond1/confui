import {
  isAlias,
  isCollection,
  isMap,
  isNode,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments,
  parseDocument,
  stringify as stringifyYamlLib,
  type Document,
  type Pair,
  type YAMLMap,
} from "yaml";
import type { ConfigChange, PathSegment, YamlDocumentSummary } from "../../shared/schema.ts";
import { containsSecretValuePattern, setSafeProperty } from "../../shared/validation.ts";
import { ConfuiError } from "../errors.ts";
import { deleteAtPath, getAtPath, setAtPath } from "../paths.ts";
import { isRecordObject, normalizeLineEndings, stripBom, UTF8_BOM } from "./common.ts";
import type { UpdateConfigResult } from "./types.ts";

const YAML_DELETE = Symbol("yaml-delete");
const YAML_TIMESTAMP_RE = /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:[ \t]*(?:Z|[+-]\d{1,2}(?::\d{2})?))?)?$/;
const YAML_FINITE_NUMBER_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const MAX_DOC_LABEL_CHARS = 60;

export interface ParsedYamlDocument {
  index: number;
  document: Document;
  value: unknown;
  spanStart: number;
  spanEnd: number;
  startLine: number;
  label?: string;
  kind?: string;
  name?: string;
  profile?: string;
  keyCount: number;
}

export function parseYamlDocuments(rawSource: string): ParsedYamlDocument[] {
  const source = stripBom(rawSource);
  const rawDocs = parseAllDocuments(source, { merge: true, uniqueKeys: false });
  const docs = rawDocs.length > 0
    ? rawDocs
    : [parseDocument(source, { merge: true, uniqueKeys: false })];

  const values: unknown[] = [];
  for (const doc of docs) {
    if (doc.errors.length > 0) {
      throw new ConfuiError("PARSE_ERROR", "无法解析这个配置文件", doc.errors[0]!.message);
    }
    const value = doc.toJS({ maxAliasCount: 100 }) ?? {};
    assertNoCircularReferences(value);
    values.push(value);
  }

  const hasSiblingProfiles = values.some((val) => Boolean(extractSpringProfile(val)));

  const spanEnds: number[] = docs.map((doc, index) => {
    if (index === docs.length - 1) return source.length;
    let end = doc.range?.[2] ?? source.length;
    const nextStart = docs[index + 1]?.range?.[0] ?? source.length;
    // Empty YAML documents (`---\n---`) end their `range[2]` right after `---`,
    // BEFORE the terminating line break. Include that line break in this doc's
    // span so splicing the following document never merges `---` + `---` -> `------`.
    if (end < nextStart) {
      if (source.startsWith("\r\n", end) && end + 2 <= nextStart) end += 2;
      else if (source.startsWith("\n", end) && end + 1 <= nextStart) end += 1;
    }
    return Math.min(end, nextStart);
  });

  return docs.map((doc, index) => {
    const value = values[index]!;
    const prevEnd = index === 0 ? 0 : spanEnds[index - 1]!;
    const spanEnd = spanEnds[index]!;
    const spanStart = Math.min(prevEnd, spanEnd);
    const contentOffset = doc.range?.[0] ?? spanStart;
    const startLine = lineNumberAtOffset(source, contentOffset);
    const meta = extractYamlDocumentMeta(value, hasSiblingProfiles);
    const keyCount = isRecordObject(value)
      ? Object.keys(value).length
      : Array.isArray(value)
        ? value.length
        : 0;
    return {
      index,
      document: doc,
      value,
      spanStart,
      spanEnd,
      startLine,
      ...meta,
      keyCount,
    };
  });
}

export function extractYamlDocumentSummaries(source: string): YamlDocumentSummary[] {
  return parseYamlDocuments(source).map((doc) => ({
    index: doc.index,
    label: doc.label,
    kind: doc.kind,
    name: doc.name,
    profile: doc.profile,
    startLine: doc.startLine,
    keyCount: doc.keyCount,
  }));
}

export function parseYaml(source: string, documentIndex = 0): unknown {
  const docs = parseYamlDocuments(source);
  if (!Number.isSafeInteger(documentIndex) || documentIndex < 0 || documentIndex >= docs.length) {
    throw new ConfuiError("INVALID_INPUT", "YAML 文档索引超出范围");
  }
  return docs[documentIndex]!.value;
}

export function stringifyYaml(value: unknown, originalText = ""): string {
  const indent = detectYamlIndent(originalText);
  return stringifyYamlLib(value, { indent, lineWidth: 100, aliasDuplicateObjects: false });
}

export function updateYaml(
  rawSource: string,
  changes: readonly ConfigChange[],
  documentIndex = 0,
): UpdateConfigResult {
  const bom = rawSource.startsWith(UTF8_BOM) ? UTF8_BOM : "";
  const source = bom ? rawSource.slice(1) : rawSource;
  const docs = parseYamlDocuments(source);
  if (!Number.isSafeInteger(documentIndex) || documentIndex < 0 || documentIndex >= docs.length) {
    throw new ConfuiError("INVALID_INPUT", "YAML 文档索引超出范围");
  }
  const target = docs[documentIndex]!;
  const isMultiDoc = docs.length > 1;
  const targetSlice = isMultiDoc ? source.slice(target.spanStart, target.spanEnd) : source;
  const preserveDocStart = (isMultiDoc && documentIndex > 0) || target.document.directives?.docStart === true;
  const preserveDocEnd = target.document.directives?.docEnd === true;

  const updatedSliceResult = updateSingleYamlDocument(
    target.document,
    target.value,
    targetSlice,
    changes,
    preserveDocStart,
    preserveDocEnd,
    isMultiDoc && documentIndex < docs.length - 1,
  );

  if (!isMultiDoc) {
    const normalized = normalizeLineEndings(updatedSliceResult.output, source);
    parseYamlDocuments(normalized);
    return { output: bom + normalized, warnings: updatedSliceResult.warnings };
  }

  let sliceText = updatedSliceResult.output;
  if (documentIndex > 0 && !/^(?:[ \t]*(?:#[^\r\n]*)?\r?\n)*[ \t]*---(?:\s|$)/.test(sliceText)) {
    sliceText = `---\n${sliceText}`;
  }
  const prefix = source.slice(0, target.spanStart);
  const suffix = source.slice(target.spanEnd);
  if (
    prefix.length > 0
    && !prefix.endsWith("\n")
    && !prefix.endsWith("\r")
    && !sliceText.startsWith("\n")
    && !sliceText.startsWith("\r")
  ) {
    sliceText = `\n${sliceText}`;
  }
  if (documentIndex < docs.length - 1 && !sliceText.endsWith("\n")) {
    sliceText += "\n";
  }

  // Splice ONLY the edited document's span; all sibling documents remain 100% byte-for-byte untouched.
  const combined = `${prefix}${sliceText}${suffix}`;
  const normalized = normalizeLineEndings(combined, source);
  const verified = parseYamlDocuments(normalized);
  if (verified.length !== docs.length) {
    throw new ConfuiError("SAVE_ERROR", "多文档 YAML 结构校验失败，已取消保存");
  }
  return { output: bom + normalized, warnings: updatedSliceResult.warnings };
}

function updateSingleYamlDocument(
  doc: Document,
  currentTree: unknown,
  sliceSource: string,
  changes: readonly ConfigChange[],
  preserveDocStart: boolean,
  preserveDocEnd: boolean,
  hasFollowingDocument: boolean,
): UpdateConfigResult {
  const crossesAlias = changes.some((change) => pathCrossesAlias(doc, change.segments));
  if (crossesAlias) {
    return fallbackUpdateYaml(
      sliceSource,
      currentTree,
      changes,
      "本次保存涉及 YAML 锚点别名展开，已重新排版文件（键和值已保留，部分注释可能调整）。",
      preserveDocStart,
      preserveDocEnd,
    );
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
    const indent = detectYamlIndent(sliceSource);
    for (const item of prepared) {
      if (item.value === YAML_DELETE) {
        deleteCstPath(doc, item.segments);
      } else {
        applyCstUpdate(doc, item.segments, item.value);
      }
    }
    if (preserveDocStart && doc.directives) {
      doc.directives.docStart = true;
    }
    if (preserveDocEnd && doc.directives) {
      doc.directives.docEnd = true;
    }
    let rawOutput = doc.toString({ indent, lineWidth: 100 });
    if (hasFollowingDocument && !rawOutput.endsWith("\n")) rawOutput += "\n";
    // Verify the serialized document still parses cleanly without errors or cycles.
    parseYamlDocuments(rawOutput);
    return { output: rawOutput, warnings: [] };
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    return fallbackUpdateYaml(
      sliceSource,
      currentTree,
      changes,
      "本次保存涉及复杂 YAML 结构，已重新排版文件（键和值已保留，原有注释可能无法完整保留）。",
      preserveDocStart,
      preserveDocEnd,
    );
  }
}

function fallbackUpdateYaml(
  source: string,
  currentTree: unknown,
  changes: readonly ConfigChange[],
  warning: string,
  preserveDocStart = false,
  preserveDocEnd = false,
): UpdateConfigResult {
  // Detach shared YAML alias object references before mutating so editing one
  // aliased path does not silently overwrite the anchor or sibling aliases.
  const next = cloneWithoutSharedRefs(currentTree);
  for (const change of changes) {
    if (change.value === undefined) deleteAtPath(next, change.segments);
    else applyYamlChange(next, change.segments, change.value);
  }
  const serialized = stringifyYaml(next, source);
  const body = serialized.endsWith("\n") ? serialized : `${serialized}\n`;
  const withStart = preserveDocStart ? `---\n${body}` : body;
  const withEnd = preserveDocEnd ? `${withStart}...\n` : withStart;
  return {
    output: normalizeLineEndings(withEnd, source),
    warnings: [warning],
  };
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  const bound = Math.min(Math.max(0, offset), text.length);
  for (let i = 0; i < bound; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function extractSpringProfile(value: unknown): string | undefined {
  const activateProfile = getAtPath(value, ["spring", "config", "activate", "on-profile"]);
  const legacyProfile = activateProfile ?? getAtPath(value, ["spring", "profiles"]);
  if (typeof legacyProfile === "string") {
    return sanitizeDocLabel(legacyProfile);
  }
  if (Array.isArray(legacyProfile)) {
    const joined = legacyProfile
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .join(", ");
    return sanitizeDocLabel(joined);
  }
  return undefined;
}

function extractYamlDocumentMeta(
  value: unknown,
  hasSiblingProfiles: boolean,
): { label?: string; kind?: string; name?: string; profile?: string } {
  if (!isRecordObject(value)) return {};
  const kind = typeof value.kind === "string" ? sanitizeDocLabel(value.kind) : undefined;
  const metadata = isRecordObject(value.metadata) ? value.metadata : undefined;
  const metaName = metadata && typeof metadata.name === "string" ? sanitizeDocLabel(metadata.name) : undefined;

  if (kind && metaName) {
    return { label: `${kind}/${metaName}`.slice(0, MAX_DOC_LABEL_CHARS), kind, name: metaName };
  }
  if (kind) {
    return { label: kind, kind };
  }

  const profile = extractSpringProfile(value);
  if (profile) {
    return { label: `profile: ${profile}`.slice(0, MAX_DOC_LABEL_CHARS), profile };
  }

  if (hasSiblingProfiles) {
    const appName = getAtPath(value, ["spring", "application", "name"]);
    const safeAppName = typeof appName === "string" ? sanitizeDocLabel(appName) : undefined;
    return {
      label: safeAppName ? `default (${safeAppName})`.slice(0, MAX_DOC_LABEL_CHARS) : "default",
      profile: "default",
      name: safeAppName,
    };
  }

  if (metaName) {
    return { label: metaName, name: metaName };
  }
  const topName = typeof value.name === "string" ? sanitizeDocLabel(value.name) : undefined;
  if (topName) {
    return { label: topName, name: topName };
  }
  return {};
}

function sanitizeDocLabel(raw: string): string | undefined {
  const cleaned = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (!cleaned) return undefined;
  if (containsSecretValuePattern(cleaned)) return undefined;
  return cleaned.slice(0, MAX_DOC_LABEL_CHARS);
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

function matchYamlMapPair(map: YAMLMap, segment: PathSegment): Pair | undefined {
  const exact = map.items.find((item) => {
    if (!isPair(item)) return false;
    const keyVal = isScalar(item.key) ? item.key.value : item.key;
    return Object.is(keyVal, segment);
  });
  if (exact) return exact;
  if (typeof segment !== "string") return undefined;
  return map.items.find((item) => {
    if (!isPair(item) || !isScalar(item.key)) return false;
    const keyVal = item.key.value;
    if (keyVal === null || keyVal === undefined) {
      return segment === "" || item.key.source === segment;
    }
    if (typeof keyVal === "number" || typeof keyVal === "boolean") {
      return String(keyVal) === segment || item.key.source === segment;
    }
    if (typeof keyVal === "bigint") {
      return keyVal.toString() === segment || item.key.source === segment;
    }
    return typeof item.key.source === "string" && item.key.source === segment;
  });
}

function resolveYamlCstPath(doc: Document, segments: readonly PathSegment[]): unknown[] {
  const resolved: unknown[] = [];
  let current: unknown = doc.contents;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    if (isMap(current)) {
      const pair = matchYamlMapPair(current, segment);
      if (pair) {
        resolved.push(isScalar(pair.key) ? pair.key.value : pair.key);
        current = pair.value;
        continue;
      }
      resolved.push(...segments.slice(i));
      break;
    }
    if (isSeq(current) && typeof segment === "number") {
      resolved.push(segment);
      current = current.items[segment];
      continue;
    }
    resolved.push(...segments.slice(i));
    break;
  }
  return resolved;
}

function deleteCstPath(doc: Document, segments: readonly PathSegment[]): void {
  if (!segments.length) return;
  const cstPath = resolveYamlCstPath(doc, segments);
  if (doc.deleteIn(cstPath)) return;
  const parent = cstPath.length === 1 ? doc.contents : doc.getIn(cstPath.slice(0, -1), true);
  if (isMap(parent)) {
    const targetPair = matchYamlMapPair(parent, segments.at(-1)!);
    if (targetPair) {
      const idx = parent.items.indexOf(targetPair);
      if (idx >= 0) parent.items.splice(idx, 1);
    }
  }
}

function applyCstUpdate(doc: Document, segments: readonly PathSegment[], value: unknown): void {
  if (!segments.length) return;
  if (doc.contents === null || doc.contents === undefined || (isScalar(doc.contents) && doc.contents.value === null)) {
    const prevCommentBefore = isNode(doc.contents) ? doc.contents.commentBefore : undefined;
    const prevComment = isNode(doc.contents) ? doc.contents.comment : undefined;
    const rootNode = doc.createNode(typeof segments[0] === "number" ? [] : {});
    const mergedComment = [prevCommentBefore, prevComment].filter(Boolean).join("\n");
    if (mergedComment) {
      rootNode.commentBefore = mergedComment;
    }
    doc.contents = rootNode;
  }
  const cstPath = resolveYamlCstPath(doc, segments);
  const existing = doc.getIn(cstPath, true);
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
  doc.setIn(cstPath, nextNode);
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
      const pair = matchYamlMapPair(current, segment);
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
    } else if (isScalar(current) && current.value === null) {
      // Empty YAML document (`---`) or empty mapping entry (`key:`) is a null Scalar in `yaml` v2, not an alias.
      return false;
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
