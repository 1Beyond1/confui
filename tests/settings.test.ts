import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../core/settings.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("settings store", () => {
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
});
