import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, updateConfigText } from "../core/formats.ts";
import { inferConfig } from "../core/inference/index.ts";
import { commitSave, previewSave } from "../core/save.ts";
import { searchProjectConfigs } from "../core/search.ts";
import type { FieldSpec } from "../shared/schema.ts";
import { isSensitiveKey, valueContainsSecret } from "../shared/validation.ts";
import {
  buildDeepFieldIndex,
  collectChanges,
  createDefaultObjectItem,
  createJsonDraft,
  extractCardSummary,
  fieldKey,
  initializeEditorValues,
  isNestedKeySensitive,
  isObjectArray,
  MAX_NESTED_TREE_DEPTH,
  resolveFocusField,
} from "../web/src/editor-state.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("C2: Object array cards, recursive nested object tree masking, and Ctrl+K deep jump", () => {
  it("round-trips launch.json configurations[], Cargo.toml [[bin]], and GitHub Actions steps[] edits safely", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-cards-roundtrip-"));
    temporaryDirectories.push(root);

    // 1. launch.json (JSONC with comments)
    await mkdir(join(root, ".vscode"), { recursive: true });
    const launchOriginal = `{
  // VS Code debug targets
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug API",
      "type": "node",
      "request": "launch",
      "program": "src/api.ts",
      "env": {
        "NODE_ENV": "development",
        "API_TOKEN": "sk-super-secret-launch-123456"
      }
    },
    {
      "name": "Debug Worker",
      "type": "node",
      "request": "launch",
      "program": "src/worker.ts"
    }
  ]
}
`;
    await writeFile(join(root, ".vscode", "launch.json"), launchOriginal, "utf8");
    const launchSchema = await inferConfig(root, ".vscode/launch.json");
    const configField = launchSchema.fields.find((f) => f.path === "configurations");
    expect(configField?.type).toBe("array");
    expect(isObjectArray(configField?.value)).toBe(true);

    const launchValues = initializeEditorValues(launchSchema.fields);
    const currentCards = configField!.value as Array<Record<string, unknown>>;
    // Reorder (swap 0 and 1), duplicate item, and edit program
    const updatedCards = [
      { ...currentCards[1]!, program: "src/worker-v2.ts" },
      currentCards[0]!,
      { name: "Debug CLI", type: "node", request: "launch", program: "src/cli.ts" },
    ];
    launchValues[fieldKey(configField!)] = createJsonDraft(updatedCards);

    const changes = collectChanges(launchSchema.fields, launchValues);
    const preview = await previewSave(root, ".vscode/launch.json", changes, launchSchema.version);
    expect(preview.output).toContain("// VS Code debug targets");
    await commitSave(root, preview);

    const savedLaunch = parseConfig(await readFile(join(root, ".vscode", "launch.json"), "utf8"), "jsonc") as {
      configurations: Array<{ name: string; program: string }>;
    };
    expect(savedLaunch.configurations.map((c) => c.name)).toEqual(["Debug Worker", "Debug API", "Debug CLI"]);
    expect(savedLaunch.configurations[0]?.program).toBe("src/worker-v2.ts");

    // 2. Cargo.toml [[bin]] array-of-tables round-trip
    const cargoOriginal = `[package]
name = "demo-tool"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "alpha"
path = "src/alpha.rs"

[[bin]]
name = "beta"
path = "src/beta.rs"
`;
    await writeFile(join(root, "Cargo.toml"), cargoOriginal, "utf8");
    const cargoSchema = await inferConfig(root, "Cargo.toml");
    const binField = cargoSchema.fields.find((f) => f.path === "bin");
    expect(binField?.type).toBe("array");
    expect(binField?.itemFields?.map((item) => item.key)).toEqual(["name", "path", "required-features"]);
    expect(isObjectArray(binField?.value, binField?.itemFields)).toBe(true);

    const updatedCargo = updateConfigText(cargoOriginal, "toml", [
      {
        segments: ["bin"],
        value: [
          { name: "beta", path: "src/beta.rs" },
          { name: "alpha", path: "src/alpha_v2.rs" },
          { name: "gamma", path: "src/gamma.rs" },
        ],
      },
    ]);
    const reparsedCargo = parseConfig(updatedCargo.output, "toml") as {
      package: { name: string };
      bin: Array<{ name: string; path: string }>;
    };
    expect(reparsedCargo.package.name).toBe("demo-tool");
    expect(reparsedCargo.bin).toEqual([
      { name: "beta", path: "src/beta.rs" },
      { name: "alpha", path: "src/alpha_v2.rs" },
      { name: "gamma", path: "src/gamma.rs" },
    ]);

    // 3. GitHub Actions YAML steps[] CST round-trip preserving comments
    const workflowYaml = `# CI pipeline
name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    # Build steps list
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Test
        run: npm test
`;
    const updatedWorkflow = updateConfigText(workflowYaml, "yaml", [
      {
        segments: ["jobs", "build", "steps"],
        value: [
          { name: "Checkout", uses: "actions/checkout@v4" },
          { name: "Install", run: "npm ci" },
          { name: "Test", run: "npm run check" },
        ],
      },
    ]);
    expect(updatedWorkflow.warnings).toEqual([]);
    expect(updatedWorkflow.output).toContain("# CI pipeline");
    expect(updatedWorkflow.output).toContain("# Build steps list");
    const reparsedWorkflow = parseConfig(updatedWorkflow.output, "yaml") as {
      jobs: { build: { steps: Array<{ name: string; run?: string }> } };
    };
    expect(reparsedWorkflow.jobs.build.steps).toHaveLength(3);
    expect(reparsedWorkflow.jobs.build.steps[1]?.name).toBe("Install");
  });

  it("never leaks sensitive keys or credential values in card titles, summary badges, or nested tree masking", () => {
    expect(MAX_NESTED_TREE_DEPTH).toBe(4);
    expect(isSensitiveKey("apiKey")).toBe(true);
    expect(isSensitiveKey("DATABASE_URL")).toBe(true);
    expect(isSensitiveKey("smtp_pass")).toBe(true);
    expect(isSensitiveKey("displayName")).toBe(false);

    // Card summary must skip secret titles and mask sensitive badge values
    const sensitiveCard = {
      password: "super-secret-password",
      apiKey: "sk-secret-key-999999999999",
      type: "webhook",
      host: "https://user:secretpass@hooks.internal/cb",
      port: 8443,
    };
    const summary = extractCardSummary(sensitiveCard);
    expect(summary.title).toBe("webhook");
    expect(summary.title).not.toContain("secret");
    const serializedBadges = JSON.stringify(summary.badges);
    expect(serializedBadges).not.toContain("super-secret-password");
    expect(serializedBadges).not.toContain("sk-secret-key-999999999999");
    expect(serializedBadges).not.toContain("secretpass");

    // Deep nested secret detection up to and beyond 4 levels
    const deepNested = {
      level1: {
        level2: {
          level3: {
            level4: {
              level5: {
                client_secret: "deep-secret-token-xyz",
              },
            },
          },
        },
      },
    };
    expect(valueContainsSecret(deepNested)).toBe(true);
    expect(isNestedKeySensitive("client_secret", ["service", "auth", "client_secret"], "deep-secret-token-xyz")).toBe(true);
    expect(isNestedKeySensitive("endpoint", ["service", "endpoint"], "postgres://admin:pwd@host/db")).toBe(true);
    expect(isNestedKeySensitive("host", ["service", "host"], "127.0.0.1")).toBe(false);

    // Default item creation from schema itemFields & from existing shape
    const fromSchema = createDefaultObjectItem([], [
      { key: "name", label: "Name", type: "string", required: true },
      { key: "retries", label: "Retries", type: "integer", default: 3 },
      { key: "shell", label: "Shell", type: "enum", enum: ["bash", "pwsh"], required: true },
    ]);
    expect(fromSchema).toEqual({ name: "", retries: 3, shell: "bash" });

    const fromExisting = createDefaultObjectItem([{ name: "API", port: 3000, enabled: true }]);
    expect(fromExisting).toEqual({ name: "", port: 0, enabled: false });
  });

  it("indexes nested object trees and object-array items for Ctrl+K deep jump while masking secrets", async () => {
    const fields: FieldSpec[] = [
      {
        path: "configurations",
        segments: ["configurations"],
        label: "Configurations",
        type: "array",
        value: [
          {
            name: "Debug API",
            program: "src/api.ts",
            env: {
              NODE_ENV: "development",
              API_SECRET: "ultra-secret-value-999",
            },
          },
          {
            name: "Debug Worker",
            program: "src/worker.ts",
          },
        ],
        source: "heuristic",
        confidence: 0.9,
        evidence: [],
      },
      {
        path: "services",
        segments: ["services"],
        label: "Services",
        type: "json",
        value: {
          api: {
            deploy: {
              replicas: 3,
              auth: {
                jwt_secret: "my-jwt-signing-secret-1234",
              },
            },
          },
        },
        source: "heuristic",
        confidence: 0.9,
        evidence: [],
      },
    ];
    const values = initializeEditorValues(fields);
    const deepEntries = buildDeepFieldIndex(fields, values);

    // Array card and nested card property entries exist and resolve back to enclosing parent field
    const card1 = deepEntries.find((e) => e.path === "configurations[1]");
    expect(card1).toMatchObject({ kind: "card", parentFieldPath: "configurations", secret: false });
    expect(card1?.label).toContain("Debug Worker");

    const card0Program = deepEntries.find((e) => e.path === "configurations[0].program");
    expect(card0Program).toMatchObject({
      kind: "nested",
      parentFieldPath: "configurations",
      preview: "src/api.ts",
      searchableValue: "src/api.ts",
      secret: false,
    });
    expect(resolveFocusField(fields, card0Program!.path, card0Program!.segments)?.path).toBe("configurations");

    // Deep nested object path resolves cleanly
    const replicas = deepEntries.find((e) => e.path === "services.api.deploy.replicas");
    expect(replicas).toMatchObject({ kind: "nested", parentFieldPath: "services", preview: "3", secret: false });
    expect(resolveFocusField(fields, replicas!.path, replicas!.segments)?.path).toBe("services");

    // Sensitive nested keys inside both object arrays and nested object trees MUST be masked & non-searchable by value!
    const cardSecret = deepEntries.find((e) => e.path === "configurations[0].env.API_SECRET");
    expect(cardSecret).toMatchObject({ secret: true, preview: "••••••••", searchableValue: "" });
    const treeSecret = deepEntries.find((e) => e.path === "services.api.deploy.auth.jwt_secret");
    expect(treeSecret).toMatchObject({ secret: true, preview: "••••••••", searchableValue: "" });

    const serializedIndex = JSON.stringify(deepEntries);
    expect(serializedIndex).not.toContain("ultra-secret-value-999");
    expect(serializedIndex).not.toContain("my-jwt-signing-secret-1234");

    // Cross-file searchProjectConfigs also descends into object arrays with strict secret redaction
    const root = await mkdtemp(join(tmpdir(), "confui-search-cards-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "launch.json"), JSON.stringify({
      configurations: [
        {
          name: "Launch Web",
          program: "dist/server-entry.js",
          env: { API_TOKEN: "sk-never-reveal-in-search-88888" },
        },
      ],
    }, null, 2), "utf8");

    const hitByVal = await searchProjectConfigs(root, "server-entry");
    expect(hitByVal.hits.some((h) => h.path === "configurations[0].program")).toBe(true);

    const secretValSearch = await searchProjectConfigs(root, "never-reveal-in-search");
    expect(secretValSearch.hits).toHaveLength(0);

    const secretKeySearch = await searchProjectConfigs(root, "API_TOKEN");
    expect(secretKeySearch.hits[0]).toMatchObject({
      path: "configurations[0].env.API_TOKEN",
      secret: true,
      preview: "••••••••",
    });
  });
});
