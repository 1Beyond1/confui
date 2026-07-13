import { readFile, stat } from "node:fs/promises";
import { dirname, join, basename } from "node:path";
import { parseConfig } from "../formats.ts";
import type { ConfigFile, ConfigFormat, FieldSpec } from "../../../shared/schema.ts";

const SUFFIXES = [".example", ".template", ".sample", ".dist"];

/** Find an example file matching the given config file. */
export async function findExampleFile(absPath: string): Promise<string | null> {
  const dir = dirname(absPath);
  const base = basename(absPath);
  const candidates: string[] = [];
  for (const suf of SUFFIXES) candidates.push(`${base}${suf}`);
  // .env special: .env -> .env.example
  if (base === ".env" || base.startsWith(".env.")) candidates.push(".env.example");
  // base without extension + .example
  const baseNoExt = base.replace(/\.[^.]+$/, "");
  for (const suf of SUFFIXES) candidates.push(`${baseNoExt}${suf}`);

  for (const c of candidates) {
    try { await stat(join(dir, c)); return join(dir, c); } catch {}
  }
  return null;
}

/** Infer field specs from an example/template file. */
export async function inferFromExample(
  configFile: ConfigFile,
  format: ConfigFormat
): Promise<FieldSpec[]> {
  const examplePath = await findExampleFile(configFile.absPath);
  if (!examplePath) return [];

  const text = await readFile(examplePath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseConfig(text, format);
  } catch {
    try { parsed = JSON.parse(text); } catch { return []; }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];

  const fields: FieldSpec[] = [];
  const obj = parsed as Record<string, unknown>;
  for (const [key, value] of Object.entries(obj)) {
    const isPlaceholder =
      typeof value === "string" &&
      /^<.+>|^\$\{|YOUR_|CHANGE_ME|REPLACE|EXAMPLE/i.test(value);
    fields.push({
      path: key,
      label: humanize(key),
      value: isPlaceholder ? undefined : value,
      default: isPlaceholder ? undefined : value,
      required: isPlaceholder,
      type: inferType(key, value),
      source: "example",
    });
  }
  return fields;
}

function humanize(s: string): string {
  return s.replace(/[_\-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function inferType(key: string, v: unknown): FieldSpec["type"] {
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "string") {
    if (/password|secret|token|api[_-]?key/i.test(key)) return "secret";
    return "string";
  }
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "string";
}
