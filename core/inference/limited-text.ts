import { open } from "node:fs/promises";

const FILE_CHUNK_BYTES = 64 * 1024;

type OverflowMode = "truncate" | "reject";

interface LimitedUtf8Options {
  maxBytes: number;
  overflow: OverflowMode;
  tooLargeMessage?: string;
  invalidUtf8Message?: string;
}

/**
 * Reads at most `maxBytes + 1` bytes from a local file. The extra probe byte is
 * used only to distinguish an exact-size file from an oversized one.
 */
export async function readLimitedUtf8File(
  path: string,
  options: LimitedUtf8Options,
): Promise<string> {
  validateLimit(options.maxBytes);
  const handle = await open(path, "r");
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let overflowed = false;

  try {
    while (totalBytes < options.maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, options.maxBytes - totalBytes));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      totalBytes += bytesRead;
    }

    if (totalBytes === options.maxBytes) {
      const probe = Buffer.allocUnsafe(1);
      overflowed = (await handle.read(probe, 0, 1, null)).bytesRead > 0;
    }
  } finally {
    await handle.close();
  }

  if (overflowed && options.overflow === "reject") throw tooLargeError(options);
  return decodeUtf8(chunks, totalBytes, overflowed, options.invalidUtf8Message);
}

/**
 * Consumes a response body incrementally and cancels its reader as soon as an
 * oversized body is detected (or as soon as a requested prefix is complete).
 */
export async function readLimitedUtf8Response(
  response: Response,
  options: LimitedUtf8Options,
): Promise<string> {
  validateLimit(options.maxBytes);
  const body = response.body;

  if (options.overflow === "reject" && contentLength(response) > options.maxBytes) {
    await body?.cancel().catch(() => undefined);
    throw tooLargeError(options);
  }
  if (!body) return "";

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let overflowed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.byteLength) continue;

      const remaining = options.maxBytes - totalBytes;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.subarray(0, remaining));
        totalBytes += remaining;
        overflowed = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(value);
      totalBytes += value.byteLength;

      // README only needs a prefix, so there is no reason to wait for another
      // network chunk after the byte budget has been filled. A strict Schema
      // read continues once more to distinguish exactly-at-limit from > limit.
      if (totalBytes === options.maxBytes && options.overflow === "truncate") {
        overflowed = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (overflowed && options.overflow === "reject") throw tooLargeError(options);
  return decodeUtf8(chunks, totalBytes, overflowed, options.invalidUtf8Message);
}

function decodeUtf8(
  chunks: readonly Uint8Array[],
  totalBytes: number,
  truncated: boolean,
  invalidUtf8Message: string | undefined,
): string {
  const bytes = Buffer.concat(chunks, totalBytes);
  try {
    const decoder = new TextDecoder("utf-8", { fatal: invalidUtf8Message !== undefined });
    // Streaming mode intentionally leaves a partial trailing code point
    // buffered when a prefix ends in the middle of a UTF-8 sequence.
    return decoder.decode(bytes, { stream: truncated });
  } catch {
    throw new Error(invalidUtf8Message ?? "内容不是有效的 UTF-8 编码");
  }
}

function contentLength(response: Response): number {
  const raw = response.headers.get("content-length");
  if (!raw || !/^\d+$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function tooLargeError(options: LimitedUtf8Options): Error {
  return new Error(options.tooLargeMessage ?? `内容超过 ${options.maxBytes} bytes`);
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes 必须是正整数");
}
