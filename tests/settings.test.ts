import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore, maskSecretHint, normalizeSettings, type SecretCodec } from "../core/settings.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";

/** Mirrors the real codec: `enc:` values are readable only while unlocked. */
function keychainCodec(state: { unlocked: boolean }): SecretCodec {
  return {
    encode: (value) => {
      if (!value) return "";
      if (!state.unlocked) throw new Error("keychain unavailable");
      return `enc:${Buffer.from(value).toString("base64")}`;
    },
    decode: (value) => {
      if (!value) return "";
      if (!value.startsWith("enc:")) return value;
      return state.unlocked ? Buffer.from(value.slice(4), "base64").toString() : undefined;
    },
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("settings store", () => {
  it("does not retain credentials or tracking data in legacy recent GitHub URLs", () => {
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      recentProjects: [
        { path: "C:\\demo", name: "demo", githubUrl: "https://user:password@github.com/owner/repo/issues", openedAt: 1 },
        { path: "C:\\clean", name: "clean", githubUrl: "https://www.github.com/owner/clean.git", openedAt: 2 },
      ],
    });

    expect(settings.recentProjects).toEqual([
      { path: "C:\\demo", name: "demo", githubUrl: undefined, openedAt: 1 },
      { path: "C:\\clean", name: "clean", githubUrl: "https://github.com/owner/clean", openedAt: 2 },
    ]);
  });

  it("never writes provider or GitHub credentials in plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-settings-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const codec = {
      encode: (value: string) => value ? `secure:${Buffer.from(value).toString("base64")}` : "",
      decode: (value: string) => value.startsWith("secure:") ? Buffer.from(value.slice(7), "base64").toString() : value,
    };
    const store = new SettingsStore(path, codec);
    const input = structuredClone(DEFAULT_SETTINGS);
    input.ai.apiKey = "sk-private";
    input.github.token = "ghp-private";
    input.ai.baseUrl = "http://127.0.0.1:11434/v1";
    input.ai.model = "qwen";
    await store.save(input);

    const disk = await readFile(path, "utf8");
    expect(disk).not.toContain("sk-private");
    expect(disk).not.toContain("ghp-private");
    await expect(store.load()).resolves.toMatchObject({
      ai: { apiKey: "sk-private" },
      github: { token: "ghp-private" },
    });
  });

  it("keeps stored credentials when the keychain is locked", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-locked-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const state = { unlocked: true };
    const store = new SettingsStore(path, keychainCodec(state));

    const input = structuredClone(DEFAULT_SETTINGS);
    input.ai.apiKey = "sk-private";
    input.github.token = "ghp-private";
    await store.save(input);
    const ciphertext = await readFile(path, "utf8");

    // The keychain goes away: the settings page must still open, reporting the
    // secrets as empty but flagged so it can explain why the fields look blank.
    state.unlocked = false;
    await expect(store.load()).resolves.toMatchObject({
      ai: { apiKey: "" },
      github: { token: "" },
      lockedSecrets: { apiKey: true, githubToken: true },
    });

    // Opening a project, then saving unrelated settings, must both leave the
    // ciphertext byte-identical instead of writing the empty strings back.
    await store.rememberProject({ path: root, name: "demo", openedAt: 1 });
    expect(await readFile(path, "utf8")).toContain(JSON.parse(ciphertext).ai.apiKey);

    // Saving unrelated settings still reports the secrets as locked, so the page
    // does not flip back to "encrypted and saved" after a round trip.
    const cleared = await store.load();
    cleared.theme = "dark";
    await expect(store.save(cleared)).resolves.toMatchObject({
      lockedSecrets: { apiKey: true, githubToken: true },
    });

    state.unlocked = true;
    const recovered = await store.load();
    expect(recovered).toMatchObject({
      theme: "dark",
      ai: { apiKey: "sk-private" },
      github: { token: "ghp-private" },
    });
    expect(recovered.lockedSecrets).toBeUndefined();
  });

  it("can save over a corrupt settings file", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-corrupt-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }));
    await writeFile(path, "{ not json", "utf8");

    await expect(store.load()).rejects.toMatchObject({ code: "PARSE_ERROR" });
    const input = structuredClone(DEFAULT_SETTINGS);
    input.ai.apiKey = "sk-fresh";
    await store.save(input);
    await expect(store.load()).resolves.toMatchObject({ ai: { apiKey: "sk-fresh" } });
  });

  it("repairs a corrupt settings file while remembering a project", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-corrupt-recent-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }));
    await writeFile(path, "{ not json", "utf8");

    await store.rememberProject({ path: root, name: "demo", openedAt: 1 });

    await expect(store.load()).resolves.toMatchObject({
      recentProjects: [{ path: root, name: "demo", openedAt: 1 }],
    });
  });

  it("serializes concurrent settings writes instead of losing one update", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-concurrent-settings-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }));
    const input = structuredClone(DEFAULT_SETTINGS);
    input.theme = "dark";

    // Queue the project update first and then save an intentionally stale
    // settings snapshot. The second write must preserve the first one's list.
    await Promise.all([
      store.rememberProject({ path: root, name: "demo", openedAt: 1 }),
      store.save(input),
    ]);

    await expect(store.load()).resolves.toMatchObject({
      theme: "dark",
      recentProjects: [{ path: root, name: "demo", openedAt: 1 }],
    });
  });

  it("still lets a readable credential be cleared on purpose", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-clear-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }));

    const input = structuredClone(DEFAULT_SETTINGS);
    input.ai.apiKey = "sk-private";
    await store.save(input);

    const cleared = await store.load();
    cleared.ai.apiKey = "";
    const saved = await store.save(cleared);
    expect(saved.ai.apiKey).toBe("");
    expect(saved.lockedSecrets).toBeUndefined();
    await expect(store.load()).resolves.toMatchObject({ ai: { apiKey: "" } });
    expect(await readFile(path, "utf8")).not.toContain("enc:");
  });

  it("does not trust a lockedSecrets flag sent by the renderer", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-spoof-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }));

    const input = structuredClone(DEFAULT_SETTINGS);
    input.ai.apiKey = "sk-private";
    input.lockedSecrets = { apiKey: true, githubToken: true };
    const saved = await store.save(input);

    expect(saved.lockedSecrets).toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain("lockedSecrets");
  });

  it("normalizes valid JSON values that are not settings objects", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-non-object-settings-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }));

    for (const value of ["null", "[]", "42", '"text"']) {
      await writeFile(path, value, "utf8");
      await expect(store.load()).resolves.toMatchObject(DEFAULT_SETTINGS);
    }
  });

  it("does not truncate a long encrypted credential while loading settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-settings-ciphertext-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const longCiphertext = `enc:v1:${"x".repeat(10_000)}`;
    await writeFile(path, JSON.stringify({
      ...DEFAULT_SETTINGS,
      ai: { ...DEFAULT_SETTINGS.ai, apiKey: longCiphertext },
    }), "utf8");
    const store = new SettingsStore(path, {
      encode: (value) => value,
      decode: (value) => value === longCiphertext ? "restored-secret" : value,
    });

    await expect(store.load()).resolves.toMatchObject({ ai: { apiKey: "restored-secret" } });
  });

  it("redacts credentials for the renderer and updates them only on explicit input, clear, or provider switch", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-settings-redacted-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const state = { unlocked: true };
    const store = new SettingsStore(path, keychainCodec(state));

    expect(maskSecretHint("")).toBeUndefined();
    expect(maskSecretHint("short")).toBe("••••");
    expect(maskSecretHint("sk-1234567890abcd")).toBe("sk-•••abcd");

    const initial = structuredClone(DEFAULT_SETTINGS);
    initial.ai.enabled = true;
    initial.ai.provider = "openai";
    initial.ai.model = "gpt-4.1-mini";
    initial.ai.baseUrl = "https://api.openai.com/v1";
    initial.ai.apiKey = "sk-1234567890abcd";
    initial.github.token = "ghp_1234567890wxyz";
    const saved = await store.saveFromRenderer(initial);

    // Renderer response must never expose plaintext secrets.
    expect(saved.ai.apiKey).toBe("");
    expect(saved.github.token).toBe("");
    expect(saved.secrets).toEqual({
      hasApiKey: true,
      apiKeyHint: "sk-•••abcd",
      hasGithubToken: true,
      githubTokenHint: "ghp•••wxyz",
    });

    const loadedForRenderer = await store.loadForRenderer();
    expect(loadedForRenderer.ai.apiKey).toBe("");
    expect(loadedForRenderer.github.token).toBe("");
    expect(loadedForRenderer.secrets).toEqual(saved.secrets);

    // Saving an unrelated preference (theme) with blank secret fields preserves stored secrets.
    const themeUpdate = structuredClone(loadedForRenderer);
    themeUpdate.theme = "dark";
    const afterTheme = await store.saveFromRenderer(themeUpdate);
    expect(afterTheme.theme).toBe("dark");
    expect(afterTheme.secrets?.hasApiKey).toBe(true);
    expect(afterTheme.secrets?.hasGithubToken).toBe(true);
    await expect(store.load()).resolves.toMatchObject({
      theme: "dark",
      ai: { apiKey: "sk-1234567890abcd" },
      github: { token: "ghp_1234567890wxyz" },
    });

    // Switching AI provider without supplying a new key clears the old provider's key.
    const switchedProvider = structuredClone(afterTheme);
    switchedProvider.ai.provider = "deepseek";
    const afterSwitch = await store.saveFromRenderer(switchedProvider);
    expect(afterSwitch.secrets?.hasApiKey).toBe(false);
    expect(afterSwitch.secrets?.hasGithubToken).toBe(true);
    await expect(store.load()).resolves.toMatchObject({
      ai: { provider: "deepseek", apiKey: "" },
      github: { token: "ghp_1234567890wxyz" },
    });

    // Explicitly clearing GitHub token removes it.
    const clearedGithub = structuredClone(afterSwitch);
    clearedGithub.clearSecrets = { githubToken: true };
    const afterClear = await store.saveFromRenderer(clearedGithub);
    expect(afterClear.secrets?.hasGithubToken).toBe(false);
    await expect(store.load()).resolves.toMatchObject({ github: { token: "" } });
    const rawDisk = await readFile(path, "utf8");
    expect(rawDisk).not.toContain("clearSecrets");
    expect(rawDisk).not.toContain("hasApiKey");

    // Locked secrets stay preserved when keychain becomes unavailable.
    const withNewKey = structuredClone(afterClear);
    withNewKey.ai.apiKey = "sk-locked-secret-9999";
    await store.saveFromRenderer(withNewKey);
    state.unlocked = false;
    const lockedRead = await store.loadForRenderer();
    expect(lockedRead.lockedSecrets).toEqual({ apiKey: true, githubToken: false });
    expect(lockedRead.secrets?.hasApiKey).toBe(false);
    lockedRead.theme = "light";
    const afterLockedSave = await store.saveFromRenderer(lockedRead);
    expect(afterLockedSave.lockedSecrets).toEqual({ apiKey: true, githubToken: false });
    state.unlocked = true;
    await expect(store.load()).resolves.toMatchObject({
      theme: "light",
      ai: { apiKey: "sk-locked-secret-9999" },
    });
  });

  it("retries transient Windows EPERM/EBUSY errors when persisting settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-settings-retry-"));
    temporaryDirectories.push(root);
    const path = join(root, "settings.json");
    const eperm = Object.assign(new Error("antivirus lock"), { code: "EPERM" });
    const ebusy = Object.assign(new Error("busy"), { code: "EBUSY" });
    let attempts = 0;
    const flakyRename = vi.fn(async (src: string, dst: string) => {
      attempts += 1;
      if (attempts === 1) throw eperm;
      if (attempts === 2) throw ebusy;
      await rename(src, dst);
    });
    const store = new SettingsStore(path, keychainCodec({ unlocked: true }), {
      renameFn: flakyRename,
      retryDelaysMs: [1, 1, 1],
      platform: "win32",
    });

    const input = structuredClone(DEFAULT_SETTINGS);
    input.theme = "dark";
    await store.save(input);

    expect(flakyRename).toHaveBeenCalledTimes(3);
    await expect(store.load()).resolves.toMatchObject({ theme: "dark" });
  });
});
