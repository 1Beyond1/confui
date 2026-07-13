import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import * as ini from "ini";
import * as properties from "properties";
import type { ConfigFormat } from "../../shared/schema.ts";

/** Parse a config file's text into a JS object based on its format. */
export function parseConfig(text: string, format: ConfigFormat): unknown {
  switch (format) {
    case "json":
    case "jsonc":
      return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"));
    case "yaml":
      return yaml.load(text);
    case "toml":
      return parseToml(text);
    case "env":
      return parseEnv(text);
    case "ini":
      return ini.parse(text);
    case "properties":
      return properties.parse(text);
    default:
      return JSON.parse(text);
  }
}

/** Serialize a JS object back to the config file's format. */
export function stringifyConfig(value: unknown, format: ConfigFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(value, null, 2) + "\n";
    case "yaml":
      return yaml.dump(value, { indent: 2 });
    case "toml":
      return stringifyToml(value as any);
    case "env":
      return stringifyEnv(value as Record<string, unknown>);
    case "ini":
      return ini.stringify(value as any);
    case "properties":
      return properties.stringify(value as any);
    default:
      return JSON.stringify(value, null, 2) + "\n";
  }
}

function parseEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function stringifyEnv(value: Record<string, unknown>): string {
  return Object.entries(value).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
