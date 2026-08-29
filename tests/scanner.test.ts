import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeGithubUrl, scanProject } from "../core/scanner.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("project scanner", () => {
  it("finds supported configs, ranks them and excludes samples, locks and JS configs", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-scan-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "config"));
    await Promise.all([
      writeFile(join(root, "package.json"), "{}"),
      writeFile(join(root, "package-lock.json"), "{}"),
      writeFile(join(root, "vite.config.ts"), "export default {}"),
      writeFile(join(root, "config.json"), "{}"),
      writeFile(join(root, "config.example.json"), "{}"),
      writeFile(join(root, "data.json"), "{}"),
      writeFile(join(root, "config", "app.yaml"), "enabled: true\n"),
      writeFile(join(root, ".git", "config"), '[remote "origin"]\n  url = git@github.com:1Beyond1/confui.git\n'),
    ]);

    const result = await scanProject(root);
    expect(result.detectedGithubUrl).toBe("https://github.com/1Beyond1/confui");
    expect(result.files.map((file) => file.path)).toEqual([
      "package.json",
      "config.json",
      "config/app.yaml",
      "data.json",
    ]);
    expect(result.files[0]?.confidence).toBe("known");
    expect(result.files.at(-1)?.confidence).toBe("possible");
  });

  it("marks a directive-style .conf unsupported but keeps a real INI editable", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-conf-"));
    temporaryDirectories.push(root);
    await Promise.all([
      writeFile(join(root, "nginx.conf"), "user nginx;\nhttp {\n    listen 80;\n}\n"),
      writeFile(join(root, "app.cfg"), "[database]\nhost=localhost\n"),
      writeFile(join(root, "plain.ini"), "key=value\n"),
    ]);

    const byPath = new Map((await scanProject(root)).files.map((file) => [file.path, file]));
    expect(byPath.get("nginx.conf")?.status).toBe("unsupported");
    expect(byPath.get("nginx.conf")?.warning).toContain("nginx");
    expect(byPath.get("app.cfg")?.status).toBe("ready");
    expect(byPath.get("plain.ini")?.status).toBe("ready");
  });

  it("normalizes only credential-free GitHub repository URLs", () => {
    expect(normalizeGithubUrl("https://www.github.com/owner/repo.git/issues")).toBe("https://github.com/owner/repo");
    expect(normalizeGithubUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeGithubUrl("https://user:password@github.com/owner/repo")).toBeUndefined();
    expect(normalizeGithubUrl("https://github.com.attacker.example/owner/repo")).toBeUndefined();
  });
});
