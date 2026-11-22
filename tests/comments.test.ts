import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractCommentMap, inferCommentFields } from "../core/inference/comments.ts";
import { inferConfig } from "../core/inference/index.ts";
import { pathKey } from "../core/paths.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("local AST/CST comment extraction across all 6 formats", () => {
  it("extracts leading and trailing comments from YAML CST including nested first keys and multi-doc isolation", () => {
    const yaml = `# yaml-language-server: $schema=./app.schema.json
# File header banner

# HTTP server settings
server:
  # Listening port for HTTP traffic
  port: 3000 # range 1..65535
  # Bind host address
  host: "127.0.0.1"
  tls:
    # Enable HTTPS listener
    enabled: false # production only
---
# Second document header
service:
  # Worker pool concurrency
  workers: 4 # CPU cores
`;

    const doc0 = extractCommentMap(yaml, "yaml", { documentIndex: 0 });
    expect(doc0.get(pathKey(["server", "port"]))?.comment).toBe("Listening port for HTTP traffic — range 1..65535");
    expect(doc0.get(pathKey(["server", "host"]))?.comment).toBe("Bind host address");
    expect(doc0.get(pathKey(["server", "tls", "enabled"]))?.comment).toBe("Enable HTTPS listener — production only");
    // Schema directive and second document comments must not leak into doc 0.
    expect(doc0.get(pathKey(["server"]))?.comment).toBe("HTTP server settings");
    expect(doc0.get(pathKey(["service", "workers"]))).toBeUndefined();

    const doc1 = extractCommentMap(yaml, "yaml", { documentIndex: 1 });
    expect(doc1.get(pathKey(["service", "workers"]))?.comment).toBe("Worker pool concurrency — CPU cores");
    expect(doc1.get(pathKey(["server", "port"]))).toBeUndefined();
  });

  it("extracts JSONC line, block, and inline comments accurately without misattributing inline sibling objects", () => {
    const jsonc = `{
  // File header separated by blank line

  "$schema": "./schema.json",
  // Top-level server object
  "server": { "port": 3000 }, // single-line server note
  /**
   * Primary database settings
   */
  "database": {
    // Connection timeout in ms
    "timeout": 5000, // default 5s
    "url": "https://example.com//not-a-comment" // actual inline note
  },
  "configurations": [
    {
      // Launch entry target
      "program": "dist/index.js"
    }
  ]
}
`;

    const map = extractCommentMap(jsonc, "jsonc");
    // Single-line `"server": { "port": 3000 }` must attach comments to `server`, NOT steal onto `server.port`.
    expect(map.get(pathKey(["server"]))?.comment).toBe("Top-level server object — single-line server note");
    expect(map.get(pathKey(["server", "port"]))).toBeUndefined();
    expect(map.get(pathKey(["database"]))?.comment).toBe("Primary database settings");
    expect(map.get(pathKey(["database", "timeout"]))?.comment).toBe("Connection timeout in ms — default 5s");
    expect(map.get(pathKey(["database", "url"]))?.comment).toBe("actual inline note");
    expect(map.get(pathKey(["configurations", 0, "program"]))?.comment).toBe("Launch entry target");
  });

  it("extracts TOML leading, trailing, section, and array-of-tables comments while ignoring #:schema pragmas", () => {
    const toml = `#:schema https://json.schemastore.org/cargo.json
# ----------------

[package]
# Package display name
name = "confui" # crate name
# Target edition
edition = "2021"
note = "hash # inside string" # real trailing note

[[bin]]
# Primary CLI binary
name = "confui-cli"
path = "src/main.rs" # entry file

[[bin]]
# Secondary helper binary
name = "confui-helper"
`;

    const map = extractCommentMap(toml, "toml");
    expect(map.get(pathKey(["package", "name"]))?.comment).toBe("Package display name — crate name");
    expect(map.get(pathKey(["package", "edition"]))?.comment).toBe("Target edition");
    expect(map.get(pathKey(["package", "note"]))?.comment).toBe("real trailing note");
    expect(map.get(pathKey(["bin", 0, "name"]))?.comment).toBe("Primary CLI binary");
    expect(map.get(pathKey(["bin", 0, "path"]))?.comment).toBe("entry file");
    expect(map.get(pathKey(["bin", 1, "name"]))?.comment).toBe("Secondary helper binary");
  });

  it("extracts ENV leading and quote-aware inline comments while ignoring file header banners", () => {
    const env = `# Environment configuration banner

# Public base URL for callbacks
export APP_URL="https://app.example.com#anchor" # keep fragment intact
# Worker concurrency
WORKERS=8 # recommended: 2x cores
`;

    const map = extractCommentMap(env, "env");
    expect(map.get(pathKey(["APP_URL"]))?.comment).toBe("Public base URL for callbacks — keep fragment intact");
    expect(map.get(pathKey(["WORKERS"]))?.comment).toBe("Worker concurrency — recommended: 2x cores");
  });

  it("extracts INI, .editorconfig, and .npmrc comments with section scoping and colon-in-key support", () => {
    const iniText = `; Global banner

# Stop upward traversal
root = true

[server]
; Listening host
host = 127.0.0.1 # loopback only
# Listening port
port = 8080 ; default HTTP alt
`;

    const map = extractCommentMap(iniText, "ini");
    expect(map.get(pathKey(["root"]))?.comment).toBe("Stop upward traversal");
    expect(map.get(pathKey(["server", "host"]))?.comment).toBe("Listening host — loopback only");
    expect(map.get(pathKey(["server", "port"]))?.comment).toBe("Listening port — default HTTP alt");

    const npmrc = `# Scoped registry mirror
@myorg:registry=https://npm.pkg.github.com/
# Always lock exact dependency versions
save-exact=true ; avoid caret drift
`;
    const npmrcMap = extractCommentMap(npmrc, "ini");
    expect(npmrcMap.get(pathKey(["@myorg:registry"]))?.comment).toBe("Scoped registry mirror");
    expect(npmrcMap.get(pathKey(["save-exact"]))?.comment).toBe("Always lock exact dependency versions — avoid caret drift");
  });

  it("extracts .properties leading # and ! comments without misinterpreting # inside values", () => {
    const props = `! Application properties banner

# Display title for the desktop UI
app.title = Confui # not a comment in properties
! Multi-line search directories
app.paths = /opt/one \\
  /opt/two
`;

    const map = extractCommentMap(props, "properties");
    expect(map.get(pathKey(["app.title"]))?.comment).toBe("Display title for the desktop UI");
    expect(map.get(pathKey(["app.paths"]))?.comment).toBe("Multi-line search directories");
  });

  it("strictly redacts secrets embedded in comments via maskDocumentSecrets before emitting candidates", () => {
    const sensitiveEnv = `# Example: postgres://admin:topsecret99@db.internal:5432/app
DATABASE_URL=postgres://admin:topsecret99@db.internal:5432/app
# Fallback token=sk-live-secret9876543210abcd or Authorization: Bearer secret-bearer-999
API_KEY=sk-live-secret9876543210abcd
# -----BEGIN RSA PRIVATE KEY-----
# MIIEowIBAAKCAQEAnSuperSecretPemBodyLine
# -----END RSA PRIVATE KEY-----
SIGNING_KEY=custom-secret-value-xyz
# Note referencing raw custom-secret-value-xyz
CUSTOM_NOTE=hello
`;

    const candidates = inferCommentFields(sensitiveEnv, "env", {
      secretValues: ["custom-secret-value-xyz"],
    });
    const byPath = new Map(candidates.map((c) => [pathKey(c.segments), c.description ?? ""]));

    expect(byPath.get(pathKey(["DATABASE_URL"]))).toContain("postgres://***:***@db.internal:5432/app");
    expect(byPath.get(pathKey(["DATABASE_URL"]))).not.toContain("topsecret99");

    expect(byPath.get(pathKey(["API_KEY"]))).not.toContain("sk-live-secret9876543210abcd");
    expect(byPath.get(pathKey(["API_KEY"]))).not.toContain("secret-bearer-999");

    expect(byPath.get(pathKey(["SIGNING_KEY"]))).not.toContain("MIIEowIBAAKCAQEAnSuperSecretPemBodyLine");
    expect(byPath.get(pathKey(["SIGNING_KEY"]))).toContain("***");

    expect(byPath.get(pathKey(["CUSTOM_NOTE"]))).not.toContain("custom-secret-value-xyz");
    expect(byPath.get(pathKey(["CUSTOM_NOTE"]))).toContain("***");
  });

  it("integrates local comments as a high-confidence source in inferConfig without collapsing expanded children", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-comments-infer-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "app.yaml"), `# Server section
server:
  # Primary HTTP listen port
  port: 4000
  # Graceful shutdown timeout in seconds
  shutdownTimeout: 15
`, "utf8");
    await writeFile(join(root, "README.md"), `| Field | Description |
| --- | --- |
| server.port | Generic README port description |
`, "utf8");

    const schema = await inferConfig(root, "app.yaml", { locale: "en-US" });
    const port = schema.fields.find((f) => f.path === "server.port");
    const timeout = schema.fields.find((f) => f.path === "server.shutdownTimeout");

    // Local file comment wins over README, and parent `server` comment never collapses `server.port`.
    expect(port).toMatchObject({
      value: 4000,
      description: "Primary HTTP listen port",
      source: "comment",
    });
    expect(timeout).toMatchObject({
      value: 15,
      description: "Graceful shutdown timeout in seconds",
      source: "comment",
    });
    expect(schema.sources.some((s) => s.source === "comment" && s.fieldCount >= 2)).toBe(true);
  });
});
