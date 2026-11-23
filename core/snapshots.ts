import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  ConfigFormat,
  FileVersion,
  SavePreview,
  SnapshotRestorePreview,
  SnapshotSummary,
  YamlDocumentSummary,
} from "../shared/schema.ts";
import { ConfuiError } from "./errors.ts";
import { HARD_FILE_LIMIT, hashText, readTextSnapshot } from "./files.ts";
import { assertEditableSyntax, detectFormat, extractYamlDocumentSummaries, parseConfig, parseYamlDocuments } from "./formats.ts";
import { readLimitedUtf8File } from "./inference/limited-text.ts";
import { resolveExistingProjectPath, safeJoin } from "./paths.ts";
import { assertSameVersion, renameWithRetry } from "./save.ts";
import type { SecretCodec } from "./settings.ts";

export const MAX_SNAPSHOTS_PER_PROJECT = 50;
export const MAX_SNAPSHOT_BYTES = HARD_FILE_LIMIT;
export const MAX_SNAPSHOT_LABEL_CHARS = 120;
/** Envelope cap allows base64 ciphertext (~1.34x) + JSON metadata for a 5 MB config file. */
const MAX_SNAPSHOT_ENVELOPE_BYTES = Math.ceil(MAX_SNAPSHOT_BYTES * 1.6) + 64 * 1024;
const SNAPSHOT_ID_RE = /^[a-z0-9][a-z0-9_-]{7,63}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
const SNAPSHOT_EXT = ".snap.json";
const SUPPORTED_FORMATS = new Set<ConfigFormat>(["json", "jsonc", "yaml", "toml", "env", "ini", "properties"]);

interface SnapshotEnvelope {
  version: 1;
  id: string;
  projectHash: string;
  file: string;
  format: ConfigFormat;
  label: string;
  createdAt: number;
  size: number;
  sha256: string;
  encrypted: boolean;
  wrappedKey?: string;
  iv?: string;
  tag?: string;
  ciphertext?: string;
  content?: string;
}

export interface SnapshotStoreOptions {
  baseDir: string;
  codec?: SecretCodec;
  /**
   * Explicit opt-in for codec-less unit tests only. Production code MUST supply
   * a strict `safeStorage`-backed `codec`; omitting `codec` fails closed.
   */
  allowPlaintextForTests?: boolean;
  maxSnapshotsPerProject?: number;
}

function buildSnapshotAad(meta: {
  version: 1;
  projectHash: string;
  id: string;
  file: string;
  format: ConfigFormat;
}): Buffer {
  return Buffer.from(
    JSON.stringify([meta.version, meta.projectHash, meta.id, meta.file, meta.format]),
    "utf8",
  );
}

export function isValidSnapshotId(value: unknown): value is string {
  return typeof value === "string" && SNAPSHOT_ID_RE.test(value);
}

export function computeProjectSnapshotHash(canonicalProjectRoot: string): string {
  const normalized = process.platform === "win32"
    ? resolve(canonicalProjectRoot).toLowerCase()
    : resolve(canonicalProjectRoot);
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Stores named configuration snapshots strictly inside Confui's application
 * data directory (`<userData>/snapshots/<projectSha256>/`) — never writing any
 * extra files into the user's project repository. When a `SecretCodec` is
 * supplied (Electron `safeStorage`), snapshot payloads are authenticated-encrypted
 * with per-snapshot random AES-256-GCM keys wrapped by OS secure storage.
 */
export class SnapshotStore {
  private readonly baseDir: string;
  private readonly codec?: SecretCodec;
  private readonly allowPlaintextForTests: boolean;
  private readonly maxSnapshotsPerProject: number;
  private readonly projectLocks = new Map<string, Promise<unknown>>();

  constructor(options: SnapshotStoreOptions) {
    if (!options.baseDir || !options.baseDir.trim()) {
      throw new ConfuiError("INVALID_INPUT", "快照存储目录无效");
    }
    if (!options.codec && options.allowPlaintextForTests !== true) {
      throw new ConfuiError("SAVE_ERROR", "快照存储缺少安全加密编解码器，已拒绝初始化");
    }
    this.baseDir = resolve(options.baseDir);
    this.codec = options.codec;
    this.allowPlaintextForTests = options.allowPlaintextForTests === true;
    this.maxSnapshotsPerProject = Math.max(1, Math.min(200, Math.trunc(options.maxSnapshotsPerProject ?? MAX_SNAPSHOTS_PER_PROJECT)));
  }

  async listSnapshots(root: string, relativeFile?: string): Promise<SnapshotSummary[]> {
    const projectRoot = await resolveProjectRoot(root);
    const projectHash = computeProjectSnapshotHash(projectRoot);
    const bucketDir = this.resolveBucketDir(projectHash);
    const normalizedFilter = relativeFile !== undefined && relativeFile.trim()
      ? normalizeRelativeConfigFile(projectRoot, relativeFile)
      : undefined;

    const exists = await this.assertExistingSafeBucketDir(bucketDir, true);
    if (!exists) return [];

    const entries = await readdir(bucketDir, { withFileTypes: true });
    const summaries: SnapshotSummary[] = [];
    const entryLimit = this.maxSnapshotsPerProject * 4;
    let processed = 0;

    for (const entry of entries) {
      if (processed >= entryLimit) break;
      if (entry.isSymbolicLink() || !entry.isFile() || !entry.name.endsWith(SNAPSHOT_EXT)) continue;
      const snapshotId = entry.name.slice(0, -SNAPSHOT_EXT.length);
      if (!SNAPSHOT_ID_RE.test(snapshotId)) continue;
      processed += 1;

      const filePath = this.resolveSnapshotFilePath(bucketDir, snapshotId);
      try {
        const record = await this.readEnvelope(filePath, projectHash, snapshotId);
        if (normalizedFilter && !sameRelativeFile(record.file, normalizedFilter)) continue;
        summaries.push(toSummary(record));
      } catch {
        // Ignore corrupted or foreign snapshot entries when listing.
      }
    }

    return summaries.sort((left, right) =>
      right.createdAt - left.createdAt || right.id.localeCompare(left.id),
    );
  }

  async saveSnapshot(root: string, relativeFile: string, rawLabel: string): Promise<SnapshotSummary> {
    const label = sanitizeSnapshotLabel(rawLabel);
    const resolved = await resolveExistingProjectPath(root, relativeFile);
    const lexicalTarget = safeJoin(resolved.root, relativeFile);
    const lexicalInfo = await lstat(lexicalTarget);
    if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile() || !sameFsPath(resolved.path, lexicalTarget)) {
      throw new ConfuiError("INVALID_INPUT", "目标配置文件包含符号链接或不是普通文件，已拒绝创建快照");
    }

    const format = detectFormat(relativeFile);
    if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");

    const fileSnapshot = await readTextSnapshot(resolved.path);
    if (Buffer.byteLength(fileSnapshot.text, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new ConfuiError("FILE_TOO_LARGE", "配置文件超过 5 MB，无法创建快照");
    }
    assertEditableSyntax(relativeFile, fileSnapshot.text);
    if (format === "yaml") {
      parseYamlDocuments(fileSnapshot.text);
    } else {
      parseConfig(fileSnapshot.text, format);
    }

    const projectHash = computeProjectSnapshotHash(resolved.root);
    return this.withProjectLock(projectHash, async () => {
      const bucketDir = await this.ensureSafeBucketDir(projectHash);
      const existingCount = await this.countSnapshotFiles(bucketDir);
      if (existingCount >= this.maxSnapshotsPerProject) {
        throw new ConfuiError(
          "SAVE_ERROR",
          `当前项目快照数量已达上限（${this.maxSnapshotsPerProject} 份），请先删除旧快照后再保存`,
        );
      }

      const normalizedFile = relative(resolved.root, resolved.path).replace(/\\/g, "/");
      const id = `${Date.now().toString(36)}-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const targetPath = this.resolveSnapshotFilePath(bucketDir, id);
      const aad = buildSnapshotAad({
        version: 1,
        projectHash,
        id,
        file: normalizedFile,
        format,
      });
      const payload = this.encodePayload(fileSnapshot.text, aad);

      const record: SnapshotEnvelope = {
        version: 1,
        id,
        projectHash,
        file: normalizedFile,
        format,
        label,
        createdAt: Date.now(),
        size: fileSnapshot.version.size,
        sha256: fileSnapshot.version.hash,
        ...payload,
      };

      const serialized = `${JSON.stringify(record)}\n`;
      const tempPath = join(bucketDir, `.${id}.${process.pid}-${randomUUID()}.tmp`);
      try {
        const handle = await open(tempPath, "wx", 0o600);
        try {
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await chmod(tempPath, 0o600).catch(() => undefined);
        await renameWithRetry(tempPath, targetPath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        if (error instanceof ConfuiError) throw error;
        throw new ConfuiError(
          "SAVE_ERROR",
          "保存命名快照失败",
          error instanceof Error ? error.message : String(error),
        );
      }

      return toSummary(record);
    });
  }

  async readVerifiedSnapshot(
    root: string,
    relativeFile: string,
    snapshotId: string,
    expectedSha256?: string,
  ): Promise<{ summary: SnapshotSummary; text: string }> {
    if (!isValidSnapshotId(snapshotId)) {
      throw new ConfuiError("INVALID_INPUT", "快照 ID 无效");
    }
    if (expectedSha256 !== undefined && !SHA256_HEX_RE.test(expectedSha256)) {
      throw new ConfuiError("INVALID_INPUT", "快照校验摘要无效");
    }

    const projectRoot = await resolveProjectRoot(root);
    const projectHash = computeProjectSnapshotHash(projectRoot);
    const normalizedFile = normalizeRelativeConfigFile(projectRoot, relativeFile);
    const bucketDir = this.resolveBucketDir(projectHash);
    await this.assertExistingSafeBucketDir(bucketDir);
    const filePath = this.resolveSnapshotFilePath(bucketDir, snapshotId);

    const record = await this.readEnvelope(filePath, projectHash, snapshotId);
    if (!sameRelativeFile(record.file, normalizedFile)) {
      throw new ConfuiError("INVALID_INPUT", "该快照不属于当前配置文件，已拒绝恢复");
    }
    if (expectedSha256 !== undefined && record.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new ConfuiError("FILE_CONFLICT", "快照内容摘要不匹配，请重新预览后再恢复");
    }

    const text = this.decodePayload(record);
    const byteSize = Buffer.byteLength(text, "utf8");
    if (byteSize > MAX_SNAPSHOT_BYTES) {
      throw new ConfuiError("FILE_TOO_LARGE", "快照文件超过 5 MB 上限，已拒绝恢复");
    }
    if (hashText(text) !== record.sha256) {
      throw new ConfuiError("SAVE_ERROR", "快照完整性校验失败（SHA-256 不匹配），已拒绝恢复");
    }

    assertEditableSyntax(normalizedFile, text);
    if (record.format === "yaml") {
      parseYamlDocuments(text);
    } else {
      parseConfig(text, record.format);
    }

    return { summary: toSummary(record), text };
  }

  async previewSnapshotRestore(
    root: string,
    relativeFile: string,
    snapshotId: string,
    expectedVersion: FileVersion,
  ): Promise<SnapshotRestorePreview> {
    const resolved = await resolveExistingProjectPath(root, relativeFile);
    const lexicalTarget = safeJoin(resolved.root, relativeFile);
    const lexicalInfo = await lstat(lexicalTarget);
    if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile() || !sameFsPath(resolved.path, lexicalTarget)) {
      throw new ConfuiError("INVALID_INPUT", "目标配置文件包含符号链接或不是普通文件，已拒绝恢复快照");
    }

    const format = detectFormat(relativeFile);
    if (!format) throw new ConfuiError("INVALID_INPUT", "不支持这个配置文件格式");

    const currentSnapshot = await readTextSnapshot(resolved.path);
    assertSameVersion(currentSnapshot.version, expectedVersion);

    const { summary, text: snapshotText } = await this.readVerifiedSnapshot(
      resolved.root,
      relativeFile,
      snapshotId,
    );
    if (summary.format !== format) {
      throw new ConfuiError("INVALID_INPUT", "快照格式与当前配置文件不一致");
    }

    let yamlDocuments: YamlDocumentSummary[] | undefined;
    if (format === "yaml") {
      const docs = extractYamlDocumentSummaries(snapshotText);
      if (docs.length > 1) yamlDocuments = docs;
    }

    const normalizedFile = relative(resolved.root, resolved.path).replace(/\\/g, "/");
    const savePreview: SavePreview = {
      projectRoot: resolved.root,
      file: normalizedFile,
      format,
      changes: [],
      operations: [],
      output: snapshotText,
      warnings: [],
      expectedVersion: currentSnapshot.version,
      ...(yamlDocuments ? { yamlDocuments } : {}),
      snapshotRestore: {
        snapshotId: summary.id,
        snapshotSha256: summary.sha256,
      },
    };

    return {
      projectRoot: resolved.root,
      file: normalizedFile,
      format,
      snapshotId: summary.id,
      snapshotLabel: summary.label,
      snapshotCreatedAt: summary.createdAt,
      snapshotSha256: summary.sha256,
      currentText: currentSnapshot.text,
      snapshotText,
      expectedVersion: currentSnapshot.version,
      savePreview,
    };
  }

  async deleteSnapshot(root: string, snapshotId: string): Promise<boolean> {
    if (!isValidSnapshotId(snapshotId)) {
      throw new ConfuiError("INVALID_INPUT", "快照 ID 无效");
    }
    const projectRoot = await resolveProjectRoot(root);
    const projectHash = computeProjectSnapshotHash(projectRoot);
    return this.withProjectLock(projectHash, async () => {
      const bucketDir = this.resolveBucketDir(projectHash);
      const exists = await this.assertExistingSafeBucketDir(bucketDir, true);
      if (!exists) return false;
      const filePath = this.resolveSnapshotFilePath(bucketDir, snapshotId);

      let info;
      try {
        info = await lstat(filePath);
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new ConfuiError("INVALID_INPUT", "快照目标不是普通文件，已拒绝删除");
      }
      await unlink(filePath);
      return true;
    });
  }

  private async withProjectLock<T>(projectHash: string, task: () => Promise<T>): Promise<T> {
    const previous = this.projectLocks.get(projectHash) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const chained = previous.then(() => gate, () => gate);
    this.projectLocks.set(projectHash, chained);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.projectLocks.get(projectHash) === chained) {
        this.projectLocks.delete(projectHash);
      }
    }
  }

  private async assertExistingSafeBucketDir(bucketDir: string, allowMissing = false): Promise<boolean> {
    let baseInfo;
    try {
      baseInfo = await lstat(this.baseDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        if (allowMissing) return false;
        throw new ConfuiError("NOT_FOUND", "找不到指定的快照");
      }
      throw error;
    }
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
      throw new ConfuiError("SAVE_ERROR", "快照根目录异常，已拒绝访问");
    }

    let bucketInfo;
    try {
      bucketInfo = await lstat(bucketDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        if (allowMissing) return false;
        throw new ConfuiError("NOT_FOUND", "找不到指定的快照");
      }
      throw error;
    }
    if (bucketInfo.isSymbolicLink() || !bucketInfo.isDirectory()) {
      throw new ConfuiError("SAVE_ERROR", "快照目录异常，已拒绝访问");
    }
    const realBase = await realpath(this.baseDir);
    const realBucket = await realpath(bucketDir);
    if (!isStrictlyInsideDir(realBase, realBucket)) {
      throw new ConfuiError("SAVE_ERROR", "项目快照目录发生逃逸，已拒绝访问");
    }
    return true;
  }

  private resolveBucketDir(projectHash: string): string {
    if (!SHA256_HEX_RE.test(projectHash)) {
      throw new ConfuiError("INVALID_INPUT", "项目快照目录标识无效");
    }
    const bucket = resolve(this.baseDir, projectHash);
    if (!isStrictlyInsideDir(this.baseDir, bucket)) {
      throw new ConfuiError("INVALID_INPUT", "快照路径超出应用数据目录");
    }
    return bucket;
  }

  private resolveSnapshotFilePath(bucketDir: string, snapshotId: string): string {
    if (!SNAPSHOT_ID_RE.test(snapshotId)) {
      throw new ConfuiError("INVALID_INPUT", "快照 ID 无效");
    }
    const target = resolve(bucketDir, `${snapshotId}${SNAPSHOT_EXT}`);
    if (!sameFsPath(dirname(target), bucketDir) || !isStrictlyInsideDir(bucketDir, target)) {
      throw new ConfuiError("INVALID_INPUT", "快照路径包含非法目录穿越");
    }
    return target;
  }

  private async ensureSafeBucketDir(projectHash: string): Promise<string> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    const baseInfo = await lstat(this.baseDir);
    if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
      throw new ConfuiError("SAVE_ERROR", "快照根目录异常，已拒绝写入");
    }
    const bucketDir = this.resolveBucketDir(projectHash);
    await mkdir(bucketDir, { recursive: true, mode: 0o700 });
    const bucketInfo = await lstat(bucketDir);
    if (bucketInfo.isSymbolicLink() || !bucketInfo.isDirectory()) {
      throw new ConfuiError("SAVE_ERROR", "项目快照目录异常，已拒绝写入");
    }
    const realBase = await realpath(this.baseDir);
    const realBucket = await realpath(bucketDir);
    if (!isStrictlyInsideDir(realBase, realBucket)) {
      throw new ConfuiError("SAVE_ERROR", "项目快照目录发生逃逸，已拒绝写入");
    }
    return bucketDir;
  }

  private async countSnapshotFiles(bucketDir: string): Promise<number> {
    const entries = await readdir(bucketDir, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isSymbolicLink() && entry.isFile() && entry.name.endsWith(SNAPSHOT_EXT)) {
        count += 1;
      }
    }
    return count;
  }

  private async readEnvelope(
    filePath: string,
    expectedProjectHash: string,
    expectedId: string,
  ): Promise<SnapshotEnvelope> {
    let info;
    try {
      info = await lstat(filePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new ConfuiError("NOT_FOUND", "找不到指定的快照");
      }
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new ConfuiError("INVALID_INPUT", "快照文件不是普通文件，已拒绝读取");
    }
    const raw = await readLimitedUtf8File(filePath, {
      maxBytes: MAX_SNAPSHOT_ENVELOPE_BYTES,
      overflow: "reject",
      tooLargeMessage: "快照文件超过允许的大小上限",
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ConfuiError("PARSE_ERROR", "快照元数据已损坏");
    }
    if (!isValidEnvelope(parsed)) {
      throw new ConfuiError("PARSE_ERROR", "快照结构无效或已损坏");
    }
    if (parsed.projectHash !== expectedProjectHash || parsed.id !== expectedId) {
      throw new ConfuiError("INVALID_INPUT", "快照归属信息不匹配");
    }
    return parsed;
  }

  private encodePayload(
    text: string,
    aad: Buffer,
  ): Pick<
    SnapshotEnvelope,
    "encrypted" | "wrappedKey" | "iv" | "tag" | "ciphertext" | "content"
  > {
    if (!this.codec) {
      if (!this.allowPlaintextForTests) {
        throw new ConfuiError("SAVE_ERROR", "快照加密服务不可用，已拒绝明文写入");
      }
      return { encrypted: false, content: text };
    }
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrappedKey = this.codec.encode(dek.toString("base64"));
    if (!wrappedKey) {
      throw new ConfuiError("SAVE_ERROR", "系统安全存储未能加密快照密钥，已取消保存");
    }
    return {
      encrypted: true,
      wrappedKey,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: encrypted.toString("base64"),
    };
  }

  private decodePayload(record: SnapshotEnvelope): string {
    if (this.codec && !record.encrypted) {
      throw new ConfuiError("SAVE_ERROR", "已启用加密快照模式，拒绝读取未加密的明文快照");
    }
    if (!record.encrypted) {
      if (!this.allowPlaintextForTests) {
        throw new ConfuiError("SAVE_ERROR", "安全策略禁止读取未加密的明文快照");
      }
      if (typeof record.content !== "string") {
        throw new ConfuiError("PARSE_ERROR", "快照正文缺失");
      }
      return record.content;
    }
    if (!this.codec) {
      throw new ConfuiError("SAVE_ERROR", "系统安全存储未初始化，无法解密该快照");
    }
    if (!record.wrappedKey || !record.iv || !record.tag || typeof record.ciphertext !== "string") {
      throw new ConfuiError("PARSE_ERROR", "加密快照缺少必要字段，无法解密");
    }
    const decodedKeyBase64 = this.codec.decode(record.wrappedKey);
    if (!decodedKeyBase64) {
      throw new ConfuiError("SAVE_ERROR", "无法解密该快照（系统安全存储不可用或密钥格式无效）");
    }
    const dek = Buffer.from(decodedKeyBase64, "base64");
    const iv = Buffer.from(record.iv, "base64");
    const tag = Buffer.from(record.tag, "base64");
    if (dek.length !== 32 || iv.length !== 12 || tag.length !== 16) {
      throw new ConfuiError("PARSE_ERROR", "加密快照参数损坏，已拒绝恢复");
    }
    try {
      const aad = buildSnapshotAad({
        version: record.version,
        projectHash: record.projectHash,
        id: record.id,
        file: record.file,
        format: record.format,
      });
      const decipher = createDecipheriv("aes-256-gcm", dek, iv);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch {
      throw new ConfuiError("SAVE_ERROR", "快照认证解密失败（内容或上下文元数据可能已被篡改或损坏）");
    }
  }
}

export function sanitizeSnapshotLabel(rawLabel: string): string {
  if (typeof rawLabel !== "string" || rawLabel.includes("\0")) {
    throw new ConfuiError("INVALID_INPUT", "快照标签无效");
  }
  const cleaned = rawLabel.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) {
    throw new ConfuiError("INVALID_INPUT", "请填写快照备注标签");
  }
  if (cleaned.length > MAX_SNAPSHOT_LABEL_CHARS) {
    throw new ConfuiError("INVALID_INPUT", `快照标签不能超过 ${MAX_SNAPSHOT_LABEL_CHARS} 个字符`);
  }
  return cleaned;
}

async function resolveProjectRoot(rootInput: string): Promise<string> {
  if (typeof rootInput !== "string" || !rootInput.trim() || rootInput.includes("\0")) {
    throw new ConfuiError("INVALID_INPUT", "项目路径无效");
  }
  let projectRoot: string;
  let info;
  try {
    projectRoot = await realpath(resolve(rootInput.trim()));
    info = await stat(projectRoot);
  } catch {
    throw new ConfuiError("NOT_FOUND", "找不到这个项目文件夹");
  }
  if (!info.isDirectory()) {
    throw new ConfuiError("INVALID_INPUT", "项目路径不是文件夹");
  }
  return projectRoot;
}

function normalizeRelativeConfigFile(projectRoot: string, relativeFile: string): string {
  const lexical = safeJoin(projectRoot, relativeFile);
  return relative(projectRoot, lexical).replace(/\\/g, "/");
}

function isValidEnvelope(value: unknown): value is SnapshotEnvelope {
  if (value === null || typeof value !== "object") return false;
  const item = value as SnapshotEnvelope;
  return item.version === 1
    && isValidSnapshotId(item.id)
    && typeof item.projectHash === "string" && SHA256_HEX_RE.test(item.projectHash)
    && typeof item.file === "string" && item.file.length > 0 && item.file.length <= 4_096 && !item.file.includes("\0")
    && typeof item.format === "string" && SUPPORTED_FORMATS.has(item.format)
    && typeof item.label === "string" && item.label.length > 0 && item.label.length <= MAX_SNAPSHOT_LABEL_CHARS
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt) && item.createdAt >= 0
    && typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 && item.size <= MAX_SNAPSHOT_BYTES
    && typeof item.sha256 === "string" && SHA256_HEX_RE.test(item.sha256)
    && typeof item.encrypted === "boolean";
}

function toSummary(record: SnapshotEnvelope): SnapshotSummary {
  return {
    id: record.id,
    file: record.file,
    format: record.format,
    label: record.label,
    createdAt: record.createdAt,
    size: record.size,
    sha256: record.sha256,
    encrypted: record.encrypted,
  };
}

function isStrictlyInsideDir(parentDir: string, candidatePath: string): boolean {
  const parent = resolve(parentDir);
  const candidate = resolve(candidatePath);
  if (sameFsPath(parent, candidate)) return false;
  const rel = relative(parent, candidate);
  return Boolean(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("../"));
}

function sameRelativeFile(left: string, right: string): boolean {
  const a = left.replace(/\\/g, "/");
  const b = right.replace(/\\/g, "/");
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFsPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}
