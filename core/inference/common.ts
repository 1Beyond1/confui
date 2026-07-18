import type { FieldType, PathSegment } from "../../shared/schema.ts";
import { formatPath } from "../paths.ts";

const SECRET_KEY_PATTERN = /password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth(?:orization)?|cookie|jwt|session[_-]?key|signing[_-]?key/i;

export function humanize(value: string): string {
  const spaced = value
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/[_.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return value;
  return spaced.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function inferFieldType(key: string, value: unknown): FieldType {
  if (SECRET_KEY_PATTERN.test(key)) return "secret";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "json";
  if (typeof value === "string" && /^#[\da-f]{3,8}$/i.test(value)) return "color";
  return "string";
}

export function groupForPath(segments: readonly PathSegment[]): string {
  if (segments.length <= 1) return "常规";
  return humanize(String(segments[0] ?? "常规"));
}

export function candidatePath(segments: readonly PathSegment[]): string {
  return formatPath(segments);
}

export function isSecretPath(segments: readonly PathSegment[]): boolean {
  return segments.some((segment) =>
    typeof segment === "string" && SECRET_KEY_PATTERN.test(segment),
  );
}
