import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ConfigFile, ProjectScanResult } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";
import { AI_FILE_LIMIT, HARD_FILE_LIMIT } from "./files.ts";
import { detectFormat } from "./formats.ts";

const KNOWN_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "jsconfig.json",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.jsonc",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.jsonc",
  "composer.json",
  "manifest.json",
  "deno.json",
  "deno.jsonc",
  "pyproject.toml",
  "cargo.toml",
  "netlify.toml",
  "wrangler.toml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "appsettings.json",
  "launch.json",
  "settings.json",
]);

const IGNORE_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "bun.lockb",
  "bun.lock",
  "poetry.lock",
  "cargo.lock",
  "mix.lock",
  "gemfile.lock",
  "flake.lock",
  "gradle.lockfile",
]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  ".turbo",
  "out",
  ".output",
  ".svelte-kit",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "release",
]);

const EXAMPLE_MARKER = /(?:^|[._-])(example|sample|template|dist|default)(?:[._-]|$)/i;
const SCHEMA_FILE = /(?:^|[._-])schema(?:[._-]|\.json$)/i;

export async function scanProject(rootInput: string, maxDepth = 6): Promise<ProjectScanResult> {
  const root = resolve(rootInput.trim());
  let rootInfo;
  try {
    rootInfo = await stat(root);
  } catch {
    throw new ConfuiError("NOT_FOUND", "找不到这个项目文件夹");
  }
  if (!rootInfo.isDirectory()) throw new ConfuiError("INVALID_INPUT", "请选择一个项目文件夹");

  const files: ConfigFile[] = [];
  const warnings: string[] = [];
  let skippedCount = 0;

  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > maxDepth) {
      skippedCount += 1;
      return;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skippedCount += 1;
      return;
    }

    for (const entry of entries) {
      const lowerName = entry.name.toLowerCase();
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        skippedCount += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(lowerName)) await walk(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile() || IGNORE_FILES.has(lowerName)) continue;
      if (isExampleFilename(entry.name) || SCHEMA_FILE.test(lowerName) || /\.bak(?:\.|$)/i.test(lowerName)) continue;
      const format = detectFormat(entry.name);
      if (!format) continue;

      try {
        const info = await stat(absolutePath);
        const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
        const confidence = classifyConfidence(entry.name, relativePath);
        const status = info.size > HARD_FILE_LIMIT
          ? "too-large"
          : info.size > AI_FILE_LIMIT
            ? "large"
            : "ready";
        files.push({
          path: relativePath,
          kind: KNOWN_FILES.has(lowerName) ? lowerName : format,
          size: info.size,
          modifiedAt: info.mtimeMs,
          format,
          confidence,
          status,
          warning: status === "too-large"
            ? "文件超过 5 MB，仅显示但不会打开"
            : status === "large"
              ? "文件超过 1 MB，将跳过 AI 分析"
              : undefined,
        });
      } catch {
        skippedCount += 1;
      }
    }
  }

  await walk(root, 0);
  files.sort(compareFiles);
  if (!files.length) warnings.push("没有发现 Confui 支持的配置文件");

  return {
    root,
    name: basename(root) || root,
    files,
    detectedGithubUrl: await detectGithubRemote(root),
    scannedAt: Date.now(),
    skippedCount,
    warnings,
  };
}

export function isExampleFilename(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (lower === ".env.example" || lower === ".env.sample" || lower === ".env.template") return true;
  return EXAMPLE_MARKER.test(lower);
}

function classifyConfidence(filename: string, relativePath: string): ConfigFile["confidence"] {
  const lower = filename.toLowerCase();
  if (KNOWN_FILES.has(lower)) return "known";
  if (
    lower.startsWith(".") ||
    /(^|[._-])(config|settings|options|preferences|manifest|credentials|secrets?)([._-]|$)/i.test(lower) ||
    /(^|\/)config(s)?\//i.test(relativePath)
  ) return "likely";
  return "possible";
}

function compareFiles(left: ConfigFile, right: ConfigFile): number {
  const confidence = { known: 0, likely: 1, possible: 2 } as const;
  return confidence[left.confidence] - confidence[right.confidence]
    || left.path.localeCompare(right.path, "zh-CN", { numeric: true, sensitivity: "base" });
}

async function detectGithubRemote(root: string): Promise<string | undefined> {
  try {
    const config = await readFile(join(root, ".git", "config"), "utf8");
    const urls = [...config.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)].map((match) => match[1]).filter(Boolean) as string[];
    for (const url of urls) {
      const normalized = normalizeGithubUrl(url);
      if (normalized) return normalized;
    }
  } catch {
    // A project without Git metadata is normal.
  }
  return undefined;
}

export function normalizeGithubUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const ssh = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh?.[1] && ssh[2]) return `https://github.com/${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}`;
  const web = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (web?.[1] && web[2]) return `https://github.com/${web[1]}/${web[2].replace(/\.git$/i, "")}`;
  return undefined;
}
