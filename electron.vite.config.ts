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
      lib: { entry: "electron/preload.ts" },
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
