import { useEffect, useState } from "preact/hooks";
import type {
  AppSettings,
  ConfigFile,
  ConfigFormSchema,
  FieldSpec,
} from "../../shared/schema.ts";

const API = (path: string, body?: unknown) =>
  fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

export function App() {
  const [root, setRoot] = useState("");
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [active, setActive] = useState<ConfigFormSchema | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [showSettings, setShowSettings] = useState(false);

  async function scan() {
    setBusy(true); setMsg(""); setActive(null);
    try {
      const r = await API("scan", { root });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "scan failed");
      setFiles(d.files || []);
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }

  async function openFile(f: ConfigFile) {
    setBusy(true); setMsg("");
    try {
      const r = await API("infer", { root, file: f.path });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "infer failed");
      setActive(d);
      const v: Record<string, unknown> = {};
      collectDefaults(d.fields, v);
      setValues(v);
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }

  async function save() {
    if (!active) return;
    setBusy(true); setMsg("");
    try {
      const r = await API("save", { root, file: active.file, value: unflatten(values) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "save failed");
      setMsg("Saved ✓");
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }

  function setField(path: string, val: unknown) {
    setValues((s) => ({ ...s, [path]: val }));
  }

  const groups = groupBy(active?.fields ?? [], (f) => f.group || "General");

  return (
    <div style={S.page}>
      <header style={S.header}>
        <h1 style={S.logo}>easy_json</h1>
        <span style={S.sub}>auto-detect & edit JSON config via a generated form</span>
        <button style={S.btnGhost} onClick={() => setShowSettings((s) => !s)}>⚙ AI Provider</button>
      </header>

      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}

      <section style={S.scan}>
        <input
          style={S.input}
          placeholder="C:\path\to\project"
          value={root}
          onInput={(e) => setRoot((e.target as HTMLInputElement).value)}
        />
        <button style={S.btn} onClick={scan} disabled={busy || !root}>Scan</button>
      </section>

      {msg && <div style={S.msg}>{msg}</div>}

      <div style={S.cols}>
        <aside style={S.sidebar}>
          <div style={S.sidebarHdr}>Config files ({files.length})</div>
          {files.map((f) => (
            <button key={f.path} style={S.fileItem} onClick={() => openFile(f)}>
              <div style={S.fileName}>{f.path}</div>
              <div style={S.fileKind}>{f.kind} · {(f.size/1024).toFixed(1)}KB</div>
            </button>
          ))}
        </aside>

        <main style={S.main}>
          {active ? (
            <>
              <div style={S.fileHeader}>
                <h2 style={S.h2}>{active.file}</h2>
                <span style={S.badge}>{active.source}</span>
              </div>
              {Object.entries(groups).map(([g, fields]) => (
                <fieldset key={g} style={S.fieldset}>
                  <legend style={S.legend}>{g}</legend>
                  {fields.map((f) => (
                    <FieldRow key={f.path} field={f} value={values[f.path]} onChange={(v) => setField(f.path, v)} />
                  ))}
                </fieldset>
              ))}
              <button style={{ ...S.btn, ...S.save }} onClick={save} disabled={busy}>Save to {active.file}</button>
            </>
          ) : (
            <div style={S.empty}>Scan a project folder to begin.</div>
          )}
        </main>
      </div>
    </div>
  );
}

function FieldRow({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  // Recurse into objects.
  if (field.type === "object" && field.properties?.length) {
    return (
      <div style={S.nested}>
        <label style={S.label}>{field.label}</label>
        {field.properties.map((p) => (
          <FieldRow key={p.path} field={{ ...p, path: p.path }} value={value} onChange={onChange} />
        ))}
      </div>
    );
  }
  // Complex types: JSON textarea.
  if (field.type === "array" || field.type === "object" || field.type === "json") {
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return (
      <div style={S.row}>
        <label style={S.label}>{field.label} <span style={S.path}>{field.path}</span></label>
        <textarea
          style={S.textarea}
          value={text}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        />
      </div>
    );
  }
  return (
    <div style={S.row}>
      <label style={S.label}>
        {field.label} {field.required && <span style={S.req}>*</span>} <span style={S.path}>{field.path}</span>
      </label>
      {field.description && <div style={S.desc}>{field.description}</div>}
      <Widget field={field} value={value} onChange={onChange} />
    </div>
  );
}

function Widget({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const common = { style: S.input, value: value == null ? "" : String(value) };
  switch (field.type) {
    case "boolean":
      return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange((e.target as HTMLInputElement).checked)} />;
    case "enum":
      return (
        <select style={S.input} value={String(value ?? "")} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          <option value="">—</option>
          {(field.enum ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      );
    case "secret":
      return <input type="password" {...common} onInput={(e) => onChange((e.target as HTMLInputElement).value)} placeholder={field.placeholder} />;
    case "color":
      return <input type="color" value={String(value ?? "#000000")} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />;
    case "number":
    case "integer":
      return <input type="number" style={S.input} value={value == null ? "" : Number(value)} min={field.minimum} max={field.maximum} onInput={(e) => onChange((e.target as HTMLInputElement).valueAsNumber)} />;
    default:
      return <input type="text" {...common} onInput={(e) => onChange((e.target as HTMLInputElement).value)} placeholder={field.placeholder} />;
  }
}

function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState("");
  useEffect(() => { fetch("/api/settings").then((r) => r.json()).then(setS); }, []);
  async function save() {
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    setSaved("Saved ✓");
  }
  if (!s) return <div style={S.panel}>Loading…</div>;
  const a = s.ai;
  const set = (patch: Partial<AppSettings["ai"]>) => setS({ ...s, ai: { ...a, ...patch } });
  return (
    <div style={S.panel}>
      <h3 style={S.h3}>AI Provider Settings</h3>
      <p style={S.desc}>Any OpenAI-compatible endpoint works. Leave base URL empty for official OpenAI.</p>
      <label style={S.label}><input type="checkbox" checked={a.enabled} onChange={(e) => set({ enabled: e.currentTarget.checked })} /> Enable AI inference</label>
      <input style={S.input} placeholder="Display name (any)" value={a.provider} onInput={(e) => set({ provider: e.currentTarget.value })} />
      <input style={S.input} placeholder="Base URL, e.g. https://api.deepseek.com/v1 (empty = OpenAI)" value={a.baseUrl} onInput={(e) => set({ baseUrl: e.currentTarget.value })} />
      <input style={S.input} placeholder="Model, e.g. gpt-4o-mini / deepseek-chat" value={a.model} onInput={(e) => set({ model: e.currentTarget.value })} />
      <input style={S.input} type="password" placeholder="API Key" value={a.apiKey} onInput={(e) => set({ apiKey: e.currentTarget.value })} />
      <div style={{ display: "flex", gap: 8 }}>
        <button style={S.btn} onClick={save}>Save settings</button>
        <button style={S.btn} onClick={onClose}>Close</button>
        {saved && <span style={S.msg}>{saved}</span>}
      </div>
    </div>
  );
}

/* ---------- helpers ---------- */
function collectDefaults(fields: FieldSpec[], out: Record<string, unknown>) {
  for (const f of fields) {
    if (f.type === "object" && f.properties) collectDefaults(f.properties, out);
    else out[f.path] = f.value ?? f.default;
  }
}
function groupBy<T>(arr: T[], key: (t: T) => string): Record<string, T[]> {
  const r: Record<string, T[]> = {};
  for (const x of arr) (r[key(x)] ||= []).push(x);
  return r;
}
function unflatten(values: Record<string, unknown>): unknown {
  const out: any = {};
  for (const [path, raw] of Object.entries(values)) {
    let val = raw;
    // try parsing JSON-ed complex fields
    if (typeof val === "string" && (val.startsWith("{") || val.startsWith("["))) {
      try { val = JSON.parse(val); } catch {}
    }
    const parts = path.split(/\.|(?=\[\])/);
    let cur = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) cur[p] = val;
      else cur[p] = cur[p] ?? (isNaN(Number(parts[i + 1])) ? {} : []);
      cur = cur[p];
    }
  }
  return out;
}

/* ---------- placeholder styles (will be replaced by Stitch design) ---------- */
/* ---------- Stitch design system ---------- */
const S: Record<string, any> = {
  page: { fontFamily: "Inter, system-ui, sans-serif", maxWidth: "100%", margin: 0, padding: 0, color: "#1a1a2e", background: "#f8f9fa", minHeight: "100vh", display: "flex", flexDirection: "column" },
  header: { display: "flex", alignItems: "center", gap: 16, padding: "12px 24px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 },
  logo: { fontSize: 20, fontWeight: 800, color: "#2b6cb0", letterSpacing: "-0.5px" },
  sub: { color: "#64748b", fontSize: 13, flex: 1 },
  scan: { display: "flex", gap: 10, padding: "16px 24px", background: "#fff", borderBottom: "1px solid #e2e8f0", flexShrink: 0 },
  input: { padding: "10px 14px", border: "1px solid #cbd5e1", borderRadius: 8, fontSize: 14, width: "100%", boxSizing: "border-box" as const, outline: "none", background: "#fff" },
  btn: { padding: "10px 18px", border: "none", background: "#2b6cb0", color: "#fff", borderRadius: 8, cursor: "pointer", fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" },
  btnGhost: { padding: "8px 14px", border: "1px solid #cbd5e1", background: "transparent", color: "#475569", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 500 },
  save: { marginTop: 20 },
  cols: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: { width: 300, flexShrink: 0, background: "#fff", borderRight: "1px solid #e2e8f0", overflowY: "auto" as const, display: "flex", flexDirection: "column" },
  sidebarHdr: { padding: "14px 20px", borderBottom: "1px solid #e2e8f0", fontSize: 13, fontWeight: 700, color: "#475569", textTransform: "uppercase" as const, letterSpacing: "0.5px" },
  fileItem: { display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", textAlign: "left" as const, padding: "12px 20px", border: "none", borderBottom: "1px solid #f1f5f9", background: "transparent", cursor: "pointer", fontSize: 13 },
  fileName: { fontSize: 13, fontWeight: 600, color: "#1a1a2e", marginBottom: 2 },
  fileKind: { fontSize: 11, color: "#94a3b8" },
  fileSize: { fontSize: 11, color: "#94a3b8", fontFamily: "monospace" },
  main: { flex: 1, overflowY: "auto" as const, padding: 24, background: "#f8f9fa" },
  h2: { margin: "0 0 6px", fontSize: 20, fontWeight: 700, color: "#1a1a2e" },
  h3: { margin: "0 0 12px", fontSize: 14, fontWeight: 700, color: "#475569" },
  badge: { fontSize: 11, background: "#dbeafe", color: "#1e40af", padding: "3px 10px", borderRadius: 12, fontWeight: 600 },
  fileHeader: { display: "flex", alignItems: "center", gap: 10, marginBottom: 20 },
  fieldset: { border: "1px solid #e2e8f0", borderRadius: 10, padding: 20, marginBottom: 16, background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  legend: { fontWeight: 700, padding: "0 0 12px 0", fontSize: 14, color: "#2b6cb0", border: "none", width: "100%" as any, borderBottom: "1px solid #e2e8f0", marginBottom: 16, display: "block" },
  row: { marginBottom: 16 },
  nested: { marginBottom: 16, paddingLeft: 16, borderLeft: "2px solid #e2e8f0" },
  label: { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 5 },
  desc: { fontSize: 12, color: "#94a3b8", marginBottom: 6, lineHeight: "1.4" },
  path: { fontSize: 11, color: "#94a3b8", fontWeight: 400, marginLeft: 6 },
  req: { color: "#ef4444", marginLeft: 2 },
  textarea: { width: "100%", minHeight: 80, padding: "10px 14px", border: "1px solid #cbd5e1", borderRadius: 8, fontFamily: "monospace", fontSize: 13, boxSizing: "border-box" as const, background: "#f8fafc", outline: "none" },
  empty: { color: "#94a3b8", padding: 60, textAlign: "center" as const, fontSize: 14 },
  msg: { color: "#2b6cb0", fontSize: 13, padding: "8px 0" },
  panel: { background: "#fff", border: "1px solid #e2e8f0", borderRadius: 12, padding: 24, margin: "16px 24px", boxShadow: "0 1px 3px rgba(0,0,0,0.04)" },
  toggle: { display: "flex", alignItems: "center", gap: 10, marginBottom: 16 },
  toggleLabel: { fontSize: 14, fontWeight: 600, color: "#334155" },
  divider: { border: "none", borderTop: "1px solid #e2e8f0", margin: "16px 0" },
};
