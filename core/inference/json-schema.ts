import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ConfigFormat,
  FieldSource,
  FieldType,
  ItemFieldSpec,
  Locale,
  PathSegment,
  SchemaStoreOrigin,
} from "../../shared/schema.ts";
import { isForbiddenKey } from "../../shared/validation.ts";
import { stripBom } from "../formats/common.ts";
import { ensurePathInsideProject, getAtPath } from "../paths.ts";
import { groupForPath, humanize, isSecretPath } from "./common.ts";
import { readLimitedUtf8File, readLimitedUtf8Response } from "./limited-text.ts";
import {
  matchSchemaStoreEntry,
  readCachedSchemaStore,
  writeCachedSchemaStore,
} from "./schemastore.ts";
import type { FieldCandidate } from "./types.ts";

export interface InferJsonSchemaOptions {
  format?: ConfigFormat;
  rawText?: string;
  /** Project-relative file path used for opt-in offline SchemaStore catalog lookup. */
  relativeFile?: string;
  /** Strictly opt-in (default false): allows fetching matched SchemaStore URLs over HTTPS allowlist. */
  enableSchemaStore?: boolean;
  /** Directory for 7-day local disk caching of opt-in SchemaStore schemas. */
  schemaStoreCacheDir?: string;
  locale?: Locale;
}

interface SchemaResult {
  fields: FieldCandidate[];
  warnings: string[];
  truncated: boolean;
  schemaStore?: SchemaStoreOrigin;
}

type JsonSchema = Record<string, unknown>;
interface SchemaTraversalState {
  value: number;
  truncated: boolean;
}

interface SchemaResolutionContext {
  steps: number;
  truncated: boolean;
  refCache: Map<string, JsonSchema>;
}

interface CycleTracker {
  hitCycle: boolean;
  hitDepthLimit: boolean;
}

interface ResolvedSchemaDocument {
  schema: JsonSchema;
  source: Extract<FieldSource, "json-schema" | "schemastore">;
  detail: string;
  schemaStore?: SchemaStoreOrigin;
}

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
const MAX_SCHEMA_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_SCHEMA_FIELDS = 6_000;
const MAX_SCHEMA_ENUM_VALUES = 100;
const MAX_SCHEMA_TEXT_CHARS = 500;
const MAX_SCHEMA_DEFAULT_CHARS = 4_000;
const MAX_SCHEMA_RESOLUTION_DEPTH = 32;
const MAX_RESOLUTION_STEPS = 4_096;
const MAX_ITEM_FIELDS = 64;
const MAX_ITEM_FIELD_DEPTH = 2;
const DIRECTIVE_SCAN_LINES = 40;

const YAML_SCHEMA_DIRECTIVE_RE = /^\s*#\s*yaml-language-server\s*:\s*\$schema\s*=\s*([^\s#]+)/i;
const TOML_SCHEMA_DIRECTIVE_RE = /^\s*#:\s*schema(?:\s+|=)\s*([^\s#]+)/i;

const remoteSchemaCache = new Map<string, { fetchedAt: number; schema: Promise<JsonSchema> }>();

/** Clears the in-memory remote schema cache (primarily useful for deterministic tests). */
export function clearRemoteSchemaCache(): void {
  remoteSchemaCache.clear();
}

/**
 * Extracts a `$schema` comment directive from YAML (`# yaml-language-server: $schema=...`)
 * or TOML (`#:schema ...`) source text.
 */
export function extractSchemaDirective(rawText: string, format?: ConfigFormat): string | undefined {
  if (!rawText || (format !== "yaml" && format !== "toml")) return undefined;
  const pattern = format === "yaml" ? YAML_SCHEMA_DIRECTIVE_RE : TOML_SCHEMA_DIRECTIVE_RE;
  const lines = stripBom(rawText).split(/\r?\n/);
  const limit = Math.min(lines.length, DIRECTIVE_SCAN_LINES);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed === "---") continue;
    if (trimmed.startsWith("#")) {
      const match = line.match(pattern);
      if (match?.[1]) {
        return unquoteDirectiveTarget(match[1]);
      }
      continue;
    }
    // Stop scanning once actual config content begins.
    break;
  }
  return undefined;
}

function unquoteDirectiveTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  const unquoted = (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  return unquoted || undefined;
}

export async function inferJsonSchemaFields(
  filePath: string,
  projectRoot: string,
  value: unknown,
  fetcher: typeof fetch = fetch,
  options: InferJsonSchemaOptions = {},
): Promise<SchemaResult> {
  const warnings: string[] = [];
  const resolved = await findSchema(filePath, projectRoot, value, warnings, fetcher, options);
  if (!resolved) return { fields: [], warnings, truncated: false };
  try {
    const state: SchemaTraversalState = { value: 0, truncated: false };
    const resolutionCtx: SchemaResolutionContext = {
      steps: 0,
      truncated: false,
      refCache: new Map<string, JsonSchema>(),
    };
    const fields = fieldsFromSchema(
      resolved.schema,
      resolved.schema,
      value,
      [],
      state,
      undefined,
      resolved.source,
      resolved.detail,
      resolutionCtx,
    );
    return {
      fields,
      warnings,
      truncated: state.truncated || resolutionCtx.truncated,
      schemaStore: resolved.schemaStore,
    };
  } catch (error) {
    warnings.push(`JSON Schema 解析失败：${error instanceof Error ? error.message : String(error)}`);
    return { fields: [], warnings, truncated: false };
  }
}

async function findSchema(
  filePath: string,
  projectRoot: string,
  value: unknown,
  warnings: string[],
  fetcher: typeof fetch,
  options: InferJsonSchemaOptions,
): Promise<ResolvedSchemaDocument | undefined> {
  const isEn = options.locale === "en-US";
  const inlineSchemaRef = value !== null && typeof value === "object"
    ? (value as Record<string, unknown>).$schema
    : undefined;
  const directiveRef = typeof inlineSchemaRef === "string"
    ? undefined
    : extractSchemaDirective(options.rawText ?? "", options.format);
  const schemaRef = typeof inlineSchemaRef === "string" ? inlineSchemaRef : directiveRef;

  if (typeof schemaRef === "string" && schemaRef.trim()) {
    try {
      if (/^https?:\/\//i.test(schemaRef)) {
        const target = allowedSchemaUrl(schemaRef);
        if (target) {
          const schema = await fetchSchema(target, fetcher);
          return {
            schema,
            source: "json-schema",
            detail: isEn ? "From project-declared JSON Schema" : "来自项目声明的 JSON Schema",
          };
        }
        // Fall through to the conventional local schema files below.
        warnings.push(`配置声明的 JSON Schema 来自未授信的地址，已跳过：${describeHost(schemaRef)}`);
      } else {
        const candidate = schemaRef.startsWith("file:")
          ? fileURLToPath(schemaRef)
          : resolve(dirname(filePath), schemaRef);
        const schema = await readSchema(candidate, projectRoot);
        return {
          schema,
          source: "json-schema",
          detail: isEn ? "From project-declared JSON Schema" : "来自项目声明的 JSON Schema",
        };
      }
    } catch (error) {
      warnings.push(`未能读取配置声明的 JSON Schema：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const extension = extname(filePath);
  const stem = filePath.slice(0, extension ? -extension.length : undefined);
  for (const candidate of [`${stem}.schema.json`, join(dirname(filePath), "schema.json")]) {
    try {
      const schema = await readSchema(candidate, projectRoot);
      return {
        schema,
        source: "json-schema",
        detail: isEn ? "From local project JSON Schema" : "来自项目本地 JSON Schema",
      };
    } catch {
      // Missing conventional schema files are expected.
    }
  }

  // Strictly opt-in SchemaStore lookup (default OFF for offline & privacy safety).
  if (options.enableSchemaStore === true) {
    const relPath = options.relativeFile ?? relative(projectRoot, filePath).replace(/\\/g, "/");
    const match = matchSchemaStoreEntry(relPath);
    if (match) {
      const target = allowedSchemaUrl(match.url);
      if (target) {
        try {
          if (options.schemaStoreCacheDir) {
            const cached = await readCachedSchemaStore(options.schemaStoreCacheDir, target);
            if (cached) {
              return {
                schema: cached,
                source: "schemastore",
                detail: isEn
                  ? `From SchemaStore (${match.name}, cached)`
                  : `来自 SchemaStore 映射（${match.name} · 本地缓存）`,
                schemaStore: { name: match.name, url: target, fromCache: true },
              };
            }
          }
          const schema = await fetchSchema(target, fetcher);
          if (options.schemaStoreCacheDir) {
            await writeCachedSchemaStore(options.schemaStoreCacheDir, target, schema);
          }
          return {
            schema,
            source: "schemastore",
            detail: isEn
              ? `From SchemaStore (${match.name})`
              : `来自 SchemaStore 远程映射（${match.name}）`,
            schemaStore: { name: match.name, url: target, fromCache: false },
          };
        } catch (error) {
          warnings.push(
            isEn
              ? `SchemaStore lookup failed (${match.name}): ${error instanceof Error ? error.message : String(error)}`
              : `未能拉取 SchemaStore（${match.name}）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
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
  return parseSchemaDocument(text);
}

function parseSchemaDocument(text: string): JsonSchema {
  const parsed: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (!isRecord(parsed)) {
    throw new Error("Schema 根节点必须是 JSON 对象");
  }
  return parsed;
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
  // Query strings and fragments are project-controlled data too. Refusing them
  // prevents a schema reference from smuggling tokens, tracking IDs, or other
  // unrelated values to an otherwise trusted host. A non-default port would
  // also turn the host allowlist into an arbitrary service-port allowlist.
  if (url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) return undefined;
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
    let currentUrl = url;
    for (let redirects = 0; redirects <= MAX_SCHEMA_REDIRECTS; redirects += 1) {
      const response = await fetcher(currentUrl, {
        headers: { Accept: "application/schema+json, application/json" },
        // Follow redirects manually so every hop is re-validated against the
        // HTTPS + host allowlist before any outbound request is issued.
        redirect: "manual",
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= MAX_SCHEMA_REDIRECTS) {
          throw new Error("Schema 重定向次数过多");
        }
        const location = response.headers.get("location");
        if (!location) {
          throw new Error(`HTTP ${response.status}`);
        }
        let resolvedNext: string;
        try {
          resolvedNext = new URL(location, currentUrl).href;
        } catch {
          throw new Error("Schema 重定向地址无效");
        }
        const nextAllowed = allowedSchemaUrl(resolvedNext);
        if (!nextAllowed) {
          throw new Error(`Schema 重定向到未授信的地址：${describeHost(resolvedNext)}`);
        }
        currentUrl = nextAllowed;
        continue;
      }
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
      return parseSchemaDocument(text);
    }
    throw new Error("Schema 重定向次数过多");
  } finally {
    clearTimeout(timeout);
  }
}

function fieldsFromSchema(
  schemaInput: JsonSchema,
  rootSchema: JsonSchema,
  value: unknown,
  prefix: PathSegment[] = [],
  order: SchemaTraversalState = { value: 0, truncated: false },
  groupHint?: string,
  source: Extract<FieldSource, "json-schema" | "schemastore"> = "json-schema",
  detail = "来自项目声明的 JSON Schema",
  resolutionCtx: SchemaResolutionContext = { steps: 0, truncated: false, refCache: new Map() },
): FieldCandidate[] {
  if (order.truncated || resolutionCtx.truncated) return [];
  const schema = resolveSchema(schemaInput, rootSchema, resolutionCtx);
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  const fields: FieldCandidate[] = [];

  for (const [key, rawChild] of Object.entries(properties)) {
    if (order.value >= MAX_SCHEMA_FIELDS || resolutionCtx.truncated) {
      order.truncated = true;
      break;
    }
    if (!key || isForbiddenKey(key) || !isRecord(rawChild)) continue;
    const child = resolveSchema(rawChild, rootSchema, resolutionCtx);
    const segments = [...prefix, key];
    const current = getAtPath(value, segments);
    const type = schemaType(child, key, current);
    const childProperties = isRecord(child.properties) ? child.properties : undefined;
    // An object schema with no declared properties still represents an editable
    // JSON object (usually via additionalProperties). Only recurse when there
    // is something to expand; otherwise an empty `properties: {}` would make
    // the field disappear from the form entirely.
    if (type === "json" && childProperties && Object.keys(childProperties).length > 0 && segments.length <= 3) {
      fields.push(...fieldsFromSchema(
        child,
        rootSchema,
        value,
        segments,
        order,
        typeof child.title === "string" ? child.title : humanize(key),
        source,
        detail,
        resolutionCtx,
      ));
      continue;
    }
    const enumValues = Array.isArray(child.enum)
      ? child.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .slice(0, MAX_SCHEMA_ENUM_VALUES)
      : (typeof child.const === "string" || typeof child.const === "number")
        ? [child.const]
        : undefined;
    const secret = isSecretPath(segments) || child.writeOnly === true || child.format === "password";
    const defaultValue = child.default !== undefined ? child.default : child.const;
    const itemFields = type === "array"
      ? extractItemFieldsFromArraySchema(child, rootSchema, 0, resolutionCtx)
      : undefined;
    fields.push({
      segments,
      label: boundedText(child.title, MAX_SCHEMA_TEXT_CHARS) ?? humanize(key),
      description: boundedText(child.description, MAX_SCHEMA_TEXT_CHARS),
      type: secret ? "secret" : enumValues?.length ? "enum" : type,
      required: required.has(key),
      default: safeSchemaValue(defaultValue),
      enum: enumValues?.length ? enumValues : undefined,
      minimum: asNumber(child.minimum),
      maximum: asNumber(child.maximum),
      minLength: asNumber(child.minLength),
      maxLength: asNumber(child.maxLength),
      pattern: boundedText(child.pattern, MAX_SCHEMA_TEXT_CHARS),
      placeholder: typeof child.examples === "object" && Array.isArray(child.examples) && child.examples.length
        ? String(child.examples[0] ?? "").slice(0, MAX_SCHEMA_TEXT_CHARS)
        : undefined,
      secret,
      group: groupHint ?? groupForPath(segments),
      itemFields: itemFields?.length ? itemFields : undefined,
      source,
      confidence: source === "schemastore" ? 0.96 : 0.995,
      detail,
      order: order.value++,
    });
  }
  return fields;
}

/**
 * Extracts `ItemFieldSpec[]` from an array schema's `items` definition (including
 * `$ref`, `allOf`, and object-shaped `oneOf` / `anyOf` unions such as `launch.json`
 * `configurations[]` or GitHub Actions `steps[]`).
 */
function extractItemFieldsFromArraySchema(
  arraySchema: JsonSchema,
  rootSchema: JsonSchema,
  depth: number,
  resolutionCtx: SchemaResolutionContext,
): ItemFieldSpec[] | undefined {
  if (depth >= MAX_ITEM_FIELD_DEPTH || resolutionCtx.truncated) return undefined;
  const rawItems = arraySchema.items;
  if (!isRecord(rawItems)) return undefined;
  const resolvedItems = resolveSchema(rawItems, rootSchema, resolutionCtx);
  const objectSchema = extractObjectItemSchema(resolvedItems, rootSchema, resolutionCtx);
  if (!objectSchema || !isRecord(objectSchema.properties)) return undefined;

  const requiredSet = new Set(
    Array.isArray(objectSchema.required)
      ? objectSchema.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const specs: ItemFieldSpec[] = [];
  for (const [propKey, rawProp] of Object.entries(objectSchema.properties)) {
    if (specs.length >= MAX_ITEM_FIELDS || resolutionCtx.truncated) break;
    if (!propKey || isForbiddenKey(propKey) || !isRecord(rawProp)) continue;
    const prop = resolveSchema(rawProp, rootSchema, resolutionCtx);
    const propType = schemaType(prop, propKey, undefined);
    const enumValues = Array.isArray(prop.enum)
      ? prop.enum.filter((item): item is string | number => typeof item === "string" || typeof item === "number")
        .slice(0, MAX_SCHEMA_ENUM_VALUES)
      : (typeof prop.const === "string" || typeof prop.const === "number")
        ? [prop.const]
        : undefined;
    const secret = isSecretPath([propKey]) || prop.writeOnly === true || prop.format === "password";
    const defaultValue = prop.default !== undefined ? prop.default : prop.const;
    const nestedItemFields = propType === "array"
      ? extractItemFieldsFromArraySchema(prop, rootSchema, depth + 1, resolutionCtx)
      : undefined;
    specs.push({
      key: propKey,
      label: boundedText(prop.title, MAX_SCHEMA_TEXT_CHARS) ?? humanize(propKey),
      description: boundedText(prop.description, MAX_SCHEMA_TEXT_CHARS),
      type: secret ? "secret" : enumValues?.length ? "enum" : propType,
      required: requiredSet.has(propKey) || undefined,
      default: safeSchemaValue(defaultValue),
      enum: enumValues?.length ? enumValues : undefined,
      minimum: asNumber(prop.minimum),
      maximum: asNumber(prop.maximum),
      minLength: asNumber(prop.minLength),
      maxLength: asNumber(prop.maxLength),
      pattern: boundedText(prop.pattern, MAX_SCHEMA_TEXT_CHARS),
      placeholder: typeof prop.examples === "object" && Array.isArray(prop.examples) && prop.examples.length
        ? String(prop.examples[0] ?? "").slice(0, MAX_SCHEMA_TEXT_CHARS)
        : undefined,
      secret: secret || undefined,
      itemFields: nestedItemFields?.length ? nestedItemFields : undefined,
    });
  }
  return specs.length ? specs : undefined;
}

function extractObjectItemSchema(
  schema: JsonSchema,
  rootSchema: JsonSchema,
  resolutionCtx: SchemaResolutionContext,
): JsonSchema | undefined {
  if (isRecord(schema.properties) && Object.keys(schema.properties).length > 0) {
    return schema;
  }
  const unionBranches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!unionBranches?.length) return undefined;

  const objectBranches = unionBranches
    .filter(isRecord)
    .map((branch) => resolveSchema(branch, rootSchema, resolutionCtx))
    .filter((branch) => isRecord(branch.properties) && Object.keys(branch.properties).length > 0);
  if (!objectBranches.length) return undefined;

  const mergedProperties: Record<string, unknown> = {};
  const requiredSets = objectBranches.map((branch) =>
    new Set(Array.isArray(branch.required) ? branch.required.filter((r): r is string => typeof r === "string") : []),
  );
  const commonRequired = [...(requiredSets[0] ?? [])].filter((key) =>
    requiredSets.every((set) => set.has(key)),
  );
  for (const branch of objectBranches) {
    for (const [k, v] of Object.entries(branch.properties as Record<string, unknown>)) {
      if (!isForbiddenKey(k) && !(k in mergedProperties)) {
        mergedProperties[k] = v;
      }
    }
  }
  return {
    type: "object",
    properties: mergedProperties,
    required: commonRequired,
  };
}

function resolveSchema(
  schema: JsonSchema,
  root: JsonSchema,
  ctx: SchemaResolutionContext,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
  cycleTracker: CycleTracker = { hitCycle: false, hitDepthLimit: false },
): JsonSchema {
  const needsResolution = typeof schema.$ref === "string"
    || Array.isArray(schema.allOf)
    || Array.isArray(schema.oneOf)
    || Array.isArray(schema.anyOf);
  if (!needsResolution) return schema;
  if (ctx.steps >= MAX_RESOLUTION_STEPS) {
    ctx.truncated = true;
    return schema;
  }
  ctx.steps += 1;
  if (depth > MAX_SCHEMA_RESOLUTION_DEPTH) {
    cycleTracker.hitDepthLimit = true;
    return schema;
  }
  const reference = schema.$ref;
  if (typeof reference !== "string" || !reference.startsWith("#/")) {
    return resolveComposition(schema, root, ctx, visited, depth, cycleTracker);
  }
  const { $ref: _ignoredRef, ...siblings } = schema;
  const hasSiblings = Object.keys(siblings).length > 0;
  if (visited.has(reference)) {
    cycleTracker.hitCycle = true;
    return resolveComposition(siblings, root, ctx, visited, depth + 1, cycleTracker);
  }
  const cached = ctx.refCache.get(reference);
  if (cached !== undefined) {
    if (!hasSiblings) return cached;
    const combined = mergeSchemaObjects(cached, siblings);
    return resolveComposition(combined, root, ctx, visited, depth + 1, cycleTracker);
  }
  const parts = reference.slice(2).split("/").map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || isForbiddenKey(part) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return resolveComposition(siblings, root, ctx, visited, depth + 1, cycleTracker);
    }
    current = current[part];
  }
  if (!isRecord(current)) return resolveComposition(siblings, root, ctx, visited, depth + 1, cycleTracker);
  const nextVisited = new Set(visited);
  nextVisited.add(reference);
  const targetTracker: CycleTracker = { hitCycle: false, hitDepthLimit: false };
  const resolvedTarget = resolveSchema(current, root, ctx, nextVisited, depth + 1, targetTracker);
  if (targetTracker.hitCycle) {
    cycleTracker.hitCycle = true;
  }
  if (targetTracker.hitDepthLimit) {
    cycleTracker.hitDepthLimit = true;
  }
  if (!targetTracker.hitCycle && !targetTracker.hitDepthLimit && !ctx.truncated) {
    ctx.refCache.set(reference, resolvedTarget);
  }
  if (!hasSiblings) return resolvedTarget;
  const combined = mergeSchemaObjects(resolvedTarget, siblings);
  return resolveComposition(combined, root, ctx, nextVisited, depth + 1, cycleTracker);
}

function resolveComposition(
  schema: JsonSchema,
  root: JsonSchema,
  ctx: SchemaResolutionContext,
  visited: ReadonlySet<string>,
  depth: number,
  cycleTracker: CycleTracker,
): JsonSchema {
  if (ctx.steps >= MAX_RESOLUTION_STEPS) {
    ctx.truncated = true;
    return schema;
  }
  if (depth > MAX_SCHEMA_RESOLUTION_DEPTH) {
    cycleTracker.hitDepthLimit = true;
    return schema;
  }
  const afterAllOf = mergeAllOf(schema, root, ctx, visited, depth, cycleTracker);
  return mergeOneOrAnyOf(afterAllOf, root, ctx, visited, depth, cycleTracker);
}

function mergeAllOf(
  schema: JsonSchema,
  root: JsonSchema,
  ctx: SchemaResolutionContext,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
  cycleTracker: CycleTracker = { hitCycle: false, hitDepthLimit: false },
): JsonSchema {
  if (depth > MAX_SCHEMA_RESOLUTION_DEPTH) {
    cycleTracker.hitDepthLimit = true;
    return schema;
  }
  if (ctx.truncated) return schema;
  if (!Array.isArray(schema.allOf)) return schema;
  const { allOf, ...rest } = schema;
  let merged: JsonSchema = rest;
  for (const item of allOf) {
    if (ctx.steps >= MAX_RESOLUTION_STEPS) {
      ctx.truncated = true;
      break;
    }
    if (!isRecord(item)) continue;
    const child = resolveSchema(item, root, ctx, visited, depth + 1, cycleTracker);
    merged = mergeSchemaObjects(merged, child);
  }
  return merged;
}

function mergeOneOrAnyOf(
  schema: JsonSchema,
  root: JsonSchema,
  ctx: SchemaResolutionContext,
  visited: ReadonlySet<string>,
  depth: number,
  cycleTracker: CycleTracker,
): JsonSchema {
  if (depth > MAX_SCHEMA_RESOLUTION_DEPTH) {
    cycleTracker.hitDepthLimit = true;
    return schema;
  }
  if (ctx.truncated) return schema;
  const rawBranches = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!rawBranches?.length) return schema;
  const resolvedBranches: JsonSchema[] = [];
  for (const branch of rawBranches) {
    if (ctx.steps >= MAX_RESOLUTION_STEPS) {
      ctx.truncated = true;
      break;
    }
    if (!isRecord(branch)) continue;
    resolvedBranches.push(resolveSchema(branch, root, ctx, visited, depth + 1, cycleTracker));
  }
  if (!resolvedBranches.length) return schema;

  const nonNullBranches = resolvedBranches.filter((branch) => !isNullOnlySchema(branch));
  if (!nonNullBranches.length) return schema;

  const { oneOf: _oneOf, anyOf: _anyOf, ...base } = schema;

  // Nullable or single effective branch: safely unwrap and merge with parent annotations.
  if (nonNullBranches.length === 1) {
    return mergeSchemaObjects(nonNullBranches[0]!, base);
  }

  // All non-null branches enumerate scalar string/number values via `const` or `enum`.
  const collectedEnums: Array<string | number> = [];
  let allScalarEnums = true;
  for (const branch of nonNullBranches) {
    const values = extractScalarEnumValues(branch);
    if (!values) {
      allScalarEnums = false;
      break;
    }
    for (const item of values) {
      if (!collectedEnums.some((existing) => Object.is(existing, item))) {
        collectedEnums.push(item);
      }
    }
  }
  if (allScalarEnums && collectedEnums.length > 0) {
    return {
      ...base,
      enum: collectedEnums.slice(0, MAX_SCHEMA_ENUM_VALUES),
    };
  }

  // All non-null branches share a single basic JSON type (or integer + number -> number).
  const branchTypes = nonNullBranches.map(extractBasicSchemaType);
  if (branchTypes.every((item): item is string => typeof item === "string")) {
    const unique = new Set(branchTypes);
    if (unique.size === 1) {
      const [sharedType] = unique;
      return { type: sharedType, ...base };
    }
    if (unique.size === 2 && unique.has("integer") && unique.has("number")) {
      return { type: "number", ...base };
    }
  }

  return schema;
}

function mergeSchemaObjects(base: JsonSchema, override: JsonSchema): JsonSchema {
  const merged: JsonSchema = { ...base, ...override };
  if (isRecord(base.properties) || isRecord(override.properties)) {
    const mergedProps: Record<string, unknown> = {};
    if (isRecord(base.properties)) {
      for (const [k, v] of Object.entries(base.properties)) {
        if (!isForbiddenKey(k)) mergedProps[k] = v;
      }
    }
    if (isRecord(override.properties)) {
      for (const [k, v] of Object.entries(override.properties)) {
        if (!isForbiddenKey(k)) mergedProps[k] = v;
      }
    }
    merged.properties = mergedProps;
  }
  if (Array.isArray(base.required) || Array.isArray(override.required)) {
    merged.required = [
      ...new Set([
        ...(Array.isArray(base.required) ? base.required : []),
        ...(Array.isArray(override.required) ? override.required : []),
      ]),
    ];
  }
  return merged;
}

function isNullOnlySchema(schema: JsonSchema): boolean {
  if (schema.type === "null") return true;
  if ("const" in schema && schema.const === null) return true;
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((item) => item === null)) return true;
  return false;
}

function extractScalarEnumValues(schema: JsonSchema): Array<string | number> | undefined {
  if ("const" in schema) {
    return typeof schema.const === "string" || typeof schema.const === "number"
      ? [schema.const]
      : undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const nonNull = schema.enum.filter((item) => item !== null);
    if (nonNull.length > 0 && nonNull.every((item): item is string | number => typeof item === "string" || typeof item === "number")) {
      return nonNull;
    }
  }
  return undefined;
}

function extractBasicSchemaType(schema: JsonSchema): string | undefined {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const nonNull = schema.type.filter((item): item is string => typeof item === "string" && item !== "null");
    return nonNull.length === 1 ? nonNull[0] : undefined;
  }
  if ("const" in schema) {
    if (typeof schema.const === "string") return "string";
    if (typeof schema.const === "boolean") return "boolean";
    if (typeof schema.const === "number") return Number.isInteger(schema.const) ? "integer" : "number";
    if (Array.isArray(schema.const)) return "array";
    if (schema.const !== null && typeof schema.const === "object") return "object";
  }
  if (isRecord(schema.properties)) return "object";
  return undefined;
}

function schemaType(schema: JsonSchema, key: string, value: unknown): FieldType {
  if (typeof schema.const === "string" || typeof schema.const === "number") return "enum";
  if (typeof schema.const === "boolean") return "boolean";
  if (Array.isArray(schema.const)) return "array";
  if (schema.const !== null && typeof schema.const === "object") return "json";
  const schemaEnum = Array.isArray(schema.enum) ? schema.enum : [];
  // The editor's enum control only accepts scalar string/number options. Do
  // not turn a boolean/object/null enum into an empty, unusable select.
  if (schemaEnum.length && schemaEnum.every((item) => typeof item === "string" || typeof item === "number")) return "enum";
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
      if (schemaEnum.length && schemaEnum.every((item) => typeof item === "boolean")) return "boolean";
      if (schemaEnum.length && schemaEnum.every((item) => typeof item === "number")) {
        return schemaEnum.every((item) => Number.isInteger(item)) ? "integer" : "number";
      }
      // JSON Schema permits omitting `type` when `properties` is present. The
      // declared shape is stronger evidence than an absent current value.
      if (isRecord(schema.properties)) return "json";
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
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boundedText(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.slice(0, limit) : undefined;
}

function safeSchemaValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    return serialized && serialized.length <= MAX_SCHEMA_DEFAULT_CHARS ? value : undefined;
  } catch {
    return undefined;
  }
}
