import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ConfigFile,
  ConfigFormSchema,
  FieldSpec,
  FieldType,
} from "../../../shared/schema.ts";
import { inferSchemaWithAI } from "../ai/infer.ts";
import type { AIProvider } from "../ai/provider.ts";
import { KNOWN_TEMPLATES } from "./known.ts";

export interface InferOptions {
  ai?: AIProvider;
  aiModel?: string;
  /** Optional README context to feed the AI tier. */
  readme?: string;
  /** Fetch remote $schema URLs (default false = offline). */
  fetchRemoteSchema?: boolean;
}

/** Strip JSONC comments so .jsonc files parse. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function parseLoose(text: string): unknown {
  return JSON.parse(stripComments(text));
}

function humanize(s: string): string {
  return s
    .replace(/[_\-\.]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Recursively build heuristic FieldSpec[] from a parsed JSON value. */
function heuristicFields(value: unknown, prefix: string): FieldSpec[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const out: FieldSpec[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    out.push(fieldFromValue(k, path, v));
  }
  return out;
}

function fieldFromValue(label: string, path: string, v: unknown): FieldSpec {
  const base: Omit<FieldSpec, "type"> = { path, label: humanize(label), value: v, source: "heuristic" };
  if (v === null) return { ...base, type: "string" };
  if (Array.isArray(v)) {
    return {
      ...base,
      type: "array",
      items: v[0] !== undefined ? fieldFromValue("item", `${path}[]`, v[0]) : undefined,
    };
  }
  if (typeof v === "object") {
    return { ...base, type: "object", properties: heuristicFields(v, path) };
  }
  if (typeof v === "number")
    return { ...base, type: Number.isInteger(v) ? "integer" : "number" };
  if (typeof v === "boolean") return { ...base, type: "boolean" };
  if (typeof v === "string") {
    if (/password|secret|token|api[_-]?key|apikey/i.test(label))
      return { ...base, type: "secret", secret: true };
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return { ...base, type: "color" };
    return { ...base, type: "string" };
  }
  return { ...base, type: "json" };
}

/** Try to locate a JSON Schema for this config file. */
async function findJsonSchema(
  absPath: string,
  json: any
): Promise<Record<string, any> | null> {
  // Inline $schema (remote) - skip fetching unless explicitly enabled.
  if (typeof json?.$schema === "string" && json.$schema.startsWith("http")) {
    // Reserved for a future online mode.
  }
  // Sibling schema.json
  try {
    const sibling = join(dirname(absPath), "schema.json");
    return JSON.parse(await readFile(sibling, "utf8"));
  } catch {}
  return null;
}

function jsonTypeToFieldType(
  t: string | undefined,
  en: unknown[] | undefined,
  label: string
): FieldType {
  if (Array.isArray(en) && en.length) return "enum";
  switch (t) {
    case "string":
      return /password|secret|token|api[_-]?key/i.test(label) ? "secret" : "string";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    case "array":
      return "array";
    default:
      return "json";
  }
}

function fieldsFromJsonSchema(
  schema: Record<string, any>,
  value: unknown,
  prefix = ""
): FieldSpec[] {
  const props = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const out: FieldSpec[] = [];
  for (const [k, sub] of Object.entries(props) as [string, any][]) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v =
      value && typeof value === "object" ? (value as any)[k] : undefined;
    out.push(fieldFromJsonSchema(k, path, sub, v, required.has(k)));
  }
  return out;
}

function fieldFromJsonSchema(
  label: string,
  path: string,
  sub: any,
  v: unknown,
  required: boolean
): FieldSpec {
  const type = jsonTypeToFieldType(sub?.type, sub?.enum, label);
  const f: FieldSpec = {
    path,
    label: sub?.title ?? humanize(label),
    description: sub?.description,
    type,
    required,
    default: sub?.default,
    value: v,
    enum: sub?.enum,
    minimum: sub?.minimum,
    maximum: sub?.maximum,
    group: sub?.group,
    source: "json-schema",
  };
  if (/password|secret|token|api[_-]?key/i.test(label) || sub?.secret) {
    f.secret = true;
    f.type = "secret";
  }
  if (type === "object" && sub?.properties)
    f.properties = fieldsFromJsonSchema(sub, v, path);
  if (type === "array" && sub?.items)
    f.items = fieldFromJsonSchema(
      "item",
      `${path}[]`,
      sub.items,
      Array.isArray(v) ? v[0] : undefined,
      false
    );
  return f;
}

/**
 * The 3-tier inference engine:
 *   1) JSON Schema (most accurate)
 *   2) Known config templates (tsconfig, eslint, package.json, ...)
 *   3) Heuristics, optionally enriched by AI
 */
export async function inferSchema(
  file: ConfigFile,
  options: InferOptions = {}
): Promise<ConfigFormSchema> {
  const text = await readFile(file.absPath, "utf8");
  let json: unknown;
  try {
    json = parseLoose(text);
  } catch {
    return {
      file: file.path,
      kind: file.kind,
      fields: [],
      source: "heuristic",
      writable: false,
    };
  }

  // Tier 1: JSON Schema
  const js = await findJsonSchema(file.absPath, json as any);
  if (js) {
    const fields = fieldsFromJsonSchema(js, json);
    if (fields.length)
      return { file: file.path, kind: file.kind, fields, source: "json-schema", writable: true };
  }

  // Tier 2: known templates
  const tmpl = KNOWN_TEMPLATES[file.kind];
  if (tmpl) {
    const fields = tmpl(json);
    if (fields.length)
      return { file: file.path, kind: file.kind, fields, source: "known-template", writable: true };
  }

  // Tier 3a: heuristic (offline fallback)
  const heuristic = heuristicFields(json, "");

  // Tier 3b: AI enrichment
  if (options.ai) {
    try {
      return await inferSchemaWithAI(
        file,
        text,
        options.readme ?? "",
        options.ai,
        options.aiModel
      );
    } catch {
      // fall back to heuristic on AI failure
    }
  }

  return {
    file: file.path,
    kind: file.kind,
    fields: heuristic,
    source: "heuristic",
    writable: true,
  };
}
