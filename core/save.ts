import { randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  BackupStatus,
  CompareEntryStatus,
  ConfigChange,
  ConfigCompareEntry,
  ConfigCompareResult,
  ConfigFormat,
  CreateFromExampleResult,
  FileVersion,
  PathSegment,
  RedactedExportPreview,
  RestoreBackupPreview,
  SavePreview,
  SaveResult,
} from "../shared/schema.ts";
import { maskDocumentLines } from "../shared/diff.ts";
import {
  collectSecretStrings,
  containsSecretValuePattern,
  isForbiddenKey,
  SECRET_KEY_PATTERN,
  setSafeProperty,
  valueContainsSecret,
} from "../shared/validation.ts";
import { ConfuiError } from "./errors.ts";
import { HARD_FILE_LIMIT, currentVersion, hashText, readTextSnapshot } from "./files.ts";
import { assertEditableSyntax, detectFormat, parseConfig, parseYamlDocuments, updateConfigText } from "./formats.ts";
import { isSecretPath, toEditorValue } from "./inference/common.ts";
import { maskDocumentSecrets } from "./inference/heuristic.ts";
import {
  ensurePathInsideProject,
  formatPath,
  getAtPath,
  pathKey,
  resolveExistingProjectPath,
  safeJoin,
} from "./paths.ts";
import { deriveTargetFromExample, isExampleFilename } from "./scanner.ts";

const activeSavePaths = new Set<string>();
const MAX_SAVE_CHANGES = 2_000;
const MAX_CHANGE_VALUE_BYTES = 1 * 1024 * 1024;
const MAX_COMPARE_DEPTH = 16;
const MAX_COMPARE_ENTRIES = 5_000;
const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200];

export async function previewSave(
  root: string,
  relativeFile: string,
  requestedChanges: readonly ConfigChange[],
  expectedVersion: FileVersion,
  documentIndex?: number,
): Promise<SavePreview> {
  const { root: projectRoot, path: absolutePath } = await resolveExistingProjectPath(root, relativeFile);
  const format = detectFormat(relativeFile);
  if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");
  if (documentIndex !== undefined && (!Number.isSafeInteger(documentIndex) || documentIndex < 0)) {
    throw new ConfuiError("INVALID_INPUT", "文档索引参数无效");
  }
  const snapshot = await readTextSnapshot(absolutePath);
  assertSameVersion(snapshot.version, expectedVersion);
  assertEditableSyntax(relativeFile, snapshot.text);
  const parsed = parseConfig(snapshot.text, format, { documentIndex });
  validateChanges(requestedChanges);
  const operations = requestedChanges.filter((change) => {
    return !isDeepStrictEqual(getAtPath(parsed, change.segments), change.value);
  });
  const result = updateConfigText(snapshot.text, format, operations, { documentIndex });
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
    ...(documentIndex !== undefined ? { documentIndex } : {}),
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
  if (preview.documentIndex !== undefined && (!Number.isSafeInteger(preview.documentIndex) || preview.documentIndex < 0)) {
    throw new ConfuiError("INVALID_INPUT", "保存预览中的文档索引无效");
  }
  const generated = updateConfigText(snapshot.text, format, preview.operations, {
    documentIndex: preview.documentIndex,
  });
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

/**
 * Safely creates a new configuration file from an existing example template
 * inside the same project. Enforces physical `realpath` containment, rejects
 * symlinks in both source and target paths, and uses `open(..., "wx")` to
 * guarantee an existing file is never overwritten.
 */
export async function createConfigFromExample(
  root: string,
  exampleRelativeFile: string,
  targetRelativeFile?: string,
): Promise<CreateFromExampleResult> {
  if (typeof root !== "string" || !root.trim()) {
    throw new ConfuiError("INVALID_INPUT", "项目路径无效");
  }
  let projectRoot: string;
  try {
    projectRoot = await realpath(resolve(root.trim()));
  } catch {
    throw new ConfuiError("NOT_FOUND", "找不到这个项目文件夹");
  }

  const lexicalExample = safeJoin(projectRoot, exampleRelativeFile);
  await assertSafeParentDirectory(projectRoot, lexicalExample);
  let exampleInfo;
  try {
    exampleInfo = await lstat(lexicalExample);
  } catch {
    throw new ConfuiError("NOT_FOUND", "找不到指定的示例模板文件");
  }
  if (exampleInfo.isSymbolicLink() || !exampleInfo.isFile()) {
    throw new ConfuiError("INVALID_INPUT", "示例模板必须是普通文件，已拒绝软链接");
  }
  const resolvedExample = await resolveExistingProjectPath(projectRoot, exampleRelativeFile);
  if (!samePath(resolvedExample.path, lexicalExample)) {
    throw new ConfuiError("INVALID_INPUT", "示例模板路径包含符号链接，已拒绝访问");
  }
  const normalizedExample = relative(projectRoot, lexicalExample).replace(/\\/g, "/");
  const exampleName = basename(normalizedExample);
  if (!isExampleFilename(exampleName) || /\.bak(?:\.|$)/i.test(exampleName)) {
    throw new ConfuiError("INVALID_INPUT", "源文件不是有效的示例模板文件，已拒绝复制");
  }

  let normalizedTarget: string;
  let format: ConfigFormat;
  if (targetRelativeFile !== undefined && targetRelativeFile.trim()) {
    const trimmedTarget = targetRelativeFile.trim();
    const candidateLexical = safeJoin(projectRoot, trimmedTarget);
    normalizedTarget = relative(projectRoot, candidateLexical).replace(/\\/g, "/");
    const targetName = basename(normalizedTarget);
    const detected = detectFormat(targetName);
    if (!detected || isExampleFilename(targetName) || /\.bak(?:\.|$)/i.test(targetName)) {
      throw new ConfuiError("INVALID_INPUT", "目标配置文件名不受支持");
    }
    format = detected;
  } else {
    const derived = deriveTargetFromExample(normalizedExample);
    if (!derived) {
      throw new ConfuiError("INVALID_INPUT", "无法从该示例模板推导目标配置文件路径");
    }
    normalizedTarget = derived.targetPath;
    format = derived.format;
  }

  const lexicalTarget = safeJoin(projectRoot, normalizedTarget);
  if (samePath(lexicalTarget, lexicalExample)) {
    throw new ConfuiError("INVALID_INPUT", "目标文件不能与示例模板相同");
  }
  await assertSafeParentDirectory(projectRoot, lexicalTarget);
  const existingTarget = await lstat(lexicalTarget).catch(() => undefined);
  if (existingTarget) {
    throw new ConfuiError("FILE_CONFLICT", "目标配置文件已存在，已拒绝覆盖");
  }

  const snapshot = await readTextSnapshot(lexicalExample);
  assertEditableSyntax(normalizedTarget, snapshot.text);
  parseConfig(snapshot.text, format);
  assertWritableSize(snapshot.text);

  await assertSafeParentDirectory(projectRoot, lexicalTarget);
  let handle;
  try {
    handle = await open(lexicalTarget, "wx");
    await handle.writeFile(snapshot.text, "utf8");
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new ConfuiError("FILE_CONFLICT", "目标配置文件已存在，已拒绝覆盖");
    }
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "SAVE_ERROR",
      "从示例模板创建配置文件失败",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  await assertStableTarget(projectRoot, lexicalTarget);
  return {
    file: normalizedTarget,
    exampleFile: normalizedExample,
    format,
    size: Buffer.byteLength(snapshot.text, "utf8"),
  };
}

/**
 * Structurally compares two configuration files inside the same project and
 * classifies leaf keys into missing-in-target, different, only-in-target, or same.
 */
export async function compareConfigFiles(
  root: string,
  sourceRelativeFile: string,
  targetRelativeFile: string,
): Promise<ConfigCompareResult> {
  const sourceResolved = await resolveExistingProjectPath(root, sourceRelativeFile);
  const targetResolved = await resolveExistingProjectPath(root, targetRelativeFile);
  await assertStableTarget(sourceResolved.root, sourceResolved.path);
  await assertStableTarget(targetResolved.root, targetResolved.path);

  const sourceFormat = detectFormat(sourceRelativeFile);
  const targetFormat = detectFormat(targetRelativeFile);
  if (!sourceFormat || !targetFormat) {
    throw new ConfuiError("INVALID_INPUT", "对比文件包含不支持的配置格式");
  }

  const [sourceSnap, targetSnap] = await Promise.all([
    readTextSnapshot(sourceResolved.path),
    readTextSnapshot(targetResolved.path),
  ]);
  assertEditableSyntax(sourceRelativeFile, sourceSnap.text);
  assertEditableSyntax(targetRelativeFile, targetSnap.text);

  const sourceParsed = parseConfig(sourceSnap.text, sourceFormat);
  const targetParsed = parseConfig(targetSnap.text, targetFormat);

  const rawSourceLeaves = flattenConfigLeaves(sourceParsed);
  const rawTargetLeaves = flattenConfigLeaves(targetParsed);
  const sourceLeaves = pruneEmptyContainerConflicts(rawSourceLeaves, rawTargetLeaves);
  const targetLeaves = pruneEmptyContainerConflicts(rawTargetLeaves, rawSourceLeaves);

  const allKeys = new Set<string>([...sourceLeaves.keys(), ...targetLeaves.keys()]);
  const entries: ConfigCompareEntry[] = [];
  const summary = {
    missingInTarget: 0,
    onlyInTarget: 0,
    different: 0,
    same: 0,
  };

  for (const key of allKeys) {
    const src = sourceLeaves.get(key);
    const dst = targetLeaves.get(key);
    const segments = src?.segments ?? dst!.segments;
    const path = src?.path ?? dst!.path;
    const secret = isSecretPath(segments)
      || (src !== undefined && valueContainsSecret(src.value))
      || (dst !== undefined && valueContainsSecret(dst.value));
    const hasSource = src !== undefined;
    const hasTarget = dst !== undefined;
    let status: CompareEntryStatus;
    if (hasSource && !hasTarget) {
      status = "missing-in-target";
      summary.missingInTarget += 1;
    } else if (!hasSource && hasTarget) {
      status = "only-in-target";
      summary.onlyInTarget += 1;
    } else if (isDeepStrictEqual(src?.value, dst?.value)) {
      status = "same";
      summary.same += 1;
    } else {
      status = "different";
      summary.different += 1;
    }
    entries.push({
      path,
      segments: [...segments],
      status,
      secret,
      hasSource,
      hasTarget,
      sourceValue: hasSource ? src.value : undefined,
      targetValue: hasTarget ? dst.value : undefined,
    });
  }

  const statusOrder: Record<CompareEntryStatus, number> = {
    "missing-in-target": 0,
    different: 1,
    "only-in-target": 2,
    same: 3,
  };
  entries.sort((left, right) =>
    statusOrder[left.status] - statusOrder[right.status]
    || left.path.localeCompare(right.path, "en", { numeric: true, sensitivity: "base" }),
  );

  return {
    sourceFile: sourceRelativeFile.replace(/\\/g, "/"),
    targetFile: targetRelativeFile.replace(/\\/g, "/"),
    sourceFormat,
    targetFormat,
    targetVersion: targetSnap.version,
    entries,
    summary,
  };
}

/**
 * Generates a validated `SavePreview` that copies selected key paths from
 * `sourceRelativeFile` into `targetRelativeFile`. Values are read directly from
 * disk in the main process rather than trusted from the renderer.
 */
export async function previewSyncFromFile(
  root: string,
  sourceRelativeFile: string,
  targetRelativeFile: string,
  selectedSegments: readonly (readonly PathSegment[])[],
  expectedTargetVersion: FileVersion,
): Promise<SavePreview> {
  if (!Array.isArray(selectedSegments) || selectedSegments.length === 0 || selectedSegments.length > MAX_SAVE_CHANGES) {
    throw new ConfuiError("INVALID_INPUT", "请选择至少一项需要补齐的配置项");
  }
  const sourceResolved = await resolveExistingProjectPath(root, sourceRelativeFile);
  await assertStableTarget(sourceResolved.root, sourceResolved.path);
  const sourceFormat = detectFormat(sourceRelativeFile);
  const targetFormat = detectFormat(targetRelativeFile);
  if (!sourceFormat || !targetFormat) {
    throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");
  }
  const sourceSnap = await readTextSnapshot(sourceResolved.path);
  assertEditableSyntax(sourceRelativeFile, sourceSnap.text);
  const sourceParsed = parseConfig(sourceSnap.text, sourceFormat);

  const changes: ConfigChange[] = [];
  for (const segments of selectedSegments) {
    if (!Array.isArray(segments) || segments.length < 1 || segments.length > 32) {
      throw new ConfuiError("INVALID_INPUT", "配置字段路径无效");
    }
    const rawValue = getAtPath(sourceParsed, segments);
    if (rawValue === undefined) {
      throw new ConfuiError("INVALID_INPUT", `源文件中不存在配置项 ${formatPath(segments)}`);
    }
    const editorVal = toEditorValue(rawValue);
    const adaptedValue = adaptValueForTargetFormat(editorVal, segments, targetFormat);
    changes.push({ segments: [...segments], value: adaptedValue });
  }

  return previewSave(root, targetRelativeFile, changes, expectedTargetVersion);
}

/**
 * Generates a redacted, comment-preserving copy of a configuration file for
 * sharing or publishing as a template. Masks both structured secret fields
 * (including caller-provided schema-marked secret paths) and pattern-matched
 * inline credentials via `maskDocumentSecrets`.
 */
export async function generateRedactedExport(
  root: string,
  relativeFile: string,
  extraSecretPaths: readonly (readonly PathSegment[])[] = [],
): Promise<RedactedExportPreview> {
  const resolved = await resolveExistingProjectPath(root, relativeFile);
  await assertStableTarget(resolved.root, resolved.path);
  const format = detectFormat(relativeFile);
  if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");

  const snapshot = await readTextSnapshot(resolved.path);
  assertEditableSyntax(relativeFile, snapshot.text);

  const validExtraPaths = extraSecretPaths.filter(
    (segments) => Array.isArray(segments) && segments.length > 0 && segments.length <= 32,
  );
  const extraPathKeys = new Set<string>(validExtraPaths.map((segments) => pathKey(segments)));
  const extraSecretKeys = new Set<string>();
  const extraSecretValues = new Set<string>();
  for (const segments of validExtraPaths) {
    extraSecretKeys.add(formatPath(segments));
    const leaf = segments.at(-1);
    if (typeof leaf === "string" && leaf.trim()) extraSecretKeys.add(leaf);
  }

  let updatedText = snapshot.text;
  const documentValues: Array<{ index?: number; value: unknown }> = format === "yaml"
    ? parseYamlDocuments(snapshot.text).map((doc) => ({ index: doc.index, value: doc.value }))
    : [{ value: parseConfig(snapshot.text, format) }];

  for (const docEntry of documentValues) {
    const leaves = flattenConfigLeaves(docEntry.value);
    const redactChanges: ConfigChange[] = [];
    for (const [key, leaf] of leaves) {
      const isMarkedSecret = isSecretPath(leaf.segments)
        || extraPathKeys.has(key)
        || validExtraPaths.some((prefix) => isStrictPrefix(prefix, leaf.segments));
      if (leaf.value === undefined || leaf.value === null || leaf.value === "") continue;
      if (!isMarkedSecret && !valueContainsSecret(leaf.value)) continue;
      if (isMarkedSecret) {
        collectSecretStrings(leaf.value, extraSecretValues);
      }
      const redacted = redactStructuredValue(leaf.value, isMarkedSecret);
      if (redacted.changed) {
        redactChanges.push({ segments: [...leaf.segments], value: redacted.value });
      }
    }
    if (redactChanges.length > 0) {
      try {
        updatedText = updateConfigText(updatedText, format, redactChanges, {
          documentIndex: docEntry.index,
        }).output;
      } catch {
        // Fall back to line-aware document masking if incremental patch fails.
      }
    }
  }
  const eol = updatedText.includes("\r\n") ? "\r\n" : "\n";
  const lineMasked = maskDocumentLines(updatedText, {
    format,
    secretKeys: [...extraSecretKeys],
    secretValues: [...extraSecretValues],
    mask: "***",
  }).lines.join(eol);
  const content = maskDocumentSecrets(lineMasked);
  const redactedCount = countChangedLines(snapshot.text, content);

  return {
    sourceFile: relativeFile.replace(/\\/g, "/"),
    format,
    suggestedFileName: suggestRedactedFileName(basename(relativeFile)),
    content,
    redactedCount,
  };
}

/**
 * Writes a redacted export copy safely inside the project root without
 * overwriting any existing file (`open(..., "wx")`) or following symlinks.
 */
export async function writeRedactedExport(
  root: string,
  sourceRelativeFile: string,
  targetRelativeFile: string,
  extraSecretPaths: readonly (readonly PathSegment[])[] = [],
): Promise<CreateFromExampleResult> {
  const resolvedSource = await resolveExistingProjectPath(root, sourceRelativeFile);
  const preview = await generateRedactedExport(root, sourceRelativeFile, extraSecretPaths);
  const lexicalTarget = safeJoin(resolvedSource.root, targetRelativeFile);
  if (samePath(lexicalTarget, resolvedSource.path)) {
    throw new ConfuiError("INVALID_INPUT", "导出目标不能覆盖原配置文件");
  }
  await assertSafeParentDirectory(resolvedSource.root, lexicalTarget);
  const existing = await lstat(lexicalTarget).catch(() => undefined);
  if (existing) {
    throw new ConfuiError("FILE_CONFLICT", "导出目标文件已存在，已拒绝覆盖");
  }
  assertWritableSize(preview.content);

  let handle;
  try {
    handle = await open(lexicalTarget, "wx");
    await handle.writeFile(preview.content, "utf8");
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new ConfuiError("FILE_CONFLICT", "导出目标文件已存在，已拒绝覆盖");
    }
    throw new ConfuiError(
      "SAVE_ERROR",
      "导出脱敏副本失败",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  return {
    file: relative(resolvedSource.root, lexicalTarget).replace(/\\/g, "/"),
    exampleFile: preview.sourceFile,
    format: preview.format,
    size: Buffer.byteLength(preview.content, "utf8"),
  };
}

/**
 * Safely writes a redacted export to a user-selected absolute path from native
 * Save Dialog, refusing symlinks and refusing to overwrite the source file.
 */
export async function writeRedactedExportToChosenPath(
  targetAbsolutePath: string,
  sourceAbsolutePath: string,
  content: string,
): Promise<void> {
  const resolvedTarget = resolve(targetAbsolutePath);
  const resolvedSource = await realpath(sourceAbsolutePath);
  if (samePath(resolvedTarget, resolvedSource)) {
    throw new ConfuiError("INVALID_INPUT", "导出目标不能覆盖原配置文件");
  }
  const existing = await lstat(resolvedTarget).catch(() => undefined);
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new ConfuiError("SAVE_ERROR", "所选目标不是普通文件，已拒绝写入");
    }
    const existingReal = await realpath(resolvedTarget);
    if (samePath(existingReal, resolvedSource)) {
      throw new ConfuiError("INVALID_INPUT", "导出目标不能覆盖原配置文件");
    }
  }
  assertWritableSize(content);
  const temporaryPath = join(
    dirname(resolvedTarget),
    `.${basename(resolvedTarget)}.confui-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporaryPath, resolvedTarget);
  } catch (error) {
    await safeUnlink(temporaryPath);
    if (error instanceof ConfuiError) throw error;
    throw new ConfuiError(
      "SAVE_ERROR",
      "导出脱敏副本失败",
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function assertSafeParentDirectory(projectRoot: string, lexicalTarget: string): Promise<void> {
  const parentDir = dirname(lexicalTarget);
  const relParent = relative(projectRoot, parentDir);
  if (relParent === ".." || relParent.startsWith(`..${sep}`)) {
    throw new ConfuiError("INVALID_INPUT", "已拒绝访问项目目录之外的路径");
  }
  let current = projectRoot;
  if (relParent && relParent !== ".") {
    for (const part of relParent.split(sep).filter(Boolean)) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch {
        throw new ConfuiError("NOT_FOUND", "目标目录不存在");
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new ConfuiError("INVALID_INPUT", "目标路径包含符号链接或非目录节点，已拒绝操作");
      }
    }
  }
  const resolvedParent = await ensurePathInsideProject(projectRoot, parentDir);
  if (!samePath(resolvedParent, parentDir)) {
    throw new ConfuiError("INVALID_INPUT", "目标目录包含符号链接，已拒绝操作");
  }
}

interface FlattenedLeaf {
  segments: PathSegment[];
  path: string;
  value: unknown;
}

function flattenConfigLeaves(parsed: unknown): Map<string, FlattenedLeaf> {
  const leaves = new Map<string, FlattenedLeaf>();
  function visit(current: unknown, segments: PathSegment[], depth: number): void {
    if (leaves.size >= MAX_COMPARE_ENTRIES) return;
    if (
      current !== null
      && typeof current === "object"
      && !Array.isArray(current)
      && !(current instanceof Date)
    ) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length === 0) {
        if (segments.length > 0) {
          leaves.set(pathKey(segments), { segments, path: formatPath(segments), value: {} });
        }
        return;
      }
      if (depth >= MAX_COMPARE_DEPTH) {
        if (segments.length > 0) {
          leaves.set(pathKey(segments), {
            segments,
            path: formatPath(segments),
            value: toEditorValue(current),
          });
        }
        return;
      }
      for (const [key, child] of entries) {
        if (key === "$schema" || isForbiddenKey(key)) continue;
        visit(child, [...segments, key], depth + 1);
        if (leaves.size >= MAX_COMPARE_ENTRIES) return;
      }
      return;
    }
    if (segments.length > 0) {
      leaves.set(pathKey(segments), {
        segments,
        path: formatPath(segments),
        value: toEditorValue(current),
      });
    }
  }
  visit(parsed, [], 0);
  return leaves;
}

function pruneEmptyContainerConflicts(
  mine: Map<string, FlattenedLeaf>,
  other: Map<string, FlattenedLeaf>,
): Map<string, FlattenedLeaf> {
  const otherSegmentsList = [...other.values()].map((item) => item.segments);
  const result = new Map<string, FlattenedLeaf>();
  for (const [key, leaf] of mine) {
    const isEmptyObj = leaf.value !== null
      && typeof leaf.value === "object"
      && !Array.isArray(leaf.value)
      && Object.keys(leaf.value as Record<string, unknown>).length === 0;
    if (isEmptyObj && otherSegmentsList.some((otherSegs) => isStrictPrefix(leaf.segments, otherSegs))) {
      continue;
    }
    result.set(key, leaf);
  }
  return result;
}

function adaptValueForTargetFormat(
  value: unknown,
  segments: readonly PathSegment[],
  targetFormat: ConfigFormat,
): unknown {
  if (targetFormat === "env" || targetFormat === "properties") {
    if (segments.length !== 1) {
      throw new ConfuiError("INVALID_INPUT", `${targetFormat.toUpperCase()} 格式不支持嵌套路径 ${formatPath(segments)}`);
    }
    if (value !== null && typeof value === "object") {
      throw new ConfuiError("INVALID_INPUT", `${targetFormat.toUpperCase()} 格式不支持对象或数组值 ${formatPath(segments)}`);
    }
    return value === null ? "" : String(value);
  }
  if (targetFormat === "ini") {
    if (segments.length > 2) {
      throw new ConfuiError("INVALID_INPUT", `INI 格式不支持超过两层的路径 ${formatPath(segments)}`);
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      throw new ConfuiError("INVALID_INPUT", `INI 格式不支持嵌套对象值 ${formatPath(segments)}`);
    }
  }
  return value;
}

function suggestRedactedFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower === ".env" || lower.startsWith(".env.")) {
    return `${fileName}.example`;
  }
  const ext = extname(fileName);
  if (ext && ext.length < fileName.length) {
    const stem = fileName.slice(0, -ext.length);
    return `${stem}.redacted${ext}`;
  }
  return `${fileName}.redacted`;
}

function redactStructuredValue(
  value: unknown,
  insideSecret: boolean,
  depth = 0,
): { value: unknown; changed: boolean } {
  if (depth > 16 || value === undefined || value === null || value === "") {
    return { value, changed: false };
  }
  if (typeof value === "string") {
    if (insideSecret) {
      return { value: "***", changed: value !== "***" };
    }
    if (containsSecretValuePattern(value)) {
      const masked = maskDocumentSecrets(value);
      return { value: masked, changed: masked !== value };
    }
    return { value, changed: false };
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return insideSecret ? { value: "***", changed: true } : { value, changed: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const res = redactStructuredValue(item, insideSecret, depth + 1);
      if (res.changed) changed = true;
      return res.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const keySecret = insideSecret || SECRET_KEY_PATTERN.test(key);
      const res = redactStructuredValue(item, keySecret, depth + 1);
      if (res.changed) changed = true;
      setSafeProperty(next, key, res.value);
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

function countChangedLines(before: string, after: string): number {
  const left = before.replace(/\r\n/g, "\n").split("\n");
  const right = after.replace(/\r\n/g, "\n").split("\n");
  const len = Math.max(left.length, right.length);
  let count = 0;
  for (let i = 0; i < len; i += 1) {
    if (left[i] !== right[i]) count += 1;
  }
  return count;
}
