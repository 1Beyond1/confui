import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ConfigFile,
  ConfigFormSchema,
  ConfigFormat,
  FieldSpec,
  FieldType,
} from "../../../shared/schema.ts";
import { parseConfig } from "../formats.ts";
import { inferSchemaWithAI } from "../ai/infer.ts";
import type { AIProvider } from "../ai/provider.ts";
import { KNOWN_TEMPLATES } from "./known.ts";
import { inferFromExample } from "./examples.ts";
import { getReadmeFields } from "./readme.ts";

export interface InferOptions {
  ai?: AIProvider;
  aiModel?: string;
  /** Project root (for README lookup). */
  projectRoot?: string;
  /** GitHub URL (for README fallback). */
  githubUrl?: string;
}

const PRIORITY: Record<string, number> = {
  "json-schema": 5,
  "known-template": 4,
  "example": 3,
  "readme": 2,
  "ai": 1,
  "heuristic": 0,
};

/**
 * 5-tier inference engine with per-field merge.
 * All tiers run; each only contributes fields not covered by higher tiers.
 */
export async function inferSchema(
  file: ConfigFile,
  options: InferOptions = {}
): Promise<ConfigFormSchema> {
  const format = (file as any).format || "json";
  const text = await readFile(file.absPath, "utf8");

  let parsed: unknown;
  try {
    parsed = parseConfig(text, format);
  } catch {
    return { file: file.path, kind: file.kind, fields: [], source: "heuristic", format, writable: false };
  }

  // Collect fields from all tiers
  const tierFields: Record<string, FieldSpec[]> = {};

  // Tier 1: JSON Schema
  const js = await findJsonSchema(file.absPath, parsed);
  if (js) tierFields["json-schema"] = fieldsFromJsonSchema(js, parsed);

  // Tier 2: Known templates
  const tmpl = KNOWN_TEMPLATES[file.kind];
  if (tmpl) tierFields["known-template"] = tmpl(parsed);

  // Tier 3: Example files
  try {
    const exFields = await inferFromExample(file, format);
    if (exFields.length) tierFields["example"] = exFields;
  } catch {}

  // Tier 4: README
  if (options.projectRoot) {
    try {
      const readmeResult = await getReadmeFields(options.projectRoot, options.githubUrl);
      if (readmeResult && readmeResult.fields.length) tierFields["readme"] = readmeResult.fields;
    } catch {}
  }

  // Tier 5a: Heuristic (always available as baseline)
  tierFields["heuristic"] = heuristicFields(parsed, "");

  // Tier 5b: AI (enriches fields not covered by above)
  if (options.ai) {
    try {
      const readmeText = tierFields["readme"] ? "" : ""; // readme already parsed
      const aiSchema = await inferSchemaWithAI(file, text, "", options.ai, options.aiModel);
      if (aiSchema.fields.length) tierFields["ai"] = aiSchema.fields;
    } catch {}
  }

  // Merge: per-field, highest priority wins
  const merged = mergeFields(tierFields);

  // Determine primary source (highest priority tier that contributed)
  const source = Object.keys(tierFields)
    .sort((a, b) => PRIORITY[b] - PRIORITY[a])[0] as any || "heuristic";

  return {
    file: file.path,
    kind: file.kind,
    fields: merged,
    source,
    format,
    writable: true,
  };
}

/** Merge fields from all tiers. Higher priority wins; lower tiers fill gaps. */
function mergeFields(tiers: Record<string, FieldSpec[]>): FieldSpec[] {
  const byPath = new Map<string, FieldSpec>();
  const sortedTiers = Object.entries(tiers).sort(
    ([a], [b]) => PRIORITY[b] - PRIORITY[a]
  );

  for (const [, fields] of sortedTiers) {
    for (const f of fields) {
      if (!byPath.has(f.path)) {
        byPath.set(f.path, f);
      }
    }
  }

  return Array.from(byPath.values());
}

// --- JSON Schema helpers (unchanged from before) ---

async function findJsonSchema(absPath: string, json: any): Promise<Record<string, any> | null> {
  if (typeof json?.$schema === "string" && json.$schema.startsWith("http")) {
    // Reserved for future online fetch.
  }
  try {
    const sibling = join(dirname(absPath), "schema.json");
    return JSON.parse(await readFile(sibling, "utf8"));
  } catch {}
  return null;
}

function fieldsFromJsonSchema(schema: Record<string, any>, value: unknown, prefix = ""): FieldSpec[] {
  const props = schema.properties ?? {};
  const required = new Set<string>(schema.required ?? []);
  const out: FieldSpec[] = [];
  for (const [k, sub] of Object.entries(props) as [string, any][]) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = value && typeof value === "object" ? (value as any)[k] : undefined;
    out.push(fieldFromJsonSchema(k, path, sub, v, required.has(k)));
  }
  return out;
}

function fieldFromJsonSchema(label: string, path: string, sub: any, v: unknown, required: boolean): FieldSpec {
  const type = jsonTypeToFieldType(sub?.type, sub?.enum, label);
  const f: FieldSpec = {
    path, label: sub?.title ?? humanize(label), description: sub?.description,
    type, required, default: sub?.default, value: v, enum: sub?.enum,
    minimum: sub?.minimum, maximum: sub?.maximum, group: sub?.group, source: "json-schema",
  };
  if (/password|secret|token|api[_-]?key/i.test(label) || sub?.secret) { f.secret = true; f.type = "secret"; }
  if (type === "object" && sub?.properties) f.properties = fieldsFromJsonSchema(sub, v, path);
  if (type === "array" && sub?.items) f.items = fieldFromJsonSchema("item", `${path}[]`, sub.items, Array.isArray(v) ? v[0] : undefined, false);
  return f;
}

function jsonTypeToFieldType(t: string | undefined, en: unknown[] | undefined, label: string): FieldType {
  if (Array.isArray(en) && en.length) return "enum";
  switch (t) {
    case "string": return /password|secret|token|api[_-]?key/i.test(label) ? "secret" : "string";
    case "integer": return "integer";
    case "number": return "number";
    case "boolean": return "boolean";
    case "object": return "object";
    case "array": return "array";
    default: return "json";
  }
}

// --- Heuristic helpers ---

function humanize(s: string): string {
  return s.replace(/[_\-\.]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

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
  if (Array.isArray(v)) return { ...base, type: "array", items: v[0] !== undefined ? fieldFromValue("item", `${path}[]`, v[0]) : undefined };
  if (typeof v === "object") return { ...base, type: "object", properties: heuristicFields(v, path) };
  if (typeof v === "number") return { ...base, type: Number.isInteger(v) ? "integer" : "number" };
  if (typeof v === "boolean") return { ...base, type: "boolean" };
  if (typeof v === "string") {
    if (/password|secret|token|api[_-]?key/i.test(label)) return { ...base, type: "secret", secret: true };
    if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return { ...base, type: "color" };
    return { ...base, type: "string" };
  }
  return { ...base, type: "json" };
}
