import * as ini from "ini";
import type { ConfigChange, PathSegment } from "../../shared/schema.ts";
import { isForbiddenKey, isSensitiveKey, setSafeProperty } from "../../shared/validation.ts";
import { ConfuiError } from "../errors.ts";
import { getAtPath } from "../paths.ts";
import { assertAppendable, detectEol, escapeRegExp, extractBaseName, isScalarValue, stripBom } from "./common.ts";

/** Share of meaningful lines that must look like `[section]` or `key=value`. */
const INI_ASSIGNMENT_RATIO = 0.8;
const INI_INVALID_SEGMENT_CHAR_RE = /[=\u0000-\u001f\u007f]/;

/** True when the filename alone is enough to trust the INI parser. */
export function isUnambiguousIniName(filename: string): boolean {
  const lower = extractBaseName(filename).toLowerCase();
  return lower.endsWith(".ini") || lower === ".editorconfig" || lower === ".npmrc";
}

/**
 * `.conf` and `.cfg` are shared by many unrelated syntaxes — nginx, httpd,
 * redis and sshd all use them. The INI parser accepts every one of those
 * without complaint and turns bare directives into boolean keys, so the
 * content has to be sniffed before the extension can be trusted.
 */
export function looksLikeIni(text: string): boolean {
  let assignments = 0;
  let others = 0;
  for (const rawLine of stripBom(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (matchIniSectionHeader(line) || isIniAssignmentLine(line)) assignments += 1;
    else others += 1;
  }
  const total = assignments + others;
  // An empty or comment-only file has nothing that could be misread.
  if (!total) return true;
  return assignments / total >= INI_ASSIGNMENT_RATIO;
}

/**
 * `ini` deliberately coerces the unquoted values `true`, `false` and `null`.
 * That is useful for a generic parser, but it loses the user's type when a
 * string field is edited to one of those literal values. Keep the library's
 * parsing behavior for everything else and restore explicitly quoted strings
 * afterwards, which is the representation emitted by Confui.
 */
export function parseIni(text: string): Record<string, unknown> {
  // The `ini` package accepts `=` but treats the equally common `key: value`
  // spelling as a bare boolean key, and rejects section headers with trailing
  // comments (`[*.md] # comment`) or nested character-class brackets (`[*.[ch]]`).
  // Normalize those lines for parsing while keeping the original text intact
  // for quote restoration and source-preserving edits.
  let rightBracketToken: string | undefined;
  const ensureRightBracketToken = (): string => {
    if (!rightBracketToken) {
      let candidate = "\uE001";
      while (text.includes(candidate)) candidate += "\uE001";
      rightBracketToken = candidate;
    }
    return rightBracketToken;
  };
  const normalized = text
    .split(/\r?\n/)
    .map((line) => {
      const header = matchIniSectionHeader(line);
      if (header) {
        const encoded = header.rawSection.includes("]")
          ? header.rawSection.replace(/]/g, ensureRightBracketToken())
          : header.rawSection;
        return `[${encoded}]`;
      }
      return normalizeIniLine(line);
    })
    .join("\n");
  const rawParsed = ini.parse(normalized) as Record<string, unknown>;
  const parsed = rightBracketToken
    ? restoreSectionBracketTokens(rawParsed, rightBracketToken)
    : rawParsed;
  restoreQuotedIniStrings(text, parsed);
  return parsed;
}

export function stringifyIni(value: Record<string, unknown>): string {
  return ini.stringify(value);
}

export interface IniAssignment {
  indent: string;
  rawKey: string;
  character: "=" | ":";
  separator: string;
  rawValue: string;
}

interface IniParseState {
  segments: string[];
  arrayMode: boolean;
  count: number;
  lastAssignment?: { quoted: boolean; value?: string };
  quotedArrayValues: Map<number, string>;
}

export function patchIni(text: string, changes: readonly ConfigChange[]): string {
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const updates = new Map<string, {
    segments: readonly PathSegment[];
    value: unknown;
    wrote: boolean;
  }>();
  for (const change of changes) {
    if (change.segments.length < 1
      || change.segments.some((part) => typeof part !== "string" || isForbiddenKey(part))) {
      throw new ConfuiError("SAVE_ERROR", "INI 只支持字符串类型的节与键");
    }
    assertValidIniSegments(change.segments as string[]);
    if (change.value !== undefined) assertIniValue(change.value);
    updates.set(JSON.stringify(change.segments), { ...change, wrote: false });
  }
  const parsed = parseIni(text);
  const seen = new Set<string>();
  let section: string[] = [];
  const next: string[] = [];
  for (const line of lines) {
    const sectionHeader = matchIniSectionHeader(line);
    if (sectionHeader) {
      section = parseIniSection(sectionHeader.rawSection);
      next.push(line);
      continue;
    }
    if (/^\s*[#;]/.test(line)) {
      next.push(line);
      continue;
    }
    const keyMatch = matchIniAssignment(line);
    const rawKey = keyMatch ? ini.unsafe(keyMatch.rawKey) : "";
    const isArrayAssignment = rawKey.length > 2 && rawKey.endsWith("[]");
    const key = isArrayAssignment ? rawKey.slice(0, -2) : rawKey;
    if (!key || !keyMatch) {
      next.push(line);
      continue;
    }
    const segments = [...section, key];
    const id = JSON.stringify(segments);
    const change = updates.get(id);
    if (!change) {
      next.push(line);
      continue;
    }
    seen.add(id);
    const current = getAtPath(parsed, change.segments);
    const arrayUpdate = Array.isArray(current) || Array.isArray(change.value);
    if (arrayUpdate) {
      if (change.value !== undefined && !Array.isArray(change.value)) {
        throw new ConfuiError("SAVE_ERROR", "INI 数组字段只能替换为数组");
      }
      if (!change.wrote) {
        change.wrote = true;
        if (change.value !== undefined) {
          const rawAssignmentKey = keyMatch.rawKey;
          const assignmentKey = isArrayAssignment ? rawAssignmentKey : `${rawAssignmentKey}[]`;
          const comment = preservedIniComment(keyMatch, section);
          next.push(...formatIniArrayAssignments(keyMatch, assignmentKey, change.value, comment));
        }
      }
      continue;
    }
    if (change.value === undefined) continue;
    const comment = preservedIniComment(keyMatch, section);
    next.push(`${keyMatch.indent}${keyMatch.rawKey}${keyMatch.separator}${formatIniValue(change.value)}${comment}`);
  }
  for (const [id, change] of updates) {
    if (seen.has(id)) continue;
    const stringSegments = change.segments as string[];
    const key = stringSegments.at(-1);
    if (!key) continue;
    if (change.value === undefined) {
      assertAppendable(parsed, stringSegments, "ini");
      continue;
    }
    assertAppendable(parsed, stringSegments, "ini");
    const sectionSegments = stringSegments.slice(0, -1);
    const assignments = formatIniAssignments(key, change.value);
    if (sectionSegments.length) {
      const headerIndex = next.findIndex((line) => {
        const header = matchIniSectionHeader(line);
        return Boolean(header && sameStringPath(parseIniSection(header.rawSection), sectionSegments));
      });
      if (headerIndex >= 0) {
        let insertionIndex = next.findIndex((line, index) => index > headerIndex && Boolean(matchIniSectionHeader(line)));
        if (insertionIndex < 0) insertionIndex = next.length;
        while (insertionIndex > headerIndex + 1 && !next[insertionIndex - 1]?.trim()) insertionIndex -= 1;
        next.splice(insertionIndex, 0, ...assignments);
      } else {
        while (next.length && !next.at(-1)?.trim()) next.pop();
        if (next.length) next.push("");
        next.push(`[${formatIniSection(sectionSegments)}]`, ...assignments);
      }
    } else {
      const firstSection = next.findIndex((line) => Boolean(matchIniSectionHeader(line)));
      const insertionIndex = firstSection >= 0
        ? firstSection
        : next.findIndex((line, index) => index === next.length - 1 && !line.trim());
      next.splice(insertionIndex >= 0 ? insertionIndex : next.length, 0, ...assignments);
    }
  }
  while (next.length > 1 && next.at(-1) === "" && next.at(-2) === "") next.pop();
  return next.join(eol).replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

function isIniAssignmentLine(line: string): boolean {
  const assignment = matchIniAssignment(line);
  return Boolean(assignment && (assignment.character === "=" || !assignment.rawValue.startsWith("//")));
}

function normalizeIniLine(line: string): string {
  if (/^\s*(?:[#;]|\[)/.test(line)) return line;
  const separator = findIniSeparator(line);
  if (!separator || separator.character !== ":") return line;
  return `${line.slice(0, separator.index)}=${line.slice(separator.index + 1)}`;
}

function findIniSeparator(line: string): { index: number; character: "=" | ":" } | undefined {
  let escaped = false;
  let firstColon: number | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "=") {
      // If `:` appeared earlier followed by whitespace (e.g. `url: https://x/?a=1`),
      // treat `:` as the separator; otherwise (e.g. `.npmrc` `@scope:registry=...`
      // or `//registry.npmjs.org/:_authToken=...`), `:` is part of the key name.
      if (firstColon !== undefined && /\s/.test(line[firstColon + 1] ?? "")) {
        return { index: firstColon, character: ":" };
      }
      return { index, character: "=" };
    }
    if (character === ":" && firstColon === undefined && !line.startsWith("//", index + 1)) {
      firstColon = index;
    }
  }
  return firstColon !== undefined ? { index: firstColon, character: ":" } : undefined;
}

export function matchIniAssignment(line: string): IniAssignment | undefined {
  const separator = findIniSeparator(line);
  if (!separator) return undefined;
  const before = line.slice(0, separator.index);
  const indent = before.match(/^\s*/)?.[0] ?? "";
  const keyWithTrailingWhitespace = before.slice(indent.length);
  const rawKey = keyWithTrailingWhitespace.replace(/\s+$/, "");
  if (!rawKey) return undefined;
  const keyTrailingWhitespace = keyWithTrailingWhitespace.slice(rawKey.length);
  const after = line.slice(separator.index + 1);
  const valueLeadingWhitespace = after.match(/^\s*/)?.[0] ?? "";
  return {
    indent,
    rawKey,
    character: separator.character,
    separator: `${keyTrailingWhitespace}${separator.character}${valueLeadingWhitespace}`,
    rawValue: after.slice(valueLeadingWhitespace.length),
  };
}

function restoreQuotedIniStrings(text: string, parsed: Record<string, unknown>): void {
  const states = new Map<string, IniParseState>();
  let section: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const sectionHeader = matchIniSectionHeader(line);
    if (sectionHeader) {
      section = parseIniSection(sectionHeader.rawSection);
      continue;
    }
    if (/^\s*[#;]/.test(line)) continue;
    const keyMatch = matchIniAssignment(line);
    if (!keyMatch) continue;
    const rawKey = ini.unsafe(keyMatch.rawKey);
    const isArray = rawKey.length > 2 && rawKey.endsWith("[]");
    const key = isArray ? rawKey.slice(0, -2) : rawKey;
    const segments = [...section, key];
    if (!key || segments.some(isForbiddenKey)) continue;
    const id = JSON.stringify(segments);
    const state = states.get(id) ?? {
      segments,
      arrayMode: false,
      count: 0,
      quotedArrayValues: new Map<number, string>(),
    };
    const rawValue = splitIniValueAndComment(keyMatch.rawValue).value.trim();
    const quotedValue = readQuotedIniString(rawValue);
    if (state.arrayMode) {
      const index = state.count;
      state.count += 1;
      if (quotedValue !== undefined) state.quotedArrayValues.set(index, quotedValue);
    } else if (isArray) {
      state.arrayMode = true;
      if (state.lastAssignment?.quoted && state.count > 0) {
        state.quotedArrayValues.set(0, state.lastAssignment.value ?? "");
      }
      const index = state.count;
      state.count += 1;
      if (quotedValue !== undefined) state.quotedArrayValues.set(index, quotedValue);
    } else {
      state.count = 1;
      state.lastAssignment = quotedValue === undefined
        ? { quoted: false }
        : { quoted: true, value: quotedValue };
    }
    states.set(id, state);
  }

  for (const state of states.values()) {
    const current = getAtPath(parsed, state.segments);
    if (Array.isArray(current)) {
      for (const [index, value] of state.quotedArrayValues) {
        if (index < current.length) current[index] = value;
      }
    } else if (!state.arrayMode && state.lastAssignment?.quoted) {
      setParsedIniValue(parsed, state.segments, state.lastAssignment.value ?? "");
    }
  }
}

function readQuotedIniString(value: string): string | undefined {
  if (value.length < 2 || !((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return undefined;
  }
  const parsed = ini.unsafe(value);
  if (typeof parsed === "string") return parsed;
  return value.startsWith("'") ? value.slice(1, -1) : undefined;
}

function setParsedIniValue(target: Record<string, unknown>, segments: readonly string[], value: string): void {
  if (!segments.length || segments.some(isForbiddenKey)) return;
  const parent = getAtPath(target, segments.slice(0, -1));
  const key = segments.at(-1);
  if (key === undefined || parent === null || typeof parent !== "object" || Array.isArray(parent)) return;
  (parent as Record<string, unknown>)[key] = value;
}

function formatIniArrayAssignments(
  keyMatch: IniAssignment | undefined,
  key: string,
  values: readonly unknown[],
  comment: string,
): string[] {
  return values.map((value, index) =>
    `${keyMatch?.indent ?? ""}${key}${keyMatch?.separator ?? "="}${formatIniValue(value)}${index === values.length - 1 ? comment : ""}`,
  );
}

function formatIniAssignments(key: string, value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => `${ini.safe(key)}[]=${formatIniValue(item)}`);
  }
  return [`${ini.safe(key)}=${formatIniValue(value)}`];
}

function assertValidIniSegments(segments: readonly string[]): void {
  for (const segment of segments) {
    if (!segment.trim() || INI_INVALID_SEGMENT_CHAR_RE.test(segment)) {
      throw new ConfuiError(
        "SAVE_ERROR",
        `INI 节或键名无效：${JSON.stringify(segment)}`,
        "INI 键名和节名不能为空，且不能包含 =、换行符或控制字符。",
      );
    }
  }
  const leafKey = segments.at(-1)!;
  if (/:\s/.test(leafKey) || leafKey.endsWith("[]")) {
    throw new ConfuiError(
      "SAVE_ERROR",
      `INI 节或键名无效：${JSON.stringify(leafKey)}`,
      "INI 键名不能包含冒号加空白（: ）或以 [] 结尾，以免破坏 INI 键值解析。",
    );
  }
  const sectionSegments = segments.slice(0, -1);
  if (sectionSegments.length > 0) {
    const joined = sectionSegments.join(".");
    const reparsedHeader = matchIniSectionHeader(`[${joined}]`);
    if (!reparsedHeader || reparsedHeader.comment !== "" || reparsedHeader.rawSection !== joined) {
      throw new ConfuiError(
        "SAVE_ERROR",
        `INI 节或键名无效：${JSON.stringify(joined)}`,
        "INI 节名不能包含未配对的方括号（如 ]）或节头注释注入，以免破坏节头解析。",
      );
    }
  }
}

function assertIniValue(value: unknown): void {
  if (isScalarValue(value)) return;
  if (Array.isArray(value) && value.length > 0 && value.every(isScalarValue)) return;
  throw new ConfuiError("SAVE_ERROR", "INI 只支持字符串、数字、布尔值或标量数组", "复杂对象不能安全地表示为 INI 值。");
}

function formatIniValue(value: unknown): string {
  if (typeof value === "string" && /^(?:true|false|null)$/.test(value)) return JSON.stringify(value);
  if (value === null) return "null";
  return ini.safe(String(value ?? ""));
}

export function splitIniValueAndComment(raw: string): { value: string; comment: string } {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }
    if ((character === ";" || character === "#") && !quote) {
      let commentStart = index;
      while (commentStart > 0 && /\s/.test(raw[commentStart - 1] ?? "")) commentStart -= 1;
      return { value: raw.slice(0, commentStart), comment: raw.slice(commentStart) };
    }
  }
  return { value: raw, comment: "" };
}

/**
 * Matches an INI / `.editorconfig` section header line such as `[section]`,
 * `[*.md] # markdown`, or `[*.[ch]] ; C headers`, balancing nested character-class
 * brackets (`[...]`) and allowing optional trailing `#` / `;` comments.
 */
export function matchIniSectionHeader(line: string): { rawSection: string; comment: string } | undefined {
  const trimmedStart = line.trimStart();
  if (!trimmedStart.startsWith("[")) return undefined;
  let bracketDepth = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let closeIdx = -1;
  for (let index = 0; index < trimmedStart.length; index += 1) {
    const ch = trimmedStart[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        closeIdx = index;
        break;
      }
    }
  }
  if (closeIdx <= 1) return undefined;
  const tail = trimmedStart.slice(closeIdx + 1);
  if (!/^\s*(?:[#;].*)?$/.test(tail)) return undefined;
  const rawSection = trimmedStart.slice(1, closeIdx);
  if (!rawSection.trim()) return undefined;
  return { rawSection, comment: tail };
}

function restoreSectionBracketTokens(obj: Record<string, unknown>, token: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const restoredKey = key.includes(token) ? key.split(token).join("]") : key;
    const restoredValue = value !== null && typeof value === "object" && !Array.isArray(value)
      ? restoreSectionBracketTokens(value as Record<string, unknown>, token)
      : value;
    setSafeProperty(result, restoredKey, restoredValue);
  }
  return result;
}

/**
 * Returns true when an INI / `.npmrc` assignment targets a sensitive key
 * (including `.npmrc` scoped registry credentials like `//host/:_authToken=...`
 * or any key/section matching `isSensitiveKey`). Trailing `;` / `#` segments on
 * such lines must never be extracted as comments because credentials often
 * contain `;` or `#`.
 */
export function isSensitiveIniAssignment(rawKey: string, section: readonly string[] = []): boolean {
  const trimmed = rawKey.trim();
  if (trimmed.startsWith("//")) return true;
  const decoded = ini.unsafe(trimmed);
  const key = decoded.length > 2 && decoded.endsWith("[]") ? decoded.slice(0, -2) : decoded;
  return key.startsWith("//") || isSensitiveKey(key) || section.some(isSensitiveKey);
}

function preservedIniComment(keyMatch: IniAssignment, section: readonly string[]): string {
  const parsedComment = splitIniValueAndComment(keyMatch.rawValue).comment;
  if (!parsedComment) return "";
  if (!isSensitiveIniAssignment(keyMatch.rawKey, section)) return parsedComment;
  // Never carry over unquoted `;` / `#` tails from a sensitive INI / `.npmrc`
  // assignment (e.g. `//host/:_authToken=part1;part2`, `//host/:custom=a#b`,
  // or passwords containing `;`/`#`).
  if (
    keyMatch.rawKey.trim().startsWith("//")
    || parsedComment.trimStart().startsWith(";")
    || !/^\s/.test(parsedComment)
  ) {
    return "";
  }
  return parsedComment;
}

export function parseIniSection(raw: string): string[] {
  const section = ini.unsafe(raw);
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index < section.length; index += 1) {
    if (section[index] !== "." || section[index - 1] === "\\") continue;
    segments.push(section.slice(start, index).replace(/\\\./g, "."));
    start = index + 1;
  }
  segments.push(section.slice(start).replace(/\\\./g, "."));
  return segments;
}

function formatIniSection(segments: readonly string[]): string {
  return segments.map((segment) => ini.safe(segment.replace(/\./g, "\\."))).join(".");
}

function sameStringPath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}
