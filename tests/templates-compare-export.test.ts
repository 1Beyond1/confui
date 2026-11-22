import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfuiError } from "../core/errors.ts";
import { parseConfig } from "../core/formats.ts";
import {
  commitSave,
  compareConfigFiles,
  createConfigFromExample,
  generateRedactedExport,
  previewSyncFromFile,
  writeRedactedExport,
} from "../core/save.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("template initialization, multi-env compare/sync & redacted export", () => {
  it("creates new configs from example templates without overwriting existing targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-tpl-"));
    temporaryDirectories.push(root);
    const envExample = "# App env\nPORT=3000\nAPI_KEY=replace-me\n";
    const jsoncExample = "{\n  // keep comment\n  \"server\": { \"port\": 8080 }\n}\n";
    await Promise.all([
      writeFile(join(root, ".env.example"), envExample, "utf8"),
      writeFile(join(root, "config.example.jsonc"), jsoncExample, "utf8"),
    ]);

    const createdEnv = await createConfigFromExample(root, ".env.example");
    expect(createdEnv).toMatchObject({
      file: ".env",
      exampleFile: ".env.example",
      format: "env",
    });
    expect(await readFile(join(root, ".env"), "utf8")).toBe(envExample);

    // Calling again must fail with FILE_CONFLICT (never overwrite existing file)
    await expect(createConfigFromExample(root, ".env.example")).rejects.toMatchObject({
      code: "FILE_CONFLICT",
    } satisfies Partial<ConfuiError>);

    const createdJsonc = await createConfigFromExample(root, "config.example.jsonc");
    expect(createdJsonc.file).toBe("config.jsonc");
    expect(await readFile(join(root, "config.jsonc"), "utf8")).toContain("// keep comment");

    // Must refuse cloning non-example config files (e.g. secret-bearing .env or config.jsonc)
    await expect(createConfigFromExample(root, ".env", ".env.cloned")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<ConfuiError>);
    await expect(createConfigFromExample(root, "config.jsonc", "config.copy.jsonc")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    } satisfies Partial<ConfuiError>);
  });

  it("blocks path traversal and symlinks during createConfigFromExample", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-tpl-sec-"));
    const outside = await mkdtemp(join(tmpdir(), "confui-tpl-outside-"));
    temporaryDirectories.push(root, outside);
    await writeFile(join(root, ".env.example"), "PORT=3000\n", "utf8");
    await writeFile(join(outside, "escape.env.example"), "SECRET=outside\n", "utf8");

    await expect(createConfigFromExample(root, ".env.example", "../escape.env")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(createConfigFromExample(root, "../escape.env.example")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    // Reject symlink example file when OS permits symlink creation
    let symlinkCreated = false;
    try {
      await symlink(join(outside, "escape.env.example"), join(root, "linked.env.example"));
      symlinkCreated = true;
    } catch {
      // Windows without Developer Mode may disallow symlink creation
    }
    if (symlinkCreated) {
      await expect(createConfigFromExample(root, "linked.env.example", "linked.env")).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }

    // Reject symlink target directory
    let dirSymlinkCreated = false;
    try {
      await symlink(outside, join(root, "linked-dir"), "junction");
      dirSymlinkCreated = true;
    } catch {
      // Ignore if OS denies junction creation
    }
    if (dirSymlinkCreated) {
      await expect(createConfigFromExample(root, ".env.example", "linked-dir/.env")).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    }
  });

  it("compares multi-environment configs, marks secrets, and syncs selected keys safely with .bak", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-compare-"));
    temporaryDirectories.push(root);
    await Promise.all([
      writeFile(
        join(root, ".env.production"),
        "PORT=8080\nLOG_LEVEL=warn\nREDIS_URL=redis://prod:6379\nAPI_TOKEN=prod-secret-token\n",
        "utf8",
      ),
      writeFile(
        join(root, ".env"),
        "# local env\nPORT=3000\nDEBUG=true\nAPI_TOKEN=local-secret-token\n",
        "utf8",
      ),
    ]);

    const diff = await compareConfigFiles(root, ".env.production", ".env");
    expect(diff.summary).toEqual({
      missingInTarget: 2, // LOG_LEVEL, REDIS_URL
      different: 2,       // PORT, API_TOKEN
      onlyInTarget: 1,    // DEBUG
      same: 0,
    });

    const tokenEntry = diff.entries.find((entry) => entry.path === "API_TOKEN");
    expect(tokenEntry).toMatchObject({ status: "different", secret: true });
    const redisEntry = diff.entries.find((entry) => entry.path === "REDIS_URL");
    expect(redisEntry).toMatchObject({ status: "missing-in-target", secret: true });
    const logEntry = diff.entries.find((entry) => entry.path === "LOG_LEVEL");
    expect(logEntry).toMatchObject({ status: "missing-in-target", secret: false });

    // Sync only LOG_LEVEL and REDIS_URL into .env
    const preview = await previewSyncFromFile(
      root,
      ".env.production",
      ".env",
      [["LOG_LEVEL"], ["REDIS_URL"]],
      diff.targetVersion,
    );
    expect(preview.changes.map((c) => c.path)).toEqual(["LOG_LEVEL", "REDIS_URL"]);
    await commitSave(root, preview);

    const updatedEnv = await readFile(join(root, ".env"), "utf8");
    expect(updatedEnv).toContain("# local env");
    expect(parseConfig(updatedEnv, "env")).toEqual({
      PORT: "3000",
      DEBUG: "true",
      API_TOKEN: "local-secret-token",
      LOG_LEVEL: "warn",
      REDIS_URL: "redis://prod:6379",
    });
    expect(await readFile(join(root, ".env.bak"), "utf8")).toContain("DEBUG=true");
  });

  it("handles nested JSONC comparison with empty object containers cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-compare-nested-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "config"));
    await Promise.all([
      writeFile(join(root, "config", "app.prod.jsonc"), '{\n  "server": { "port": 8080, "host": "0.0.0.0" }\n}\n'),
      writeFile(join(root, "config", "app.jsonc"), '{\n  "server": {}\n}\n'),
    ]);

    const diff = await compareConfigFiles(root, "config/app.prod.jsonc", "config/app.jsonc");
    expect(diff.entries.map((e) => `${e.path}:${e.status}`)).toEqual([
      "server.host:missing-in-target",
      "server.port:missing-in-target",
    ]);
  });

  it("exports comment-preserving redacted copies using maskDocumentSecrets and refuses overwrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-export-"));
    temporaryDirectories.push(root);
    const original = [
      "# Service configuration",
      'API_KEY="sk-live-secret-1234567890"',
      "DATABASE_URL=postgres://admin:superpass@db.example.com/prod",
      "VAULT_CODE=custom-schema-secret",
      "WEBHOOK=https://hooks.slack.com/services/T111/B222/SECRETTOKEN",
      "PORT=3000",
    ].join("\n") + "\n";
    await writeFile(join(root, ".env"), original, "utf8");

    const preview = await generateRedactedExport(root, ".env", [["VAULT_CODE"]]);
    expect(preview.suggestedFileName).toBe(".env.example");
    expect(preview.redactedCount).toBeGreaterThanOrEqual(4);
    expect(preview.content).toContain("# Service configuration");
    expect(preview.content).toContain("PORT=3000");
    expect(preview.content).not.toContain("sk-live-secret");
    expect(preview.content).not.toContain("superpass");
    expect(preview.content).not.toContain("custom-schema-secret");
    expect(preview.content).not.toContain("SECRETTOKEN");

    // Refuses overwriting the source file
    await expect(writeRedactedExport(root, ".env", ".env")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    // Writes new redacted copy safely and refuses second overwrite
    const written = await writeRedactedExport(root, ".env", ".env.example", [["VAULT_CODE"]]);
    expect(written.file).toBe(".env.example");
    expect(await readFile(join(root, ".env.example"), "utf8")).toBe(preview.content);
    await expect(writeRedactedExport(root, ".env", ".env.example")).rejects.toMatchObject({
      code: "FILE_CONFLICT",
    });
  });

  it("redacts secret arrays, nested secret objects, value-pattern credentials, TOML triple-quotes and .properties continuations in compare and export", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-export-complex-"));
    temporaryDirectories.push(root);
    await Promise.all([
      writeFile(
        join(root, "app.json"),
        JSON.stringify({
          api_keys: ["plain-array-secret-1", "plain-array-secret-2"],
          custom_endpoints: ["https://public.example.com", "redis://:my_pass@redis.local:6379"],
          port: 3000,
        }, null, 2) + "\n",
        "utf8",
      ),
      writeFile(
        join(root, "app.prod.json"),
        JSON.stringify({
          api_keys: ["prod-array-secret"],
          custom_endpoints: ["redis://:prod_pass@redis.prod:6379"],
          port: 8080,
        }, null, 2) + "\n",
        "utf8",
      ),
      writeFile(
        join(root, "secrets.toml"),
        'api_secret = """\ntoml-secret-a\ntoml-secret-b\n"""\nport = 8080\n',
        "utf8",
      ),
      writeFile(
        join(root, "app.properties"),
        "db.password space-secret\nsmtp.pass = part1\\\n  part2\napp.name = demo\n",
        "utf8",
      ),
    ]);

    // Compare detects value-pattern secrets even under non-secret key name `custom_endpoints`
    const cmp = await compareConfigFiles(root, "app.prod.json", "app.json");
    expect(cmp.entries.find((e) => e.path === "custom_endpoints")).toMatchObject({ secret: true });
    expect(cmp.entries.find((e) => e.path === "api_keys")).toMatchObject({ secret: true });
    expect(cmp.entries.find((e) => e.path === "port")).toMatchObject({ secret: false });

    // Export redacts arrays and value-pattern array items in JSON
    const jsonExport = await generateRedactedExport(root, "app.json");
    expect(jsonExport.content).not.toContain("plain-array-secret-1");
    expect(jsonExport.content).not.toContain("plain-array-secret-2");
    expect(jsonExport.content).not.toContain("my_pass");
    expect(jsonExport.content).toContain("https://public.example.com");
    expect(jsonExport.content).toContain("3000");

    // Export redacts TOML triple-quoted multi-line secrets
    const tomlExport = await generateRedactedExport(root, "secrets.toml");
    expect(tomlExport.content).not.toContain("toml-secret-a");
    expect(tomlExport.content).not.toContain("toml-secret-b");
    expect(tomlExport.content).toContain("port = 8080");

    // Export redacts .properties whitespace-separated and backslash-continued secrets
    const propExport = await generateRedactedExport(root, "app.properties");
    expect(propExport.content).not.toContain("space-secret");
    expect(propExport.content).not.toContain("part1");
    expect(propExport.content).not.toContain("part2");
    expect(propExport.content).toContain("app.name = demo");
  });
});
