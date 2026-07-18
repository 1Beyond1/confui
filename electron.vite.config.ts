import { defineConfig } from "electron-vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      lib: { entry: "electron/main.ts" },
      rollupOptions: { external: ["electron"] },
    },
  },
  preload: {
    build: {
      // Sandboxed Electron preload scripts execute as CommonJS even when the
      // application package itself is ESM.
      lib: { entry: "electron/preload.ts", formats: ["cjs"] },
      rollupOptions: { external: ["electron"] },
    },
  },
  renderer: {
    root: "web",
    build: {
      rollupOptions: { input: { index: resolve("web/index.html") } },
    },
    plugins: [preact()],
    server: { port: 5173 },
  },
});
