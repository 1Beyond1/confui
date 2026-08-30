import { opendir } from "node:fs/promises";
import type { Dirent } from "node:fs";

/**
 * Reads only a bounded number of directory entries. Config discovery only
 * needs to inspect names, so loading an entire hostile or generated directory
 * into memory is unnecessary.
 */
export async function readLimitedDirectory(
  path: string,
  maxEntries: number,
): Promise<{ entries: Dirent[]; truncated: boolean }> {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("maxEntries 必须是正整数");
  }
  const handle = await opendir(path);
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    while (entries.length < maxEntries) {
      const entry = await handle.read();
      if (!entry) break;
      entries.push(entry);
    }
    // Consume one probe entry to distinguish an exact-size directory from a
    // capped one without retaining anything beyond the configured limit.
    if (!truncated && entries.length === maxEntries) {
      truncated = (await handle.read()) !== null;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { entries, truncated };
}
