import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings } from "../../shared/schema.ts";
import { DEFAULT_SETTINGS } from "../../shared/schema.ts";

const SETTINGS_DIR = join(
  process.env.APPDATA || process.env.USERPROFILE || process.env.HOME || ".",
  "easy_json"
);
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

export async function loadSettings(): Promise<AppSettings> {
  try {
    const txt = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(txt) as Partial<AppSettings>;
    return {
      ai: { ...DEFAULT_SETTINGS.ai, ...(parsed.ai ?? {}) },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(s, null, 2), "utf8");
}

export { SETTINGS_PATH };
