export interface ConfuiAPI {
  selectFolder: () => Promise<string | null>;
  scanProject: (root: string) => Promise<{ files: any[] } | { error: string }>;
  inferSchema: (root: string, file: string, options?: { readme?: string }) => Promise<any>;
  readFile: (root: string, file: string) => Promise<{ text: string } | { error: string }>;
  saveConfig: (root: string, file: string, value: unknown) => Promise<{ ok: boolean } | { error: string }>;
  getSettings: () => Promise<any>;
  setSettings: (settings: unknown) => Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    confui: ConfuiAPI;
  }
}
