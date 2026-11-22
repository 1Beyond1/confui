import type { PathSegment } from "../../shared/schema.ts";
import { setSafeProperty } from "../../shared/validation.ts";
import { formatPath, pathKey } from "../paths.ts";
import {
  groupForPath,
  humanize,
  inferFieldType,
  isSecretPath,
  SECRET_KEY_FRAGMENT,
  toEditorValue,
} from "./common.ts";
import type { FieldCandidate } from "./types.ts";

const MAX_OBJECT_DEPTH = 3;
const MAX_OBJECT_KEYS = 40;
const MAX_HEURISTIC_FIELDS = 6_000;
const MAX_MASK_NODES = 20_000;
const MAX_MASK_DEPTH = 32;

const MARKDOWN_TABLE_SECRET_RE = new RegExp(
  `(\\|\\s*[\`"']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*[\`"']?\\s*\\|\\s*)([^|\\r\\n]*?)(\\s*\\|)`,
  "gi",
);
const KEY_VALUE_SECRET_RE = new RegExp(
  `(["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|\\\`[^\\\`]*\\\`|[^\\s,;]+)`,
  "gi",
);
const YAML_SECRET_BLOCK_RE = new RegExp(
  `^\\s*(?:-\\s+)?["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*:\\s*[|>](?:[-+]?\\d*|\\d*[-+])?(?:\\s+#.*)?$`,
  "i",
);

export interface MaskSecretsOptions {
  secretPaths?: readonly (readonly PathSegment[])[];
}

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
    if (current !== null && typeof current === "object" && !Array.isArray(current) && !(current instanceof Date)) {
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
      value: toEditorValue(current),
      source: "heuristic",
      confidence: secret ? 0.92 : 0.58,
      detail: "根据当前值的结构推断",
      order: order++,
    });
  }

  visit(value, [], 0);
  return { fields, truncated };
}

export function maskSecrets(
  value: unknown,
  segments: PathSegment[] = [],
  options?: MaskSecretsOptions,
): unknown {
  const secretPathKeys = new Set<string>(
    (options?.secretPaths ?? []).map((path) => pathKey(path)),
  );
  return maskSecretsInternal(value, segments, secretPathKeys, { nodes: 0 });
}

function maskSecretsInternal(
  value: unknown,
  segments: PathSegment[],
  secretPathKeys: ReadonlySet<string>,
  state: MaskState,
): unknown {
  if (isSecretPath(segments) || (segments.length > 0 && secretPathKeys.has(pathKey(segments)))) return "***";
  if (segments.length >= MAX_MASK_DEPTH || state.nodes >= MAX_MASK_NODES) return "[内容已省略]";
  state.nodes += 1;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (state.nodes >= MAX_MASK_NODES) {
        result.push("[内容已省略]");
        break;
      }
      result.push(maskSecretsInternal(value[index], [...segments, index], secretPathKeys, state));
    }
    return result;
  }
  if (value instanceof Date) return toEditorValue(value);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (state.nodes >= MAX_MASK_NODES) {
        result["…"] = "[内容已省略]";
        break;
      }
      const masked = maskSecretsInternal(item, [...segments, key], secretPathKeys, state);
      setSafeProperty(result, key, masked);
    }
    return result;
  }
  if (typeof value === "bigint" || typeof value === "number" && !Number.isFinite(value)) {
    return toEditorValue(value);
  }
  if (typeof value === "string") return maskDocumentSecrets(value);
  return value;
}

export function maskDocumentSecrets(text: string): string {
  return maskYamlSecretBlocks(text)
    .replace(
      /-----BEGIN ((?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
      "-----BEGIN $1-----\n***\n-----END $1-----",
    )
    // `@` is legal inside a userinfo password in several DSN spellings. Make
    // the password part greedy up to the last `@` before the URL path, so a
    // raw `@` cannot leave the tail of a password in AI context.
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s]+)@/gi, "$1***:***@")
    // Authorization headers are often written in README examples rather than
    // as `token: value` pairs. Mask the whole credential for the common HTTP
    // schemes before the generic key/value pass below.
    .replace(/(\b(?:Bearer|Basic|Digest)\s+)[^\s"',;]+/gi, "$1***")
    // Markdown tables do not use `:` or `=` between a sensitive key and its
    // value, so the key/value expression below would otherwise miss them.
    .replace(MARKDOWN_TABLE_SECRET_RE, "$1***$3")
    .replace(
      KEY_VALUE_SECRET_RE,
      (_match, prefix: string, value: string) => {
        if (/auth(?:orization)?/i.test(prefix) && /^(?:Bearer|Basic|Digest)$/i.test(value)) return `${prefix}${value}`;
        if (/^(?:[|>])(?:[-+]\d*|\d*[-+]?)?$/.test(value.trim())) return `${prefix}${value}`;
        const quote = value.at(0);
        return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}***${quote}` : "***"}`;
      },
    )
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9_-]{12,}|g2a_[A-Za-z0-9_-]{12,}|ark-[A-Za-z0-9-]{16,}|xai-[A-Za-z0-9_-]{12,}|pplx-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{12,}|r8_[A-Za-z0-9]{12,}|npm_[A-Za-z0-9]{20,})\b/g, "***")
    .replace(/\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "https://hooks.slack.com/services/***")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "***");
}

/** Mask YAML literal/folded block values whose key is clearly sensitive. */
function maskYamlSecretBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  let blockKeyIndent: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (blockKeyIndent !== undefined && line.trim()) {
      if (indent > blockKeyIndent) {
        lines[index] = `${line.slice(0, indent)}***`;
        continue;
      }
      blockKeyIndent = undefined;
    }
    if (YAML_SECRET_BLOCK_RE.test(line)) {
      blockKeyIndent = indent;
    }
  }
  return lines.join("\n");
}
