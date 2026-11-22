import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractYamlDocumentSummaries,
  looksLikeIni,
  parseConfig,
  parseYamlDocuments,
  updateConfigText,
} from "../core/formats.ts";
import { matchIniSectionHeader, patchIni } from "../core/formats/ini.ts";
import { extractCommentMap, inferCommentFields } from "../core/inference/comments.ts";
import { maskDocumentSecrets } from "../core/inference/heuristic.ts";
import { inferConfig } from "../core/inference/index.ts";
import { clearRemoteSchemaCache, inferJsonSchemaFields } from "../core/inference/json-schema.ts";
import { pathKey } from "../core/paths.ts";
import {
  commitSave,
  compareConfigFiles,
  generateRedactedExport,
  previewSave,
  previewSyncFromFile,
} from "../core/save.ts";
import { searchProjectConfigs } from "../core/search.ts";
import {
  computeUnifiedDiff,
  DIFF_SECRET_MASK,
  maskDocumentLines,
  maskUnifiedDiff,
} from "../shared/diff.ts";
import type { ConfigFormSchema, FieldSpec, SavePreview } from "../shared/schema.ts";
import { containsSecretValuePattern } from "../shared/validation.ts";
import {
  buildDeepFieldIndex,
  clearJsonDraftSubErrors,
  collectChanges,
  createJsonDraft,
  extractCardSummary,
  fieldKey,
  isEditorDirty,
  isFieldModified,
  objectHasSchemaSecret,
  parseJsonDraft,
  reconcileSavedState,
  validateField,
  validationErrors,
  withJsonDraftSubError,
} from "../web/src/editor-state.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDirs: string[] = [];

afterEach(async () => {
  clearRemoteSchemaCache();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Stage 5 Wave 2 Hardening (4 P0 + 6 P1 regression suite)", () => {
  /* ------------------------------------------------------------------------ */
  /* P0-1: .npmrc credentials masking in RawViewer / UnifiedDiff / Export     */
  /* ------------------------------------------------------------------------ */
  it("P0-1: masks .npmrc //host/:_authToken and _password with spaces, commas, and semicolons across RawViewer, UnifiedDiff, patchIni, and redacted export", async () => {
    const npmrc = [
      "# Registry settings",
      "registry=https://registry.npmjs.org/",
      "@myorg:registry=https://npm.pkg.github.com/",
      "//registry.npmjs.org/:_password=my secret pass word",
      "//npm.pkg.github.com/:_authToken=tok_comma_a,tok_comma_b,tok_comma_c",
      "//private.reg.internal:4873/:_authToken=tok_semi_a;tok_semi_b;tok_semi_c",
      "//edge.reg.internal/:_authToken=;leading_semi_secret",
      "save-exact=true # keep comment",
    ].join("\n") + "\n";

    // 1. RawViewer (`maskDocumentLines` with format: "ini") must NOT skip `//` lines as comments
    const maskedDoc = maskDocumentLines(npmrc, { format: "ini" });
    const maskedText = maskedDoc.lines.join("\n");
    for (const leaked of [
      "my secret",
      "pass word",
      "tok_comma_a",
      "tok_comma_b",
      "tok_comma_c",
      "tok_semi_a",
      "tok_semi_b",
      "tok_semi_c",
      "leading_semi_secret",
    ]) {
      expect(maskedText, `RawViewer leaked ${leaked}`).not.toContain(leaked);
    }
    expect(maskedText).toContain(`//registry.npmjs.org/:_password=${DIFF_SECRET_MASK}`);
    expect(maskedText).toContain(`//npm.pkg.github.com/:_authToken=${DIFF_SECRET_MASK}`);
    expect(maskedText).toContain(`//private.reg.internal:4873/:_authToken=${DIFF_SECRET_MASK}`);
    expect(maskedText).toContain(`//edge.reg.internal/:_authToken=${DIFF_SECRET_MASK}`);
    expect(maskedText).toContain("@myorg:registry=https://npm.pkg.github.com/");
    expect(maskedText).toContain("# Registry settings");

    // 2. UnifiedDiff (`maskUnifiedDiff` with and without explicit format)
    const updatedNpmrc = npmrc
      .replace("my secret pass word", "rotated secret pass phrase")
      .replace("tok_semi_b", "tok_semi_rotated");
    const rawDiff = computeUnifiedDiff(npmrc, updatedNpmrc, 2);
    for (const opts of [{ format: "ini" as const }, {}]) {
      const diffMasked = maskUnifiedDiff(rawDiff, opts);
      const rendered = diffMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
      for (const secret of [
        "my secret",
        "pass word",
        "rotated secret",
        "pass phrase",
        "tok_comma_b",
        "tok_semi_a",
        "tok_semi_b",
        "tok_semi_rotated",
        "tok_semi_c",
        "leading_semi_secret",
      ]) {
        expect(rendered, `UnifiedDiff leaked ${secret}`).not.toContain(secret);
      }
      expect(rendered).toContain(`//registry.npmjs.org/:_password=${DIFF_SECRET_MASK}`);
      expect(rendered).toContain(`//private.reg.internal:4873/:_authToken=${DIFF_SECRET_MASK}`);
    }

    // 3. Direct `patchIni` must not carry `;tok_semi_b;tok_semi_c` over as a "comment"
    const patchedIni = patchIni(npmrc, [
      { segments: ["//private.reg.internal:4873/:_authToken"], value: "***" },
    ]);
    expect(patchedIni).toContain("//private.reg.internal:4873/:_authToken=***\n");
    expect(patchedIni).not.toContain("tok_semi_b");
    expect(patchedIni).not.toContain("tok_semi_c");

    // 4. Full `generateRedactedExport` on real `.npmrc` file
    const root = await mkdtemp(join(tmpdir(), "confui-p01-npmrc-"));
    tempDirs.push(root);
    await writeFile(join(root, ".npmrc"), npmrc, "utf8");
    const exported = await generateRedactedExport(root, ".npmrc");
    for (const leaked of [
      "my secret",
      "pass word",
      "tok_comma_a",
      "tok_comma_b",
      "tok_comma_c",
      "tok_semi_a",
      "tok_semi_b",
      "tok_semi_c",
      "leading_semi_secret",
    ]) {
      expect(exported.content, `Redacted export leaked ${leaked}`).not.toContain(leaked);
    }
    expect(exported.content).toContain("@myorg:registry=https://npm.pkg.github.com/");
    expect(exported.content).toContain("save-exact=true # keep comment");
  });

  /* ------------------------------------------------------------------------ */
  /* P0-2: JSON Schema DAG DoS protection, __proto__ guard, root validation   */
  /* ------------------------------------------------------------------------ */
  it("P0-2: resolves a 14-level 4-way $ref + allOf/anyOf DAG in milliseconds, blocks __proto__, and rejects non-object schema roots before disk caching", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-p02-schema-"));
    const cacheDir = join(root, ".cache");
    tempDirs.push(root);

    // 1. 14-level 4-way exponential DAG (4^14 = 268,435,456 paths without memoization)
    // Cover both pure allOf (preserves nested leaf properties) and alternating allOf/anyOf/oneOf.
    const defs: Record<string, unknown> = {
      A14: { type: "object", properties: { leafPort: { type: "integer", minimum: 1 } } },
      M14: { type: "object", properties: { mixedLeaf: { type: "string" } } },
    };
    for (let level = 13; level >= 0; level -= 1) {
      const nextAllOf = { $ref: `#/$defs/A${level + 1}` };
      defs[`A${level}`] = { allOf: [nextAllOf, nextAllOf, nextAllOf, nextAllOf] };
      const nextMixed = { $ref: `#/$defs/M${level + 1}` };
      defs[`M${level}`] = level % 3 === 0
        ? { allOf: [nextMixed, nextMixed, nextMixed, nextMixed] }
        : level % 3 === 1
          ? { anyOf: [nextMixed, nextMixed, nextMixed, nextMixed] }
          : { oneOf: [nextMixed, nextMixed, nextMixed, nextMixed] };
    }
    // Also inject forbidden keys (`__proto__`, `constructor`, `prototype`) in schema properties
    const rawDagSchema = JSON.stringify({
      type: "object",
      $defs: defs,
      properties: {
        dagTarget: { $ref: "#/$defs/A0" },
        mixedDagTarget: { $ref: "#/$defs/M0" },
        protoRef: { $ref: "#/__proto__/toString", type: "string" },
        constructor: { type: "string" },
        prototype: { type: "string" },
      },
    }).replace(
      '"dagTarget"',
      '"__proto__":{"type":"object","properties":{"polluted":{"type":"string"}}},"dagTarget"',
    );
    await writeFile(join(root, "dag.schema.json"), rawDagSchema, "utf8");
    const cfgFile = join(root, "config.json");
    await writeFile(cfgFile, JSON.stringify({ $schema: "./dag.schema.json", dagTarget: { leafPort: 8080 } }), "utf8");

    const start = performance.now();
    const dagRes = await inferJsonSchemaFields(cfgFile, root, {
      $schema: "./dag.schema.json",
      dagTarget: { leafPort: 8080 },
    });
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(dagRes.warnings).toEqual([]);
    const leafField = dagRes.fields.find((f) => f.segments.join(".") === "dagTarget.leafPort");
    expect(leafField?.type).toBe("integer");
    expect(leafField?.minimum).toBe(1);
    expect(dagRes.fields.some((f) => f.segments.join(".") === "mixedDagTarget")).toBe(true);
    // Forbidden keys must never appear as fields or pollute Object.prototype
    expect(dagRes.fields.some((f) => f.segments.includes("__proto__"))).toBe(false);
    expect(dagRes.fields.some((f) => f.segments.includes("constructor"))).toBe(false);
    expect(dagRes.fields.some((f) => f.segments.includes("prototype"))).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // 2. Uncacheable unique-branching composition bomb hits MAX_RESOLUTION_STEPS cleanly
    const bombProps: Record<string, unknown> = {};
    for (let i = 0; i < 60; i += 1) {
      bombProps[`p${i}`] = {
        allOf: Array.from({ length: 100 }, (_, j) => ({
          anyOf: [{ type: "string", minLength: j }, { type: "null" }],
        })),
      };
    }
    await writeFile(join(root, "bomb.schema.json"), JSON.stringify({ type: "object", properties: bombProps }), "utf8");
    const bombStart = performance.now();
    const bombRes = await inferJsonSchemaFields(cfgFile, root, { $schema: "./bomb.schema.json" });
    expect(performance.now() - bombStart).toBeLessThan(1_000);
    expect(bombRes.truncated).toBe(true);

    // 3. Non-plain-object remote schema root (`null`, `[1,2]`, `"str"`) rejected & NEVER cached to disk
    const badPayloads = ["null", "[1, 2, 3]", '"not-an-object"', "true"];
    for (const [idx, payload] of badPayloads.entries()) {
      clearRemoteSchemaCache();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(payload, { status: 200, headers: { "Content-Type": "application/json" } }),
      );
      const res = await inferJsonSchemaFields(
        join(root, "package.json"),
        root,
        { name: `demo-${idx}` },
        fetcher,
        {
          format: "json",
          relativeFile: "package.json",
          enableSchemaStore: true,
          schemaStoreCacheDir: cacheDir,
        },
      );
      expect(res.fields).toEqual([]);
      expect(res.warnings.length).toBeGreaterThan(0);
    }
    const cachedFiles = await readdir(cacheDir).catch(() => []);
    expect(cachedFiles).toEqual([]);
  });

  /* ------------------------------------------------------------------------ */
  /* P0-3: Multi-doc YAML empty docs, Scalar(null), `...` fallback, UTF-8 BOM */
  /* ------------------------------------------------------------------------ */
  it("P0-3: handles empty multi-doc YAML (---\\n---), commented empty docs (Scalar(null)), ... fallback boundaries, and UTF-8 BOM offsets", async () => {
    // 1. Empty leading/middle documents (LF and CRLF) never concatenate `---` + `---` into `------`
    const leadingEmpty = "---\n---\na: 1\n";
    const editedLeading = updateConfigText(leadingEmpty, "yaml", [{ segments: ["a"], value: 2 }], { documentIndex: 1 });
    expect(editedLeading.warnings).toEqual([]);
    expect(editedLeading.output).not.toContain("------");
    expect(editedLeading.output).toBe("---\n---\na: 2\n");
    expect(parseYamlDocuments(editedLeading.output)).toHaveLength(2);

    const middleEmptyCrlf = "a: 1\r\n---\r\n---\r\nb: 2\r\n";
    const editedMiddle = updateConfigText(middleEmptyCrlf, "yaml", [{ segments: ["b"], value: 9 }], { documentIndex: 2 });
    expect(editedMiddle.warnings).toEqual([]);
    expect(editedMiddle.output).not.toContain("------");
    expect(editedMiddle.output).toBe("a: 1\r\n---\r\n---\r\nb: 9\r\n");
    expect(parseYamlDocuments(editedMiddle.output)).toHaveLength(3);

    // 2. Commented empty YAML doc (`Scalar(null)`) must NOT trigger alias fallback or lose comments
    const commentedEmpty = "---\n# keep this empty doc comment\n---\na: 1\n";
    const editedEmptyDoc = updateConfigText(commentedEmpty, "yaml", [{ segments: ["enabled"], value: true }], {
      documentIndex: 0,
    });
    expect(editedEmptyDoc.warnings).toEqual([]);
    expect(editedEmptyDoc.output).toContain("# keep this empty doc comment");
    const docsAfterEmpty = parseYamlDocuments(editedEmptyDoc.output);
    expect(docsAfterEmpty).toHaveLength(2);
    expect(docsAfterEmpty[0]?.value).toEqual({ enabled: true });
    expect(docsAfterEmpty[1]?.value).toEqual({ a: 1 });

    // 3. `fallbackUpdateYaml` preserves `...` end-of-document boundary so sibling docs never merge
    const ellipsisAlias = [
      "defaults: &def",
      "  port: 8080",
      "app: *def",
      "...",
      "other: 1",
    ].join("\n") + "\n";
    const editedEllipsis = updateConfigText(ellipsisAlias, "yaml", [{ segments: ["app", "port"], value: 9090 }], {
      documentIndex: 0,
    });
    expect(editedEllipsis.warnings.length).toBe(1);
    expect(editedEllipsis.output).toContain("\n...\nother: 1");
    const docsAfterEllipsis = parseYamlDocuments(editedEllipsis.output);
    expect(docsAfterEllipsis).toHaveLength(2);
    expect(docsAfterEllipsis[0]?.value).toEqual({ defaults: { port: 8080 }, app: { port: 9090 } });
    expect(docsAfterEllipsis[1]?.value).toEqual({ other: 1 });

    // 4. UTF-8 BOM multi-doc YAML: inference schema directive slice, search line offsets, and BOM-preserving update
    const root = await mkdtemp(join(tmpdir(), "confui-p03-bom-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "doc1.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          servicePort: { type: "integer", description: "Doc 1 schema port" },
        },
      }),
      "utf8",
    );
    const bomMultiYaml = "\uFEFFname: doc-zero\n---\n# yaml-language-server: $schema=./doc1.schema.json\nservicePort: 7070\n";
    await writeFile(join(root, "multi.yaml"), bomMultiYaml, "utf8");

    const doc1Schema = await inferConfig(root, "multi.yaml", { documentIndex: 1 });
    expect(doc1Schema.fields.find((f) => f.path === "servicePort")).toMatchObject({
      value: 7070,
      description: "Doc 1 schema port",
      source: "json-schema",
    });

    const searchRes = await searchProjectConfigs(root, "servicePort");
    expect(searchRes.hits[0]).toMatchObject({
      file: "multi.yaml",
      path: "servicePort",
      documentIndex: 1,
      line: 4,
    });

    const bomUpdated = updateConfigText(bomMultiYaml, "yaml", [{ segments: ["servicePort"], value: 7071 }], {
      documentIndex: 1,
    });
    expect(bomUpdated.output.startsWith("\uFEFF")).toBe(true);
    expect(parseYamlDocuments(bomUpdated.output)).toHaveLength(2);
    expect(parseYamlDocuments(bomUpdated.output)[1]?.value).toEqual({ servicePort: 7071 });
  });

  /* ------------------------------------------------------------------------ */
  /* P0-4: DeepJsonFallbackBlock / cardJsonDrafts error propagation & sync    */
  /* ------------------------------------------------------------------------ */
  it("P0-4: propagates sub-editor JSON errors to validation/dirty state and prevents undefined-origin invalid JSON deadlock", async () => {
    const objectField: FieldSpec = {
      path: "deep",
      segments: ["deep"],
      label: "Deep",
      type: "json",
      value: { a: { b: { c: { d: { x: 1 } } } } },
      source: "heuristic",
      confidence: 0.9,
      evidence: [],
    };
    const optionalField: FieldSpec = {
      path: "extra",
      segments: ["extra"],
      label: "Extra",
      type: "json",
      value: undefined,
      source: "json-schema",
      confidence: 0.9,
      evidence: [],
    };

    // 1. Sub-editor syntax error (DeepJsonFallbackBlock / cardJsonDrafts) marks dirty & blocks validation
    const baseDraft = createJsonDraft(objectField.value);
    const erroredDraft = withJsonDraftSubError(baseDraft, "deep.a.b.c.d", "JSON 语法无效");
    expect(validateField(objectField, erroredDraft)).toBe("JSON 语法无效");
    expect(isFieldModified(objectField, erroredDraft)).toBe(true);
    expect(isEditorDirty([objectField], { [fieldKey(objectField)]: erroredDraft })).toBe(true);
    expect(validationErrors([objectField], { [fieldKey(objectField)]: erroredDraft }).size).toBe(1);

    // Clearing sub-error restores clean state
    const clearedDraft = clearJsonDraftSubErrors(erroredDraft, "deep.a.b.c.d");
    expect(validateField(objectField, clearedDraft)).toBeUndefined();
    expect(isFieldModified(objectField, clearedDraft)).toBe(false);
    expect(isEditorDirty([objectField], { [fieldKey(objectField)]: clearedDraft })).toBe(false);

    // 2. Undefined-origin field with invalid JSON has dirty=true, errors=1, isFieldModified=true even when collectChanges=[]
    const invalidOptional = parseJsonDraft("{bad");
    const optValues = { [fieldKey(optionalField)]: invalidOptional };
    expect(collectChanges([optionalField], optValues)).toEqual([]);
    expect(isFieldModified(optionalField, invalidOptional)).toBe(true);
    expect(isEditorDirty([optionalField], optValues)).toBe(true);
    expect(validationErrors([optionalField], optValues).size).toBe(1);

    // 3. Source contracts: App.tsx checks `errors.size` before `!changes.length`, StructuredControls syncs on external changes
    const appSource = await readFile(resolve(REPO_ROOT, "web/src/App.tsx"), "utf8");
    const beginSaveBody = appSource.slice(appSource.indexOf("async function beginSave"), appSource.indexOf("async function confirmSave"));
    expect(beginSaveBody.indexOf("if (errors.size)")).toBeGreaterThan(-1);
    expect(beginSaveBody.indexOf("if (!changes.length) return;")).toBeGreaterThan(beginSaveBody.indexOf("if (errors.size)"));
    expect(appSource).toContain("changeCount={Math.max(changes.length, modifiedCount)}");

    const structuredSource = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    expect(structuredSource).toContain("withJsonDraftSubError");
    expect(structuredSource).toContain("externalSyncVersion");
    expect(structuredSource).not.toContain("if (parseError) return;");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-1: 4-class redaction in comment inference & cross-file search         */
  /* ------------------------------------------------------------------------ */
  it("P1-1: redacts nested object/array secrets echoed in comments, Authorization: Token, multi-word passwords, and multi-line PEM comment bodies", async () => {
    // 1. `Authorization: Token ...` and multi-word unquoted passwords (without corrupting benign prose)
    const maskedDoc = maskDocumentSecrets([
      "Authorization: Token gh_custom_token_987654",
      'curl -H "Authorization: Token another_token_555"',
      "Token lifetime in seconds",
      "password: correct horse battery staple",
      "db_password = my multi word secret 2026",
    ].join("\n"));
    expect(maskedDoc).toContain("Authorization: Token ***");
    expect(maskedDoc).not.toContain("gh_custom_token_987654");
    expect(maskedDoc).not.toContain("another_token_555");
    expect(maskedDoc).toContain("Token lifetime in seconds");
    expect(maskedDoc).not.toContain("correct");
    expect(maskedDoc).not.toContain("horse");
    expect(maskedDoc).not.toContain("battery");
    expect(maskedDoc).not.toContain("staple");
    expect(maskedDoc).not.toContain("multi word secret");

    // 2. Nested object/array secrets inside collapsed JSONC fields + comment echo redaction in `inferConfig`
    const root = await mkdtemp(join(tmpdir(), "confui-p11-comments-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "app.jsonc"),
      `{
  // Remember rotated value: nested-array-secret-777 and deep-obj-signing-888
  // Also fallback Authorization: Token comment-auth-tok-999 and password: my secret phrase pass
  "publicNote": "hello",
  "configurations": [
    {
      "name": "API",
      "env": {
        "API_TOKEN": "nested-array-secret-777"
      }
    }
  ],
  "l1": {
    "l2": {
      "l3": {
        "auth": {
          "signing_key": "deep-obj-signing-888"
        }
      }
    }
  }
}
`,
      "utf8",
    );

    const schema = await inferConfig(root, "app.jsonc");
    const publicField = schema.fields.find((f) => f.path === "publicNote");
    expect(publicField?.description).toBeDefined();
    expect(publicField?.description).not.toContain("nested-array-secret-777");
    expect(publicField?.description).not.toContain("deep-obj-signing-888");
    expect(publicField?.description).not.toContain("comment-auth-tok-999");
    expect(publicField?.description).not.toContain("my secret phrase pass");

    // 3. Cross-file comment search MUST block multi-line PEM private key body lines (closed & unclosed)
    await writeFile(
      join(root, "pem-comment.yaml"),
      [
        "# -----BEGIN RSA PRIVATE KEY-----",
        "# MIIE_MIDDLE_PEM_BODY_SECRET_LINE_ABC",
        "# -----END RSA PRIVATE KEY-----",
        "# -----BEGIN PRIVATE KEY-----",
        "# UNCLOSED_PEM_BODY_SECRET_XYZ",
        "port: 8080",
      ].join("\n") + "\n",
      "utf8",
    );
    expect((await searchProjectConfigs(root, "MIIE_MIDDLE_PEM_BODY_SECRET_LINE_ABC")).hits).toEqual([]);
    expect((await searchProjectConfigs(root, "UNCLOSED_PEM_BODY_SECRET_XYZ")).hits).toEqual([]);
    expect((await searchProjectConfigs(root, "comment-auth-tok-999")).hits).toEqual([]);
    expect((await searchProjectConfigs(root, "phrase pass")).hits).toEqual([]);

    // Also check unclosed PEM in inferCommentFields directly
    const pemCandidates = inferCommentFields(
      "# -----BEGIN PRIVATE KEY-----\n# UNCLOSED_BODY_SECRET_12345\nport: 8080\n",
      "yaml",
    );
    expect(JSON.stringify(pemCandidates)).not.toContain("UNCLOSED_BODY_SECRET_12345");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-2: Card summary, deep index, and nested secret gate hardening         */
  /* ------------------------------------------------------------------------ */
  it("P1-2: redacts inline KEY=VALUE in card summaries/deep index and enforces schema writeOnly/ancestorSecret gates", async () => {
    expect(containsSecretValuePattern("PGPASSWORD=topsecret123 psql -U app")).toBe(true);
    expect(containsSecretValuePattern("--api-key=secret-cli-val")).toBe(true);
    expect(containsSecretValuePattern("Authorization: Token my_secret_tok")).toBe(true);
    expect(containsSecretValuePattern('PGPASSWORD=""')).toBe(false);
    expect(containsSecretValuePattern("PGPASSWORD=***")).toBe(false);

    // 1. Card summary masks inline KEY=VALUE in `run`/`command` and respects ancestorSecret & schema writeOnly
    const stepCard = {
      run: "PGPASSWORD=supersecret999 pg_dump prod",
      vaultCode: "schema-writeonly-pin-42",
      env: "staging",
    };
    const itemFields = [
      { key: "run", label: "Run", type: "string" as const },
      { key: "vaultCode", label: "Vault Code", type: "secret" as const, secret: true },
      { key: "env", label: "Env", type: "string" as const },
    ];
    const summary = extractCardSummary(stepCard, itemFields, ["steps", 0], false);
    expect(summary.title).toBeUndefined(); // `run` skipped because it contains PGPASSWORD=...
    expect(JSON.stringify(summary.badges)).not.toContain("supersecret999");
    expect(JSON.stringify(summary.badges)).not.toContain("schema-writeonly-pin-42");

    // Ancestor secret hides ALL titles & badges
    const secretGroupSummary = extractCardSummary(
      { name: "Primary", host: "db.internal" },
      undefined,
      ["credentials", 0],
      true,
    );
    expect(secretGroupSummary.title).toBeUndefined();
    expect(secretGroupSummary.badges.every((b) => b.value === "••••")).toBe(true);

    // Schema writeOnly detection on card objects
    expect(objectHasSchemaSecret({ name: "x", vaultCode: "pin-123" }, itemFields)).toBe(true);
    expect(objectHasSchemaSecret({ name: "x" }, itemFields)).toBe(false);
    expect(objectHasSchemaSecret({ name: "x" }, undefined, true)).toBe(true);

    // 2. `buildDeepFieldIndex` masks inline KEY=VALUE, schema writeOnly, and secret scalar arrays
    const fields: FieldSpec[] = [
      {
        path: "steps",
        segments: ["steps"],
        label: "Steps",
        type: "array",
        value: [stepCard],
        itemFields,
        source: "json-schema",
        confidence: 0.99,
        evidence: [],
      },
      {
        path: "endpoints",
        segments: ["endpoints"],
        label: "Endpoints",
        type: "array",
        value: ["https://ok.example.com", "PGPASSWORD=arrsecret777 psql"],
        source: "heuristic",
        confidence: 0.8,
        evidence: [],
      },
      {
        path: "secretVault",
        segments: ["secretVault"],
        label: "Secret Vault",
        type: "json",
        secret: true,
        value: { customPin: "vault-pin-9999" },
        source: "json-schema",
        confidence: 0.99,
        evidence: [],
      },
    ];
    const deepIndex = buildDeepFieldIndex(fields, {});
    const serialized = JSON.stringify(deepIndex);
    expect(serialized).not.toContain("supersecret999");
    expect(serialized).not.toContain("schema-writeonly-pin-42");
    expect(serialized).not.toContain("arrsecret777");
    expect(serialized).not.toContain("vault-pin-9999");
    expect(deepIndex.find((e) => e.path === "steps[0].vaultCode")).toMatchObject({ secret: true, searchableValue: "" });
    expect(deepIndex.find((e) => e.path === "secretVault.customPin")).toMatchObject({ secret: true, searchableValue: "" });
    expect(deepIndex.find((e) => e.path === "endpoints")).toMatchObject({ secret: true, searchableValue: "" });

    // 3. Source-contract check that StructuredControls propagates `ancestorSecret` & gates `ScalarArrayControl`
    const structuredSource = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    expect(structuredSource).toContain("objectHasSchemaSecret");
    expect(structuredSource).toContain("ancestorSecret");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-3: Multi-doc YAML CompareSync / reconcileSavedState / Raw / Export    */
  /* ------------------------------------------------------------------------ */
  it("P1-3: scopes CompareSync, reconcileSavedState, RawViewer, and Redacted Export cleanly across multi-document YAML", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-p13-multidoc-"));
    tempDirs.push(root);

    await writeFile(
      join(root, "doc0.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          code: { type: "string", writeOnly: true },
          kind: { type: "string" },
        },
      }),
      "utf8",
    );
    await writeFile(
      join(root, "doc1.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          code: { type: "string" },
          vaultRef: { type: "string", format: "password" },
          kind: { type: "string" },
          metadata: { type: "object", properties: { name: { type: "string" } } },
          port: { type: "integer" },
        },
      }),
      "utf8",
    );

    const targetMultiYaml = [
      "# yaml-language-server: $schema=./doc0.schema.json",
      "kind: Deployment",
      "code: doc0-writeonly-secret-111",
      "port: 8000",
      "---",
      "# yaml-language-server: $schema=./doc1.schema.json",
      "kind: Service",
      "metadata:",
      "  name: svc-v1",
      "code: HTTP_200_PUBLIC",
      "vaultRef: doc1-password-secret-222",
      "port: 8080",
    ].join("\n") + "\n";

    const sourceYaml = "port: 9090\nmetadata:\n  name: svc-v2\n";
    await writeFile(join(root, "multi.yaml"), targetMultiYaml, "utf8");
    await writeFile(join(root, "prod.yaml"), sourceYaml, "utf8");

    // 1. CompareSync targeting Doc 1 MUST diff and patch Doc 1 ONLY (Doc 0 untouched!)
    const cmp = await compareConfigFiles(root, "prod.yaml", "multi.yaml", { targetDocumentIndex: 1 });
    expect(cmp.targetDocumentIndex).toBe(1);
    expect(cmp.targetYamlDocuments).toHaveLength(2);
    expect(cmp.entries.find((e) => e.path === "port")).toMatchObject({
      status: "different",
      sourceValue: 9090,
      targetValue: 8080,
    });

    const syncPreview = await previewSyncFromFile(
      root,
      "prod.yaml",
      "multi.yaml",
      [["port"], ["metadata", "name"]],
      cmp.targetVersion,
      { targetDocumentIndex: 1 },
    );
    expect(syncPreview.documentIndex).toBe(1);
    expect(syncPreview.yamlDocuments?.[1]?.label).toBe("Service/svc-v2");
    const docsSynced = parseYamlDocuments(syncPreview.output);
    expect(docsSynced[0]?.value).toMatchObject({ kind: "Deployment", port: 8000 });
    expect(docsSynced[1]?.value).toMatchObject({ kind: "Service", port: 9090, metadata: { name: "svc-v2" } });

    // 2. `reconcileSavedState` protects Doc 1 baseline when a SavePreview targeted Doc 0, AND refreshes yamlDocuments
    const doc1Schema = await inferConfig(root, "multi.yaml", { documentIndex: 1 });
    const doc0Preview: SavePreview = await previewSave(
      root,
      "multi.yaml",
      [{ segments: ["port"], value: 7777 }],
      doc1Schema.version,
      0,
    );
    const reconciledMismatch = reconcileSavedState(
      doc1Schema,
      { [fieldKey(doc1Schema.fields.find((f) => f.path === "port")!)]: 8080 },
      [],
      doc0Preview,
      { ...doc1Schema.version, hash: "a".repeat(64) },
    );
    // Doc 1's port field MUST still be 8080 (NOT polluted with Doc 0's 7777!)
    expect(reconciledMismatch.schema.fields.find((f) => f.path === "port")?.value).toBe(8080);
    expect(reconciledMismatch.schema.rawText).toBe(doc0Preview.output);

    // When saving Doc 1 itself, yamlDocuments label refreshes to Service/svc-v2
    const reconciledSame = reconcileSavedState(
      doc1Schema,
      { [fieldKey(doc1Schema.fields.find((f) => f.path === "port")!)]: 9090 },
      [],
      syncPreview,
      { ...doc1Schema.version, hash: "b".repeat(64) },
    );
    expect(reconciledSame.schema.yamlDocuments?.[1]?.label).toBe("Service/svc-v2");
    expect(reconciledSame.schema.fields.find((f) => f.path === "port")?.value).toBe(9090);

    // 3. `inferConfig` from Doc 0 aggregates ALL docs' writeOnly secrets scoped per document for RawViewer
    const doc0Schema = await inferConfig(root, "multi.yaml", { documentIndex: 0 });
    expect(doc0Schema.documentSecrets).toHaveLength(2);
    expect(doc0Schema.documentSecrets?.[0]?.secretKeys).toContain("code");
    expect(doc0Schema.documentSecrets?.[1]?.secretKeys).toContain("vaultRef");
    expect(doc0Schema.documentSecrets?.[1]?.secretKeys).not.toContain("code");

    const rawDocSecrets = doc0Schema.yamlDocuments!.map((doc, idx) => {
      const meta = doc0Schema.documentSecrets!.find((m) => m.documentIndex === doc.index);
      const next = doc0Schema.yamlDocuments![idx + 1];
      return {
        startLine: idx === 0 ? 1 : doc.startLine,
        endLine: next?.startLine,
        secretKeys: meta?.secretKeys ?? [],
        secretValues: meta?.secretValues ?? [],
      };
    });
    const rawMasked = maskDocumentLines(doc0Schema.rawText, {
      format: "yaml",
      documentSecrets: rawDocSecrets,
    }).lines.join("\n");
    expect(rawMasked).not.toContain("doc0-writeonly-secret-111");
    expect(rawMasked).not.toContain("doc1-password-secret-222");
    // Doc 1's non-secret `code: HTTP_200_PUBLIC` MUST NOT be falsely masked by Doc 0's `code`!
    expect(rawMasked).toContain("code: HTTP_200_PUBLIC");

    // 4. `generateRedactedExport` redacts BOTH docs' writeOnly secrets & isolates `extraSecretPaths` per doc
    const exported = await generateRedactedExport(root, "multi.yaml", [["code"]], { documentIndex: 0 });
    expect(exported.content).not.toContain("doc0-writeonly-secret-111");
    expect(exported.content).not.toContain("doc1-password-secret-222");
    expect(exported.content).toContain("code: HTTP_200_PUBLIC");
    expect(extractYamlDocumentSummaries(exported.content)).toHaveLength(2);
  });

  /* ------------------------------------------------------------------------ */
  /* P1-4: .editorconfig trailing-comment headers & character-class globs     */
  /* ------------------------------------------------------------------------ */
  it("P1-4: parses, comments, searches, and round-trips real .editorconfig with [*.md] # comments and [*.[ch]] character classes", async () => {
    expect(matchIniSectionHeader("[*.md] # markdown rules")).toEqual({
      rawSection: "*.md",
      comment: " # markdown rules",
    });
    expect(matchIniSectionHeader("[*.[ch]] ; C headers")).toEqual({
      rawSection: "*.[ch]",
      comment: " ; C headers",
    });
    expect(matchIniSectionHeader("[*.[a-z]] # range with [brackets]")).toEqual({
      rawSection: "*.[a-z]",
      comment: " # range with [brackets]",
    });

    const editorconfig = [
      "# Top-level EditorConfig",
      "root = true",
      "",
      "[*.md] # markdown files",
      "# Keep trailing spaces in markdown",
      "trim_trailing_whitespace = false",
      "indent_size = 2",
      "",
      "[*.[ch]] ; C headers and source",
      "# Kernel tab width",
      "indent_style = tab",
      "indent_size = 8",
    ].join("\n") + "\n";

    expect(looksLikeIni(editorconfig)).toBe(true);
    const parsed = parseConfig(editorconfig, "ini");
    expect(parsed).toEqual({
      root: true,
      "*": {
        md: { trim_trailing_whitespace: false, indent_size: "2" },
        "[ch]": { indent_style: "tab", indent_size: "8" },
      },
    });

    const comments = extractCommentMap(editorconfig, "ini");
    expect(comments.get(pathKey(["*", "md", "trim_trailing_whitespace"]))?.comment).toBe(
      "Keep trailing spaces in markdown",
    );
    expect(comments.get(pathKey(["*", "[ch]", "indent_style"]))?.comment).toBe("Kernel tab width");

    const root = await mkdtemp(join(tmpdir(), "confui-p14-ec-"));
    tempDirs.push(root);
    await writeFile(join(root, ".editorconfig"), editorconfig, "utf8");

    const schema = await inferConfig(root, ".editorconfig");
    const preview = await previewSave(
      root,
      ".editorconfig",
      [
        { segments: ["*", "md", "indent_size"], value: 4 },
        { segments: ["*", "[ch]", "indent_size"], value: 4 },
        { segments: ["*", "[ch]", "charset"], value: "utf-8" },
      ],
      schema.version,
    );
    await commitSave(root, preview);

    const disk = await readFile(join(root, ".editorconfig"), "utf8");
    expect(disk).toContain("[*.md] # markdown files");
    expect(disk).toContain("[*.[ch]] ; C headers and source");
    // Appended key inserted inside existing `[*.[ch]]` section (no duplicate header!)
    expect(disk.match(/\[\*\.\[ch\]\]/g)).toHaveLength(1);
    expect(parseConfig(disk, "ini")).toEqual({
      root: true,
      "*": {
        md: { trim_trailing_whitespace: false, indent_size: "4" },
        "[ch]": { indent_style: "tab", indent_size: "4", charset: "utf-8" },
      },
    });

    const search = await searchProjectConfigs(root, "charset");
    expect(search.hits[0]).toMatchObject({ file: ".editorconfig", line: 13 });
  });

  /* ------------------------------------------------------------------------ */
  /* P1-5: focusFieldRequest one-shot token + documentIndex + deep-path       */
  /* ------------------------------------------------------------------------ */
  it("P1-5: enforces one-shot focusFieldRequest consumption with documentIndex and DeepJsonFallbackBlock data-deep-path", async () => {
    const appSource = await readFile(resolve(REPO_ROOT, "web/src/App.tsx"), "utf8");
    expect(appSource).toContain("focusTokenRef");
    expect(appSource).toContain("consumeFocusFieldRequest");
    expect(appSource).toContain("(focusFieldRequest.documentIndex ?? 0) === (schema.activeDocumentIndex ?? 0)");
    expect(appSource).toContain("setFocusFieldRequest(undefined);");

    const fieldEditorSource = await readFile(resolve(REPO_ROOT, "web/src/FieldEditor.tsx"), "utf8");
    expect(fieldEditorSource).toContain("handledFocusTokenRef");
    expect(fieldEditorSource).toContain("onConsumeFocusRequest");
    expect(fieldEditorSource).toContain("findDeepestMatchingElement");

    const structuredSource = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    const fallbackStart = structuredSource.indexOf("function DeepJsonFallbackBlock");
    const fallbackSource = structuredSource.slice(fallbackStart);
    expect(fallbackSource).toContain("data-deep-path={deepPath}");
    expect(fallbackSource).toContain("deep-node--highlighted");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-6: TOML 1.0 heterogeneous array append without false coercion error   */
  /* ------------------------------------------------------------------------ */
  it("P1-6: allows appending to TOML 1.0 heterogeneous arrays while preserving homogeneous special-scalar coercion", () => {
    const heteroToml = [
      'mixed_dates = [2024-01-01T00:00:00Z, "note"]',
      'mixed_big = [9007199254740993, "tag"]',
      'mixed_inf = [inf, "label"]',
      "pure_dates = [2024-01-01T00:00:00Z, 2024-02-01T00:00:00Z]",
    ].join("\n") + "\n";

    // Appending a plain string to heterogeneous arrays MUST succeed
    const updated = updateConfigText(heteroToml, "toml", [
      { segments: ["mixed_dates"], value: ["2024-01-01T00:00:00.000Z", "note", "extra-string"] },
      { segments: ["mixed_big"], value: ["9007199254740993", "tag", "more"] },
      { segments: ["mixed_inf"], value: ["inf", "label", "after"] },
      { segments: ["pure_dates"], value: ["2024-01-01T00:00:00.000Z", "2024-02-01T00:00:00.000Z", "2024-03-01T00:00:00Z"] },
    ]);
    const reparsed = parseConfig(updated.output, "toml") as Record<string, unknown[]>;
    expect(reparsed.mixed_dates).toHaveLength(3);
    expect(reparsed.mixed_dates?.[2]).toBe("extra-string");
    expect(reparsed.mixed_big?.[2]).toBe("more");
    expect(reparsed.mixed_inf?.[2]).toBe("after");
    expect(reparsed.pure_dates).toHaveLength(3);
    // Homogeneous date array still coerces appended valid date string to TomlDate
    expect(reparsed.pure_dates?.[2]).toBeInstanceOf(Date);

    // Homogeneous date array still rejects invalid date string when appending
    expect(() =>
      updateConfigText(heteroToml, "toml", [
        { segments: ["pure_dates"], value: ["2024-01-01T00:00:00.000Z", "2024-02-01T00:00:00.000Z", "not-a-date"] },
      ]),
    ).toThrow(/TOML 日期或时间格式无效/);
  });
});
