import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inferConfig } from "../core/inference/index.ts";
import {
  clearRemoteSchemaCache,
  extractSchemaDirective,
  inferJsonSchemaFields,
} from "../core/inference/json-schema.ts";
import {
  matchSchemaStoreEntry,
  readCachedSchemaStore,
  SCHEMA_STORE_CACHE_TTL_MS,
  writeCachedSchemaStore,
} from "../core/inference/schemastore.ts";
import { normalizeSettings } from "../core/settings.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  clearRemoteSchemaCache();
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("YAML / TOML $schema directives, array itemFields, and opt-in SchemaStore", () => {
  it("extracts YAML yaml-language-server and TOML #:schema directives cleanly", () => {
    expect(
      extractSchemaDirective("# yaml-language-server: $schema=./deploy.schema.json\nkind: Deployment\n", "yaml"),
    ).toBe("./deploy.schema.json");
    expect(
      extractSchemaDirective('---\n# yaml-language-server: $schema="https://json.schemastore.org/github-workflow.json"\nname: CI\n', "yaml"),
    ).toBe("https://json.schemastore.org/github-workflow.json");
    expect(
      extractSchemaDirective("#:schema ./settings.schema.json\n[server]\nport = 3000\n", "toml"),
    ).toBe("./settings.schema.json");
    expect(
      extractSchemaDirective("#:schema=https://json.schemastore.org/pyproject.json\n[project]\nname = 'demo'\n", "toml"),
    ).toBe("https://json.schemastore.org/pyproject.json");
    expect(extractSchemaDirective("port: 3000\n# yaml-language-server: $schema=./late.json\n", "yaml")).toBeUndefined();
  });

  it("infers YAML and TOML schemas via comment directives and parses object-array items.properties", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-yaml-toml-schema-"));
    temporaryDirectories.push(root);

    await writeFile(join(root, "pipeline.schema.json"), JSON.stringify({
      type: "object",
      properties: {
        name: { type: "string", title: "Workflow Name", description: "Display name in CI." },
        steps: {
          type: "array",
          title: "Job Steps",
          description: "Ordered pipeline execution steps.",
          items: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string", title: "Step Name", description: "Readable step label." },
              uses: { type: "string", title: "Action Reference", description: "Reusable GitHub Action." },
              shell: { type: "string", enum: ["bash", "pwsh", "sh"], description: "Shell runner." },
              timeout: { type: "integer", minimum: 1, maximum: 360, default: 30 },
              apiToken: { type: "string", writeOnly: true, description: "Step secret token." },
            },
          },
        },
      },
    }), "utf8");

    await writeFile(join(root, "pipeline.yml"), `# yaml-language-server: $schema=./pipeline.schema.json
name: Build & Test
steps:
  - name: Checkout
    uses: actions/checkout@v4
    shell: bash
`, "utf8");

    const yamlSchema = await inferConfig(root, "pipeline.yml", { locale: "en-US" });
    const stepsField = yamlSchema.fields.find((f) => f.path === "steps");
    expect(stepsField).toMatchObject({
      type: "array",
      label: "Job Steps",
      description: "Ordered pipeline execution steps.",
      source: "json-schema",
    });
    expect(stepsField?.itemFields).toBeDefined();
    expect(stepsField?.itemFields?.find((i) => i.key === "name")).toMatchObject({
      label: "Step Name",
      required: true,
      type: "string",
    });
    expect(stepsField?.itemFields?.find((i) => i.key === "shell")).toMatchObject({
      type: "enum",
      enum: ["bash", "pwsh", "sh"],
    });
    expect(stepsField?.itemFields?.find((i) => i.key === "timeout")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 360,
      default: 30,
    });
    expect(stepsField?.itemFields?.find((i) => i.key === "apiToken")).toMatchObject({
      type: "secret",
      secret: true,
    });

    // TOML #:schema directive with local schema
    await writeFile(join(root, "service.schema.json"), JSON.stringify({
      type: "object",
      properties: {
        server: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["dev", "prod"], description: "Runtime profile mode." },
            port: { type: "integer", minimum: 1, maximum: 65535, description: "TCP listen port." },
          },
        },
      },
    }), "utf8");
    await writeFile(join(root, "service.toml"), `#:schema ./service.schema.json
[server]
mode = "prod"
port = 8080
`, "utf8");

    const tomlSchema = await inferConfig(root, "service.toml", { locale: "en-US" });
    expect(tomlSchema.fields.find((f) => f.path === "server.mode")).toMatchObject({
      type: "enum",
      enum: ["dev", "prod"],
      description: "Runtime profile mode.",
      source: "json-schema",
    });
    expect(tomlSchema.fields.find((f) => f.path === "server.port")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 65535,
      source: "json-schema",
    });

    // Untrusted HTTPS host in YAML directive must be skipped without calling fetch.
    const evilFetcher = vi.fn<typeof fetch>();
    await writeFile(join(root, "untrusted.yml"), "# yaml-language-server: $schema=https://attacker.invalid/s.json\nport: 80\n", "utf8");
    const untrustedRes = await inferJsonSchemaFields(
      join(root, "untrusted.yml"),
      root,
      { port: 80 },
      evilFetcher,
      { format: "yaml", rawText: "# yaml-language-server: $schema=https://attacker.invalid/s.json\nport: 80\n" },
    );
    expect(evilFetcher).not.toHaveBeenCalled();
    expect(untrustedRes.warnings.join("\n")).toContain("attacker.invalid");
  });

  it("matches offline SchemaStore catalog filenames and enforces default-OFF opt-in with 7-day disk cache", async () => {
    // 1. Default setting is strictly OFF.
    expect(DEFAULT_SETTINGS.schemaStore.enabled).toBe(false);
    expect(normalizeSettings({}).schemaStore.enabled).toBe(false);

    // 2. Offline catalog mapping covers popular developer tools.
    expect(matchSchemaStoreEntry("tsconfig.json")?.url).toBe("https://json.schemastore.org/tsconfig.json");
    expect(matchSchemaStoreEntry("packages/web/tsconfig.app.json")?.url).toBe("https://json.schemastore.org/tsconfig.json");
    expect(matchSchemaStoreEntry("package.json")?.url).toBe("https://json.schemastore.org/package.json");
    expect(matchSchemaStoreEntry(".eslintrc.json")?.url).toBe("https://json.schemastore.org/eslintrc.json");
    expect(matchSchemaStoreEntry("docker-compose.yml")?.url).toBe("https://json.schemastore.org/compose-spec.json");
    expect(matchSchemaStoreEntry(".github/workflows/ci.yml")?.url).toBe("https://json.schemastore.org/github-workflow.json");
    expect(matchSchemaStoreEntry("vercel.json")?.url).toBe("https://json.schemastore.org/vercel.json");
    expect(matchSchemaStoreEntry("Cargo.toml")?.url).toBe("https://json.schemastore.org/cargo.json");
    expect(matchSchemaStoreEntry("pyproject.toml")?.url).toBe("https://json.schemastore.org/pyproject.json");
    expect(matchSchemaStoreEntry("random-custom-app.json")).toBeUndefined();

    // 3. When enableSchemaStore is omitted or false, ZERO network requests occur.
    const root = await mkdtemp(join(tmpdir(), "confui-schemastore-"));
    const cacheDir = await mkdtemp(join(tmpdir(), "confui-schemastore-cache-"));
    temporaryDirectories.push(root, cacheDir);

    await writeFile(join(root, "vercel.json"), JSON.stringify({
      framework: "nextjs",
      fluid: true,
      rewrites: [{ source: "/api/:path*", destination: "https://backend.local/:path*" }],
    }, null, 2), "utf8");

    const vercelRemoteSchema = {
      type: "object",
      properties: {
        framework: {
          type: "string",
          enum: ["nextjs", "vite", "astro"],
          description: "Detected frontend framework preset.",
        },
        fluid: {
          type: "boolean",
          description: "Enable Fluid Compute concurrency for serverless functions.",
        },
        rewrites: {
          type: "array",
          description: "URL rewrite rules.",
          items: {
            type: "object",
            required: ["source", "destination"],
            properties: {
              source: { type: "string", description: "Incoming path pattern." },
              destination: { type: "string", description: "Rewrite target URL." },
            },
          },
        },
      },
    };

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(vercelRemoteSchema));

    const offlineSchema = await inferConfig(root, "vercel.json", {
      schemaFetcher: fetcher,
      schemaStoreCacheDir: cacheDir,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(offlineSchema.schemaStore).toBeUndefined();
    expect(offlineSchema.sources.some((s) => s.source === "schemastore")).toBe(false);

    // 4. When explicitly opted in, fetches over HTTPS allowlist, labels source as "schemastore",
    // populates itemFields, and writes the 7-day disk cache.
    const onlineSchema = await inferConfig(root, "vercel.json", {
      enableSchemaStore: true,
      schemaStoreCacheDir: cacheDir,
      schemaFetcher: fetcher,
      locale: "en-US",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://json.schemastore.org/vercel.json",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(onlineSchema.schemaStore).toEqual({
      name: "Vercel",
      url: "https://json.schemastore.org/vercel.json",
      fromCache: false,
    });
    const frameworkField = onlineSchema.fields.find((f) => f.path === "framework");
    expect(frameworkField).toMatchObject({
      type: "enum",
      enum: ["nextjs", "vite", "astro"],
      source: "known-template",
    });
    expect(frameworkField?.evidence.find((e) => e.property === "enum")?.source).toBe("schemastore");
    expect(onlineSchema.fields.find((f) => f.path === "fluid")).toMatchObject({
      type: "boolean",
      source: "schemastore",
      description: "Enable Fluid Compute concurrency for serverless functions.",
    });
    expect(onlineSchema.fields.find((f) => f.path === "rewrites")?.itemFields?.map((i) => i.key)).toEqual([
      "source",
      "destination",
    ]);

    const cacheFiles = await readdir(cacheDir);
    expect(cacheFiles.length).toBe(1);

    // 5. Clearing in-memory cache still serves from the 7-day disk cache without calling fetch.
    clearRemoteSchemaCache();
    const cachedSchema = await inferConfig(root, "vercel.json", {
      enableSchemaStore: true,
      schemaStoreCacheDir: cacheDir,
      schemaFetcher: fetcher,
      locale: "en-US",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cachedSchema.schemaStore).toMatchObject({ name: "Vercel", fromCache: true });

    // 6. Expired (> 7 days) cache entry is rejected and triggers a fresh fetch.
    const cacheUrl = "https://json.schemastore.org/vercel.json";
    const now = Date.now();
    await writeCachedSchemaStore(cacheDir, cacheUrl, vercelRemoteSchema, now - SCHEMA_STORE_CACHE_TTL_MS - 1_000);
    await expect(readCachedSchemaStore(cacheDir, cacheUrl, now)).resolves.toBeUndefined();
    const rawCache = JSON.parse(await readFile(join(cacheDir, cacheFiles[0]!), "utf8")) as { fetchedAt: number };
    expect(now - rawCache.fetchedAt).toBeGreaterThan(SCHEMA_STORE_CACHE_TTL_MS);
  });
});
