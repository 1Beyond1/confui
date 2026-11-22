import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HARD_FILE_LIMIT, readTextSnapshot } from "../core/files.ts";

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

  it("allocates buffer proportionally to file size instead of a fixed 5 MiB slab", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-files-alloc-"));
    temporaryDirectories.push(root);
    const path = join(root, "tiny.env");
    await writeFile(path, "PORT=3000\n", "utf8"); // 10 bytes

    const allocSpy = vi.spyOn(Buffer, "allocUnsafe");
    try {
      const snap = await readTextSnapshot(path, HARD_FILE_LIMIT);
      expect(snap.text).toBe("PORT=3000\n");
      expect(allocSpy).toHaveBeenCalled();
      const requestedSizes = allocSpy.mock.calls.map((call) => call[0]);
      expect(requestedSizes).toContain(11); // stat.size (10) + 1
      expect(Math.max(...requestedSizes)).toBeLessThan(1_024);
    } finally {
      allocSpy.mockRestore();
    }
  });
});
