import type { PathSegment } from "../../shared/schema.ts";
import {
  AUTH_BEARER_BASIC_RE,
  AUTH_DIGEST_RE,
  AUTH_TOKEN_HEADER_RE,
  JWT_TOKEN_RE,
  setSafeProperty,
  SLACK_WEBHOOK_RE,
  URL_CREDENTIALS_RE,
  VENDOR_TOKEN_RE,
} from "../../shared/validation.ts";
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
const PASSWORD_KEY_FRAGMENT = [
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "passcode",
  "(?:smtp|mail|db|redis|mongo(?:db)?|mysql|postgres(?:ql)?|pg|amqp|rabbitmq|kafka|proxy|ftp|ldap|ssh|admin|root|user|basic|vault|keystore|truststore)[\\s_.-]?pass",
].join("|");
const NPMRC_SECRET_LINE_RE = new RegExp(
  `^(\\s*\\/\\/[^\\s=\\r\\n]+:[^=\\r\\n]*(?:${SECRET_KEY_FRAGMENT})[^=\\r\\n]*=\\s*)(.+)$`,
  "gim",
);
const MULTI_WORD_PASSWORD_RE = new RegExp(
  `(["']?[\\w.-]*(?:${PASSWORD_KEY_FRAGMENT})[\\w.-]*["']?[ \\t]*[=:][ \\t]*)(?![ \\t"'\`{\\[|>]|\\*{3}(?:[ \\t]|$)|null\\b|~)([^\\r\\n,;}\\]]+)`,
  "gi",
);
const KEY_VALUE_SECRET_RE = new RegExp(
  `(["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*[=:]\\s*)("""(?:[^\\\\]|\\\\.)*?"""|'''[\\s\\S]*?'''|"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|'[^'\\\\]*(?:\\\\.[^'\\\\]*)*'|\\\`[^\\\`]*\\\`|[^\\s,;}\\]]+)`,
  "gi",
);
const YAML_SECRET_BLOCK_RE = new RegExp(
  `^\\s*(?:-\\s+)?["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*:\\s*[|>](?:[-+]?\\d*|\\d*[-+])?(?:\\s+#.*)?$`,
  "i",
);
const TOML_SECRET_TRIPLE_START_RE = new RegExp(
  `^(\\s*["']?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*=\\s*)("""|''')(.*)$`,
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
  return maskTomlSecretBlocks(maskYamlSecretBlocks(text))
    .replace(
      /-----BEGIN ((?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----[\s\S]*?-----END \1-----/g,
      "-----BEGIN $1-----\n***\n-----END $1-----",
    )
    // `.npmrc` scoped credentials (`//host/:_authToken=...`, `//host/:_password=...`)
    // may contain spaces, commas, or semicolons; mask their entire value span.
    .replace(NPMRC_SECRET_LINE_RE, "$1***")
    // `@` is legal inside a userinfo password in several DSN spellings, and the
    // username may be empty (e.g. `redis://:pass@host:6379`).
    .replace(URL_CREDENTIALS_RE, "$1***:***@")
    // Authorization headers (Bearer / Basic / Digest / Token / ApiKey / JWT / OAuth)
    // are often written in README examples or config comments rather than as `token: value`.
    .replace(AUTH_DIGEST_RE, "$1***")
    .replace(AUTH_BEARER_BASIC_RE, "$1***")
    .replace(AUTH_TOKEN_HEADER_RE, "$1***")
    // Markdown tables do not use `:` or `=` between a sensitive key and its
    // value, so the key/value expression below would otherwise miss them.
    .replace(MARKDOWN_TABLE_SECRET_RE, "$1***$3")
    // Multi-word unquoted password/passphrase values in comments or plain lines.
    .replace(MULTI_WORD_PASSWORD_RE, (_match, prefix: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed || trimmed === "***") return `${prefix}${value}`;
      const trailingWs = value.match(/\s*$/)?.[0] ?? "";
      return `${prefix}***${trailingWs}`;
    })
    .replace(
      KEY_VALUE_SECRET_RE,
      (_match, prefix: string, value: string) => {
        if (/auth(?:orization)?/i.test(prefix) && /^(?:Bearer|Basic|Digest|Token|ApiKey|API-Key|JWT|OAuth)$/i.test(value)) return `${prefix}${value}`;
        if (/^(?:[|>])(?:[-+]\d*|\d*[-+]?)?$/.test(value.trim())) return `${prefix}${value}`;
        if (value === '""' || value === "''" || value === '""""""' || value === "''''''") return `${prefix}${value}`;
        if (value.startsWith('"""') && value.endsWith('"""')) return `${prefix}"""***"""`;
        if (value.startsWith("'''") && value.endsWith("'''")) return `${prefix}'''***'''`;
        const quote = value.at(0);
        return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}***${quote}` : "***"}`;
      },
    )
    .replace(VENDOR_TOKEN_RE, "***")
    .replace(SLACK_WEBHOOK_RE, "https://hooks.slack.com/services/***")
    .replace(JWT_TOKEN_RE, "***");
}

/** Mask multi-line TOML triple-quoted secret strings (`"""..."""` / `'''...'''`). */
function maskTomlSecretBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  let activeDelim: '"""' | "'''" | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (activeDelim) {
      const closeIdx = line.indexOf(activeDelim);
      if (closeIdx < 0) {
        const indent = line.match(/^\s*/)?.[0] ?? "";
        if (line.trim()) lines[index] = `${indent}***`;
      } else {
        const before = line.slice(0, closeIdx);
        const after = line.slice(closeIdx + 3);
        const maskedBefore = before.trim() ? `${before.match(/^\s*/)?.[0] ?? ""}***` : before;
        lines[index] = `${maskedBefore}${activeDelim}${after}`;
        activeDelim = undefined;
      }
      continue;
    }
    const startMatch = line.match(TOML_SECRET_TRIPLE_START_RE);
    if (!startMatch) continue;
    const [, prefix = "", delim = '"""', tail = ""] = startMatch;
    if (delim !== '"""' && delim !== "'''") continue;
    const closeIdx = tail.indexOf(delim);
    if (closeIdx >= 0) {
      const inner = tail.slice(0, closeIdx);
      if (inner.length > 0) {
        lines[index] = `${prefix}${delim}***${delim}${tail.slice(closeIdx + 3)}`;
      }
    } else {
      activeDelim = delim;
      lines[index] = tail.trim() ? `${prefix}${delim}***` : line;
    }
  }
  return lines.join("\n");
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
