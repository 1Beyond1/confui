import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../server/src/scanner.ts";
import { inferSchema } from "../server/src/schema/infer.ts";
import { loadSettings, saveSettings } from "../server/src/config.ts";
import { createProvider } from "../server/src/ai/provider.ts";
import type { AppSettings } from "../shared/schema.ts";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function safeJoin(root: string, file: string): string {
  const realRoot = resolve(root);
  const joined = resolve(realRoot, file);
  if (joined !== realRoot && !joined.startsWith(realRoot + sep)) {
    throw new Error("path traversal rejected");
  }
  return joined;
}

function registerIpcHandlers() {
  ipcMain.handle("confui:selectFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"],
      title: "Select a project folder",
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle("confui:scanProject", async (_, root: string) => {
    try {
      const files = await scanProject(root);
      return { files };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle("confui:inferSchema", async (_, root: string, file: string, options?: { readme?: string }) => {
    try {
      const settings = await loadSettings();
      const ai = settings.ai.enabled && settings.ai.apiKey
        ? createProvider(settings.ai)
        : undefined;
      const absPath = safeJoin(root, file);
      const cfg = { path: file, absPath, kind: file, size: 0 };
      return await inferSchema(cfg, { ai, aiModel: settings.ai.model, projectRoot: root, readme: options?.readme });
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle("confui:readFile", async (_, root: string, file: string) => {
    try {
      return { text: await readFile(safeJoin(root, file), "utf8") };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle("confui:saveConfig", async (_, root: string, file: string, value: unknown) => {
    try {
      const absPath = safeJoin(root, file);
      let existing: any = {};
      try { existing = JSON.parse(await readFile(absPath, "utf8")); } catch {}
      const merged = value && typeof value === "object" ? { ...existing, ...(value as object) } : value;
      await writeFile(absPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
      return { ok: true };
    } catch (e: any) {
      return { error: e.message };
    }
  });

  ipcMain.handle("confui:getSettings", async () => loadSettings());

  ipcMain.handle("confui:setSettings", async (_, settings: AppSettings) => {
    await saveSettings(settings);
    return { ok: true };
  });
}
