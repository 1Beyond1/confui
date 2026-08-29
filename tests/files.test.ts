import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { readTextSnapshot } from "../core/files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("bounded text snapshots", () => {
  it("reads an exact-size UTF-8 file and rejects the first byte beyond the limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-files-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.txt");

    await writeFile(path, "12345", "utf8");
    await expect(readTextSnapshot(path, 5)).resolves.toMatchObject({ text: "12345", version: { size: 5 } });

    await writeFile(path, "123456", "utf8");
    await expect(readTextSnapshot(path, 5)).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });

  it("refuses invalid UTF-8 and binary NUL bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-files-encoding-"));
    temporaryDirectories.push(root);
    const path = join(root, "config.bin");

    await writeFile(path, Buffer.from([0xc3, 0x28]));
    await expect(readTextSnapshot(path)).rejects.toMatchObject({ code: "PARSE_ERROR" });

    await writeFile(path, Buffer.from([0x61, 0x00, 0x62]));
    await expect(readTextSnapshot(path)).rejects.toMatchObject({ code: "PARSE_ERROR" });
  });
});
