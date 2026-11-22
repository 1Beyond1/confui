import type { ConfigChange, ConfigFormat } from "../../shared/schema.ts";
import { ConfuiError } from "../errors.ts";
import { normalizeLineEndings, stripBom, UTF8_BOM } from "./common.ts";
import { parseEnv, patchEnv, stringifyEnv } from "./env.ts";
import { isUnambiguousIniName, looksLikeIni, parseIni, patchIni, stringifyIni } from "./ini.ts";
import { parseJsonc, stringifyJsonc, updateJsonc } from "./json.ts";
import { parseProperties, patchProperties, stringifyProperties } from "./properties.ts";
import { parseToml, stringifyToml, updateToml } from "./toml.ts";
import type { UpdateConfigResult } from "./types.ts";
import { parseYaml, stringifyYaml, updateYaml } from "./yaml.ts";

export { isUnambiguousIniName, looksLikeIni };
export type { UpdateConfigResult };

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
      case "jsonc":
        return parseJsonc(source);
      case "yaml":
        return parseYaml(source);
      case "toml":
        return parseToml(source);
      case "env":
        return parseEnv(source);
      case "ini":
        return parseIni(source);
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
  let output: string;
  switch (format) {
    case "json":
    case "jsonc":
      output = stringifyJsonc(value, originalText);
      break;
    case "yaml":
      output = stringifyYaml(value);
      break;
    case "toml":
      output = stringifyToml(value as Record<string, unknown>);
      break;
    case "env":
      output = stringifyEnv(value as Record<string, unknown>);
      break;
    case "ini":
      output = stringifyIni(value as Record<string, unknown>);
      break;
    case "properties":
      output = stringifyProperties(value as Record<string, unknown>);
      break;
  }
  return normalizeLineEndings(output, originalText);
}

export function updateConfigText(
  originalText: string,
  format: ConfigFormat,
  changes: readonly ConfigChange[],
): UpdateConfigResult {
  if (!changes.length) return { output: originalText, warnings: [] };
  const bom = originalText.startsWith(UTF8_BOM) ? UTF8_BOM : "";
  const source = bom ? originalText.slice(1) : originalText;
  let result: UpdateConfigResult;
  switch (format) {
    case "json":
    case "jsonc":
      result = { output: updateJsonc(source, changes), warnings: [] };
      break;
    case "env":
      result = { output: patchEnv(source, changes), warnings: [] };
      break;
    case "properties":
      result = { output: patchProperties(source, changes), warnings: [] };
      break;
    case "ini":
      result = { output: patchIni(source, changes), warnings: [] };
      break;
    case "yaml":
      result = updateYaml(source, changes);
      break;
    case "toml":
      result = updateToml(source, changes);
      break;
  }
  return { ...result, output: bom + result.output };
}
