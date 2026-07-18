import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
await rename(join(target, "electron.exe"), join(target, "Confui.exe"));

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
