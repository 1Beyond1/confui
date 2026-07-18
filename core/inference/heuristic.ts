import type { PathSegment } from "../../shared/schema.ts";
import { formatPath } from "../paths.ts";
import { groupForPath, humanize, inferFieldType, isSecretPath } from "./common.ts";
import type { FieldCandidate } from "./types.ts";

const MAX_OBJECT_DEPTH = 3;
const MAX_OBJECT_KEYS = 40;

export function inferHeuristicFields(value: unknown): FieldCandidate[] {
  const fields: FieldCandidate[] = [];
  let order = 0;

  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (segments.length && (depth >= MAX_OBJECT_DEPTH || entries.length > MAX_OBJECT_KEYS || entries.length === 0)) {
        push(current, segments, "json");
        return;
      }
      for (const [key, child] of entries) {
        if (key === "$schema") continue;
        visit(child, [...segments, key], depth + 1);
      }
      return;
    }
    if (segments.length) push(current, segments);
  }

  function push(current: unknown, segments: PathSegment[], forcedType?: "json"): void {
    const leaf = String(segments.at(-1) ?? formatPath(segments));
    const secret = isSecretPath(segments);
    fields.push({
      segments,
      label: humanize(leaf),
      type: forcedType ?? inferFieldType(leaf, current),
      secret,
      group: groupForPath(segments),
      value: current,
      source: "heuristic",
      confidence: secret ? 0.92 : 0.58,
      detail: "根据当前值的结构推断",
      order: order++,
    });
  }

  visit(value, [], 0);
  return fields;
}

export function maskSecrets(value: unknown, segments: PathSegment[] = []): unknown {
  if (isSecretPath(segments)) return "***";
  if (Array.isArray(value)) return value.map((item, index) => maskSecrets(item, [...segments, index]));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskSecrets(item, [...segments, key])]),
    );
  }
  if (typeof value === "string") return maskDocumentSecrets(value);
  return value;
}

export function maskDocumentSecrets(text: string): string {
  return text
    .replace(/(\bBearer\s+)[^\s"',;]+/gi, "$1***")
    .replace(
      /(["']?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth(?:orization)?|cookie|jwt|session[_-]?key|signing[_-]?key)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi,
      (_match, prefix: string, value: string) => {
        if (/auth(?:orization)?/i.test(prefix) && /^Bearer$/i.test(value)) return `${prefix}${value}`;
        const quote = value.at(0);
        return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}***${quote}` : "***"}`;
      },
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, "***");
}
