import type { AppSettings, ConfigFormat, ThemePreference } from "../../../shared/schema.ts";

export const FORMAT_LABELS: Record<ConfigFormat, string> = {
  json: "JSON",
  jsonc: "JSONC",
  yaml: "YAML",
  toml: "TOML",
  env: "ENV",
  ini: "INI",
  properties: "PROPERTIES",
};

// Keep file badges short without slicing words (JSON must not become "JSO").
export const FORMAT_SHORT_LABELS: Record<ConfigFormat, string> = {
  json: "JSON",
  jsonc: "JSONC",
  yaml: "YAML",
  toml: "TOML",
  env: "ENV",
  ini: "INI",
  properties: "PROP",
};

export function applyTheme(preference: ThemePreference): void {
  const dark = preference === "dark"
    || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function defaultClientSettings(): AppSettings {
  return {
    theme: "system",
    ai: { enabled: false, provider: "custom", model: "", baseUrl: "", apiKey: "", timeoutMs: 45_000 },
    github: { token: "" },
    recentProjects: [],
  };
}

export function errorMessage(error: unknown, fallback = "操作失败，请重试"): string {
  return error instanceof Error ? error.message : fallback;
}

export function sameProjectRoot(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

export function parentPath(path: string, rootLabel = "项目根目录"): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : rootLabel;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
