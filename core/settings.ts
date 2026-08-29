import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSettings, RecentProject } from "../shared/schema.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";

const SETTINGS_MAX_BYTES = 512 * 1024;
const SECRET_STORAGE_MAX_CHARS = 24_000;

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
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec,
  ) {}

  async load(): Promise<AppSettings> {
    return this.decodeSecrets(await this.readPersisted());
  }

  async save(input: AppSettings): Promise<AppSettings> {
    return this.withWriteLock(async () => {
      const settings = normalizeSettings(input);
      // A corrupt settings file has to stay repairable by saving over it, so a
      // parse failure here means "no ciphertext worth preserving", not an error.
      const stored = await this.readPersistedForWrite();
      const persisted: PersistedSettings = {
        ...settings,
        // Recent projects are owned by rememberProject(). The settings page can
        // hold an older snapshot while a project is opening, so trusting its
        // copy here would silently erase the newly remembered entry.
        recentProjects: stored.recentProjects,
        ai: { ...settings.ai, apiKey: this.encodeSecret(settings.ai.apiKey, stored.ai.apiKey) },
        github: { token: this.encodeSecret(settings.github.token, stored.github.token) },
      };
      await this.writePersisted(persisted);
      // Reported from what was actually written, not from `input`: a locked secret
      // is preserved rather than cleared, and the caller needs to know that.
      return this.decodeSecrets(persisted);
    });
  }

  async rememberProject(project: RecentProject): Promise<AppSettings> {
    return this.withWriteLock(async () => {
      // Opening a project deliberately skips the decode/encode round trip: when
      // the keychain is locked the secrets cannot be read, and writing back what
      // `load()` reported would replace the ciphertext with an empty string.
      // A broken settings file should not prevent a project from opening; the
      // recent-project list is also the first opportunity to repair it.
      const persisted = await this.readPersistedForWrite();
      persisted.recentProjects = [
        project,
        ...persisted.recentProjects.filter((item) => item.path.toLowerCase() !== project.path.toLowerCase()),
      ].slice(0, 10);
      await this.writePersisted(persisted);
      return this.decodeSecrets(persisted);
    });
  }

  /** Reads the on-disk settings with the secrets left in their stored form. */
  private async readPersisted(): Promise<PersistedSettings> {
    try {
      const info = await stat(this.filePath);
      if (!info.isFile()) throw new ConfuiError("PARSE_ERROR", "Confui 设置文件不是普通文件");
      if (info.size > SETTINGS_MAX_BYTES) {
        throw new ConfuiError("PARSE_ERROR", "Confui 设置文件过大，无法读取");
      }
      const text = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(text, "utf8") > SETTINGS_MAX_BYTES) {
        throw new ConfuiError("PARSE_ERROR", "Confui 设置文件在读取时变得过大");
      }
      return normalizeSettings(JSON.parse(text) as Partial<PersistedSettings>);
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(DEFAULT_SETTINGS);
      if (error instanceof SyntaxError) throw new ConfuiError("PARSE_ERROR", "Confui 设置文件已损坏", error.message);
      throw error;
    }
  }

  private async readPersistedForWrite(): Promise<PersistedSettings> {
    return this.readPersisted().catch((error: unknown) => {
      if (error instanceof ConfuiError && error.code === "PARSE_ERROR") return structuredClone(DEFAULT_SETTINGS);
      throw error;
    });
  }

  private async writePersisted(persisted: PersistedSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(persisted, null, 2)}\n`, { encoding: "utf8", flag: "w" });
      await rename(temporary, this.filePath);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw new ConfuiError("SAVE_ERROR", "无法保存 Confui 设置", error instanceof Error ? error.message : String(error));
    }
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTail;
    let release!: () => void;
    this.writeTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
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

export function normalizeSettings(input: unknown): AppSettings {
  const source = isRecord(input) ? input : {};
  const theme = source.theme === "light" || source.theme === "dark" || source.theme === "system"
    ? source.theme
    : DEFAULT_SETTINGS.theme;
  const ai = isRecord(source.ai) ? source.ai : {};
  const github = isRecord(source.github) ? source.github : {};
  const recentProjects = Array.isArray(source.recentProjects)
    ? source.recentProjects
      .filter((item): item is RecentProject => Boolean(item && typeof item.path === "string" && typeof item.name === "string"))
      .map((item) => ({
        path: item.path.trim().slice(0, 4_096),
        name: item.name.trim().slice(0, 200),
        githubUrl: typeof item.githubUrl === "string" ? item.githubUrl.trim().slice(0, 2_000) || undefined : undefined,
        openedAt: Number.isFinite(item.openedAt) ? item.openedAt : Date.now(),
      }))
      .filter((item) => item.path.length > 0 && item.name.length > 0)
      .slice(0, 10)
    : [];
  return {
    theme,
    ai: {
      enabled: ai.enabled === true,
      provider: typeof ai.provider === "string" ? ai.provider.slice(0, 80) : "custom",
      model: typeof ai.model === "string" ? ai.model.trim().slice(0, 200) : "",
      baseUrl: typeof ai.baseUrl === "string" ? ai.baseUrl.trim().slice(0, 2_000) : "",
      // Persisted values can be safeStorage ciphertext, which is longer than
      // the plaintext entered by the user. Keep enough room for either form.
      apiKey: typeof ai.apiKey === "string" ? ai.apiKey.slice(0, SECRET_STORAGE_MAX_CHARS) : "",
      timeoutMs: typeof ai.timeoutMs === "number" && Number.isFinite(ai.timeoutMs)
        ? Math.min(120_000, Math.max(5_000, ai.timeoutMs))
        : 45_000,
    },
    github: {
      token: typeof github.token === "string" ? github.token.slice(0, SECRET_STORAGE_MAX_CHARS) : "",
    },
    recentProjects,
  };
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
