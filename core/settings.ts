import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSettings, RecentProject } from "../shared/schema.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";

export interface SecretCodec {
  encode(value: string): string;
  /**
   * Returns the plaintext, or `undefined` when a ciphertext is present but
   * cannot be read — an OS keychain that is locked or unavailable, or a value
   * encrypted under a different user profile. The distinction matters: an
   * unreadable secret must never be treated as an empty one.
   */
  decode(value: string): string | undefined;
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
    return this.decodeSecrets(await this.readPersisted());
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const settings = normalizeSettings(input);
    // A corrupt settings file has to stay repairable by saving over it, so a
    // parse failure here means "no ciphertext worth preserving", not an error.
    const stored = await this.readPersisted().catch((error: unknown) => {
      if (error instanceof ConfuiError && error.code === "PARSE_ERROR") return structuredClone(DEFAULT_SETTINGS);
      throw error;
    });
    const persisted: PersistedSettings = {
      ...settings,
      ai: { ...settings.ai, apiKey: this.encodeSecret(settings.ai.apiKey, stored.ai.apiKey) },
      github: { token: this.encodeSecret(settings.github.token, stored.github.token) },
    };
    await this.writePersisted(persisted);
    // Reported from what was actually written, not from `input`: a locked secret
    // is preserved rather than cleared, and the caller needs to know that.
    return this.decodeSecrets(persisted);
  }

  async rememberProject(project: RecentProject): Promise<AppSettings> {
    // Opening a project deliberately skips the decode/encode round trip: when
    // the keychain is locked the secrets cannot be read, and writing back what
    // `load()` reported would replace the ciphertext with an empty string.
    const persisted = await this.readPersisted();
    persisted.recentProjects = [
      project,
      ...persisted.recentProjects.filter((item) => item.path.toLowerCase() !== project.path.toLowerCase()),
    ].slice(0, 10);
    await this.writePersisted(persisted);
    return this.decodeSecrets(persisted);
  }

  /** Reads the on-disk settings with the secrets left in their stored form. */
  private async readPersisted(): Promise<PersistedSettings> {
    try {
      const text = await readFile(this.filePath, "utf8");
      return normalizeSettings(JSON.parse(text) as Partial<PersistedSettings>);
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(DEFAULT_SETTINGS);
      if (error instanceof SyntaxError) throw new ConfuiError("PARSE_ERROR", "Confui 设置文件已损坏", error.message);
      throw error;
    }
  }

  private async writePersisted(persisted: PersistedSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ConfuiError("SAVE_ERROR", "无法保存 Confui 设置", error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * An unreadable secret is reported as empty so the settings page stays usable,
   * plus a `lockedSecrets` flag so the page can say why the field looks empty
   * instead of letting the user believe the credential was never saved.
   */
  private decodeSecrets(persisted: PersistedSettings): AppSettings {
    const apiKey = this.codec.decode(persisted.ai.apiKey);
    const githubToken = this.codec.decode(persisted.github.token);
    const settings: AppSettings = {
      ...persisted,
      ai: { ...persisted.ai, apiKey: apiKey ?? "" },
      github: { token: githubToken ?? "" },
      lockedSecrets: undefined,
    };
    if (apiKey === undefined || githubToken === undefined) {
      settings.lockedSecrets = { apiKey: apiKey === undefined, githubToken: githubToken === undefined };
    }
    return settings;
  }

  /**
   * Refuses to overwrite an unreadable ciphertext with an empty string. `load()`
   * reports a locked secret as `""`, so without this guard merely opening a
   * project would round-trip that `""` back to disk and destroy a key that a
   * later, working session could still have decrypted.
   */
  private encodeSecret(value: string, stored: string): string {
    if (!value && stored && this.codec.decode(stored) === undefined) return stored;
    return this.codec.encode(value);
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
