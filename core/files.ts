import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { FileVersion } from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";

export const AI_FILE_LIMIT = 1024 * 1024;
export const HARD_FILE_LIMIT = 5 * 1024 * 1024;

export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function readTextSnapshot(
  absolutePath: string,
  maxBytes = HARD_FILE_LIMIT,
): Promise<{ text: string; version: FileVersion }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new ConfuiError("INVALID_INPUT", "文件大小限制无效");
  }
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    throw new ConfuiError("NOT_FOUND", "配置文件不存在或无法访问");
  }
  if (!info.isFile()) throw new ConfuiError("INVALID_INPUT", "目标不是文件");
  if (info.size > maxBytes) {
    throw new ConfuiError(
      "FILE_TOO_LARGE",
      "文件超过 5 MB，Confui 为避免误操作不会打开它",
      `${info.size} bytes`,
    );
  }

  let handle;
  try {
    handle = await open(absolutePath, "r");
    // Allocate proportionally to the observed file size plus one guard byte so
    // hundreds of small config files never allocate 5 MiB each, while still
    // detecting files that grow past `info.size` or `maxBytes` during read.
    const allocSize = Math.min(Math.max(0, info.size), maxBytes) + 1;
    const buffer = Buffer.allocUnsafe(allocSize);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maxBytes) {
      throw new ConfuiError(
        "FILE_TOO_LARGE",
        "文件超过 5 MB，Confui 为避免误操作不会打开它",
        `${bytesRead} bytes`,
      );
    }
    if (bytesRead > info.size) {
      const grown = await handle.stat();
      if (grown.size > maxBytes) {
        throw new ConfuiError(
          "FILE_TOO_LARGE",
          "文件超过 5 MB，Confui 为避免误操作不会打开它",
          `${grown.size} bytes`,
        );
      }
      throw new ConfuiError(
        "FILE_CONFLICT",
        "文件在读取过程中发生变化，请重新加载后再试",
      );
    }

    const bytes = buffer.subarray(0, bytesRead);
    try {
      // Buffer#toString replaces malformed UTF-8 with U+FFFD. Do not let a
      // lossy decode turn a non-UTF-8 config into valid-looking UTF-8 on save.
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConfuiError("PARSE_ERROR", "配置文件不是有效的 UTF-8 编码");
    }
    if (bytes.includes(0)) {
      throw new ConfuiError("PARSE_ERROR", "配置文件包含二进制内容，Confui 不会打开它");
    }

    const after = await handle.stat();
    if (after.size !== bytesRead || after.mtimeMs !== info.mtimeMs) {
      throw new ConfuiError(
        "FILE_CONFLICT",
        "文件在读取过程中发生变化，请重新加载后再试",
      );
    }
    const text = bytes.toString("utf8");
    return {
      text,
      version: { mtimeMs: after.mtimeMs, size: bytesRead, hash: hashText(text) },
    };
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "NOT_FOUND",
      "配置文件不存在或无法访问",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function currentVersion(absolutePath: string): Promise<FileVersion> {
  return (await readTextSnapshot(absolutePath)).version;
}
