import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { ConfigFile, ConfigFileStatus, ProjectScanResult } from "../shared/schema.ts";
import { normalizeGithubUrl } from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";
import { AI_FILE_LIMIT, HARD_FILE_LIMIT } from "./files.ts";
import { detectFormat, isUnambiguousIniName, looksLikeIni } from "./formats.ts";
import { ensurePathInsideProject } from "./paths.ts";
import { readLimitedUtf8File } from "./inference/limited-text.ts";

/** Enough of a `.conf` / `.cfg` file to tell INI apart from nginx-style syntax. */
const SNIFF_BYTES = 64 * 1024;
const GIT_CONFIG_MAX_BYTES = 128 * 1024;
const SCAN_CONCURRENCY = 16;
const MAX_SCAN_DEPTH = 32;
const MAX_SCAN_ENTRIES = 50_000;
const MAX_SCAN_DIRECTORIES = 4_096;
const MAX_CONFIG_FILES = 4_000;

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
  if (typeof rootInput !== "string" || !rootInput.trim()) {
    throw new ConfuiError("INVALID_INPUT", "请选择一个项目文件夹");
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > MAX_SCAN_DEPTH) {
    throw new ConfuiError("INVALID_INPUT", `扫描深度必须是 0 到 ${MAX_SCAN_DEPTH} 之间的整数`);
  }
  let root: string;
  let rootInfo;
  try {
    root = await realpath(resolve(rootInput.trim()));
    rootInfo = await stat(root);
  } catch {
    throw new ConfuiError("NOT_FOUND", "找不到这个项目文件夹");
  }
  if (!rootInfo.isDirectory()) throw new ConfuiError("INVALID_INPUT", "请选择一个项目文件夹");

  const files: ConfigFile[] = [];
  const warnings: string[] = [];
  let skippedCount = 0;
  let scannedEntries = 0;
  let scannedDirectories = 0;
  let scheduledConfigFiles = 0;
  let scanCapped = false;

  async function walk(directory: string, depth: number): Promise<void> {
    if (scanCapped) return;
    if (depth > maxDepth) {
      skippedCount += 1;
      return;
    }
    if (scannedDirectories >= MAX_SCAN_DIRECTORIES) {
      scanCapped = true;
      skippedCount += 1;
      return;
    }
    scannedDirectories += 1;
    let physicalDirectory: string;
    try {
      physicalDirectory = await ensurePathInsideProject(root, directory);
    } catch {
      skippedCount += 1;
      return;
    }
    let directoryHandle;
    try {
      directoryHandle = await opendir(physicalDirectory);
    } catch {
      skippedCount += 1;
      return;
    }

    const directories: string[] = [];
    const fileTasks: Array<() => Promise<void>> = [];
    try {
      while (true) {
        const entry = await directoryHandle.read();
        if (!entry) break;
        scannedEntries += 1;
        if (scannedEntries > MAX_SCAN_ENTRIES) {
          scanCapped = true;
          skippedCount += 1;
          break;
        }
        const lowerName = entry.name.toLowerCase();
        const absolutePath = join(physicalDirectory, entry.name);
        if (entry.isSymbolicLink()) {
          skippedCount += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (!IGNORE_DIRS.has(lowerName)) directories.push(absolutePath);
          continue;
        }
        if (!entry.isFile() || IGNORE_FILES.has(lowerName)) continue;
        if (isExampleFilename(entry.name) || SCHEMA_FILE.test(lowerName) || /\.bak(?:\.|$)/i.test(lowerName)) continue;
        const format = detectFormat(entry.name);
        if (!format) continue;
        scheduledConfigFiles += 1;
        if (scheduledConfigFiles > MAX_CONFIG_FILES) {
          scanCapped = true;
          skippedCount += 1;
          break;
        }

        fileTasks.push(async () => {
          try {
            // Re-check with lstat so a file swapped to a symlink after opendir is
            // not followed outside the selected project.
            const info = await lstat(absolutePath);
            if (!info.isFile() || info.isSymbolicLink()) {
              skippedCount += 1;
              return;
            }
            const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
            const confidence = classifyConfidence(entry.name, relativePath);
            let status: ConfigFileStatus = info.size > HARD_FILE_LIMIT
              ? "too-large"
              : info.size > AI_FILE_LIMIT
                ? "large"
                : "ready";
            let warning: string | undefined;
            if (status !== "too-large" && format === "ini" && !isUnambiguousIniName(entry.name)) {
              try {
                if (!looksLikeIni(await readPrefix(absolutePath, SNIFF_BYTES))) status = "unsupported";
              } catch {
                status = "unreadable";
              }
            }
            warning = status === "too-large"
              ? "文件超过 5 MB，仅显示但不会打开"
              : status === "unsupported"
                ? "这不是 INI 语法（例如 nginx / httpd / redis 这类指令式配置），Confui 不会编辑它"
                : status === "unreadable"
                  ? "无法读取文件内容，请检查权限或文件是否仍然存在"
                  : status === "large"
                    ? "文件超过 1 MB，将跳过 AI 分析"
                    : undefined;
            files.push({
              path: relativePath,
              kind: KNOWN_FILES.has(lowerName) ? lowerName : format,
              size: info.size,
              modifiedAt: info.mtimeMs,
              format,
              confidence,
              status,
              warning,
            });
          } catch {
            skippedCount += 1;
          }
        });
      }
    } catch {
      skippedCount += 1;
    } finally {
      await directoryHandle.close().catch(() => undefined);
    }

    await runLimited(fileTasks, SCAN_CONCURRENCY);
    for (const child of directories) {
      if (scanCapped) break;
      await walk(child, depth + 1);
    }
  }

  await walk(root, 0);
  files.sort(compareFiles);
  if (!files.length) warnings.push("没有发现 Confui 支持的配置文件");
  if (scanCapped) warnings.push("项目内容较多，扫描已达到安全上限；可以缩小项目范围后再试。");

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

async function runLimited(tasks: ReadonlyArray<() => Promise<void>>, concurrency: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

/** Reads at most `maxBytes` and drops a trailing partial line. */
async function readPrefix(absolutePath: string, maxBytes: number): Promise<string> {
  const handle = await open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    let bytesRead = 0;
    // FileHandle.read is allowed to return a short read even before EOF.
    // Complete the prefix so a transient partial read cannot make a valid
    // INI look like directive-style syntax (or vice versa).
    while (bytesRead < maxBytes) {
      const chunk = await handle.read(buffer, bytesRead, maxBytes - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (bytesRead < maxBytes) return text;
    const lastBreak = text.lastIndexOf("\n");
    return lastBreak > 0 ? text.slice(0, lastBreak) : text;
  } finally {
    await handle.close();
  }
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
    const gitConfig = await ensurePathInsideProject(root, join(root, ".git", "config"));
    const config = await readLimitedUtf8File(gitConfig, {
      maxBytes: GIT_CONFIG_MAX_BYTES,
      overflow: "reject",
      // A malformed/oversized Git config is not relevant to scanning the
      // project; skip remote detection instead of allocating it in full.
      tooLargeMessage: "Git 配置过大",
    });
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

export { normalizeGithubUrl };
