import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ConfigFormat, PathSegment } from "../../shared/schema.ts";
import { parseConfig } from "../formats.ts";
import { formatPath, pathKey } from "../paths.ts";
import { groupForPath, humanize, inferFieldType, isSecretPath } from "./common.ts";
import type { FieldCandidate } from "./types.ts";

export interface ReadmeResult {
  fields: FieldCandidate[];
  text: string;
  source?: "local" | "github";
  warning?: string;
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
  if (!text) return { fields: [], text: "", warning };
  return {
    fields: parseReadme(text, knownPaths, format),
    text: text.slice(0, 100_000),
    source,
    warning,
  };
}

export async function readLocalReadme(projectRoot: string): Promise<string | undefined> {
  const roots = [projectRoot, join(projectRoot, "docs")];
  for (const directory of roots) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const readmes = entries
        .filter((entry) => entry.isFile() && /^readme(?:\.[a-z0-9_-]+)?\.(?:md|mdx|rst|txt)$/i.test(entry.name))
        .sort((left, right) => scoreReadme(left.name) - scoreReadme(right.name));
      const first = readmes[0];
      if (first) return (await readFile(join(directory, first.name), "utf8")).slice(0, 512 * 1024);
    } catch {
      // Try the next conventional location.
    }
  }
  return undefined;
}

export async function fetchGithubReadme(githubUrl: string, token?: string): Promise<string | undefined> {
  const repository = parseGithubRepository(githubUrl);
  if (!repository) throw new Error("GitHub 仓库链接格式不正确");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.repo}/readme`, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "Confui/0.2",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub API 返回 ${response.status}`);
    const text = await response.text();
    return text.slice(0, 512 * 1024);
  } finally {
    clearTimeout(timeout);
  }
}

export function parseReadme(
  text: string,
  knownPaths: readonly PathSegment[][],
  format: ConfigFormat,
): FieldCandidate[] {
  const matcher = createPathMatcher(knownPaths);
  const candidates: FieldCandidate[] = [];
  let order = 20_000;
  const lines = text.split(/\r?\n/);

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
        candidates.push({
          segments,
          label: humanize(String(segments.at(-1) ?? rawKey)),
          description: stripMarkdown(row[columns.description] ?? ""),
          default: defaultRaw && !/^[-—无n/a]+$/i.test(defaultRaw) ? parseScalar(defaultRaw) : undefined,
          required: requiredRaw ? /^(?:yes|true|required|必填|是|✓|✅)$/i.test(requiredRaw) : undefined,
          source: "readme",
          confidence: 0.93,
          detail: "来自 README 配置表格",
          order: order++,
        });
      }
      index += 1;
    }
  }

  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(?:`([^`]+)`|\*\*([^*]+)\*\*|([A-Za-z_][\w.-]*))\s*(?::|[-–—])\s*(.+)$/);
    const rawKey = match?.[1] ?? match?.[2] ?? match?.[3];
    const description = match?.[4]?.trim();
    if (!rawKey || !description) continue;
    const segments = matcher(rawKey);
    if (!segments) continue;
    candidates.push({
      segments,
      description: stripMarkdown(description),
      required: /\b(required|must)\b|必填|必须/i.test(description) ? true : undefined,
      source: "readme",
      confidence: 0.78,
      detail: "来自 README 字段说明",
      order: order++,
    });
  }

  for (const block of extractCodeBlocks(text)) {
    try {
      const parsed = parseConfig(block, format);
      for (const item of flattenCodeExample(parsed)) {
        const segments = matcher(formatPath(item.segments));
        if (!segments) continue;
        candidates.push({
          segments,
          default: item.value,
          type: inferFieldType(String(segments.at(-1) ?? ""), item.value),
          secret: isSecretPath(segments),
          group: groupForPath(segments),
          source: "readme",
          confidence: 0.64,
          detail: "来自 README 配置代码块",
          order: order++,
        });
      }
    } catch {
      // Most README code blocks are unrelated; ignore those that do not parse as this format.
    }
  }
  return candidates;
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

function flattenCodeExample(value: unknown): Array<{ segments: PathSegment[]; value: unknown }> {
  const result: Array<{ segments: PathSegment[]; value: unknown }> = [];
  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length) {
        for (const [key, item] of entries) visit(item, [...segments, key], depth + 1);
        return;
      }
    }
    if (segments.length) result.push({ segments, value: current });
  }
  visit(value, [], 0);
  return result;
}

function parseGithubRepository(url: string): { owner: string; repo: string } | undefined {
  const match = url.trim().match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#]|$)/i);
  if (!match?.[1] || !match[2]) return undefined;
  return { owner: match[1], repo: match[2].replace(/\.git$/i, "") };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[`"'\s\[\]]/g, "").replace(/[-_]/g, "");
}

function stripMarkdown(value: string): string {
  return value.replace(/[`*_~]/g, "").replace(/<br\s*\/?>/gi, " ").trim();
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
