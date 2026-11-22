import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, open, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  BackupStatus,
  ConfigChange,
  ConfigFormat,
  FileVersion,
  PathSegment,
  RestoreBackupPreview,
  SavePreview,
  SaveResult,
} from "../shared/schema.ts";
import { isForbiddenKey } from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";
import { HARD_FILE_LIMIT, currentVersion, hashText, readTextSnapshot } from "./files.ts";
import { assertEditableSyntax, detectFormat, parseConfig, updateConfigText } from "./formats.ts";
import { ensurePathInsideProject, formatPath, getAtPath, pathKey, resolveExistingProjectPath } from "./paths.ts";

const activeSavePaths = new Set<string>();
const MAX_SAVE_CHANGES = 2_000;
const MAX_CHANGE_VALUE_BYTES = 1 * 1024 * 1024;
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200];

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
  let mainReplaced = false;
  let effectiveBackupPath = backupPath;
  try {
    // Reject a non-regular `.bak` (such as a symlink) before writing or
    // touching the target file.
    await assertSafeBackupTarget(backupPath);

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

    // Stage the backup copy beside the target before replacing the main file,
    // but do NOT overwrite the existing `.bak` until the main replacement
    // actually succeeds — if replacing the target fails, the previous `.bak`
    // stays intact.
    await copyFile(absolutePath, backupTemporaryPath);
    await assertStableTarget(projectRoot, absolutePath);
    assertSameVersion(await currentVersion(absolutePath), preview.expectedVersion);

    // Atomically replace the main file first (with short Windows EPERM/EBUSY
    // backoff retry).
    await renameWithRetry(temporaryPath, absolutePath);
    mainReplaced = true;
  } catch (error) {
    await safeUnlink(temporaryPath);
    if (!mainReplaced) await safeUnlink(backupTemporaryPath);
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "SAVE_ERROR",
      "配置文件保存失败，原文件没有被覆盖",
      error instanceof Error ? error.message : String(error),
    );
  }

  // Promote the staged backup into `.bak` atomically via rename (never
  // unlinking `.bak` beforehand, so a failure never leaves the user with no
  // backup). If promotion still fails after the main file was already written,
  // keep the staged backup file and return its path rather than falsely
  // reporting that the save itself failed.
  try {
    await promoteBackup(backupTemporaryPath, backupPath);
  } catch {
    effectiveBackupPath = backupTemporaryPath;
  }

  // Compute the new FileVersion from the bytes we just wrote rather than
  // re-reading the file, so a transient antivirus/indexer lock immediately
  // after rename cannot falsely fail a completed save.
  const mtimeMs = await stat(absolutePath).then((info) => info.mtimeMs).catch(() => Date.now());
  return {
    file: preview.file,
    version: {
      mtimeMs,
      size: Buffer.byteLength(generated.output, "utf8"),
      hash: hashText(generated.output),
    },
    backupPath: effectiveBackupPath,
  };
}

export async function getBackupStatus(root: string, relativeFile: string): Promise<BackupStatus> {
  const { root: projectRoot, path: absolutePath } = await resolveExistingProjectPath(root, relativeFile);
  const backupPath = `${absolutePath}.bak`;
  try {
    const info = await lstat(backupPath);
    if (info.isSymbolicLink() || !info.isFile() || info.size > HARD_FILE_LIMIT) {
      return { exists: false };
    }
    const resolvedBackup = await ensurePathInsideProject(projectRoot, backupPath);
    if (!samePath(resolvedBackup, backupPath)) return { exists: false };
    return {
      exists: true,
      size: info.size,
      modifiedAt: info.mtimeMs,
    };
  } catch {
    return { exists: false };
  }
}

export async function previewRestoreBackup(
  root: string,
  relativeFile: string,
  expectedVersion: FileVersion,
): Promise<RestoreBackupPreview> {
  const { root: projectRoot, path: absolutePath } = await resolveExistingProjectPath(root, relativeFile);
  const format = detectFormat(relativeFile);
  if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");
  const currentSnapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(currentSnapshot.version, expectedVersion);

  const backupPath = `${absolutePath}.bak`;
  await assertStableTarget(projectRoot, backupPath);
  const backupSnapshot = await readTextSnapshot(backupPath);
  assertEditableSyntax(relativeFile, backupSnapshot.text);
  parseConfig(backupSnapshot.text, format);

  return {
    projectRoot,
    file: relativeFile.replace(/\\/g, "/"),
    format,
    currentText: currentSnapshot.text,
    backupText: backupSnapshot.text,
    expectedVersion: currentSnapshot.version,
    backupVersion: backupSnapshot.version,
    backupModifiedAt: backupSnapshot.version.mtimeMs,
  };
}

export async function commitRestoreBackup(
  root: string,
  preview: RestoreBackupPreview,
): Promise<SaveResult> {
  const resolved = await resolveExistingProjectPath(root, preview.file);
  if (!samePath(resolved.root, preview.projectRoot)) {
    throw new ConfuiError("FILE_CONFLICT", "恢复预览属于另一个项目，已拒绝写入");
  }
  const { path: absolutePath } = resolved;
  const format = detectFormat(preview.file);
  if (!format || format !== preview.format) {
    throw new ConfuiError("INVALID_INPUT", "恢复请求中的文件格式不一致");
  }
  if (activeSavePaths.has(absolutePath)) {
    throw new ConfuiError("FILE_CONFLICT", "这个配置文件正在保存或恢复，请稍后再试");
  }
  activeSavePaths.add(absolutePath);
  try {
    return await commitRestoreExclusive(resolved.root, absolutePath, preview, format);
  } finally {
    activeSavePaths.delete(absolutePath);
  }
}

async function commitRestoreExclusive(
  projectRoot: string,
  absolutePath: string,
  preview: RestoreBackupPreview,
  format: ConfigFormat,
): Promise<SaveResult> {
  const backupPath = `${absolutePath}.bak`;
  await assertStableTarget(projectRoot, absolutePath);
  await assertStableTarget(projectRoot, backupPath);

  const currentSnapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(currentSnapshot.version, preview.expectedVersion);

  const backupSnapshot = await readTextSnapshot(backupPath);
  assertSameVersion(backupSnapshot.version, preview.backupVersion);
  if (backupSnapshot.text !== preview.backupText) {
    throw new ConfuiError("FILE_CONFLICT", "备份文件已发生变化，请重新预览后再恢复");
  }
  assertEditableSyntax(preview.file, backupSnapshot.text);
  parseConfig(backupSnapshot.text, format);
  assertWritableSize(backupSnapshot.text);

  const temporaryPath = join(dirname(absolutePath), `.${basename(absolutePath)}.confui-${process.pid}-${randomUUID()}.tmp`);
  const backupTemporaryPath = join(dirname(absolutePath), `.${basename(absolutePath)}.confui-${process.pid}-${randomUUID()}.bak.tmp`);
  let mainReplaced = false;
  let effectiveBackupPath = backupPath;

  try {
    const mode = (await stat(absolutePath)).mode;
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(backupSnapshot.text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporaryPath, mode);

    await assertStableTarget(projectRoot, absolutePath);
    assertSameVersion(await currentVersion(absolutePath), preview.expectedVersion);

    await copyFile(absolutePath, backupTemporaryPath);
    await assertStableTarget(projectRoot, absolutePath);
    assertSameVersion(await currentVersion(absolutePath), preview.expectedVersion);

    await renameWithRetry(temporaryPath, absolutePath);
    mainReplaced = true;
  } catch (error) {
    await safeUnlink(temporaryPath);
    if (!mainReplaced) await safeUnlink(backupTemporaryPath);
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "SAVE_ERROR",
      "从备份恢复失败，原文件没有被覆盖",
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    await promoteBackup(backupTemporaryPath, backupPath);
  } catch {
    effectiveBackupPath = backupTemporaryPath;
  }

  const mtimeMs = await stat(absolutePath).then((info) => info.mtimeMs).catch(() => Date.now());
  return {
    file: preview.file,
    version: {
      mtimeMs,
      size: Buffer.byteLength(backupSnapshot.text, "utf8"),
      hash: hashText(backupSnapshot.text),
    },
    backupPath: effectiveBackupPath,
  };
}

export async function renameWithRetry(
  source: string,
  target: string,
  renameFn: (src: string, dst: string) => Promise<void> = rename,
  delaysMs: readonly number[] = RENAME_RETRY_DELAYS_MS,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await renameFn(source, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      const retryable = platform === "win32"
        ? code === "EPERM" || code === "EBUSY"
        : code === "EBUSY";
      if (!retryable || attempt >= delaysMs.length) throw error;
      await sleep(delaysMs[attempt]!);
      attempt += 1;
    }
  }
}

async function assertSafeBackupTarget(target: string): Promise<{ mode: number } | undefined> {
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ConfuiError("SAVE_ERROR", "已有的 .bak 不是普通文件，已拒绝覆盖");
    }
    return { mode: existing.mode };
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function promoteBackup(source: string, target: string): Promise<void> {
  const existing = await assertSafeBackupTarget(target);
  if (existing && (existing.mode & 0o200) === 0) {
    await chmod(target, existing.mode | 0o200).catch(() => undefined);
  }
  await renameWithRetry(source, target);
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (isMissingFile(error)) return;
    try {
      await chmod(filePath, 0o600);
      await unlink(filePath);
    } catch {
      // Best-effort temporary file cleanup.
    }
  }
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

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMissingFile(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
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
    if (typeof segment === "string" && isForbiddenKey(segment)) {
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
