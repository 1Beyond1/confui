import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanProject } from "../core/scanner.ts";
import { extractFileComments, searchProjectConfigs } from "../core/search.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cross-file project config search", () => {
  it("searches key paths, non-secret values and comments across supported formats", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-search-"));
    tempDirs.push(root);
    await mkdir(join(root, "config"));
    await Promise.all([
      writeFile(
        join(root, ".env"),
        "# Primary gateway timeout note\nAPP_NAME=confui-gateway\nAPI_TOKEN=super-secret-value-999\n",
        "utf8",
      ),
      writeFile(
        join(root, "config", "app.jsonc"),
        '{\n  // HTTP timeout in seconds\n  "server": { "host": "gateway.internal", "timeout": 30 },\n  "url": "https://example.com"\n}\n',
        "utf8",
      ),
      writeFile(
        join(root, "settings.yaml"),
        "# YAML worker pool\nworkers: 4\ndb_password: ultra-hidden-password\n",
        "utf8",
      ),
      // Directive-style .conf should be skipped as unsupported
      writeFile(join(root, "nginx.conf"), "http {\n  # gateway directive\n  listen 80;\n}\n", "utf8"),
    ]);

    // 1. Key path + comment hits across files
    const timeoutRes = await searchProjectConfigs(root, "timeout");
    expect(timeoutRes.searchedFiles).toBe(3);
    expect(timeoutRes.skippedFiles).toBe(1); // nginx.conf
    expect(timeoutRes.hits.some((h) => h.file === "config/app.jsonc" && h.path === "server.timeout" && h.matchKind === "path")).toBe(true);
    expect(timeoutRes.hits.some((h) => h.file === ".env" && h.matchKind === "comment")).toBe(true);

    // 2. Non-secret value hits
    const gatewayRes = await searchProjectConfigs(root, "gateway");
    expect(gatewayRes.hits.some((h) => h.file === ".env" && h.path === "APP_NAME" && h.matchKind === "value")).toBe(true);
    expect(gatewayRes.hits.some((h) => h.file === "config/app.jsonc" && h.path === "server.host" && h.matchKind === "value")).toBe(true);
    // Unsupported nginx.conf must not appear
    expect(gatewayRes.hits.some((h) => h.file === "nginx.conf")).toBe(false);
  });

  it("strictly masks secret hits by path and never searches inside secret values or commented secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-search-secret-"));
    tempDirs.push(root);
    await writeFile(
      join(root, ".env"),
      [
        "# commented backup: API_KEY=sk-nevermatchthissecret999",
        "API_TOKEN=my-ultra-secret-token-777",
        "DB_PASSWORD=top-secret-password-888",
        "CUSTOM_FIELD=sk-embeddedvendor1234567890",
        "PUBLIC_LABEL=visible-label",
      ].join("\n") + "\n",
      "utf8",
    );

    // Searching by key path hits the secret field but redacts preview completely
    const tokenHits = await searchProjectConfigs(root, "API_TOKEN");
    expect(tokenHits.hits).toHaveLength(1);
    expect(tokenHits.hits[0]).toMatchObject({
      file: ".env",
      path: "API_TOKEN",
      matchKind: "path",
      secret: true,
      preview: "••••••••",
      line: 2,
    });

    // Searching by secret value itself MUST return 0 hits (never act as a secret oracle)
    const leakToken = await searchProjectConfigs(root, "ultra-secret-token-777");
    expect(leakToken.hits).toEqual([]);

    const leakPass = await searchProjectConfigs(root, "top-secret-password-888");
    expect(leakPass.hits).toEqual([]);

    const leakComment = await searchProjectConfigs(root, "sk-nevermatchthissecret999");
    expect(leakComment.hits).toEqual([]);

    // Unnamed field holding a vendor token signature is also treated as secret
    const leakVendor = await searchProjectConfigs(root, "embeddedvendor1234567890");
    expect(leakVendor.hits).toEqual([]);
    const customPathHit = await searchProjectConfigs(root, "CUSTOM_FIELD");
    expect(customPathHit.hits[0]).toMatchObject({ secret: true, preview: "••••••••" });
  });

  it("enforces result count limits and total byte budgets cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-search-limits-"));
    tempDirs.push(root);
    const lines = Array.from({ length: 40 }, (_, i) => `ITEM_${i}=shared_value_${i}`).join("\n") + "\n";
    await Promise.all([
      writeFile(join(root, "a.env"), lines, "utf8"),
      writeFile(join(root, "b.env"), lines, "utf8"),
      writeFile(join(root, "c.env"), lines, "utf8"),
    ]);

    const limited = await searchProjectConfigs(root, "shared_value", { limit: 10, concurrency: 2 });
    expect(limited.hits).toHaveLength(10);
    expect(limited.truncated).toBe(true);

    // Strict total byte budget skips remaining files
    const tightBudget = await searchProjectConfigs(root, "shared_value", { maxTotalBytes: 1_024, concurrency: 1 });
    expect(tightBudget.truncated).toBe(true);
    expect(tightBudget.skippedFiles).toBeGreaterThanOrEqual(1);
  });

  it("extracts comments quote-aware without false positives on URLs or hex colors", () => {
    const jsoncComments = extractFileComments(
      '{\n  "url": "https://example.com/path",\n  // real comment\n  "color": "#2563eb" /* block */\n}',
      "jsonc",
    );
    expect(jsoncComments).toEqual([
      { line: 3, text: "real comment" },
      { line: 4, text: "block" },
    ]);

    const yamlComments = extractFileComments(
      'color: "#2563eb" # accent color\n# top note\n',
      "yaml",
    );
    expect(yamlComments).toEqual([
      { line: 1, text: "accent color" },
      { line: 2, text: "top note" },
    ]);

    // YAML block scalar `#` content must NOT be misclassified as comments (header comment IS kept)
    const yamlBlockComments = extractFileComments(
      [
        "script: | # real header comment",
        "  # bash comment inside block",
        "  echo hello # inline inside block",
        "next: 1 # real trailing comment",
      ].join("\n"),
      "yaml",
    );
    expect(yamlBlockComments).toEqual([
      { line: 1, text: "real header comment" },
      { line: 4, text: "real trailing comment" },
    ]);

    // TOML triple-quoted multi-line strings must NOT leak `#` lines as comments
    const tomlBlockComments = extractFileComments(
      [
        'body = """',
        "# heading inside multiline string",
        'value = 1 # not a comment',
        '""" # real toml comment',
        "lit = '''",
        "# literal multiline hash",
        "'''",
        "# top toml comment",
      ].join("\n"),
      "toml",
    );
    expect(tomlBlockComments).toEqual([
      { line: 4, text: "real toml comment" },
      { line: 8, text: "top toml comment" },
    ]);
  });

  it("ranks path > value > comment across ALL files before truncating limit, supports AbortSignal and preScanned reuse", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-search-priority-"));
    tempDirs.push(root);
    const commentLines = Array.from({ length: 20 }, (_, i) => `# gateway note ${i}`).join("\n") + "\nA=1\n";
    const valueLines = Array.from({ length: 20 }, (_, i) => `ITEM_${i}=gateway-worker-${i}`).join("\n") + "\n";
    await Promise.all([
      writeFile(join(root, "a-comments.env"), commentLines, "utf8"),
      writeFile(join(root, "b-values.env"), valueLines, "utf8"),
      writeFile(join(root, "z-path.yaml"), "gateway: 8080\n", "utf8"),
    ]);

    const scanned = await scanProject(root);
    // Even with limit=5 and concurrency=1 (processing a-comments.env first), z-path.yaml's exact path hit MUST rank #1!
    const res = await searchProjectConfigs(root, "gateway", {
      limit: 5,
      concurrency: 1,
      preScanned: { root: scanned.root, files: scanned.files },
    });
    expect(res.truncated).toBe(true);
    expect(res.hits).toHaveLength(5);
    expect(res.hits[0]).toMatchObject({
      file: "z-path.yaml",
      path: "gateway",
      matchKind: "path",
      line: 1,
    });
    expect(res.hits.slice(1).every((h) => h.matchKind === "value")).toBe(true);

    // Pre-aborted signal returns immediately without searching any files
    const controller = new AbortController();
    controller.abort();
    const aborted = await searchProjectConfigs(root, "gateway", {
      signal: controller.signal,
      preScanned: { root: scanned.root, files: scanned.files },
    });
    expect(aborted.hits).toEqual([]);
    expect(aborted.searchedFiles).toBe(0);
  });

  it("locates accurate line numbers for identically-named keys across multiple services in YAML, TOML, JSON and INI", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-search-lines-"));
    tempDirs.push(root);
    await Promise.all([
      writeFile(
        join(root, "docker-compose.yml"),
        [
          "services:",
          "  web:",
          "    image: nginx",
          "    port: 80",
          "  api:",
          "    image: node",
          "    port: 3000",
        ].join("\n") + "\n",
        "utf8",
      ),
      writeFile(
        join(root, "services.toml"),
        [
          "[services.web]",
          "port = 80",
          "",
          "[services.api]",
          "port = 3000",
        ].join("\n") + "\n",
        "utf8",
      ),
      writeFile(
        join(root, "services.json"),
        [
          "{",
          '  "services": {',
          '    "web": {',
          '      "port": 80',
          "    },",
          '    "api": {',
          '      "port": 3000',
          "    }",
          "  }",
          "}",
        ].join("\n") + "\n",
        "utf8",
      ),
      writeFile(
        join(root, "services.ini"),
        [
          "[web]",
          "port=80",
          "",
          "[api]",
          "port=3000",
        ].join("\n") + "\n",
        "utf8",
      ),
    ]);

    const hits = (await searchProjectConfigs(root, "port")).hits;
    expect(hits.find((h) => h.file === "docker-compose.yml" && h.path === "services.web.port")?.line).toBe(4);
    expect(hits.find((h) => h.file === "docker-compose.yml" && h.path === "services.api.port")?.line).toBe(7);
    expect(hits.find((h) => h.file === "services.toml" && h.path === "services.web.port")?.line).toBe(2);
    expect(hits.find((h) => h.file === "services.toml" && h.path === "services.api.port")?.line).toBe(5);
    expect(hits.find((h) => h.file === "services.json" && h.path === "services.web.port")?.line).toBe(4);
    expect(hits.find((h) => h.file === "services.json" && h.path === "services.api.port")?.line).toBe(7);
    expect(hits.find((h) => h.file === "services.ini" && h.path === "web.port")?.line).toBe(2);
    expect(hits.find((h) => h.file === "services.ini" && h.path === "api.port")?.line).toBe(5);
  });

  it("detects and skips intra-project file symlinks via lexical lstat before reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-search-symlink-"));
    tempDirs.push(root);
    await writeFile(join(root, "real.env"), "TARGET_KEY=found\n", "utf8");
    let linkCreated = false;
    try {
      await symlink(join(root, "real.env"), join(root, "linked.env"));
      linkCreated = true;
    } catch {
      // OS may disallow file symlink creation without privileges
    }
    if (!linkCreated) return;

    // Pass preScanned explicitly referencing the symlink (simulating a TOCTOU swap after scan)
    const res = await searchProjectConfigs(root, "TARGET_KEY", {
      preScanned: {
        root,
        files: [
          {
            path: "linked.env",
            kind: "env",
            size: 17,
            modifiedAt: Date.now(),
            format: "env",
            confidence: "likely",
            status: "ready",
          },
        ],
      },
    });
    expect(res.searchedFiles).toBe(0);
    expect(res.skippedFiles).toBe(1);
    expect(res.hits).toEqual([]);
  });
});
