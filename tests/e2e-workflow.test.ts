import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AIProvider } from "../core/ai/provider.ts";
import { readTextSnapshot } from "../core/files.ts";
import { parseConfig, updateConfigText } from "../core/formats.ts";
import { inferConfig } from "../core/inference/index.ts";
import { inferKnownFields } from "../core/inference/known.ts";
import {
  commitRestoreBackup,
  commitSave,
  getBackupStatus,
  previewRestoreBackup,
  previewSave,
} from "../core/save.ts";
import { scanProject } from "../core/scanner.ts";
import { SettingsStore, type SecretCodec } from "../core/settings.ts";
import { computeUnifiedDiff } from "../shared/diff.ts";

const FIXTURE_DIR = resolve(fileURLToPath(new URL("./fixtures/e2e-project", import.meta.url)));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function copyFixtureProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "confui-e2e-"));
  tempDirs.push(dir);
  await cp(FIXTURE_DIR, dir, { recursive: true });
  return dir;
}

describe("end-to-end confui workflow", () => {
  it("scans all supported formats while excluding lockfiles, schemas, examples and TS configs", async () => {
    const root = await copyFixtureProject();
    const scan = await scanProject(root);
    const paths = scan.files.map((file) => file.path);

    expect(paths).toContain("package.json");
    expect(paths).toContain("config.jsonc");
    expect(paths).toContain("app.yaml");
    expect(paths).toContain("settings.toml");
    expect(paths).toContain(".env");
    expect(paths).toContain("service.ini");
    expect(paths).toContain("app.properties");

    expect(paths).not.toContain("package-lock.json");
    expect(paths).not.toContain("config.schema.json");
    expect(paths).not.toContain("config.example.jsonc");
    expect(paths).not.toContain(".env.example");
    expect(paths).not.toContain("vite.config.ts");
  });

  it("runs 6-layer inference on fixture project and masks sensitive values before AI", async () => {
    const root = await copyFixtureProject();
    const capturedPrompts: string[] = [];
    const mockAi: AIProvider = {
      async chat(messages) {
        capturedPrompts.push(messages.map((m) => m.content).join("\n"));
        return JSON.stringify({
          fields: [
            {
              segments: ["themeColor"],
              label: "Theme Accent",
              description: "Primary UI accent hex color.",
              type: "color",
            },
          ],
        });
      },
    };

    const schema = await inferConfig(root, "config.jsonc", { ai: mockAi, locale: "zh-CN" });
    expect(schema.exampleFiles).toContain("config.example.jsonc");
    expect(schema.readmeSource).toBe("local");

    const portField = schema.fields.find((field) => field.path === "server.port");
    expect(portField).toBeDefined();
    expect(portField?.type).toBe("integer");
    expect(portField?.minimum).toBe(1);
    expect(portField?.maximum).toBe(65535);
    expect(portField?.value).toBe(3000);
    expect(portField?.description).toContain("HTTP");

    const tokenField = schema.fields.find((field) => field.path === "apiToken");
    expect(tokenField?.secret).toBe(true);

    // Ensure AI never saw the plaintext secret token value.
    expect(capturedPrompts.length).toBe(1);
    expect(capturedPrompts[0]).not.toContain("demo-token");
    expect(capturedPrompts[0]).toContain("***");
  });

  it("provides bilingual built-in templates for docker-compose, pyproject.toml, Cargo.toml and .env", () => {
    const composeDoc = {
      name: "demo-stack",
      services: {
        web: { image: "nginx:alpine", restart: "unless-stopped", ports: ["8080:80"] },
      },
      volumes: { data: {} },
    };
    const composeZh = inferKnownFields("docker-compose.yml", composeDoc, "yaml", "zh-CN");
    const composeEn = inferKnownFields("compose.yaml", composeDoc, "yaml", "en-US");
    expect(composeZh.find((f) => f.segments.join(".") === "services.web.restart")?.enum).toContain("unless-stopped");
    expect(composeZh.find((f) => f.segments.join(".") === "services.web.image")?.label).toContain("镜像");
    expect(composeEn.find((f) => f.segments.join(".") === "services.web.image")?.label).toContain("Image");

    const pyprojectDoc = {
      project: { name: "demo", version: "0.1.0", "requires-python": ">=3.11" },
      tool: { ruff: { "line-length": 100 }, mypy: { strict: true } },
    };
    const pyEn = inferKnownFields("pyproject.toml", pyprojectDoc, "toml", "en-US");
    expect(pyEn.find((f) => f.segments.join(".") === "tool.ruff.line-length")?.type).toBe("integer");
    expect(pyEn.find((f) => f.segments.join(".") === "tool.mypy.strict")?.type).toBe("boolean");

    const cargoDoc = {
      package: { name: "confui-cli", version: "0.1.0", edition: "2021" },
      profile: { release: { lto: true } },
    };
    const cargoZh = inferKnownFields("Cargo.toml", cargoDoc, "toml", "zh-CN");
    expect(cargoZh.find((f) => f.segments.join(".") === "package.edition")?.enum).toEqual(["2015", "2018", "2021", "2024"]);
    expect(cargoZh.find((f) => f.segments.join(".") === "profile.release.lto")?.type).toBe("boolean");

    const envDoc = {
      PORT: "3000",
      HOST: "0.0.0.0",
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@localhost/db",
      REDIS_URL: "redis://localhost:6379",
      LOG_LEVEL: "info",
      DEBUG: "false",
    };
    const envZh = inferKnownFields(".env", envDoc, "env", "zh-CN");
    const envEn = inferKnownFields(".env.production", envDoc, "env", "en-US");
    expect(envZh.find((f) => f.segments[0] === "PORT")?.maximum).toBe(65535);
    expect(envZh.find((f) => f.segments[0] === "NODE_ENV")?.enum).toContain("production");
    expect(envZh.find((f) => f.segments[0] === "DATABASE_URL")?.secret).toBe(true);
    expect(envEn.find((f) => f.segments[0] === "LOG_LEVEL")?.enum).toContain("debug");
  });

  it("preserves YAML and TOML comments end-to-end, supports adding/deleting keys and .bak restore", async () => {
    const root = await copyFixtureProject();

    // 1. YAML CST comment-preserving edit + add key + delete key + save
    const yamlSchema = await inferConfig(root, "app.yaml");
    const yamlPreview = await previewSave(root, "app.yaml", [
      { segments: ["server", "port"], value: 9090 },
      { segments: ["server", "secure"], value: undefined },
      { segments: ["server", "timeout"], value: 30 },
    ], yamlSchema.version);
    expect(yamlPreview.warnings).toEqual([]);
    expect(yamlPreview.output).toContain("# YAML comments are intentionally present");
    expect(parseConfig(yamlPreview.output, "yaml")).toEqual({
      server: { port: 9090, timeout: 30 },
      workers: 2,
    });

    const diff = computeUnifiedDiff(yamlSchema.rawText, yamlPreview.output);
    expect(diff.added).toBeGreaterThan(0);
    expect(diff.removed).toBeGreaterThan(0);

    const savedYaml = await commitSave(root, yamlPreview);
    expect(savedYaml.version.hash).not.toBe(yamlSchema.version.hash);

    // 2. Verify .bak status, preview restore, and atomic restore round-trip
    const backupStatus = await getBackupStatus(root, "app.yaml");
    expect(backupStatus.exists).toBe(true);

    const restorePreview = await previewRestoreBackup(root, "app.yaml", savedYaml.version);
    expect(restorePreview.backupText).toBe(yamlSchema.rawText);
    expect(restorePreview.currentText).toBe(yamlPreview.output);

    const restored = await commitRestoreBackup(root, restorePreview);
    expect(restored.version.hash).toBe(yamlSchema.version.hash);
    expect(await readFile(join(root, "app.yaml"), "utf8")).toBe(yamlSchema.rawText);
    // Previous modified content is safely preserved in .bak for undo-restore.
    expect(await readFile(join(root, "app.yaml.bak"), "utf8")).toBe(yamlPreview.output);

    // 3. TOML comment-preserving edit + add key
    const tomlPath = join(root, "settings.toml");
    await writeFile(tomlPath, '# App settings\ntitle = "Fixture" # keep\n\n[database]\nhost = "localhost"\nport = 5432 # pg\n', "utf8");
    const tomlSnap = await readTextSnapshot(tomlPath);
    const tomlPreview = await previewSave(root, "settings.toml", [
      { segments: ["database", "port"], value: 6432 },
      { segments: ["database", "pool_size"], value: 16 },
    ], tomlSnap.version);
    expect(tomlPreview.warnings).toEqual([]);
    expect(tomlPreview.output).toContain("# App settings");
    expect(tomlPreview.output).toContain('title = "Fixture" # keep');
    expect(tomlPreview.output).toContain("port = 6432 # pg");
    expect(tomlPreview.output).toContain("pool_size = 16");
    await commitSave(root, tomlPreview);
    expect(parseConfig(await readFile(tomlPath, "utf8"), "toml")).toMatchObject({
      title: "Fixture",
      database: { host: "localhost", port: 6432, pool_size: 16 },
    });

    // 4. Reject cyclic YAML aliases
    await writeFile(join(root, "cyclic.yaml"), "self: &self\n  child: *self\n", "utf8");
    await expect(inferConfig(root, "cyclic.yaml")).rejects.toThrow(/循环引用/);
  });

  it("supports adding and deleting keys across ENV, INI and Properties formats", async () => {
    const root = await copyFixtureProject();

    // ENV
    const envSnap = await readTextSnapshot(join(root, ".env"));
    const envPreview = await previewSave(root, ".env", [
      { segments: ["DEBUG"], value: "true" },
      { segments: ["SECRET_KEY"], value: undefined },
      { segments: ["LOG_LEVEL"], value: "info" },
    ], envSnap.version);
    await commitSave(root, envPreview);
    expect(parseConfig(await readFile(join(root, ".env"), "utf8"), "env")).toEqual({
      DATABASE_URL: "postgres://localhost/confui",
      DEBUG: "true",
      LOG_LEVEL: "info",
    });

    // INI
    const iniSnap = await readTextSnapshot(join(root, "service.ini"));
    const iniPreview = await previewSave(root, "service.ini", [
      { segments: ["server", "port"], value: 8000 },
      { segments: ["server", "enabled"], value: undefined },
      { segments: ["server", "timeout"], value: 15 },
    ], iniSnap.version);
    await commitSave(root, iniPreview);
    expect(parseConfig(await readFile(join(root, "service.ini"), "utf8"), "ini")).toEqual({
      server: { host: "localhost", port: "8000", timeout: "15" },
    });

    // Properties
    const propSnap = await readTextSnapshot(join(root, "app.properties"));
    const propPreview = await previewSave(root, "app.properties", [
      { segments: ["app.mode"], value: "production" },
      { segments: ["server.port"], value: undefined },
      { segments: ["app.retry"], value: "3" },
    ], propSnap.version);
    await commitSave(root, propPreview);
    expect(parseConfig(await readFile(join(root, "app.properties"), "utf8"), "properties")).toEqual({
      "app.name": "Confui Fixture",
      "app.mode": "production",
      "app.retry": "3",
    });
  });

  it("persists locale and removes individual recent projects without exposing or losing secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "confui-settings-e2e-"));
    tempDirs.push(dir);
    const codec: SecretCodec = {
      encode: (value) => (value ? `enc:${value}` : ""),
      decode: (value) => (value.startsWith("enc:") ? value.slice(4) : value),
    };
    const store = new SettingsStore(join(dir, "settings.json"), codec);

    await store.save({
      theme: "dark",
      locale: "en-US",
      ai: { enabled: true, provider: "openai", model: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1", apiKey: "sk-secret-key-1234", timeoutMs: 45_000 },
      github: { token: "github_pat_secret_1234" },
      recentProjects: [],
    });
    await store.rememberProject({ path: "C:/projects/alpha", name: "alpha", openedAt: 1 });
    await store.rememberProject({ path: "C:/projects/beta", name: "beta", openedAt: 2 });

    const afterRemove = await store.removeRecentProject("C:/projects/alpha");
    expect(afterRemove.locale).toBe("en-US");
    expect(afterRemove.recentProjects.map((p) => p.name)).toEqual(["beta"]);
    // Renderer response must redact plaintext secrets while keeping presence flags.
    expect(afterRemove.ai.apiKey).toBe("");
    expect(afterRemove.github.token).toBe("");
    expect(afterRemove.secrets?.hasApiKey).toBe(true);
    expect(afterRemove.secrets?.hasGithubToken).toBe(true);

    // Main-process load still has intact decrypted secrets.
    const full = await store.load();
    expect(full.ai.apiKey).toBe("sk-secret-key-1234");
    expect(full.github.token).toBe("github_pat_secret_1234");
  });

  it("rejects symlink .bak files during backup status and restore", async () => {
    const root = await copyFixtureProject();
    const outside = await mkdtemp(join(tmpdir(), "confui-outside-"));
    tempDirs.push(outside);
    const outsideFile = join(outside, "secret.yaml");
    await writeFile(outsideFile, "secret: leaked\n", "utf8");

    const bakPath = join(root, "app.yaml.bak");
    try {
      await symlink(outsideFile, bakPath);
    } catch {
      // Symlink creation on Windows without Developer Mode may fail with EPERM; skip only that assertion if OS denies.
      return;
    }

    expect((await getBackupStatus(root, "app.yaml")).exists).toBe(false);
    const snap = await readTextSnapshot(join(root, "app.yaml"));
    await expect(previewRestoreBackup(root, "app.yaml", snap.version)).rejects.toThrow();
  });

  it("handles TOML fallback cleanly when editing nested inline tables", () => {
    const src = "# comment\ninline = { a = 1, b = 2 }\n";
    const result = updateConfigText(src, "toml", [{ segments: ["inline", "a"], value: 9 }]);
    expect(result.warnings.length).toBe(1);
    expect(parseConfig(result.output, "toml")).toMatchObject({ inline: { a: 9, b: 2 } });
  });
});
