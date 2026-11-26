import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppSettings, Locale, RecentProject, TestAIRequest } from "../shared/schema.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";
import { canReuseStoredAiApiKey, isAiEndpointUnchanged } from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";
import { renameWithRetry } from "./save.ts";
import { normalizeGithubUrl } from "./scanner.ts";
import { readLimitedUtf8File } from "./inference/limited-text.ts";

const SETTINGS_MAX_BYTES = 512 * 1024;
const SECRET_STORAGE_MAX_CHARS = 24_000;
const SETTINGS_TOO_LARGE_MESSAGE = "Confui 设置文件过大，无法读取";
const SETTINGS_INVALID_UTF8_MESSAGE = "Confui 设置文件不是有效的 UTF-8 编码";

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

export interface SettingsStoreOptions {
  renameFn?: (src: string, dst: string) => Promise<void>;
  retryDelaysMs?: readonly number[];
  platform?: NodeJS.Platform;
}

export class SettingsStore {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly codec: SecretCodec,
    private readonly options: SettingsStoreOptions = {},
  ) {}

  async load(): Promise<AppSettings> {
    return this.decodeSecrets(await this.readPersisted());
  }

  /**
   * Loads settings with plaintext credentials stripped so the renderer only
   * receives safe presence/hint flags and locked-keychain indicators.
   */
  async loadForRenderer(): Promise<AppSettings> {
    return redactSettingsForRenderer(await this.load());
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

  /**
   * Persists settings sent by the renderer without ever requiring plaintext
   * credentials to round-trip through the renderer. Existing stored secrets are
   * preserved unless the user supplies a new value, explicitly requests clear,
   * switches AI providers, or changes the canonical trusted origin of `baseUrl`.
   */
  async saveFromRenderer(input: AppSettings): Promise<AppSettings> {
    return this.withWriteLock(async () => {
      const settings = normalizeSettings(input);
      const clearApiKey = isRecord(input) && isRecord(input.clearSecrets) && input.clearSecrets.apiKey === true;
      const clearGithubToken = isRecord(input) && isRecord(input.clearSecrets) && input.clearSecrets.githubToken === true;
      const stored = await this.readPersistedForWrite();
      const canPreserveApiKey = canReuseStoredAiApiKey(stored.ai, settings.ai)
        || isAiEndpointUnchanged(stored.ai, settings.ai);

      const nextApiKey = settings.ai.apiKey
        ? this.codec.encode(settings.ai.apiKey)
        : clearApiKey || !canPreserveApiKey
          ? ""
          : stored.ai.apiKey;
      const nextGithubToken = settings.github.token
        ? this.codec.encode(settings.github.token)
        : clearGithubToken
          ? ""
          : stored.github.token;

      const persisted: PersistedSettings = {
        ...settings,
        recentProjects: stored.recentProjects,
        ai: { ...settings.ai, apiKey: nextApiKey },
        github: { token: nextGithubToken },
      };
      await this.writePersisted(persisted);
      return redactSettingsForRenderer(this.decodeSecrets(persisted));
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

  async removeRecentProject(projectPath: string): Promise<AppSettings> {
    return this.withWriteLock(async () => {
      const target = projectPath.trim().toLowerCase();
      const persisted = await this.readPersistedForWrite();
      persisted.recentProjects = persisted.recentProjects.filter(
        (item) => item.path.toLowerCase() !== target,
      );
      await this.writePersisted(persisted);
      return redactSettingsForRenderer(this.decodeSecrets(persisted));
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
      const text = await readLimitedUtf8File(this.filePath, {
        maxBytes: SETTINGS_MAX_BYTES,
        overflow: "reject",
        tooLargeMessage: SETTINGS_TOO_LARGE_MESSAGE,
        invalidUtf8Message: SETTINGS_INVALID_UTF8_MESSAGE,
      });
      return normalizeSettings(JSON.parse(text) as Partial<PersistedSettings>);
    } catch (error) {
      if (isMissingFile(error)) return structuredClone(DEFAULT_SETTINGS);
      if (error instanceof SyntaxError) throw new ConfuiError("PARSE_ERROR", "Confui 设置文件已损坏", error.message);
      if (error instanceof Error && error.message === SETTINGS_TOO_LARGE_MESSAGE) {
        throw new ConfuiError("PARSE_ERROR", SETTINGS_TOO_LARGE_MESSAGE);
      }
      if (error instanceof Error && error.message === SETTINGS_INVALID_UTF8_MESSAGE) {
        throw new ConfuiError("PARSE_ERROR", SETTINGS_INVALID_UTF8_MESSAGE);
      }
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
      await renameWithRetry(
        temporary,
        this.filePath,
        this.options.renameFn ?? rename,
        this.options.retryDelaysMs,
        this.options.platform,
      );
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

export function maskSecretHint(value: string): string | undefined {
  if (!value) return undefined;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 3)}•••${value.slice(-4)}`;
}

/**
 * Resolves the API key used by `confui:testAI`. Refuses to attach a stored
 * `safeStorage` API key unless both `provider` and the canonical trusted origin
 * of `baseUrl` match the stored AI configuration.
 */
export function resolveTestAIApiKey(
  storedAi: AppSettings["ai"],
  request: TestAIRequest,
  locale: Locale = "zh-CN",
): string {
  if (request.apiKey) return request.apiKey;
  if (request.useStoredApiKey !== true) return "";
  if (!canReuseStoredAiApiKey(storedAi, request)) {
    throw new ConfuiError(
      "AI_ERROR",
      locale === "en-US"
        ? "Provider or Base URL origin changed; please re-enter your API Key before testing."
        : "AI 供应商或 Base URL 来源已变更，请重新输入 API Key 后再测试连接。",
    );
  }
  return storedAi.apiKey;
}

export function redactSettingsForRenderer(settings: AppSettings): AppSettings {
  const hasApiKey = Boolean(settings.ai.apiKey);
  const hasGithubToken = Boolean(settings.github.token);
  return {
    ...settings,
    ai: { ...settings.ai, apiKey: "" },
    github: { token: "" },
    secrets: {
      hasApiKey,
      apiKeyHint: maskSecretHint(settings.ai.apiKey),
      hasGithubToken,
      githubTokenHint: maskSecretHint(settings.github.token),
    },
    clearSecrets: undefined,
  };
}

export function normalizeSettings(input: unknown): AppSettings {
  const source = isRecord(input) ? input : {};
  const theme = source.theme === "light" || source.theme === "dark" || source.theme === "system"
    ? source.theme
    : DEFAULT_SETTINGS.theme;
  const locale = source.locale === "en-US" || source.locale === "zh-CN"
    ? source.locale
    : DEFAULT_SETTINGS.locale;
  const ai = isRecord(source.ai) ? source.ai : {};
  const github = isRecord(source.github) ? source.github : {};
  const schemaStore = isRecord(source.schemaStore) ? source.schemaStore : {};
  const recentProjects = Array.isArray(source.recentProjects)
    ? source.recentProjects
      .filter((item): item is RecentProject => Boolean(item && typeof item.path === "string" && typeof item.name === "string"))
      .map((item) => ({
        path: item.path.trim().slice(0, 4_096),
        name: item.name.trim().slice(0, 200),
        // Older versions accepted an arbitrary string here. Canonicalize it on
        // read so a legacy credential-bearing URL is not shown to the renderer
        // or written back to disk on the next settings update.
        githubUrl: typeof item.githubUrl === "string" ? normalizeGithubUrl(item.githubUrl.slice(0, 2_000)) : undefined,
        openedAt: Number.isFinite(item.openedAt) ? item.openedAt : Date.now(),
      }))
      .filter((item) => item.path.length > 0 && item.name.length > 0)
      .slice(0, 10)
    : [];
  return {
    theme,
    locale,
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
    schemaStore: {
      enabled: schemaStore.enabled === true,
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
