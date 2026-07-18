import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import rcedit from "rcedit";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = join(workspace, "node_modules", "electron", "dist");
const buildOutput = join(workspace, "out");
const releaseRoot = join(workspace, "release");
const target = join(releaseRoot, "Confui-win32-x64");

assertInside(workspace, releaseRoot);
assertInside(releaseRoot, target);

const rootPackage = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
const appPackage = {
  name: "confui",
  productName: "Confui",
  version: rootPackage.version,
  private: true,
  type: "module",
  main: "out/main/main.js",
};

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(electronDist, target, { recursive: true, force: true });
const executable = join(target, "Confui.exe");
await rename(join(target, "electron.exe"), executable);
await rcedit(executable, {
  icon: join(workspace, "assets", "confui-icon.ico"),
  "file-version": windowsVersion(appPackage.version),
  "product-version": windowsVersion(appPackage.version),
  "version-string": {
    CompanyName: "1Beyond1",
    FileDescription: "Confui configuration editor",
    InternalName: "Confui",
    OriginalFilename: "Confui.exe",
    ProductName: "Confui",
  },
});

const resources = join(target, "resources");
const appResources = join(resources, "app");
await rm(join(resources, "default_app.asar"), { force: true });
await mkdir(appResources, { recursive: true });
await cp(buildOutput, join(appResources, "out"), { recursive: true, force: true });
await writeFile(join(appResources, "package.json"), `${JSON.stringify(appPackage, null, 2)}\n`, "utf8");

console.log(`Packaged Confui ${appPackage.version}`);
console.log(`Output: ${target}`);

function assertInside(parent, child) {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  if (childPath === parentPath || !childPath.startsWith(parentPath + sep)) {
    throw new Error(`Unsafe package path: ${relative(workspace, childPath)}`);
  }
}

function windowsVersion(version) {
  const numeric = version.split(/[+-]/, 1)[0].split(".").map((part) => Number.parseInt(part, 10) || 0);
  return [...numeric, 0, 0, 0, 0].slice(0, 4).join(".");
}
