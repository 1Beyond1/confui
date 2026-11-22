import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { extractCommentMap } from "../core/inference/comments.ts";
import { inferConfig } from "../core/inference/index.ts";
import { clearRemoteSchemaCache, inferJsonSchemaFields } from "../core/inference/json-schema.ts";
import { pathKey } from "../core/paths.ts";
import { previewSave } from "../core/save.ts";
import { extractFileComments, searchProjectConfigs } from "../core/search.ts";
import {
  buildYamlDocumentLineSecrets,
  computeUnifiedDiff,
  DIFF_SECRET_MASK,
  isSaveChangeSecret,
  maskDocumentLines,
  maskUnifiedDiff,
  scanYamlDocumentLineRanges,
} from "../shared/diff.ts";
import {
  clearJsonDraftSubErrors,
  createJsonDraft,
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

describe("Stage 5 Recheck Closure (3 P0 + 3 P1 regressions)", () => {
  /* ------------------------------------------------------------------------ */
  /* P0-1: CardPropertyInput stable EMPTY_ARRAY + DeepJsonFallbackBlock sync  */
  /* ------------------------------------------------------------------------ */
  it("P0-1: uses module-level stable EMPTY_ARRAY in CardPropertyInput and clears parent subError on external reset", async () => {
    const source = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    expect(source).toContain("const EMPTY_ARRAY: readonly unknown[] = [];");
    expect(source).toContain("value={value ?? EMPTY_ARRAY}");
    expect(source).not.toContain("value={value ?? []}");

    const fallbackStart = source.indexOf("function DeepJsonFallbackBlock");
    const fallbackSource = source.slice(fallbackStart);
    expect(fallbackSource).toContain("parseErrorRef");
    expect(fallbackSource).toContain("onErrorChangeRef.current?.(undefined)");

    // Clearing an already-clean draft on external Undo/reset is an exact reference no-op
    const cleanDraft = createJsonDraft([{ name: "API" }]);
    expect(clearJsonDraftSubErrors(cleanDraft, "configurations[0].args")).toBe(cleanDraft);
    const errored = withJsonDraftSubError(cleanDraft, "configurations[0].args", "JSON 语法无效");
    const cleared = clearJsonDraftSubErrors(errored, "configurations[0].args");
    expect(cleared.subErrors).toBeUndefined();
    expect(clearJsonDraftSubErrors(cleared, "configurations[0].args")).toBe(cleared);
  });

  /* ------------------------------------------------------------------------ */
  /* P0-2: .npmrc ;/# comment & search redaction + maskAssignedValue quotes   */
  /* ------------------------------------------------------------------------ */
  it("P0-2: blocks .npmrc ;/# token tail leaks in inferConfig descriptions and Ctrl+K search", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-recheck-p02-npmrc-"));
    tempDirs.push(root);

    const npmrc = [
      "# Scoped registry credential note",
      "//private.reg.internal:4873/:_authToken=tok_semi_a;tok_semi_b;tok_semi_c",
      "//edge.reg.internal/:_authToken=;leading_semi_secret",
      "_authToken=unscoped_a;unscoped_b",
      "//space.reg.internal/:_authToken=tok_sp_a ;tok_sp_b",
      "//hash.reg.internal/:_authToken=tok_hash_a #tok_hash_b",
      "password=pass_part1 ;pass_part2",
      "save-exact=true ; keep benign trailing comment",
    ].join("\n") + "\n";

    await writeFile(join(root, ".npmrc"), npmrc, "utf8");

    // 1. Direct comment extraction + full inferConfig must NEVER expose token tails as descriptions
    const commentMap = extractCommentMap(npmrc, "ini");
    const schema = await inferConfig(root, ".npmrc");
    const serializedComments = JSON.stringify([...commentMap.values()]);
    const serializedFields = JSON.stringify(schema.fields.map((f) => ({ path: f.path, description: f.description })));

    for (const leaked of [
      "tok_semi_b",
      "tok_semi_c",
      "leading_semi_secret",
      "unscoped_b",
      "tok_sp_b",
      "tok_hash_b",
      "pass_part2",
    ]) {
      expect(serializedComments, `extractCommentMap leaked ${leaked}`).not.toContain(leaked);
      expect(serializedFields, `inferConfig description leaked ${leaked}`).not.toContain(leaked);
    }
    // Benign leading comment above secret and non-secret trailing comment stay intact
    expect(commentMap.get(pathKey(["//private.reg.internal:4873/:_authToken"]))?.comment).toBe(
      "Scoped registry credential note",
    );
    expect(commentMap.get(pathKey(["save-exact"]))?.comment).toBe("keep benign trailing comment");

    // 2. Ctrl+K cross-file search + extractFileComments must NEVER match token tails after ; or #
    const fileComments = extractFileComments(npmrc, "ini");
    const fileCommentsText = JSON.stringify(fileComments);
    for (const leaked of [
      "tok_semi_b",
      "tok_semi_c",
      "leading_semi_secret",
      "unscoped_b",
      "tok_sp_b",
      "tok_hash_b",
      "pass_part2",
    ]) {
      expect(fileCommentsText, `extractFileComments leaked ${leaked}`).not.toContain(leaked);
      const searchRes = await searchProjectConfigs(root, leaked);
      expect(searchRes.hits, `searchProjectConfigs leaked ${leaked}`).toEqual([]);
    }
    const benignHit = await searchProjectConfigs(root, "keep benign trailing comment");
    expect(benignHit.hits).toHaveLength(1);
    expect(benignHit.hits[0]).toMatchObject({ file: ".npmrc", matchKind: "comment", secret: false });
  });

  it("P0-2: blocks quote-prefix bypasses in maskAssignedValue across .npmrc, INI, ENV, Properties, TOML, and unspecified format", () => {
    const cases: Array<{ label: string; line: string; format?: "ini" | "env" | "properties" | "toml" | "yaml" | "jsonc"; leaks: string[] }> = [
      {
        label: ".npmrc leading empty quotes (ini)",
        line: '//registry.npmjs.org/:_authToken=""real_npm_secret_123',
        format: "ini",
        leaks: ["real_npm_secret_123"],
      },
      {
        label: ".npmrc leading empty quotes (unspecified format)",
        line: '//registry.npmjs.org/:_authToken=""real_npm_secret_123',
        leaks: ["real_npm_secret_123"],
      },
      {
        label: ".npmrc quoted prefix + trailing token (ini)",
        line: '//quote.reg.internal/:_authToken="tok_q1" tok_q2',
        format: "ini",
        leaks: ["tok_q1", "tok_q2"],
      },
      {
        label: ".npmrc quoted prefix + trailing token (unspecified format)",
        line: '//quote.reg.internal/:_authToken="tok_q1" tok_q2',
        leaks: ["tok_q1", "tok_q2"],
      },
      {
        label: "INI leading empty quotes bypass",
        line: 'password=""real_ini_secret_456',
        format: "ini",
        leaks: ["real_ini_secret_456"],
      },
      {
        label: "ENV leading empty quotes bypass",
        line: 'password=""real_env_secret_456',
        format: "env",
        leaks: ["real_env_secret_456"],
      },
      {
        label: "Properties leading empty quotes bypass",
        line: 'password=""real_prop_secret_456',
        format: "properties",
        leaks: ["real_prop_secret_456"],
      },
      {
        label: "Properties quoted prefix with hash tail",
        line: 'api_key="a" # real_prop_hash_secret',
        format: "properties",
        leaks: ["real_prop_hash_secret"],
      },
      {
        label: "INI quoted prefix + tail bypass",
        line: 'api_key="a"real_tail_789',
        format: "ini",
        leaks: ["real_tail_789"],
      },
      {
        label: "ENV quoted prefix + tail bypass",
        line: 'api_key="a"real_tail_789',
        format: "env",
        leaks: ["real_tail_789"],
      },
      {
        label: "Unspecified format quoted prefix + tail bypass",
        line: 'api_key="a"real_tail_789',
        leaks: ["real_tail_789"],
      },
      {
        label: "TOML empty triple-quote prefix bypass",
        line: 'password = """"""real_triple_secret_000',
        format: "toml",
        leaks: ["real_triple_secret_000"],
      },
    ];

    for (const tc of cases) {
      const masked = maskDocumentLines(tc.line, tc.format ? { format: tc.format } : {}).lines.join("\n");
      for (const leak of tc.leaks) {
        expect(masked, `${tc.label} leaked ${leak}`).not.toContain(leak);
      }
      expect(masked, `${tc.label} did not mask`).toContain(DIFF_SECRET_MASK);

      // Also verify via UnifiedDiff
      const diff = computeUnifiedDiff(tc.line + "\n", tc.line + "_v2\n", 1);
      const maskedDiff = maskUnifiedDiff(diff, tc.format ? { format: tc.format } : {});
      const rendered = maskedDiff.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
      for (const leak of tc.leaks) {
        expect(rendered, `${tc.label} UnifiedDiff leaked ${leak}`).not.toContain(leak);
      }
    }

    // Legitimate empty quoted strings and valid comments/commas remain preserved outside .properties
    expect(maskDocumentLines('password=""', { format: "env" }).lines[0]).toBe('password=""');
    expect(maskDocumentLines('password = "secret-val" # keep note', { format: "toml" }).lines[0]).toBe(
      `password = "${DIFF_SECRET_MASK}" # keep note`,
    );
    expect(maskDocumentLines('  "apiKey": "secret-val", // jsonc note', { format: "jsonc" }).lines[0]).toBe(
      `  "apiKey": "${DIFF_SECRET_MASK}", // jsonc note`,
    );
  });

  /* ------------------------------------------------------------------------ */
  /* P0-3: JSON Schema 10,000-item flat allOf / oneOf O(N) & step budget      */
  /* ------------------------------------------------------------------------ */
  it("P0-3: bounds 10,000-item flat allOf and oneOf schemas within MAX_RESOLUTION_STEPS in milliseconds", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-recheck-p03-schema-"));
    tempDirs.push(root);
    const cfgFile = join(root, "config.json");

    // 1. Exact 10,000-item flat allOf DoS schema (~428 KB, previously blocked ~12.5s)
    const flatAllOfSchema = {
      type: "object",
      allOf: Array.from({ length: 10_000 }, (_, i) => ({
        properties: { [`k${i}`]: { type: "string" } },
      })),
    };
    await writeFile(join(root, "allof-10k.schema.json"), JSON.stringify(flatAllOfSchema), "utf8");
    await writeFile(cfgFile, JSON.stringify({ $schema: "./allof-10k.schema.json", k0: "ok" }), "utf8");

    const allOfStart = performance.now();
    const allOfRes = await inferJsonSchemaFields(cfgFile, root, { $schema: "./allof-10k.schema.json", k0: "ok" });
    const allOfElapsed = performance.now() - allOfStart;
    expect(allOfElapsed).toBeLessThan(500);
    expect(allOfRes.truncated).toBe(true);

    // 1b. Normal multi-item allOf (within step budget) merges properties & required in-place without loss
    const mediumAllOfSchema = {
      type: "object",
      required: ["base"],
      properties: { base: { type: "string" } },
      allOf: Array.from({ length: 200 }, (_, i) => ({
        required: i === 199 ? ["k199"] : undefined,
        properties: { [`k${i}`]: { type: "string" } },
      })),
    };
    await writeFile(join(root, "allof-200.schema.json"), JSON.stringify(mediumAllOfSchema), "utf8");
    const medRes = await inferJsonSchemaFields(cfgFile, root, { $schema: "./allof-200.schema.json" });
    expect(medRes.truncated).toBe(false);
    expect(medRes.fields.find((f) => f.segments.join(".") === "base")?.required).toBe(true);
    expect(medRes.fields.find((f) => f.segments.join(".") === "k0")).toBeDefined();
    expect(medRes.fields.find((f) => f.segments.join(".") === "k199")?.required).toBe(true);

    // 2. 10,000-item flat oneOf scalar const branches
    const flatOneOfEnumSchema = {
      type: "object",
      properties: {
        mode: {
          oneOf: Array.from({ length: 10_000 }, (_, i) => ({ const: `v${i}` })),
        },
      },
    };
    await writeFile(join(root, "oneof-enum-10k.schema.json"), JSON.stringify(flatOneOfEnumSchema), "utf8");
    const oneOfEnumStart = performance.now();
    const oneOfEnumRes = await inferJsonSchemaFields(cfgFile, root, { $schema: "./oneof-enum-10k.schema.json" });
    expect(performance.now() - oneOfEnumStart).toBeLessThan(1_000);
    expect(oneOfEnumRes.truncated).toBe(true);

    // 3. Large multi-branch oneOf enum deduplication caps at MAX_SCHEMA_ENUM_VALUES (100) using Set
    const cappedEnumSchema = {
      type: "object",
      properties: {
        region: {
          oneOf: [
            { enum: Array.from({ length: 250 }, (_, i) => `r-${i}`) },
            { enum: Array.from({ length: 250 }, (_, i) => `r-${i + 50}`) },
          ],
        },
      },
    };
    await writeFile(join(root, "oneof-capped.schema.json"), JSON.stringify(cappedEnumSchema), "utf8");
    const cappedRes = await inferJsonSchemaFields(cfgFile, root, { $schema: "./oneof-capped.schema.json" });
    const regionField = cappedRes.fields.find((f) => f.segments.join(".") === "region");
    expect(regionField?.enum).toHaveLength(100);
    expect(cappedRes.truncated).toBe(false);

    // 4. 10,000-item flat oneOf object union (hits resolveObjectUnionSchema + mergeOneOrAnyOf step cap)
    const flatOneOfObjSchema = {
      type: "object",
      oneOf: Array.from({ length: 10_000 }, (_, i) => ({
        properties: { [`u${i}`]: { type: "string" } },
      })),
    };
    await writeFile(join(root, "oneof-obj-10k.schema.json"), JSON.stringify(flatOneOfObjSchema), "utf8");
    const oneOfObjStart = performance.now();
    const oneOfObjRes = await inferJsonSchemaFields(cfgFile, root, { $schema: "./oneof-obj-10k.schema.json" });
    expect(performance.now() - oneOfObjStart).toBeLessThan(1_000);
    expect(oneOfObjRes.truncated).toBe(true);
  });

  /* ------------------------------------------------------------------------ */
  /* P1-1: Collapse / toggleAllCards / toggleCardJson / NestedObjectTree      */
  /* ------------------------------------------------------------------------ */
  it("P1-1: clears unmounted DeepJsonFallbackBlock subErrors by path prefix on collapse and card JSON transitions", async () => {
    // Prefix cleanup semantics for card collapse, toggleAllCards, and NestedObjectTree ancestor collapse
    let draft = createJsonDraft({ nested: { tags: ["a"], deep: { a: { b: { c: { x: 1 } } } } }, nested2: { tags: ["b"] } });
    draft = withJsonDraftSubError(draft, "deep.nested.tags", "JSON 语法无效");
    draft = withJsonDraftSubError(draft, "deep.nested.deep.a.b.c", "JSON 语法无效");
    draft = withJsonDraftSubError(draft, "deep.nested2.tags", "JSON 语法无效");

    const afterCollapseNested = clearJsonDraftSubErrors(draft, "deep.nested");
    expect(afterCollapseNested.subErrors).toEqual({ "deep.nested2.tags": "JSON 语法无效" });

    let cardsDraft = createJsonDraft([{ args: ["--prod"] }, { args: ["--dev"] }]);
    cardsDraft = withJsonDraftSubError(cardsDraft, "configurations[0].args", "JSON 语法无效");
    cardsDraft = withJsonDraftSubError(cardsDraft, "configurations[0].env.tags", "JSON 语法无效");
    cardsDraft = withJsonDraftSubError(cardsDraft, "configurations[1].args", "JSON 语法无效");

    // Collapsing card #0 clears only card #0 subErrors, preserving card #1
    const afterCollapseCard0 = clearJsonDraftSubErrors(cardsDraft, "configurations[0]");
    expect(afterCollapseCard0.subErrors).toEqual({ "configurations[1].args": "JSON 语法无效" });

    // Collapsing all cards via field prefix clears all cards' form subErrors
    const afterCollapseAll = clearJsonDraftSubErrors(cardsDraft, "configurations");
    expect(afterCollapseAll.subErrors).toBeUndefined();

    // Source contracts in StructuredControls.tsx
    const source = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    const toggleCardJsonStart = source.indexOf("function toggleCardJson");
    const toggleCardJsonEnd = source.indexOf("function handleCardJsonInput");
    const toggleCardJsonBody = source.slice(toggleCardJsonStart, toggleCardJsonEnd);
    expect(toggleCardJsonBody).toContain("clearJsonDraftSubErrors(draft, cardPath)");
    expect(toggleCardJsonBody).toContain("clearJsonDraftSubErrors(nextDraft, cardPath)");

    const toggleAllStart = source.indexOf("function toggleAllCards");
    const toggleAllBody = source.slice(toggleAllStart, toggleAllStart + 500);
    expect(toggleAllBody).toContain("clearJsonDraftSubErrors(draft, fieldPrefix)");

    expect(source).not.toContain("if (expanded && exceedsDepth) onSubError?.(childPath, undefined);");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-2: Multi-doc YAML SaveConfirmModal & RestoreBackupModal scoping       */
  /* ------------------------------------------------------------------------ */
  it("P1-2: isolates multi-doc YAML writeOnly/password secrets across SaveConfirmModal (fields + Unified Diff) and RestoreBackupModal", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-recheck-p12-multidoc-"));
    tempDirs.push(root);

    await writeFile(
      join(root, "doc0.schema.json"),
      JSON.stringify({
        type: "object",
        properties: {
          code: { type: "string", writeOnly: true },
          kind: { type: "string" },
          port: { type: "integer" },
          extraNote: { type: "string" },
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
          port: { type: "integer" },
        },
      }),
      "utf8",
    );

    const multiYaml = [
      "# yaml-language-server: $schema=./doc0.schema.json",
      "kind: Deployment",
      "code: doc0-writeonly-secret-111",
      "port: 8000",
      "---",
      "# yaml-language-server: $schema=./doc1.schema.json",
      "kind: Service",
      "code: HTTP_200_PUBLIC",
      "vaultRef: doc1-password-secret-222",
      "port: 8080",
    ].join("\n") + "\n";

    await writeFile(join(root, "multi.yaml"), multiYaml, "utf8");
    const doc0Schema = await inferConfig(root, "multi.yaml", { documentIndex: 0 });
    expect(doc0Schema.documentSecrets).toHaveLength(2);

    // 1. SaveConfirmModal Unified Diff when editing Doc 0 (and shifting Doc 1's line numbers!)
    const savePreview = await previewSave(
      root,
      "multi.yaml",
      [
        { segments: ["port"], value: 8001 },
        { segments: ["extraNote"], value: "added-line-shifts-doc1" },
      ],
      doc0Schema.version,
      0,
    );
    const oldRanges = scanYamlDocumentLineRanges(doc0Schema.rawText);
    const newRanges = scanYamlDocumentLineRanges(savePreview.output);
    expect(oldRanges).toHaveLength(2);
    expect(newRanges).toHaveLength(2);
    expect(newRanges[1]!.startLine).toBe(oldRanges[1]!.startLine + 1);

    const oldDocSecrets = buildYamlDocumentLineSecrets(doc0Schema.rawText, doc0Schema.documentSecrets!);
    const newDocSecrets = buildYamlDocumentLineSecrets(savePreview.output, doc0Schema.documentSecrets!);
    const diff = computeUnifiedDiff(doc0Schema.rawText, savePreview.output, 5);
    const maskedDiff = maskUnifiedDiff(diff, {
      format: "yaml",
      oldText: doc0Schema.rawText,
      newText: savePreview.output,
      oldDocumentSecrets: oldDocSecrets,
      newDocumentSecrets: newDocSecrets,
    });
    const diffRendered = maskedDiff.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(diffRendered).not.toContain("doc0-writeonly-secret-111");
    expect(diffRendered).not.toContain("doc1-password-secret-222");
    expect(diffRendered).toContain(`code: ${DIFF_SECRET_MASK}`);
    expect(diffRendered).toContain(`vaultRef: ${DIFF_SECRET_MASK}`);
    // Doc 1 public `code` must NOT be falsely masked by Doc 0's `writeOnly` `code`
    expect(diffRendered).toContain("code: HTTP_200_PUBLIC");

    // 2. SaveConfirmModal Fields tab when CompareSync targets Doc 1 while active doc is Doc 0 (`fields = []`)
    const doc1Meta = doc0Schema.documentSecrets!.find((m) => m.documentIndex === 1)!;
    expect(
      isSaveChangeSecret(
        { path: "vaultRef", before: "doc1-password-secret-222", after: "doc1-rotated-secret-333" },
        [],
        doc1Meta,
      ),
    ).toBe(true);
    expect(
      isSaveChangeSecret(
        { path: "code", before: "HTTP_200_PUBLIC", after: "HTTP_201_PUBLIC" },
        [],
        doc1Meta,
      ),
    ).toBe(false);

    // 3. RestoreBackupModal multi-doc `.bak` diff with shifted lines & older backup secrets
    const backupYaml = [
      "# yaml-language-server: $schema=./doc0.schema.json",
      "kind: Deployment",
      "code: doc0-backup-old-secret-000",
      "extraNote: from-backup",
      "port: 8000",
      "---",
      "# yaml-language-server: $schema=./doc1.schema.json",
      "kind: Service",
      "code: HTTP_200_PUBLIC",
      "vaultRef: doc1-backup-old-secret-999",
      "port: 8080",
    ].join("\n") + "\n";

    const restoreDiff = computeUnifiedDiff(doc0Schema.rawText, backupYaml, 3);
    const restoreMasked = maskUnifiedDiff(restoreDiff, {
      format: "yaml",
      oldText: doc0Schema.rawText,
      newText: backupYaml,
      oldDocumentSecrets: buildYamlDocumentLineSecrets(doc0Schema.rawText, doc0Schema.documentSecrets!),
      newDocumentSecrets: buildYamlDocumentLineSecrets(backupYaml, doc0Schema.documentSecrets!),
    });
    const restoreRendered = restoreMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(restoreRendered).not.toContain("doc0-writeonly-secret-111");
    expect(restoreRendered).not.toContain("doc0-backup-old-secret-000");
    expect(restoreRendered).not.toContain("doc1-password-secret-222");
    expect(restoreRendered).not.toContain("doc1-backup-old-secret-999");
    expect(restoreRendered).toContain("code: HTTP_200_PUBLIC");

    // 4. Component wiring contracts
    const saveModalSrc = await readFile(resolve(REPO_ROOT, "web/src/components/SaveConfirmModal.tsx"), "utf8");
    expect(saveModalSrc).toContain("isSaveChangeSecret");
    expect(saveModalSrc).toContain("oldDocumentSecrets={oldDocumentSecrets}");
    expect(saveModalSrc).toContain("newDocumentSecrets={newDocumentSecrets}");

    const restoreModalSrc = await readFile(resolve(REPO_ROOT, "web/src/components/RestoreBackupModal.tsx"), "utf8");
    expect(restoreModalSrc).toContain("buildYamlDocumentLineSecrets");
    expect(restoreModalSrc).toContain("oldDocumentSecrets={oldDocumentSecrets}");
    expect(restoreModalSrc).toContain("newDocumentSecrets={newDocumentSecrets}");

    const appSrc = await readFile(resolve(REPO_ROOT, "web/src/App.tsx"), "utf8");
    expect(appSrc).toContain("documentSecrets={schema?.file === restorePreview.file ? schema.documentSecrets : undefined}");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-3: FieldEditor clears deepFocusTarget + one-shot handledFocusTokenRef */
  /* ------------------------------------------------------------------------ */
  it("P1-3: clears deepFocusTarget in FieldEditor timer and consumes tokens strictly once in NestedObjectTree and StructuredObjectArrayControl", async () => {
    const fieldEditorSrc = await readFile(resolve(REPO_ROOT, "web/src/FieldEditor.tsx"), "utf8");
    expect(fieldEditorSrc).toContain(
      "setDeepFocusTarget((current) => (current?.token === requestToken ? undefined : current));",
    );

    const structuredSrc = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    // StructuredObjectArrayControl, StructuredObjectControl, and NestedObjectTree all guard via handledFocusTokenRef
    const tokenGuardMatches = structuredSrc.match(/handledFocusTokenRef\.current === deepFocusTarget\.token/g) ?? [];
    expect(tokenGuardMatches.length).toBeGreaterThanOrEqual(3);

    // NestedObjectTree depends on stable `basePath` (not per-render `baseSegments` array reference)
    const nestedStart = structuredSrc.indexOf("export function NestedObjectTree");
    const nestedEnd = structuredSrc.indexOf("function emitWithEntries", nestedStart);
    const nestedEffectBlock = structuredSrc.slice(nestedStart, nestedEnd);
    expect(nestedEffectBlock).toContain("handledFocusTokenRef.current = deepFocusTarget.token");
    expect(nestedEffectBlock).toContain("highlightTimerRef");
    expect(nestedEffectBlock).toContain("[deepFocusTarget?.path, deepFocusTarget?.segments, deepFocusTarget?.token, basePath]");
  });
});
