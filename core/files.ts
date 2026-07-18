import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
  const text = await readFile(absolutePath, "utf8");
  return {
    text,
    version: { mtimeMs: info.mtimeMs, size: info.size, hash: hashText(text) },
  };
}

export async function currentVersion(absolutePath: string): Promise<FileVersion> {
  return (await readTextSnapshot(absolutePath)).version;
}
