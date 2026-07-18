import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  AppSettings,
  ConfigFile,
  ConfigFormat,
  ConfigFormSchema,
  FieldSpec,
  ProjectScanResult,
  RecentProject,
  SavePreview,
  ThemePreference,
} from "../../shared/schema.ts";
import { FieldEditor } from "./FieldEditor.tsx";
import {
  collectChanges,
  effectiveValue,
  fieldKey,
  initializeEditorValues,
  validationErrors,
  type EditorValues,
} from "./editor-state.ts";
import { Icon } from "./icons.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { Button, EmptyIllustration, Logo, Modal, SourceBadge } from "./ui.tsx";
import "./styles.css";

type View = "home" | "editor" | "settings";
type EditorTab = "form" | "raw";
type BusyState = "scan" | "infer" | "preview" | "save" | null;
type ToastType = "success" | "error" | "info";
type PendingAction =
  | { kind: "file"; file: ConfigFile }
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "reload" }
  | { kind: "rescan" }
  | { kind: "browse" };

interface ToastState {
  id: number;
  message: string;
  type: ToastType;
}

const FORMAT_LABELS: Record<ConfigFormat, string> = {
  json: "JSON",
  jsonc: "JSONC",
  yaml: "YAML",
  toml: "TOML",
  env: "ENV",
  ini: "INI",
  properties: "PROPERTIES",
};

export function App() {
  const [settings, setSettings] = useState<AppSettings>();
  const [view, setView] = useState<View>("home");
  const [project, setProject] = useState<ProjectScanResult>();
  const [rootInput, setRootInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<ConfigFormat | "all">("all");
  const [activeFile, setActiveFile] = useState<ConfigFile>();
  const [schema, setSchema] = useState<ConfigFormSchema>();
  const [values, setValues] = useState<EditorValues>({});
  const [editorTab, setEditorTab] = useState<EditorTab>("form");
  const [busy, setBusy] = useState<BusyState>(null);
  const [toast, setToast] = useState<ToastState>();
  const [externalChange, setExternalChange] = useState(false);
  const [savePreview, setSavePreview] = useState<SavePreview>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsPageRevision, setSettingsPageRevision] = useState(0);
  const [pendingSettingsAction, setPendingSettingsAction] = useState<PendingAction>();
  const [afterSaveAction, setAfterSaveAction] = useState<PendingAction>();
  const toastTimer = useRef<number>();
  const openSequence = useRef(0);

  const changes = useMemo(() => schema ? collectChanges(schema.fields, values) : [], [schema, values]);
  const errors = useMemo(() => schema ? validationErrors(schema.fields, values) : new Map<string, string>(), [schema, values]);
  const dirty = changes.length > 0;

  const filteredFiles = useMemo(() => {
    const query = fileQuery.trim().toLowerCase();
    return (project?.files ?? []).filter((file) =>
      (formatFilter === "all" || file.format === formatFilter)
      && (!query || file.path.toLowerCase().includes(query)),
    );
  }, [project, fileQuery, formatFilter]);

  useEffect(() => {
    void (async () => {
      const result = await window.confui.getSettings();
      if (result.ok) {
        setSettings(result.data);
        applyTheme(result.data.theme);
      } else {
        setSettings(defaultClientSettings());
        notify(result.error.message, "error");
      }
    })();
  }, []);

  useEffect(() => {
    if (settings?.theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [settings?.theme]);

  useEffect(() => window.confui.onFileChanged((event) => {
    if (schema && event.file === schema.file) setExternalChange(true);
  }), [schema]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (dirty && !savePreview && !pendingAction) void beginSave();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        requestAction({ kind: "browse" });
      }
      if (event.key === "Escape") {
        if (savePreview) closeSavePreview();
        else if (pendingAction) setPendingAction(undefined);
        else if (pendingSettingsAction) setPendingSettingsAction(undefined);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  });

  useEffect(() => {
    window.confui.setDirtyState(dirty || settingsDirty);
    return () => window.confui.setDirtyState(false);
  }, [dirty, settingsDirty]);

  function notify(message: string, type: ToastType = "info"): void {
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), message, type });
    toastTimer.current = window.setTimeout(() => setToast(undefined), 3_600);
  }

  async function browseForProject(): Promise<void> {
    const result = await window.confui.selectFolder();
    if (!result.ok) {
      notify(result.error.message, "error");
      return;
    }
    if (result.data) {
      setRootInput(result.data);
      await openProject(result.data, githubInput);
    }
  }

  async function openProject(root = rootInput, githubUrl = githubInput): Promise<void> {
    if (!root.trim()) {
      notify("请先选择本地项目文件夹", "error");
      return;
    }
    openSequence.current += 1;
    setBusy("scan");
    try {
      const result = await window.confui.scanProject(root.trim(), githubUrl.trim() || undefined);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      const scanned = result.data;
      const resolvedGithub = githubUrl.trim() || scanned.detectedGithubUrl || "";
      setProject(scanned);
      setExternalChange(false);
      setRootInput(scanned.root);
      setGithubInput(resolvedGithub);
      setActiveFile(undefined);
      setSchema(undefined);
      setValues({});
      setView("editor");
      const refreshedSettings = await window.confui.getSettings();
      if (refreshedSettings.ok) setSettings(refreshedSettings.data);
      const first = scanned.files.find((file) => file.status !== "too-large");
      if (first) await loadFile(first, scanned.root, resolvedGithub);
      else if (!scanned.files.length) notify("项目中没有发现支持的配置文件", "info");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  }

  async function openRecent(recent: RecentProject): Promise<void> {
    setRootInput(recent.path);
    setGithubInput(recent.githubUrl ?? "");
    await openProject(recent.path, recent.githubUrl ?? "");
  }

  async function loadFile(
    file: ConfigFile,
    root = project?.root,
    githubUrl = githubInput,
  ): Promise<void> {
    if (!root) return;
    if (file.status === "too-large") {
      notify(file.warning || "这个文件太大，无法安全打开", "error");
      return;
    }
    const sequence = ++openSequence.current;
    setBusy("infer");
    setView("editor");
    setEditorTab("form");
    try {
      const result = await window.confui.inferSchema(root, file.path, { githubUrl: githubUrl || undefined });
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (sequence !== openSequence.current) return;
      setActiveFile(file);
      setSchema(result.data);
      setValues(initializeEditorValues(result.data.fields));
      setExternalChange(false);
    } catch (error) {
      if (sequence === openSequence.current) notify(errorMessage(error), "error");
    } finally {
      if (sequence === openSequence.current) setBusy(null);
    }
  }

  function requestAction(action: PendingAction): void {
    if (view === "settings" && settingsDirty && action.kind !== "settings") {
      setPendingSettingsAction(action);
      return;
    }
    const sameFile = action.kind === "file" && action.file.path === activeFile?.path;
    if (sameFile) {
      setView("editor");
      return;
    }
    if (dirty) setPendingAction(action);
    else void performAction(action);
  }

  async function performAction(action: PendingAction): Promise<void> {
    if (view === "settings" && action.kind !== "settings" && settings) applyTheme(settings.theme);
    switch (action.kind) {
      case "file":
        await loadFile(action.file);
        return;
      case "home":
        setView("home");
        return;
      case "settings":
        setView("settings");
        return;
      case "reload":
        if (activeFile) await loadFile(activeFile);
        return;
      case "rescan":
        if (project) await openProject(project.root, githubInput);
        return;
      case "browse":
        await browseForProject();
    }
  }

  async function beginSave(continuation?: PendingAction): Promise<void> {
    if (!schema || !project || !changes.length) return;
    if (errors.size) {
      notify(`有 ${errors.size} 个字段需要修正`, "error");
      setEditorTab("form");
      return;
    }
    setBusy("preview");
    try {
      const result = await window.confui.previewSave(project.root, schema.file, changes, schema.version);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (!result.data.changes.length) {
        const nextFields = schema.fields.map((field) => ({ ...field, value: effectiveValue(values[fieldKey(field)]) }));
        setSchema({ ...schema, fields: nextFields });
        setValues(initializeEditorValues(nextFields));
        setAfterSaveAction(undefined);
        if (continuation) await performAction(continuation);
        return;
      }
      setAfterSaveAction(continuation);
      setSavePreview(result.data);
    } catch (error) {
      setAfterSaveAction(undefined);
      notify(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  }

  async function confirmSave(): Promise<void> {
    if (!savePreview || !schema || !project) return;
    setBusy("save");
    try {
      const result = await window.confui.saveConfig(project.root, savePreview);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      const nextFields = schema.fields.map((field) => ({
        ...field,
        value: effectiveValue(values[fieldKey(field)]),
      }));
      const nextSchema = {
        ...schema,
        fields: nextFields,
        rawText: savePreview.output,
        version: result.data.version,
      };
      setSchema(nextSchema);
      setValues(initializeEditorValues(nextFields));
      setSavePreview(undefined);
      setExternalChange(false);
      notify(`已保存，并创建 ${result.data.backupPath.split(/[\\/]/).at(-1)}`, "success");
      const action = afterSaveAction;
      setAfterSaveAction(undefined);
      if (action) await performAction(action);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  }

  function discardAndContinue(): void {
    const action = pendingAction;
    setPendingAction(undefined);
    if (schema) setValues(initializeEditorValues(schema.fields));
    if (action) window.setTimeout(() => void performAction(action), 0);
  }

  function saveAndContinue(): void {
    const action = pendingAction;
    setPendingAction(undefined);
    window.setTimeout(() => void beginSave(action), 0);
  }

  function closeSavePreview(): void {
    if (busy === "save") return;
    setSavePreview(undefined);
    setAfterSaveAction(undefined);
  }

  function discardSettingsAndContinue(): void {
    const action = pendingSettingsAction;
    setPendingSettingsAction(undefined);
    setSettingsDirty(false);
    setSettingsPageRevision((current) => current + 1);
    applyTheme(settings?.theme ?? "system");
    if (action) window.setTimeout(() => void performAction(action), 0);
  }

  async function saveSettings(next: AppSettings): Promise<void> {
    const result = await window.confui.setSettings(next);
    if (!result.ok) throw new Error(result.error.detail || result.error.message);
    setSettings(result.data);
    applyTheme(result.data.theme);
  }

  function updateField(field: FieldSpec, value: unknown): void {
    setValues((current) => ({ ...current, [fieldKey(field)]: value }));
  }

  if (!settings) {
    return (
      <div class="app-loading">
        <Logo/>
        <span><Icon name="loader" class="spin"/>正在准备 Confui</span>
      </div>
    );
  }

  return (
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar__brand"><Logo/></div>
        <nav class="primary-nav" aria-label="主导航">
          <button class={view === "home" ? "active" : ""} onClick={() => requestAction({ kind: "home" })}><Icon name="home"/><span>开始</span></button>
        </nav>

        {project ? (
          <div class="project-panel">
            <div class="project-card">
              <div class="project-card__icon"><Icon name="folder-open"/></div>
              <div><strong title={project.root}>{project.name}</strong><span>{project.files.length} 个配置文件</span></div>
              <button class="icon-button" aria-label="重新扫描项目" title="重新扫描项目" onClick={() => requestAction({ kind: "rescan" })}><Icon name="refresh" size={16}/></button>
            </div>
            <div class="file-tools">
              <label class="search-box">
                <Icon name="search" size={15}/>
                <input value={fileQuery} onInput={(event) => setFileQuery(event.currentTarget.value)} placeholder="筛选配置文件" aria-label="筛选配置文件"/>
                {fileQuery && <button onClick={() => setFileQuery("")} aria-label="清空筛选"><Icon name="x" size={14}/></button>}
              </label>
              <div class="format-filter">
                <select value={formatFilter} onChange={(event) => setFormatFilter(event.currentTarget.value as ConfigFormat | "all")} aria-label="按格式筛选">
                  <option value="all">全部格式</option>
                  {Object.entries(FORMAT_LABELS).map(([format, label]) => <option key={format} value={format}>{label}</option>)}
                </select>
                <Icon name="chevron-down" size={14}/>
              </div>
            </div>
            <div class="file-list" role="listbox" aria-label="配置文件">
              {filteredFiles.map((file) => (
                <button
                  key={file.path}
                  role="option"
                  aria-selected={activeFile?.path === file.path && view === "editor"}
                  class={`file-item ${activeFile?.path === file.path && view === "editor" ? "active" : ""}`}
                  onClick={() => requestAction({ kind: "file", file })}
                  title={file.warning || file.path}
                >
                  <span class={`format-icon format-icon--${file.format}`}>{FORMAT_LABELS[file.format].slice(0, 3)}</span>
                  <span class="file-item__copy"><strong>{file.path.split("/").at(-1)}</strong><small>{parentPath(file.path)} · {formatBytes(file.size)}</small></span>
                  {activeFile?.path === file.path && dirty && <i class="dirty-dot" title="有未保存的更改"/>}
                  {file.status !== "ready" && <Icon name="warning" size={14} class="file-warning"/>}
                </button>
              ))}
              {!filteredFiles.length && (
                <div class="file-list__empty"><Icon name="search"/><span>没有匹配的文件</span></div>
              )}
            </div>
          </div>
        ) : (
          <div class="sidebar-empty">
            <Icon name="folder"/>
            <p>打开项目后，配置文件会出现在这里。</p>
          </div>
        )}

        <nav class="sidebar-footer" aria-label="设置">
          <button class={view === "settings" ? "active" : ""} onClick={() => requestAction({ kind: "settings" })}><Icon name="settings"/><span>设置</span></button>
          <small>Confui 0.2</small>
        </nav>
      </aside>

      <main class="main-shell">
        <header class="topbar">
          <div class="topbar__title">
            {view === "home" ? <><span>开始</span><small>选择项目并识别配置</small></> : view === "settings" ? <><span>设置</span><small>供应商、安全与外观</small></> : schema ? <><span>{schema.kind}{dirty && <i class="title-dirty"/>}</span><small title={schema.file}>{schema.file}</small></> : <><span>{project?.name ?? "配置编辑器"}</span><small>选择一个配置文件</small></>}
          </div>
          <div class="topbar__actions">
            {view === "editor" && schema && (
              <>
                <div class="view-tabs" role="tablist">
                  <button id="editor-tab-form" role="tab" aria-selected={editorTab === "form"} aria-controls="editor-panel-form" class={editorTab === "form" ? "active" : ""} onClick={() => setEditorTab("form")}><Icon name="layers" size={15}/>表单</button>
                  <button id="editor-tab-raw" role="tab" aria-selected={editorTab === "raw"} aria-controls="editor-panel-raw" class={editorTab === "raw" ? "active" : ""} onClick={() => setEditorTab("raw")}><Icon name="code" size={15}/>原始内容</button>
                </div>
                <Button variant="primary" icon="save" disabled={!dirty || errors.size > 0 || busy !== null} busy={busy === "preview" || busy === "save"} onClick={() => void beginSave()}>
                  {dirty ? `保存 ${changes.length} 项` : "已保存"}
                </Button>
              </>
            )}
            {view === "home" && <Button icon="folder-open" onClick={() => void browseForProject()}>选择文件夹</Button>}
          </div>
        </header>

        {externalChange && view === "editor" && (
          <div class="external-banner" role="status">
            <Icon name="warning"/>
            <div><strong>文件在 Confui 外部发生了变化</strong><span>{dirty ? "当前还有未保存内容，重新加载前请先确认。" : "建议重新加载，以免基于旧内容继续编辑。"}</span></div>
            <Button onClick={() => requestAction({ kind: "reload" })}>重新加载</Button>
            <button class="icon-button" onClick={() => setExternalChange(false)} aria-label="暂时忽略"><Icon name="x"/></button>
          </div>
        )}

        <div class="main-content">
          {view === "home" && (
            <HomePage
              root={rootInput}
              github={githubInput}
              recent={settings.recentProjects}
              busy={busy === "scan"}
              onRoot={setRootInput}
              onGithub={setGithubInput}
              onBrowse={() => void browseForProject()}
              onOpen={() => void openProject()}
              onRecent={(item) => void openRecent(item)}
            />
          )}

          {view === "settings" && (
            <SettingsPage
              key={settingsPageRevision}
              settings={settings}
              onSave={saveSettings}
              onThemePreview={applyTheme}
              onToast={notify}
              onDirtyChange={setSettingsDirty}
            />
          )}

          {view === "editor" && busy === "infer" && !schema && <EditorSkeleton/>}

          {view === "editor" && !schema && busy !== "infer" && (
            <div class="editor-empty">
              <EmptyIllustration/>
              <h1>{project?.files.length ? "选择一个配置文件" : "没有发现配置文件"}</h1>
              <p>{project?.files.length ? "Confui 会组合 Schema、示例、README 与结构推断，生成可编辑表单。" : "可以确认项目路径，或检查配置文件是否属于当前支持的格式。"}</p>
              {!project && <Button variant="primary" icon="folder-open" onClick={() => void browseForProject()}>打开本地项目</Button>}
            </div>
          )}

          {view === "editor" && schema && editorTab === "form" && (
            <div id="editor-panel-form" class="editor-page page-wide" role="tabpanel" aria-labelledby="editor-tab-form">
              <EditorSummary schema={schema}/>
              {schema.fields.length ? (
                <FieldEditor fields={schema.fields} values={values} errors={errors} onChange={updateField}/>
              ) : (
                <div class="empty-card"><Icon name="info"/><div><h2>暂时无法生成表单</h2><p>这个文件没有可识别的键值字段。你仍然可以在“原始内容”中查看它。</p></div></div>
              )}
              <div class="editor-bottom-space"/>
            </div>
          )}

          {view === "editor" && schema && editorTab === "raw" && (
            <div id="editor-panel-raw" class="raw-page page-wide" role="tabpanel" aria-labelledby="editor-tab-raw">
              <div class="raw-notice"><Icon name="info"/><span>原始内容用于核对格式和注释；请回到表单进行安全修改。</span><SourceBadge source="heuristic"/></div>
              <section class="raw-card">
                <header><span>{schema.file}</span><small>{FORMAT_LABELS[schema.format]} · 只读</small></header>
                <pre><code>{schema.rawText}</code></pre>
              </section>
            </div>
          )}
        </div>

        {view === "editor" && schema && dirty && (
          <div class="editor-savebar">
            <div><i/><strong>{changes.length} 项更改尚未保存</strong>{errors.size > 0 && <span>{errors.size} 个字段需要修正</span>}</div>
            <div>
              <Button variant="ghost" onClick={() => setValues(initializeEditorValues(schema.fields))}>全部撤销</Button>
              <Button variant="primary" icon="save" disabled={errors.size > 0 || busy !== null} busy={busy === "preview"} onClick={() => void beginSave()}>查看并保存</Button>
            </div>
          </div>
        )}
      </main>

      {toast && (
        <div key={toast.id} class={`toast toast--${toast.type}`} role={toast.type === "error" ? "alert" : "status"}>
          <span><Icon name={toast.type === "success" ? "check" : toast.type === "error" ? "warning" : "info"}/></span>
          <p>{toast.message}</p>
          <button class="icon-button" onClick={() => setToast(undefined)} aria-label="关闭提示"><Icon name="x" size={15}/></button>
        </div>
      )}

      {savePreview && (
        <Modal
          title="确认保存更改"
          description={`将更新 ${savePreview.file}，保存前会自动创建 .bak 备份。`}
          width="680px"
          onClose={closeSavePreview}
          footer={<><Button onClick={closeSavePreview} disabled={busy === "save"}>返回编辑</Button><Button variant="primary" icon="save" busy={busy === "save"} disabled={busy === "save"} onClick={() => void confirmSave()}>确认保存 {savePreview.changes.length} 项</Button></>}
        >
          {savePreview.warnings.map((warning) => <div class="modal-warning" key={warning}><Icon name="warning"/><span>{warning}</span></div>)}
          <div class="diff-list">
            {savePreview.changes.map((change) => {
              const field = schema?.fields.find((item) => item.path === change.path);
              const secret = field?.secret || field?.type === "secret";
              return (
                <div class="diff-item" key={change.path}>
                  <div><strong>{field?.label || change.path}</strong><code>{change.path}</code></div>
                  <div class="diff-values"><span>{secret ? "••••••••" : formatValue(change.before)}</span><Icon name="arrow-left" class="diff-arrow"/><strong>{secret ? "••••••••" : formatValue(change.after)}</strong></div>
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {pendingAction && (
        <Modal
          title="还有未保存的更改"
          description="离开当前文件前，选择如何处理这些更改。"
          onClose={() => setPendingAction(undefined)}
          footer={<><Button onClick={() => setPendingAction(undefined)}>继续编辑</Button><Button variant="danger" onClick={discardAndContinue}>放弃更改</Button><Button variant="primary" icon="save" onClick={saveAndContinue}>保存后继续</Button></>}
        >
          <div class="unsaved-summary"><span><Icon name="file"/></span><div><strong>{schema?.kind}</strong><p>{changes.length} 项更改尚未写入文件</p></div></div>
        </Modal>
      )}

      {pendingSettingsAction && (
        <Modal
          title="设置尚未保存"
          description="离开设置页会丢弃刚才的修改。"
          onClose={() => setPendingSettingsAction(undefined)}
          footer={<><Button onClick={() => setPendingSettingsAction(undefined)}>返回设置</Button><Button variant="danger" onClick={discardSettingsAndContinue}>放弃并继续</Button></>}
        >
          <div class="unsaved-summary"><span><Icon name="settings"/></span><div><strong>Confui 设置</strong><p>供应商、安全或外观选项已发生变化</p></div></div>
        </Modal>
      )}
    </div>
  );
}

function HomePage({
  root,
  github,
  recent,
  busy,
  onRoot,
  onGithub,
  onBrowse,
  onOpen,
  onRecent,
}: {
  root: string;
  github: string;
  recent: RecentProject[];
  busy: boolean;
  onRoot: (value: string) => void;
  onGithub: (value: string) => void;
  onBrowse: () => void;
  onOpen: () => void;
  onRecent: (item: RecentProject) => void;
}) {
  return (
    <div class="home-page page-wide">
      <div class="home-heading">
        <span class="home-heading__icon"><Icon name="layers" size={24}/></span>
        <div><p class="eyebrow">本地配置工作台</p><h1>打开项目，直接开始配置</h1><p>Confui 会识别常见配置格式，把字段说明和正确控件放到同一个桌面界面里。</p></div>
      </div>
      <section class="open-project-card">
        <div class="open-project-card__head"><div><h2>选择本地项目</h2><p>配置文件只在你的电脑上读取和保存。</p></div><span class="local-pill"><Icon name="shield" size={14}/>本地处理</span></div>
        <div class="project-input-block">
          <label for="project-root">项目文件夹 <em>必选</em></label>
          <div class="path-control"><Icon name="folder"/><input id="project-root" value={root} placeholder="选择或粘贴项目文件夹路径" onInput={(event) => onRoot(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}/><Button onClick={onBrowse}>浏览</Button></div>
        </div>
        <div class="project-input-block">
          <label for="github-url">GitHub 仓库 <span>可选，用于本地无 README 时补充说明</span></label>
          <div class="path-control"><Icon name="github"/><input id="github-url" value={github} placeholder="https://github.com/owner/repository" onInput={(event) => onGithub(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}/></div>
        </div>
        <div class="open-project-card__footer"><p><Icon name="info" size={15}/>优先读取本地 Schema、示例文件和 README；AI 只是最后一层补充。</p><Button variant="primary" icon="folder-open" busy={busy} disabled={busy || !root.trim()} onClick={onOpen}>识别并打开</Button></div>
      </section>

      {recent.length > 0 && (
        <section class="recent-section">
          <div class="section-heading"><div><h2>最近打开</h2><p>继续处理之前的本地项目</p></div></div>
          <div class="recent-grid">
            {recent.slice(0, 6).map((item) => (
              <button class="recent-card" key={item.path} onClick={() => onRecent(item)}>
                <span class="recent-card__icon"><Icon name="folder"/></span>
                <span><strong>{item.name}</strong><small title={item.path}>{item.path}</small></span>
                <Icon name="arrow-left" class="recent-card__arrow"/>
              </button>
            ))}
          </div>
        </section>
      )}

    </div>
  );
}

function EditorSummary({ schema }: { schema: ConfigFormSchema }) {
  return (
    <section class="editor-summary">
      <div class="editor-summary__main">
        <span class={`format-icon format-icon--${schema.format}`}>{FORMAT_LABELS[schema.format].slice(0, 3)}</span>
        <div><h1>{schema.kind}</h1><p>{schema.fields.length} 个字段 · {FORMAT_LABELS[schema.format]} · {formatBytes(schema.version.size)}</p></div>
      </div>
      <div class="source-pipeline">
        {schema.sources.map((source) => <span key={source.source} title={`${source.fieldCount} 个字段使用了此来源`}><SourceBadge source={source.source}/><small>{source.fieldCount}</small></span>)}
      </div>
      {(schema.warnings.length > 0 || schema.exampleFiles.length > 0 || schema.readmeSource) && (
        <div class="editor-summary__details">
          {schema.exampleFiles.length > 0 && <span><Icon name="archive" size={14}/>{schema.exampleFiles.length} 个示例文件</span>}
          {schema.readmeSource && <span><Icon name="file" size={14}/>{schema.readmeSource === "local" ? "本地 README" : "GitHub README"}</span>}
          {schema.warnings.map((warning) => <span class="summary-warning" key={warning} title={warning}><Icon name="warning" size={14}/>{warning}</span>)}
        </div>
      )}
    </section>
  );
}

function EditorSkeleton() {
  return (
    <div class="editor-page page-wide skeleton-page">
      <div class="skeleton skeleton--summary"/>
      <div class="skeleton-card"><span/><span/><span/><span/></div>
      <div class="skeleton-card"><span/><span/><span/></div>
    </div>
  );
}

function applyTheme(preference: ThemePreference): void {
  const dark = preference === "dark" || (preference === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function defaultClientSettings(): AppSettings {
  return {
    theme: "system",
    ai: { enabled: false, provider: "custom", model: "", baseUrl: "", apiKey: "", timeoutMs: 45_000 },
    github: { token: "" },
    recentProjects: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作失败，请重试";
}

function parentPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : "项目根目录";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatValue(value: unknown): string {
  if (value === undefined) return "未设置";
  if (value === null) return "null";
  if (typeof value === "string") return value ? truncate(value, 120) : "空字符串";
  const text = JSON.stringify(value);
  return text ? truncate(text, 120) : String(value);
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}
