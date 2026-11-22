import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectSecretsFromFields,
  computeUnifiedDiff,
  DIFF_SECRET_MASK,
  formatUnifiedDiffText,
  maskDocumentLines,
  maskUnifiedDiff,
} from "../shared/diff.ts";
import type { FieldSpec } from "../shared/schema.ts";
import {
  isForbiddenKey,
  isHexColor,
  isHexColor6,
  normalizeGithubUrl,
  parseGithubRepository,
  SECRET_KEY_PATTERN,
  valueContainsSecret,
} from "../shared/validation.ts";
import {
  allowedCustomFieldTypes,
  createCustomFieldSpec,
  createJsonDraft,
  filterFieldsByStatus,
  initialFieldEditorValue,
  isEditableKeyboardTarget,
  isFieldModified,
  isFlatScalarObject,
  isScalarArray,
  validateNewKeyPath,
  validationErrors,
  fieldKey,
} from "../web/src/editor-state.ts";
import { isFileDragEvent } from "../web/src/components/HomePage.tsx";
import { DICTIONARIES, translate } from "../web/src/i18n/index.tsx";
import {
  computeCenteredScrollTop,
  computeMaxLineCharWidth,
  computeVirtualWindow,
  findLineMatchRanges,
  segmentLineMatches,
} from "../web/src/utils/virtual-scroll.ts";
import { formatDisplayValue } from "../web/src/value-display.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function makeField(patch: Partial<FieldSpec>): FieldSpec {
  return {
    path: "port",
    segments: ["port"],
    label: "Port",
    type: "integer",
    source: "heuristic",
    confidence: 0.8,
    evidence: [],
    ...patch,
  };
}

describe("UI state, diff, validation & i18n integration", () => {
  it("computes accurate LCS unified diff hunks and formatted diff output", () => {
    const before = "line1\nport = 3000\nhost = localhost\nline4\n";
    const after = "line1\nport = 8080\nhost = localhost\ntimeout = 30\nline4\n";
    const diff = computeUnifiedDiff(before, after, 1);

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.hunks.length).toBe(1);
    const text = formatUnifiedDiffText(before, after, "config.toml", 1);
    expect(text).toContain("--- a/config.toml");
    expect(text).toContain("+++ b/config.toml");
    expect(text).toContain("-port = 3000");
    expect(text).toContain("+port = 8080");
    expect(text).toContain("+timeout = 30");
    expect(computeUnifiedDiff(before, before).hunks).toEqual([]);
  });

  it("masks secret values in Unified Diff hunks without hiding modified secret lines", () => {
    const before = [
      'API_KEY="sk-old-secret-1234567890"',
      "DATABASE_URL=postgres://admin:oldpass@db.local/app # primary db",
      "vaultCode=old-vault-pin",
      "PORT=3000",
    ].join("\n") + "\n";
    const after = [
      'API_KEY="sk-new-secret-9876543210"',
      "DATABASE_URL=postgres://admin:newpass@db.local/app # primary db",
      "vaultCode=new-vault-pin",
      "PORT=8080",
    ].join("\n") + "\n";

    const rawDiff = computeUnifiedDiff(before, after, 1);
    const { diff, maskedLineCount } = maskUnifiedDiff(rawDiff, {
      secretKeys: ["vaultCode"],
      secretValues: ["old-vault-pin", "new-vault-pin"],
    });

    expect(maskedLineCount).toBeGreaterThanOrEqual(6);
    const rendered = diff.hunks.flatMap((h) => h.lines.map((l) => `${l.kind}:${l.text}`)).join("\n");
    expect(rendered).not.toContain("sk-old-secret");
    expect(rendered).not.toContain("sk-new-secret");
    expect(rendered).not.toContain("oldpass");
    expect(rendered).not.toContain("newpass");
    expect(rendered).not.toContain("old-vault-pin");
    expect(rendered).not.toContain("new-vault-pin");
    expect(rendered).toContain(`remove:API_KEY="${DIFF_SECRET_MASK}"`);
    expect(rendered).toContain(`add:API_KEY="${DIFF_SECRET_MASK}"`);
    expect(rendered).toContain(`remove:vaultCode=${DIFF_SECRET_MASK}`);
    expect(rendered).toContain(`add:vaultCode=${DIFF_SECRET_MASK}`);
    expect(rendered).toContain("# primary db");
    expect(rendered).toContain("remove:PORT=3000");
    expect(rendered).toContain("add:PORT=8080");

    // YAML block scalar secret masking
    const yamlBefore = "ssh_private_key: |\n  line-secret-1\n  line-secret-2\nsafe: ok\n";
    const yamlAfter = "ssh_private_key: |\n  line-secret-3\n  line-secret-2\nsafe: ok\n";
    const yamlMasked = maskUnifiedDiff(computeUnifiedDiff(yamlBefore, yamlAfter, 3));
    const yamlLines = yamlMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(yamlLines).not.toContain("line-secret");
    expect(yamlLines).toContain(`  ${DIFF_SECRET_MASK}`);
    expect(yamlLines).toContain("safe: ok");
  });

  it("prevents cross-format & cross-hunk secret redaction bypasses (TOML triple quotes, PEM, YAML blocks, arrays, .properties, Digest, empty-user DSN)", () => {
    // 1. Expanded secret key names & empty-username DSNs
    expect(SECRET_KEY_PATTERN.test("REDIS_URL")).toBe(true);
    expect(SECRET_KEY_PATTERN.test("SMTP_PASS")).toBe(true);
    expect(valueContainsSecret("redis://:my_pass@host:6379")).toBe(true);
    expect(valueContainsSecret(["safe", "redis://:my_pass@host:6379"])).toBe(true);
    expect(valueContainsSecret({ nested: { header: 'Digest username="alice", nonce="abc", response="deadbeef"' } })).toBe(true);
    expect(valueContainsSecret({ host: "localhost", port: 6379 })).toBe(false);

    // 2. TOML triple-quoted strings (single-line + multi-line + empty preservation)
    const tomlBefore = [
      'api_secret = """single-line-top-secret"""',
      "token = '''literal-secret\\tail'''",
      'empty_secret = """"""',
      'multiline_secret = """',
      ...Array.from({ length: 12 }, (_, i) => `toml-secret-line-${i + 1}`),
      '"""',
      'host = "localhost"',
    ].join("\n") + "\n";
    const tomlAfter = tomlBefore.replace("toml-secret-line-8", "toml-secret-line-8-changed");
    const tomlMasked = maskUnifiedDiff(computeUnifiedDiff(tomlBefore, tomlAfter, 2), { format: "toml" });
    const tomlDiffText = tomlMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(tomlDiffText).not.toContain("toml-secret-line");
    expect(tomlDiffText).toContain(DIFF_SECRET_MASK);

    const tomlFullDoc = maskDocumentLines(tomlBefore, { format: "toml" }).lines.join("\n");
    expect(tomlFullDoc).toContain(`api_secret = """${DIFF_SECRET_MASK}"""`);
    expect(tomlFullDoc).toContain(`token = '''${DIFF_SECRET_MASK}'''`);
    expect(tomlFullDoc).toContain('empty_secret = """"""');
    expect(tomlFullDoc).not.toContain("single-line-top-secret");
    expect(tomlFullDoc).not.toContain("literal-secret");
    expect(tomlFullDoc).not.toContain("toml-secret-line");
    expect(tomlFullDoc).toContain('host = "localhost"');

    // 3. Cross-hunk truncation for YAML block scalar, PEM block, and JSON/YAML secret arrays
    const yamlDeepBefore = [
      "private_key: |",
      ...Array.from({ length: 14 }, (_, i) => `  yaml-secret-row-${i + 1}`),
      "api_keys:",
      ...Array.from({ length: 12 }, (_, i) => `  - yaml-arr-secret-${i + 1}`),
      "safe: keep",
    ].join("\n") + "\n";
    const yamlDeepAfter = yamlDeepBefore
      .replace("yaml-secret-row-9", "yaml-secret-row-9-edited")
      .replace("yaml-arr-secret-8", "yaml-arr-secret-8-edited");
    const yamlDeepMasked = maskUnifiedDiff(computeUnifiedDiff(yamlDeepBefore, yamlDeepAfter, 2), { format: "yaml" });
    const yamlDeepText = yamlDeepMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(yamlDeepText).not.toContain("yaml-secret-row");
    expect(yamlDeepText).not.toContain("yaml-arr-secret");

    const pemBefore = [
      "-----BEGIN RSA PRIVATE KEY-----",
      ...Array.from({ length: 14 }, (_, i) => `MIIE_BASE64_SECRET_LINE_${i + 1}`),
      "-----END RSA PRIVATE KEY-----",
    ].join("\n") + "\n";
    const pemAfter = pemBefore.replace("MIIE_BASE64_SECRET_LINE_8", "MIIE_BASE64_SECRET_LINE_8_MOD");
    const pemMasked = maskUnifiedDiff(computeUnifiedDiff(pemBefore, pemAfter, 2));
    const pemText = pemMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(pemText).not.toContain("MIIE_BASE64_SECRET");

    const jsonArrBefore = [
      "{",
      '  "api_keys": [',
      ...Array.from({ length: 12 }, (_, i) => `    "json-arr-secret-${i + 1}"${i < 11 ? "," : ""}`),
      "  ],",
      '  "credentials": {"primary": "obj-secret-1", "backup": "obj-secret-2"},',
      '  "mixed": {"host": "localhost", "apiKeys": ["nested-arr-1", "nested-arr-2"]},',
      '  "cache": "redis://:empty_user_pass@redis.internal:6379"',
      "}",
    ].join("\n") + "\n";
    const jsonArrAfter = jsonArrBefore.replace("json-arr-secret-7", "json-arr-secret-7-mod");
    const jsonArrMasked = maskUnifiedDiff(computeUnifiedDiff(jsonArrBefore, jsonArrAfter, 2), { format: "json" });
    expect(jsonArrMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n")).not.toContain("json-arr-secret");
    const jsonFullMasked = maskDocumentLines(jsonArrBefore, { format: "json" }).lines.join("\n");
    expect(jsonFullMasked).not.toContain("obj-secret-1");
    expect(jsonFullMasked).not.toContain("obj-secret-2");
    expect(jsonFullMasked).not.toContain("nested-arr-1");
    expect(jsonFullMasked).not.toContain("nested-arr-2");
    expect(jsonFullMasked).not.toContain("empty_user_pass");
    expect(jsonFullMasked).toContain('"host": "localhost"');

    // 4. .properties whitespace separator, backslash continuation, unquoted ` #` / ` //`, and Bearer/Digest headers
    const propsDoc = [
      "db.password whitespace-secret-val",
      "smtp.pass = first-part-secret\\",
      "  second-part-secret\\",
      "  third-part-secret",
      "mail.password = secret-with #hash-inside",
      "auth.header = Digest username=\"Mufasa\", realm=\"test\", nonce=\"abc\", response=\"6629fae4\"",
      "service.host = example.com",
    ].join("\n");
    const propsMasked = maskDocumentLines(propsDoc, { format: "properties" }).lines.join("\n");
    expect(propsMasked).not.toContain("whitespace-secret-val");
    expect(propsMasked).not.toContain("first-part-secret");
    expect(propsMasked).not.toContain("second-part-secret");
    expect(propsMasked).not.toContain("third-part-secret");
    expect(propsMasked).not.toContain("hash-inside");
    expect(propsMasked).not.toContain("Mufasa");
    expect(propsMasked).not.toContain("6629fae4");
    expect(propsMasked).toContain("service.host = example.com");

    // Unquoted value with ` //` in .env must not leak tail after ` //`
    const envWithSlashes = [
      "SMTP_PASS=my-secret //not-a-comment",
      'CUSTOM_HDR="Digest username=\\"bob\\", nonce=\\"xyz\\", response=\\"9f86d08\\""',
      "CUSTOM_BEARER=Bearer secret-bearer-token-99",
    ].join("\n");
    const envMasked = maskDocumentLines(envWithSlashes, { format: "env" }).lines.join("\n");
    expect(envMasked).not.toContain("not-a-comment");
    expect(envMasked).not.toContain("bob");
    expect(envMasked).not.toContain("9f86d08");
    expect(envMasked).not.toContain("secret-bearer-token-99");

    // 5. Recursive secret collection from fields (arrays, objects, multi-line)
    const collected = collectSecretsFromFields([
      makeField({ path: "apiKeys", segments: ["apiKeys"], type: "array", secret: true, value: ["arr-key-111", "arr-key-222"] }),
      makeField({ path: "pem", segments: ["pem"], type: "secret", secret: true, value: "line-one-secret\nline-two-secret" }),
      makeField({ path: "services", segments: ["services"], type: "json", value: { redis: { password: "nested-obj-pass" } } }),
    ]);
    expect(collected.secretValues).toEqual(expect.arrayContaining([
      "arr-key-111",
      "arr-key-222",
      "line-one-secret",
      "line-two-secret",
      "nested-obj-pass",
    ]));
  });

  it("excludes input, textarea and contenteditable targets from global Ctrl+Z/Y hijacking", () => {
    expect(isEditableKeyboardTarget({ tagName: "INPUT" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "textarea" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", getAttribute: () => "true" })).toBe(true);
    expect(isEditableKeyboardTarget({ tagName: "DIV", getAttribute: () => "false" })).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableKeyboardTarget({ tagName: "SPAN", parentElement: { tagName: "INPUT" }, closest: () => ({}) })).toBe(true);
    expect(isEditableKeyboardTarget(null)).toBe(false);
  });

  it("filters fields cleanly across all/modified/error/required status pills", () => {
    const f1 = makeField({ path: "port", segments: ["port"], value: 3000, required: true });
    const f2 = makeField({ path: "host", segments: ["host"], type: "string", value: "localhost", required: false });
    const f3 = makeField({ path: "retries", segments: ["retries"], value: 3, minimum: 1, required: true });
    const fields = [f1, f2, f3];
    const values = {
      [fieldKey(f1)]: 8080, // modified
      [fieldKey(f2)]: "localhost", // untouched
      [fieldKey(f3)]: 0, // modified + error (below minimum)
    };
    const errs = validationErrors(fields, values, "json", "en-US");

    expect(filterFieldsByStatus(fields, values, errs, undefined, "all").map((f) => f.path)).toEqual(["port", "host", "retries"]);
    expect(filterFieldsByStatus(fields, values, errs, undefined, "modified").map((f) => f.path)).toEqual(["port", "retries"]);
    expect(filterFieldsByStatus(fields, values, errs, undefined, "error").map((f) => f.path)).toEqual(["retries"]);
    expect(filterFieldsByStatus(fields, values, errs, undefined, "required").map((f) => f.path)).toEqual(["port", "retries"]);
  });

  it("computes bounded virtual scroll windows and centered line offsets for large files", () => {
    const totalLines = 20_000;
    const rowHeight = 22;
    const viewport = 440; // 20 visible rows

    const topWin = computeVirtualWindow(totalLines, 0, viewport, rowHeight, 10);
    expect(topWin.startIndex).toBe(0);
    expect(topWin.endIndex).toBe(30);
    expect(topWin.topSpacerPx).toBe(0);
    expect(topWin.topSpacerPx + (topWin.endIndex - topWin.startIndex) * rowHeight + topWin.bottomSpacerPx).toBe(totalLines * rowHeight);

    const midScroll = computeCenteredScrollTop(10_000, viewport, rowHeight, totalLines);
    const midWin = computeVirtualWindow(totalLines, midScroll, viewport, rowHeight, 10);
    expect(midWin.startIndex).toBeLessThanOrEqual(10_000);
    expect(midWin.endIndex).toBeGreaterThan(10_000);
    expect(midWin.endIndex - midWin.startIndex).toBeLessThanOrEqual(45);

    const bottomScroll = computeCenteredScrollTop(19_999, viewport, rowHeight, totalLines);
    const bottomWin = computeVirtualWindow(totalLines, bottomScroll, viewport, rowHeight, 10);
    expect(bottomWin.endIndex).toBe(totalLines);
    expect(bottomWin.bottomSpacerPx).toBe(0);

    // Accounts for vertical container padding (.raw-lines 12px top/bottom)
    const padWin = computeVirtualWindow(totalLines, 0, viewport, rowHeight, 10, 12, 12);
    expect(padWin.totalHeightPx).toBe(totalLines * rowHeight + 24);
    const padCenter0 = computeCenteredScrollTop(100, viewport, rowHeight, totalLines, 12, 12);
    const unpaddedCenter0 = computeCenteredScrollTop(100, viewport, rowHeight, totalLines, 0, 0);
    expect(padCenter0 - unpaddedCenter0).toBe(12);

    // Stable horizontal width estimation across ASCII, tabs, CJK and emoji
    expect(computeMaxLineCharWidth(["short", "\tindented", "中文宽度测试", "a".repeat(240)])).toBe(240);
    expect(computeMaxLineCharWidth(["中文"])).toBe(4);
    expect(computeMaxLineCharWidth(["\ta"])).toBe(5);

    // Multi-code-unit Unicode case folding (`İ` U+0130 -> `i\u0307`) must NOT shift highlight slices
    const dottedLine = "İİİ_PORT=3000 # İ_port";
    const ranges = findLineMatchRanges(dottedLine, "port");
    expect(ranges.map((r) => dottedLine.slice(r.start, r.end))).toEqual(["PORT", "port"]);
    const segments = segmentLineMatches(dottedLine, "port", 0);
    expect(segments.filter((s) => s.matchIndex !== undefined).map((s) => s.text)).toEqual(["PORT", "port"]);
    expect(segments.map((s) => s.text).join("")).toBe(dottedLine);

    const dottedSelf = "İ_İ_ok";
    const selfSegs = segmentLineMatches(dottedSelf, "İ", 0);
    expect(selfSegs.filter((s) => s.matchIndex !== undefined).map((s) => s.text)).toEqual(["İ", "İ"]);
    expect(selfSegs.map((s) => s.text).join("")).toBe(dottedSelf);
  });

  it("distinguishes OS file drags from in-page text drags", () => {
    expect(isFileDragEvent({ types: ["Files"] })).toBe(true);
    expect(isFileDragEvent({ types: ["text/plain", "Files"] })).toBe(true);
    expect(isFileDragEvent({ types: ["text/plain", "text/html"] })).toBe(false);
    expect(isFileDragEvent(null)).toBe(false);
    expect(isFileDragEvent(undefined)).toBe(false);
  });

  it("enforces shared validation rules for colors, prototype keys and GitHub URLs", () => {
    expect(isHexColor("#fff")).toBe(true);
    expect(isHexColor("#11223344")).toBe(true);
    expect(isHexColor("#12345")).toBe(false);
    expect(isHexColor6("#2563eb")).toBe(true);
    expect(isHexColor6("#fff")).toBe(false);

    expect(isForbiddenKey("__proto__")).toBe(true);
    expect(isForbiddenKey("prototype")).toBe(true);
    expect(isForbiddenKey("constructor")).toBe(true);
    expect(isForbiddenKey("normalKey")).toBe(false);

    expect(normalizeGithubUrl("https://github.com/1Beyond1/confui.git")).toBe("https://github.com/1Beyond1/confui");
    expect(normalizeGithubUrl("git@github.com:1Beyond1/confui.git")).toBe("https://github.com/1Beyond1/confui");
    expect(normalizeGithubUrl("https://user:pass@github.com/1Beyond1/confui")).toBeUndefined();
    expect(normalizeGithubUrl("https://gitlab.com/1Beyond1/confui")).toBeUndefined();
    expect(parseGithubRepository("https://github.com/1Beyond1/confui")).toEqual({ owner: "1Beyond1", repo: "confui" });
  });

  it("validates custom key paths per format, blocks prototype pollution and parent-child conflicts", () => {
    const existing = [
      makeField({ path: "server.port", segments: ["server", "port"], value: 3000 }),
      makeField({ path: "PORT", segments: ["PORT"], value: "3000" }),
    ];

    expect(validateNewKeyPath("server.timeout", "yaml", existing).segments).toEqual(["server", "timeout"]);
    expect(validateNewKeyPath("server", "yaml", existing).error).toContain("父子冲突");
    expect(validateNewKeyPath("server.port.sub", "yaml", existing).error).toContain("父子冲突");
    expect(validateNewKeyPath("server.__proto__", "json", existing).error).toContain("__proto__");
    expect(validateNewKeyPath("123_BAD", "env", existing).error).toBeDefined();
    expect(validateNewKeyPath("NEW_KEY", "env", existing).segments).toEqual(["NEW_KEY"]);
    expect(validateNewKeyPath("app.retry.count", "properties", existing).segments).toEqual(["app.retry.count"]);
    expect(validateNewKeyPath("server.__proto__", "json", existing, "en-US").error).toContain("__proto__");

    expect(allowedCustomFieldTypes("env")).not.toContain("json");
    expect(allowedCustomFieldTypes("yaml")).toContain("json");
    expect(createCustomFieldSpec(["server", "timeout"], "integer", "Custom")).toMatchObject({
      path: "server.timeout",
      label: "timeout",
      group: "Custom",
    });
  });

  it("tracks per-field modification, reset values and structured visual eligibility", () => {
    const port = makeField({ value: 3000 });
    expect(isFieldModified(port, 3000)).toBe(false);
    expect(isFieldModified(port, 8080)).toBe(true);
    expect(initialFieldEditorValue(port)).toBe(3000);

    const list = makeField({ type: "array", value: ["a", "b"] });
    expect(isFieldModified(list, createJsonDraft(["a", "b"]))).toBe(false);
    expect(isFieldModified(list, createJsonDraft(["a", "c"]))).toBe(true);

    expect(isScalarArray(["a", 1, true, null])).toBe(true);
    expect(isScalarArray([{ nested: true }])).toBe(false);
    expect(isFlatScalarObject({ a: "1", b: 2, c: false })).toBe(true);
    expect(isFlatScalarObject({ a: { nested: 1 } })).toBe(false);
  });

  it("maintains 100% zh-CN / en-US i18n parity with zero leaked CJK in English mode", () => {
    const zhKeys = Object.keys(DICTIONARIES["zh-CN"]).sort();
    const enKeys = Object.keys(DICTIONARIES["en-US"]).sort();
    expect(enKeys).toEqual(zhKeys);

    for (const key of enKeys as Array<keyof typeof DICTIONARIES["en-US"]>) {
      const value = DICTIONARIES["en-US"][key];
      expect(value.length).toBeGreaterThan(0);
      if (key === "settings.langZh") continue; // Self-name "简体中文"
      expect(value, `en-US key "${key}" must not contain Chinese characters`).not.toMatch(/[\u4e00-\u9fff]/);
    }

    // Verify interpolation and localized validation/display outputs
    expect(translate("en-US", "topbar.saveCount", { count: 3 })).toBe("Save 3");
    expect(translate("zh-CN", "topbar.saveCount", { count: 3 })).toBe("保存 3 项");
    expect(formatDisplayValue(undefined, "en-US")).toBe("Unset");
    expect(formatDisplayValue("", "en-US")).toBe("Empty string");

    const requiredField = makeField({ required: true, value: "x" });
    const enErrors = validationErrors([requiredField], { [fieldKey(requiredField)]: "" }, "json", "en-US");
    expect(enErrors.get(fieldKey(requiredField))).toBe("This field is required");
  });

  it("keeps accessibility & IPC contracts intact in source files", async () => {
    const uiSource = await readFile(resolve(REPO_ROOT, "web/src/ui.tsx"), "utf8");
    expect(uiSource).toContain("useId()");
    expect(uiSource).not.toContain('id="modal-title"');

    const preloadSource = await readFile(resolve(REPO_ROOT, "electron/preload.ts"), "utf8");
    const mainSource = await readFile(resolve(REPO_ROOT, "electron/main.ts"), "utf8");
    for (const channel of [
      "confui:removeRecentProject",
      "confui:getBackupStatus",
      "confui:previewRestoreBackup",
      "confui:restoreBackup",
      "confui:createFromExample",
      "confui:compareConfigs",
      "confui:previewSyncConfig",
      "confui:previewRedactedExport",
      "confui:saveRedactedExport",
      "confui:searchProject",
    ]) {
      expect(preloadSource).toContain(channel);
      expect(mainSource).toContain(channel);
    }
    expect(preloadSource).toContain("webUtils.getPathForFile");

    // Stage 4 regression source-contract guards
    const rawViewerSource = await readFile(resolve(REPO_ROOT, "web/src/components/RawViewer.tsx"), "utf8");
    expect(rawViewerSource).not.toContain("scrollIntoView(");
    expect(rawViewerSource).toContain("viewportHeightRef");
    expect(rawViewerSource).toContain("maskDocumentLines");

    const appSource = await readFile(resolve(REPO_ROOT, "web/src/App.tsx"), "utf8");
    expect(appSource).not.toContain("fieldEditorRevision");
    expect(appSource).toContain("dirtyRef.current");
    expect(mainSource).toContain("inferSeq === activeInferSeq");
    expect(mainSource).toContain("activeSearchController?.abort()");

    // Stage 4 Wave 2 regression source-contract guards
    const structuredSource = await readFile(resolve(REPO_ROOT, "web/src/components/StructuredControls.tsx"), "utf8");
    expect(structuredSource).toContain("export function StructuredObjectArrayControl");
    expect(structuredSource).toContain("export function NestedObjectTree");
    expect(structuredSource).toContain("MAX_NESTED_TREE_DEPTH");
    expect(structuredSource).toContain("isNestedKeySensitive");
    expect(structuredSource).toContain("valueContainsSecret");

    const settingsPageSource = await readFile(resolve(REPO_ROOT, "web/src/SettingsPage.tsx"), "utf8");
    expect(settingsPageSource).toContain("schemaStore");

    const summarySource = await readFile(resolve(REPO_ROOT, "web/src/components/EditorSummary.tsx"), "utf8");
    expect(summarySource).toContain("yamlDocuments");
    expect(summarySource).toContain("onSelectYamlDocument");
  });
});
