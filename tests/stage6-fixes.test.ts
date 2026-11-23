import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEditableSyntax,
  detectFormat,
  isUnambiguousIniName,
  parseConfig,
  updateConfigText,
} from "../core/formats.ts";
import { patchEnv, stringifyEnv } from "../core/formats/env.ts";
import { patchIni } from "../core/formats/ini.ts";
import { inferConfig } from "../core/inference/index.ts";
import {
  commitSave,
  compareConfigFiles,
  generateRedactedExport,
  previewSave,
  previewSyncFromFile,
} from "../core/save.ts";
import { validateNewKeyPath } from "../web/src/editor-state.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("Stage 6 P1 fixes & P2 hardening regressions", () => {
  /* ------------------------------------------------------------------------ */
  /* P1-1: Monorepo subdirectory dotfiles (.env.*, .npmrc, .editorconfig, ...) */
  /* ------------------------------------------------------------------------ */
  it("P1-1: detects, opens, saves, compares, and redacted-exports monorepo subdirectory dotfiles on POSIX and Windows paths", async () => {
    expect(detectFormat("apps/api/.env")).toBe("env");
    expect(detectFormat("apps/api/.env.local")).toBe("env");
    expect(detectFormat("apps\\api\\.env.production")).toBe("env");
    expect(detectFormat("packages/web/.npmrc")).toBe("ini");
    expect(detectFormat("packages\\web\\.npmrc")).toBe("ini");
    expect(detectFormat("packages/web/.editorconfig")).toBe("ini");
    expect(detectFormat("packages\\web\\.editorconfig")).toBe("ini");
    expect(detectFormat("apps/web/.eslintrc")).toBe("json");
    expect(detectFormat("apps\\web\\.prettierrc")).toBe("json");
    expect(detectFormat("apps/api/")).toBeNull();

    expect(isUnambiguousIniName("packages/web/.npmrc")).toBe(true);
    expect(isUnambiguousIniName("packages\\web\\.npmrc")).toBe(true);
    expect(isUnambiguousIniName("packages/web/.editorconfig")).toBe(true);
    expect(isUnambiguousIniName("packages\\web\\.editorconfig")).toBe(true);
    expect(isUnambiguousIniName("apps/nginx/site.conf")).toBe(false);

    const root = await mkdtemp(join(tmpdir(), "confui-p11-monorepo-"));
    tempDirs.push(root);

    await mkdir(join(root, "apps", "api"), { recursive: true });
    await mkdir(join(root, "packages", "web"), { recursive: true });

    await writeFile(
      join(root, "apps", "api", ".env.local"),
      "PORT=3000\nAPI_SECRET=sk-monorepo-secret-123456\n",
      "utf8",
    );
    await writeFile(
      join(root, "apps", "api", ".env.production"),
      "PORT=8080\nNEW_FLAG=true\n",
      "utf8",
    );
    await writeFile(
      join(root, "packages", "web", ".npmrc"),
      "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm_1234567890abcdefghijklmnop\nsave-exact=false\n",
      "utf8",
    );
    await writeFile(
      join(root, "packages", "web", ".editorconfig"),
      "root = true\n\n[*]\nindent_size = 2\n",
      "utf8",
    );
    await writeFile(
      join(root, "packages", "web", ".eslintrc"),
      '{\n  "root": true\n}\n',
      "utf8",
    );
    await writeFile(
      join(root, "packages", "web", ".prettierrc"),
      '{\n  "semi": true\n}\n',
      "utf8",
    );

    // 1. Open, edit, save, compare, and redacted-export `apps/api/.env.local`
    const envSchema = await inferConfig(root, "apps/api/.env.local");
    expect(envSchema.format).toBe("env");
    const envPreview = await previewSave(
      root,
      "apps/api/.env.local",
      [{ segments: ["PORT"], value: "4000" }],
      envSchema.version,
    );
    await commitSave(root, envPreview);
    expect(await readFile(join(root, "apps", "api", ".env.local"), "utf8")).toContain("PORT=4000");

    const cmp = await compareConfigFiles(root, "apps/api/.env.production", "apps/api/.env.local");
    expect(cmp.sourceFormat).toBe("env");
    expect(cmp.targetFormat).toBe("env");
    expect(cmp.entries.find((e) => e.path === "NEW_FLAG")?.status).toBe("missing-in-target");

    const syncPreview = await previewSyncFromFile(
      root,
      "apps/api/.env.production",
      "apps/api/.env.local",
      [["NEW_FLAG"]],
      cmp.targetVersion,
    );
    expect(syncPreview.output).toContain("NEW_FLAG=true");

    const envRedacted = await generateRedactedExport(root, "apps/api/.env.local");
    expect(envRedacted.content).not.toContain("sk-monorepo-secret-123456");
    expect(envRedacted.suggestedFileName).toBe(".env.local.example");

    // 2. `.npmrc`, `.editorconfig`, `.eslintrc`, `.prettierrc` in subdirectories
    for (const relPath of [
      "packages/web/.npmrc",
      "packages/web/.editorconfig",
      "packages/web/.eslintrc",
      "packages/web/.prettierrc",
    ]) {
      const schema = await inferConfig(root, relPath);
      expect(schema.fields.length).toBeGreaterThan(0);
    }

    const npmRedacted = await generateRedactedExport(root, "packages/web/.npmrc");
    expect(npmRedacted.content).not.toContain("npm_1234567890abcdefghijklmnop");
    assertEditableSyntax("packages/web/.editorconfig", "root = true\n");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-2: Per-path suppressChanges Map & mainWindow.isDestroyed() guards     */
  /* ------------------------------------------------------------------------ */
  it("P1-2: replaces global suppressChange with per-path Map and guards mainWindow.isDestroyed()", async () => {
    const mainSource = await readFile(resolve(REPO_ROOT, "electron/main.ts"), "utf8");
    expect(mainSource).toContain("const suppressedChanges = new Map<string, { until: number; hash?: string }>()");
    expect(mainSource).not.toContain("let suppressChange:");
    expect(mainSource).toContain("runWithSuppressedChange");
    expect(mainSource).not.toContain("mainWindow?.webContents.send");
    const destroyedGuardCount = mainSource.match(/mainWindow && !mainWindow\.isDestroyed\(\)/g)?.length ?? 0;
    expect(destroyedGuardCount).toBeGreaterThanOrEqual(5);
  });

  /* ------------------------------------------------------------------------ */
  /* P1-3: YAML non-string Map keys (numbers, booleans, hex) edit & delete    */
  /* ------------------------------------------------------------------------ */
  it("P1-3: edits and deletes numeric and boolean YAML map keys in-place without duplicating quoted keys", () => {
    const yamlSrc = [
      "statusCodes:",
      "  100: Continue # keep comment",
      "  200: OK",
      "  404: Not Found",
      "flags:",
      "  true: enabled # bool key comment",
      "  false: disabled",
      "nested:",
      "  100:",
      "    label: info",
      "hexCodes:",
      "  0x10: sixteen",
    ].join("\n") + "\n";

    // Edit existing numeric/boolean/hex/nested keys + delete numeric & boolean keys
    const updated = updateConfigText(yamlSrc, "yaml", [
      { segments: ["statusCodes", "100"], value: "Proceed" },
      { segments: ["statusCodes", "404"], value: undefined },
      { segments: ["flags", "true"], value: "active" },
      { segments: ["flags", "false"], value: undefined },
      { segments: ["nested", "100", "label"], value: "informational" },
      { segments: ["hexCodes", "16"], value: "sixteen-v2" },
    ]);

    expect(updated.warnings).toEqual([]);
    // Must NOT append duplicate quoted `"100":` or `"true":`
    expect(updated.output).not.toContain('"100":');
    expect(updated.output).not.toContain("'100':");
    expect(updated.output).not.toContain('"true":');
    expect(updated.output).not.toContain("'true':");
    // Comments and unquoted keys preserved
    expect(updated.output).toContain("100: Proceed # keep comment");
    expect(updated.output).toContain("true: active # bool key comment");
    expect(updated.output).toContain("0x10: sixteen-v2");
    expect(updated.output).not.toContain("404:");
    expect(updated.output).not.toContain("false:");

    const reparsed = parseConfig(updated.output, "yaml");
    expect(reparsed).toEqual({
      statusCodes: { "100": "Proceed", "200": "OK" },
      flags: { true: "active" },
      nested: { "100": { label: "informational" } },
      hexCodes: { "16": "sixteen-v2" },
    });

    // Alias crossing under numeric map key must still trigger safe alias fallback
    const aliasedYaml = "base: &b\n  title: default\ncodes:\n  100: *b\n";
    const aliasedUpdated = updateConfigText(aliasedYaml, "yaml", [
      { segments: ["codes", "100", "title"], value: "custom" },
    ]);
    expect(aliasedUpdated.warnings.length).toBe(1);
    expect(parseConfig(aliasedUpdated.output, "yaml")).toEqual({
      base: { title: "default" },
      codes: { "100": { title: "custom" } },
    });
  });

  /* ------------------------------------------------------------------------ */
  /* P1-4: patchEnv & cross-format sync enforce strict ENV variable names     */
  /* ------------------------------------------------------------------------ */
  it("P1-4: rejects invalid ENV key names (=, newline, dash, dot, leading digit) in patchEnv, stringifyEnv, and cross-format sync", async () => {
    const invalidKeys = [
      "BAD=INJECT",
      "BAD\nINJECT=1",
      "BAD\rKEY",
      "my-dashed-key",
      "nested.dot.key",
      "123_STARTS_WITH_DIGIT",
      "SPACE KEY",
      "",
    ];

    for (const key of invalidKeys) {
      expect(() => patchEnv("PORT=3000\n", [{ segments: [key], value: "x" }])).toThrow(/ENV 变量名无效/);
      expect(() => stringifyEnv({ [key]: "x" })).toThrow(/ENV 变量名无效/);
    }

    // Valid ENV keys continue to work cleanly
    const ok = patchEnv("PORT=3000\n", [{ segments: ["APP_ENV_2"], value: "prod" }]);
    expect(ok).toContain("APP_ENV_2=prod");

    // Cross-format sync from JSON containing `my-key` / `a=b` into `.env` must throw explicitly instead of injecting/dropping
    const root = await mkdtemp(join(tmpdir(), "confui-p14-env-sync-"));
    tempDirs.push(root);
    await writeFile(join(root, "source.json"), JSON.stringify({ "bad-key": "1", "a=b": "2", VALID_KEY: "ok" }), "utf8");
    await writeFile(join(root, ".env"), "PORT=3000\n", "utf8");

    const cmp = await compareConfigFiles(root, "source.json", ".env");
    await expect(
      previewSyncFromFile(root, "source.json", ".env", [["bad-key"]], cmp.targetVersion),
    ).rejects.toThrow(/ENV 变量名无效/);
    await expect(
      previewSyncFromFile(root, "source.json", ".env", [["a=b"]], cmp.targetVersion),
    ).rejects.toThrow(/ENV 变量名无效/);

    const validSync = await previewSyncFromFile(root, "source.json", ".env", [["VALID_KEY"]], cmp.targetVersion);
    expect(validSync.output).toContain("VALID_KEY=ok");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-5: INI key validation rejects =, newlines, and control characters     */
  /* ------------------------------------------------------------------------ */
  it("P1-5: blocks INI keys/sections containing =, newlines, or control characters in both patchIni and validateNewKeyPath", () => {
    const badSegmentsList: string[][] = [
      ["bad=key"],
      ["section", "key=val"],
      ["sec=1", "key"],
      ["key\ninjected"],
      ["section", "key\r\n[evil]"],
      ["section", "key\x07bell"],
      ["section", "key\ttab"],
      ["section", "key\x7fdel"],
      ["   ", "key"],
    ];

    for (const segments of badSegmentsList) {
      expect(() => patchIni("[section]\nport=80\n", [{ segments, value: "x" }])).toThrow(/INI 节或键名无效/);
    }

    // Frontend validateNewKeyPath blocks invalid INI keys in both zh-CN and en-US
    expect(validateNewKeyPath("server.key=bad", "ini", [], "zh-CN").error).toContain("=");
    expect(validateNewKeyPath("server.key=bad", "ini", [], "en-US").error).toContain("=");
    expect(validateNewKeyPath("server.key\nevil", "ini", [], "zh-CN").error).toBeDefined();
    expect(validateNewKeyPath("server.key\x07", "ini", [], "en-US").error).toBeDefined();
    expect(validateNewKeyPath("server.key\n", "ini", [], "en-US").error).toBeDefined();

    // Valid INI multi-level dotted paths still pass cleanly
    expect(validateNewKeyPath("database.primary.host", "ini", [], "en-US")).toEqual({
      segments: ["database", "primary", "host"],
    });
  });

  /* ------------------------------------------------------------------------ */
  /* P2 Hardening: INI dotted section sync, dead exports removed, UI/CI guards*/
  /* ------------------------------------------------------------------------ */
  it("P2: allows legal multi-level dotted INI section sync and verifies dead-export removal, modal/settings/CI hardening", async () => {
    // 1. Multi-level dotted INI sync (`[database.primary]`) succeeds via previewSyncFromFile
    const root = await mkdtemp(join(tmpdir(), "confui-p2-ini-sync-"));
    tempDirs.push(root);
    await writeFile(
      join(root, "source.ini"),
      "[database.primary]\nhost = db.prod.internal\nport = 5432\n",
      "utf8",
    );
    await writeFile(
      join(root, "target.ini"),
      "[database.primary]\nhost = localhost\n",
      "utf8",
    );

    const cmp = await compareConfigFiles(root, "source.ini", "target.ini");
    const syncPreview = await previewSyncFromFile(
      root,
      "source.ini",
      "target.ini",
      [["database", "primary", "port"]],
      cmp.targetVersion,
    );
    expect(syncPreview.output).toContain("[database.primary]");
    expect(syncPreview.output).toContain("port=5432");
    await commitSave(root, syncPreview);
    expect(parseConfig(await readFile(join(root, "target.ini"), "utf8"), "ini")).toEqual({
      database: { primary: { host: "localhost", port: "5432" } },
    });

    // 2. Dead exports removed cleanly
    const tomlSrc = await readFile(resolve(REPO_ROOT, "core/formats/toml.ts"), "utf8");
    const pathsSrc = await readFile(resolve(REPO_ROOT, "core/paths.ts"), "utf8");
    const uiSrc = await readFile(resolve(REPO_ROOT, "web/src/ui.tsx"), "utf8");
    expect(tomlSrc).not.toContain("applyTomlChange");
    expect(pathsSrc).not.toContain("cloneValue");
    expect(uiSrc).not.toContain("SOURCE_LABELS");

    // 3. Modal closeDisabled + CompareSyncModal / ExportRedactedModal / SettingsPage guards
    expect(uiSrc).toContain("closeDisabled");
    expect(uiSrc).toContain("event.stopPropagation()");

    const compareSrc = await readFile(resolve(REPO_ROOT, "web/src/components/CompareSyncModal.tsx"), "utf8");
    expect(compareSrc).toContain("closeDisabled={syncing}");
    expect(compareSrc).toContain("mountedRef");
    expect(compareSrc).toContain("syncSeqRef");

    const exportSrc = await readFile(resolve(REPO_ROOT, "web/src/components/ExportRedactedModal.tsx"), "utf8");
    expect(exportSrc).toContain("closeDisabled={saving}");
    expect(exportSrc).toContain("copyTimerRef");
    expect(exportSrc).toContain("window.clearTimeout(copyTimerRef.current)");

    const settingsSrc = await readFile(resolve(REPO_ROOT, "web/src/SettingsPage.tsx"), "utf8");
    expect(settingsSrc).toContain("mountedRef");
    expect(settingsSrc).toContain("updateRun");

    // 4. CI workflow least-privilege permissions & timeout
    const ciYaml = await readFile(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ciYaml).toMatch(/permissions:\s*\r?\n\s*contents:\s*read/);
    expect(ciYaml).toContain("timeout-minutes: 15");
  });
});
