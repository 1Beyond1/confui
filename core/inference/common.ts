import type { FieldType, PathSegment } from "../../shared/schema.ts";
import { isHexColor, SECRET_KEY_FRAGMENT, SECRET_KEY_PATTERN, setSafeProperty } from "../../shared/validation.ts";
import { formatPath } from "../paths.ts";

export { SECRET_KEY_FRAGMENT };

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
  if (typeof value === "number") {
    return Number.isFinite(value) ? Number.isInteger(value) ? "integer" : "number" : "string";
  }
  if (value instanceof Date) return "string";
  if (Array.isArray(value)) return "array";
  if (value !== null && typeof value === "object") return "json";
  if (isHexColor(value)) return "color";
  return "string";
}

/** Convert parser-specific values to a renderer-safe, editable tree. */
export function toEditorValue(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();

  function convert(current: unknown): unknown {
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "number" && !Number.isFinite(current)) {
      if (Number.isNaN(current)) return "nan";
      return current < 0 ? "-inf" : "inf";
    }
    if (current instanceof Date) {
      try {
        return current.toISOString();
      } catch {
        return undefined;
      }
    }
    if (current === null || typeof current !== "object") return current;
    const cached = seen.get(current);
    if (cached !== undefined) return cached;
    if (Array.isArray(current)) {
      const result: unknown[] = [];
      seen.set(current, result);
      for (const item of current) result.push(convert(item));
      return result;
    }
    const result: Record<string, unknown> = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      setSafeProperty(result, key, convert(item));
    }
    return result;
  }

  return convert(value);
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
