import type { Locale } from "../../shared/schema.ts";
import { translate } from "./i18n/index.tsx";

/** Render values in the save-diff UI without allowing parser-specific values to crash it. */
export function formatDisplayValue(value: unknown, locale: Locale = "zh-CN"): string {
  if (value === undefined) return translate(locale, "common.unset");
  if (value === null) return "null";
  if (typeof value === "string") return value ? truncate(value, 120) : translate(locale, "common.emptyString");
  if (typeof value === "bigint") return truncate(value.toString(), 120);
  if (typeof value === "number" && !Number.isFinite(value)) {
    return Number.isNaN(value) ? "nan" : value < 0 ? "-inf" : "inf";
  }
  try {
    const text = JSON.stringify(value);
    return text ? truncate(text, 120) : String(value);
  } catch {
    return translate(locale, "common.unrenderable");
  }
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
