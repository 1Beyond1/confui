import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeUnifiedDiff, DIFF_SECRET_MASK, formatUnifiedDiffText, maskUnifiedDiff } from "../shared/diff.ts";
import type { FieldSpec } from "../shared/schema.ts";
import {
  isForbiddenKey,
  isHexColor,
  isHexColor6,
  normalizeGithubUrl,
  parseGithubRepository,
} from "../shared/validation.ts";
import {
  allowedCustomFieldTypes,
  createCustomFieldSpec,
  createJsonDraft,
  initialFieldEditorValue,
  isEditableKeyboardTarget,
  isFieldModified,
  isFlatScalarObject,
  isScalarArray,
  validateNewKeyPath,
  validationErrors,
  fieldKey,
} from "../web/src/editor-state.ts";
import { DICTIONARIES, translate } from "../web/src/i18n/index.tsx";
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
  });
});
