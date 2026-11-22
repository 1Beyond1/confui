import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readLimitedUtf8File } from "./limited-text.ts";

/** Local disk cache TTL for opt-in SchemaStore downloads (7 days). */
export const SCHEMA_STORE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const SCHEMA_STORE_CACHE_MAX_BYTES = 2 * 1024 * 1024 + 8_192;

export interface SchemaStoreMatch {
  id: string;
  name: string;
  url: string;
}

interface SchemaStoreRule {
  id: string;
  name: string;
  url: string;
  /** Matches normalized lowercase path (slash-separated) or basename. */
  match: (normalizedPath: string, baseName: string) => boolean;
}

/**
 * Offline filename/path -> SchemaStore HTTPS catalog mapping for popular
 * developer tooling configs. Network fetching from these URLs is strictly
 * opt-in via Settings (`settings.schemaStore.enabled`, default `false`).
 */
export const SCHEMA_STORE_RULES: readonly SchemaStoreRule[] = [
  {
    id: "github-workflow",
    name: "GitHub Workflow",
    url: "https://json.schemastore.org/github-workflow.json",
    match: (path) => /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i.test(path),
  },
  {
    id: "github-action",
    name: "GitHub Action",
    url: "https://json.schemastore.org/github-action.json",
    match: (_path, base) => base === "action.yml" || base === "action.yaml",
  },
  {
    id: "dependabot",
    name: "Dependabot",
    url: "https://json.schemastore.org/dependabot-2.0.json",
    match: (path) => /(?:^|\/)\.github\/dependabot\.ya?ml$/i.test(path),
  },
  {
    id: "vscode-launch",
    name: "VS Code Launch",
    url: "https://json.schemastore.org/launch.json",
    match: (path, base) => base === "launch.json" || /(?:^|\/)\.vscode\/launch\.json$/i.test(path),
  },
  {
    id: "vscode-tasks",
    name: "VS Code Tasks",
    url: "https://json.schemastore.org/tasks.json",
    match: (path) => /(?:^|\/)\.vscode\/tasks\.json$/i.test(path),
  },
  {
    id: "tsconfig",
    name: "TypeScript tsconfig",
    url: "https://json.schemastore.org/tsconfig.json",
    match: (_path, base) =>
      base === "tsconfig.json"
      || base === "jsconfig.json"
      || /^tsconfig\.[^/]+\.jsonc?$/i.test(base),
  },
  {
    id: "package",
    name: "NPM package.json",
    url: "https://json.schemastore.org/package.json",
    match: (_path, base) => base === "package.json",
  },
  {
    id: "eslintrc",
    name: "ESLint",
    url: "https://json.schemastore.org/eslintrc.json",
    match: (_path, base) =>
      base === ".eslintrc"
      || base === ".eslintrc.json"
      || base === ".eslintrc.jsonc"
      || base === ".eslintrc.yml"
      || base === ".eslintrc.yaml",
  },
  {
    id: "prettierrc",
    name: "Prettier",
    url: "https://json.schemastore.org/prettierrc.json",
    match: (_path, base) =>
      base === ".prettierrc"
      || base === ".prettierrc.json"
      || base === ".prettierrc.jsonc"
      || base === ".prettierrc.yml"
      || base === ".prettierrc.yaml",
  },
  {
    id: "docker-compose",
    name: "Docker Compose",
    url: "https://json.schemastore.org/compose-spec.json",
    match: (_path, base) =>
      base === "docker-compose.yml"
      || base === "docker-compose.yaml"
      || base === "compose.yml"
      || base === "compose.yaml"
      || /^(?:docker-)?compose\.[^/]+\.ya?ml$/i.test(base),
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://json.schemastore.org/vercel.json",
    match: (_path, base) => base === "vercel.json",
  },
  {
    id: "cargo",
    name: "Cargo.toml",
    url: "https://json.schemastore.org/cargo.json",
    match: (_path, base) => base === "cargo.toml",
  },
  {
    id: "pyproject",
    name: "pyproject.toml",
    url: "https://json.schemastore.org/pyproject.json",
    match: (_path, base) => base === "pyproject.toml",
  },
  {
    id: "netlify",
    name: "Netlify",
    url: "https://json.schemastore.org/netlify.json",
    match: (_path, base) => base === "netlify.toml",
  },
  {
    id: "biome",
    name: "Biome",
    url: "https://json.schemastore.org/biome.json",
    match: (_path, base) => base === "biome.json" || base === "biome.jsonc",
  },
  {
    id: "turbo",
    name: "Turborepo",
    url: "https://json.schemastore.org/turbo.json",
    match: (_path, base) => base === "turbo.json",
  },
  {
    id: "deno",
    name: "Deno",
    url: "https://json.schemastore.org/deno.json",
    match: (_path, base) => base === "deno.json" || base === "deno.jsonc",
  },
  {
    id: "renovate",
    name: "Renovate",
    url: "https://json.schemastore.org/renovate.json",
    match: (_path, base) => base === "renovate.json" || base === ".renovaterc.json",
  },
  {
    id: "composer",
    name: "Composer",
    url: "https://json.schemastore.org/composer.json",
    match: (_path, base) => base === "composer.json",
  },
  {
    id: "wrangler",
    name: "Cloudflare Wrangler",
    url: "https://json.schemastore.org/wrangler.json",
    match: (_path, base) => base === "wrangler.toml" || base === "wrangler.json" || base === "wrangler.jsonc",
  },
  {
    id: "ruff",
    name: "Ruff",
    url: "https://json.schemastore.org/ruff.json",
    match: (_path, base) => base === "ruff.toml" || base === ".ruff.toml",
  },
  {
    id: "rustfmt",
    name: "rustfmt",
    url: "https://json.schemastore.org/rustfmt.json",
    match: (_path, base) => base === "rustfmt.toml" || base === ".rustfmt.toml",
  },
  {
    id: "kustomization",
    name: "Kustomize",
    url: "https://json.schemastore.org/kustomization.json",
    match: (_path, base) => base === "kustomization.yaml" || base === "kustomization.yml",
  },
  {
    id: "gitlab-ci",
    name: "GitLab CI",
    url: "https://json.schemastore.org/gitlab-ci.json",
    match: (_path, base) => base === ".gitlab-ci.yml" || base === ".gitlab-ci.yaml",
  },
  {
    id: "nodemon",
    name: "Nodemon",
    url: "https://json.schemastore.org/nodemon.json",
    match: (_path, base) => base === "nodemon.json",
  },
  {
    id: "manifest",
    name: "Web App Manifest",
    url: "https://json.schemastore.org/web-manifest.json",
    match: (_path, base) => base === "manifest.json",
  },
  {
    id: "openapi",
    name: "OpenAPI 3.1",
    url: "https://json.schemastore.org/openapi-3.1.json",
    match: (_path, base) => base === "openapi.yaml" || base === "openapi.yml" || base === "openapi.json",
  },
];

/**
 * Matches a project-relative file path against the built-in offline
 * SchemaStore catalog without performing any network I/O.
 */
export function matchSchemaStoreEntry(relativeFile: string): SchemaStoreMatch | undefined {
  const normalized = relativeFile.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
  if (!normalized) return undefined;
  const baseName = normalized.split("/").at(-1) ?? normalized;
  for (const rule of SCHEMA_STORE_RULES) {
    if (rule.match(normalized, baseName)) {
      return { id: rule.id, name: rule.name, url: rule.url };
    }
  }
  return undefined;
}

interface DiskCacheEntry {
  url: string;
  fetchedAt: number;
  schema: Record<string, unknown>;
}

function cacheFilePath(cacheDir: string, url: string): string {
  const digest = createHash("sha256").update(url).digest("hex");
  return join(cacheDir, `${digest}.json`);
}

export async function readCachedSchemaStore(
  cacheDir: string,
  url: string,
  now = Date.now(),
): Promise<Record<string, unknown> | undefined> {
  try {
    const filePath = cacheFilePath(cacheDir, url);
    const raw = await readLimitedUtf8File(filePath, {
      maxBytes: SCHEMA_STORE_CACHE_MAX_BYTES,
      overflow: "reject",
    });
    const parsed = JSON.parse(raw) as Partial<DiskCacheEntry>;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.url !== url
      || typeof parsed.fetchedAt !== "number"
      || !Number.isFinite(parsed.fetchedAt)
      || now - parsed.fetchedAt >= SCHEMA_STORE_CACHE_TTL_MS
      || !parsed.schema
      || typeof parsed.schema !== "object"
      || Array.isArray(parsed.schema)
    ) {
      return undefined;
    }
    return parsed.schema;
  } catch {
    return undefined;
  }
}

export async function writeCachedSchemaStore(
  cacheDir: string,
  url: string,
  schema: Record<string, unknown>,
  now = Date.now(),
): Promise<void> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const target = cacheFilePath(cacheDir, url);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(cacheDir, { recursive: true });
    const payload: DiskCacheEntry = { url, fetchedAt: now, schema };
    await writeFile(temporary, JSON.stringify(payload), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } catch {
    await unlink(temporary).catch(() => undefined);
  }
}
