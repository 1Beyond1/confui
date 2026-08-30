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
  await copyElectronRuntime(stagingTarget);
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

async function copyElectronRuntime(destination) {
  // Do not rely on fs.cp's recursive filter here. Its callback behavior has
  // differed between Node versions on the Windows runner, which could leave
  // every Electron locale in the portable bundle. Copy top-level entries
  // explicitly and copy only the locales that Confui actually supports.
  const entries = await readdir(electronDist, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(electronDist, entry.name);
    const targetPath = join(destination, entry.name);
    if (entry.name !== "locales") {
      await cp(source, targetPath, { recursive: true, force: true });
      continue;
    }

    await mkdir(targetPath, { recursive: true });
    for (const locale of retainedLocales) {
      await cp(join(source, locale), join(targetPath, locale), { force: true });
    }
  }
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

  const rendererRoot = join(root, "resources", "app", "out", "renderer");
  const rendererIndex = await readFile(join(rendererRoot, "index.html"), "utf8");
  const rendererAssets = [...rendererIndex.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((asset) => asset && !/^(?:[a-z]+:|\/\/|data:|#)/i.test(asset));
  for (const asset of rendererAssets) {
    const assetPath = resolve(rendererRoot, asset);
    assertInside(rendererRoot, assetPath);
    await assertNonEmptyFile(assetPath);
  }

  // The portable bundle is intentionally built from `out/` only. A source
  // directory accidentally copied into resources/app would increase the
  // artifact and expose files that are not needed at runtime.
  for (const sourceDirectory of ["core", "electron", "shared", "tests", "web"]) {
    await assertMissingPath(join(root, "resources", "app", sourceDirectory));
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

async function assertMissingPath(path) {
  try {
    await stat(path);
    throw new Error(`Unexpected source path in portable package: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unexpected source path")) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}
