import type { ConfigChange } from "../../shared/schema.ts";
import { ConfuiError } from "../errors.ts";
import { assertAppendable, detectEol, escapeRegExp, isScalarValue } from "./common.ts";

export function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match?.[1]) continue;
    result[match[1]] = unquote(splitEnvValueAndComment(match[2] ?? "").value);
  }
  return result;
}

export function stringifyEnv(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${formatEnvValue(item)}`)
    .join("\n");
}

export function patchEnv(text: string, changes: readonly ConfigChange[]): string {
  const eol = detectEol(text);
  const updates = new Map<string, unknown>();
  for (const change of changes) {
    if (change.segments.length !== 1 || typeof change.segments[0] !== "string") {
      throw new ConfuiError("SAVE_ERROR", "ENV 只支持顶层键值");
    }
    if (change.value !== undefined && !isScalarValue(change.value)) {
      throw new ConfuiError("SAVE_ERROR", "ENV 只支持标量键值", "复杂对象不能安全地表示为这种格式。");
    }
    updates.set(change.segments[0], change.value);
  }

  const parsed = parseEnv(text);
  const seen = new Set<string>();
  const nextLines: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      nextLines.push(line);
      continue;
    }
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    const key = match?.[2];
    if (!key || !updates.has(key)) {
      nextLines.push(line);
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

export function formatEnvValue(value: unknown, previous = ""): string {
  const stringValue = String(value ?? "");
  const previousValue = previous.trim();
  let quote = previousValue.startsWith("\"") && previousValue.endsWith("\"")
    ? "\""
    : previousValue.startsWith("'") && previousValue.endsWith("'")
      ? "'"
      : /[\s#=\\"']/.test(stringValue)
        ? "\""
        : "";
  if (quote === "'" && stringValue.includes("'")) quote = "\"";
  // A single-quoted ENV value cannot span physical lines. Switch to a
  // double-quoted escaped representation before a multiline value turns the
  // remainder of the assignment into unrelated lines.
  if (quote === "'" && /[\r\n\t]/.test(stringValue)) quote = "\"";
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
  if (firstChar === "'" || firstChar === '"') {
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
