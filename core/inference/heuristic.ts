import type { PathSegment } from "../../shared/schema.ts";
import { formatPath } from "../paths.ts";
import { groupForPath, humanize, inferFieldType, isSecretPath } from "./common.ts";
import type { FieldCandidate } from "./types.ts";

const MAX_OBJECT_DEPTH = 3;
const MAX_OBJECT_KEYS = 40;
const MAX_HEURISTIC_FIELDS = 6_000;
const MAX_MASK_NODES = 20_000;
const MAX_MASK_DEPTH = 32;

interface HeuristicResult {
  fields: FieldCandidate[];
  truncated: boolean;
}

interface MaskState {
  nodes: number;
}

export function inferHeuristicFields(value: unknown): HeuristicResult {
  const fields: FieldCandidate[] = [];
  let truncated = false;
  let order = 0;

  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (fields.length >= MAX_HEURISTIC_FIELDS) {
      truncated = true;
      return;
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current)) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (segments.length && (depth >= MAX_OBJECT_DEPTH || entries.length > MAX_OBJECT_KEYS || entries.length === 0)) {
        push(current, segments, "json");
        return;
      }
      for (const [key, child] of entries) {
        if (key === "$schema") continue;
        visit(child, [...segments, key], depth + 1);
        if (truncated) return;
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
  return { fields, truncated };
}

export function maskSecrets(value: unknown, segments: PathSegment[] = [], state: MaskState = { nodes: 0 }): unknown {
  if (isSecretPath(segments)) return "***";
  if (segments.length >= MAX_MASK_DEPTH || state.nodes >= MAX_MASK_NODES) return "[内容已省略]";
  state.nodes += 1;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= MAX_MASK_NODES) {
        result.push("[内容已省略]");
        break;
      }
      result.push(maskSecrets(value[index], [...segments, index], state));
    }
    return result;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (state.nodes >= MAX_MASK_NODES) {
        result["…"] = "[内容已省略]";
        break;
      }
      result[key] = maskSecrets(item, [...segments, key], state);
    }
    return result;
  }
  if (typeof value === "string") return maskDocumentSecrets(value);
  return value;
}

export function maskDocumentSecrets(text: string): string {
  return text
    .replace(
    /-----BEGIN ((?:(?:RSA|EC|OPENSSH|DSA) )?(?:ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
      "-----BEGIN $1-----\n***\n-----END $1-----",
    )
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, "$1***:***@")
    .replace(/(\bBearer\s+)[^\s"',;]+/gi, "$1***")
    .replace(
      /(["']?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth(?:orization)?|cookie|jwt|session[_-]?key|signing[_-]?key|client[_-]?secret|access[_-]?key|database[_-]?url|connection[_-]?string|dsn|webhook[_-]?(?:url|secret))[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|`[^`]*`|[^\s,;]+)/gi,
      (_match, prefix: string, value: string) => {
        if (/auth(?:orization)?/i.test(prefix) && /^Bearer$/i.test(value)) return `${prefix}${value}`;
        const quote = value.at(0);
        return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}***${quote}` : "***"}`;
      },
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9_-]{12,}|g2a_[A-Za-z0-9_-]{12,}|ark-[A-Za-z0-9-]{16,}|xai-[A-Za-z0-9_-]{12,}|pplx-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{12,}|r8_[A-Za-z0-9]{12,}|npm_[A-Za-z0-9]{20,})\b/g, "***")
    .replace(/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "https://hooks.slack.com/services/***")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "***");
}
