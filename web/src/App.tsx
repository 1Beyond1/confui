import { useState, useEffect } from "preact/hooks";
import type {
  AppSettings,
  ConfigFile,
  ConfigFormSchema,
  FieldSpec,
} from "../../shared/schema.ts";

/* ================================================================
 * Confui — Design System (原版 Stitch 风格)
 * 有侧边栏 · 卡片层次 · 微妙阴影 · 专业开发者工具感
 * ================================================================ */

const C = {
  // Colors
  primary: "#0052CC",
  primaryHover: "#0747A6",
  primaryLight: "#DEEBFF",
  surface: "#FFFFFF",
  bg: "#F4F5F7",
  text: "#172B4D",
  textSec: "#6B778C",
  textTer: "#97A0AF",
  border: "#DFE1E6",
  borderLight: "#EBECF0",
  error: "#DE350B",
  success: "#16C456",
  warn: "#FF9500",
  // Shadows
  shadowSm: "0 1px 3px rgba(0,0,0,0.08)",
  shadowMd: "0 4px 12px rgba(0,0,0,0.08)",
  // Radii
  r: "6px",
  rLg: "10px",
  rXl: "14px",
  // Source badge colors
  srcColor: (s?: string) => {
    const m: Record<string, string> = {
      "json-schema": "#0052CC", "known-template": "#16C456", "example": "#FF9500",
      "readme": "#985FFB", "ai": "#DE350B", "heuristic": "#97A0AF",
    };
    return m[s || ""] || "#97A0AF";
  },
};

const S: Record<string, any> = {
  app: { display: "flex", height: "100vh", fontFamily: "Inter, system-ui, sans-serif", fontSize: 14, color: C.text, background: C.bg, overflow: "hidden" },
  // Sidebar
  sidebar: { width: 280, flexShrink: 0, background: C.surface, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", overflow: "hidden" },
  sidebarBrand: { padding: "20px 20px 16px", borderBottom: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", gap: 10 },
  brandIcon: { width: 32, height: 32, borderRadius: 8, background: C.primary, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 16 },
  brandName: { fontSize: 16, fontWeight: 700, color: C.text },
  brandSub: { fontSize: 11, color: C.textTer, marginTop: 1 },
  sidebarScan: { padding: "12px 16px", borderBottom: `1px solid ${C.borderLight}`, display: "flex", gap: 8 },
  sidebarList: { flex: 1, overflowY: "auto", padding: "8px 0" },
  sidebarSection: { padding: "8px 16px 4px", fontSize: 11, fontWeight: 700, color: C.textTer, textTransform: "uppercase", letterSpacing: "0.5px" },
  fileItem: { display: "flex", alignItems: "center", gap: 10, padding: "8px 16px", cursor: "pointer", borderLeft: "3px solid transparent", transition: "background 0.1s" },
  fileItemActive: { background: C.primaryLight, borderLeftColor: C.primary },
  fileIcon: { width: 28, height: 28, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 },
  fileInfo: { flex: 1, minWidth: 0 },
  fileName: { fontSize: 13, fontWeight: 500, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  fileMeta: { fontSize: 11, color: C.textTer },
  sidebarFooter: { padding: 12, borderTop: `1px solid ${C.borderLight}` },
  // Main
  main: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  topbar: { height: 56, flexShrink: 0, background: C.surface, borderBottom: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 24px" },
  topbarTitle: { fontSize: 15, fontWeight: 600, color: C.text },
  topbarActions: { display: "flex", gap: 8, alignItems: "center" },
  content: { flex: 1, overflowY: "auto", padding: 24 },
  // Inputs
  input: { padding: "8px 12px", border: `1px solid ${C.border}`, borderRadius: C.r, fontSize: 13, width: "100%", boxSizing: "border-box", outline: "none", background: C.surface, color: C.text, transition: "border-color 0.15s" },
  btn: { padding: "8px 16px", border: "none", background: C.primary, color: "#fff", borderRadius: C.r, cursor: "pointer", fontSize: 13, fontWeight: 600, transition: "background 0.15s", whiteSpace: "nowrap" },
  btnGhost: { padding: "8px 16px", border: `1px solid ${C.border}`, background: "transparent", color: C.textSec, borderRadius: C.r, cursor: "pointer", fontSize: 13, fontWeight: 500, transition: "all 0.15s" },
  btnSm: { padding: "4px 10px", border: "none", background: C.primaryLight, color: C.primaryHover, borderRadius: C.r, cursor: "pointer", fontSize: 12, fontWeight: 600 },
  // Cards
  card: { background: C.surface, borderRadius: C.rXl, border: `1px solid ${C.border}`, boxShadow: C.shadowSm, overflow: "hidden", marginBottom: 16 },
  cardHeader: { padding: "14px 20px", borderBottom: `1px solid ${C.borderLight}`, display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 700, color: C.text },
  cardBody: { padding: 20 },
  // Form
  field: { marginBottom: 18 },
  label: { display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 5 },
  desc: { fontSize: 12, color: C.textSec, marginBottom: 6, lineHeight: 1.5 },
  badge: { fontSize: 10, padding: "2px 8px", borderRadius: 10, fontWeight: 600, display: "inline-block" },
  badgeReq: { color: C.error, fontSize: 12 },
  // Empty state
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: C.textTer },
  emptyIcon: { fontSize: 48, marginBottom: 16, opacity: 0.4 },
  // Settings
  toggle: { width: 40, height: 22, borderRadius: 11, background: C.border, cursor: "pointer", position: "relative", transition: "background 0.2s", flexShrink: 0 },
  toggleOn: { background: C.primary },
  toggleKnob: { width: 18, height: 18, borderRadius: "50%", background: "#fff", position: "absolute", top: 2, left: 2, transition: "left 0.2s", boxShadow: C.shadowSm },
  // Loading
  loading: { display: "flex", alignItems: "center", gap: 8, color: C.textSec, fontSize: 13 },
  spinner: { width: 16, height: 16, border: `2px solid ${C.borderLight}`, borderTopColor: C.primary, borderRadius: "50%", animation: "spin 0.8s linear infinite" },
};

/* ================================================================ * Main App
 * ================================================================ */

export function App() {
  const [root, setRoot] = useState("");
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [active, setActive] = useState<ConfigFormSchema | null>(null);
  const [activeFile, setActiveFile] = useState<ConfigFile | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [view, setView] = useState<"main" | "settings">("main");
  const [dirty, setDirty] = useState(false);
  const [fileChanged, setFileChanged] = useState(false);

  useEffect(() => {
    window.confui.onFileChanged(() => {
      setFileChanged(true);
    });
  }, []);

  async function reloadFile() {
    setFileChanged(false);
    if (activeFile) await openFile(activeFile);
  }

  async function browse() {
    const f = await window.confui.selectFolder();
    if (f) setRoot(f);
  }

  async function scan() {
    setBusy(true); setMsg(""); setActive(null); setDirty(false);
    try {
      const r: any = await window.confui.scanProject(root);
      if (r.error) throw new Error(r.error);
      setFiles(r.files || []);
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }

  async function openFile(f: ConfigFile) {
    if (dirty && !confirm("You have unsaved changes. Switch file?")) return;
    setBusy(true); setMsg(""); setView("main");
    try {
      const r: any = await window.confui.inferSchema(root, f.path);
      if (r.error) throw new Error(r.error);
      setActive(r); setActiveFile(f);
      const v: Record<string, unknown> = {};
      collectDefaults(r.fields, v);
      setValues(v); setDirty(false);
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }

  async function save() {
    if (!active) return;
    setBusy(true); setMsg("");
    try {
      const r: any = await window.confui.saveConfig(root, active.file, unflatten(values));
      if (r.error) throw new Error(r.error);
      setMsg("Saved"); setDirty(false);
    } catch (e: any) { setMsg(e.message); }
    setBusy(false);
  }

  function setField(path: string, val: unknown) {
    setValues((s) => ({ ...s, [path]: val }));
    setDirty(true);
  }

  const groups = groupBy(active?.fields ?? [], (f) => f.group || "General");

  return (
    <div style={S.app}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* ===== Sidebar ===== */}
      <aside style={S.sidebar}>
        <div style={S.sidebarBrand}>
          <div style={S.brandIcon}>C</div>
          <div>
            <div style={S.brandName}>Confui</div>
            <div style={S.brandSub}>Config Editor</div>
          </div>
        </div>

        <div style={S.sidebarScan}>
          <input
            style={S.input}
            placeholder="Project path..."
            value={root}
            onInput={(e) => setRoot((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => { if (e.key === "Enter") scan(); }}
          />
          <button style={S.btnGhost} onClick={browse}>···</button>
          <button style={S.btn} onClick={scan} disabled={busy || !root}>Scan</button>
        </div>

        <div style={S.sidebarList}>
          {files.length > 0 && <div style={S.sidebarSection}>Config Files ({files.length})</div>}
          {files.map((f) => (
            <div
              key={f.path}
              style={{ ...S.fileItem, ...(activeFile?.path === f.path ? S.fileItemActive : {}) }}
              onClick={() => openFile(f)}
            >
              <div style={{ ...S.fileIcon, background: formatColor((f as any).format), color: "#fff" }}>
                {((f as any).format || "json").slice(0, 3).toUpperCase()}
              </div>
              <div style={S.fileInfo}>
                <div style={S.fileName}>{f.path}</div>
                <div style={S.fileMeta}>{f.kind} · {(f.size / 1024).toFixed(1)}KB</div>
              </div>
            </div>
          ))}
        </div>

        <div style={S.sidebarFooter}>
          <button style={{ ...S.btnGhost, width: "100%" }} onClick={() => setView(view === "settings" ? "main" : "settings")}>
            {view === "settings" ? "← Back" : "⚙ AI Provider"}
          </button>
        </div>
      </aside>

      {/* ===== Main ===== */}
      <main style={S.main}>
        <div style={S.topbar}>
          <div style={S.topbarTitle}>
            {view === "settings" ? "AI Provider Settings" : active?.file || "Confui"}
          </div>
          <div style={S.topbarActions}>{fileChanged && <button style={{ ...S.btnGhost, borderColor: C.warn, color: C.warn }} onClick={reloadFile}>⚠ File changed externally - Reload</button>}
            {msg && <span style={{ fontSize: 13, color: msg === "Saved" ? C.success : C.textSec }}>{msg}</span>}
            {busy && <div style={S.loading}><div style={S.spinner} /> Working...</div>}
            {view === "main" && active && (
              <button style={{ ...S.btn, opacity: dirty ? 1 : 0.5 }} onClick={save} disabled={busy || !dirty}>
                {dirty ? "● Save" : "Saved"}
              </button>
            )}
          </div>
        </div>

        <div style={S.content}>
          {view === "settings" ? (
            <SettingsPanel />
          ) : active ? (
            <div>
              <div style={{ marginBottom: 16, display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ ...S.badge, background: C.primaryLight, color: C.primaryHover }}>{active.source}</span>
                <span style={{ ...S.badge, background: C.borderLight, color: C.textSec }}>{(active as any).format || "json"}</span>
                <span style={{ fontSize: 12, color: C.textTer }}>{active.fields.length} fields</span>
              </div>
              {Object.entries(groups).map(([g, fields]) => (
                <div key={g} style={S.card}>
                  <div style={S.cardHeader}>{g}</div>
                  <div style={S.cardBody}>
                    {fields.map((f) => (
                      <FieldRow key={f.path} field={f} value={values[f.path]} onChange={(v) => setField(f.path, v)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={S.empty}>
              <div style={S.emptyIcon}>📁</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: C.textSec, marginBottom: 4 }}>No file selected</div>
              <div style={{ fontSize: 13 }}>Browse to a project and scan, then select a config file to edit.</div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/* ================================================================ * Field Row + Widget
 * ================================================================ */

function FieldRow({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === "object" && field.properties?.length) {
    return (
      <div style={{ marginBottom: 16, paddingLeft: 12, borderLeft: `2px solid ${C.borderLight}` }}>
        <label style={S.label}>{field.label}</label>
        {field.properties.map((p) => (
          <FieldRow key={p.path} field={p} value={value} onChange={onChange} />
        ))}
      </div>
    );
  }

  if (field.type === "array" || field.type === "object" || field.type === "json") {
    const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return (
      <div style={S.field}>
        <label style={S.label}>
          {field.label}
          {field.required && <span style={S.badgeReq}>*</span>}
          <SourceBadge source={field.source} />
        </label>
        {field.description && <div style={S.desc}>{field.description}</div>}
        <textarea
          style={{ ...S.input, minHeight: 70, fontFamily: "monospace", fontSize: 12 }}
          value={text}
          onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
        />
      </div>
    );
  }

  return (
    <div style={S.field}>
      <label style={S.label}>
        {field.label}
        {field.required && <span style={S.badgeReq}>*</span>}
        <SourceBadge source={field.source} />
      </label>
      {field.description && <div style={S.desc}>{field.description}</div>}
      <Widget field={field} value={value} onChange={onChange} />
    </div>
  );
}

function SourceBadge({ source }: { source?: string }) {
  if (!source || source === "heuristic") return null;
  const color = C.srcColor(source);
  return <span style={{ ...S.badge, background: color + "20", color }}>{source}</span>;
}

function Widget({ field, value, onChange }: { field: FieldSpec; value: unknown; onChange: (v: unknown) => void }) {
  const inputStyle = { ...S.input, borderColor: field.required && value == null ? C.warn : S.input.border };
  switch (field.type) {
    case "boolean":
      return (
        <div
          style={{ ...S.toggle, ...(value ? S.toggleOn : {}) }}
          onClick={() => onChange(!value)}
        >
          <div style={{ ...S.toggleKnob, left: value ? 20 : 2 }} />
        </div>
      );
    case "enum":
      return (
        <select style={S.input} value={String(value ?? "")} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          <option value="">—</option>
          {(field.enum ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      );
    case "secret":
      return <input type="password" style={inputStyle} value={String(value ?? "")} onInput={(e) => onChange((e.target as HTMLInputElement).value)} placeholder="••••••••" />;
    case "color":
      return <input type="color" style={{ ...S.input, padding: 2, height: 36, width: 50 }} value={String(value ?? "#000000")} onChange={(e) => onChange((e.target as HTMLInputElement).value)} />;
    case "number":
    case "integer":
      return <input type="number" style={inputStyle} value={value == null ? "" : Number(value)} min={field.minimum} max={field.maximum} onInput={(e) => onChange((e.target as HTMLInputElement).valueAsNumber)} />;
    default:
      return <input type="text" style={inputStyle} value={String(value ?? "")} onInput={(e) => onChange((e.target as HTMLInputElement).value)} placeholder={field.placeholder} />;
  }
}

/* ================================================================ * Settings Panel
 * ================================================================ */

function SettingsPanel() {
  const [s, setS] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => { window.confui.getSettings().then((v: any) => setS(v)); }, []);

  async function save() {
    await window.confui.setSettings(s);
    setSaved("Saved ✓");
    setTimeout(() => setSaved(""), 2000);
  }

  if (!s) return <div style={S.loading}><div style={S.spinner} /> Loading...</div>;

  const a = s.ai;
  const set = (patch: Partial<AppSettings["ai"]>) => setS({ ...s, ai: { ...a, ...patch } });

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={S.card}>
        <div style={S.cardHeader}>⚙ AI Inference</div>
        <div style={S.cardBody}>
          <div style={{ ...S.field, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={S.label}>Enable AI Inference</div>
              <div style={S.desc}>When enabled, unknown config fields are analyzed by AI for descriptions and types.</div>
            </div>
            <div style={{ ...S.toggle, ...(a.enabled ? S.toggleOn : {}) }} onClick={() => set({ enabled: !a.enabled })}>
              <div style={{ ...S.toggleKnob, left: a.enabled ? 20 : 2 }} />
            </div>
          </div>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardHeader}>Connection Details</div>
        <div style={S.cardBody}>
          <div style={S.field}>
            <label style={S.label}>Provider Name</label>
            <input style={S.input} value={a.provider} onInput={(e) => set({ provider: e.currentTarget.value })} />
          </div>
          <div style={S.field}>
            <label style={S.label}>Base URL</label>
            <div style={S.desc}>Any OpenAI-compatible endpoint. Empty = official OpenAI.</div>
            <input style={S.input} placeholder="https://api.openai.com/v1" value={a.baseUrl} onInput={(e) => set({ baseUrl: e.currentTarget.value })} />
          </div>
          <div style={S.field}>
            <label style={S.label}>Model</label>
            <input style={S.input} placeholder="gpt-4o-mini" value={a.model} onInput={(e) => set({ model: e.currentTarget.value })} />
          </div>
          <div style={S.field}>
            <label style={S.label}>API Key</label>
            <input style={S.input} type="password" placeholder="sk-..." value={a.apiKey} onInput={(e) => set({ apiKey: e.currentTarget.value })} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button style={S.btn} onClick={save}>Save Settings</button>
        {saved && <span style={{ color: C.success, fontSize: 13 }}>{saved}</span>}
      </div>
    </div>
  );
}

/* ================================================================ * Helpers
 * ================================================================ */

function formatColor(format?: string): string {
  const m: Record<string, string> = { json: "#0052CC", yaml: "#CB171E", toml: "#9C4221", env: "#ECD53F", ini: "#6B7280", properties: "#16C456" };
  return m[format || "json"] || "#0052CC";
}

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
    if (typeof val === "string" && (val.startsWith("{") || val.startsWith("["))) {
      try { val = JSON.parse(val); } catch {}
    }
    const parts = path.split(".");
    let cur = out;
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) cur[parts[i]] = val;
      else { cur[parts[i]] = cur[parts[i]] ?? {}; cur = cur[parts[i]]; }
    }
  }
  return out;
}
