import { parse as parseTomlLib, stringify as stringifyTomlLib, TomlDate } from "smol-toml";
import type { ConfigChange, PathSegment } from "../../shared/schema.ts";
import { setSafeProperty } from "../../shared/validation.ts";
import { ConfuiError } from "../errors.ts";
import { deleteAtPath, getAtPath, setAtPath } from "../paths.ts";
import { detectEol, escapeRegExp, isRecordObject, normalizeLineEndings } from "./common.ts";
import type { UpdateConfigResult } from "./types.ts";

const TOML_DELETE = Symbol("toml-delete");
const BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;
const TOML_FINITE_NUMBER_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.\d+(?:_\d+)*)?|\.\d+(?:_\d+)*)(?:e[+-]?\d+(?:_\d+)*)?$/i;

export function parseToml(source: string): unknown {
  // Keep ordinary integers as numbers but retain valid TOML integers
  // beyond JavaScript's safe range as BigInt instead of rejecting them.
  return parseTomlLib(source, { integersAsBigInt: "asNeeded" });
}

export function stringifyToml(value: Record<string, unknown>): string {
  return stringifyTomlLib(value);
}

export function updateToml(source: string, changes: readonly ConfigChange[]): UpdateConfigResult {
  // Parse twice: `originalTree` is the read-only reference for coercion, and
  // `expectedTree` receives all mutations (preserving TomlDate/BigInt) so we
  // can verify any in-place patch against the exact semantic target.
  const originalTree = parseToml(source);
  const expectedTree = parseToml(source);
  const coercedChanges: Array<{ segments: readonly PathSegment[]; value: unknown | typeof TOML_DELETE }> = [];

  for (const change of changes) {
    if (change.value === undefined) {
      deleteAtPath(expectedTree, change.segments);
      coercedChanges.push({ segments: change.segments, value: TOML_DELETE });
    } else {
      const current = getAtPath(originalTree, change.segments);
      const converted = coerceTomlValue(current, change.value, change.segments, true);
      if (converted === TOML_DELETE) {
        deleteAtPath(expectedTree, change.segments);
      } else {
        setAtPath(expectedTree, change.segments, converted);
      }
      coercedChanges.push({ segments: change.segments, value: converted });
    }
  }

  const patched = tryPatchTomlSource(source, coercedChanges);
  if (patched !== null) {
    try {
      const reparsed = parseToml(patched);
      if (tomlDeepEqual(reparsed, expectedTree)) {
        return { output: normalizeLineEndings(patched, source), warnings: [] };
      }
    } catch {
      // Fall back to full serialization if in-place patch produced invalid TOML.
    }
  }

  return {
    output: normalizeLineEndings(stringifyToml(expectedTree as Record<string, unknown>), source),
    warnings: [
      "本次保存涉及复杂 TOML 结构，已重新排版文件（键和值已保留，原有注释或空行可能调整）。",
    ],
  };
}

export interface TomlSectionInfo {
  path: string[];
  headerLine: number;
  endLine: number;
  isArray: boolean;
}

export interface TomlAssignmentInfo {
  fullPath: string[];
  startLine: number;
  endLine: number;
  indent: string;
  rawKey: string;
  separator: string;
  trailingComment: string;
  inArrayTable: boolean;
}

export interface TomlScan {
  sections: TomlSectionInfo[];
  assignments: TomlAssignmentInfo[];
}

function tryPatchTomlSource(
  source: string,
  changes: ReadonlyArray<{ segments: readonly PathSegment[]; value: unknown | typeof TOML_DELETE }>,
): string | null {
  if (changes.some((change) => change.segments.length === 0 || change.segments.some((s) => typeof s !== "string"))) {
    return null;
  }

  const eol = detectEol(source);
  const rawLines = source.split(/\r?\n/);
  // Drop a single trailing sentinel line from final newline before scanning.
  const hasTrailingEmpty = rawLines.length > 0 && rawLines.at(-1) === "";
  const lines = hasTrailingEmpty ? rawLines.slice(0, -1) : [...rawLines];

  const scan = scanTomlLines(lines);
  if (!scan) return null;

  const assignmentByPath = new Map<string, TomlAssignmentInfo[]>();
  for (const assignment of scan.assignments) {
    const id = JSON.stringify(assignment.fullPath);
    const list = assignmentByPath.get(id) ?? [];
    list.push(assignment);
    assignmentByPath.set(id, list);
  }

  const replacements: Array<{ start: number; end: number; lines: string[] }> = [];
  const additions: Array<{ segments: string[]; formattedValue: string }> = [];

  for (const change of changes) {
    const segments = change.segments as string[];
    const id = JSON.stringify(segments);
    const matches = assignmentByPath.get(id);

    if (matches && matches.length > 0) {
      if (matches.length > 1 || matches[0]!.inArrayTable) return null;
      const entry = matches[0]!;
      if (change.value === TOML_DELETE) {
        replacements.push({ start: entry.startLine, end: entry.endLine, lines: [] });
      } else {
        const formatted = formatTomlInlineValue(change.value);
        if (formatted === null) return null;
        replacements.push({
          start: entry.startLine,
          end: entry.endLine,
          lines: [`${entry.indent}${entry.rawKey}${entry.separator}${formatted}${entry.trailingComment}`],
        });
      }
      continue;
    }

    // Check if the path refers to a table section itself or an entry inside an array table.
    const hitsArrayTable = scan.sections.some(
      (section) => section.isArray && isPrefix(section.path, segments),
    );
    if (hitsArrayTable) return null;

    if (change.value === TOML_DELETE) {
      // Target key was not located as a standalone assignment (e.g., nested in inline table).
      return null;
    }

    // Cannot safely patch a child key inside an existing inline table assignment.
    const insideExistingAssignment = scan.assignments.some((a) => isStrictPrefix(a.fullPath, segments));
    if (insideExistingAssignment) return null;

    // Cannot safely replace an entire existing [section] header with a scalar/object inline.
    const matchesSectionHeader = scan.sections.some((section) => samePath(section.path, segments));
    if (matchesSectionHeader) return null;

    const formatted = formatTomlInlineValue(change.value);
    if (formatted === null) return null;
    additions.push({ segments, formattedValue: formatted });
  }

  // Apply replacements from bottom to top so line indices remain valid.
  replacements.sort((a, b) => b.start - a.start);
  for (let i = 1; i < replacements.length; i += 1) {
    if (replacements[i]!.end >= replacements[i - 1]!.start) return null;
  }
  for (const rep of replacements) {
    lines.splice(rep.start, rep.end - rep.start + 1, ...rep.lines);
  }

  // Apply additions on the updated lines array (re-scan sections to get exact insertion points).
  for (const addition of additions) {
    const nextScan = scanTomlLines(lines);
    if (!nextScan) return null;
    const tablePath = addition.segments.slice(0, -1);
    const leafKey = addition.segments.at(-1)!;
    const assignmentLine = `${formatTomlKeySegment(leafKey)} = ${addition.formattedValue}`;

    if (tablePath.length === 0) {
      const firstHeader = nextScan.sections[0]?.headerLine ?? lines.length;
      let insertAt = firstHeader;
      while (insertAt > 0 && lines[insertAt - 1]?.trim() === "") insertAt -= 1;
      lines.splice(insertAt, 0, assignmentLine);
    } else {
      const matchingSection = nextScan.sections.find(
        (section) => !section.isArray && samePath(section.path, tablePath),
      );
      if (matchingSection) {
        let insertAt = matchingSection.endLine + 1;
        while (insertAt > matchingSection.headerLine + 1 && lines[insertAt - 1]?.trim() === "") {
          insertAt -= 1;
        }
        lines.splice(insertAt, 0, assignmentLine);
      } else {
        while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
        if (lines.length > 0) lines.push("");
        lines.push(`[${tablePath.map(formatTomlKeySegment).join(".")}]`, assignmentLine);
      }
    }
  }

  const joined = lines.join(eol);
  return joined.replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

export function scanTomlLines(lines: readonly string[]): TomlScan | null {
  const sections: TomlSectionInfo[] = [];
  const assignments: TomlAssignmentInfo[] = [];
  let currentTablePath: string[] = [];
  let inArrayTable = false;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("[")) {
      const header = parseTomlHeader(trimmed);
      if (!header) return null;
      if (sections.length > 0) sections.at(-1)!.endLine = index - 1;
      currentTablePath = header.path;
      inArrayTable = header.isArray;
      sections.push({
        path: header.path,
        headerLine: index,
        endLine: lines.length - 1,
        isArray: header.isArray,
      });
      index += 1;
      continue;
    }

    const keyPart = parseTomlAssignmentStart(line);
    if (!keyPart) return null;

    const span = scanTomlValueSpan(lines, index, keyPart.valueStartCol);
    if (!span) return null;

    assignments.push({
      fullPath: [...currentTablePath, ...keyPart.keySegments],
      startLine: index,
      endLine: span.endLine,
      indent: keyPart.indent,
      rawKey: keyPart.rawKey,
      separator: keyPart.separator,
      trailingComment: span.trailingComment,
      inArrayTable,
    });
    index = span.endLine + 1;
  }

  if (sections.length > 0) sections.at(-1)!.endLine = lines.length - 1;
  return { sections, assignments };
}

function parseTomlHeader(trimmed: string): { path: string[]; isArray: boolean } | null {
  const isArray = trimmed.startsWith("[[");
  const openLen = isArray ? 2 : 1;
  const closeToken = isArray ? "]]" : "]";
  const parsed = readTomlKeyPath(trimmed, openLen);
  if (!parsed) return null;
  let pos = skipHorizontalWhitespace(trimmed, parsed.endIndex);
  if (!trimmed.startsWith(closeToken, pos)) return null;
  pos += closeToken.length;
  pos = skipHorizontalWhitespace(trimmed, pos);
  if (pos < trimmed.length && trimmed[pos] !== "#") return null;
  return { path: parsed.segments, isArray };
}

function parseTomlAssignmentStart(line: string): {
  indent: string;
  rawKey: string;
  keySegments: string[];
  separator: string;
  valueStartCol: number;
} | null {
  const indentLen = skipHorizontalWhitespace(line, 0);
  const parsed = readTomlKeyPath(line, indentLen);
  if (!parsed) return null;
  const eqPos = skipHorizontalWhitespace(line, parsed.endIndex);
  if (line[eqPos] !== "=") return null;
  const valueStartCol = skipHorizontalWhitespace(line, eqPos + 1);
  return {
    indent: line.slice(0, indentLen),
    rawKey: line.slice(indentLen, parsed.endIndex),
    keySegments: parsed.segments,
    separator: line.slice(parsed.endIndex, valueStartCol),
    valueStartCol,
  };
}

function readTomlKeyPath(text: string, start: number): { segments: string[]; endIndex: number } | null {
  const segments: string[] = [];
  let pos = skipHorizontalWhitespace(text, start);
  let lastKeyEnd = pos;

  while (pos < text.length) {
    const seg = readTomlKeySegment(text, pos);
    if (!seg) return null;
    segments.push(seg.value);
    lastKeyEnd = seg.endIndex;
    const afterSeg = skipHorizontalWhitespace(text, seg.endIndex);
    if (text[afterSeg] === ".") {
      pos = skipHorizontalWhitespace(text, afterSeg + 1);
      continue;
    }
    return { segments, endIndex: lastKeyEnd };
  }
  return segments.length ? { segments, endIndex: lastKeyEnd } : null;
}

function readTomlKeySegment(text: string, start: number): { value: string; endIndex: number } | null {
  const ch = text[start];
  if (!ch) return null;
  if (ch === '"') {
    let pos = start + 1;
    let escaped = false;
    while (pos < text.length) {
      const c = text[pos]!;
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        try {
          return { value: JSON.parse(text.slice(start, pos + 1)) as string, endIndex: pos + 1 };
        } catch {
          return null;
        }
      }
      pos += 1;
    }
    return null;
  }
  if (ch === "'") {
    const end = text.indexOf("'", start + 1);
    if (end < 0) return null;
    return { value: text.slice(start + 1, end), endIndex: end + 1 };
  }
  let pos = start;
  while (pos < text.length && /[A-Za-z0-9_-]/.test(text[pos]!)) pos += 1;
  if (pos === start) return null;
  return { value: text.slice(start, pos), endIndex: pos };
}

function scanTomlValueSpan(
  lines: readonly string[],
  startLine: number,
  startCol: number,
): { endLine: number; trailingComment: string } | null {
  let bracketDepth = 0;
  let braceDepth = 0;
  let stringMode: null | '"' | "'" | '"""' | "'''" = null;

  for (let lineIdx = startLine; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]!;
    let col = lineIdx === startLine ? startCol : 0;
    let commentStart: number | undefined;

    while (col < line.length) {
      const ch = line[col]!;
      if (stringMode === '"""') {
        if (ch === "\\") {
          col += 2;
          continue;
        }
        if (line.startsWith('"""', col)) {
          // TOML 1.0 allows 1 or 2 literal quotes immediately before the closing `"""` (4 or 5 quotes in a row).
          let runEnd = col + 3;
          while (runEnd < line.length && line[runEnd] === '"' && runEnd - col < 5) {
            runEnd += 1;
          }
          stringMode = null;
          col = runEnd;
          continue;
        }
        col += 1;
        continue;
      }
      if (stringMode === "'''") {
        if (line.startsWith("'''", col)) {
          // TOML 1.0 allows 1 or 2 literal apostrophes immediately before the closing `'''` (4 or 5 in a row).
          let runEnd = col + 3;
          while (runEnd < line.length && line[runEnd] === "'" && runEnd - col < 5) {
            runEnd += 1;
          }
          stringMode = null;
          col = runEnd;
          continue;
        }
        col += 1;
        continue;
      }
      if (stringMode === '"') {
        if (ch === "\\") {
          col += 2;
          continue;
        }
        if (ch === '"') stringMode = null;
        col += 1;
        continue;
      }
      if (stringMode === "'") {
        if (ch === "'") stringMode = null;
        col += 1;
        continue;
      }

      if (ch === "#") {
        if (bracketDepth === 0 && braceDepth === 0) {
          let cs = col;
          while (cs > (lineIdx === startLine ? startCol : 0) && (line[cs - 1] === " " || line[cs - 1] === "\t")) {
            cs -= 1;
          }
          commentStart = cs;
        }
        break;
      }
      if (line.startsWith('"""', col)) {
        stringMode = '"""';
        col += 3;
        continue;
      }
      if (line.startsWith("'''", col)) {
        stringMode = "'''";
        col += 3;
        continue;
      }
      if (ch === '"' || ch === "'") {
        stringMode = ch;
        col += 1;
        continue;
      }
      if (ch === "[") bracketDepth += 1;
      else if (ch === "]") bracketDepth -= 1;
      else if (ch === "{") braceDepth += 1;
      else if (ch === "}") braceDepth -= 1;

      if (bracketDepth < 0 || braceDepth < 0) return null;
      col += 1;
    }

    if (stringMode === '"' || stringMode === "'") return null;
    if (stringMode === null && bracketDepth === 0 && braceDepth === 0) {
      return {
        endLine: lineIdx,
        trailingComment: commentStart !== undefined ? line.slice(commentStart) : "",
      };
    }
  }
  return null;
}

function formatTomlInlineValue(value: unknown): string | null {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return Object.is(value, -0) ? "-0.0" : String(value);
  }
  if (value instanceof TomlDate || value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (const item of value) {
      // Arrays of tables / nested records are safer handled via full stringify.
      if (isRecordObject(item)) return null;
      const formatted = formatTomlInlineValue(item);
      if (formatted === null) return null;
      items.push(formatted);
    }
    return `[${items.join(", ")}]`;
  }
  if (isRecordObject(value)) {
    const entries: string[] = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (isRecordObject(v)) return null;
      const formatted = formatTomlInlineValue(v);
      if (formatted === null) return null;
      entries.push(`${formatTomlKeySegment(k)} = ${formatted}`);
    }
    return `{ ${entries.join(", ")} }`;
  }
  return null;
}

function formatTomlKeySegment(segment: string): string {
  return BARE_KEY_RE.test(segment) ? segment : JSON.stringify(segment);
}

function skipHorizontalWhitespace(text: string, index: number): number {
  let pos = index;
  while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos += 1;
  return pos;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, idx) => part === right[idx]);
}

function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((part, idx) => part === full[idx]);
}

function isStrictPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length < full.length && prefix.every((part, idx) => part === full[idx]);
}

function tomlDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "bigint" && typeof right === "number") {
    return Number.isSafeInteger(right) && !Object.is(right, -0) && BigInt(right) === left;
  }
  if (typeof left === "number" && typeof right === "bigint") {
    return Number.isSafeInteger(left) && !Object.is(left, -0) && BigInt(left) === right;
  }
  if (left instanceof Date && right instanceof Date) {
    return left.toISOString() === right.toISOString();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, idx) => tomlDeepEqual(item, right[idx]));
  }
  if (isRecordObject(left) && isRecordObject(right)) {
    const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
    const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && tomlDeepEqual(left[key], right[key]));
  }
  return false;
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
      const signed = match[1] === "-" ? -integer : integer;
      const asNumber = Number(signed);
      // Match `smol-toml`'s `{ integersAsBigInt: "asNeeded" }`: values within
      // JavaScript's safe integer range re-parse as `number`.
      if (Number.isSafeInteger(asNumber) && BigInt(asNumber) === signed) {
        return asNumber;
      }
      return signed;
    } catch {
      throw new ConfuiError("SAVE_ERROR", "TOML 大整数格式无效", `${segments.join(".")}：请填写整数。`);
    }
  }
  if (typeof current === "number" && !Number.isFinite(current) && typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (!text) {
      if (allowUnset) return TOML_DELETE;
      throw new ConfuiError("SAVE_ERROR", "TOML 特殊浮点值不能为空", `${segments.join(".")}：请填写 inf、-inf、nan 或有限数字。`);
    }
    const special = text === "inf" || text === "+inf"
      ? Infinity
      : text === "-inf"
        ? -Infinity
        : text === "nan" || text === "+nan" || text === "-nan"
          ? Number.NaN
          : undefined;
    if (special !== undefined) return special;
    if (TOML_FINITE_NUMBER_RE.test(text)) {
      const numeric = Number(text.replace(/_/g, ""));
      if (Number.isFinite(numeric)) return numeric;
    }
    throw new ConfuiError("SAVE_ERROR", "TOML 特殊浮点格式无效", `${segments.join(".")}：请填写 inf、-inf、nan 或有限数字。`);
  }
  if (Array.isArray(current) && Array.isArray(value)) {
    const homogeneousWitness = current.length > 0 && (
      current.every((item) => item instanceof TomlDate)
      || current.every((item) => typeof item === "bigint")
      || current.every((item) => typeof item === "number" && !Number.isFinite(item))
    )
      ? current[0]
      : undefined;
    return value.map((item, index) => {
      const currentItem = index < current.length ? current[index] : homogeneousWitness;
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
