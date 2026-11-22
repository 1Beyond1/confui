import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { deriveTargetFromExample, normalizeGithubUrl, scanProject } from "../core/scanner.ts";

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

  it("reports unpaired example templates and multi-environment config groups", async () => {
    const root = await mkdtemp(join(tmpdir(), "confui-scan-tpl-env-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "config"));
    await Promise.all([
      // Unpaired templates (targets do not exist yet)
      writeFile(join(root, ".env.example"), "PORT=3000\n"),
      writeFile(join(root, ".env.sample"), "PORT=4000\n"),
      writeFile(join(root, "config", "service.example.yaml"), "port: 8080\n"),
      writeFile(join(root, "settings.toml.template"), "port = 9000\n"),
      // Already paired template (should NOT appear in templates)
      writeFile(join(root, "config.json"), "{}"),
      writeFile(join(root, "config.example.json"), "{}"),
      // Multi-environment groups
      writeFile(join(root, "config.prod.json"), '{"port":80}'),
      writeFile(join(root, "config", "app.yaml"), "env: base\n"),
      writeFile(join(root, "config", "app-dev.yaml"), "env: dev\n"),
      writeFile(join(root, "config", "app-prod.yaml"), "env: prod\n"),
    ]);

    expect(deriveTargetFromExample(".env.example")).toEqual({ targetPath: ".env", format: "env" });
    expect(deriveTargetFromExample("config/app.example.jsonc")).toEqual({ targetPath: "config/app.jsonc", format: "jsonc" });
    expect(deriveTargetFromExample("README.example.md")).toBeNull();

    const result = await scanProject(root);
    expect(result.templates?.map((t) => `${t.examplePath}->${t.targetPath}`)).toEqual([
      ".env.example->.env",
      "config/service.example.yaml->config/service.yaml",
      "settings.toml.template->settings.toml",
    ]);
    expect(result.envGroups).toEqual([
      {
        id: "config.json",
        label: "config.json",
        format: "json",
        files: ["config.json", "config.prod.json"],
      },
      {
        id: "config/app.yaml",
        label: "config/app.yaml",
        format: "yaml",
        files: ["config/app.yaml", "config/app-dev.yaml", "config/app-prod.yaml"],
      },
    ]);
  });
});
