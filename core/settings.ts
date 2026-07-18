import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSettings, RecentProject } from "../shared/schema.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";

export interface SecretCodec {
  encode(value: string): string;
  decode(value: string): string;
}

interface PersistedSettings extends Omit<AppSettings, "ai" | "github"> {
  ai: AppSettings["ai"];
  github: AppSettings["github"];
}

export class SettingsStore {
  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec,
  ) {}

  async load(): Promise<AppSettings> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as Partial<PersistedSettings>;
      const settings = normalizeSettings(parsed);
      settings.ai.apiKey = this.codec.decode(settings.ai.apiKey);
      settings.github.token = this.codec.decode(settings.github.token);
      return settings;
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(DEFAULT_SETTINGS);
      if (error instanceof SyntaxError) throw new ConfuiError("PARSE_ERROR", "Confui 设置文件已损坏", error.message);
      throw error;
    }
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const settings = normalizeSettings(input);
    const persisted: PersistedSettings = {
      ...settings,
      ai: { ...settings.ai, apiKey: this.codec.encode(settings.ai.apiKey) },
      github: { token: this.codec.encode(settings.github.token) },
    };
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ConfuiError("SAVE_ERROR", "无法保存 Confui 设置", error instanceof Error ? error.message : String(error));
    }
    return settings;
  }

  async rememberProject(project: RecentProject): Promise<AppSettings> {
    const current = await this.load();
    current.recentProjects = [
      project,
      ...current.recentProjects.filter((item) => item.path.toLowerCase() !== project.path.toLowerCase()),
    ].slice(0, 10);
    return this.save(current);
  }
}

export function normalizeSettings(input: Partial<AppSettings>): AppSettings {
  const theme = input.theme === "light" || input.theme === "dark" || input.theme === "system"
    ? input.theme
    : DEFAULT_SETTINGS.theme;
  const ai = input.ai ?? DEFAULT_SETTINGS.ai;
  const github = input.github ?? DEFAULT_SETTINGS.github;
  const recentProjects = Array.isArray(input.recentProjects)
    ? input.recentProjects
      .filter((item): item is RecentProject => Boolean(item && typeof item.path === "string" && typeof item.name === "string"))
      .map((item) => ({
        path: item.path,
        name: item.name,
        githubUrl: typeof item.githubUrl === "string" ? item.githubUrl : undefined,
        openedAt: Number.isFinite(item.openedAt) ? item.openedAt : Date.now(),
      }))
      .slice(0, 10)
    : [];
  return {
    theme,
    ai: {
      enabled: ai.enabled === true,
      provider: typeof ai.provider === "string" ? ai.provider.slice(0, 80) : "custom",
      model: typeof ai.model === "string" ? ai.model.trim().slice(0, 200) : "",
      baseUrl: typeof ai.baseUrl === "string" ? ai.baseUrl.trim().slice(0, 2_000) : "",
      apiKey: typeof ai.apiKey === "string" ? ai.apiKey.slice(0, 8_000) : "",
      timeoutMs: Number.isFinite(ai.timeoutMs) ? Math.min(120_000, Math.max(5_000, ai.timeoutMs)) : 45_000,
    },
    github: {
      token: typeof github.token === "string" ? github.token.slice(0, 8_000) : "",
    },
    recentProjects,
  };
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
