import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseProject } from "../core/diagnostics.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Project Config Diagnostics Dashboard (core/diagnostics.ts)", () => {
  it("reports parse errors, schema/template violations, missing example keys, and plaintext secret alerts without leaking secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-diag-full-"));
    tempDirs.push(root);
    await mkdir(join(root, "apps", "api"), { recursive: true });

    // 1. Parse error adjacent to a secret token (must sanitize error details!)
    const secretNextToSyntaxErr = "sk-syntax-error-secret-9999999999";
    await writeFile(
      join(root, "broken.json"),
      `{\n  "apiKey": "${secretNextToSyntaxErr}",\n  "port": \n}`,
      "utf8",
    );

    // 2. JSON Schema violations (required missing, type mismatch, minimum, enum, minLength, pattern)
    await writeFile(
      join(root, "service.schema.json"),
      JSON.stringify({
        type: "object",
        required: ["serviceName", "port"],
        properties: {
          serviceName: { type: "string", minLength: 4 },
          port: { type: "integer", minimum: 1024, maximum: 65535 },
          mode: { type: "string", enum: ["dev", "prod"] },
          region: { type: "string", pattern: "^[a-z]{2}-[a-z]+-\\d+$" },
          vaultPin: { type: "string", writeOnly: true },
        },
      }),
      "utf8",
    );
    const schemaSecretVal = "vault-writeonly-secret-777777";
    await writeFile(
      join(root, "service.json"),
      JSON.stringify({
        $schema: "./service.schema.json",
        port: 80,
        mode: "staging",
        region: "INVALID_REGION",
        vaultPin: schemaSecretVal,
      }, null, 2),
      "utf8",
    );

    // 3. Built-in template violation (`package.json` missing `name`, invalid `type`)
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ version: "1.0.0", type: "invalid-module-type" }, null, 2),
      "utf8",
    );

    // 4. Companion `.env.example` missing keys + plaintext secret alerts + benign placeholders
    const realApiSecret = "sk-live-supersecret-1234567890abcdef";
    const realDbPass = "ultra_secret_db_password_2026";
    const realDsnPass = "dsn_real_password_98765";
    const realWebhookSecret = "whsec_hmac_signing_value_44444";
    await writeFile(
      join(root, "apps", "api", ".env.example"),
      [
        "PORT=3000",
        "REQUIRED_WEBHOOK_SECRET=<your-webhook-secret>",
        "FEATURE_FLAG=true",
        "API_KEY=YOUR_API_KEY",
      ].join("\n") + "\n",
      "utf8",
    );
    await writeFile(
      join(root, "apps", "api", ".env"),
      [
        "PORT=3000",
        `API_KEY=${realApiSecret}`,
        `DB_PASSWORD=${realDbPass}`,
        `WEBHOOK_SECRET=${realWebhookSecret}`,
        `DATABASE_URL=postgres://admin:${realDsnPass}@db.internal:5432/prod`,
        // Benign entries that MUST NOT trigger plaintext-secret false positives:
        "REDIS_URL=redis://localhost:6379/0",
        "WEBHOOK_URL=https://example.com/webhooks/notify",
        "PLACEHOLDER_TOKEN=YOUR_TOKEN_HERE",
        "ENV_REF_SECRET=${RUNTIME_SECRET}",
        "MASKED_SECRET=***",
        "TLS_PRIVATE_KEY=/run/secrets/tls_key.pem",
      ].join("\n") + "\n",
      "utf8",
    );

    // 5. Multi-document YAML with plaintext secret in doc 1
    const k8sSecret = "k8s-doc1-plain-secret-555555";
    await writeFile(
      join(root, "k8s.yaml"),
      [
        "kind: Deployment",
        "metadata:",
        "  name: web",
        "spec:",
        "  replicas: 2",
        "---",
        "kind: Secret",
        "metadata:",
        "  name: app-creds",
        "stringData:",
        `  db_password: ${k8sSecret}`,
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await diagnoseProject(root, { locale: "zh-CN" });

    expect(result.scannedFiles).toBe(5);
    expect(result.summary.errors).toBeGreaterThanOrEqual(5);
    expect(result.summary.warnings).toBeGreaterThanOrEqual(2);
    expect(result.summary.infos).toBeGreaterThanOrEqual(5);

    // Category 1: parse-error
    const parseIssue = result.issues.find((i) => i.file === "broken.json" && i.category === "parse-error");
    expect(parseIssue).toMatchObject({ severity: "error", category: "parse-error" });

    // Category 2: schema-violation (JSON Schema + built-in template)
    const serviceIssues = result.issues.filter((i) => i.file === "service.json" && i.category === "schema-violation");
    expect(serviceIssues.map((i) => i.path)).toEqual(expect.arrayContaining([
      "serviceName",
      "port",
      "mode",
      "region",
    ]));
    expect(serviceIssues.find((i) => i.path === "port")?.line).toBeGreaterThan(0);

    const pkgIssues = result.issues.filter((i) => i.file === "package.json" && i.category === "schema-violation");
    expect(pkgIssues.map((i) => i.path)).toEqual(expect.arrayContaining(["name", "type"]));

    // Category 3: missing-from-example in monorepo subdir
    const missingEnvIssues = result.issues.filter(
      (i) => i.file === "apps/api/.env" && i.category === "missing-from-example",
    );
    expect(missingEnvIssues.map((i) => i.path)).toEqual(expect.arrayContaining([
      "REQUIRED_WEBHOOK_SECRET",
      "FEATURE_FLAG",
    ]));
    expect(missingEnvIssues[0]).toMatchObject({
      severity: "warning",
      sourceFile: "apps/api/.env.example",
    });

    // Category 4: plaintext-secret alerts (accurate detection, zero false positives on placeholders/paths)
    const envSecretIssues = result.issues.filter(
      (i) => i.file === "apps/api/.env" && i.category === "plaintext-secret",
    );
    expect(envSecretIssues.map((i) => i.path)).toEqual(expect.arrayContaining([
      "API_KEY",
      "DB_PASSWORD",
      "WEBHOOK_SECRET",
      "DATABASE_URL",
    ]));
    expect(envSecretIssues.map((i) => i.path)).not.toContain("REDIS_URL");
    expect(envSecretIssues.map((i) => i.path)).not.toContain("WEBHOOK_URL");
    expect(envSecretIssues.map((i) => i.path)).not.toContain("PLACEHOLDER_TOKEN");
    expect(envSecretIssues.map((i) => i.path)).not.toContain("ENV_REF_SECRET");
    expect(envSecretIssues.map((i) => i.path)).not.toContain("MASKED_SECRET");
    expect(envSecretIssues.map((i) => i.path)).not.toContain("TLS_PRIVATE_KEY");

    // Schema writeOnly field in service.json & doc 1 in k8s.yaml detected with document metadata
    expect(result.issues.some((i) => i.file === "service.json" && i.path === "vaultPin" && i.category === "plaintext-secret")).toBe(true);
    const k8sSecretIssue = result.issues.find((i) => i.file === "k8s.yaml" && i.category === "plaintext-secret");
    expect(k8sSecretIssue).toMatchObject({
      path: "stringData.db_password",
      documentIndex: 1,
      documentLabel: "Secret/app-creds",
    });
    expect(k8sSecretIssue?.line).toBe(11);

    // IRONCLAD SECRET SAFETY: ZERO plaintext secret values anywhere in serialized diagnostics result!
    const serialized = JSON.stringify(result);
    for (const leaked of [
      secretNextToSyntaxErr,
      schemaSecretVal,
      realApiSecret,
      realDbPass,
      realDsnPass,
      realWebhookSecret,
      k8sSecret,
    ]) {
      expect(serialized, `Diagnostics result leaked secret ${leaked}`).not.toContain(leaked);
    }

    // English locale emits clean English messages with zero CJK characters
    const enResult = await diagnoseProject(root, { locale: "en-US" });
    expect(enResult.issues.length).toBe(result.issues.length);
    for (const issue of enResult.issues) {
      expect(issue.message).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("enforces symlink rejection, maxIssues/byte budgets, and AbortSignal cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-diag-limits-"));
    const outside = await mkdtemp(join(tmpdir(), "confui-diag-outside-"));
    tempDirs.push(root, outside);

    await writeFile(join(outside, "escape.env"), "LEAKED_KEY=sk-outside-escape-1234567890\n", "utf8");
    await writeFile(join(root, ".env"), "PORT=3000\n", "utf8");
    await writeFile(join(root, ".env.example"), "PORT=3000\nA=1\nB=2\nC=3\nD=4\n", "utf8");

    // Attempt symlink/junction escape inside project
    try {
      await symlink(outside, join(root, "linked-outside"), "junction");
    } catch {
      // Skip if OS blocks junction creation
    }

    const res = await diagnoseProject(root);
    expect(JSON.stringify(res)).not.toContain("LEAKED_KEY");
    expect(res.issues.filter((i) => i.category === "missing-from-example")).toHaveLength(4);

    // maxIssues cap sets truncated = true and keeps summary synced with returned issues
    const capped = await diagnoseProject(root, { maxIssues: 2 });
    expect(capped.truncated).toBe(true);
    expect(capped.issues).toHaveLength(2);
    expect(capped.summary.warnings).toBe(2);

    // AbortSignal cancels cleanly
    const controller = new AbortController();
    controller.abort();
    const aborted = await diagnoseProject(root, { signal: controller.signal });
    expect(aborted.issues).toEqual([]);
    expect(aborted.scannedFiles).toBe(0);
  });

  it("red-team P1-2 & P2-4: strips TOML/YAML parse-error source excerpts, flags nested dsn.password/url.api_token, and propagates scanner cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-diag-rt-"));
    tempDirs.push(root);

    // 1. Broken TOML whose preceding context line holds a secret under a generic key name (`value`)
    const tomlNeighborSecret = "secret_under_table_88888";
    await writeFile(
      join(root, "broken.toml"),
      `[credentials]\nvalue = "${tomlNeighborSecret}"\nbad = @@@\nnext = 1\n`,
      "utf8",
    );
    const tomlEofSecret = "secret_before_eof_77777";
    await writeFile(
      join(root, "broken-eof.toml"),
      `[credentials]\nvalue = "${tomlEofSecret}"\nbad = [\n`,
      "utf8",
    );

    // 2. Broken YAML whose preceding lines hold a multi-line PEM private key body
    const yamlPemSecret = "MIIEvQIBADANBgkqhkiG9w0BAQEF_SECRET_CCC333";
    await writeFile(
      join(root, "broken.yaml"),
      `private_key: |\n  -----BEGIN PRIVATE KEY-----\n  ${yamlPemSecret}\n invalid_indent: 1\n`,
      "utf8",
    );

    // 3. Nested secret fields under URL/DSN parent sections (`dsn.password`, `url.api_token`)
    const nestedDsnPassword = "super-nested-dsn-password-1111";
    const nestedUrlToken = "super-nested-url-token-2222";
    await writeFile(
      join(root, "nested-secrets.json"),
      JSON.stringify({
        dsn: {
          url: "postgres://localhost:5432/app",
          password: nestedDsnPassword,
        },
        url: {
          endpoint: "https://api.example.com",
          api_token: nestedUrlToken,
        },
      }, null, 2),
      "utf8",
    );

    const res = await diagnoseProject(root, { locale: "zh-CN" });

    // TOML parse-errors (both caret mid-file and EOF) report line 3 without echoing neighbor secrets
    const tomlIssue = res.issues.find((i) => i.file === "broken.toml" && i.category === "parse-error");
    expect(tomlIssue).toMatchObject({ severity: "error", category: "parse-error", line: 3 });
    const tomlEofIssue = res.issues.find((i) => i.file === "broken-eof.toml" && i.category === "parse-error");
    expect(tomlEofIssue).toMatchObject({ severity: "error", category: "parse-error", line: 3 });

    // YAML parse-error reported without echoing PEM body
    const yamlIssue = res.issues.find((i) => i.file === "broken.yaml" && i.category === "parse-error");
    expect(yamlIssue).toMatchObject({ severity: "error", category: "parse-error" });

    // Nested dsn.password & url.api_token ARE flagged; plain dsn.url without credentials is NOT
    const nestedSecretPaths = res.issues
      .filter((i) => i.file === "nested-secrets.json" && i.category === "plaintext-secret")
      .map((i) => i.path);
    expect(nestedSecretPaths).toEqual(expect.arrayContaining(["dsn.password", "url.api_token"]));
    expect(nestedSecretPaths).not.toContain("dsn.url");
    expect(nestedSecretPaths).not.toContain("url.endpoint");

    // ZERO secret value leakage across the entire serialized diagnostic payload
    const serialized = JSON.stringify(res);
    for (const secret of [tomlNeighborSecret, tomlEofSecret, yamlPemSecret, nestedDsnPassword, nestedUrlToken]) {
      expect(serialized, `Leaked secret ${secret}`).not.toContain(secret);
    }

    // Scanner cap (`capped: true`) propagates to `result.truncated`
    const cappedRes = await diagnoseProject(root, {
      preScanned: { root, files: [], capped: true },
    });
    expect(cappedRes.truncated).toBe(true);
  });
});
