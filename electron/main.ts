import { app, BrowserWindow, ipcMain, dialog, safeStorage, WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanProject } from "../server/src/scanner.ts";
import { inferSchema } from "../server/src/schema/infer.ts";
import { loadSettings, saveSettings } from "../server/src/config.ts";
import { createProvider } from "../server/src/ai/provider.ts";
import { parseConfig, stringifyConfig } from "../server/src/formats.ts";
import type { AppSettings, ConfigFormat } from "../shared/schema.ts";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { watch, FSWatcher } from "node:fs";
import { resolve, sep } from "node:path";
import { modify as jsoncModify } from "jsonc-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let fileWatcher: FSWatcher | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true, nodeIntegration: false,
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
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

function safeJoin(root: string, file: string): string {
  const r = resolve(root); const j = resolve(r, file);
  if (j !== r && !j.startsWith(r + sep)) throw new Error("path traversal rejected");
  return j;
}

function sendToRenderer(channel: string, data?: unknown) {
  mainWindow?.webContents.send(channel, data);
}

/** Start watching a file for external changes. */
function watchFile(absPath: string) {
  if (fileWatcher) fileWatcher.close();
  try {
    fileWatcher = watch(absPath, (eventType) => {
      if (eventType === "change") sendToRenderer("confui:fileChanged", { path: absPath });
    });
  } catch {}
}

/** Encrypt API key with safeStorage (returns base64). */
function encryptKey(plain: string): string {
  if (!plain || !safeStorage.isEncryptionAvailable()) return plain;
  return safeStorage.encryptString(plain).toString("base64");
}
/** Decrypt API key from safeStorage (from base64). */
function decryptKey(encoded: string): string {
  if (!encoded) return "";
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(encoded, "base64"));
    }
  } catch {}
  return encoded;
}

function registerIpcHandlers() {
  ipcMain.handle("confui:selectFolder", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "Select a project folder" });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("confui:scanProject", async (_, root: string) => {
    try { return { files: await scanProject(root) }; }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle("confui:inferSchema", async (_, root: string, file: string, options?: { readme?: string }) => {
    try {
      const settings = await loadSettings();
      const ai = settings.ai.enabled && settings.ai.apiKey ? createProvider(settings.ai) : undefined;
      const absPath = safeJoin(root, file);
      const cfg = { path: file, absPath, kind: file, size: 0, format: detectFormat(file) };
      const result = await inferSchema(cfg, { ai, aiModel: settings.ai.model, projectRoot: root, readme: options?.readme });
      watchFile(absPath);
      return result;
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle("confui:readFile", async (_, root: string, file: string) => {
    try { return { text: await readFile(safeJoin(root, file), "utf8") }; }
    catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle("confui:saveConfig", async (_, root: string, file: string, value: unknown) => {
    try {
      const absPath = safeJoin(root, file);
      const format = detectFormat(file);
      const originalText = await readFile(absPath, "utf8");

      // Backup
      try { await copyFile(absPath, absPath + ".bak"); } catch {}

      let output: string;
      if (format === "json") {
        // AST-level edit with jsonc-parser (preserves comments, formatting, key order)
        let text = originalText;
        const original = parseConfig(originalText, "json") as Record<string, unknown> | null;
        const newVal = value as Record<string, unknown>;
        if (original && typeof newVal === "object") {
          for (const [key, val] of Object.entries(newVal)) {
            if (JSON.stringify(original[key]) !== JSON.stringify(val)) {
              text = jsoncModify(text, [key], val, {
                formattingOptions: { tabSize: 2, insertSpaces: true },
              });
            }
          }
        } else {
          text = stringifyConfig(value, format);
        }
        output = text;
      } else {
        // Non-JSON: merge and full serialize
        let existing: any = {};
        try { existing = parseConfig(originalText, format); } catch {}
        const merged = value && typeof value === "object" ? { ...existing, ...(value as object) } : value;
        output = stringifyConfig(merged, format);
      }

      await writeFile(absPath, output, "utf8");
      return { ok: true };
    } catch (e: any) { return { error: e.message }; }
  });

  ipcMain.handle("confui:getSettings", async () => {
    const s = await loadSettings();
    // Decrypt API key before sending to renderer
    if (s.ai?.apiKey) s.ai.apiKey = decryptKey(s.ai.apiKey);
    return s;
  });

  ipcMain.handle("confui:setSettings", async (_, settings: AppSettings) => {
    // Encrypt API key before saving
    if (settings.ai?.apiKey) settings.ai.apiKey = encryptKey(settings.ai.apiKey);
    await saveSettings(settings);
    return { ok: true };
  });
}

function detectFormat(filename: string): ConfigFormat {
  const f = filename.toLowerCase();
  if (f.endsWith(".yaml") || f.endsWith(".yml")) return "yaml";
  if (f.endsWith(".toml")) return "toml";
  if (f === ".env" || f.endsWith(".env") || f.startsWith(".env.")) return "env";
  if (f.endsWith(".ini") || f.endsWith(".conf") || f.endsWith(".cfg")) return "ini";
  if (f.endsWith(".properties")) return "properties";
  return "json";
}
