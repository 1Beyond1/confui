import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { diagnoseProject } from "../core/diagnostics.ts";
import { HARD_FILE_LIMIT, readRawConfigFile, readTextSnapshot } from "../core/files.ts";
import { parseConfig, updateConfigText } from "../core/formats.ts";
import { groupEnvLines, parseEnv, patchEnv } from "../core/formats/env.ts";
import { patchIni } from "../core/formats/ini.ts";
import { parseJsonc } from "../core/formats/json.ts";
import { parseProperties, patchProperties, stringifyProperties } from "../core/formats/properties.ts";
import { extractCommentMap } from "../core/inference/comments.ts";
import { inferConfig } from "../core/inference/index.ts";
import { inferKnownFields } from "../core/inference/known.ts";
import { resolveRegularProjectFile } from "../core/paths.ts";
import {
  commitRestoreBackup,
  commitSave,
  compareConfigFiles,
  generateRedactedExport,
  getBackupStatus,
  previewRestoreBackup,
  previewSave,
  previewSyncFromFile,
  writeRedactedExport,
} from "../core/save.ts";
import { resolveTestAIApiKey, SettingsStore, type SecretCodec } from "../core/settings.ts";
import { computeUnifiedDiff, DIFF_SECRET_MASK, maskDocumentLines, maskUnifiedDiff } from "../shared/diff.ts";
import { DEFAULT_SETTINGS } from "../shared/schema.ts";
import { canReuseStoredAiApiKey, isAiEndpointUnchanged, normalizeAiOrigin } from "../shared/validation.ts";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function keychainCodec(state: { unlocked: boolean }): SecretCodec {
  return {
    encode: (value) => {
      if (!value) return "";
      if (!state.unlocked) throw new Error("keychain unavailable");
      return `enc:${Buffer.from(value).toString("base64")}`;
    },
    decode: (value) => {
      if (!value) return "";
      if (!value.startsWith("enc:")) return value;
      return state.unlocked ? Buffer.from(value.slice(4), "base64").toString() : undefined;
    },
  };
}

describe("v0.5.1 P1 fixes & P2 closure regressions", () => {
  /* ------------------------------------------------------------------------ */
  /* P1-1: Multiline quoted .env parse, patch, delete, comments & redaction   */
  /* ------------------------------------------------------------------------ */
  it("P1-1: parses, patches, deletes, and extracts comments for multiline quoted .env values (double, single, backtick)", () => {
    const envSource = [
      "# Service credentials",
      'DOUBLE_ML="first line \\"quoted\\"',
      "PORT=9999",
      "# not a comment inside quote",
      'third line" # trailing note',
      "SINGLE_ML='single-1",
      "single-2\\nliteral",
      "single-3'",
      "BACKTICK_ML=`tick-1",
      'tick-2 "inner" \'quotes\'',
      "tick-3` # backtick note",
      "export PORT=3000",
    ].join("\n") + "\n";

    expect(groupEnvLines(envSource.trimEnd().split("\n"))).toHaveLength(5);

    const parsed = parseEnv(envSource);
    expect(parsed).toEqual({
      DOUBLE_ML: 'first line "quoted"\nPORT=9999\n# not a comment inside quote\nthird line',
      SINGLE_ML: "single-1\nsingle-2\\nliteral\nsingle-3",
      BACKTICK_ML: 'tick-1\ntick-2 "inner" \'quotes\'\ntick-3',
      PORT: "3000",
    });

    // Updating an unrelated key preserves all multiline groups verbatim (without mistaking inner `PORT=9999`)
    const portOnly = patchEnv(envSource, [{ segments: ["PORT"], value: "8080" }]);
    expect(parseEnv(portOnly)).toEqual({
      ...parsed,
      PORT: "8080",
    });
    expect(portOnly).toContain("PORT=9999\n# not a comment inside quote");
    expect(portOnly).toContain("export PORT=8080");

    // Replacing multiline variables replaces the ENTIRE logical group with zero orphan lines
    const replaced = patchEnv(envSource, [
      { segments: ["DOUBLE_ML"], value: "new-a\nnew-b" },
      { segments: ["SINGLE_ML"], value: "clean-single" },
      { segments: ["BACKTICK_ML"], value: "clean-backtick" },
    ]);
    expect(replaced).toContain('DOUBLE_ML="new-a\\nnew-b" # trailing note');
    expect(replaced).toContain("SINGLE_ML='clean-single'");
    expect(replaced).toContain("BACKTICK_ML=`clean-backtick` # backtick note");
    expect(replaced).not.toContain("PORT=9999");
    expect(replaced).not.toContain("single-2");
    expect(replaced).not.toContain("tick-2");
    expect(parseEnv(replaced)).toEqual({
      DOUBLE_ML: "new-a\nnew-b",
      SINGLE_ML: "clean-single",
      BACKTICK_ML: "clean-backtick",
      PORT: "3000",
    });

    // Deleting multiline variables removes ALL physical lines of each group with zero orphan lines
    const deleted = patchEnv(envSource, [
      { segments: ["DOUBLE_ML"], value: undefined },
      { segments: ["SINGLE_ML"], value: undefined },
      { segments: ["BACKTICK_ML"], value: undefined },
    ]);
    expect(deleted).toBe("# Service credentials\nexport PORT=3000\n");
    expect(parseEnv(deleted)).toEqual({ PORT: "3000" });

    // Comment extraction ignores lines inside multiline values and preserves outer comments
    const comments = extractCommentMap(envSource, "env");
    expect(comments.get(JSON.stringify(["DOUBLE_ML"]))?.comment).toContain("Service credentials");
    expect(comments.get(JSON.stringify(["DOUBLE_ML"]))?.comment).toContain("trailing note");
    expect(comments.get(JSON.stringify(["BACKTICK_ML"]))?.comment).toContain("backtick note");
    expect(comments.has(JSON.stringify(["PORT"]))).toBe(false);
  });

  it("P1-1: masks non-PEM multiline quoted .env secrets across RawViewer, UnifiedDiffView, and generateRedactedExport", async () => {
    const mlLines = Array.from({ length: 12 }, (_, idx) => `non-pem-secret-row-${idx + 1}`);
    const envBefore = [
      'API_SECRET="first-double-secret',
      ...mlLines,
      'last-double-secret" # keep safe note',
      "SIGNING_KEY='",
      "single-secret-line-2",
      "single-secret-line-3'",
      "CLIENT_SECRET=`tick-secret-line-1",
      "tick-secret-line-2",
      "tick-secret-line-3`",
      'PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      "pem-body-secret-1111",
      "-----END PRIVATE KEY-----",
      'extra-secret-after-pem-2222"',
      "PUBLIC_HOST=example.com",
    ].join("\n") + "\n";

    // 1. RawViewer full-document masking (`maskDocumentLines`)
    const docMasked = maskDocumentLines(envBefore, { format: "env" }).lines.join("\n");
    for (const leaked of [
      "first-double-secret",
      ...mlLines,
      "last-double-secret",
      "single-secret-line-2",
      "single-secret-line-3",
      "tick-secret-line-1",
      "tick-secret-line-2",
      "tick-secret-line-3",
      "pem-body-secret-1111",
      "extra-secret-after-pem-2222",
    ]) {
      expect(docMasked, `maskDocumentLines leaked ${leaked}`).not.toContain(leaked);
    }
    expect(docMasked).toContain("# keep safe note");
    expect(docMasked).toContain("PUBLIC_HOST=example.com");
    expect(docMasked).toContain(DIFF_SECRET_MASK);

    // 2. UnifiedDiffView cross-hunk truncation masking (`maskUnifiedDiff`)
    const envAfter = envBefore.replace("non-pem-secret-row-7", "non-pem-secret-row-7-edited");
    const rawDiff = computeUnifiedDiff(envBefore, envAfter, 2);
    const diffMasked = maskUnifiedDiff(rawDiff, { format: "env" });
    const diffText = diffMasked.diff.hunks.flatMap((h) => h.lines.map((l) => l.text)).join("\n");
    expect(diffText).not.toContain("non-pem-secret-row");
    expect(diffText).toContain(DIFF_SECRET_MASK);

    // Also works when format is unspecified
    const unspecifiedMasked = maskDocumentLines(envBefore).lines.join("\n");
    expect(unspecifiedMasked).not.toContain("non-pem-secret-row-5");
    expect(unspecifiedMasked).not.toContain("single-secret-line-2");
    expect(unspecifiedMasked).not.toContain("tick-secret-line-2");
    expect(unspecifiedMasked).not.toContain("extra-secret-after-pem-2222");

    // 3. generateRedactedExport replaces entire multiline secret cleanly with zero orphan lines
    const root = await mkdtemp(join(tmpdir(), "confui-v051-env-export-"));
    tempDirs.push(root);
    await writeFile(join(root, ".env"), envBefore, "utf8");
    const exported = await generateRedactedExport(root, ".env");
    for (const leaked of [
      "first-double-secret",
      "non-pem-secret-row-1",
      "non-pem-secret-row-12",
      "last-double-secret",
      "single-secret-line-2",
      "tick-secret-line-2",
      "pem-body-secret-1111",
      "extra-secret-after-pem-2222",
    ]) {
      expect(exported.content, `generateRedactedExport leaked ${leaked}`).not.toContain(leaked);
    }
    expect(exported.content).toContain("PUBLIC_HOST=example.com");
    expect(parseEnv(exported.content)).toMatchObject({
      API_SECRET: "***",
      SIGNING_KEY: "***",
      CLIENT_SECRET: "***",
      PRIVATE_KEY: "***",
      PUBLIC_HOST: "example.com",
    });
  });

  /* ------------------------------------------------------------------------ */
  /* P1-2: JSON/JSONC error line numbers + readRawConfigFile fallback channel */
  /* ------------------------------------------------------------------------ */
  it("P1-2: reports 1-based line numbers for JSON/JSONC syntax & duplicate-key errors and serves broken files safely via readRawConfigFile", async () => {
    expect(() => parseJsonc('{\n  "a": 1,\n  "b": \n}')).toThrow(/at line 4, column 1/);
    expect(() => parseJsonc('{\n  // comment\n  "a": 1\n  "b": 2\n}')).toThrow(/at line 4, column 3/);
    expect(() => parseJsonc('{\n  "port": 3000,\n  "port": 8080\n}')).toThrow(/第 3 行/);

    const root = await mkdtemp(join(tmpdir(), "confui-v051-p12-raw-"));
    tempDirs.push(root);

    const brokenJson = '{\n  "apiKey": "sk-broken-json-secret-999999",\n  "port": \n}\n';
    const brokenJsonc = '{\n  // missing comma below\n  "host": "localhost"\n  "port": 3000\n}\n';
    const dupJson = '{\n  "name": "demo",\n  "name": "dup"\n}\n';
    await writeFile(join(root, "broken.json"), brokenJson, "utf8");
    await writeFile(join(root, "broken.jsonc"), brokenJsonc, "utf8");
    await writeFile(join(root, "dup.json"), dupJson, "utf8");
    await writeFile(join(root, "nginx.conf"), "user nginx;\nhttp { server { listen 80; } }\n", "utf8");
    await writeFile(join(root, "script.ts"), "export const x = 1;\n", "utf8");
    await writeFile(join(root, "binary.json"), Buffer.from([0x7b, 0x00, 0x7d]));

    // Diagnostics extracts exact 1-based line numbers for JSON, JSONC, and duplicate keys without leaking secrets
    const diag = await diagnoseProject(root);
    const brokenJsonIssue = diag.issues.find((i) => i.file === "broken.json" && i.category === "parse-error");
    const brokenJsoncIssue = diag.issues.find((i) => i.file === "broken.jsonc" && i.category === "parse-error");
    const dupJsonIssue = diag.issues.find((i) => i.file === "dup.json" && i.category === "parse-error");
    expect(brokenJsonIssue?.line).toBe(4);
    expect(brokenJsoncIssue?.line).toBe(4);
    expect(dupJsonIssue?.line).toBe(3);
    expect(JSON.stringify(diag)).not.toContain("sk-broken-json-secret-999999");

    // `inferConfig` still fails with PARSE_ERROR on broken files
    await expect(inferConfig(root, "broken.json")).rejects.toMatchObject({ code: "PARSE_ERROR" });

    // `readRawConfigFile` succeeds for broken configs and keeps secrets maskable in RawViewer
    const raw = await readRawConfigFile(root, "broken.json");
    expect(raw).toMatchObject({
      file: "broken.json",
      kind: "broken.json",
      format: "json",
      rawText: brokenJson,
    });
    const maskedRaw = maskDocumentLines(raw.rawText, { format: raw.format }).lines.join("\n");
    expect(maskedRaw).not.toContain("sk-broken-json-secret-999999");
    expect(maskedRaw).toContain(`"apiKey": "${DIFF_SECRET_MASK}"`);

    // `readRawConfigFile` rejects non-config formats, directive-style `.conf`, binary files, and traversal
    await expect(readRawConfigFile(root, "script.ts")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(readRawConfigFile(root, "nginx.conf")).rejects.toMatchObject({ code: "PARSE_ERROR" });
    await expect(readRawConfigFile(root, "binary.json")).rejects.toMatchObject({ code: "PARSE_ERROR" });
    await expect(readRawConfigFile(root, "../outside.json")).rejects.toMatchObject({ code: "INVALID_INPUT" });

    // Over-sized file rejected cleanly
    const huge = `{"k":"${"a".repeat(HARD_FILE_LIMIT)}"}`;
    await writeFile(join(root, "huge.json"), huge, "utf8");
    await expect(readRawConfigFile(root, "huge.json")).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });

    // Source contracts for IPC & RawViewer degraded fallback
    const [mainSrc, preloadSrc, appSrc, rawViewerSrc] = await Promise.all([
      readFile(resolve(REPO_ROOT, "electron/main.ts"), "utf8"),
      readFile(resolve(REPO_ROOT, "electron/preload.ts"), "utf8"),
      readFile(resolve(REPO_ROOT, "web/src/App.tsx"), "utf8"),
      readFile(resolve(REPO_ROOT, "web/src/components/RawViewer.tsx"), "utf8"),
    ]);
    expect(mainSrc).toContain('handle("confui:readRawFile"');
    expect(preloadSrc).toContain('ipcRenderer.invoke("confui:readRawFile"');
    expect(appSrc).toContain("window.confui.readRawFile");
    expect(appSrc).toContain("parseError: parseErrorText");
    expect(rawViewerSrc).toContain("schema.parseError");
    expect(rawViewerSrc).toContain("raw.parseErrorNotice");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-3: TOML special floats, BigInt narrowing comments, and 4–5 quotes     */
  /* ------------------------------------------------------------------------ */
  it("P1-3: edits TOML special floats to finite numbers, narrows BigInt without wiping comments, and parses 4–5 consecutive closing quotes", () => {
    // 1. Special floats (`inf`, `-inf`, `nan`) editable to finite numbers without wiping comments
    const specialToml = [
      "# Special floats header",
      "upper = inf # upper bound",
      "lower = -inf # lower bound",
      "ratio = nan # ratio note",
    ].join("\n") + "\n";

    const specialRes = updateConfigText(specialToml, "toml", [
      { segments: ["upper"], value: "100" },
      { segments: ["lower"], value: "-3.14" },
      { segments: ["ratio"], value: "1_000.5" },
    ]);
    expect(specialRes.warnings).toEqual([]);
    expect(specialRes.output).toContain("# Special floats header");
    expect(specialRes.output).toContain("upper = 100 # upper bound");
    expect(specialRes.output).toContain("lower = -3.14 # lower bound");
    expect(specialRes.output).toContain("ratio = 1000.5 # ratio note");
    expect(parseConfig(specialRes.output, "toml")).toEqual({
      upper: 100,
      lower: -3.14,
      ratio: 1000.5,
    });
    expect(() => updateConfigText(specialToml, "toml", [
      { segments: ["upper"], value: "not-a-number" },
    ])).toThrow(/特殊浮点格式无效/);

    // 2. Narrowing a BigInt (> MAX_SAFE_INTEGER) to a safe integer preserves comments and emits zero warnings
    const bigintToml = [
      "# Keep request metadata comment",
      "requestId = 9223372036854775807 # inline bigint note",
      "ids = [9223372036854775807, 9223372036854775806] # ids note",
      "port = 3000",
    ].join("\n") + "\n";

    const narrowed = updateConfigText(bigintToml, "toml", [
      { segments: ["requestId"], value: "42" },
      { segments: ["ids"], value: ["10", "20"] },
    ]);
    expect(narrowed.warnings).toEqual([]);
    expect(narrowed.output).toContain("# Keep request metadata comment");
    expect(narrowed.output).toContain("requestId = 42 # inline bigint note");
    expect(narrowed.output).toContain("ids = [10, 20] # ids note");
    expect(parseConfig(narrowed.output, "toml")).toEqual({
      requestId: 42,
      ids: [10, 20],
      port: 3000,
    });

    // 3. TOML 1.0 4-quote and 5-quote endings (`""""`, `"""""`, `''''`, `'''''`) preserve comments & extract comments
    const quoteToml = [
      "# Four double quotes",
      'four_basic = """hello"""" # note4',
      "# Five double quotes",
      'five_basic = """',
      'multiline body""""" # note5',
      "# Four single quotes",
      "four_lit = '''world'''' # lit4",
      "# Five single quotes",
      "five_lit = '''",
      "lit body''''' # lit5",
      "# Target port comment",
      "port = 3000 # port inline",
    ].join("\n") + "\n";

    const quotePatched = updateConfigText(quoteToml, "toml", [
      { segments: ["port"], value: 8080 },
    ]);
    expect(quotePatched.warnings).toEqual([]);
    expect(quotePatched.output).toContain("# Four double quotes");
    expect(quotePatched.output).toContain("# Five single quotes");
    expect(quotePatched.output).toContain("port = 8080 # port inline");
    expect(parseConfig(quotePatched.output, "toml")).toEqual({
      four_basic: 'hello"',
      five_basic: 'multiline body""',
      four_lit: "world'",
      five_lit: "lit body''",
      port: 8080,
    });

    const tomlComments = extractCommentMap(quoteToml, "toml");
    expect(tomlComments.get(JSON.stringify(["four_basic"]))?.comment).toContain("Four double quotes");
    expect(tomlComments.get(JSON.stringify(["four_basic"]))?.comment).toContain("note4");
    expect(tomlComments.get(JSON.stringify(["five_lit"]))?.comment).toContain("lit5");
    expect(tomlComments.get(JSON.stringify(["port"]))?.comment).toContain("Target port comment");
    expect(tomlComments.get(JSON.stringify(["port"]))?.comment).toContain("port inline");
  });

  /* ------------------------------------------------------------------------ */
  /* P1-4: resolveRegularProjectFile & core/save.ts in-project symlink guards */
  /* ------------------------------------------------------------------------ */
  it("P1-4: rejects in-project symlinks and directory junctions across core/save.ts and readRawConfigFile", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-v051-p14-symlink-"));
    tempDirs.push(root);

    await mkdir(join(root, "real-dir"), { recursive: true });
    const realFile = join(root, "real-dir", "config.json");
    const otherFile = join(root, "other.json");
    const realContent = '{"port":3000}\n';
    await writeFile(realFile, realContent, "utf8");
    await writeFile(`${realFile}.bak`, '{"port":2000}\n', "utf8");
    await writeFile(otherFile, '{"port":4000,"extra":true}\n', "utf8");

    // 1. In-project directory junction (works reliably on Windows without admin elevation)
    const dirLink = join(root, "linked-dir");
    let hasDirLink = false;
    try {
      await symlink(join(root, "real-dir"), dirLink, "junction");
      hasDirLink = true;
    } catch {
      // Fall back to regular symlink on POSIX if needed
      try {
        await symlink(join(root, "real-dir"), dirLink);
        hasDirLink = true;
      } catch {
        hasDirLink = false;
      }
    }

    // 2. Direct in-project file symlink (when OS policy allows file symlinks)
    const fileLink = join(root, "link.json");
    let hasFileLink = false;
    try {
      await symlink(realFile, fileLink, "file");
      hasFileLink = true;
    } catch {
      hasFileLink = false;
    }

    expect(hasDirLink || hasFileLink).toBe(true);
    const snap = await readTextSnapshot(realFile);
    const realPreview = await previewSave(root, "real-dir/config.json", [{ segments: ["port"], value: 9000 }], snap.version);
    const realRestorePreview = await previewRestoreBackup(root, "real-dir/config.json", snap.version);

    const symlinkTargets: string[] = [];
    if (hasDirLink) symlinkTargets.push("linked-dir/config.json");
    if (hasFileLink) symlinkTargets.push("link.json");

    for (const linkedRel of symlinkTargets) {
      await expect(resolveRegularProjectFile(root, linkedRel)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(previewSave(root, linkedRel, [{ segments: ["port"], value: 9000 }], snap.version))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(commitSave(root, { ...realPreview, file: linkedRel }))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(getBackupStatus(root, linkedRel))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(previewRestoreBackup(root, linkedRel, snap.version))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(commitRestoreBackup(root, { ...realRestorePreview, file: linkedRel }))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(compareConfigFiles(root, linkedRel, "other.json"))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(compareConfigFiles(root, "other.json", linkedRel))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(previewSyncFromFile(root, linkedRel, "other.json", [["port"]], (await readTextSnapshot(otherFile)).version))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(generateRedactedExport(root, linkedRel))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(writeRedactedExport(root, linkedRel, "exported.json"))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(readRawConfigFile(root, linkedRel))
        .rejects.toMatchObject({ code: "INVALID_INPUT" });
    }

    // Regular file inside project still resolves & operates normally, and was never mutated
    const resolvedReal = await resolveRegularProjectFile(root, "real-dir/config.json");
    expect(resolvedReal.path.toLowerCase()).toBe((await realpath(realFile)).toLowerCase());
    expect(await readFile(realFile, "utf8")).toBe(realContent);
  });

  /* ------------------------------------------------------------------------ */
  /* P1-5: LAN HTTP AI Base URL & locked secrets preserved on unrelated saves */
  /* ------------------------------------------------------------------------ */
  it("P1-5: preserves LAN HTTP AI keys and locked secrets across theme/locale/SchemaStore saves while still blocking origin changes and HTTPS downgrades", async () => {
    expect(normalizeAiOrigin("http://192.168.1.50:11434/v1")).toBe("http://192.168.1.50:11434");
    expect(normalizeAiOrigin("http://10.0.0.5:8000/v1?x=1")).toBeUndefined();
    expect(normalizeAiOrigin("http://user:pass@10.0.0.5:8000/v1")).toBeUndefined();

    // Same non-loopback HTTP origin MAY reuse stored key (e.g. intranet Ollama / vLLM)
    expect(canReuseStoredAiApiKey(
      { provider: "custom", baseUrl: "http://192.168.1.50:11434/v1" },
      { provider: "custom", baseUrl: "http://192.168.1.50:11434/v2" },
    )).toBe(true);
    // Different LAN IP, port, credentials, query, fragment, or HTTPS->HTTP downgrade MUST be rejected
    expect(canReuseStoredAiApiKey(
      { provider: "custom", baseUrl: "http://192.168.1.50:11434/v1" },
      { provider: "custom", baseUrl: "http://192.168.1.51:11434/v1" },
    )).toBe(false);
    expect(canReuseStoredAiApiKey(
      { provider: "custom", baseUrl: "http://192.168.1.50:11434/v1" },
      { provider: "custom", baseUrl: "http://192.168.1.50:8080/v1" },
    )).toBe(false);
    expect(canReuseStoredAiApiKey(
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      { provider: "openai", baseUrl: "http://api.openai.com/v1" },
    )).toBe(false);
    expect(isAiEndpointUnchanged(
      { provider: "custom", baseUrl: "http://192.168.1.50:11434/v1" },
      { provider: "custom", baseUrl: " http://192.168.1.50:11434/v1 " },
    )).toBe(true);

    const root = await mkdtemp(join(tmpdir(), "confui-v051-p15-lan-"));
    tempDirs.push(root);
    const settingsPath = join(root, "settings.json");
    const state = { unlocked: true };
    const store = new SettingsStore(settingsPath, keychainCodec(state));

    // 1. Save LAN HTTP AI settings (e.g. intranet vLLM)
    const lanInit = structuredClone(DEFAULT_SETTINGS);
    lanInit.ai.enabled = true;
    lanInit.ai.provider = "custom";
    lanInit.ai.model = "qwen2.5-72b";
    lanInit.ai.baseUrl = "http://10.0.0.5:8000/v1";
    lanInit.ai.apiKey = "vllm-internal-secret-7777";
    const savedLan = await store.saveFromRenderer(lanInit);
    expect(savedLan.secrets?.hasApiKey).toBe(true);

    // 2. Switching theme, locale, and SchemaStore MUST NOT wipe the LAN HTTP API key!
    const afterTheme = await store.saveFromRenderer({
      ...savedLan,
      theme: "dark",
      locale: "en-US",
      schemaStore: { enabled: true },
    });
    expect(afterTheme.secrets?.hasApiKey).toBe(true);
    const decodedLan = await store.load();
    expect(decodedLan.ai.apiKey).toBe("vllm-internal-secret-7777");

    // 3. `resolveTestAIApiKey` reuses the stored LAN key for the exact same origin, rejects different hosts
    expect(resolveTestAIApiKey(decodedLan.ai, {
      ...decodedLan.ai,
      apiKey: "",
      baseUrl: "http://10.0.0.5:8000/v2",
      useStoredApiKey: true,
    })).toBe("vllm-internal-secret-7777");
    expect(() => resolveTestAIApiKey(decodedLan.ai, {
      ...decodedLan.ai,
      apiKey: "",
      baseUrl: "http://10.0.0.99:8000/v1",
      useStoredApiKey: true,
    })).toThrow();

    // 4. Locked secret with empty baseUrl (AI disabled) MUST NOT be wiped on theme/locale/SchemaStore save
    const emptyBaseInit = structuredClone(DEFAULT_SETTINGS);
    emptyBaseInit.ai.enabled = false;
    emptyBaseInit.ai.provider = "custom";
    emptyBaseInit.ai.baseUrl = "";
    emptyBaseInit.ai.apiKey = "sk-locked-empty-url-9999";
    await store.saveFromRenderer(emptyBaseInit);

    state.unlocked = false;
    const lockedView = await store.loadForRenderer();
    expect(lockedView.lockedSecrets).toEqual({ apiKey: true, githubToken: false });
    const afterLockedTheme = await store.saveFromRenderer({
      ...lockedView,
      theme: "light",
      locale: "zh-CN",
      schemaStore: { enabled: false },
    });
    expect(afterLockedTheme.lockedSecrets).toEqual({ apiKey: true, githubToken: false });

    // Unlocking recovers the exact secret intact
    state.unlocked = true;
    expect((await store.load()).ai.apiKey).toBe("sk-locked-empty-url-9999");

    // Changing baseUrl from "" to another domain STILL wipes the stored key (no exfiltration)
    const redirected = await store.loadForRenderer();
    redirected.ai.baseUrl = "https://attacker.example/v1";
    const afterRedirect = await store.saveFromRenderer(redirected);
    expect(afterRedirect.secrets?.hasApiKey).toBe(false);
    expect((await store.load()).ai.apiKey).toBe("");
  });

  /* ------------------------------------------------------------------------ */
  /* P2-1..P2-4: INI dead branch, Properties keys, Diagnostics array/refresh, */
  /*             and launch.json / vercel.json built-in bilingual templates   */
  /* ------------------------------------------------------------------------ */
  it("P2-1: strips unquoted ;/# tails for ALL //host/:... .npmrc keys in patchIni while keeping normal INI comments", () => {
    const npmrc = [
      "//registry.npmjs.org/:always-auth=true;stray-tail",
      "//registry.npmjs.org/:custom-flag=old # stray-hash",
      "registry=https://registry.npmjs.org/ # keep normal comment",
    ].join("\n") + "\n";

    const patched = patchIni(npmrc, [
      { segments: ["//registry.npmjs.org/:always-auth"], value: false },
      { segments: ["//registry.npmjs.org/:custom-flag"], value: "new" },
      { segments: ["registry"], value: "https://npmmirror.com/" },
    ]);

    expect(patched).toContain("//registry.npmjs.org/:always-auth=false\n");
    expect(patched).not.toContain("stray-tail");
    expect(patched).toContain("//registry.npmjs.org/:custom-flag=new\n");
    expect(patched).not.toContain("stray-hash");
    expect(patched).toContain("registry=https://npmmirror.com/ # keep normal comment");
  });

  it("P2-2: validates property keys in patchProperties/stringifyProperties and supports bare keys without separator", () => {
    for (const badKey of ["", "   ", "bad\0key", "__proto__", "prototype", "constructor"]) {
      expect(() => patchProperties("a=1\n", [{ segments: [badKey], value: "x" }])).toThrow(/PROPERTIES 键名无效/);
      expect(() => stringifyProperties({ [badKey]: "x" })).toThrow(/PROPERTIES 键名无效/);
    }

    const propsSource = [
      "# Bare feature flag",
      "feature.enabled",
      "empty.flag",
      "app.name=Confui",
    ].join("\n") + "\n";

    expect(parseProperties(propsSource)).toEqual({
      "feature.enabled": "",
      "empty.flag": "",
      "app.name": "Confui",
    });

    const comments = extractCommentMap(propsSource, "properties");
    expect(comments.get(JSON.stringify(["feature.enabled"]))?.comment).toBe("Bare feature flag");

    const updated = patchProperties(propsSource, [
      { segments: ["feature.enabled"], value: "true" },
      { segments: ["empty.flag"], value: undefined },
    ]);
    expect(updated).toBe("# Bare feature flag\nfeature.enabled=true\napp.name=Confui\n");
    expect(parseProperties(updated)).toEqual({
      "feature.enabled": "true",
      "app.name": "Confui",
    });
  });

  it("P2-3: avoids missing-from-example false positives on shorter object arrays and refreshes project files on diagnostic jump miss", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-v051-p23-diag-array-"));
    tempDirs.push(root);

    await writeFile(
      join(root, "app.example.json"),
      JSON.stringify({
        servers: [
          { host: "a.example.com", port: 80 },
          { host: "b.example.com", port: 443 },
        ],
        webhooks: [
          { url: "https://example.com/hook1" },
          { url: "https://example.com/hook2" },
        ],
        requiredGroups: [
          { name: "default" },
        ],
      }, null, 2),
      "utf8",
    );
    await writeFile(
      join(root, "app.json"),
      JSON.stringify({
        servers: [
          { host: "prod.myapp.com" }, // item 0 missing `port`; item 1 intentionally omitted!
        ],
        webhooks: [], // intentionally empty array
        // `requiredGroups` completely absent -> should report `requiredGroups` ONCE
      }, null, 2),
      "utf8",
    );

    const diag = await diagnoseProject(root, { locale: "en-US" });
    const missingPaths = diag.issues
      .filter((i) => i.file === "app.json" && i.category === "missing-from-example")
      .map((i) => i.path);

    expect(missingPaths).toContain("servers[0].port");
    expect(missingPaths).toContain("requiredGroups");
    expect(missingPaths).not.toContain("servers[1].host");
    expect(missingPaths).not.toContain("servers[1].port");
    expect(missingPaths).not.toContain("webhooks[0].url");
    expect(missingPaths).not.toContain("webhooks[1].url");
    expect(missingPaths).not.toContain("requiredGroups[0].name");

    const appSrc = await readFile(resolve(REPO_ROOT, "web/src/App.tsx"), "utf8");
    expect(appSrc).toContain("window.confui.scanProject(currentRoot");
  });

  it("P2-4: provides complete bilingual built-in templates for launch.json and vercel.json", () => {
    const launchDoc = {
      version: "0.2.0",
      configurations: [{ name: "Launch API", type: "node", request: "launch", program: "${workspaceFolder}/index.js" }],
      compounds: [{ name: "Full Stack", configurations: ["Launch API"] }],
      inputs: [{ id: "token", type: "promptString", description: "API Token" }],
    };
    const launchZh = inferKnownFields("launch.json", launchDoc, "json", "zh-CN");
    const launchEn = inferKnownFields("launch.json", launchDoc, "json", "en-US");
    expect(launchZh.map((f) => f.segments.join("."))).toEqual([
      "version",
      "configurations",
      "compounds",
      "inputs",
    ]);
    expect(launchZh.find((f) => f.segments[0] === "configurations")?.itemFields?.map((i) => i.key))
      .toEqual(expect.arrayContaining(["name", "type", "request", "program", "cwd", "args", "env", "port", "console"]));
    expect(launchEn).toHaveLength(launchZh.length);
    for (const field of launchEn) {
      expect(field.label).not.toMatch(/[\u4e00-\u9fff]/);
      expect(field.description ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      expect(field.group ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      for (const item of field.itemFields ?? []) {
        expect(item.label).not.toMatch(/[\u4e00-\u9fff]/);
        expect(item.description ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      }
    }

    const vercelDoc = {
      framework: "nextjs",
      buildCommand: "npm run build",
      outputDirectory: ".next",
      cleanUrls: true,
      rewrites: [{ source: "/api/:path*", destination: "https://api.example.com/:path*" }],
      redirects: [{ source: "/old", destination: "/new", permanent: true }],
      headers: [{ source: "/(.*)", headers: [{ key: "X-Frame-Options", value: "DENY" }] }],
      crons: [{ path: "/api/cron", schedule: "0 5 * * *" }],
      regions: ["iad1"],
      functions: { "api/*.ts": { maxDuration: 30 } },
    };
    const vercelZh = inferKnownFields("vercel.json", vercelDoc, "json", "zh-CN");
    const vercelEn = inferKnownFields("vercel.json", vercelDoc, "json", "en-US");
    expect(vercelZh.map((f) => f.segments.join("."))).toEqual(expect.arrayContaining([
      "framework",
      "buildCommand",
      "outputDirectory",
      "cleanUrls",
      "rewrites",
      "redirects",
      "headers",
      "crons",
      "regions",
      "functions",
    ]));
    expect(vercelZh.find((f) => f.segments[0] === "redirects")?.itemFields?.map((i) => i.key))
      .toEqual(expect.arrayContaining(["source", "destination", "permanent", "statusCode"]));
    expect(vercelEn).toHaveLength(vercelZh.length);
    for (const field of vercelEn) {
      expect(field.label).not.toMatch(/[\u4e00-\u9fff]/);
      expect(field.description ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      expect(field.group ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      for (const item of field.itemFields ?? []) {
        expect(item.label).not.toMatch(/[\u4e00-\u9fff]/);
        expect(item.description ?? "").not.toMatch(/[\u4e00-\u9fff]/);
      }
    }
  });
});
