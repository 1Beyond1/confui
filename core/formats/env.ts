import type { ConfigChange } from "../../shared/schema.ts";
import { ConfuiError } from "../errors.ts";
import { assertAppendable, detectEol, escapeRegExp, isScalarValue } from "./common.ts";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const group of groupEnvLines(text.split(/\r?\n/))) {
    const logical = group.join("\n");
    const trimmed = logical.trim();
    if (!trimmed || (group.length === 1 && trimmed.startsWith("#"))) continue;
    const match = logical.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([\s\S]*)$/);
    if (!match?.[1]) continue;
    result[match[1]] = unquote(splitEnvValueAndComment(match[2] ?? "").value);
  }
  return result;
}

export function stringifyEnv(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => {
      assertValidEnvKey(key);
      return `${key}=${formatEnvValue(item)}`;
    })
    .join("\n");
}

function assertValidEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key)) {
    throw new ConfuiError(
      "SAVE_ERROR",
      `ENV 变量名无效：${JSON.stringify(key)}`,
      "ENV 键名只允许英文字母、数字和下划线，且必须以字母或下划线开头（不允许包含 =、换行符、-、. 或空格）。",
    );
  }
}

export function patchEnv(text: string, changes: readonly ConfigChange[]): string {
  const eol = detectEol(text);
  const updates = new Map<string, unknown>();
  for (const change of changes) {
    if (change.segments.length !== 1 || typeof change.segments[0] !== "string") {
      throw new ConfuiError("SAVE_ERROR", "ENV 只支持顶层键值");
    }
    const key = change.segments[0];
    assertValidEnvKey(key);
    if (change.value !== undefined && !isScalarValue(change.value)) {
      throw new ConfuiError("SAVE_ERROR", "ENV 只支持标量键值", "复杂对象不能安全地表示为这种格式。");
    }
    updates.set(key, change.value);
  }

  const parsed = parseEnv(text);
  const seen = new Set<string>();
  const nextLines: string[] = [];

  // ENV quoted values (`"..."`, `'...'`, `` `...` ``) may span multiple physical
  // lines. Group physical lines into logical assignments first so updates and
  // deletions replace or remove the entire block without leaving orphan lines.
  for (const group of groupEnvLines(text.split(/\r?\n/))) {
    const logical = group.join("\n");
    const trimmed = logical.trim();
    if (!trimmed || (group.length === 1 && trimmed.startsWith("#"))) {
      nextLines.push(...group);
      continue;
    }
    const match = logical.match(/^([ \t]*(?:export[ \t]+)?)([A-Za-z_][A-Za-z0-9_]*)([ \t]*=[ \t]*)([\s\S]*)$/);
    const key = match?.[2];
    if (!key || !updates.has(key)) {
      nextLines.push(...group);
      continue;
    }
    seen.add(key);
    if (updates.get(key) === undefined) continue;
    const oldValue = match?.[4] ?? "";
    const envParts = splitEnvValueAndComment(oldValue);
    const separator = match?.[3] ?? "=";
    const nextValue = `${formatEnvValue(updates.get(key), envParts.value)}${envParts.comment}`;
    nextLines.push(`${match?.[1] ?? ""}${key}${separator}${nextValue}`);
  }

  for (const [key, value] of updates) {
    if (seen.has(key)) continue;
    if (value === undefined) {
      assertAppendable(parsed, [key], "env");
      continue;
    }
    assertAppendable(parsed, [key], "env");
    if (nextLines.at(-1) === "") nextLines.pop();
    nextLines.push(`${key}=${formatEnvValue(value)}`);
  }

  while (nextLines.length > 1 && nextLines.at(-1) === "" && nextLines.at(-2) === "") nextLines.pop();
  return nextLines.join(eol).replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

/**
 * Groups physical `.env` lines into logical entries while tracking open
 * single-quoted (`'`), double-quoted (`"`), and backtick-quoted (`` ` ``)
 * multi-line values.
 */
export function groupEnvLines(lines: readonly string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let openQuote: '"' | "'" | "`" | undefined;

  for (const line of lines) {
    if (openQuote !== undefined) {
      current.push(line);
      if (findClosingEnvQuote(line, 0, openQuote) >= 0) {
        groups.push(current);
        current = [];
        openQuote = undefined;
      }
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      groups.push([line]);
      continue;
    }

    const match = line.match(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/);
    if (!match) {
      groups.push([line]);
      continue;
    }

    const rawValue = match[2] ?? "";
    const firstChar = rawValue[0];
    if (firstChar === '"' || firstChar === "'" || firstChar === "`") {
      if (findClosingEnvQuote(rawValue, 1, firstChar) < 0) {
        current = [line];
        openQuote = firstChar;
        continue;
      }
    }

    groups.push([line]);
  }

  if (current.length) groups.push(current);
  return groups;
}

function findClosingEnvQuote(line: string, startIndex: number, quote: '"' | "'" | "`"): number {
  let escaped = false;
  for (let index = startIndex; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) {
      return index;
    }
  }
  return -1;
}

export function formatEnvValue(value: unknown, previous = ""): string {
  const stringValue = String(value ?? "");
  const previousValue = previous.trim();
  let quote = previousValue.startsWith("\"") && previousValue.endsWith("\"")
    ? "\""
    : previousValue.startsWith("'") && previousValue.endsWith("'")
      ? "'"
      : previousValue.startsWith("`") && previousValue.endsWith("`")
        ? "`"
        : /[\s#=\\"'`]/.test(stringValue)
          ? "\""
          : "";
  if (quote === "'" && stringValue.includes("'")) quote = "\"";
  if (quote === "`" && stringValue.includes("`")) quote = "\"";
  // Single-quoted and backtick-quoted ENV values are normalized to an escaped
  // double-quoted line whenever a value contains line breaks or tabs so edits
  // round-trip cleanly on one assignment line.
  if ((quote === "'" || quote === "`") && /[\r\n\t]/.test(stringValue)) quote = "\"";
  if (!quote) return stringValue;
  const escaped = quote === "\""
    ? stringValue
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
    : stringValue;
  return `${quote}${escaped}${quote}`;
}

export function splitEnvValueAndComment(raw: string): { value: string; comment: string } {
  const leadingWhitespace = raw.match(/^\s*/)?.[0].length ?? 0;
  const firstChar = raw[leadingWhitespace];
  if (firstChar === "'" || firstChar === '"' || firstChar === "`") {
    const quote = firstChar;
    let escaped = false;
    let closed = false;
    for (let index = leadingWhitespace + 1; index < raw.length; index += 1) {
      const character = raw[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (!closed && character === "\\" && quote === '"') {
        escaped = true;
        continue;
      }
      if (!closed && character === quote) {
        closed = true;
        continue;
      }
      if (closed && character === "#") {
        let commentStart = index;
        while (commentStart > 0 && /\s/.test(raw[commentStart - 1] ?? "")) commentStart -= 1;
        return { value: raw.slice(0, commentStart), comment: raw.slice(commentStart) };
      }
    }
    return { value: raw, comment: "" };
  }
  for (let index = leadingWhitespace; index < raw.length; index += 1) {
    if (raw[index] === "#" && (index === leadingWhitespace || /\s/.test(raw[index - 1] ?? ""))) {
      let commentStart = index;
      while (commentStart > 0 && /\s/.test(raw[commentStart - 1] ?? "")) commentStart -= 1;
      return { value: raw.slice(0, commentStart), comment: raw.slice(commentStart) };
    }
  }
  return { value: raw, comment: "" };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return decodeEnvEscapes(trimmed.slice(1, -1));
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  if (trimmed.length >= 2 && trimmed.startsWith("`") && trimmed.endsWith("`")) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "");
}

function decodeEnvEscapes(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\" || index === value.length - 1) {
      output += character;
      continue;
    }
    const escaped = value[index + 1];
    index += 1;
    output += escaped === "n"
      ? "\n"
      : escaped === "r"
        ? "\r"
        : escaped === "t"
          ? "\t"
          : escaped === "\\" || escaped === '"'
            ? escaped
            // dotenv-style files are not JavaScript strings. Preserve an
            // unknown escape verbatim so quoted Windows paths such as
            // `C:\\Program Files` do not silently lose their backslashes.
            : `\\${escaped ?? ""}`;
  }
  return output;
}
