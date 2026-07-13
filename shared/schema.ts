/**
 * Form Schema — the shared contract between server (inference) and web (rendering).
 * One source of truth, imported by both. This is the heart of easy_json.
 */

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "secret"
  | "color"
  | "object"
  | "array"
  | "json";

export type FieldSource =
  | "json-schema"
  | "known-template"
  | "heuristic"
  | "ai";

/** A single configurable field. */
export interface FieldSpec {
  /** Dotted path in the JSON, e.g. "server.port" or "db[0].host". */
  path: string;
  /** Human-readable label, e.g. "Server Port". */
  label: string;
  /** Help text sourced from schema / README / AI. */
  description?: string;
  /** Controls the UI widget. */
  type: FieldType;
  required?: boolean;
  default?: unknown;
  /** Current value read from the file. */
  value?: unknown;
  /** Options for enum widgets. */
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  placeholder?: string;
  /** Render as password. */
  secret?: boolean;
  /** Nested fields when type === "object". */
  properties?: FieldSpec[];
  /** Item template when type === "array". */
  items?: FieldSpec;
  /** UI grouping / section. */
  group?: string;
  /** How this spec was derived. */
  source?: FieldSource;
}

/** Inferred schema for one config file. */
export interface ConfigFormSchema {
  /** Relative path within the project. */
  file: string;
  /** Detected kind, e.g. "package.json", "tsconfig.json", "json". */
  kind: string;
  fields: FieldSpec[];
  source: FieldSource;
  writable: boolean;
}

/** A discovered config file (pre-inference). */
export interface ConfigFile {
  path: string;
  absPath: string;
  kind: string;
  size: number;
}

/** Persisted app settings. */
export interface AppSettings {
  ai: {
    enabled: boolean;
    /** Active provider id. */
    provider: string;
    model: string;
    /** Custom OpenAI-compatible base URL. Empty = official OpenAI. */
    baseUrl: string;
    apiKey: string;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    enabled: true,
    provider: "openai-compatible",
    model: "gpt-4o-mini",
    baseUrl: "",
    apiKey: "",
  },
};
