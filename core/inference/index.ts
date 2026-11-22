import { basename } from "node:path";
import type { ConfigFormSchema, FieldSpec, InferOptions, Locale } from "../../shared/schema.ts";
import type { AIProvider } from "../ai/provider.ts";
import { AI_FILE_LIMIT, readTextSnapshot } from "../files.ts";
import { assertEditableSyntax, detectFormat, parseConfig } from "../formats.ts";
import { getAtPath, resolveExistingProjectPath } from "../paths.ts";
import { inferAIFields } from "./ai.ts";
import { toEditorValue } from "./common.ts";
import { inferExampleFields } from "./examples.ts";
import { inferHeuristicFields, maskDocumentSecrets, maskSecrets } from "./heuristic.ts";
import { inferJsonSchemaFields } from "./json-schema.ts";
import { inferKnownFields } from "./known.ts";
import { MAX_FORM_FIELDS, mergeCandidates } from "./merge.ts";
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
  const resolved = await resolveExistingProjectPath(root, relativeFile);
  const projectRoot = resolved.root;
  const absolutePath = resolved.path;
  const format = detectFormat(relativeFile);
  if (!format) throw new Error("不支持这个配置文件格式");
  const { text, version } = await readTextSnapshot(absolutePath);
  assertEditableSyntax(relativeFile, text);
  const parsed = parseConfig(text, format);
  const warnings: string[] = [];
  const candidates: FieldCandidate[] = [];

  const locale: Locale = options.locale === "en-US" ? "en-US" : "zh-CN";
  const known = inferKnownFields(basename(relativeFile), parsed, format, locale);
  const collapsedPrefixes = known
    .filter((candidate) => candidate.type === "json" && candidate.value !== undefined)
    .map((candidate) => candidate.segments);
  const heuristicResult = inferHeuristicFields(parsed);
  const heuristic = heuristicResult.fields.filter((candidate) =>
    !collapsedPrefixes.some((prefix) => isDescendantPath(candidate.segments, prefix)),
  );
  if (heuristicResult.truncated) warnings.push("当前配置字段过多，结构推断已达到安全上限；表单只展示有限字段。");
  candidates.push(...heuristic, ...known);

  // These sources do not depend on one another. Running them together is
  // especially useful for projects whose `$schema` is remote: otherwise a
  // schema request and example-file scan add their latency one after another.
  const schemaPromise = format === "json" || format === "jsonc"
    ? inferJsonSchemaFields(absolutePath, projectRoot, parsed)
    : Promise.resolve({ fields: [], warnings: [], truncated: false });
  const examplesPromise = inferExampleFields(absolutePath, projectRoot, format);
  const [schema, examples] = await Promise.all([schemaPromise, examplesPromise]);
  candidates.push(...schema.fields);
  warnings.push(...schema.warnings);
  if (schema.truncated) warnings.push("JSON Schema 字段过多，已停止继续展开其余字段。");
  candidates.push(...examples.fields);
  if (examples.truncated) warnings.push("示例文件字段过多，已停止继续展开其余字段。");

  const knownPaths = uniquePaths(candidates.map((candidate) => candidate.segments));
  const readme = await inferReadmeFields(
    projectRoot,
    options.githubUrl,
    options.githubToken,
    knownPaths,
    format,
  );
  candidates.push(...readme.fields);
  if (readme.warning) warnings.push(readme.warning);
  if (readme.truncated) warnings.push("README 中可识别字段过多，已停止继续解析其余内容。");

  const preMerged = mergeCandidates(candidates);
  const unresolvedPaths = preMerged.fields
    .filter((field) => !field.description)
    .map((field) => field.segments);
  const secretPaths = uniquePaths([
    ...candidates
      .filter((candidate) => candidate.secret === true || candidate.type === "secret")
      .map((candidate) => candidate.segments),
    ...preMerged.fields
      .filter((field) => field.secret === true || field.type === "secret")
      .map((field) => field.segments),
  ]);
  if (options.ai && version.size <= AI_FILE_LIMIT && unresolvedPaths.length) {
    try {
      candidates.push(...await inferAIFields({
        provider: options.ai,
        file: relativeFile,
        format,
        maskedValue: maskSecrets(parsed, [], { secretPaths }),
        availablePaths: unresolvedPaths,
        readmeContext: maskDocumentSecrets(readme.text),
        exampleContext: examples.context,
        locale,
      }));
    } catch (error) {
      const prefix = locale === "en-US" ? "AI analysis skipped: " : "AI 分析已跳过：";
      warnings.push(`${prefix}${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (options.ai && version.size > AI_FILE_LIMIT && unresolvedPaths.length) {
    warnings.push(locale === "en-US" ? "File exceeds 1 MB; AI analysis was skipped." : "文件超过 1 MB，已跳过 AI 分析");
  }

  const merged = mergeCandidates(candidates);
  const fields = hydrateFieldValues(merged.fields, parsed);
  if (merged.truncated) {
    warnings.push(`字段数量较多（共 ${merged.totalFieldCount} 项），仅展示优先级最高的前 ${MAX_FORM_FIELDS} 项；其余内容仍保留在原始文件中。`);
  }
  if (!fields.length) warnings.push("没有发现可转换为表单的字段，可在原始内容中检查文件");
  return {
    file: relativeFile.replace(/\\/g, "/"),
    kind: basename(relativeFile),
    format,
    fields,
    sources: merged.sources,
    writable: fields.length > 0,
    warnings: [...new Set(warnings)],
    exampleFiles: examples.files,
    readmeSource: readme.source,
    version,
    rawText: text,
  };
}

function hydrateFieldValues(fields: readonly FieldSpec[], parsed: unknown): FieldSpec[] {
  return fields.map((field) => {
    if (field.value !== undefined) return field;
    const actual = getAtPath(parsed, field.segments);
    if (actual === undefined) return field;
    return { ...field, value: toEditorValue(actual) };
  });
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
