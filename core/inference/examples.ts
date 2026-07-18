import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import type { ConfigFormat, PathSegment } from "../../shared/schema.ts";
import { parseConfig } from "../formats.ts";
import { groupForPath, humanize, inferFieldType, isSecretPath } from "./common.ts";
import { maskSecrets } from "./heuristic.ts";
import type { FieldCandidate } from "./types.ts";

const MARKERS = ["example", "sample", "template", "dist", "default"];

export interface ExampleResult {
  fields: FieldCandidate[];
  files: string[];
  context: string;
}

export async function inferExampleFields(
  configPath: string,
  projectRoot: string,
  format: ConfigFormat,
): Promise<ExampleResult> {
  const examplePaths = await findExampleFiles(configPath);
  const fields: FieldCandidate[] = [];
  const contextParts: string[] = [];
  let order = 10_000;

  for (const examplePath of examplePaths) {
    try {
      const text = await readFile(examplePath, "utf8");
      if (text.length > 512 * 1024) continue;
      const parsed = parseConfig(text, format);
      const comments = extractComments(text);
      fields.push(...flattenExample(parsed, comments, () => order++));
      contextParts.push(
        `--- ${basename(examplePath)} ---\n${JSON.stringify(maskSecrets(parsed), null, 2).slice(0, 12_000)}`,
      );
    } catch {
      // One broken sample should not stop inference from the others.
    }
  }

  return {
    fields,
    files: examplePaths.map((path) => relative(projectRoot, path).replace(/\\/g, "/")),
    context: contextParts.join("\n\n").slice(0, 24_000),
  };
}

export async function findExampleFiles(configPath: string): Promise<string[]> {
  const directory = dirname(configPath);
  const target = basename(configPath).toLowerCase();
  const extension = extname(target);
  const stem = extension ? target.slice(0, -extension.length) : target;
  const candidates = new Set<string>();
  for (const marker of MARKERS) {
    candidates.add(`${target}.${marker}`);
    candidates.add(`${stem}.${marker}${extension}`);
    candidates.add(`${stem}-${marker}${extension}`);
    if (target === ".env" || target.startsWith(".env.")) candidates.add(`.env.${marker}`);
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && candidates.has(entry.name.toLowerCase()))
      .map((entry) => join(directory, entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function flattenExample(
  value: unknown,
  comments: Map<string, string>,
  nextOrder: () => number,
): FieldCandidate[] {
  const fields: FieldCandidate[] = [];

  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length) {
        for (const [key, child] of entries) visit(child, [...segments, key], depth + 1);
        return;
      }
    }
    if (!segments.length) return;
    const leaf = String(segments.at(-1) ?? "字段");
    const placeholder = typeof current === "string" && isPlaceholder(current);
    const secret = isSecretPath(segments);
    fields.push({
      segments,
      label: humanize(leaf),
      description: comments.get(leaf.toLowerCase()),
      type: secret ? "secret" : inferFieldType(leaf, current),
      required: placeholder,
      default: placeholder ? undefined : current,
      placeholder: placeholder ? String(current) : undefined,
      secret,
      group: groupForPath(segments),
      source: "example",
      confidence: comments.has(leaf.toLowerCase()) ? 0.9 : 0.82,
      detail: "来自项目随附的示例配置",
      order: nextOrder(),
    });
  }

  visit(value, [], 0);
  return fields;
}

function isPlaceholder(value: string): boolean {
  return /^(?:<[^>]+>|\$\{[^}]+\}|YOUR[_-]|CHANGE[_-]?ME|REPLACE[_-]?ME|INSERT[_-]|EXAMPLE[_-]|xxx+$)/i.test(value.trim());
}

function extractComments(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const pending: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const comment = line.match(/^\s*(?:#|\/\/|;|!)\s*(.+?)\s*$/)?.[1];
    if (comment) {
      pending.push(comment);
      continue;
    }
    const inline = line.match(/^\s*["']?([A-Za-z_][\w.-]*)["']?\s*(?::|=)\s*[^#]*?(?:\s+#\s*(.+))?$/);
    if (inline?.[1]) {
      const description = inline[2]?.trim() || pending.join(" ").trim();
      if (description) result.set(inline[1].toLowerCase(), description);
      pending.length = 0;
      continue;
    }
    if (line.trim()) pending.length = 0;
  }
  return result;
}
