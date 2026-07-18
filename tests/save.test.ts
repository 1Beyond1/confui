import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readTextSnapshot } from "../core/files.ts";
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
});
