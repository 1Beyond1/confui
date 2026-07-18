import type { ConfuiAPI } from "../../shared/schema.ts";

declare global {
  interface Window {
    confui: ConfuiAPI;
  }
}

export {};
