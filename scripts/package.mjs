import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import rcedit from "rcedit";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronDist = join(workspace, "node_modules", "electron", "dist");
const buildOutput = join(workspace, "out");
const releaseRoot = join(workspace, "release");
const target = join(releaseRoot, "Confui-win32-x64");
const stagingTarget = join(releaseRoot, `.Confui-win32-x64-${process.pid}-${randomUUID()}`);
const retainedLocales = new Set(["en-US.pak", "zh-CN.pak", "zh-TW.pak"]);

assertInside(workspace, releaseRoot);
assertInside(releaseRoot, target);
assertInside(releaseRoot, stagingTarget);

const rootPackage = JSON.parse(await readFile(join(workspace, "package.json"), "utf8"));
const appPackage = {
  name: "confui",
  productName: "Confui",
  version: rootPackage.version,
  private: true,
  type: "module",
  main: "out/main/main.js",
};

try {
  await rm(stagingTarget, { recursive: true, force: true });
  await mkdir(stagingTarget, { recursive: true });
  await cp(electronDist, stagingTarget, {
    recursive: true,
    force: true,
    filter: shouldCopyElectronPath,
  });
  const executable = join(stagingTarget, "Confui.exe");
  await rename(join(stagingTarget, "electron.exe"), executable);
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

  const resources = join(stagingTarget, "resources");
  const appResources = join(resources, "app");
  // The Electron npm distribution includes a sample/default app that is not
  // used by Confui. Keep this explicit removal as a second line of defense if a
  // future cp implementation changes how filtered directories are handled.
  await rm(join(resources, "default_app.asar"), { force: true });
  await mkdir(appResources, { recursive: true });
  await cp(buildOutput, join(appResources, "out"), { recursive: true, force: true });
  await writeFile(join(appResources, "package.json"), `${JSON.stringify(appPackage, null, 2)}\n`, "utf8");

  await assertPackagedRuntime(stagingTarget);
  await rm(target, { recursive: true, force: true });
  await rename(stagingTarget, target);
} catch (error) {
  await rm(stagingTarget, { recursive: true, force: true });
  throw error;
}

console.log(`Packaged Confui ${appPackage.version}`);
console.log(`Output: ${target}`);
console.log(`Electron locales retained: ${[...retainedLocales].join(", ")}`);

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

function shouldCopyElectronPath(source) {
  const path = relative(electronDist, source).split(sep).join("/");
  if (path === "") return true;
  if (path === "resources/default_app.asar") return false;

  const localePrefix = "locales/";
  if (path.startsWith(localePrefix) && path.endsWith(".pak")) {
    return retainedLocales.has(path.slice(localePrefix.length));
  }
  return true;
}

async function assertPackagedRuntime(root) {
  const requiredFiles = [
    "Confui.exe",
    "icudtl.dat",
    "resources.pak",
    "chrome_100_percent.pak",
    "chrome_200_percent.pak",
    "snapshot_blob.bin",
    "v8_context_snapshot.bin",
    "libEGL.dll",
    "libGLESv2.dll",
    "resources/app/package.json",
    "resources/app/out/main/main.js",
    "resources/app/out/preload/preload.cjs",
    "resources/app/out/renderer/index.html",
  ];

  for (const file of requiredFiles) {
    await assertNonEmptyFile(join(root, file));
  }

  const packagedApp = JSON.parse(await readFile(join(root, "resources/app/package.json"), "utf8"));
  if (packagedApp.main !== appPackage.main || packagedApp.version !== appPackage.version) {
    throw new Error("Packaged app metadata does not match the build");
  }

  for (const locale of retainedLocales) {
    await assertNonEmptyFile(join(root, "locales", locale));
  }

  const localeFiles = await readdir(join(root, "locales"));
  const unexpectedLocales = localeFiles.filter((file) => file.endsWith(".pak") && !retainedLocales.has(file));
  if (unexpectedLocales.length > 0) {
    throw new Error(`Unexpected Electron locales in package: ${unexpectedLocales.join(", ")}`);
  }
}

async function assertNonEmptyFile(path) {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty packaged file: ${path}`);
}
