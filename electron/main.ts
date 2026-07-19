import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleProvider, testAIConnection } from "../core/ai/provider.ts";
import { toAppError, ConfuiError } from "../core/errors.ts";
import { currentVersion } from "../core/files.ts";
import { inferConfig } from "../core/inference/index.ts";
import { safeJoin } from "../core/paths.ts";
import { commitSave, previewSave } from "../core/save.ts";
import { scanProject } from "../core/scanner.ts";
import { SettingsStore, type SecretCodec } from "../core/settings.ts";
import { checkForUpdates } from "../core/update.ts";
import type {
  AppSettings,
  ConfigChange,
  FileChangedEvent,
  FileVersion,
  InferOptions,
  Result,
  SavePreview,
} from "../shared/schema.ts";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
let mainWindow: BrowserWindow | undefined;
let settingsStore: SettingsStore;
let watchedFile: { watcher: FSWatcher; absolutePath: string; relativePath: string } | undefined;
let suppressChange: { absolutePath: string; until: number; hash?: string } | undefined;
let watcherTimer: NodeJS.Timeout | undefined;
let hasUnsavedChanges = false;

app.setName("Confui");
if (process.platform === "win32") app.setAppUserModelId("com.1beyond1.confui");

app.whenReady().then(async () => {
  settingsStore = new SettingsStore(join(app.getPath("userData"), "settings.json"), createSecretCodec());
  registerIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  closeWatcher();
  if (process.platform !== "darwin") app.quit();
});

function createWindow(): void {
  let allowClose = false;
  const window = new BrowserWindow({
    title: "Confui",
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 680,
    icon: resolveWindowIcon(),
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f3f5f8",
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (allowClose || !hasUnsavedChanges) return;
    event.preventDefault();
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "Confui",
      message: "还有未保存的更改",
      detail: "关闭 Confui 会放弃当前配置或设置中的更改。",
      buttons: ["继续编辑", "放弃更改并退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice === 1) {
      allowClose = true;
      window.close();
    }
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = undefined;
    hasUnsavedChanges = false;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(currentDirectory, "../renderer/index.html"));
  }
}

function resolveWindowIcon(): string | undefined {
  return [
    join(currentDirectory, "../renderer/confui-icon.png"),
    join(app.getAppPath(), "web", "public", "confui-icon.png"),
  ].find(existsSync);
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners("confui:setDirtyState");
  ipcMain.on("confui:setDirtyState", (_event, dirty: unknown) => {
    if (typeof dirty === "boolean") hasUnsavedChanges = dirty;
  });

  handle("confui:selectFolder", async () => {
    const options: OpenDialogOptions = {
      title: "选择项目文件夹",
      properties: ["openDirectory"],
      buttonLabel: "打开项目",
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  handle("confui:scanProject", async (_event, root: unknown, githubUrl?: unknown) => {
    assertString(root, "项目路径");
    const result = await scanProject(root);
    await settingsStore.rememberProject({
      path: result.root,
      name: result.name,
      githubUrl: typeof githubUrl === "string" && githubUrl.trim()
        ? githubUrl.trim()
        : result.detectedGithubUrl,
      openedAt: Date.now(),
    });
    return result;
  });

  handle("confui:inferSchema", async (_event, root: unknown, file: unknown, options?: InferOptions) => {
    assertString(root, "项目路径");
    assertString(file, "配置文件路径");
    const settings = await settingsStore.load();
    const ai = settings.ai.enabled && settings.ai.baseUrl && settings.ai.model
      ? new OpenAICompatibleProvider(settings.ai)
      : undefined;
    const schema = await inferConfig(root, file, {
      githubUrl: typeof options?.githubUrl === "string" ? options.githubUrl : undefined,
      githubToken: settings.github.token,
      ai,
    });
    watchConfigFile(root, file);
    return schema;
  });

  handle(
    "confui:previewSave",
    async (_event, root: unknown, file: unknown, changes: unknown, expectedVersion: unknown) => {
      assertString(root, "项目路径");
      assertString(file, "配置文件路径");
      if (!Array.isArray(changes) || !isFileVersion(expectedVersion)) {
        throw new ConfuiError("INVALID_INPUT", "保存参数无效");
      }
      return previewSave(root, file, changes as ConfigChange[], expectedVersion);
    },
  );

  handle("confui:saveConfig", async (_event, root: unknown, preview: unknown) => {
    assertString(root, "项目路径");
    if (!isSavePreview(preview)) throw new ConfuiError("INVALID_INPUT", "保存预览无效");
    const absolutePath = safeJoin(root, preview.file);
    suppressChange = { absolutePath, until: Date.now() + 2_000 };
    try {
      const result = await commitSave(root, preview);
      suppressChange.hash = result.version.hash;
      suppressChange.until = Date.now() + 1_000;
      return result;
    } catch (error) {
      suppressChange = undefined;
      throw error;
    }
  });

  handle("confui:getSettings", async () => settingsStore.load());

  handle("confui:setSettings", async (_event, settings: unknown) => {
    if (!isAppSettings(settings)) throw new ConfuiError("INVALID_INPUT", "设置内容无效");
    const current = await settingsStore.load();
    return settingsStore.save({ ...settings, recentProjects: current.recentProjects });
  });

  handle("confui:testAI", async (_event, settings: unknown) => {
    if (!isAiSettings(settings)) throw new ConfuiError("INVALID_INPUT", "AI 设置内容无效");
    return testAIConnection(settings);
  });

  handle("confui:getAppInfo", async () => ({ version: app.getVersion() }));

  handle("confui:checkForUpdates", async () => checkForUpdates(app.getVersion()));

  handle("confui:openReleasePage", async () => {
    await shell.openExternal("https://github.com/1Beyond1/confui/releases/latest");
    return null;
  });
}

function handle<T>(
  channel: string,
  action: (event: IpcMainInvokeEvent, ...args: never[]) => Promise<T>,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args): Promise<Result<T>> => {
    try {
      return { ok: true, data: await action(event, ...(args as never[])) };
    } catch (error) {
      return { ok: false, error: toAppError(error) };
    }
  });
}

function watchConfigFile(root: string, relativeFile: string): void {
  const absolutePath = safeJoin(root, relativeFile);
  if (watchedFile?.absolutePath === absolutePath) return;
  closeWatcher();
  try {
    const targetName = basename(absolutePath).toLowerCase();
    // Watch the containing directory rather than the file itself. Editors and
    // Confui both use atomic rename-on-save, which invalidates file-level
    // watchers on Windows after the first replacement.
    const watcher = watch(dirname(absolutePath), { persistent: false }, (_eventType, filename) => {
      if (filename && filename.toString().toLowerCase() !== targetName) return;
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => void emitFileChange(absolutePath, relativeFile), 140);
    });
    watchedFile = { watcher, absolutePath, relativePath: relativeFile };
  } catch {
    // Watching is a convenience; opening the file still works if the platform refuses it.
  }
}

async function emitFileChange(absolutePath: string, relativeFile: string): Promise<void> {
  let version: FileVersion | undefined;
  try {
    version = await currentVersion(absolutePath);
  } catch {
    // A rename-save from another editor can make the file briefly unavailable.
  }
  const suppression = suppressChange;
  if (suppression?.absolutePath === absolutePath && Date.now() <= suppression.until) {
    if (!suppression.hash || suppression.hash === version?.hash) return;
  }
  suppressChange = undefined;
  const event: FileChangedEvent = { file: relativeFile.replace(/\\/g, "/"), version };
  mainWindow?.webContents.send("confui:fileChanged", event);
}

function closeWatcher(): void {
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = undefined;
  watchedFile?.watcher.close();
  watchedFile = undefined;
}

function createSecretCodec(): SecretCodec {
  return {
    encode(value) {
      if (!value) return "";
      if (!safeStorage.isEncryptionAvailable()) {
        throw new ConfuiError("SAVE_ERROR", "系统安全存储暂不可用，敏感设置没有保存");
      }
      return `enc:v1:${safeStorage.encryptString(value).toString("base64")}`;
    },
    decode(value) {
      if (!value) return "";
      if (!value.startsWith("enc:v1:")) return value;
      if (!safeStorage.isEncryptionAvailable()) return "";
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(7), "base64"));
      } catch {
        return "";
      }
    },
  };
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new ConfuiError("INVALID_INPUT", `${label}不能为空`);
}

function isFileVersion(value: unknown): value is FileVersion {
  return value !== null && typeof value === "object"
    && typeof (value as FileVersion).hash === "string"
    && typeof (value as FileVersion).mtimeMs === "number"
    && typeof (value as FileVersion).size === "number";
}

function isSavePreview(value: unknown): value is SavePreview {
  return value !== null && typeof value === "object"
    && typeof (value as SavePreview).file === "string"
    && typeof (value as SavePreview).output === "string"
    && Array.isArray((value as SavePreview).operations)
    && isFileVersion((value as SavePreview).expectedVersion);
}

function isAiSettings(value: unknown): value is AppSettings["ai"] {
  return value !== null && typeof value === "object"
    && typeof (value as AppSettings["ai"]).enabled === "boolean"
    && typeof (value as AppSettings["ai"]).provider === "string"
    && typeof (value as AppSettings["ai"]).model === "string"
    && typeof (value as AppSettings["ai"]).baseUrl === "string"
    && typeof (value as AppSettings["ai"]).apiKey === "string";
}

function isAppSettings(value: unknown): value is AppSettings {
  return value !== null && typeof value === "object"
    && isAiSettings((value as AppSettings).ai)
    && (value as AppSettings).github !== null
    && typeof (value as AppSettings).github === "object"
    && typeof (value as AppSettings).github.token === "string"
    && Array.isArray((value as AppSettings).recentProjects);
}
