import { posix as posixPath, win32 as win32Path } from "node:path";
import type { ConfigFormat, PathSegment } from "../../shared/schema.ts";
import { ConfuiError } from "../errors.ts";
import { getAtPath } from "../paths.ts";

export const UTF8_BOM = "\uFEFF";

/**
 * Extracts the bare filename from either POSIX (`/`) or Windows (`\`) paths.
 * Returns an empty string for trailing-slash directory paths.
 */
export function extractBaseName(filename: string): string {
  if (!filename || filename.endsWith("/") || filename.endsWith("\\")) return "";
  return posixPath.basename(win32Path.basename(filename));
}

export function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function normalizeLineEndings(output: string, originalText = ""): string {
  const eol = detectEol(originalText);
  const normalized = output.replace(/\r?\n/g, eol);
  return normalized.endsWith(eol) ? normalized : normalized + eol;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isScalarValue(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function isRecordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * Refuses to append a key that the parser already reported. Hitting this means
 * the text scan could not find the line the value came from, so appending
 * would add a second, contradictory definition instead of editing in place.
 */
export function assertAppendable(
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
