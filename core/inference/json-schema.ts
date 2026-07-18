import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldType, PathSegment } from "../../shared/schema.ts";
import { getAtPath } from "../paths.ts";
import { groupForPath, humanize, isSecretPath } from "./common.ts";
import type { FieldCandidate } from "./types.ts";

interface SchemaResult {
  fields: FieldCandidate[];
  warnings: string[];
}

type JsonSchema = Record<string, unknown>;
const remoteSchemaCache = new Map<string, Promise<JsonSchema>>();

export async function inferJsonSchemaFields(
  filePath: string,
  projectRoot: string,
  value: unknown,
): Promise<SchemaResult> {
  const warnings: string[] = [];
  const schema = await findSchema(filePath, projectRoot, value, warnings);
  if (!schema) return { fields: [], warnings };
  try {
    return { fields: fieldsFromSchema(schema, schema, value), warnings };
  } catch (error) {
    warnings.push(`JSON Schema 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return { fields: [], warnings };
  }
}

async function findSchema(
  filePath: string,
  projectRoot: string,
  value: unknown,
  warnings: string[],
): Promise<JsonSchema | undefined> {
  const schemaRef = value !== null && typeof value === "object"
    ? (value as Record<string, unknown>).$schema
    : undefined;
  if (typeof schemaRef === "string") {
    try {
      if (/^https?:\/\//i.test(schemaRef)) return await fetchSchema(schemaRef);
      const candidate = schemaRef.startsWith("file:")
        ? fileURLToPath(schemaRef)
        : resolve(dirname(filePath), schemaRef);
      if (isInsideProject(candidate, projectRoot)) return await readSchema(candidate);
      warnings.push("配置声明的 JSON Schema 位于项目目录之外，已跳过");
    } catch (error) {
      warnings.push(`未能读取配置声明的 JSON Schema：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const extension = extname(filePath);
  const stem = filePath.slice(0, extension ? -extension.length : undefined);
  for (const candidate of [`${stem}.schema.json`, join(dirname(filePath), "schema.json")]) {
    try {
      return await readSchema(candidate);
    } catch {
      // Missing conventional schema files are expected.
    }
  }
  return undefined;
}

async function readSchema(path: string): Promise<JsonSchema> {
  const text = await readFile(path, "utf8");
  if (text.length > 2 * 1024 * 1024) throw new Error("Schema 超过 2 MB");
  return JSON.parse(text) as JsonSchema;
}

async function fetchSchema(url: string): Promise<JsonSchema> {
  const cached = remoteSchemaCache.get(url);
  if (cached) return cached;
  const request = fetchSchemaUncached(url);
  remoteSchemaCache.set(url, request);
  try {
    return await request;
  } catch (error) {
    remoteSchemaCache.delete(url);
    throw error;
  }
}

async function fetchSchemaUncached(url: string): Promise<JsonSchema> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/schema+json, application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error("Schema 超过 2 MB");
    return JSON.parse(text) as JsonSchema;
  } finally {
    clearTimeout(timeout);
  }
}

function fieldsFromSchema(
  schemaInput: JsonSchema,
  rootSchema: JsonSchema,
  value: unknown,
  prefix: PathSegment[] = [],
  order = { value: 0 },
  groupHint?: string,
): FieldCandidate[] {
  const schema = resolveSchema(schemaInput, rootSchema);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  const fields: FieldCandidate[] = [];

  for (const [key, rawChild] of Object.entries(properties)) {
    if (!isRecord(rawChild)) continue;
    const child = resolveSchema(rawChild, rootSchema);
    const segments = [...prefix, key];
    const current = getAtPath(value, segments);
    const type = schemaType(child, key, current);
    const childProperties = isRecord(child.properties) ? child.properties : undefined;
    if (type === "json" && childProperties && segments.length <= 3) {
      fields.push(...fieldsFromSchema(
        child,
        rootSchema,
        value,
        segments,
        order,
        typeof child.title === "string" ? child.title : humanize(key),
      ));
      continue;
    }
    const enumValues = Array.isArray(child.enum)
      ? child.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      : undefined;
    const secret = isSecretPath(segments) || child.writeOnly === true || child.format === "password";
    fields.push({
      segments,
      label: typeof child.title === "string" ? child.title : humanize(key),
      description: typeof child.description === "string" ? child.description : undefined,
      type: secret ? "secret" : enumValues?.length ? "enum" : type,
      required: required.has(key),
      default: child.default,
      enum: enumValues?.length ? enumValues : undefined,
      minimum: asNumber(child.minimum),
      maximum: asNumber(child.maximum),
      minLength: asNumber(child.minLength),
      maxLength: asNumber(child.maxLength),
      pattern: typeof child.pattern === "string" ? child.pattern : undefined,
      placeholder: typeof child.examples === "object" && Array.isArray(child.examples) && child.examples.length
        ? String(child.examples[0] ?? "")
        : undefined,
      secret,
      group: groupHint ?? groupForPath(segments),
      source: "json-schema",
      confidence: 0.995,
      detail: "来自项目声明的 JSON Schema",
      order: order.value++,
    });
  }
  return fields;
}

function resolveSchema(schema: JsonSchema, root: JsonSchema): JsonSchema {
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) return mergeAllOf(schema, root);
  const parts = reference.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current)) return schema;
    current = current[part];
  }
  return isRecord(current) ? mergeAllOf({ ...current, ...schema, $ref: undefined }, root) : schema;
}

function mergeAllOf(schema: JsonSchema, root: JsonSchema): JsonSchema {
  if (!Array.isArray(schema.allOf)) return schema;
  return schema.allOf.reduce<JsonSchema>((merged, item) => {
    if (!isRecord(item)) return merged;
    const child = resolveSchema(item, root);
    return {
      ...merged,
      ...child,
      properties: { ...(isRecord(merged.properties) ? merged.properties : {}), ...(isRecord(child.properties) ? child.properties : {}) },
      required: [...new Set([...(Array.isArray(merged.required) ? merged.required : []), ...(Array.isArray(child.required) ? child.required : [])])],
    };
  }, { ...schema, allOf: undefined });
}

function schemaType(schema: JsonSchema, key: string, value: unknown): FieldType {
  if (Array.isArray(schema.enum) && schema.enum.length) return "enum";
  const rawType = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null")
    : schema.type;
  switch (rawType) {
    case "boolean": return "boolean";
    case "number": return "number";
    case "integer": return "integer";
    case "array": return "array";
    case "object": return "json";
    case "string": return isSecretPath([key]) ? "secret" : schema.format === "color" ? "color" : "string";
    default:
      if (typeof value === "boolean") return "boolean";
      if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
      if (Array.isArray(value)) return "array";
      if (value !== null && typeof value === "object") return "json";
      return "string";
  }
}

function isInsideProject(candidate: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
