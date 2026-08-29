import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, normalizeSettings, type SecretCodec } from "../core/settings.ts";
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
});
