import type { ConfigChange } from "../../shared/schema.ts";
import { isForbiddenKey, setSafeProperty } from "../../shared/validation.ts";
import { ConfuiError } from "../errors.ts";
import { assertAppendable, detectEol, escapeRegExp, isScalarValue } from "./common.ts";

const PROPERTY_LINE_RE = /^([ \t]*)((?:\\.|[^:=\s\\]|\\$)+)(?:([ \t]*(?:[:=][ \t]*|[ \t]+))(.*))?$/;

export function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of joinPropertyLines(text.split(/\r?\n/))) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const match = rawLine.match(PROPERTY_LINE_RE);
    if (match?.[2]) {
      const key = unescapeProperty(match[2]);
      if (key && !isForbiddenKey(key)) {
        setSafeProperty(result, key, unescapeProperty(match[4] ?? ""));
      }
    }
  }
  return result;
}

export function stringifyProperties(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => {
      assertValidPropertyKey(key);
      return `${escapeProperty(key, true)}=${escapeProperty(String(item ?? ""))}`;
    })
    .join("\n");
}

function assertValidPropertyKey(key: string): void {
  if (!key.trim() || key.includes("\0") || isForbiddenKey(key)) {
    throw new ConfuiError(
      "SAVE_ERROR",
      `PROPERTIES 键名无效：${JSON.stringify(key)}`,
      "PROPERTIES 键名不能为空、包含空字符或使用保留键名（__proto__ / prototype / constructor）。",
    );
  }
}

export function patchProperties(text: string, changes: readonly ConfigChange[]): string {
  const eol = detectEol(text);
  const updates = new Map<string, unknown>();
  for (const change of changes) {
    if (change.segments.length !== 1 || typeof change.segments[0] !== "string") {
      throw new ConfuiError("SAVE_ERROR", "PROPERTIES 只支持顶层键值");
    }
    const key = change.segments[0];
    assertValidPropertyKey(key);
    if (change.value !== undefined && !isScalarValue(change.value)) {
      throw new ConfuiError("SAVE_ERROR", "PROPERTIES 只支持标量键值", "复杂对象不能安全地表示为这种格式。");
    }
    updates.set(key, change.value);
  }

  const parsed = parseProperties(text);
  const seen = new Set<string>();
  const nextLines: string[] = [];

  // Properties values may span several physical lines via a trailing "\".
  // Match against the joined logical line so the whole group is replaced
  // together and no continuation is left behind as an orphan key.
  for (const group of groupPropertyLines(text.split(/\r?\n/))) {
    const logical = joinPropertyLines(group)[0] ?? "";
    const trimmed = logical.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      nextLines.push(...group);
      continue;
    }
    const match = logical.match(PROPERTY_LINE_RE);
    const rawKey = match?.[2];
    const key = rawKey ? unescapeProperty(rawKey) : undefined;
    if (!rawKey || !key || !updates.has(key)) {
      nextLines.push(...group);
      continue;
    }
    seen.add(key);
    if (updates.get(key) === undefined) continue;
    const separator = match?.[3] ?? "=";
    const nextValue = escapeProperty(String(updates.get(key) ?? ""), false, !/[:=]/.test(separator));
    nextLines.push(`${match?.[1] ?? ""}${rawKey}${separator}${nextValue}`);
  }

  for (const [key, value] of updates) {
    if (seen.has(key)) continue;
    if (value === undefined) {
      assertAppendable(parsed, [key], "properties");
      continue;
    }
    assertAppendable(parsed, [key], "properties");
    if (nextLines.at(-1) === "") nextLines.pop();
    nextLines.push(`${escapeProperty(key, true)}=${escapeProperty(String(value ?? ""))}`);
  }

  while (nextLines.length > 1 && nextLines.at(-1) === "" && nextLines.at(-2) === "") nextLines.pop();
  return nextLines.join(eol).replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

export function groupPropertyLines(lines: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (current.length === 0 && isPropertyCommentLine(line)) {
      groups.push([line]);
      continue;
    }
    current.push(line);
    if (!hasPropertyContinuation(line)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function isPropertyCommentLine(line: string): boolean {
  return /^\s*[#!]/.test(line);
}

export function joinPropertyLines(lines: readonly string[]): string[] {
  const logical: string[] = [];
  let current: string | undefined;
  for (const physical of lines) {
    if (current === undefined && isPropertyCommentLine(physical)) {
      logical.push(physical);
      continue;
    }
    const continuedPart = current === undefined ? physical : physical.replace(/^\s+/, "");
    current = (current ?? "") + continuedPart;
    if (hasPropertyContinuation(physical)) {
      current = current.slice(0, -1);
      continue;
    }
    logical.push(current);
    current = undefined;
  }
  if (current !== undefined) logical.push(current);
  return logical;
}

function hasPropertyContinuation(line: string): boolean {
  let slashes = 0;
  for (let index = line.length - 1; index >= 0 && line[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

export function escapeProperty(value: string, key = false, escapeLeadingDelimiter = false): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\f/g, "\\f");
  if (key) {
    return escaped
      .replace(/([:= ])/g, "\\$1")
      .replace(/^([#!])/, "\\$1");
  }
  const withLeadingSpaces = escaped.replace(/^ +/, (spaces) => spaces.replace(/ /g, "\\ "));
  return escapeLeadingDelimiter ? withLeadingSpaces.replace(/^([:=])/, "\\$1") : withLeadingSpaces;
}

export function unescapeProperty(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index === value.length - 1) {
      output += character;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === "u" && /^[0-9a-fA-F]{4}$/.test(value.slice(index + 2, index + 6))) {
      output += String.fromCharCode(Number.parseInt(value.slice(index + 2, index + 6), 16));
      index += 5;
      continue;
    }
    index += 1;
    output += escaped === "n"
      ? "\n"
      : escaped === "r"
        ? "\r"
        : escaped === "t"
          ? "\t"
          : escaped === "f"
            ? "\f"
            : escaped ?? "";
  }
  return output;
}
