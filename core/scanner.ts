import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, extname, join, posix, relative, resolve } from "node:path";
import type {
  ConfigEnvGroup,
  ConfigFile,
  ConfigFileStatus,
  ConfigFormat,
  ExampleTemplate,
  ProjectScanResult,
} from "../shared/schema.ts";
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
const MAX_EXAMPLE_TEMPLATES = 500;
const EXAMPLE_MARKERS = ["example", "template", "sample", "default", "dist"] as const;
const ENV_VARIANT_RE = /^(.+?)[._-](dev|development|prod|production|staging|stage|test|testing|local|qa|uat|preview|ci|sandbox|debug|release|beta|alpha|preprod)$/i;

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
  ".editorconfig",
  ".npmrc",
  "vercel.json",
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
  const rawTemplates: ExampleTemplate[] = [];
  const existingPathsLower = new Set<string>();
  const warnings: string[] = [];
  let skippedCount = 0;
  let scannedEntries = 0;
  let scannedDirectories = 0;
  let scheduledConfigFiles = 0;
  let scheduledTemplates = 0;
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
        if (!entry.isFile()) continue;
        const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
        existingPathsLower.add(relativePath.toLowerCase());
        if (IGNORE_FILES.has(lowerName)) continue;
        if (SCHEMA_FILE.test(lowerName) || /\.bak(?:\.|$)/i.test(lowerName)) continue;
        if (isExampleFilename(entry.name)) {
          const derived = deriveTargetFromExample(relativePath);
          if (!derived || scheduledTemplates >= MAX_EXAMPLE_TEMPLATES) continue;
          scheduledTemplates += 1;
          fileTasks.push(async () => {
            try {
              const info = await lstat(absolutePath);
              if (!info.isFile() || info.isSymbolicLink() || info.size > HARD_FILE_LIMIT) {
                skippedCount += 1;
                return;
              }
              if (derived.format === "ini" && !isUnambiguousIniName(posix.basename(derived.targetPath))) {
                try {
                  if (!looksLikeIni(await readPrefix(absolutePath, SNIFF_BYTES))) return;
                } catch {
                  return;
                }
              }
              rawTemplates.push({
                examplePath: relativePath,
                targetPath: derived.targetPath,
                format: derived.format,
                size: info.size,
                modifiedAt: info.mtimeMs,
              });
            } catch {
              skippedCount += 1;
            }
          });
          continue;
        }
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
  const templates = deduplicateOrphanTemplates(rawTemplates, existingPathsLower);
  const envGroups = detectEnvGroups(files);
  if (!files.length && !templates.length) warnings.push("没有发现 Confui 支持的配置文件");
  if (scanCapped) warnings.push("项目内容较多，扫描已达到安全上限；可以缩小项目范围后再试。");

  return {
    root,
    name: basename(root) || root,
    files,
    templates,
    envGroups,
    detectedGithubUrl: await detectGithubRemote(root),
    scannedAt: Date.now(),
    skippedCount,
    ...(scanCapped ? { capped: true } : {}),
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

/**
 * Derives the target configuration file path and format for an example/template
 * file (e.g. `.env.example` -> `.env`, `config.example.jsonc` -> `config.jsonc`,
 * `app.yaml.sample` -> `app.yaml`). Returns `null` if the filename does not map
 * cleanly to a supported editable config format.
 */
export function deriveTargetFromExample(
  relativeExamplePath: string,
): { targetPath: string; format: ConfigFormat } | null {
  const normalized = relativeExamplePath.replace(/\\/g, "/");
  const dir = posix.dirname(normalized);
  const name = posix.basename(normalized);
  const lower = name.toLowerCase();
  if (!name || SCHEMA_FILE.test(lower) || /\.bak(?:\.|$)/i.test(lower)) return null;

  let targetName: string | undefined;

  // 1. Trailing marker: `.env.example`, `.env.local.example`, `config.json.sample`
  for (const marker of EXAMPLE_MARKERS) {
    const dotSuffix = `.${marker}`;
    if (lower.endsWith(dotSuffix) && name.length > dotSuffix.length) {
      const candidate = name.slice(0, -dotSuffix.length);
      if (detectFormat(candidate)) {
        targetName = candidate;
        break;
      }
    }
  }

  // 2. Infix marker before extension: `config.example.jsonc`, `app-sample.yaml`, `settings_template.toml`
  if (!targetName) {
    const ext = extname(name);
    if (ext && ext.length < name.length) {
      const stem = name.slice(0, -ext.length);
      const markerPattern = new RegExp(`^(.+?)[._-](?:${EXAMPLE_MARKERS.join("|")})$`, "i");
      const match = stem.match(markerPattern);
      if (match?.[1]) {
        const candidate = `${match[1]}${ext}`;
        if (detectFormat(candidate)) targetName = candidate;
      }
    }
  }

  if (!targetName || targetName.toLowerCase() === lower) return null;
  const targetLower = targetName.toLowerCase();
  if (IGNORE_FILES.has(targetLower) || SCHEMA_FILE.test(targetLower) || isExampleFilename(targetName)) {
    return null;
  }
  const format = detectFormat(targetName);
  if (!format) return null;
  const targetPath = dir === "." ? targetName : `${dir}/${targetName}`;
  return { targetPath, format };
}

function markerPriority(examplePath: string): number {
  const lower = posix.basename(examplePath).toLowerCase();
  const idx = EXAMPLE_MARKERS.findIndex((marker) => new RegExp(`(?:^|[._-])${marker}(?:[._-]|$)`, "i").test(lower));
  return idx >= 0 ? idx : EXAMPLE_MARKERS.length;
}

function deduplicateOrphanTemplates(
  candidates: readonly ExampleTemplate[],
  existingPathsLower: ReadonlySet<string>,
): ExampleTemplate[] {
  const byTarget = new Map<string, ExampleTemplate>();
  const sorted = [...candidates].sort((left, right) =>
    markerPriority(left.examplePath) - markerPriority(right.examplePath)
    || left.examplePath.localeCompare(right.examplePath, "en", { numeric: true, sensitivity: "base" }),
  );
  for (const template of sorted) {
    const targetKey = template.targetPath.toLowerCase();
    if (existingPathsLower.has(targetKey)) continue;
    if (!byTarget.has(targetKey)) byTarget.set(targetKey, template);
  }
  return [...byTarget.values()].sort((left, right) =>
    left.targetPath.localeCompare(right.targetPath, "en", { numeric: true, sensitivity: "base" }),
  );
}

/**
 * Groups multi-environment config files residing in the same directory
 * (e.g. `.env` + `.env.local` + `.env.production`, or `config.json` +
 * `config.dev.json` + `config.prod.json`, or `application.yml` + `application-prod.yml`).
 */
export function detectEnvGroups(files: readonly ConfigFile[]): ConfigEnvGroup[] {
  const openable = files.filter((file) => file.status === "ready" || file.status === "large");
  const buckets = new Map<string, { label: string; format: ConfigFormat; baseNameLower: string; files: ConfigFile[] }>();

  for (const file of openable) {
    const normalized = file.path.replace(/\\/g, "/");
    const dir = posix.dirname(normalized);
    const name = posix.basename(normalized);
    const lower = name.toLowerCase();

    let familyKey: string | undefined;
    let label: string | undefined;
    let baseNameLower = "";

    if (lower === ".env" || lower.startsWith(".env.")) {
      familyKey = `${dir}|env|.env`;
      label = dir === "." ? ".env" : `${dir}/.env`;
      baseNameLower = ".env";
    } else {
      const ext = extname(name);
      if (!ext || ext.length >= name.length) continue;
      const stem = name.slice(0, -ext.length);
      const variantMatch = stem.match(ENV_VARIANT_RE);
      const baseStem = variantMatch?.[1] ?? stem;
      const formatFamily = file.format === "jsonc" ? "json" : file.format;
      familyKey = `${dir}|${formatFamily}|${baseStem.toLowerCase()}`;
      label = dir === "." ? `${baseStem}${ext}` : `${dir}/${baseStem}${ext}`;
      baseNameLower = `${baseStem.toLowerCase()}${ext.toLowerCase()}`;
    }

    const bucket = buckets.get(familyKey);
    if (bucket) {
      bucket.files.push(file);
    } else {
      buckets.set(familyKey, { label, format: file.format, baseNameLower, files: [file] });
    }
  }

  const groups: ConfigEnvGroup[] = [];
  for (const [, bucket] of buckets) {
    if (bucket.files.length < 2) continue;
    const sortedFiles = [...bucket.files].sort((left, right) => {
      const leftName = posix.basename(left.path).toLowerCase();
      const rightName = posix.basename(right.path).toLowerCase();
      const leftBase = leftName === bucket.baseNameLower ? 0 : 1;
      const rightBase = rightName === bucket.baseNameLower ? 0 : 1;
      return leftBase - rightBase
        || left.path.localeCompare(right.path, "en", { numeric: true, sensitivity: "base" });
    });
    const firstFile = sortedFiles[0]!;
    groups.push({
      id: bucket.label,
      label: bucket.label,
      format: firstFile.format,
      files: sortedFiles.map((item) => item.path),
    });
  }

  return groups.sort((left, right) =>
    left.id.localeCompare(right.id, "en", { numeric: true, sensitivity: "base" }),
  );
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
