export type ConfigFormat =
  | "json"
  | "jsonc"
  | "yaml"
  | "toml"
  | "env"
  | "ini"
  | "properties";

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "enum"
  | "secret"
  | "color"
  | "array"
  | "json";

export type FieldSource =
  | "json-schema"
  | "known-template"
  | "example"
  | "readme"
  | "ai"
  | "heuristic";

export type FieldProperty =
  | "label"
  | "description"
  | "type"
  | "required"
  | "default"
  | "enum"
  | "minimum"
  | "maximum"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "placeholder"
  | "secret"
  | "group";

export type PathSegment = string | number;

export interface FieldEvidence {
  property: FieldProperty;
  source: FieldSource;
  confidence: number;
  detail?: string;
}

export interface FieldSpec {
  /** Stable display path. Use `segments` for all reads and writes. */
  path: string;
  segments: PathSegment[];
  label: string;
  description?: string;
  type: FieldType;
  required?: boolean;
  default?: unknown;
  value?: unknown;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  secret?: boolean;
  group?: string;
  source: FieldSource;
  confidence: number;
  evidence: FieldEvidence[];
}

/** Metadata sent when the user explicitly asks the configured AI to explain a field. */
export interface FieldAssistField {
  segments: PathSegment[];
  label: string;
  type: FieldType;
  description?: string;
  required?: boolean;
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  placeholder?: string;
  secret?: boolean;
  group?: string;
}

export interface FieldAssistResult {
  explanation: string;
  recommendation?: string;
  caution?: string;
}

export interface FileVersion {
  mtimeMs: number;
  size: number;
  hash: string;
}

export interface SourceSummary {
  source: FieldSource;
  fieldCount: number;
}

export interface ConfigFormSchema {
  file: string;
  kind: string;
  format: ConfigFormat;
  fields: FieldSpec[];
  sources: SourceSummary[];
  writable: boolean;
  warnings: string[];
  exampleFiles: string[];
  readmeSource?: "local" | "github";
  version: FileVersion;
  rawText: string;
}

export type ConfigFileStatus = "ready" | "large" | "too-large" | "unreadable" | "unsupported";

export interface ConfigFile {
  path: string;
  kind: string;
  size: number;
  modifiedAt: number;
  format: ConfigFormat;
  confidence: "known" | "likely" | "possible";
  status: ConfigFileStatus;
  warning?: string;
}

export interface ProjectScanResult {
  root: string;
  name: string;
  files: ConfigFile[];
  detectedGithubUrl?: string;
  scannedAt: number;
  skippedCount: number;
  warnings: string[];
}

export interface InferOptions {
  githubUrl?: string;
}

export interface ConfigChange {
  segments: PathSegment[];
  value: unknown;
}

export interface SaveChangePreview {
  path: string;
  before: unknown;
  after: unknown;
}

export interface SavePreview {
  /** Canonical project root this preview was generated from. */
  projectRoot: string;
  file: string;
  format: ConfigFormat;
  changes: SaveChangePreview[];
  operations: ConfigChange[];
  output: string;
  warnings: string[];
  expectedVersion: FileVersion;
}

export interface SaveResult {
  file: string;
  version: FileVersion;
  backupPath: string;
}

export interface FileChangedEvent {
  projectRoot?: string;
  file: string;
  version?: FileVersion;
}

export type ThemePreference = "system" | "light" | "dark";

export interface RecentProject {
  path: string;
  name: string;
  githubUrl?: string;
  openedAt: number;
}

/**
 * Which stored credentials exist on disk but could not be decrypted — an OS
 * keychain that is locked or unavailable, or a value encrypted under another
 * user profile. Confui reports those as empty strings so the settings page stays
 * usable, and keeps the ciphertext untouched rather than overwriting it.
 */
export interface LockedSecrets {
  apiKey: boolean;
  githubToken: boolean;
}

/**
 * Redacted status metadata sent to the renderer instead of plaintext secrets.
 * Derived in the main process on every read; renderer-supplied values are ignored.
 */
export interface StoredSecretsMeta {
  hasApiKey: boolean;
  apiKeyHint?: string;
  hasGithubToken: boolean;
  githubTokenHint?: string;
}

export interface SecretClearFlags {
  apiKey?: boolean;
  githubToken?: boolean;
}

export type TestAIRequest = AppSettings["ai"] & {
  useStoredApiKey?: boolean;
};

export interface AppSettings {
  theme: ThemePreference;
  ai: {
    enabled: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
  };
  github: {
    token: string;
  };
  recentProjects: RecentProject[];
  /**
   * Derived in the main process on every read; `normalizeSettings` never emits
   * it, so a value sent by the renderer is discarded rather than trusted.
   */
  lockedSecrets?: LockedSecrets;
  /**
   * Derived in the main process for renderer responses so plaintext credentials
   * never leave the main process.
   */
  secrets?: StoredSecretsMeta;
  /**
   * One-shot intent sent by the renderer when the user explicitly clears a
   * stored credential. Never persisted to disk.
   */
  clearSecrets?: SecretClearFlags;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  ai: {
    enabled: false,
    provider: "custom",
    model: "",
    baseUrl: "",
    apiKey: "",
    timeoutMs: 45_000,
  },
  github: { token: "" },
  recentProjects: [],
};

export type AppErrorCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "PARSE_ERROR"
  | "FILE_TOO_LARGE"
  | "FILE_CONFLICT"
  | "SAVE_ERROR"
  | "NETWORK_ERROR"
  | "AI_ERROR"
  | "UNKNOWN";

export interface AppError {
  code: AppErrorCode;
  message: string;
  detail?: string;
}

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppError };

export interface ConnectionTestResult {
  latencyMs: number;
  message: string;
}

export interface AppInfo {
  version: string;
}

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  releaseName: string;
  releaseUrl: string;
  publishedAt?: string;
}

export interface ConfuiAPI {
  selectFolder(): Promise<Result<string | null>>;
  scanProject(root: string, githubUrl?: string): Promise<Result<ProjectScanResult>>;
  inferSchema(root: string, file: string, options?: InferOptions): Promise<Result<ConfigFormSchema>>;
  explainField(root: string, file: string, field: FieldAssistField, githubUrl?: string): Promise<Result<FieldAssistResult>>;
  previewSave(root: string, file: string, changes: ConfigChange[], expectedVersion: FileVersion): Promise<Result<SavePreview>>;
  saveConfig(root: string, preview: SavePreview): Promise<Result<SaveResult>>;
  getSettings(): Promise<Result<AppSettings>>;
  setSettings(settings: AppSettings): Promise<Result<AppSettings>>;
  testAI(settings: TestAIRequest): Promise<Result<ConnectionTestResult>>;
  getAppInfo(): Promise<Result<AppInfo>>;
  checkForUpdates(): Promise<Result<UpdateCheckResult>>;
  openReleasePage(): Promise<Result<null>>;
  setDirtyState(dirty: boolean): void;
  stopWatching(): void;
  onFileChanged(callback: (event: FileChangedEvent) => void): () => void;
}
