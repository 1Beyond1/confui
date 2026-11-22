import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  AppSettings,
  ConfigFile,
  ConfigFormat,
  ConfigFormSchema,
  FieldAssistField,
  FieldAssistResult,
  FieldSpec,
  ProjectScanResult,
  RecentProject,
  SavePreview,
} from "../../shared/schema.ts";
import { EditorSkeleton, EditorSummary } from "./components/EditorSummary.tsx";
import { HomePage } from "./components/HomePage.tsx";
import { RawViewer } from "./components/RawViewer.tsx";
import { SaveConfirmModal } from "./components/SaveConfirmModal.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { UnsavedConfigModal, UnsavedSettingsModal } from "./components/UnsavedModals.tsx";
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
import { Button, EmptyIllustration, Logo } from "./ui.tsx";
import {
  applyTheme,
  defaultClientSettings,
  errorMessage,
  sameProjectRoot,
} from "./utils/format.ts";
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

interface LoadErrorState {
  file: string;
  message: string;
}

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
  const [loadError, setLoadError] = useState<LoadErrorState>();
  const [savePreview, setSavePreview] = useState<SavePreview>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsPageRevision, setSettingsPageRevision] = useState(0);
  const [pendingSettingsAction, setPendingSettingsAction] = useState<PendingAction>();
  const [afterSaveAction, setAfterSaveAction] = useState<PendingAction>();
  const [fieldEditorRevision, setFieldEditorRevision] = useState(0);
  const [appVersion, setAppVersion] = useState("");
  const toastTimer = useRef<number>();
  const openSequence = useRef(0);
  const mainContentRef = useRef<HTMLDivElement>(null);

  const changes = useMemo(() => schema ? collectChanges(schema.fields, values) : [], [schema, values]);
  const errors = useMemo(
    () => schema ? validationErrors(schema.fields, values, schema.format) : new Map<string, string>(),
    [schema, values],
  );
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
    void window.confui.getAppInfo().then((result) => {
      if (result.ok) setAppVersion(result.data.version);
    });
  }, []);

  useEffect(() => {
    if (settings?.theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => applyTheme("system");
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [settings?.theme]);

  useEffect(() => window.confui.onFileChanged((event) => {
    if (
      schema
      && project
      && event.file === schema.file
      && (!event.projectRoot || sameProjectRoot(event.projectRoot, project.root))
    ) {
      setExternalChange(true);
    }
  }), [schema, project]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (view === "editor" && dirty && busy === null && !savePreview && !pendingAction) void beginSave();
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

  useEffect(() => {
    mainContentRef.current?.scrollTo({ top: 0, left: 0 });
  }, [view, schema?.file, editorTab]);

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
    const sequence = ++openSequence.current;
    setBusy("scan");
    try {
      const result = await window.confui.scanProject(root.trim(), githubUrl.trim() || undefined);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (sequence !== openSequence.current) return;
      const scanned = result.data;
      const resolvedGithub = scanned.detectedGithubUrl || "";
      setProject(scanned);
      setExternalChange(false);
      setLoadError(undefined);
      setRootInput(scanned.root);
      setGithubInput(resolvedGithub);
      setActiveFile(undefined);
      setSchema(undefined);
      setValues({});
      setView("editor");
      const refreshedSettings = await window.confui.getSettings();
      if (sequence !== openSequence.current) return;
      if (refreshedSettings.ok) setSettings(refreshedSettings.data);
      const first = scanned.files.find((file) => file.status === "ready" || file.status === "large");
      if (first) await loadFile(first, scanned.root, resolvedGithub);
      else if (!scanned.files.length) notify("项目中没有发现支持的配置文件", "info");
    } catch (error) {
      if (sequence === openSequence.current) notify(errorMessage(error), "error");
    } finally {
      if (sequence === openSequence.current) setBusy(null);
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
    if (file.status === "too-large" || file.status === "unsupported" || file.status === "unreadable") {
      notify(file.warning || "这个文件无法安全打开", "error");
      return;
    }
    const sequence = ++openSequence.current;
    setBusy("infer");
    setActiveFile(file);
    setSchema(undefined);
    setValues({});
    setExternalChange(false);
    setLoadError(undefined);
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
      if (sequence === openSequence.current) {
        const message = errorMessage(error);
        setLoadError({ file: file.path, message });
        notify(message, "error");
      }
    } finally {
      if (sequence === openSequence.current) setBusy(null);
    }
  }

  function requestAction(action: PendingAction): void {
    if (busy !== null || savePreview || pendingAction || pendingSettingsAction) return;
    if (view === "settings" && settingsDirty && action.kind !== "settings") {
      setPendingSettingsAction(action);
      return;
    }
    const sameFile = view !== "home" && action.kind === "file" && action.file.path === activeFile?.path;
    if (sameFile && !loadError) {
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
        window.confui.stopWatching();
        setExternalChange(false);
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
      setFieldEditorRevision((current) => current + 1);
      window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
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
      const savedValues = new Map(
        savePreview.operations.map((operation) => [JSON.stringify(operation.segments), operation.value]),
      );
      const nextFields = schema.fields.map((field) => ({
        ...field,
        value: savedValues.has(fieldKey(field))
          ? savedValues.get(fieldKey(field))
          : effectiveValue(values[fieldKey(field)]),
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

  async function askAiAboutField(field: FieldSpec): Promise<FieldAssistResult> {
    if (!project || !schema) throw new Error("当前没有打开的配置文件");
    const request: FieldAssistField = {
      segments: [...field.segments],
      label: field.label,
      type: field.type,
      description: field.description,
      required: field.required,
      enum: field.enum,
      minimum: field.minimum,
      maximum: field.maximum,
      minLength: field.minLength,
      maxLength: field.maxLength,
      placeholder: field.placeholder,
      secret: field.secret,
      group: field.group,
    };
    const result = await window.confui.explainField(project.root, schema.file, request, githubInput || undefined);
    if (!result.ok) throw new Error(result.error.detail || result.error.message);
    return result.data;
  }

  function selectEditorTab(tab: EditorTab): void {
    setEditorTab(tab);
    window.setTimeout(() => document.getElementById(`editor-tab-${tab}`)?.focus(), 0);
  }

  function handleEditorTabKey(event: KeyboardEvent): void {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || event.key === "ArrowLeft" ? "form" : "raw";
    selectEditorTab(next);
  }

  function forwardMainWheel(event: WheelEvent): void {
    const scroller = mainContentRef.current;
    const target = event.target;
    const overFloatingBar = target instanceof Element
      && Boolean(target.closest(".editor-savebar, .settings-savebar"));
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return;
    if (target instanceof Node && scroller.contains(target) && !overFloatingBar) return;
    if (event.deltaX === 0 && event.deltaY === 0) return;
    event.preventDefault();
    scroller.scrollBy({ left: event.deltaX, top: event.deltaY });
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
      <Sidebar
        view={view}
        project={project}
        filteredFiles={filteredFiles}
        activeFile={activeFile}
        fileQuery={fileQuery}
        formatFilter={formatFilter}
        dirty={dirty}
        busy={busy !== null}
        appVersion={appVersion}
        onFileQuery={setFileQuery}
        onFormatFilter={setFormatFilter}
        onHome={() => requestAction({ kind: "home" })}
        onSettings={() => requestAction({ kind: "settings" })}
        onRescan={() => requestAction({ kind: "rescan" })}
        onSelectFile={(file) => requestAction({ kind: "file", file })}
      />

      <main class="main-shell" onWheel={forwardMainWheel}>
        <header class="topbar">
          <div class="topbar__title">
            {view === "home"
              ? <><span>开始</span><small>选择项目并识别配置</small></>
              : view === "settings"
                ? <><span>设置</span><small>供应商、安全与外观</small></>
                : schema
                  ? <><span>{schema.kind}{dirty && <i class="title-dirty"/>}</span><small title={schema.file}>{schema.file}</small></>
                  : <><span>{project?.name ?? "配置编辑器"}</span><small>选择一个配置文件</small></>}
          </div>
          <div class="topbar__actions">
            {view === "editor" && schema && (
              <>
                <div class="view-tabs" role="tablist" aria-orientation="horizontal">
                  <button
                    id="editor-tab-form"
                    role="tab"
                    tabIndex={editorTab === "form" ? 0 : -1}
                    aria-selected={editorTab === "form"}
                    aria-controls="editor-panel-form"
                    class={editorTab === "form" ? "active" : ""}
                    onKeyDown={handleEditorTabKey}
                    onClick={() => selectEditorTab("form")}
                  >
                    <Icon name="layers" size={15}/>表单
                  </button>
                  <button
                    id="editor-tab-raw"
                    role="tab"
                    tabIndex={editorTab === "raw" ? 0 : -1}
                    aria-selected={editorTab === "raw"}
                    aria-controls="editor-panel-raw"
                    class={editorTab === "raw" ? "active" : ""}
                    onKeyDown={handleEditorTabKey}
                    onClick={() => selectEditorTab("raw")}
                  >
                    <Icon name="code" size={15}/>原始内容
                  </button>
                </div>
                <Button
                  variant="primary"
                  icon="save"
                  disabled={!dirty || errors.size > 0 || busy !== null}
                  busy={busy === "preview" || busy === "save"}
                  onClick={() => void beginSave()}
                >
                  {dirty ? `保存 ${changes.length} 项` : "已保存"}
                </Button>
              </>
            )}
            {view === "home" && (
              <Button icon="folder-open" disabled={busy !== null} onClick={() => void browseForProject()}>
                选择文件夹
              </Button>
            )}
          </div>
        </header>

        {externalChange && view === "editor" && (
          <div class="external-banner" role="status">
            <Icon name="warning"/>
            <div>
              <strong>文件在 Confui 外部发生了变化</strong>
              <span>{dirty ? "当前还有未保存内容，重新加载前请先确认。" : "建议重新加载，以免基于旧内容继续编辑。"}</span>
            </div>
            <Button onClick={() => requestAction({ kind: "reload" })}>重新加载</Button>
            <button class="icon-button" onClick={() => setExternalChange(false)} aria-label="暂时忽略">
              <Icon name="x"/>
            </button>
          </div>
        )}

        <div ref={mainContentRef} class="main-content" role="region" aria-label="页面内容" tabIndex={0}>
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

          {view === "editor" && !schema && busy !== "infer" && loadError?.file === activeFile?.path ? (
            <div class="editor-load-error" role="alert">
              <span class="editor-load-error__icon"><Icon name="warning"/></span>
              <h1>这个配置文件暂时打不开</h1>
              <p>{loadError?.message}</p>
              <Button variant="primary" icon="refresh" onClick={() => activeFile && void loadFile(activeFile)}>重试</Button>
            </div>
          ) : view === "editor" && !schema && busy !== "infer" && (
            <div class="editor-empty">
              <EmptyIllustration/>
              <h1>{project?.files.length ? "选择一个配置文件" : "没有发现配置文件"}</h1>
              <p>{project?.files.length
                ? "Confui 会组合 Schema、示例、README 与结构推断，生成可编辑表单。"
                : "可以确认项目路径，或检查配置文件是否属于当前支持的格式。"}
              </p>
              {!project && (
                <Button variant="primary" icon="folder-open" onClick={() => void browseForProject()}>
                  打开本地项目
                </Button>
              )}
            </div>
          )}

          {view === "editor" && schema && editorTab === "form" && (
            <div id="editor-panel-form" class="editor-page page-wide" role="tabpanel" aria-labelledby="editor-tab-form">
              <EditorSummary schema={schema}/>
              {schema.fields.length ? (
                <FieldEditor
                  key={fieldEditorRevision}
                  fileKey={`${project?.root ?? ""}:${schema.file}`}
                  fields={schema.fields}
                  values={values}
                  errors={errors}
                  disabled={busy !== null}
                  aiAvailable={settings.ai.enabled && Boolean(settings.ai.baseUrl.trim() && settings.ai.model.trim())}
                  onExplain={askAiAboutField}
                  onChange={updateField}
                />
              ) : (
                <div class="empty-card">
                  <Icon name="info"/>
                  <div>
                    <h2>暂时无法生成表单</h2>
                    <p>这个文件没有可识别的键值字段。你仍然可以在“原始内容”中查看它。</p>
                  </div>
                </div>
              )}
              <div class="editor-bottom-space"/>
            </div>
          )}

          {view === "editor" && schema && editorTab === "raw" && <RawViewer schema={schema}/>}
        </div>

        {view === "editor" && schema && dirty && (
          <div class="editor-savebar">
            <div>
              <i/>
              <strong>{changes.length} 项更改尚未保存</strong>
              {errors.size > 0 && <span>{errors.size} 个字段需要修正</span>}
            </div>
            <div>
              <Button variant="ghost" disabled={busy !== null} onClick={() => setValues(initializeEditorValues(schema.fields))}>
                全部撤销
              </Button>
              <Button
                variant="primary"
                icon="save"
                disabled={errors.size > 0 || busy !== null}
                busy={busy === "preview"}
                onClick={() => void beginSave()}
              >
                查看并保存
              </Button>
            </div>
          </div>
        )}
      </main>

      {toast && (
        <div
          key={toast.id}
          class={`toast toast--${toast.type} ${(dirty || settingsDirty) ? "toast--above-savebar" : ""}`}
          role={toast.type === "error" ? "alert" : "status"}
        >
          <span><Icon name={toast.type === "success" ? "check" : toast.type === "error" ? "warning" : "info"}/></span>
          <p>{toast.message}</p>
          <button class="icon-button" onClick={() => setToast(undefined)} aria-label="关闭提示">
            <Icon name="x" size={15}/>
          </button>
        </div>
      )}

      {savePreview && (
        <SaveConfirmModal
          savePreview={savePreview}
          schema={schema}
          saving={busy === "save"}
          onClose={closeSavePreview}
          onConfirm={() => void confirmSave()}
        />
      )}

      {pendingAction && (
        <UnsavedConfigModal
          kind={schema?.kind}
          changeCount={changes.length}
          onCancel={() => setPendingAction(undefined)}
          onDiscard={discardAndContinue}
          onSaveAndContinue={saveAndContinue}
        />
      )}

      {pendingSettingsAction && (
        <UnsavedSettingsModal
          onCancel={() => setPendingSettingsAction(undefined)}
          onDiscard={discardSettingsAndContinue}
        />
      )}
    </div>
  );
}
