import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ConfigChange,
  ConfigFormat,
  FileVersion,
  PathSegment,
  SavePreview,
  SaveResult,
} from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";
import { HARD_FILE_LIMIT, currentVersion, readTextSnapshot } from "./files.ts";
import { assertEditableSyntax, detectFormat, parseConfig, updateConfigText } from "./formats.ts";
import { ensurePathInsideProject, formatPath, getAtPath, pathKey, resolveExistingProjectPath } from "./paths.ts";

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const activeSavePaths = new Set<string>();
const MAX_SAVE_CHANGES = 2_000;
const MAX_CHANGE_VALUE_BYTES = 1 * 1024 * 1024;

export async function previewSave(
  root: string,
  relativeFile: string,
  requestedChanges: readonly ConfigChange[],
  expectedVersion: FileVersion,
): Promise<SavePreview> {
  const { root: projectRoot, path: absolutePath } = await resolveExistingProjectPath(root, relativeFile);
  const format = detectFormat(relativeFile);
  if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");
  const snapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(snapshot.version, expectedVersion);
  assertEditableSyntax(relativeFile, snapshot.text);
  const parsed = parseConfig(snapshot.text, format);
  validateChanges(requestedChanges);
  const operations = requestedChanges.filter((change) => {
    return !isDeepStrictEqual(getAtPath(parsed, change.segments), change.value);
  });
  const result = updateConfigText(snapshot.text, format, operations);
  assertWritableSize(result.output);
  return {
    projectRoot,
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
  const resolved = await resolveExistingProjectPath(root, preview.file);
  if (!samePath(resolved.root, preview.projectRoot)) {
    throw new ConfuiError("FILE_CONFLICT", "保存预览属于另一个项目，已拒绝写入");
  }
  const { path: absolutePath } = resolved;
  const format = detectFormat(preview.file);
  if (!format || format !== preview.format) throw new ConfuiError("INVALID_INPUT", "保存请求中的文件格式不一致");
  if (activeSavePaths.has(absolutePath)) {
    throw new ConfuiError("FILE_CONFLICT", "这个配置文件正在保存，请稍后再试");
  }
  activeSavePaths.add(absolutePath);
  try {
    return await commitSaveExclusive(resolved.root, absolutePath, preview, format);
  } finally {
    activeSavePaths.delete(absolutePath);
  }
}

async function commitSaveExclusive(
  projectRoot: string,
  absolutePath: string,
  preview: SavePreview,
  format: ConfigFormat,
): Promise<SaveResult> {
  await assertStableTarget(projectRoot, absolutePath);
  const snapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(snapshot.version, preview.expectedVersion);
  assertEditableSyntax(preview.file, snapshot.text);
  validateChanges(preview.operations);
  const generated = updateConfigText(snapshot.text, format, preview.operations);
  assertWritableSize(generated.output);
  if (generated.output !== preview.output) {
    throw new ConfuiError("FILE_CONFLICT", "保存预览已经失效，请重新预览后再保存");
  }

  const backupPath = `${absolutePath}.bak`;
  const temporaryPath = join(dirname(absolutePath), `.${basename(absolutePath)}.confui-${process.pid}-${randomUUID()}.tmp`);
  const backupTemporaryPath = join(dirname(absolutePath), `.${basename(absolutePath)}.confui-${process.pid}-${randomUUID()}.bak.tmp`);
  try {
    const mode = (await stat(absolutePath)).mode;
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(generated.output, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, mode);

    // Generating and flushing the temporary file can take time on a slow or
    // busy disk. Re-check immediately before backup/replacement so an edit
    // made during that window is not silently overwritten.
    await assertStableTarget(projectRoot, absolutePath);
    assertSameVersion(await currentVersion(absolutePath), preview.expectedVersion);
    // Build the backup beside the target first, then rename it into place.
    // Unlike copyFile(destination), rename replaces the directory entry and
    // never follows a pre-existing `.bak` symlink to an outside path.
    await copyFile(absolutePath, backupTemporaryPath);
    // The source can change while copyFile is running. A second boundary and
    // version check prevents the common race from turning the newer external
    // file into a backup and then overwriting it with this stale preview.
    await assertStableTarget(projectRoot, absolutePath);
    assertSameVersion(await currentVersion(absolutePath), preview.expectedVersion);
    await replaceBackup(backupTemporaryPath, backupPath);
    // Keep the final rename bound to the same physical target. This is not an
    // OS-level compare-and-swap, but it closes the checks-after-copy window and
    // rejects parent junction/symlink replacement whenever it remains visible.
    await assertStableTarget(projectRoot, absolutePath);
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    await unlink(backupTemporaryPath).catch(() => undefined);
    if (error instanceof ConfuiError) throw error;
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

function validateChanges(changes: readonly ConfigChange[]): void {
  if (!Array.isArray(changes) || changes.length > MAX_SAVE_CHANGES) {
    throw new ConfuiError("INVALID_INPUT", `一次最多只能保存 ${MAX_SAVE_CHANGES} 项更改`);
  }
  const seen = new Set<string>();
  const paths: PathSegment[][] = [];
  for (const change of changes) {
    validateChange(change);
    const key = pathKey(change.segments);
    if (seen.has(key)) throw new ConfuiError("INVALID_INPUT", "同一配置项不能重复修改");
    if (paths.some((path) => isStrictPrefix(path, change.segments) || isStrictPrefix(change.segments, path))) {
      throw new ConfuiError("INVALID_INPUT", "不能同时修改父级对象和子字段，请只保留其中一项");
    }
    seen.add(key);
    paths.push([...change.segments]);
  }
}

function isStrictPrefix(prefix: readonly PathSegment[], path: readonly PathSegment[]): boolean {
  return prefix.length < path.length && prefix.every((segment, index) => segment === path[index]);
}

async function assertStableTarget(projectRoot: string, absolutePath: string): Promise<void> {
  try {
    const resolvedPath = await ensurePathInsideProject(projectRoot, absolutePath);
    const info = await lstat(absolutePath);
    if (!samePath(resolvedPath, absolutePath) || info.isSymbolicLink() || !info.isFile()) {
      throw new ConfuiError("FILE_CONFLICT", "配置文件路径在保存过程中发生变化，请重新加载后再试");
    }
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError("FILE_CONFLICT", "配置文件路径在保存过程中发生变化，请重新加载后再试");
  }
}

function assertWritableSize(output: string): void {
  const size = Buffer.byteLength(output, "utf8");
  if (size > HARD_FILE_LIMIT) {
    throw new ConfuiError(
      "FILE_TOO_LARGE",
      "保存后的文件超过 5 MB，Confui 不会写入它",
      `${size} bytes`,
    );
  }
}

async function replaceBackup(source: string, target: string): Promise<void> {
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ConfuiError("SAVE_ERROR", "已有的 .bak 不是普通文件，已拒绝覆盖");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await unlink(target);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await rename(source, target);
}

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
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
  if (change === null || typeof change !== "object" || !Array.isArray(change.segments)) {
    throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
  }
  if (change.segments.length < 1 || change.segments.length > 32) {
    throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
  }
  for (const segment of change.segments) {
    if ((typeof segment !== "string" && typeof segment !== "number")
      || (typeof segment === "number" && (!Number.isSafeInteger(segment) || segment < 0))
      || (typeof segment === "string" && (segment.length > 512 || segment.includes("\0")))) {
      throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
    }
    if (typeof segment === "string" && FORBIDDEN_SEGMENTS.has(segment)) {
      throw new ConfuiError("INVALID_INPUT", "配置字段路径包含不安全的键名");
    }
  }
  try {
    validateChangeValue(change.value);
    const serialized = JSON.stringify(change.value);
    if (serialized && Buffer.byteLength(serialized, "utf8") > MAX_CHANGE_VALUE_BYTES) {
      throw new ConfuiError("FILE_TOO_LARGE", "单个配置项的内容超过 1 MB，已拒绝保存");
    }
  } catch (error) {
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError("INVALID_INPUT", "配置字段值无法序列化");
  }
}

function validateChangeValue(value: unknown): void {
  const seen = new WeakSet<object>();
  function visit(current: unknown, nested: boolean): void {
    if (current === undefined) {
      if (nested) throw new ConfuiError("INVALID_INPUT", "配置字段值无法序列化");
      return;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new ConfuiError("INVALID_INPUT", "配置字段值必须是有限数字");
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new ConfuiError("INVALID_INPUT", "整数超过 JavaScript 安全范围，无法安全保存");
      }
    }
    if (typeof current === "string" && current.includes("\0")) {
      throw new ConfuiError("INVALID_INPUT", "配置字段值包含无效字符");
    }
    if (typeof current === "bigint" || typeof current === "function" || typeof current === "symbol") {
      throw new ConfuiError("INVALID_INPUT", "配置字段值无法序列化");
    }
    if (current instanceof Date) {
      if (!Number.isFinite(current.getTime())) throw new ConfuiError("INVALID_INPUT", "配置字段值无法序列化");
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (seen.has(current)) throw new ConfuiError("INVALID_INPUT", "配置字段值不能包含循环引用");
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item, true);
    } else {
      for (const item of Object.values(current as Record<string, unknown>)) visit(item, true);
    }
    seen.delete(current);
  }
  visit(value, false);
}
