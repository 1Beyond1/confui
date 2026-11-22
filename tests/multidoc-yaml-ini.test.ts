import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEditableSyntax,
  detectFormat,
  extractYamlDocumentSummaries,
  isUnambiguousIniName,
  parseConfig,
  parseYamlDocuments,
  updateConfigText,
} from "../core/formats.ts";
import { inferConfig } from "../core/inference/index.ts";
import { commitSave, generateRedactedExport, previewSave } from "../core/save.ts";
import { scanProject } from "../core/scanner.ts";
import { searchProjectConfigs } from "../core/search.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("C3a: Multi-document YAML lossless editing & .editorconfig / .npmrc native INI support", () => {
  it("extracts K8s kind/metadata.name and Spring Boot on-profile labels cleanly", () => {
    const k8sYaml = `# Deployment manifest
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-frontend
spec:
  replicas: 2
---
# Service manifest
apiVersion: v1
kind: Service
metadata:
  name: web-svc
spec:
  # Preserve unusual spacing in untouched doc
  port:    80
---
apiVersion: v1
kind: Secret
metadata:
  name: app-creds
stringData:
  db_password: k8s-prod-password-123
`;

    const k8sSummaries = extractYamlDocumentSummaries(k8sYaml);
    expect(k8sSummaries).toHaveLength(3);
    expect(k8sSummaries[0]).toMatchObject({ index: 0, label: "Deployment/web-frontend", kind: "Deployment", name: "web-frontend" });
    expect(k8sSummaries[1]).toMatchObject({ index: 1, label: "Service/web-svc", kind: "Service", name: "web-svc" });
    expect(k8sSummaries[2]).toMatchObject({ index: 2, label: "Secret/app-creds", kind: "Secret", name: "app-creds" });

    const springYaml = `spring:
  application:
    name: billing-service
server:
  port: 8080
---
spring:
  config:
    activate:
      on-profile: dev
server:
  port: 8081
---
spring:
  config:
    activate:
      on-profile: prod
server:
  port: 9090
`;

    const springSummaries = extractYamlDocumentSummaries(springYaml);
    expect(springSummaries).toHaveLength(3);
    expect(springSummaries[0]?.label).toBe("default (billing-service)");
    expect(springSummaries[1]).toMatchObject({ index: 1, label: "profile: dev", profile: "dev" });
    expect(springSummaries[2]).toMatchObject({ index: 2, label: "profile: prod", profile: "prod" });
  });

  it("preserves sibling documents 100% byte-for-byte when editing any document in multi-doc YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-multidoc-yaml-"));
    temporaryDirectories.push(root);

    const k8sSource = `# File-level K8s header
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-server # keep inline note
spec:
  replicas: 2
---
# Untouched Service doc with quirky formatting
apiVersion: v1
kind: Service
metadata:
  name: api-svc
spec:
  type:    ClusterIP
  port:    8080 # keep svc port comment
---
# Untouched ConfigMap doc
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  LOG_LEVEL: "info"
`;
    await writeFile(join(root, "k8s.yaml"), k8sSource, "utf8");

    // 1. Infer doc 0 and edit spec.replicas -> 5; doc 1 and doc 2 MUST remain byte-for-byte untouched!
    const doc0Schema = await inferConfig(root, "k8s.yaml", { documentIndex: 0 });
    expect(doc0Schema.activeDocumentIndex).toBe(0);
    expect(doc0Schema.yamlDocuments?.map((d) => d.label)).toEqual([
      "Deployment/api-server",
      "Service/api-svc",
      "ConfigMap/api-config",
    ]);

    const preview0 = await previewSave(
      root,
      "k8s.yaml",
      [{ segments: ["spec", "replicas"], value: 5 }],
      doc0Schema.version,
      0,
    );
    expect(preview0.warnings).toEqual([]);
    expect(preview0.documentIndex).toBe(0);
    expect(preview0.output).toContain("# File-level K8s header");
    expect(preview0.output).toContain("name: api-server # keep inline note");
    expect(preview0.output).toContain("replicas: 5");
    // Sibling doc 1 weird formatting & comments 100% untouched!
    expect(preview0.output).toContain("# Untouched Service doc with quirky formatting");
    expect(preview0.output).toContain("  type:    ClusterIP");
    expect(preview0.output).toContain("  port:    8080 # keep svc port comment");
    expect(preview0.output).toContain('  LOG_LEVEL: "info"');

    const saved0 = await commitSave(root, preview0);

    // 2. Switch to doc 2 (ConfigMap) and update LOG_LEVEL -> "debug"; doc 0 and doc 1 remain 100% untouched!
    const doc2Schema = await inferConfig(root, "k8s.yaml", { documentIndex: 2 });
    expect(doc2Schema.activeDocumentIndex).toBe(2);
    expect(doc2Schema.fields.find((f) => f.path === "data.LOG_LEVEL")?.value).toBe("info");

    const preview2 = await previewSave(
      root,
      "k8s.yaml",
      [{ segments: ["data", "LOG_LEVEL"], value: "debug" }],
      saved0.version,
      2,
    );
    expect(preview2.warnings).toEqual([]);
    await commitSave(root, preview2);

    const diskContent = await readFile(join(root, "k8s.yaml"), "utf8");
    const docsAfter = parseYamlDocuments(diskContent);
    expect(docsAfter).toHaveLength(3);
    expect(docsAfter[0]?.value).toMatchObject({ kind: "Deployment", spec: { replicas: 5 } });
    expect(docsAfter[1]?.value).toMatchObject({ kind: "Service", spec: { port: 8080 } });
    expect(docsAfter[2]?.value).toMatchObject({ kind: "ConfigMap", data: { LOG_LEVEL: "debug" } });
    // Weird spacing in doc 1 survived TWO separate saves to doc 0 and doc 2!
    expect(diskContent).toContain("  type:    ClusterIP");
    expect(diskContent).toContain("  port:    8080 # keep svc port comment");

    // 3. CRLF line endings stay intact across multi-doc edits
    const crlfSource = "kind: Deployment\r\nspec:\r\n  replicas: 1\r\n---\r\nkind: Service\r\nspec:\r\n  port:    90\r\n";
    const crlfUpdated = updateConfigText(crlfSource, "yaml", [{ segments: ["spec", "replicas"], value: 3 }], {
      documentIndex: 0,
    });
    expect(crlfUpdated.output).toBe(
      "kind: Deployment\r\nspec:\r\n  replicas: 3\r\n---\r\nkind: Service\r\nspec:\r\n  port:    90\r\n",
    );

    // 4. Out-of-range documentIndex is rejected
    expect(() => parseConfig(k8sSource, "yaml", { documentIndex: 5 })).toThrow(/文档索引/);
  });

  it("searches across all YAML documents and redacts secrets in every document during redacted export", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-multidoc-sec-"));
    temporaryDirectories.push(root);

    await writeFile(join(root, "application.yml"), `spring:
  application:
    name: payments
  datasource:
    password: dev-plain-password-111
---
spring:
  config:
    activate:
      on-profile: prod
  datasource:
    password: prod-plain-password-999
    host: prod-db.internal
`, "utf8");

    // Cross-file search finds doc 1 keys with documentIndex & documentLabel, never exposes secret values
    const hostSearch = await searchProjectConfigs(root, "prod-db.internal");
    expect(hostSearch.hits[0]).toMatchObject({
      file: "application.yml",
      path: "spring.datasource.host",
      documentIndex: 1,
      documentLabel: "profile: prod",
      secret: false,
    });
    const secretValSearch = await searchProjectConfigs(root, "prod-plain-password-999");
    expect(secretValSearch.hits).toHaveLength(0);

    // Redacted export MUST scrub passwords in BOTH doc 0 AND doc 1!
    const redacted = await generateRedactedExport(root, "application.yml");
    expect(redacted.content).not.toContain("dev-plain-password-111");
    expect(redacted.content).not.toContain("prod-plain-password-999");
    expect(redacted.content).toContain("prod-db.internal");
    expect(parseYamlDocuments(redacted.content)).toHaveLength(2);
  });

  it("recognizes .editorconfig and .npmrc as native INI configs with safe patching and token redaction", async () => {
    expect(detectFormat(".editorconfig")).toBe("ini");
    expect(detectFormat(".npmrc")).toBe("ini");
    expect(isUnambiguousIniName(".editorconfig")).toBe(true);
    expect(isUnambiguousIniName(".npmrc")).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "confui-dotini-"));
    temporaryDirectories.push(root);

    const editorconfig = `# Project code style
root = true

[*]
indent_style = space
indent_size = 2 # two spaces default
end_of_line = lf
trim_trailing_whitespace = true

[*.{ts,tsx}]
indent_size = 2
`;
    const npmrc = `# Registry mirrors
registry=https://registry.npmjs.org/
@myorg:registry=https://npm.pkg.github.com/
//registry.npmjs.org/:_authToken=npm_1234567890abcdefghijklmnop
save-exact=false # pin versions
`;

    await writeFile(join(root, ".editorconfig"), editorconfig, "utf8");
    await writeFile(join(root, ".npmrc"), npmrc, "utf8");

    // Scanner discovers both as high-confidence "known" INI files
    const scan = await scanProject(root);
    const ecFile = scan.files.find((f) => f.path === ".editorconfig");
    const npmFile = scan.files.find((f) => f.path === ".npmrc");
    expect(ecFile).toMatchObject({ format: "ini", confidence: "known", status: "ready" });
    expect(npmFile).toMatchObject({ format: "ini", confidence: "known", status: "ready" });

    assertEditableSyntax(".editorconfig", editorconfig);
    assertEditableSyntax(".npmrc", npmrc);

    // .editorconfig round-trip edit preserves comments and [*.{ts,tsx}] section
    const ecSchema = await inferConfig(root, ".editorconfig");
    expect(ecSchema.fields.find((f) => f.path === "root")?.value).toBe(true);
    const ecPreview = await previewSave(
      root,
      ".editorconfig",
      [{ segments: ["*", "indent_size"], value: 4 }],
      ecSchema.version,
    );
    expect(ecPreview.output).toContain("# Project code style");
    expect(ecPreview.output).toContain("indent_size = 4 # two spaces default");
    expect(ecPreview.output).toContain("[*.{ts,tsx}]");
    await commitSave(root, ecPreview);
    expect(parseConfig(await readFile(join(root, ".editorconfig"), "utf8"), "ini")).toMatchObject({
      root: true,
      "*": { indent_size: "4" },
    });

    // .npmrc parses colon-containing keys accurately, marks _authToken secret, and redacts cleanly
    const npmSchema = await inferConfig(root, ".npmrc");
    expect(npmSchema.fields.find((f) => f.segments[0] === "@myorg:registry")?.value).toBe("https://npm.pkg.github.com/");
    const authField = npmSchema.fields.find((f) => f.segments[0] === "//registry.npmjs.org/:_authToken");
    expect(authField).toBeDefined();
    expect(authField?.secret).toBe(true);
    expect(authField?.type).toBe("secret");

    const npmPreview = await previewSave(
      root,
      ".npmrc",
      [{ segments: ["save-exact"], value: true }],
      npmSchema.version,
    );
    expect(npmPreview.output).toContain("# Registry mirrors");
    expect(npmPreview.output).toContain("save-exact=true # pin versions");
    expect(npmPreview.output).toContain("@myorg:registry=https://npm.pkg.github.com/");
    expect(npmPreview.output).toContain("//registry.npmjs.org/:_authToken=npm_1234567890abcdefghijklmnop");

    // Redacted export & search MUST never expose the npm auth token
    const npmRedacted = await generateRedactedExport(root, ".npmrc");
    expect(npmRedacted.content).not.toContain("npm_1234567890abcdefghijklmnop");
    expect(npmRedacted.content).toContain("@myorg:registry=https://npm.pkg.github.com/");

    const npmSecretSearch = await searchProjectConfigs(root, "npm_1234567890");
    expect(npmSecretSearch.hits).toHaveLength(0);
  });
});
