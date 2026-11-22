import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  safeStorage,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from "electron";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenAICompatibleProvider, testAIConnection } from "../core/ai/provider.ts";
import { toAppError, ConfuiError } from "../core/errors.ts";
import { AI_FILE_LIMIT, currentVersion, HARD_FILE_LIMIT, readTextSnapshot } from "../core/files.ts";
import { explainField as explainFieldWithAI } from "../core/inference/ai.ts";
import { inferExampleFields } from "../core/inference/examples.ts";
import { inferConfig } from "../core/inference/index.ts";
import { inferReadmeFields } from "../core/inference/readme.ts";
import { maskDocumentSecrets, maskSecrets } from "../core/inference/heuristic.ts";
import { isSecretPath } from "../core/inference/common.ts";
import { assertEditableSyntax, detectFormat, parseConfig } from "../core/formats.ts";
import { getAtPath, resolveExistingProjectPath } from "../core/paths.ts";
import {
  commitRestoreBackup,
  commitSave,
  compareConfigFiles,
  createConfigFromExample,
  generateRedactedExport,
  getBackupStatus,
  previewRestoreBackup,
  previewSave,
  previewSyncFromFile,
  writeRedactedExportToChosenPath,
} from "../core/save.ts";
import { isForbiddenKey, normalizeGithubUrl } from "../shared/validation.ts";
import { scanProject } from "../core/scanner.ts";
import { SettingsStore, type SecretCodec } from "../core/settings.ts";
import { checkForUpdates } from "../core/update.ts";
import type {
  AppSettings,
  ConfigChange,
  FileChangedEvent,
  FileVersion,
  FieldAssistField,
  FieldType,
  InferOptions,
  Locale,
  PathSegment,
  Result,
  RestoreBackupPreview,
  SavePreview,
  TestAIRequest,
  ThemePreference,
} from "../shared/schema.ts";

const currentDirectory = fileURLToPath(new URL(".", import.meta.url));
const MAX_PROJECT_PATH_CHARS = 32_768;
const MAX_CONFIG_PATH_CHARS = 4_096;
const MAX_GITHUB_URL_CHARS = 2_000;
const MAX_RECENT_PROJECTS = 100;
const MAX_SAVE_OPERATIONS = 2_000;
const MAX_FIELD_ASSIST_CONCURRENCY = 3;
const SUPPORTED_FORMATS = new Set(["json", "jsonc", "yaml", "toml", "env", "ini", "properties"]);
const PRODUCTION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'";
let mainWindow: BrowserWindow | undefined;
let settingsStore: SettingsStore;
let watchedFile: { watcher: FSWatcher; projectRoot: string; absolutePath: string; relativePath: string } | undefined;
let suppressChange: { absolutePath: string; until: number; hash?: string } | undefined;
let watcherTimer: NodeJS.Timeout | undefined;
let hasUnsavedChanges = false;
let currentLocale: Locale = "zh-CN";
let lastVerifiedReleasePage = "https://github.com/1Beyond1/confui/releases/latest";
let fieldAssistInFlight = 0;

app.setName("Confui");
if (process.platform === "win32") app.setAppUserModelId("com.1beyond1.confui");

// Two instances editing one file would overwrite each other's `.bak` and only
// discover the conflict at save time, so a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    settingsStore = new SettingsStore(join(app.getPath("userData"), "settings.json"), createSecretCodec());
    const initialSettings = await settingsStore.load().catch(() => undefined);
    const initialTheme = initialSettings?.theme ?? "system";
    currentLocale = initialSettings?.locale ?? "zh-CN";
    applyNativeTheme(initialTheme);
    registerIpcHandlers();
    createWindow(initialTheme);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void settingsStore.load()
          .then((settings) => settings.theme)
          .catch(() => "system" as const)
          .then((theme) => {
            applyNativeTheme(theme);
            createWindow(theme);
          });
      }
    });
  });
}

app.on("window-all-closed", () => {
  closeWatcher();
  if (process.platform !== "darwin") app.quit();
});

function createWindow(initialTheme: ThemePreference = "system"): void {
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
    backgroundColor: resolveWindowBackground(initialTheme),
    webPreferences: {
      preload: join(currentDirectory, "../preload/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow = window;
  if (!process.env.ELECTRON_RENDERER_URL) {
    window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders };
      for (const key of Object.keys(responseHeaders)) {
        if (key.toLowerCase() === "content-security-policy") delete responseHeaders[key];
      }
      responseHeaders["Content-Security-Policy"] = [PRODUCTION_CSP];
      callback({ responseHeaders });
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.once("ready-to-show", () => window.show());
  window.on("close", (event) => {
    if (allowClose || !hasUnsavedChanges) return;
    event.preventDefault();
    const isEn = currentLocale === "en-US";
    const choice = dialog.showMessageBoxSync(window, {
      type: "warning",
      title: "Confui",
      message: isEn ? "You have unsaved changes" : "还有未保存的更改",
      detail: isEn
        ? "Closing Confui will discard unsaved configuration or settings changes."
        : "关闭 Confui 会放弃当前配置或设置中的更改。",
      buttons: isEn ? ["Keep Editing", "Discard & Quit"] : ["继续编辑", "放弃更改并退出"],
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

function applyNativeTheme(preference: ThemePreference): void {
  nativeTheme.themeSource = preference;
}

function resolveWindowBackground(preference: ThemePreference): string {
  const dark = preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
  return dark ? "#000000" : "#f3f3f0";
}

function resolveWindowIcon(): string | undefined {
  return [
    join(currentDirectory, "../renderer/confui-icon.png"),
    join(app.getAppPath(), "web", "public", "confui-icon.png"),
  ].find(existsSync);
}

function isTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== mainWindow.webContents.mainFrame) return false;
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    try {
      return new URL(frame.url).origin === new URL(devUrl).origin;
    } catch {
      return false;
    }
  }
  return frame.url.startsWith("file://");
}

function registerIpcHandlers(): void {
  ipcMain.removeAllListeners("confui:setDirtyState");
  ipcMain.on("confui:setDirtyState", (event, dirty: unknown) => {
    if (!isTrustedSender(event)) return;
    if (typeof dirty === "boolean") hasUnsavedChanges = dirty;
  });

  ipcMain.removeAllListeners("confui:stopWatching");
  ipcMain.on("confui:stopWatching", (event) => {
    if (!isTrustedSender(event)) return;
    closeWatcher();
  });

  handle("confui:selectFolder", async () => {
    const isEn = currentLocale === "en-US";
    const options: OpenDialogOptions = {
      title: isEn ? "Select Project Folder" : "选择项目文件夹",
      properties: ["openDirectory"],
      buttonLabel: isEn ? "Open Project" : "打开项目",
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  handle("confui:scanProject", async (_event, root: unknown, githubUrl?: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertOptionalString(githubUrl, "GitHub 仓库链接", MAX_GITHUB_URL_CHARS);
    // Stop watching any previously opened project file before switching.
    closeWatcher();
    const result = await scanProject(root);
    const requestedGithubUrl = typeof githubUrl === "string" ? normalizeGithubUrl(githubUrl) : undefined;
    const effectiveGithubUrl = requestedGithubUrl ?? result.detectedGithubUrl;
    await settingsStore.rememberProject({
      path: result.root,
      name: result.name,
      githubUrl: effectiveGithubUrl,
      openedAt: Date.now(),
    });
    return effectiveGithubUrl === result.detectedGithubUrl
      ? result
      : { ...result, detectedGithubUrl: effectiveGithubUrl };
  });

  handle("confui:inferSchema", async (_event, root: unknown, file: unknown, options?: InferOptions) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
    assertOptionalString(options?.githubUrl, "GitHub 仓库链接", MAX_GITHUB_URL_CHARS);
    const settings = await settingsStore.load();
    const ai = settings.ai.enabled && settings.ai.baseUrl && settings.ai.model
      ? new OpenAICompatibleProvider(settings.ai)
      : undefined;
    const schema = await inferConfig(root, file, {
      githubUrl: typeof options?.githubUrl === "string" ? options.githubUrl : undefined,
      locale: options?.locale === "en-US" || options?.locale === "zh-CN" ? options.locale : settings.locale,
      githubToken: settings.github.token,
      ai,
    });
    const resolved = await resolveExistingProjectPath(root, file);
    watchConfigFile(resolved.root, resolved.path, file);
    return schema;
  });

  handle("confui:explainField", async (_event, root: unknown, file: unknown, field: unknown, githubUrl?: unknown, locale?: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
    assertOptionalString(githubUrl, "GitHub 仓库链接", MAX_GITHUB_URL_CHARS);
    if (locale !== undefined && locale !== "zh-CN" && locale !== "en-US") {
      throw new ConfuiError("INVALID_INPUT", currentLocale === "en-US" ? "Invalid locale parameter" : "语言参数无效");
    }
    const requestedLocale: Locale | undefined = locale === "en-US" || locale === "zh-CN" ? locale : undefined;
    if (!isFieldAssistField(field)) {
      throw new ConfuiError(
        "INVALID_INPUT",
        (requestedLocale ?? currentLocale) === "en-US" ? "Invalid field assistant request" : "字段助手参数无效",
      );
    }

    return withFieldAssistSlot(async () => {
      const settings = await settingsStore.load();
      const effectiveLocale: Locale = requestedLocale ?? settings.locale;
      const isEn = effectiveLocale === "en-US";
      if (!settings.ai.enabled || !settings.ai.baseUrl.trim() || !settings.ai.model.trim()) {
        throw new ConfuiError(
          "AI_ERROR",
          isEn ? "Enable and configure an AI provider in Settings first" : "请先在设置中启用并配置 AI 服务",
        );
      }
      const resolved = await resolveExistingProjectPath(root, file);
      const format = detectFormat(file);
      if (!format) {
        throw new ConfuiError(
          "INVALID_INPUT",
          isEn ? "Unsupported configuration file format" : "不支持这个配置文件格式",
        );
      }
      const snapshot = await readTextSnapshot(resolved.path);
      if (snapshot.version.size > AI_FILE_LIMIT) {
        throw new ConfuiError(
          "AI_ERROR",
          isEn ? "File exceeds 1 MB; AI field explanation is unavailable" : "文件超过 1 MB，暂不提供 AI 字段解释",
        );
      }
      assertEditableSyntax(file, snapshot.text);
      const parsed = parseConfig(snapshot.text, format);
      const isSecret = field.secret === true || field.type === "secret" || isSecretPath(field.segments);
      const maskedValue = isSecret
        ? "***"
        : maskSecrets(getAtPath(parsed, field.segments), field.segments);
      const safeField: FieldAssistField = {
        ...field,
        label: maskDocumentSecrets(field.label),
        description: field.description ? maskDocumentSecrets(field.description) : undefined,
        placeholder: field.placeholder ? maskDocumentSecrets(field.placeholder) : undefined,
        group: field.group ? maskDocumentSecrets(field.group) : undefined,
        enum: field.enum?.map((item) => typeof item === "string" ? maskDocumentSecrets(item) : item),
      };
      const normalizedGithub = typeof githubUrl === "string" ? normalizeGithubUrl(githubUrl) : undefined;
      const [readme, examples] = await Promise.all([
        inferReadmeFields(resolved.root, normalizedGithub, settings.github.token, [field.segments], format),
        inferExampleFields(resolved.path, resolved.root, format),
      ]);
      return explainFieldWithAI({
        provider: new OpenAICompatibleProvider(settings.ai),
        file: file.replace(/\\/g, "/"),
        format,
        field: safeField,
        maskedValue,
        readmeContext: maskDocumentSecrets(readme.text),
        exampleContext: examples.context,
        locale: effectiveLocale,
      });
    }, requestedLocale ?? currentLocale);
  });

  handle(
    "confui:previewSave",
    async (_event, root: unknown, file: unknown, changes: unknown, expectedVersion: unknown) => {
      assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
      assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
      if (!Array.isArray(changes) || !isFileVersion(expectedVersion)) {
        throw new ConfuiError("INVALID_INPUT", "保存参数无效");
      }
      return previewSave(root, file, changes as ConfigChange[], expectedVersion);
    },
  );

  handle("confui:saveConfig", async (_event, root: unknown, preview: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    if (!isSavePreview(preview)) throw new ConfuiError("INVALID_INPUT", "保存预览无效");
    const absolutePath = (await resolveExistingProjectPath(root, preview.file)).path;
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

  handle("confui:getBackupStatus", async (_event, root: unknown, file: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
    return getBackupStatus(root, file);
  });

  handle("confui:previewRestoreBackup", async (_event, root: unknown, file: unknown, expectedVersion: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
    if (!isFileVersion(expectedVersion)) throw new ConfuiError("INVALID_INPUT", "文件版本参数无效");
    return previewRestoreBackup(root, file, expectedVersion);
  });

  handle("confui:restoreBackup", async (_event, root: unknown, preview: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    if (!isRestoreBackupPreview(preview)) throw new ConfuiError("INVALID_INPUT", "备份恢复预览无效");
    const absolutePath = (await resolveExistingProjectPath(root, preview.file)).path;
    suppressChange = { absolutePath, until: Date.now() + 2_000 };
    try {
      const result = await commitRestoreBackup(root, preview);
      suppressChange.hash = result.version.hash;
      suppressChange.until = Date.now() + 1_000;
      return result;
    } catch (error) {
      suppressChange = undefined;
      throw error;
    }
  });

  handle("confui:createFromExample", async (_event, root: unknown, exampleFile: unknown, targetFile?: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(exampleFile, "示例模板路径", MAX_CONFIG_PATH_CHARS);
    assertOptionalString(targetFile, "目标配置文件路径", MAX_CONFIG_PATH_CHARS);
    return createConfigFromExample(root, exampleFile, targetFile);
  });

  handle("confui:compareConfigs", async (_event, root: unknown, sourceFile: unknown, targetFile: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(sourceFile, "源配置文件路径", MAX_CONFIG_PATH_CHARS);
    assertString(targetFile, "目标配置文件路径", MAX_CONFIG_PATH_CHARS);
    return compareConfigFiles(root, sourceFile, targetFile);
  });

  handle(
    "confui:previewSyncConfig",
    async (
      _event,
      root: unknown,
      sourceFile: unknown,
      targetFile: unknown,
      selectedSegments: unknown,
      expectedTargetVersion: unknown,
    ) => {
      assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
      assertString(sourceFile, "源配置文件路径", MAX_CONFIG_PATH_CHARS);
      assertString(targetFile, "目标配置文件路径", MAX_CONFIG_PATH_CHARS);
      if (!isPathSegmentList(selectedSegments) || !isFileVersion(expectedTargetVersion)) {
        throw new ConfuiError("INVALID_INPUT", "配置补齐参数无效");
      }
      return previewSyncFromFile(root, sourceFile, targetFile, selectedSegments, expectedTargetVersion);
    },
  );

  handle("confui:previewRedactedExport", async (_event, root: unknown, file: unknown, secretPaths?: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
    const paths = secretPaths === undefined ? [] : parseOptionalSecretPaths(secretPaths);
    return generateRedactedExport(root, file, paths);
  });

  handle("confui:saveRedactedExport", async (_event, root: unknown, file: unknown, secretPaths?: unknown) => {
    assertString(root, "项目路径", MAX_PROJECT_PATH_CHARS);
    assertString(file, "配置文件路径", MAX_CONFIG_PATH_CHARS);
    const paths = secretPaths === undefined ? [] : parseOptionalSecretPaths(secretPaths);
    const resolved = await resolveExistingProjectPath(root, file);
    const preview = await generateRedactedExport(root, file, paths);
    const isEn = currentLocale === "en-US";
    const saveOptions = {
      title: isEn ? "Export Redacted Copy" : "导出脱敏副本",
      defaultPath: join(dirname(resolved.path), preview.suggestedFileName),
      buttonLabel: isEn ? "Export" : "导出",
    };
    const chosen = mainWindow
      ? await dialog.showSaveDialog(mainWindow, saveOptions)
      : await dialog.showSaveDialog(saveOptions);
    if (chosen.canceled || !chosen.filePath) {
      return { savedPath: null, redactedCount: preview.redactedCount };
    }
    await writeRedactedExportToChosenPath(chosen.filePath, resolved.path, preview.content);
    return { savedPath: chosen.filePath, redactedCount: preview.redactedCount };
  });

  handle("confui:getSettings", async () => settingsStore.loadForRenderer());

  handle("confui:setSettings", async (_event, settings: unknown) => {
    if (!isAppSettings(settings)) throw new ConfuiError("INVALID_INPUT", "设置内容无效");
    const saved = await settingsStore.saveFromRenderer(settings);
    currentLocale = saved.locale;
    applyNativeTheme(saved.theme);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(resolveWindowBackground(saved.theme));
    }
    return saved;
  });

  handle("confui:removeRecentProject", async (_event, projectPath: unknown) => {
    assertString(projectPath, "项目路径", MAX_PROJECT_PATH_CHARS);
    return settingsStore.removeRecentProject(projectPath);
  });

  handle("confui:testAI", async (_event, settings: unknown) => {
    if (!isTestAIRequest(settings)) throw new ConfuiError("INVALID_INPUT", "AI 设置内容无效");
    let effectiveApiKey = settings.apiKey;
    if (!effectiveApiKey && settings.useStoredApiKey === true) {
      const stored = await settingsStore.load();
      if (stored.ai.provider === settings.provider) {
        effectiveApiKey = stored.ai.apiKey;
      }
    }
    return testAIConnection({
      enabled: settings.enabled,
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: effectiveApiKey,
      timeoutMs: settings.timeoutMs,
    });
  });

  handle("confui:getAppInfo", async () => ({ version: app.getVersion() }));

  handle("confui:checkForUpdates", async () => {
    const result = await checkForUpdates(app.getVersion());
    lastVerifiedReleasePage = result.releaseUrl;
    return result;
  });

  handle("confui:openReleasePage", async () => {
    await shell.openExternal(lastVerifiedReleasePage);
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
      if (!isTrustedSender(event)) {
        throw new ConfuiError("INVALID_INPUT", "未授权的 IPC 请求来源");
      }
      return { ok: true, data: await action(event, ...(args as never[])) };
    } catch (error) {
      return { ok: false, error: toAppError(error) };
    }
  });
}

async function withFieldAssistSlot<T>(operation: () => Promise<T>, locale: Locale = currentLocale): Promise<T> {
  if (fieldAssistInFlight >= MAX_FIELD_ASSIST_CONCURRENCY) {
    throw new ConfuiError(
      "AI_ERROR",
      locale === "en-US"
        ? "Other field explanations are in progress; please try again shortly"
        : "当前正在处理其他字段的 AI 解读，请稍后再试",
    );
  }
  fieldAssistInFlight += 1;
  try {
    return await operation();
  } finally {
    fieldAssistInFlight -= 1;
  }
}

function watchConfigFile(projectRoot: string, absolutePath: string, relativeFile: string): void {
  if (watchedFile?.absolutePath === absolutePath && watchedFile.projectRoot === projectRoot) return;
  closeWatcher();
  try {
    const targetName = basename(absolutePath).toLowerCase();
    // Watch the containing directory rather than the file itself. Editors and
    // Confui both use atomic rename-on-save, which invalidates file-level
    // watchers on Windows after the first replacement.
    const watcher = watch(dirname(absolutePath), { persistent: false }, (_eventType, filename) => {
      if (filename && filename.toString().toLowerCase() !== targetName) return;
      if (watcherTimer) clearTimeout(watcherTimer);
      watcherTimer = setTimeout(() => void emitFileChange(projectRoot, absolutePath, relativeFile), 140);
    });
    watcher.on("error", () => {
      if (watchedFile?.watcher !== watcher) return;
      closeWatcher();
      // Treat a broken watcher as an external change. The user can then
      // reload after restoring the directory or file instead of losing the
      // notification silently (or crashing the main process).
      const event: FileChangedEvent = { projectRoot, file: relativeFile.replace(/\\/g, "/") };
      mainWindow?.webContents.send("confui:fileChanged", event);
    });
    watchedFile = { watcher, projectRoot, absolutePath, relativePath: relativeFile };
  } catch {
    // Watching is a convenience; opening the file still works if the platform refuses it.
  }
}

async function emitFileChange(projectRoot: string, absolutePath: string, relativeFile: string): Promise<void> {
  if (watchedFile?.absolutePath !== absolutePath || watchedFile.projectRoot !== projectRoot) return;
  let version: FileVersion | undefined;
  try {
    version = await currentVersion(absolutePath);
  } catch {
    // A rename-save from another editor can make the file briefly unavailable.
  }
  if (watchedFile?.absolutePath !== absolutePath || watchedFile.projectRoot !== projectRoot) return;
  const suppression = suppressChange;
  if (suppression?.absolutePath === absolutePath && Date.now() <= suppression.until) {
    if (!suppression.hash || suppression.hash === version?.hash) return;
  }
  suppressChange = undefined;
  const event: FileChangedEvent = { projectRoot, file: relativeFile.replace(/\\/g, "/"), version };
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
      // `undefined` keeps the stored ciphertext alive — see SecretCodec.decode.
      if (!safeStorage.isEncryptionAvailable()) return undefined;
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(7), "base64"));
      } catch {
        return undefined;
      }
    },
  };
}

function assertString(value: unknown, label: string, maxLength = MAX_PROJECT_PATH_CHARS): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new ConfuiError("INVALID_INPUT", `${label}不能为空`);
  if (value.length > maxLength || value.includes("\0")) throw new ConfuiError("INVALID_INPUT", `${label}无效`);
}

function assertOptionalString(value: unknown, label: string, maxLength: number): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length > maxLength || value.includes("\0"))) {
    throw new ConfuiError("INVALID_INPUT", `${label}无效`);
  }
}

function isFileVersion(value: unknown): value is FileVersion {
  return value !== null && typeof value === "object"
    && typeof (value as FileVersion).hash === "string"
    && /^[0-9a-f]{64}$/i.test((value as FileVersion).hash)
    && typeof (value as FileVersion).mtimeMs === "number"
    && Number.isFinite((value as FileVersion).mtimeMs)
    && (value as FileVersion).mtimeMs >= 0
    && typeof (value as FileVersion).size === "number"
    && Number.isSafeInteger((value as FileVersion).size)
    && (value as FileVersion).size >= 0;
}

function isSavePreview(value: unknown): value is SavePreview {
  if (value === null || typeof value !== "object") return false;
  const preview = value as SavePreview;
  return boundedString(preview.projectRoot, MAX_PROJECT_PATH_CHARS)
    && boundedString(preview.file, MAX_CONFIG_PATH_CHARS)
    && typeof preview.format === "string"
    && SUPPORTED_FORMATS.has(preview.format)
    && boundedString(preview.output, HARD_FILE_LIMIT)
    && Array.isArray(preview.changes)
    && preview.changes.length <= MAX_SAVE_OPERATIONS
    && Array.isArray(preview.operations)
    && preview.operations.length <= MAX_SAVE_OPERATIONS
    && isFileVersion(preview.expectedVersion);
}

function isRestoreBackupPreview(value: unknown): value is RestoreBackupPreview {
  if (value === null || typeof value !== "object") return false;
  const preview = value as RestoreBackupPreview;
  return boundedString(preview.projectRoot, MAX_PROJECT_PATH_CHARS)
    && boundedString(preview.file, MAX_CONFIG_PATH_CHARS)
    && typeof preview.format === "string"
    && SUPPORTED_FORMATS.has(preview.format)
    && boundedString(preview.currentText, HARD_FILE_LIMIT)
    && boundedString(preview.backupText, HARD_FILE_LIMIT)
    && isFileVersion(preview.expectedVersion)
    && isFileVersion(preview.backupVersion)
    && typeof preview.backupModifiedAt === "number"
    && Number.isFinite(preview.backupModifiedAt);
}

function isAiSettings(value: unknown): value is AppSettings["ai"] {
  return value !== null && typeof value === "object"
    && typeof (value as AppSettings["ai"]).enabled === "boolean"
    && boundedString((value as AppSettings["ai"]).provider, 80)
    && boundedString((value as AppSettings["ai"]).model, 200)
    && boundedString((value as AppSettings["ai"]).baseUrl, 2_000)
    && boundedString((value as AppSettings["ai"]).apiKey, 24_000)
    && typeof (value as AppSettings["ai"]).timeoutMs === "number"
    && Number.isFinite((value as AppSettings["ai"]).timeoutMs);
}

function isTestAIRequest(value: unknown): value is TestAIRequest {
  if (!isAiSettings(value)) return false;
  const flag = (value as TestAIRequest).useStoredApiKey;
  return flag === undefined || typeof flag === "boolean";
}

function isAppSettings(value: unknown): value is AppSettings {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as AppSettings;
  if (candidate.clearSecrets !== undefined) {
    if (candidate.clearSecrets === null || typeof candidate.clearSecrets !== "object") return false;
    if (candidate.clearSecrets.apiKey !== undefined && typeof candidate.clearSecrets.apiKey !== "boolean") return false;
    if (candidate.clearSecrets.githubToken !== undefined && typeof candidate.clearSecrets.githubToken !== "boolean") return false;
  }
  return isAiSettings(candidate.ai)
    && candidate.github !== null
    && typeof candidate.github === "object"
    && boundedString(candidate.github.token, 24_000)
    && Array.isArray(candidate.recentProjects)
    && candidate.recentProjects.length <= MAX_RECENT_PROJECTS;
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && !value.includes("\0");
}

function isFieldAssistField(value: unknown): value is FieldAssistField {
  if (value === null || typeof value !== "object" || !Array.isArray((value as FieldAssistField).segments)) return false;
  const field = value as FieldAssistField;
  if (field.segments.length < 1 || field.segments.length > 32) return false;
  if (!field.segments.every(isSafeAssistSegment)) return false;
  if (!boundedString(field.label, 300) || !FIELD_TYPES.has(field.type)) return false;
  if (field.description !== undefined && !boundedString(field.description, 1_200)) return false;
  if (field.placeholder !== undefined && !boundedString(field.placeholder, 500)) return false;
  if (field.group !== undefined && !boundedString(field.group, 300)) return false;
  if (field.required !== undefined && typeof field.required !== "boolean") return false;
  if (field.secret !== undefined && typeof field.secret !== "boolean") return false;
  if (field.enum !== undefined && (!Array.isArray(field.enum) || field.enum.length > 100
    || !field.enum.every((item) => typeof item === "string" && item.length <= 500 && !item.includes("\0")
      || typeof item === "number" && Number.isFinite(item)))) return false;
  return [field.minimum, field.maximum, field.minLength, field.maxLength]
    .every((item) => item === undefined || typeof item === "number" && Number.isFinite(item));
}

const FIELD_TYPES = new Set<FieldType>([
  "string", "number", "integer", "boolean", "enum", "secret", "color", "array", "json",
]);

function isSafeAssistSegment(segment: unknown): segment is string | number {
  return typeof segment === "number"
    ? Number.isSafeInteger(segment) && segment >= 0
    : typeof segment === "string"
      && segment.length <= 512
      && !segment.includes("\0")
      && !isForbiddenKey(segment);
}

function isPathSegmentList(value: unknown): value is PathSegment[][] {
  return Array.isArray(value)
    && value.length <= MAX_SAVE_OPERATIONS
    && value.every(
      (item) => Array.isArray(item) && item.length >= 1 && item.length <= 32 && item.every(isSafeAssistSegment),
    );
}

function parseOptionalSecretPaths(value: unknown): PathSegment[][] {
  if (!isPathSegmentList(value)) {
    throw new ConfuiError("INVALID_INPUT", "敏感字段路径列表无效");
  }
  return value;
}
