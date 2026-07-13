import Fastify from "fastify";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { scanProject } from "./scanner.ts";
import { inferSchema } from "./schema/infer.ts";
import { loadSettings, saveSettings } from "./config.ts";
import { createProvider } from "./ai/provider.ts";
import type { AppSettings, ConfigFile } from "../../shared/schema.ts";

const PORT = Number(process.env.PORT) || 7321;
const app = Fastify({ logger: true });

/** Resolve `file` under `root`, rejecting path traversal. */
function safeJoin(root: string, file: string): string {
  const realRoot = resolve(root);
  const joined = resolve(realRoot, file);
  if (joined !== realRoot && !joined.startsWith(realRoot + sep)) {
    throw new Error("path traversal rejected");
  }
  return joined;
}

app.get("/api/health", async () => ({ ok: true, service: "Confui" }));

/** Scan a project folder for JSON config files. */
app.post("/api/scan", async (req, reply) => {
  const { root } = (req.body ?? {}) as { root?: string };
  if (!root) return reply.code(400).send({ error: "root required" });
  try {
    const files = await scanProject(root);
    return { root, files };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

/** Infer a form schema for one config file. */
app.post("/api/infer", async (req, reply) => {
  const { root, file, readme } = (req.body ?? {}) as {
    root?: string;
    file?: string;
    readme?: string;
  };
  if (!root || !file) return reply.code(400).send({ error: "root and file required" });
  try {
    const settings = await loadSettings();
    const ai =
      settings.ai.enabled && settings.ai.apiKey
        ? createProvider(settings.ai)
        : undefined;
    const absPath = safeJoin(root, file);
    const cfg: ConfigFile = { path: file, absPath, kind: file, size: 0 };
    const schema = await inferSchema(cfg, {
      ai,
      aiModel: settings.ai.model,
      readme,
    });
    return schema;
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

/** Read raw file (for the editor / fallback). */
app.post("/api/read", async (req, reply) => {
  const { root, file } = (req.body ?? {}) as { root?: string; file?: string };
  if (!root || !file) return reply.code(400).send({ error: "root and file required" });
  try {
    const text = await readFile(safeJoin(root, file), "utf8");
    return { text };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

/** Save a (partial) value back to the config file, merging into existing JSON. */
app.post("/api/save", async (req, reply) => {
  const { root, file, value } = (req.body ?? {}) as {
    root?: string;
    file?: string;
    value?: unknown;
  };
  if (!root || !file) return reply.code(400).send({ error: "root and file required" });
  try {
    const absPath = safeJoin(root, file);
    let existing: any = {};
    try {
      existing = JSON.parse(await readFile(absPath, "utf8"));
    } catch {}
    const merged = value && typeof value === "object" ? { ...existing, ...(value as object) } : value;
    await writeFile(absPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
    return { ok: true };
  } catch (e: any) {
    return reply.code(400).send({ error: e.message });
  }
});

/** Settings (incl. custom AI provider config). */
app.get("/api/settings", async () => loadSettings());
app.post("/api/settings", async (req, reply) => {
  const incoming = (req.body ?? {}) as AppSettings;
  if (!incoming?.ai) return reply.code(400).send({ error: "invalid settings" });
  await saveSettings(incoming);
  return { ok: true };
});

app
  .listen({ port: PORT, host: "127.0.0.1" })
  .then(() => app.log.info(`Confui ready: http://127.0.0.1:${PORT}`))
  .catch((e) => {
    app.log.error(e);
    process.exit(1);
  });
