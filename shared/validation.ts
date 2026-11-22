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
  "secret",
  "token",
  "api[\\s_-]?key",
  "private[\\s_-]?key",
  "app[\\s_-]?key",
  "master[\\s_-]?key",
  "encryption[\\s_-]?key",
  "cipher[\\s_-]?key",
  "hmac[\\s_-]?key",
  "aes[\\s_-]?key",
  "ssh[\\s_-]?key",
  "tls[\\s_-]?key",
  "ssl[\\s_-]?key",
  "credential",
  "auth(?:orization)?",
  "cookie",
  "jwt",
  "session[\\s_-]?key",
  "signing[\\s_-]?key",
  "client[\\s_-]?secret",
  "access[\\s_-]?key",
  "database[\\s_-]?url",
  "connection[\\s_-]?string",
  "dsn",
  "webhook[\\s_-]?(?:url|secret)",
  "(?:openai|anthropic|google|gemini|stripe|slack)[\\s_-]?key",
].join("|");

export const SECRET_KEY_PATTERN = new RegExp(SECRET_KEY_FRAGMENT, "i");

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
