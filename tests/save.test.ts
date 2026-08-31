import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { HARD_FILE_LIMIT, readTextSnapshot } from "../core/files.ts";
import { commitSave, previewSave } from "../core/save.ts";
import { ConfuiError } from "../core/errors.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("safe save", () => {
  it("previews exact changes, writes atomically and creates a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-save-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.jsonc");
    const original = `{
  // keep me
  "server": { "port": 3000, },
}\n`;
    await writeFile(path, original);
    const snapshot = await readTextSnapshot(path);
    const preview = await previewSave(root, "config.jsonc", [
      { segments: ["server", "port"], value: 8080 },
    ], snapshot.version);

    expect(preview.changes).toEqual([{ path: "server.port", before: 3000, after: 8080 }]);
    expect(preview.output).toContain("// keep me");
    const result = await commitSave(root, preview);
    expect(result.version.hash).not.toBe(snapshot.version.hash);
    expect(await readFile(path, "utf8")).toContain('"port": 8080');
    expect(await readFile(`${path}.bak`, "utf8")).toBe(original);
  });

  it("rejects a stale preview instead of overwriting external changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-conflict-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.json");
    await writeFile(path, '{"port":3000}\n');
    const snapshot = await readTextSnapshot(path);
    const preview = await previewSave(root, "config.json", [{ segments: ["port"], value: 8080 }], snapshot.version);
    await writeFile(path, '{"port":9000}\n');

    await expect(commitSave(root, preview)).rejects.toMatchObject({ code: "FILE_CONFLICT" } satisfies Partial<ConfuiError>);
    expect(await readFile(path, "utf8")).toBe('{"port":9000}\n');
  });

  it("binds a preview to the project it was created from", async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), "confui-save-project-a-"));
    const secondRoot = await mkdtemp(join(tmpdir(), "confui-save-project-b-"));
    temporaryDirectories.push(firstRoot, secondRoot);
    await Promise.all([
      writeFile(join(firstRoot, "config.json"), '{"port":3000}\n'),
      writeFile(join(secondRoot, "config.json"), '{"port":3000}\n'),
    ]);

    const snapshot = await readTextSnapshot(join(firstRoot, "config.json"));
    const preview = await previewSave(firstRoot, "config.json", [
      { segments: ["port"], value: 8080 },
    ], snapshot.version);

    await expect(commitSave(secondRoot, preview)).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(join(secondRoot, "config.json"), "utf8")).toBe('{"port":3000}\n');
  });

  it("rejects concurrent commits so the original backup cannot be overwritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-concurrent-save-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.json");
    const original = '{"port":3000}\n';
    await writeFile(path, original);
    const snapshot = await readTextSnapshot(path);
    const preview = await previewSave(root, "config.json", [{ segments: ["port"], value: 8080 }], snapshot.version);

    const results = await Promise.allSettled([
      commitSave(root, preview),
      commitSave(root, preview),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "FILE_CONFLICT" },
    });
    expect(await readFile(path, "utf8")).toBe('{"port":8080}\n');
    expect(await readFile(`${path}.bak`, "utf8")).toBe(original);
  });

  it("rejects parent and child edits instead of silently overwriting one", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-overlapping-save-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.json");
    await writeFile(path, '{"scripts":{"test":"old","build":"keep"}}\n', "utf8");
    const snapshot = await readTextSnapshot(path);

    await expect(previewSave(root, "config.json", [
      { segments: ["scripts", "test"], value: "new" },
      { segments: ["scripts"], value: { test: "old", build: "keep" } },
    ], snapshot.version)).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "不能同时修改父级对象和子字段，请只保留其中一项",
    } satisfies Partial<ConfuiError>);
    expect(await readFile(path, "utf8")).toBe('{"scripts":{"test":"old","build":"keep"}}\n');
  });

  it("rejects a generated file that would exceed the safe size limit before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-save-too-large-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.json");
    // {"value":"<padding>"} adds exactly 12 ASCII bytes around the value;
    // adding two characters in the preview therefore crosses the limit.
    const padding = "x".repeat(HARD_FILE_LIMIT - 12);
    await writeFile(path, JSON.stringify({ value: padding }), "utf8");
    const snapshot = await readTextSnapshot(path);

    await expect(previewSave(root, "config.json", [
      { segments: ["value"], value: `${padding}!!` },
    ], snapshot.version)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(await readFile(path, "utf8")).toContain(padding);
  });

  it("rejects malformed or oversized IPC-style changes before parsing values", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-save-input-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.json");
    await writeFile(path, '{"value":"ok"}\n', "utf8");
    const snapshot = await readTextSnapshot(path);

    await expect(previewSave(root, "config.json", [null as never], snapshot.version))
      .rejects.toMatchObject({ code: "INVALID_INPUT" } satisfies Partial<ConfuiError>);
    await expect(previewSave(root, "config.json", [
      { segments: ["value"], value: "x".repeat(1024 * 1024) },
    ], snapshot.version)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" } satisfies Partial<ConfuiError>);
  });
  it("rejects non-finite and otherwise non-serializable change values", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-save-invalid-value-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.json");
    await writeFile(path, '{"value":1}\n', "utf8");
    const snapshot = await readTextSnapshot(path);

    await expect(previewSave(root, "config.json", [
      { segments: ["value"], value: Number.POSITIVE_INFINITY },
    ], snapshot.version)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(previewSave(root, "config.json", [
      { segments: ["value"], value: [undefined] },
    ], snapshot.version)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(previewSave(root, "config.json", [
      { segments: ["value"], value: Number.MAX_SAFE_INTEGER + 1 },
    ], snapshot.version)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(previewSave(root, "config.json", [
      { segments: ["value"], value: "before\0after" },
    ], snapshot.version)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
