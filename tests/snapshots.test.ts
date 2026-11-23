import { mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentVersion } from "../core/files.ts";
import { commitSave } from "../core/save.ts";
import type { SecretCodec } from "../core/settings.ts";
import { computeProjectSnapshotHash, SnapshotStore } from "../core/snapshots.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function createMockCodec(): SecretCodec {
  return {
    encode(value: string): string {
      return `enc:test:${Buffer.from(value, "utf8").toString("base64")}`;
    },
    decode(value: string): string | undefined {
      if (!value.startsWith("enc:test:")) return undefined;
      return Buffer.from(value.slice(9), "base64").toString("utf8");
    },
  };
}

describe("Out-of-repo Named Snapshots (core/snapshots.ts + commitSave)", () => {
  it("encrypts snapshots outside the project repo, previews diff, restores losslessly via commitSave with .bak, and deletes cleanly", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "confui-snap-proj-"));
    const appDataDir = await mkdtemp(join(tmpdir(), "confui-snap-appdata-"));
    tempDirs.push(projectDir, appDataDir);

    const secretVal = "sk-snapshot-top-secret-999988887777";
    const v1Content = [
      "# Primary service config (keep comment verbatim)",
      "service: billing",
      `api_token: ${secretVal}`,
      "---",
      "# Sibling doc untouched",
      "kind: Service",
      "port:   8080",
    ].join("\n") + "\n";

    const configPath = join(projectDir, "deploy.yaml");
    await writeFile(configPath, v1Content, "utf8");
    const repoEntriesBefore = (await readdir(projectDir)).sort();

    const store = new SnapshotStore({
      baseDir: join(appDataDir, "snapshots"),
      codec: createMockCodec(),
    });

    // 1. Save named snapshot — MUST NOT create any file inside projectDir!
    const snap = await store.saveSnapshot(projectDir, "deploy.yaml", "  Before   migration\n");
    expect(snap).toMatchObject({
      file: "deploy.yaml",
      format: "yaml",
      label: "Before migration",
      encrypted: true,
    });
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await readdir(projectDir)).sort()).toEqual(repoEntriesBefore);

    // 2. Raw file on disk inside appDataDir MUST be AES-256-GCM encrypted (zero plaintext secret!)
    const projectHash = computeProjectSnapshotHash(await realpath(projectDir));
    const bucketDir = join(appDataDir, "snapshots", projectHash);
    const snapFileRaw = await readFile(join(bucketDir, `${snap.id}.snap.json`), "utf8");
    expect(snapFileRaw).not.toContain(secretVal);
    expect(snapFileRaw).not.toContain("Primary service config");
    expect(snapFileRaw).toContain('"encrypted":true');

    // 3. listSnapshots returns metadata only (no ciphertext / content)
    const listed = await store.listSnapshots(projectDir, "deploy.yaml");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(snap.id);
    expect(JSON.stringify(listed)).not.toContain(secretVal);

    // 4. Modify file on disk, then preview & restore snapshot via commitSave
    const v2Content = "service: billing-v2\napi_token: rotated\n---\nkind: Service\nport: 9090\n";
    await writeFile(configPath, v2Content, "utf8");
    const v2Version = await currentVersion(configPath);

    const preview = await store.previewSnapshotRestore(projectDir, "deploy.yaml", snap.id, v2Version);
    expect(preview.currentText).toBe(v2Content);
    expect(preview.snapshotText).toBe(v1Content);
    expect(preview.savePreview.snapshotRestore).toEqual({
      snapshotId: snap.id,
      snapshotSha256: snap.sha256,
    });

    // Forged renderer output MUST be rejected by commitSave!
    await expect(
      commitSave(
        projectDir,
        { ...preview.savePreview, output: "service: hacked\n" },
        {
          resolveSnapshotText: async (root, file, snapshotId, expectedSha256) =>
            (await store.readVerifiedSnapshot(root, file, snapshotId, expectedSha256)).text,
        },
      ),
    ).rejects.toThrow(/快照恢复预览已经失效/);

    // Missing main-process resolver MUST also be rejected!
    await expect(commitSave(projectDir, preview.savePreview)).rejects.toThrow(/缺少快照校验服务/);

    // Verified restore succeeds atomically and creates `.bak` containing v2Content!
    const saved = await commitSave(projectDir, preview.savePreview, {
      resolveSnapshotText: async (root, file, snapshotId, expectedSha256) =>
        (await store.readVerifiedSnapshot(root, file, snapshotId, expectedSha256)).text,
    });
    expect(await readFile(configPath, "utf8")).toBe(v1Content);
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(v2Content);
    expect(saved.version.hash).toBe(snap.sha256);

    // 5. Delete snapshot removes it cleanly
    expect(await store.deleteSnapshot(projectDir, snap.id)).toBe(true);
    expect(await store.deleteSnapshot(projectDir, snap.id)).toBe(false);
    expect(await store.listSnapshots(projectDir, "deploy.yaml")).toEqual([]);
  });

  it("detects GCM ciphertext tampering, enforces 50-snapshot & 5 MB caps, blocks path traversal and symlinks", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "confui-snap-sec-"));
    const appDataDir = await mkdtemp(join(tmpdir(), "confui-snap-secdata-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "confui-snap-outside-"));
    tempDirs.push(projectDir, appDataDir, outsideDir);

    await writeFile(join(projectDir, ".env"), "PORT=3000\n", "utf8");
    await writeFile(join(projectDir, "other.env"), "PORT=4000\n", "utf8");

    const store = new SnapshotStore({
      baseDir: join(appDataDir, "snapshots"),
      codec: createMockCodec(),
      maxSnapshotsPerProject: 3,
    });

    // 1. Reject path-traversal snapshot IDs
    const envVersion = await currentVersion(join(projectDir, ".env"));
    for (const badId of ["../evil", "..\\evil", "a/b", "short", "bad id!"]) {
      await expect(store.deleteSnapshot(projectDir, badId)).rejects.toThrow(/快照 ID 无效/);
      await expect(store.previewSnapshotRestore(projectDir, ".env", badId, envVersion)).rejects.toThrow(/快照 ID 无效/);
    }

    // 2. Reject empty/overlong labels
    await expect(store.saveSnapshot(projectDir, ".env", "   ")).rejects.toThrow(/备注标签/);
    await expect(store.saveSnapshot(projectDir, ".env", "x".repeat(121))).rejects.toThrow(/不能超过/);

    // 3. Enforce per-project snapshot count limit even under concurrent burst saves
    const burst = await Promise.allSettled([
      store.saveSnapshot(projectDir, ".env", "Snap 1"),
      store.saveSnapshot(projectDir, ".env", "Snap 2"),
      store.saveSnapshot(projectDir, ".env", "Snap 3"),
      store.saveSnapshot(projectDir, ".env", "Snap 4"),
      store.saveSnapshot(projectDir, ".env", "Snap 5"),
    ]);
    const fulfilled = burst.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<SnapshotStore["saveSnapshot"]>>> => r.status === "fulfilled");
    const rejected = burst.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(3);
    expect(rejected).toHaveLength(2);
    const s1 = fulfilled[0]!.value;
    await expect(store.saveSnapshot(projectDir, ".env", "Snap 6")).rejects.toThrow(/数量已达上限/);

    // 4. Cross-file restore mismatch rejected
    const otherVersion = await currentVersion(join(projectDir, "other.env"));
    await expect(store.previewSnapshotRestore(projectDir, "other.env", s1.id, otherVersion)).rejects.toThrow(/不属于当前配置文件/);

    // 5. Tampered GCM ciphertext rejected
    const projectHash = computeProjectSnapshotHash(await realpath(projectDir));
    const s1Path = join(appDataDir, "snapshots", projectHash, `${s1.id}.snap.json`);
    const envelope = JSON.parse(await readFile(s1Path, "utf8")) as Record<string, unknown>;
    const origBuf = Buffer.from(String(envelope.ciphertext), "base64");
    origBuf[0] = (origBuf[0] ?? 0) ^ 0xff;
    envelope.ciphertext = origBuf.toString("base64");
    await writeFile(s1Path, JSON.stringify(envelope), "utf8");

    await expect(store.previewSnapshotRestore(projectDir, ".env", s1.id, envVersion)).rejects.toThrow(/认证解密失败/);

    // 6. Oversized (> 5 MB) file rejected
    const bigStore = new SnapshotStore({
      baseDir: join(appDataDir, "snapshots-big"),
      codec: createMockCodec(),
    });
    await writeFile(join(projectDir, "huge.env"), `DATA=${"a".repeat(5 * 1024 * 1024 + 10)}\n`, "utf8");
    await expect(bigStore.saveSnapshot(projectDir, "huge.env", "Too big")).rejects.toThrow(/5 MB/);

    // 7. Symlink target file rejected when OS permits symlinks
    await writeFile(join(outsideDir, "secret.env"), "SECRET=1\n", "utf8");
    let linked = false;
    try {
      await symlink(join(outsideDir, "secret.env"), join(projectDir, "linked.env"));
      linked = true;
    } catch {
      // Windows without Developer Mode may disallow file symlinks
    }
    if (linked) {
      await expect(bigStore.saveSnapshot(projectDir, "linked.env", "Escape")).rejects.toThrow();
    }
  });

  it("red-team P1-3: fails closed without codec, binds GCM AAD against envelope swap, blocks plaintext downgrade and raw unwrapped DEKs", async () => {
    const projectDir = await mkdtemp(join(tmpdir(), "confui-snap-rt-"));
    const appDataDir = await mkdtemp(join(tmpdir(), "confui-snap-rtdata-"));
    tempDirs.push(projectDir, appDataDir);

    // 1. Fail-closed constructor when codec is omitted without explicit test opt-in
    expect(() => new SnapshotStore({ baseDir: join(appDataDir, "no-codec") })).toThrow(/缺少安全加密编解码器/);

    await writeFile(join(projectDir, "dev.env"), "ENV=dev\nSECRET=dev_secret_111\n", "utf8");
    await writeFile(join(projectDir, "prod.env"), "ENV=prod\nSECRET=prod_secret_222\n", "utf8");

    const strictCodec: SecretCodec = {
      encode(value: string): string {
        return `enc:v1:${Buffer.from(value, "utf8").toString("base64")}`;
      },
      decode(value: string): string | undefined {
        if (!value.startsWith("enc:v1:")) return undefined;
        return Buffer.from(value.slice(7), "base64").toString("utf8");
      },
    };
    const store = new SnapshotStore({
      baseDir: join(appDataDir, "snapshots"),
      codec: strictCodec,
    });

    const devSnap = await store.saveSnapshot(projectDir, "dev.env", "Dev baseline");
    const prodVersion = await currentVersion(join(projectDir, "prod.env"));
    const devVersion = await currentVersion(join(projectDir, "dev.env"));
    const projectHash = computeProjectSnapshotHash(await realpath(projectDir));
    const bucketDir = join(appDataDir, "snapshots", projectHash);
    const devPath = join(bucketDir, `${devSnap.id}.snap.json`);
    const devEnvelope = JSON.parse(await readFile(devPath, "utf8")) as Record<string, unknown>;

    // 2. GCM AAD swap attack: transplanting dev.env ciphertext into a forged prod.env envelope MUST fail auth
    const forgedProdId = "forged1234-abcdef012345";
    const forgedProdEnvelope = {
      ...devEnvelope,
      id: forgedProdId,
      file: "prod.env",
    };
    await writeFile(join(bucketDir, `${forgedProdId}.snap.json`), JSON.stringify(forgedProdEnvelope), "utf8");
    await expect(
      store.previewSnapshotRestore(projectDir, "prod.env", forgedProdId, prodVersion),
    ).rejects.toThrow(/认证解密失败/);

    // Same-file ID swap also fails AAD auth
    const forgedIdSwap = "forged5678-abcdef012345";
    await writeFile(
      join(bucketDir, `${forgedIdSwap}.snap.json`),
      JSON.stringify({ ...devEnvelope, id: forgedIdSwap }),
      "utf8",
    );
    await expect(
      store.previewSnapshotRestore(projectDir, "dev.env", forgedIdSwap, devVersion),
    ).rejects.toThrow(/认证解密失败/);

    // 3. Plaintext downgrade attack (`encrypted: false`) MUST be rejected when codec is active
    const downgradeId = "downgrade1-abcdef012345";
    const downgradeContent = "ENV=pwned\n";
    await writeFile(
      join(bucketDir, `${downgradeId}.snap.json`),
      JSON.stringify({
        version: 1,
        id: downgradeId,
        projectHash,
        file: "dev.env",
        format: "env",
        label: "Downgraded",
        createdAt: Date.now(),
        size: Buffer.byteLength(downgradeContent, "utf8"),
        sha256: devSnap.sha256,
        encrypted: false,
        content: downgradeContent,
      }),
      "utf8",
    );
    await expect(
      store.previewSnapshotRestore(projectDir, "dev.env", downgradeId, devVersion),
    ).rejects.toThrow(/拒绝读取未加密的明文快照/);

    // 4. Raw unwrapped base64 DEK (missing `enc:v1:` prefix) MUST be rejected by strict codec
    const rawDekId = "rawdek0001-abcdef012345";
    const rawDekEnvelope = {
      ...devEnvelope,
      id: rawDekId,
      wrappedKey: Buffer.alloc(32, 7).toString("base64"),
    };
    await writeFile(join(bucketDir, `${rawDekId}.snap.json`), JSON.stringify(rawDekEnvelope), "utf8");
    await expect(
      store.previewSnapshotRestore(projectDir, "dev.env", rawDekId, devVersion),
    ).rejects.toThrow(/无法解密该快照/);

    // 5. P2-3: listSnapshots rejects symlinked/junctioned baseDir or bucketDir
    const symBase = join(appDataDir, "symlink-base");
    const decoyDir = await mkdtemp(join(tmpdir(), "confui-snap-decoy-"));
    tempDirs.push(decoyDir);
    let baseLinked = false;
    try {
      await symlink(decoyDir, symBase, "junction");
      baseLinked = true;
    } catch {
      // Skip if OS refuses junction creation
    }
    if (baseLinked) {
      const linkedStore = new SnapshotStore({ baseDir: symBase, codec: strictCodec });
      await expect(linkedStore.listSnapshots(projectDir)).rejects.toThrow(/快照根目录异常/);
    }
  });
});
