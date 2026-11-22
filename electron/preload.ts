import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSettings,
  ConfigChange,
  ConfuiAPI,
  FileChangedEvent,
  FieldAssistField,
  FileVersion,
  InferOptions,
  SavePreview,
  TestAIRequest,
} from "../shared/schema.ts";

const api: ConfuiAPI = {
  selectFolder: () => ipcRenderer.invoke("confui:selectFolder"),
  scanProject: (root: string, githubUrl?: string) => ipcRenderer.invoke("confui:scanProject", root, githubUrl),
  inferSchema: (root: string, file: string, options?: InferOptions) =>
    ipcRenderer.invoke("confui:inferSchema", root, file, options),
  explainField: (root: string, file: string, field: FieldAssistField, githubUrl?: string) =>
    ipcRenderer.invoke("confui:explainField", root, file, field, githubUrl),
  previewSave: (root: string, file: string, changes: ConfigChange[], expectedVersion: FileVersion) =>
    ipcRenderer.invoke("confui:previewSave", root, file, changes, expectedVersion),
  saveConfig: (root: string, preview: SavePreview) =>
    ipcRenderer.invoke("confui:saveConfig", root, preview),
  getSettings: () => ipcRenderer.invoke("confui:getSettings"),
  setSettings: (settings: AppSettings) => ipcRenderer.invoke("confui:setSettings", settings),
  removeRecentProject: (projectPath: string) => ipcRenderer.invoke("confui:removeRecentProject", projectPath),
  testAI: (settings: TestAIRequest) => ipcRenderer.invoke("confui:testAI", settings),
  getAppInfo: () => ipcRenderer.invoke("confui:getAppInfo"),
  checkForUpdates: () => ipcRenderer.invoke("confui:checkForUpdates"),
  openReleasePage: () => ipcRenderer.invoke("confui:openReleasePage"),
  setDirtyState: (dirty: boolean) => ipcRenderer.send("confui:setDirtyState", dirty),
  stopWatching: () => ipcRenderer.send("confui:stopWatching"),
  onFileChanged: (callback: (event: FileChangedEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FileChangedEvent) => callback(payload);
    ipcRenderer.on("confui:fileChanged", listener);
    return () => ipcRenderer.removeListener("confui:fileChanged", listener);
  },
};

contextBridge.exposeInMainWorld("confui", Object.freeze(api));
