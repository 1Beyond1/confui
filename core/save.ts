import { copyFile, chmod, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ConfigChange,
  FileVersion,
  SavePreview,
  SaveResult,
} from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";
import { currentVersion, readTextSnapshot } from "./files.ts";
import { detectFormat, parseConfig, updateConfigText } from "./formats.ts";
import { formatPath, getAtPath, safeJoin } from "./paths.ts";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export async function previewSave(
  root: string,
  relativeFile: string,
  requestedChanges: readonly ConfigChange[],
  expectedVersion: FileVersion,
): Promise<SavePreview> {
  const absolutePath = safeJoin(root, relativeFile);
  const format = detectFormat(relativeFile);
  if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");
  const snapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(snapshot.version, expectedVersion);
  const parsed = parseConfig(snapshot.text, format);
  const operations = requestedChanges.filter((change) => {
    validateChange(change);
    return !isDeepStrictEqual(getAtPath(parsed, change.segments), change.value);
  });
  const result = updateConfigText(snapshot.text, format, operations);
  return {
    file: relativeFile.replace(/\\/g, "/"),
    format,
    changes: operations.map((change) => ({
      path: formatPath(change.segments),
      before: getAtPath(parsed, change.segments),
      after: change.value,
    })),
    operations: operations.map((change) => ({ segments: [...change.segments], value: change.value })),
    output: result.output,
    warnings: result.warnings,
    expectedVersion: snapshot.version,
  };
}

export async function commitSave(root: string, preview: SavePreview): Promise<SaveResult> {
  const absolutePath = safeJoin(root, preview.file);
  const format = detectFormat(preview.file);
  if (!format || format !== preview.format) throw new ConfuiError("INVALID_INPUT", "保存请求中的文件格式不一致");
  const snapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(snapshot.version, preview.expectedVersion);
  for (const operation of preview.operations) validateChange(operation);
  const generated = updateConfigText(snapshot.text, format, preview.operations);
  if (generated.output !== preview.output) {
    throw new ConfuiError("FILE_CONFLICT", "保存预览已经失效，请重新预览后再保存");
  }

  const backupPath = `${absolutePath}.bak`;
  const temporaryPath = join(dirname(absolutePath), `.${basename(absolutePath)}.confui-${process.pid}-${Date.now()}.tmp`);
  try {
    await copyFile(absolutePath, backupPath);
    const mode = (await stat(absolutePath)).mode;
    await writeFile(temporaryPath, generated.output, { encoding: "utf8", flag: "wx" });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new ConfuiError(
      "SAVE_ERROR",
      "配置文件保存失败，原文件没有被覆盖",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    file: preview.file,
    version: await currentVersion(absolutePath),
    backupPath,
  };
}

export function assertSameVersion(current: FileVersion, expected: FileVersion): void {
  if (current.hash !== expected.hash || current.size !== expected.size) {
    throw new ConfuiError(
      "FILE_CONFLICT",
      "文件已被其他程序修改，为避免覆盖，请重新加载后再保存",
    );
  }
}

function validateChange(change: ConfigChange): void {
  if (!Array.isArray(change.segments) || change.segments.length < 1 || change.segments.length > 32) {
    throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
  }
  for (const segment of change.segments) {
    if ((typeof segment !== "string" && typeof segment !== "number") || (typeof segment === "number" && (!Number.isInteger(segment) || segment < 0))) {
      throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
    }
    if (typeof segment === "string" && FORBIDDEN_SEGMENTS.has(segment)) {
      throw new ConfuiError("INVALID_INPUT", "配置字段路径包含不安全的键名");
    }
  }
}
