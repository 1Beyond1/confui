import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FieldType, PathSegment } from "../../shared/schema.ts";
import { ensurePathInsideProject, getAtPath } from "../paths.ts";
import { groupForPath, humanize, isSecretPath } from "./common.ts";
import { readLimitedUtf8File, readLimitedUtf8Response } from "./limited-text.ts";
import type { FieldCandidate } from "./types.ts";

interface SchemaResult {
  fields: FieldCandidate[];
  warnings: string[];
}

type JsonSchema = Record<string, unknown>;

/**
 * Hosts whose schemas Confui is willing to fetch. A config file in an untrusted
 * project can name any `$schema` URL, and an unrestricted fetch would turn
 * merely opening that project into an outbound request carrying the user's IP.
 * Everything outside this list is skipped with a warning instead.
 */
const SCHEMA_HOSTS = new Set([
  "json.schemastore.org",
  "schemastore.org",
  "raw.githubusercontent.com",
  "unpkg.com",
  "cdn.jsdelivr.net",
]);

/** Remote schemas change rarely, but the cache must not outlive a long session. */
const SCHEMA_CACHE_TTL_MS = 10 * 60 * 1_000;
const SCHEMA_CACHE_LIMIT = 32;
const SCHEMA_MAX_BYTES = 2 * 1024 * 1024;

const remoteSchemaCache = new Map<string, { fetchedAt: number; schema: Promise<JsonSchema> }>();

export async function inferJsonSchemaFields(
  filePath: string,
  projectRoot: string,
  value: unknown,
  fetcher: typeof fetch = fetch,
): Promise<SchemaResult> {
  const warnings: string[] = [];
  const schema = await findSchema(filePath, projectRoot, value, warnings, fetcher);
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
  fetcher: typeof fetch,
): Promise<JsonSchema | undefined> {
  const schemaRef = value !== null && typeof value === "object"
    ? (value as Record<string, unknown>).$schema
    : undefined;
  if (typeof schemaRef === "string") {
    try {
      if (/^https?:\/\//i.test(schemaRef)) {
        const target = allowedSchemaUrl(schemaRef);
        if (target) return await fetchSchema(target, fetcher);
        // Fall through to the conventional local schema files below.
        warnings.push(`配置声明的 JSON Schema 来自未授信的地址，已跳过：${describeHost(schemaRef)}`);
      } else {
        const candidate = schemaRef.startsWith("file:")
          ? fileURLToPath(schemaRef)
          : resolve(dirname(filePath), schemaRef);
        return await readSchema(candidate, projectRoot);
      }
    } catch (error) {
      warnings.push(`未能读取配置声明的 JSON Schema：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const extension = extname(filePath);
  const stem = filePath.slice(0, extension ? -extension.length : undefined);
  for (const candidate of [`${stem}.schema.json`, join(dirname(filePath), "schema.json")]) {
    try {
      return await readSchema(candidate, projectRoot);
    } catch {
      // Missing conventional schema files are expected.
    }
  }
  return undefined;
}

async function readSchema(path: string, projectRoot: string): Promise<JsonSchema> {
  const safePath = await ensurePathInsideProject(projectRoot, path);
  const text = await readLimitedUtf8File(safePath, {
    maxBytes: SCHEMA_MAX_BYTES,
    overflow: "reject",
    tooLargeMessage: "Schema 超过 2 MiB",
    invalidUtf8Message: "Schema 不是有效的 UTF-8 编码",
  });
  return JSON.parse(text.replace(/^\uFEFF/, "")) as JsonSchema;
}

/**
 * Returns the URL to fetch, or `undefined` when the reference is not one Confui
 * will request. HTTPS only — the allowlisted hosts all serve it, and plain HTTP
 * would let anything on the path rewrite the schema that drives the form.
 */
export function allowedSchemaUrl(schemaRef: string): string | undefined {
  let url: URL;
  try {
    url = new URL(schemaRef);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  // Do not allow credentials embedded in a project-controlled URL. Even on an
  // allowlisted host they would be sent as part of the request unexpectedly.
  if (url.username || url.password) return undefined;
  return SCHEMA_HOSTS.has(url.hostname.toLowerCase()) ? url.href : undefined;
}

async function fetchSchema(url: string, fetcher: typeof fetch): Promise<JsonSchema> {
  const cached = remoteSchemaCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_CACHE_TTL_MS) return cached.schema;
  const request = fetchSchemaUncached(url, fetcher);
  // Re-inserting keeps the Map ordered oldest-first for the size cap below.
  remoteSchemaCache.delete(url);
  remoteSchemaCache.set(url, { fetchedAt: Date.now(), schema: request });
  for (const key of remoteSchemaCache.keys()) {
    if (remoteSchemaCache.size <= SCHEMA_CACHE_LIMIT) break;
    remoteSchemaCache.delete(key);
  }
  try {
    return await request;
  } catch (error) {
    if (remoteSchemaCache.get(url)?.schema === request) remoteSchemaCache.delete(url);
    throw error;
  }
}

async function fetchSchemaUncached(url: string, fetcher: typeof fetch): Promise<JsonSchema> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetcher(url, {
      headers: { Accept: "application/schema+json, application/json" },
      // The allowlist applies to the actual request, not just the first URL.
      // Refusing redirects prevents an allowlisted URL from bouncing to an
      // arbitrary host while a project is being opened.
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await readLimitedUtf8Response(response, {
      maxBytes: SCHEMA_MAX_BYTES,
      overflow: "reject",
      tooLargeMessage: "Schema 超过 2 MiB",
      invalidUtf8Message: "Schema 不是有效的 UTF-8 编码",
    });
    return JSON.parse(text.replace(/^\uFEFF/, "")) as JsonSchema;
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

/** Names the host in a warning without echoing a possibly huge URL back to the UI. */
function describeHost(schemaRef: string): string {
  try {
    return new URL(schemaRef).host || schemaRef.slice(0, 80);
  } catch {
    return schemaRef.slice(0, 80);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}
