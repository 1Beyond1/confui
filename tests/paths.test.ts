import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { safeJoin } from "../core/paths.ts";

const ROOT = resolve("C:", "projects", "demo");

describe("safeJoin", () => {
  it("resolves paths inside the project root", () => {
    expect(safeJoin(ROOT, "config.json")).toBe(join(ROOT, "config.json"));
    expect(safeJoin(ROOT, "config/app.yaml")).toBe(join(ROOT, "config", "app.yaml"));
    // Traversal that stays inside is still inside.
    expect(safeJoin(ROOT, "config/../config.json")).toBe(join(ROOT, "config.json"));
  });

  it("rejects traversal, absolute paths and blank input", () => {
    for (const bad of ["..", "../outside.json", "config/../../outside.json", `..${sep}outside.json`]) {
      expect(() => safeJoin(ROOT, bad)).toThrow(/项目目录之外/);
    }
    for (const bad of ["", "   ", resolve(ROOT, "config.json"), resolve("C:", "windows", "win.ini")]) {
      expect(() => safeJoin(ROOT, bad)).toThrow(/文件路径无效/);
    }
    expect(() => safeJoin("", "config.json")).toThrow(/文件路径无效/);
  });

  it("does not let a sibling directory pass as a prefix match", () => {
    // `C:\projects\demo-evil` shares a string prefix with the root but is outside it.
    expect(() => safeJoin(ROOT, join("..", "demo-evil", "config.json"))).toThrow(/项目目录之外/);
  });
});
