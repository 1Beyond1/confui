import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ConfigFile, ConfigFormat } from "../../shared/schema.ts";

/** Well-known config filenames that get rich field templates. */
const KNOWN_FILES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json",
  ".eslintrc", ".eslintrc.json", ".eslintrc.jsonc",
  ".prettierrc", ".prettierrc.json",
  "vite.config.ts", "vite.config.js", "vite.config.mts",
  "next.config.js", "next.config.mjs",
  "tailwind.config.js", "tailwind.config.ts",
  "webpack.config.js", "settings.json", "launch.json",
  "manifest.json", "composer.json",
]);

/** Files that are NOT user-editable config - skip them. */
const IGNORE_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock",
  "bun.lockb", "bun.lock", "poetry.lock", "Cargo.lock", "mix.lock",
  "Gemfile.lock", "flake.lock", "gradle.lockfile",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt",
  ".cache", "coverage", ".turbo", "out", ".output", ".svelte-kit",
  "target", "vendor", ".venv", "__pycache__",
]);

function kindOf(name: string): { kind: string; format: ConfigFormat } | null {
  const lower = name.toLowerCase();
  // Known configs (check first for rich templates)
  if (KNOWN_FILES.has(name)) return { kind: name, format: "json" };
  // JSON family
  if (lower.endsWith(".json")) return { kind: "json", format: "json" };
  if (lower.endsWith(".jsonc")) return { kind: "jsonc", format: "json" };
  if (lower.endsWith(".json5")) return { kind: "json5", format: "json" };
  // YAML
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return { kind: "yaml", format: "yaml" };
  // TOML
  if (lower.endsWith(".toml")) return { kind: "toml", format: "toml" };
  // ENV
  if (lower === ".env" || lower.endsWith(".env") || lower.startsWith(".env.")) return { kind: "env", format: "env" };
  // INI / Conf
  if (lower.endsWith(".ini") || lower.endsWith(".conf") || lower.endsWith(".cfg")) return { kind: "ini", format: "ini" };
  // Properties
  if (lower.endsWith(".properties")) return { kind: "properties", format: "properties" };
  return null;
}

/** Discover JSON config files under a project root. */
export async function scanProject(root: string, maxDepth = 5): Promise<ConfigFile[]> {
  const results: ConfigFile[] = [];
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${root}`);

  async function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        if (IGNORE_FILES.has(e.name)) continue;
        const detected = kindOf(e.name); if (!detected) continue;
        try {
          const s = await stat(join(dir, e.name));
          results.push({
            path: relative(root, join(dir, e.name)),
            absPath: join(dir, e.name),
            kind: detected.kind, format: detected.format, size: s.size,
          });
        } catch {}
      }
    }
  }
  await walk(root, 0);

  results.sort(
    (a, b) =>
      Number(KNOWN_FILES.has(b.kind)) - Number(KNOWN_FILES.has(a.kind)) ||
      a.path.localeCompare(b.path)
  );
  return results;
}
