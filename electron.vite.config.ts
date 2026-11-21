import { defineConfig } from "electron-vite";
import preact from "@preact/preset-vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      lib: { entry: "electron/main.ts" },
      // The portable package intentionally contains only `out/` and the
      // Electron runtime. Bundle runtime dependencies into the main process
      // instead of leaving imports that would require a shipped node_modules
      // directory (and make the Windows build needlessly large).
      externalizeDeps: false,
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
    plugins: [
      preact(),
      {
        name: "confui-prod-csp",
        apply: "build",
        transformIndexHtml(html) {
          return html.replace("connect-src 'self' ws:;", "connect-src 'self';");
        },
      },
    ],
    server: { port: 5173 },
  },
});
