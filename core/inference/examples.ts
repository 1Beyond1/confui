import { basename, dirname, extname, join, relative } from "node:path";
import type { ConfigFormat, PathSegment } from "../../shared/schema.ts";
import { parseConfig } from "../formats.ts";
import { ensurePathInsideProject } from "../paths.ts";
import { readLimitedUtf8File } from "./limited-text.ts";
import { groupForPath, humanize, inferFieldType, isSecretPath, toEditorValue } from "./common.ts";
import { maskSecrets } from "./heuristic.ts";
import { readLimitedDirectory } from "./limited-directory.ts";
import type { FieldCandidate } from "./types.ts";

const MARKERS = ["example", "sample", "template", "dist", "default"];
const EXAMPLE_MAX_BYTES = 512 * 1024;
const MAX_EXAMPLE_FIELDS = 6_000;
const MAX_LOOKUP_ENTRIES = 10_000;

export interface ExampleResult {
  fields: FieldCandidate[];
  files: string[];
  context: string;
  truncated: boolean;
}

export async function inferExampleFields(
  configPath: string,
  projectRoot: string,
  format: ConfigFormat,
): Promise<ExampleResult> {
  const examplePaths = await findExampleFiles(configPath);
  const fields: FieldCandidate[] = [];
  const contextParts: string[] = [];
  const readableExamplePaths: string[] = [];
  let truncated = false;
  let order = 10_000;

  for (const examplePath of examplePaths) {
    const remaining = MAX_EXAMPLE_FIELDS - fields.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    try {
      // Directory discovery and the later read are separate operations. Recheck
      // the physical target immediately before and after reading so a file
      // swapped to an outside symlink/junction cannot contribute context to
      // inference or a user-configured AI service.
      const safeExamplePath = await ensurePathInsideProject(projectRoot, examplePath);
      const text = await readLimitedUtf8File(safeExamplePath, {
        maxBytes: EXAMPLE_MAX_BYTES,
        overflow: "reject",
      });
      await ensurePathInsideProject(projectRoot, examplePath);
      readableExamplePaths.push(safeExamplePath);
      const parsed = parseConfig(text, format);
      const comments = extractComments(text);
      const flattened = flattenExample(parsed, comments, () => order++, remaining);
      fields.push(...flattened.fields);
      truncated ||= flattened.truncated;
      contextParts.push(
        `--- ${basename(safeExamplePath)} ---\n${JSON.stringify(maskSecrets(parsed), null, 2).slice(0, 12_000)}`,
      );
      if (truncated) break;
    } catch {
      // One broken sample should not stop inference from the others.
    }
  }

  return {
    fields,
    files: readableExamplePaths.map((path) => relative(projectRoot, path).replace(/\\/g, "/")),
    context: contextParts.join("\n\n").slice(0, 24_000),
    truncated,
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
    const { entries } = await readLimitedDirectory(directory, MAX_LOOKUP_ENTRIES);
    return entries
      .filter((entry) => !entry.isSymbolicLink() && entry.isFile() && candidates.has(entry.name.toLowerCase()))
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
  maxFields: number,
): { fields: FieldCandidate[]; truncated: boolean } {
  const fields: FieldCandidate[] = [];
  let truncated = false;

  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (fields.length >= maxFields) {
      truncated = true;
      return;
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current) && depth < 3) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length) {
        for (const [key, child] of entries) {
          visit(child, [...segments, key], depth + 1);
          if (truncated) return;
        }
        return;
      }
    }
    if (!segments.length) return;
    const leaf = String(segments.at(-1) ?? "字段");
    const placeholder = typeof current === "string" && isPlaceholder(current);
    const secret = isSecretPath(segments);
    const editorValue = toEditorValue(current);
    fields.push({
      segments,
      label: humanize(leaf),
      description: comments.get(leaf.toLowerCase()),
      type: secret ? "secret" : inferFieldType(leaf, current),
      required: placeholder ? true : undefined,
      default: placeholder ? undefined : editorValue,
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
  return { fields, truncated };
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
