import { contextBridge, ipcRenderer } from "electron";

const api = {
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke("confui:selectFolder"),
  scanProject: (root: string) => ipcRenderer.invoke("confui:scanProject", root),
  inferSchema: (root: string, file: string, options?: { readme?: string }) =>
    ipcRenderer.invoke("confui:inferSchema", root, file, options),
  readFile: (root: string, file: string) =>
    ipcRenderer.invoke("confui:readFile", root, file),
  saveConfig: (root: string, file: string, value: unknown) =>
    ipcRenderer.invoke("confui:saveConfig", root, file, value),
  getSettings: () => ipcRenderer.invoke("confui:getSettings"),
  setSettings: (settings: unknown) =>
    ipcRenderer.invoke("confui:setSettings", settings),
};

contextBridge.exposeInMainWorld("confui", api);
