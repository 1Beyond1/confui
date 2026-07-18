import { basename } from "node:path";
import type { ConfigFormSchema, InferOptions } from "../../shared/schema.ts";
import type { AIProvider } from "../ai/provider.ts";
import { AI_FILE_LIMIT, readTextSnapshot } from "../files.ts";
import { detectFormat, parseConfig } from "../formats.ts";
import { safeJoin } from "../paths.ts";
import { inferAIFields } from "./ai.ts";
import { inferExampleFields } from "./examples.ts";
import { inferHeuristicFields, maskDocumentSecrets, maskSecrets } from "./heuristic.ts";
import { inferJsonSchemaFields } from "./json-schema.ts";
import { inferKnownFields } from "./known.ts";
import { mergeCandidates } from "./merge.ts";
import { inferReadmeFields } from "./readme.ts";
import type { FieldCandidate } from "./types.ts";

export interface InferenceContext extends InferOptions {
  ai?: AIProvider;
  githubToken?: string;
}

export async function inferConfig(
  root: string,
  relativeFile: string,
  options: InferenceContext = {},
): Promise<ConfigFormSchema> {
  const absolutePath = safeJoin(root, relativeFile);
  const format = detectFormat(relativeFile);
  if (!format) throw new Error("不支持这个配置文件格式");
  const { text, version } = await readTextSnapshot(absolutePath);
  const parsed = parseConfig(text, format);
  const warnings: string[] = [];
  const candidates: FieldCandidate[] = [];

  const known = inferKnownFields(basename(relativeFile), parsed);
  const collapsedPrefixes = known
    .filter((candidate) => candidate.type === "json" && candidate.value !== undefined)
    .map((candidate) => candidate.segments);
  const heuristic = inferHeuristicFields(parsed).filter((candidate) =>
    !collapsedPrefixes.some((prefix) => isDescendantPath(candidate.segments, prefix)),
  );
  candidates.push(...heuristic, ...known);

  if (format === "json" || format === "jsonc") {
    const schema = await inferJsonSchemaFields(absolutePath, root, parsed);
    candidates.push(...schema.fields);
    warnings.push(...schema.warnings);
  }

  const examples = await inferExampleFields(absolutePath, root, format);
  candidates.push(...examples.fields);

  const knownPaths = uniquePaths(candidates.map((candidate) => candidate.segments));
  const readme = await inferReadmeFields(
    root,
    options.githubUrl,
    options.githubToken,
    knownPaths,
    format,
  );
  candidates.push(...readme.fields);
  if (readme.warning) warnings.push(readme.warning);

  const unresolvedPaths = mergeCandidates(candidates).fields
    .filter((field) => !field.description)
    .map((field) => field.segments);
  if (options.ai && version.size <= AI_FILE_LIMIT && unresolvedPaths.length) {
    try {
      candidates.push(...await inferAIFields({
        provider: options.ai,
        file: relativeFile,
        format,
        maskedValue: maskSecrets(parsed),
        availablePaths: unresolvedPaths,
        readmeContext: maskDocumentSecrets(readme.text),
        exampleContext: examples.context,
      }));
    } catch (error) {
      warnings.push(`AI 分析已跳过：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (options.ai && version.size > AI_FILE_LIMIT && unresolvedPaths.length) {
    warnings.push("文件超过 1 MB，已跳过 AI 分析");
  }

  const merged = mergeCandidates(candidates);
  if (!merged.fields.length) warnings.push("没有发现可转换为表单的字段，可在原始内容中检查文件");
  return {
    file: relativeFile.replace(/\\/g, "/"),
    kind: basename(relativeFile),
    format,
    fields: merged.fields,
    sources: merged.sources,
    writable: merged.fields.length > 0,
    warnings: [...new Set(warnings)],
    exampleFiles: examples.files,
    readmeSource: readme.source,
    version,
    rawText: text,
  };
}

function uniquePaths(paths: readonly (readonly (string | number)[])[]): Array<Array<string | number>> {
  const seen = new Set<string>();
  const result: Array<Array<string | number>> = [];
  for (const segments of paths) {
    const key = JSON.stringify(segments);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push([...segments]);
  }
  return result;
}

function isDescendantPath(path: readonly (string | number)[], prefix: readonly (string | number)[]): boolean {
  return path.length > prefix.length && prefix.every((segment, index) => path[index] === segment);
}
