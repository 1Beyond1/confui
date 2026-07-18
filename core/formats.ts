import * as ini from "ini";
import * as yaml from "js-yaml";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { ConfigChange, ConfigFormat, PathSegment } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";
import { cloneValue, setAtPath } from "./paths.ts";

export function detectFormat(filename: string): ConfigFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".jsonc")) return "jsonc";
  if (lower.endsWith(".json") || lower === ".eslintrc" || lower === ".prettierrc") return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) return "env";
  if (lower.endsWith(".ini") || lower.endsWith(".conf") || lower.endsWith(".cfg")) return "ini";
  if (lower.endsWith(".properties")) return "properties";
  return null;
}

export function parseConfig(text: string, format: ConfigFormat): unknown {
  try {
    switch (format) {
      case "json":
      case "jsonc": {
        const errors: ParseError[] = [];
        const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length) {
          const first = errors[0]!;
          throw new Error(`${printParseErrorCode(first.error)} @ ${first.offset}`);
        }
        return value;
      }
      case "yaml":
        return yaml.load(text) ?? {};
      case "toml":
        return parseToml(text);
      case "env":
        return parseEnv(text);
      case "ini":
        return ini.parse(text);
      case "properties":
        return parseProperties(text);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfuiError("PARSE_ERROR", "无法解析这个配置文件", detail);
  }
}

export function stringifyConfig(value: unknown, format: ConfigFormat, originalText = ""): string {
  const eol = originalText.includes("\r\n") ? "\r\n" : "\n";
  let output: string;
  switch (format) {
    case "json":
    case "jsonc":
      output = JSON.stringify(value, null, detectIndent(originalText));
      break;
    case "yaml":
      output = yaml.dump(value, { indent: 2, noRefs: true, lineWidth: 100, sortKeys: false });
      break;
    case "toml":
      output = stringifyToml(value as Record<string, unknown>);
      break;
    case "env":
      output = Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${key}=${formatEnvValue(item)}`)
        .join("\n");
      break;
    case "ini":
      output = ini.stringify(value as Record<string, unknown>);
      break;
    case "properties":
      output = Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${escapeProperty(key, true)}=${escapeProperty(String(item ?? ""))}`)
        .join("\n");
      break;
  }
  output = output.replace(/\r?\n/g, eol);
  return output.endsWith(eol) ? output : output + eol;
}

export function updateConfigText(
  originalText: string,
  format: ConfigFormat,
  changes: readonly ConfigChange[],
): { output: string; warnings: string[] } {
  if (!changes.length) return { output: originalText, warnings: [] };
  switch (format) {
    case "json":
    case "jsonc":
      return { output: updateJsonc(originalText, changes), warnings: [] };
    case "env":
      return { output: patchFlatAssignments(originalText, changes, "env"), warnings: [] };
    case "properties":
      return { output: patchFlatAssignments(originalText, changes, "properties"), warnings: [] };
    case "ini":
      return { output: patchIni(originalText, changes), warnings: [] };
    case "yaml":
    case "toml": {
      const parsed = parseConfig(originalText, format);
      const next = cloneValue(parsed);
      for (const change of changes) setAtPath(next, change.segments, change.value);
      return {
        output: stringifyConfig(next, format, originalText),
        warnings: [
          `${format.toUpperCase()} 保存会重新排版文件；键和值会保留，但原有注释可能无法完整保留。`,
        ],
      };
    }
  }
}

function updateJsonc(originalText: string, changes: readonly ConfigChange[]): string {
  let output = originalText;
  const formattingOptions = detectFormattingOptions(originalText);
  for (const change of changes) {
    const edits = modify(output, change.segments, change.value, { formattingOptions });
    output = applyEdits(output, edits);
  }
  return output;
}

function detectFormattingOptions(text: string): FormattingOptions {
  const indentMatch = text.match(/\n([ \t]+)["'}\w]/);
  const indent = indentMatch?.[1] ?? "  ";
  return {
    insertSpaces: !indent.includes("\t"),
    tabSize: indent.includes("\t") ? 1 : Math.max(1, indent.length),
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}

function detectIndent(text: string): string | number {
  const indent = text.match(/\n([ \t]+)["'}\w]/)?.[1];
  if (!indent) return 2;
  return indent.includes("\t") ? "\t" : indent.length;
}

function parseEnv(text: string): Record<string, string> {
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

function parseProperties(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of joinContinuations(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const match = rawLine.match(/^\s*((?:\\.|[^:=\s])+?)\s*(?:[:=]|\s)\s*(.*)$/);
    if (match?.[1]) result[unescapeProperty(match[1])] = unescapeProperty(match[2] ?? "");
  }
  return result;
}

function patchFlatAssignments(
  text: string,
  changes: readonly ConfigChange[],
  format: "env" | "properties",
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const updates = new Map<string, unknown>();
  for (const change of changes) {
    if (change.segments.length !== 1 || typeof change.segments[0] !== "string") {
      throw new ConfuiError("SAVE_ERROR", `${format.toUpperCase()} 只支持顶层键值`);
    }
    updates.set(change.segments[0], change.value);
  }
  const seen = new Set<string>();
  const nextLines = lines.map((line) => {
    const match = format === "env"
      ? line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/)
      : line.match(/^(\s*)((?:\\.|[^:=\s])+?)(\s*(?:[:=]|\s)\s*)(.*)$/);
    const rawKey = match?.[2];
    if (!rawKey) return line;
    const key = format === "properties" ? unescapeProperty(rawKey) : rawKey;
    if (!updates.has(key)) return line;
    seen.add(key);
    const oldValue = match?.[4] ?? "";
    const envParts = format === "env" ? splitEnvValueAndComment(oldValue) : undefined;
    const nextValue = format === "env"
      ? `${formatEnvValue(updates.get(key), envParts?.value)}${envParts?.comment ?? ""}`
      : escapeProperty(String(updates.get(key) ?? ""));
    return `${match?.[1] ?? ""}${rawKey}${match?.[3] ?? "="}${nextValue}`;
  });
  for (const [key, value] of updates) {
    if (seen.has(key)) continue;
    nextLines.push(
      format === "env"
        ? `${key}=${formatEnvValue(value)}`
        : `${escapeProperty(key, true)}=${escapeProperty(String(value ?? ""))}`,
    );
  }
  while (nextLines.length > 1 && nextLines.at(-1) === "" && nextLines.at(-2) === "") nextLines.pop();
  return nextLines.join(eol).replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

function patchIni(text: string, changes: readonly ConfigChange[]): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const updates = new Map<string, { segments: readonly PathSegment[]; value: unknown }>();
  for (const change of changes) {
    if (change.segments.length < 1 || change.segments.some((part) => typeof part !== "string")) {
      throw new ConfuiError("SAVE_ERROR", "INI 只支持字符串类型的节与键");
    }
    updates.set(JSON.stringify(change.segments), change);
  }
  const seen = new Set<string>();
  let section: string[] = [];
  const next = lines.map((line) => {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (sectionMatch?.[1]) {
      section = parseIniSection(sectionMatch[1]);
      return line;
    }
    if (/^\s*[#;]/.test(line)) return line;
    const keyMatch = line.match(/^(\s*)([^=]+?)(\s*=\s*)(.*)$/);
    const key = keyMatch?.[2] ? ini.unsafe(keyMatch[2]) : "";
    if (!key) return line;
    const segments = [...section, key];
    const id = JSON.stringify(segments);
    const change = updates.get(id);
    if (!change) return line;
    seen.add(id);
    const comment = splitIniValueAndComment(keyMatch?.[4] ?? "").comment;
    return `${keyMatch?.[1] ?? ""}${keyMatch?.[2] ?? key}${keyMatch?.[3] ?? "="}${ini.safe(String(change.value ?? ""))}${comment}`;
  });
  for (const [id, change] of updates) {
    if (seen.has(id)) continue;
    const stringSegments = change.segments as string[];
    const key = stringSegments.at(-1);
    if (!key) continue;
    const sectionSegments = stringSegments.slice(0, -1);
    const assignment = `${ini.safe(key)}=${ini.safe(String(change.value ?? ""))}`;
    if (sectionSegments.length) {
      const headerIndex = next.findIndex((line) => {
        const match = line.match(/^\s*\[([^\]]+)]\s*$/);
        return Boolean(match?.[1] && sameStringPath(parseIniSection(match[1]), sectionSegments));
      });
      if (headerIndex >= 0) {
        let insertionIndex = next.findIndex((line, index) => index > headerIndex && /^\s*\[[^\]]+]\s*$/.test(line));
        if (insertionIndex < 0) insertionIndex = next.length;
        while (insertionIndex > headerIndex + 1 && !next[insertionIndex - 1]?.trim()) insertionIndex -= 1;
        next.splice(insertionIndex, 0, assignment);
      } else {
        while (next.length && !next.at(-1)?.trim()) next.pop();
        if (next.length) next.push("");
        next.push(`[${formatIniSection(sectionSegments)}]`, assignment);
      }
    } else {
      const firstSection = next.findIndex((line) => /^\s*\[[^\]]+]\s*$/.test(line));
      const insertionIndex = firstSection >= 0 ? firstSection : next.findIndex((line, index) => index === next.length - 1 && !line.trim());
      next.splice(insertionIndex >= 0 ? insertionIndex : next.length, 0, assignment);
    }
  }
  while (next.length > 1 && next.at(-1) === "" && next.at(-2) === "") next.pop();
  return next.join(eol).replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

function formatEnvValue(value: unknown, previous = ""): string {
  const stringValue = String(value ?? "");
  const previousValue = previous.trim();
  let quote = previousValue.startsWith("\"") && previousValue.endsWith("\"")
    ? "\""
    : previousValue.startsWith("'") && previousValue.endsWith("'")
      ? "'"
      : /[\s#=]/.test(stringValue)
        ? "\""
        : "";
  if (quote === "'" && stringValue.includes("'")) quote = "\"";
  if (!quote) return stringValue;
  const escaped = quote === "\"" ? stringValue.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : stringValue;
  return `${quote}${escaped}${quote}`;
}

function splitIniValueAndComment(raw: string): { value: string; comment: string } {
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

function parseIniSection(raw: string): string[] {
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

function splitEnvValueAndComment(raw: string): { value: string; comment: string } {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }
    if (character === "#" && !quote) {
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
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed.replace(/\s+#.*$/, "");
}

function joinContinuations(text: string): string {
  return text.replace(/\\\r?\n\s*/g, "");
}

function escapeProperty(value: string, key = false): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/([:=])/g, "\\$1").replace(/\n/g, "\\n");
  if (key) return escaped.replace(/ /g, "\\ ").replace(/^([#!])/, "\\$1");
  return escaped.replace(/^ +/, (spaces) => spaces.replace(/ /g, "\\ "));
}

function unescapeProperty(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\([\\:= ])/g, "$1");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
