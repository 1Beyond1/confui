import * as ini from "ini";
import * as yaml from "js-yaml";
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  visit,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { ConfigChange, ConfigFormat, PathSegment } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";
import { cloneValue, deleteAtPath, formatPath, getAtPath, setAtPath } from "./paths.ts";

/** Share of meaningful lines that must look like `[section]` or `key=value`. */
const INI_ASSIGNMENT_RATIO = 0.8;
const UTF8_BOM = "\uFEFF";

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

/** True when the extension alone is enough to trust the INI parser. */
export function isUnambiguousIniName(filename: string): boolean {
  return filename.toLowerCase().endsWith(".ini");
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
    if (/^\[[^\]]+]$/.test(line) || /^[^=]+=/.test(line)) assignments += 1;
    else others += 1;
  }
  const total = assignments + others;
  // An empty or comment-only file has nothing that could be misread.
  if (!total) return true;
  return assignments / total >= INI_ASSIGNMENT_RATIO;
}

/**
 * Main-process guard for the `.conf` / `.cfg` sniff. The scanner already marks
 * these files `unsupported`, but inference and save must not depend on the
 * renderer honouring that flag.
 */
export function assertEditableSyntax(filename: string, text: string): void {
  if (detectFormat(filename) !== "ini" || isUnambiguousIniName(filename)) return;
  if (looksLikeIni(text)) return;
  throw new ConfuiError(
    "PARSE_ERROR",
    "这个文件不是 INI 语法，Confui 不会编辑它",
    `${filename}：nginx / httpd / redis 这类指令式配置只是共用了 .conf / .cfg 扩展名，`
      + "按 INI 解析会把指令误读成开关，保存时还会写入无效内容。",
  );
}

export function parseConfig(text: string, format: ConfigFormat): unknown {
  try {
    const source = stripBom(text);
    switch (format) {
      case "json":
      case "jsonc": {
        const errors: ParseError[] = [];
        const value = parse(source, errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length) {
          const first = errors[0]!;
          throw new Error(`${printParseErrorCode(first.error)} @ ${first.offset}`);
        }
        assertNoDuplicateJsonKeys(source);
        return value;
      }
      case "yaml": {
        const value = yaml.load(source) ?? {};
        assertNoCircularReferences(value);
        return value;
      }
      case "toml":
        return parseToml(source);
      case "env":
        return parseEnv(source);
      case "ini":
        return ini.parse(source);
      case "properties":
        return parseProperties(source);
    }
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
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
  const bom = originalText.startsWith(UTF8_BOM) ? UTF8_BOM : "";
  const source = bom ? originalText.slice(1) : originalText;
  let result: { output: string; warnings: string[] };
  switch (format) {
    case "json":
    case "jsonc":
      result = { output: updateJsonc(source, changes), warnings: [] };
      break;
    case "env":
      result = { output: patchFlatAssignments(source, changes, "env"), warnings: [] };
      break;
    case "properties":
      result = { output: patchFlatAssignments(source, changes, "properties"), warnings: [] };
      break;
    case "ini":
      result = { output: patchIni(source, changes), warnings: [] };
      break;
    case "yaml":
    case "toml": {
      const parsed = parseConfig(source, format);
      const next = cloneValue(parsed);
      for (const change of changes) {
        if (change.value === undefined) deleteAtPath(next, change.segments);
        else setAtPath(next, change.segments, change.value);
      }
      result = {
        output: stringifyConfig(next, format, source),
        warnings: [
          `${format.toUpperCase()} 保存会重新排版文件；键和值会保留，但原有注释可能无法完整保留。`,
        ],
      };
      break;
    }
  }
  return { ...result, output: bom + result.output };
}

function assertNoDuplicateJsonKeys(text: string): void {
  const seen = new Set<string>();
  let duplicate: PathSegment[] | undefined;
  visit(text, {
    onObjectProperty(property, _offset, _length, _line, _character, pathSupplier) {
      const path = [...pathSupplier(), property] as PathSegment[];
      const id = JSON.stringify(path);
      if (seen.has(id)) duplicate ??= path;
      else seen.add(id);
    },
  }, { allowTrailingComma: true, disallowComments: false });
  if (duplicate) throw new Error(`存在重复的 JSON 键：${formatPath(duplicate)}`);
}

/**
 * YAML aliases can describe a cyclic object graph even though the source is
 * valid YAML. The form editor and the serializers operate on JSON-like trees;
 * rejecting only cycles keeps shared (but acyclic) aliases usable and avoids a
 * later renderer crash or an opaque "circular structure" save error.
 */
function assertNoCircularReferences(value: unknown): void {
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
  for (const rawLine of joinPropertyLines(text.split(/\r?\n/))) {
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
  const updates = new Map<string, unknown>();
  for (const change of changes) {
    if (change.segments.length !== 1 || typeof change.segments[0] !== "string") {
      throw new ConfuiError("SAVE_ERROR", `${format.toUpperCase()} 只支持顶层键值`);
    }
    updates.set(change.segments[0], change.value);
  }
  const parsed = format === "env" ? parseEnv(text) : parseProperties(text);
  const seen = new Set<string>();
  const nextLines: string[] = [];
  // Properties values may span several physical lines via a trailing "\".
  // Match against the joined logical line so the whole group is replaced
  // together and no continuation is left behind as an orphan key.
  for (const group of groupLogicalLines(text.split(/\r?\n/), format)) {
    const logical = format === "properties" ? joinPropertyLines(group)[0] ?? "" : group[0] ?? "";
    const match = format === "env"
      ? logical.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/)
      : logical.match(/^(\s*)((?:\\.|[^:=\s])+?)(\s*(?:[:=]|\s)\s*)(.*)$/);
    const rawKey = match?.[2];
    const key = rawKey && format === "properties" ? unescapeProperty(rawKey) : rawKey;
    if (!rawKey || !key || !updates.has(key)) {
      nextLines.push(...group);
      continue;
    }
    seen.add(key);
    if (updates.get(key) === undefined) {
      // `undefined` means the user chose “未设置”. Flat formats have no
      // native undefined value, so remove the whole assignment (including a
      // Java Properties continuation) instead of turning it into `KEY=`.
      continue;
    }
    const oldValue = match?.[4] ?? "";
    const envParts = format === "env" ? splitEnvValueAndComment(oldValue) : undefined;
    const nextValue = format === "env"
      ? `${formatEnvValue(updates.get(key), envParts?.value)}${envParts?.comment ?? ""}`
      : escapeProperty(String(updates.get(key) ?? ""));
    nextLines.push(`${match?.[1] ?? ""}${rawKey}${match?.[3] ?? "="}${nextValue}`);
  }
  for (const [key, value] of updates) {
    if (seen.has(key)) continue;
    if (value === undefined) {
      // Do not append a new assignment just to represent an unset field. Keep
      // the same append-safety check used for normal updates in case the
      // parser saw a value that the line scanner could not safely locate.
      assertAppendable(parsed, [key], format);
      continue;
    }
    assertAppendable(parsed, [key], format);
    // split() represents the existing terminal newline as one empty item.
    // Remove only that sentinel before appending, while preserving real blank
    // lines that the user intentionally left at the end of the file.
    if (nextLines.at(-1) === "") nextLines.pop();
    nextLines.push(
      format === "env"
        ? `${key}=${formatEnvValue(value)}`
        : `${escapeProperty(key, true)}=${escapeProperty(String(value ?? ""))}`,
    );
  }
  while (nextLines.length > 1 && nextLines.at(-1) === "" && nextLines.at(-2) === "") nextLines.pop();
  return nextLines.join(eol).replace(new RegExp(`${escapeRegExp(eol)}+$`), "") + eol;
}

/**
 * Groups physical lines into logical ones. A properties line continues into
 * the next when it ends with an odd number of backslashes.
 */
function groupLogicalLines(lines: readonly string[], format: "env" | "properties"): string[][] {
  if (format !== "properties") return lines.map((line) => [line]);
  const groups: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    current.push(line);
    if (!hasPropertyContinuation(line)) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function joinPropertyLines(lines: readonly string[]): string[] {
  const logical: string[] = [];
  let current: string | undefined;
  for (const physical of lines) {
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

/**
 * Refuses to append a key that the parser already reported. Hitting this means
 * the text scan could not find the line the value came from, so appending
 * would add a second, contradictory definition instead of editing in place.
 */
function assertAppendable(
  parsed: unknown,
  segments: readonly PathSegment[],
  format: ConfigFormat,
): void {
  if (getAtPath(parsed, segments) === undefined) return;
  throw new ConfuiError(
    "SAVE_ERROR",
    "无法在原文件中定位这个配置项，已取消保存",
    `${segments.join(".")}：该键存在于解析结果中，但文件里没有对应的赋值行。`
      + `这通常说明文件不是标准 ${format.toUpperCase()} 语法，Confui 不会向它追加内容。`,
  );
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
  const parsed = ini.parse(text);
  const seen = new Set<string>();
  let section: string[] = [];
  const next: string[] = [];
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/);
    if (sectionMatch?.[1]) {
      section = parseIniSection(sectionMatch[1]);
      next.push(line);
      continue;
    }
    if (/^\s*[#;]/.test(line)) {
      next.push(line);
      continue;
    }
    const keyMatch = line.match(/^(\s*)([^=]+?)(\s*=\s*)(.*)$/);
    const key = keyMatch?.[2] ? ini.unsafe(keyMatch[2]) : "";
    if (!key) {
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
    if (change.value === undefined) continue;
    const comment = splitIniValueAndComment(keyMatch?.[4] ?? "").comment;
    next.push(`${keyMatch?.[1] ?? ""}${keyMatch?.[2] ?? key}${keyMatch?.[3] ?? "="}${ini.safe(String(change.value ?? ""))}${comment}`);
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
      : /[\s#=\\\"]/.test(stringValue)
        ? "\""
        : "";
  if (quote === "'" && stringValue.includes("'")) quote = "\"";
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

function escapeProperty(value: string, key = false): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\f/g, "\\f")
    .replace(/([:=])/g, "\\$1");
  if (key) return escaped.replace(/ /g, "\\ ").replace(/^([#!])/, "\\$1");
  return escaped.replace(/^ +/, (spaces) => spaces.replace(/ /g, "\\ "));
}

function unescapeProperty(value: string): string {
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}
