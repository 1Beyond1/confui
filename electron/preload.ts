import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppSettings,
  CompareConfigOptions,
  ConfigChange,
  ConfuiAPI,
  FileChangedEvent,
  FieldAssistField,
  FileVersion,
  InferOptions,
  Locale,
  PathSegment,
  ProjectDiagnosticsOptions,
  ProjectSearchOptions,
  RedactedExportOptions,
  RestoreBackupPreview,
  SavePreview,
  TestAIRequest,
} from "../shared/schema.ts";

const api: ConfuiAPI = {
  selectFolder: () => ipcRenderer.invoke("confui:selectFolder"),
  scanProject: (root: string, githubUrl?: string) => ipcRenderer.invoke("confui:scanProject", root, githubUrl),
  inferSchema: (root: string, file: string, options?: InferOptions) =>
    ipcRenderer.invoke("confui:inferSchema", root, file, options),
  explainField: (root: string, file: string, field: FieldAssistField, githubUrl?: string, locale?: Locale, documentIndex?: number) =>
    ipcRenderer.invoke("confui:explainField", root, file, field, githubUrl, locale, documentIndex),
  previewSave: (root: string, file: string, changes: ConfigChange[], expectedVersion: FileVersion, documentIndex?: number) =>
    ipcRenderer.invoke("confui:previewSave", root, file, changes, expectedVersion, documentIndex),
  saveConfig: (root: string, preview: SavePreview) =>
    ipcRenderer.invoke("confui:saveConfig", root, preview),
  getBackupStatus: (root: string, file: string) =>
    ipcRenderer.invoke("confui:getBackupStatus", root, file),
  previewRestoreBackup: (root: string, file: string, expectedVersion: FileVersion) =>
    ipcRenderer.invoke("confui:previewRestoreBackup", root, file, expectedVersion),
  restoreBackup: (root: string, preview: RestoreBackupPreview) =>
    ipcRenderer.invoke("confui:restoreBackup", root, preview),
  createFromExample: (root: string, exampleFile: string, targetFile?: string) =>
    ipcRenderer.invoke("confui:createFromExample", root, exampleFile, targetFile),
  compareConfigs: (root: string, sourceFile: string, targetFile: string, options?: CompareConfigOptions) =>
    ipcRenderer.invoke("confui:compareConfigs", root, sourceFile, targetFile, options),
  previewSyncConfig: (
    root: string,
    sourceFile: string,
    targetFile: string,
    selectedSegments: PathSegment[][],
    expectedTargetVersion: FileVersion,
    options?: CompareConfigOptions,
  ) => ipcRenderer.invoke("confui:previewSyncConfig", root, sourceFile, targetFile, selectedSegments, expectedTargetVersion, options),
  previewRedactedExport: (root: string, file: string, secretPaths?: PathSegment[][], options?: RedactedExportOptions) =>
    ipcRenderer.invoke("confui:previewRedactedExport", root, file, secretPaths, options),
  saveRedactedExport: (root: string, file: string, secretPaths?: PathSegment[][], options?: RedactedExportOptions) =>
    ipcRenderer.invoke("confui:saveRedactedExport", root, file, secretPaths, options),
  searchProject: (root: string, query: string, options?: ProjectSearchOptions) =>
    ipcRenderer.invoke("confui:searchProject", root, query, options),
  diagnoseProject: (root: string, options?: ProjectDiagnosticsOptions) =>
    ipcRenderer.invoke("confui:diagnoseProject", root, options),
  listSnapshots: (root: string, file?: string) =>
    ipcRenderer.invoke("confui:listSnapshots", root, file),
  saveSnapshot: (root: string, file: string, label: string) =>
    ipcRenderer.invoke("confui:saveSnapshot", root, file, label),
  previewSnapshotRestore: (root: string, file: string, snapshotId: string, expectedVersion: FileVersion) =>
    ipcRenderer.invoke("confui:previewSnapshotRestore", root, file, snapshotId, expectedVersion),
  deleteSnapshot: (root: string, snapshotId: string) =>
    ipcRenderer.invoke("confui:deleteSnapshot", root, snapshotId),
  getSettings: () => ipcRenderer.invoke("confui:getSettings"),
  setSettings: (settings: AppSettings) => ipcRenderer.invoke("confui:setSettings", settings),
  removeRecentProject: (projectPath: string) => ipcRenderer.invoke("confui:removeRecentProject", projectPath),
  testAI: (settings: TestAIRequest) => ipcRenderer.invoke("confui:testAI", settings),
  getAppInfo: () => ipcRenderer.invoke("confui:getAppInfo"),
  checkForUpdates: () => ipcRenderer.invoke("confui:checkForUpdates"),
  openReleasePage: () => ipcRenderer.invoke("confui:openReleasePage"),
  setDirtyState: (dirty: boolean) => ipcRenderer.send("confui:setDirtyState", dirty),
  stopWatching: () => ipcRenderer.send("confui:stopWatching"),
  cancelDiagnostics: () => ipcRenderer.send("confui:cancelDiagnostics"),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  onFileChanged: (callback: (event: FileChangedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FileChangedEvent) => callback(payload);
    ipcRenderer.on("confui:fileChanged", listener);
    return () => ipcRenderer.removeListener("confui:fileChanged", listener);
  },
};

contextBridge.exposeInMainWorld("confui", Object.freeze(api));
