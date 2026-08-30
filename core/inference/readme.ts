import { join } from "node:path";
import type { ConfigFormat, PathSegment } from "../../shared/schema.ts";
import { parseConfig } from "../formats.ts";
import { ensurePathInsideProject, formatPath, pathKey } from "../paths.ts";
import { groupForPath, humanize, inferFieldType, isSecretPath } from "./common.ts";
import { readLimitedUtf8File, readLimitedUtf8Response } from "./limited-text.ts";
import { readLimitedDirectory } from "./limited-directory.ts";
import type { FieldCandidate } from "./types.ts";

const GITHUB_README_CACHE_TTL_MS = 10 * 60 * 1_000;
const GITHUB_README_CACHE_LIMIT = 32;
const README_MAX_BYTES = 512 * 1024;
const MAX_README_FIELDS = 6_000;
const MAX_README_TEXT_CHARS = 500;
const MAX_README_DEFAULT_CHARS = 4_000;
const MAX_LOOKUP_ENTRIES = 10_000;

// Opening several config files in one project should not spend one GitHub API
// request per file. Public README responses are safe to reuse for a short
// session; authenticated responses deliberately bypass this cache so a token
// change can never expose one account's private README to another request.
const githubReadmeCache = new Map<string, {
  fetchedAt: number;
  text: Promise<string | undefined>;
}>();

export interface ReadmeResult {
  fields: FieldCandidate[];
  text: string;
  source?: "local" | "github";
  warning?: string;
  truncated: boolean;
}

export async function inferReadmeFields(
  projectRoot: string,
  githubUrl: string | undefined,
  token: string | undefined,
  knownPaths: readonly PathSegment[][],
  format: ConfigFormat,
): Promise<ReadmeResult> {
  let text = await readLocalReadme(projectRoot);
  let source: ReadmeResult["source"] = text ? "local" : undefined;
  let warning: string | undefined;

  if (!text && githubUrl) {
    try {
      text = await fetchGithubReadme(githubUrl, token);
      if (text) source = "github";
    } catch (error) {
      warning = `GitHub README 读取失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!text) return { fields: [], text: "", warning, truncated: false };
  const parsed = parseReadmeDetailed(text, knownPaths, format);
  return {
    fields: parsed.fields,
    text: text.slice(0, 100_000),
    source,
    warning,
    truncated: parsed.truncated,
  };
}

export async function readLocalReadme(projectRoot: string): Promise<string | undefined> {
  const roots = [projectRoot, join(projectRoot, "docs")];
  for (const directory of roots) {
    try {
      const safeDirectory = await ensurePathInsideProject(projectRoot, directory);
      const { entries } = await readLimitedDirectory(safeDirectory, MAX_LOOKUP_ENTRIES);
      const readmes = entries
        .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && /^readme(?:\.[a-z0-9_-]+)?\.(?:md|mdx|rst|txt)$/i.test(entry.name))
        .sort((left, right) => scoreReadme(left.name) - scoreReadme(right.name));
      const first = readmes[0];
      if (first) {
        const safeReadme = await ensurePathInsideProject(projectRoot, join(safeDirectory, first.name));
        return await readLimitedUtf8File(safeReadme, {
          maxBytes: README_MAX_BYTES,
          overflow: "truncate",
        });
      }
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined;
}

export async function fetchGithubReadme(
  githubUrl: string,
  token?: string,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const repository = parseGithubRepository(githubUrl);
  if (!repository) throw new Error("GitHub 仓库链接格式不正确");
  const authToken = token?.trim() || undefined;
  if (authToken) return fetchGithubReadmeUncached(repository, authToken, fetcher);

  const cacheKey = `${repository.owner}/${repository.repo}`.toLowerCase();
  const cached = githubReadmeCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < GITHUB_README_CACHE_TTL_MS) return cached.text;

  const request = fetchGithubReadmeUncached(repository, undefined, fetcher);
  githubReadmeCache.delete(cacheKey);
  githubReadmeCache.set(cacheKey, { fetchedAt: Date.now(), text: request });
  while (githubReadmeCache.size > GITHUB_README_CACHE_LIMIT) {
    const oldest = githubReadmeCache.keys().next().value;
    if (oldest === undefined) break;
    githubReadmeCache.delete(oldest);
  }
  try {
    return await request;
  } catch (error) {
    if (githubReadmeCache.get(cacheKey)?.text === request) githubReadmeCache.delete(cacheKey);
    throw error;
  }
}

async function fetchGithubReadmeUncached(
  repository: { owner: string; repo: string },
  token: string | undefined,
  fetcher: typeof fetch,
): Promise<string | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetcher(`https://api.github.com/repos/${repository.owner}/${repository.repo}/readme`, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "Confui",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`GitHub API 返回 ${response.status}`);
    }
    return await readLimitedUtf8Response(response, {
      maxBytes: README_MAX_BYTES,
      overflow: "truncate",
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseReadme(
  text: string,
  knownPaths: readonly PathSegment[][],
  format: ConfigFormat,
): FieldCandidate[] {
  return parseReadmeDetailed(text, knownPaths, format).fields;
}

function parseReadmeDetailed(
  text: string,
  knownPaths: readonly PathSegment[][],
  format: ConfigFormat,
): { fields: FieldCandidate[]; truncated: boolean } {
  const matcher = createPathMatcher(knownPaths);
  const candidates: FieldCandidate[] = [];
  let truncated = false;
  let order = 20_000;
  const lines = text.split(/\r?\n/);

  const addCandidate = (candidate: FieldCandidate): boolean => {
    if (candidates.length >= MAX_README_FIELDS) {
      truncated = true;
      return false;
    }
    candidates.push(candidate);
    return true;
  };

  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = parseTableRow(lines[index] ?? "");
    const separator = parseTableRow(lines[index + 1] ?? "");
    if (!header.length || separator.length !== header.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    const columns = mapTableColumns(header);
    if (columns.key < 0 || columns.description < 0) continue;
    index += 2;
    while (index < lines.length) {
      const row = parseTableRow(lines[index] ?? "");
      if (row.length < 2) break;
      const rawKey = stripMarkdown(row[columns.key] ?? "");
      const segments = matcher(rawKey);
      if (segments) {
        const defaultRaw = columns.default >= 0 ? stripMarkdown(row[columns.default] ?? "") : "";
        const requiredRaw = columns.required >= 0 ? stripMarkdown(row[columns.required] ?? "") : "";
        if (!addCandidate({
          segments,
          label: humanize(String(segments.at(-1) ?? rawKey)),
          description: limitText(stripMarkdown(row[columns.description] ?? ""), MAX_README_TEXT_CHARS),
          default: defaultRaw && !/^[-—无n/a]+$/i.test(defaultRaw) && defaultRaw.length <= MAX_README_DEFAULT_CHARS
            ? parseScalar(defaultRaw)
            : undefined,
          required: requiredRaw ? /^(?:yes|true|required|必填|是|✓|✅)$/i.test(requiredRaw) : undefined,
          source: "readme",
          confidence: 0.93,
          detail: "来自 README 配置表格",
          order: order++,
        })) break;
      }
      index += 1;
    }
    if (truncated) break;
  }

  for (const line of lines) {
    if (truncated) break;
    const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:`([^`]+)`|\*\*([^*]+)\*\*|([A-Za-z_][\w.-]*))\s*(?::|[-–—])\s*(.+)$/);
    const rawKey = match?.[1] ?? match?.[2] ?? match?.[3];
    const description = match?.[4]?.trim();
    if (!rawKey || !description) continue;
    const segments = matcher(rawKey);
    if (!segments) continue;
    if (!addCandidate({
      segments,
      description: limitText(stripMarkdown(description), MAX_README_TEXT_CHARS),
      required: /\b(required|must)\b|必填|必须/i.test(description) ? true : undefined,
      source: "readme",
      confidence: 0.78,
      detail: "来自 README 字段说明",
      order: order++,
    })) break;
  }

  for (const block of extractCodeBlocks(text)) {
    if (truncated) break;
    try {
      const parsed = parseConfig(block, format);
      const flattened = flattenCodeExample(parsed, MAX_README_FIELDS - candidates.length);
      for (const item of flattened.items) {
        const segments = matcher(formatPath(item.segments));
        if (!segments) continue;
        if (!addCandidate({
          segments,
          default: item.value,
          type: inferFieldType(String(segments.at(-1) ?? ""), item.value),
          secret: isSecretPath(segments),
          group: groupForPath(segments),
          source: "readme",
          confidence: 0.64,
          detail: "来自 README 配置代码块",
          order: order++,
        })) break;
      }
      truncated ||= flattened.truncated;
    } catch {
      // Most README code blocks are unrelated; ignore those that do not parse as this format.
    }
  }
  return { fields: candidates, truncated };
}

function createPathMatcher(paths: readonly PathSegment[][]): (raw: string) => PathSegment[] | undefined {
  const exact = new Map<string, PathSegment[]>();
  const leaves = new Map<string, PathSegment[][]>();
  for (const segments of paths) {
    const variants = [
      formatPath(segments),
      segments.join("."),
      segments.join("_"),
    ];
    for (const variant of variants) {
      const normalized = normalizeKey(variant);
      exact.set(normalized, [...segments]);
    }
    const leaf = normalizeKey(String(segments.at(-1) ?? ""));
    const list = leaves.get(leaf) ?? [];
    list.push([...segments]);
    leaves.set(leaf, list);
  }
  return (raw) => {
    const normalized = normalizeKey(stripMarkdown(raw));
    const direct = exact.get(normalized);
    if (direct) return [...direct];
    const leafMatches = leaves.get(normalized);
    return leafMatches?.length === 1 ? [...(leafMatches[0] ?? [])] : undefined;
  };
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  return trimmed.replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function mapTableColumns(headers: string[]): { key: number; description: number; default: number; required: number } {
  const normalized = headers.map((header) => normalizeKey(stripMarkdown(header)));
  return {
    key: normalized.findIndex((header) => /^(field|key|name|option|variable|property|字段|配置项|参数|变量|环境变量)$/.test(header)),
    description: normalized.findIndex((header) => /^(description|meaning|details?|说明|描述|含义|用途)$/.test(header)),
    default: normalized.findIndex((header) => /^(default|defaultvalue|默认|默认值)$/.test(header)),
    required: normalized.findIndex((header) => /^(required|mandatory|必填|必须)$/.test(header)),
  };
}

function extractCodeBlocks(text: string): string[] {
  return [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "").filter(Boolean);
}

function flattenCodeExample(value: unknown, maxFields: number): { items: Array<{ segments: PathSegment[]; value: unknown }>; truncated: boolean } {
  const result: Array<{ segments: PathSegment[]; value: unknown }> = [];
  let truncated = false;
  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (result.length >= maxFields) {
      truncated = true;
      return;
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length) {
        for (const [key, item] of entries) {
          visit(item, [...segments, key], depth + 1);
          if (truncated) return;
        }
        return;
      }
    }
    if (segments.length) result.push({ segments, value: current });
  }
  visit(value, [], 0);
  return { items: result, truncated };
}

function parseGithubRepository(url: string): { owner: string; repo: string } | undefined {
  const trimmed = url.trim();
  const candidate = trimmed.match(/^git@github\.com:(.+)$/i)
    ? `https://github.com/${trimmed.slice("git@github.com:".length)}`
    : trimmed;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return undefined;
  }
  if (!/^https?:$/i.test(parsed.protocol) || !/^(?:www\.)?github\.com$/i.test(parsed.hostname)) return undefined;
  if (parsed.username || parsed.password) return undefined;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const owner = parts[0];
  const repo = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repo || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo)) return undefined;
  return { owner, repo };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[`"'\s\[\]]/g, "").replace(/[-_]/g, "");
}

function stripMarkdown(value: string): string {
  return value.replace(/[`*_~]/g, "").replace(/<br\s*\/?>/gi, " ").trim();
}

function limitText(value: string, limit: number): string | undefined {
  if (!value) return undefined;
  return value.slice(0, limit);
}

function parseScalar(value: string): unknown {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  if (/^(true|yes|是)$/i.test(normalized)) return true;
  if (/^(false|no|否)$/i.test(normalized)) return false;
  if (/^-?\d+$/.test(normalized)) return Number.parseInt(normalized, 10);
  if (/^-?\d+\.\d+$/.test(normalized)) return Number.parseFloat(normalized);
  return normalized;
}

function scoreReadme(filename: string): number {
  if (/^readme\.md$/i.test(filename)) return 0;
  if (/^readme\.zh(?:-cn)?\.md$/i.test(filename)) return 1;
  if (/^readme\.(?:mdx|rst|txt)$/i.test(filename)) return 2;
  return 3;
}
