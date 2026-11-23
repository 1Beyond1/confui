import type { PathSegment } from "./schema.ts";

/** Standard CSS hex color literal (#rgb, #rgba, #rrggbb, #rrggbbaa). */
export const HEX_COLOR_RE = /^(?:#[\da-f]{3}|#[\da-f]{4}|#[\da-f]{6}|#[\da-f]{8})$/i;

/** Six-digit opaque hex color accepted by the native HTML color picker. */
export const HEX_COLOR_6_RE = /^#[\da-f]{6}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_RE.test(value);
}

export function isHexColor6(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_6_RE.test(value);
}

/** Keys that must never be traversed or assigned onto plain JS objects. */
export const FORBIDDEN_OBJECT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_OBJECT_KEYS.has(key);
}

/**
 * Shared key-name fragment matching sensitive configuration keys (passwords,
 * tokens, API keys, private keys, DSNs, webhooks). Single source of truth
 * shared between inference masking, cross-file search, and Unified Diff masking.
 */
export const SECRET_KEY_FRAGMENT = [
  "password",
  "passwd",
  "pwd",
  "passphrase",
  "passcode",
  "(?:smtp|mail|db|redis|mongo(?:db)?|mysql|postgres(?:ql)?|pg|amqp|rabbitmq|kafka|proxy|ftp|ldap|ssh|admin|root|user|basic|vault|keystore|truststore)[\\s_.-]?pass",
  "secret",
  "token",
  "bearer",
  "api[\\s_.-]?key",
  "private[\\s_.-]?(?:key|pem)",
  "pem[\\s_.-]?key",
  "cert[\\s_.-]?key",
  "app[\\s_.-]?key",
  "master[\\s_.-]?key",
  "encryption[\\s_.-]?key",
  "cipher[\\s_.-]?key",
  "hmac[\\s_.-]?key",
  "aes[\\s_.-]?key",
  "ssh[\\s_.-]?key",
  "tls[\\s_.-]?key",
  "ssl[\\s_.-]?key",
  "oauth[\\s_.-]?key",
  "service[\\s_.-]?account[\\s_.-]?key",
  "credential",
  "auth(?:orization)?",
  "cookie",
  "jwt",
  "session[\\s_.-]?key",
  "signing[\\s_.-]?key",
  "client[\\s_.-]?secret",
  "access[\\s_.-]?key",
  "(?:database|db|redis|mongo(?:db)?|postgres(?:ql)?|mysql|mariadb|amqp|rabbitmq|kafka|broker|jdbc|sqlalchemy)[\\s_.-]?(?:url|uri)",
  "connection[\\s_.-]?string",
  "dsn",
  "webhook[\\s_.-]?(?:url|secret)",
  "(?:openai|anthropic|google|gemini|stripe|slack|aws|gcp|azure|github|gitlab|twilio|sendgrid|mailgun|cloudflare|datadog|algolia|firebase|supabase|deepseek|openrouter|groq|mistral|cohere)[\\s_.-]?(?:key|pat)",
].join("|");

export const SECRET_KEY_PATTERN = new RegExp(SECRET_KEY_FRAGMENT, "i");

/** Returns true if a single configuration key name indicates a sensitive credential. */
export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

export const PEM_BEGIN_RE = /-----BEGIN (?:(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----/;
export const PEM_END_RE = /-----END (?:(?:(?:RSA|EC|OPENSSH|DSA|PGP) )?(?:ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)-----/;
export const URL_CREDENTIALS_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@"'<>]*):([^/\s"'<>]+)@/gi;
export const AUTH_BEARER_BASIC_RE = /(\b(?:Bearer|Basic)\s+)[^\s"',;#]+/gi;
export const AUTH_TOKEN_HEADER_RE = /(\b[\w.-]*auth(?:orization)?[\w.-]*\s*[:=]\s*["']?(?:Token|ApiKey|API-Key|JWT|OAuth)\s+)[^\s"',;#]+/gi;
const DIGEST_VALUE_FRAGMENT = `(?:\\\\"(?:[^"\\\\]|\\\\(?!").)*\\\\"|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\s,;#"']+)`;
const DIGEST_PARAM_FRAGMENT = `[A-Za-z0-9_-]+\\s*=\\s*${DIGEST_VALUE_FRAGMENT}`;
export const AUTH_DIGEST_RE = new RegExp(
  `(\\bDigest\\s+)(?:${DIGEST_PARAM_FRAGMENT}(?:\\s*,\\s*${DIGEST_PARAM_FRAGMENT})*|[^\\s"',;#]+)`,
  "gi",
);
export const VENDOR_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|sk-ant-[A-Za-z0-9_-]{12,}|sk_(?:live|test)_[A-Za-z0-9]{12,}|gsk_[A-Za-z0-9_-]{12,}|g2a_[A-Za-z0-9_-]{12,}|ark-[A-Za-z0-9-]{16,}|xai-[A-Za-z0-9_-]{12,}|pplx-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{12,}|r8_[A-Za-z0-9]{12,}|npm_[A-Za-z0-9]{20,})\b/g;
export const SLACK_WEBHOOK_RE = /\bhttps:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi;
export const JWT_TOKEN_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

// Non-global copies for stateless `.test()` calls.
const URL_CREDENTIALS_TEST_RE = new RegExp(URL_CREDENTIALS_RE.source, "i");
const AUTH_BEARER_BASIC_TEST_RE = new RegExp(AUTH_BEARER_BASIC_RE.source, "i");
const AUTH_TOKEN_HEADER_TEST_RE = new RegExp(AUTH_TOKEN_HEADER_RE.source, "i");
const AUTH_DIGEST_TEST_RE = new RegExp(AUTH_DIGEST_RE.source, "i");
const INLINE_SECRET_KV_TEST_RE = new RegExp(
  `(?:^|[\\s,;(\\[{"'])["']?(?:--)?[\\w.-]*(?:${SECRET_KEY_FRAGMENT})[\\w.-]*["']?\\s*[=:]\\s*(?!["']?(?:\\*{3}|•+|null|~)(?:["']|[\\s,;}\\]]|$))(?:"(?:[^"\\\\]|\\\\.)+"|'(?:[^'\\\\]|\\\\.)+'|[^\\s,;}\\]"']+)`,
  "i",
);
const VENDOR_TOKEN_TEST_RE = new RegExp(VENDOR_TOKEN_RE.source);
const SLACK_WEBHOOK_TEST_RE = new RegExp(SLACK_WEBHOOK_RE.source, "i");
const JWT_TOKEN_TEST_RE = new RegExp(JWT_TOKEN_RE.source);

/** Returns true if a string contains a recognized credential/key/token pattern. */
export function containsSecretValuePattern(text: string): boolean {
  if (!text) return false;
  return PEM_BEGIN_RE.test(text)
    || URL_CREDENTIALS_TEST_RE.test(text)
    || AUTH_BEARER_BASIC_TEST_RE.test(text)
    || AUTH_TOKEN_HEADER_TEST_RE.test(text)
    || AUTH_DIGEST_TEST_RE.test(text)
    || INLINE_SECRET_KV_TEST_RE.test(text)
    || VENDOR_TOKEN_TEST_RE.test(text)
    || SLACK_WEBHOOK_TEST_RE.test(text)
    || JWT_TOKEN_TEST_RE.test(text);
}

/**
 * Recursively inspects a scalar, array, or object value and returns true if
 * any nested key name matches `SECRET_KEY_PATTERN` or any nested string matches
 * a credential pattern (DSN with password, PEM key, Bearer/Digest, JWT, vendor
 * token, Slack webhook).
 */
export function valueContainsSecret(value: unknown, maxDepth = 16, maxNodes = 2_000): boolean {
  let visited = 0;
  function walk(current: unknown, depth: number): boolean {
    if (visited >= maxNodes || depth > maxDepth) return false;
    visited += 1;
    if (typeof current === "string") return containsSecretValuePattern(current);
    if (current === null || typeof current !== "object") return false;
    if (Array.isArray(current)) {
      for (const item of current) {
        if (walk(item, depth + 1)) return true;
      }
      return false;
    }
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key) && item !== undefined && item !== null && item !== "") {
        return true;
      }
      if (walk(item, depth + 1)) return true;
    }
    return false;
  }
  return walk(value, 0);
}

/**
 * Recursively extracts string secret candidates (including individual lines of
 * multi-line secrets) from scalars, arrays, and nested objects.
 */
export function collectSecretStrings(
  value: unknown,
  out: Set<string>,
  minLength = 6,
  maxDepth = 16,
  maxNodes = 2_000,
): void {
  let visited = 0;
  function walk(current: unknown, depth: number): void {
    if (visited >= maxNodes || depth > maxDepth) return;
    visited += 1;
    if (typeof current === "string") {
      if (current.length >= minLength) out.add(current);
      if (current.includes("\n") || current.includes("\r")) {
        for (const line of current.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed.length >= minLength && !PEM_BEGIN_RE.test(trimmed) && !PEM_END_RE.test(trimmed)) {
            out.add(trimmed);
          }
        }
      }
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const item of current) walk(item, depth + 1);
      return;
    }
    for (const item of Object.values(current as Record<string, unknown>)) {
      walk(item, depth + 1);
    }
  }
  walk(value, 0);
}

export function isSafePathSegment(segment: unknown): segment is PathSegment {
  if (typeof segment === "number") return Number.isSafeInteger(segment) && segment >= 0;
  return typeof segment === "string" && !isForbiddenKey(segment);
}

/** Sets a property on a plain object without risking `__proto__` mutation. */
export function setSafeProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  } else {
    target[key] = value;
  }
}

export interface GithubRepositoryRef {
  owner: string;
  repo: string;
}

/**
 * Parses a GitHub HTTPS or SSH repository URL into `{ owner, repo }`,
 * rejecting credential-bearing URLs and non-GitHub hosts.
 */
export function parseGithubRepository(value: string): GithubRepositoryRef | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?$/i);
  const candidate = ssh?.[1] && ssh[2]
    ? `https://github.com/${ssh[1]}/${ssh[2]}`
    : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!/^https?:$/i.test(parsed.protocol) || !/^(?:www\.)?github\.com$/i.test(parsed.hostname)) {
    return undefined;
  }
  if (parsed.username || parsed.password) return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, "");
  if (
    !owner
    || !repo
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)
  ) {
    return undefined;
  }
  return { owner, repo };
}

export function normalizeGithubUrl(value: string): string | undefined {
  const repo = parseGithubRepository(value);
  return repo ? `https://github.com/${repo.owner}/${repo.repo}` : undefined;
}

/**
 * Extracts a canonical origin (`scheme://host[:port]`) for an AI Base URL if
 * and only if it is a valid HTTPS URL or a loopback HTTP URL without embedded
 * credentials, query parameters, or fragments.
 */
export function normalizeTrustedAiOrigin(baseUrl: string): string | undefined {
  const trimmed = baseUrl.trim();
  if (!trimmed) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:") {
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host)) {
      return url.origin;
    }
  }
  return undefined;
}

/**
 * Determines whether a stored AI API key may be reused for a target AI config.
 * Both the provider identifier and the canonical trusted origin of `baseUrl`
 * must match so changing `baseUrl` to another domain can never exfiltrate a
 * previously saved `safeStorage` key.
 */
export function canReuseStoredAiApiKey(
  stored: { provider: string; baseUrl: string },
  candidate: { provider: string; baseUrl: string },
): boolean {
  if (stored.provider !== candidate.provider) return false;
  const storedOrigin = normalizeTrustedAiOrigin(stored.baseUrl);
  const candidateOrigin = normalizeTrustedAiOrigin(candidate.baseUrl);
  return Boolean(storedOrigin && candidateOrigin && storedOrigin === candidateOrigin);
}

const MAX_REGEX_PATTERN_LENGTH = 512;
const MAX_REGEX_GROUP_DEPTH = 6;
const MAX_REGEX_UNBOUNDED_QUANTIFIERS = 20;
const MAX_REGEX_BRACE_BOUND = 1_000;

/**
 * Static linear-time ReDoS guard for regex patterns sourced from untrusted
 * `$schema` files or AI inference. Rejects overly long patterns, backreferences,
 * nested quantifiers (star-height > 1), repeated alternation groups, and
 * consecutive unbounded wildcard sequences.
 */
export function isSafeRegexPattern(pattern: string): boolean {
  if (!pattern || pattern.length > MAX_REGEX_PATTERN_LENGTH) return false;
  interface GroupFrame {
    hasQuantifier: boolean;
    hasAlternation: boolean;
    isLookaround: boolean;
  }
  const stack: GroupFrame[] = [];
  let lastToken: "none" | "atom" | "group" | "quantifier" = "none";
  let lastAtomWasDot = false;
  let lastClosedGroup: GroupFrame | undefined;
  let unboundedCount = 0;
  let prevWasWildcardRepeat = false;

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;

    if (ch === "\\") {
      if (i + 1 >= pattern.length) return false;
      const next = pattern[i + 1]!;
      if ((next >= "1" && next <= "9") || next === "k") return false;
      i += 1;
      lastToken = "atom";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "[") {
      let closed = false;
      for (i += 1; i < pattern.length; i += 1) {
        if (pattern[i] === "\\") {
          i += 1;
          continue;
        }
        if (pattern[i] === "]") {
          closed = true;
          break;
        }
      }
      if (!closed) return false;
      lastToken = "atom";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "(") {
      if (stack.length >= MAX_REGEX_GROUP_DEPTH) return false;
      let isLookaround = false;
      if (pattern[i + 1] === "?") {
        if (pattern.startsWith("(?<=", i) || pattern.startsWith("(?<!", i)) {
          isLookaround = true;
          i += 3;
        } else if (pattern.startsWith("(?=", i) || pattern.startsWith("(?!", i)) {
          isLookaround = true;
          i += 2;
        } else if (pattern.startsWith("(?:", i)) {
          i += 2;
        } else if (pattern.startsWith("(?<", i)) {
          const endName = pattern.indexOf(">", i + 3);
          if (endName < 0) return false;
          i = endName;
        }
      }
      stack.push({ hasQuantifier: false, hasAlternation: false, isLookaround });
      lastToken = "none";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === ")") {
      const closed = stack.pop();
      if (!closed) return false;
      if (closed.isLookaround && closed.hasQuantifier) return false;
      if (closed.hasQuantifier && stack.length > 0) {
        stack.at(-1)!.hasQuantifier = true;
      }
      lastClosedGroup = closed;
      lastToken = "group";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "|") {
      if (stack.length > 0) stack.at(-1)!.hasAlternation = true;
      lastToken = "none";
      lastAtomWasDot = false;
      prevWasWildcardRepeat = false;
      continue;
    }

    if (ch === "?" && lastToken === "quantifier") {
      continue;
    }

    let quant: { min: number; max: number; isUnbounded: boolean } | undefined;
    if (ch === "*") {
      quant = { min: 0, max: Number.POSITIVE_INFINITY, isUnbounded: true };
    } else if (ch === "+") {
      quant = { min: 1, max: Number.POSITIVE_INFINITY, isUnbounded: true };
    } else if (ch === "?") {
      quant = { min: 0, max: 1, isUnbounded: false };
    } else if (ch === "{") {
      const braceMatch = pattern.slice(i).match(/^\{(\d+)(?:,(\d*))?\}/);
      if (braceMatch) {
        const min = Number(braceMatch[1]);
        const hasComma = braceMatch[0].includes(",");
        const max = !hasComma
          ? min
          : braceMatch[2]
            ? Number(braceMatch[2])
            : Number.POSITIVE_INFINITY;
        if (!Number.isFinite(min) || (Number.isFinite(max) && max < min)) return false;
        quant = { min, max, isUnbounded: !Number.isFinite(max) };
        i += braceMatch[0].length - 1;
      }
    }

    if (quant) {
      if (lastToken === "none" || lastToken === "quantifier") return false;
      if (quant.min > MAX_REGEX_BRACE_BOUND || (Number.isFinite(quant.max) && quant.max > MAX_REGEX_BRACE_BOUND)) {
        return false;
      }
      if (quant.isUnbounded) {
        unboundedCount += 1;
        if (unboundedCount > MAX_REGEX_UNBOUNDED_QUANTIFIERS) return false;
      }
      const repeatsMultiple = quant.isUnbounded || quant.max > 1;
      if (lastToken === "group" && lastClosedGroup && repeatsMultiple) {
        const highRepeat = quant.isUnbounded || quant.max > 5;
        if (lastClosedGroup.hasQuantifier && highRepeat) return false;
        if (lastClosedGroup.hasAlternation && highRepeat) return false;
      }
      if (repeatsMultiple && stack.length > 0) {
        stack.at(-1)!.hasQuantifier = true;
      }
      if (lastToken === "atom" && lastAtomWasDot && quant.isUnbounded) {
        if (prevWasWildcardRepeat) return false;
        prevWasWildcardRepeat = true;
      } else {
        prevWasWildcardRepeat = false;
      }
      lastToken = "quantifier";
      lastAtomWasDot = false;
      continue;
    }

    lastToken = "atom";
    lastAtomWasDot = ch === ".";
    if (ch !== ".") prevWasWildcardRepeat = false;
  }

  return stack.length === 0;
}
