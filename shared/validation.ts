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
