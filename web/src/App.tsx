import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  AppSettings,
  BackupStatus,
  ConfigFile,
  ConfigFormat,
  ConfigFormSchema,
  ExampleTemplate,
  FieldAssistField,
  FieldAssistResult,
  FieldSpec,
  FieldType,
  Locale,
  PathSegment,
  ProjectScanResult,
  ProjectSearchHit,
  RecentProject,
  RestoreBackupPreview,
  SavePreview,
  ThemePreference,
} from "../../shared/schema.ts";
import { normalizeGithubUrl } from "../../shared/validation.ts";
import { AddKeyModal } from "./components/AddKeyModal.tsx";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.tsx";
import { CompareSyncModal } from "./components/CompareSyncModal.tsx";
import { EditorSkeleton, EditorSummary } from "./components/EditorSummary.tsx";
import { ExportRedactedModal } from "./components/ExportRedactedModal.tsx";
import { HomePage } from "./components/HomePage.tsx";
import { RawViewer } from "./components/RawViewer.tsx";
import { RestoreBackupModal } from "./components/RestoreBackupModal.tsx";
import { SaveConfirmModal } from "./components/SaveConfirmModal.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { UnsavedConfigModal, UnsavedSettingsModal } from "./components/UnsavedModals.tsx";
import { FieldEditor } from "./FieldEditor.tsx";
import {
  collectChanges,
  createCustomFieldSpec,
  createJsonDraft,
  effectiveValue,
  fieldKey,
  initialFieldEditorValue,
  initializeEditorValues,
  isEditableKeyboardTarget,
  isEditorDirty,
  needsJsonEditor,
  reconcileSavedState,
  validationErrors,
} from "./editor-state.ts";
import { useEditorHistory } from "./hooks/useEditorHistory.ts";
import { I18nProvider, translate } from "./i18n/index.tsx";
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
type BusyState = "scan" | "infer" | "preview" | "save" | "restore" | null;
type ToastType = "success" | "error" | "info";
type PendingAction =
  | { kind: "file"; file: ConfigFile; focusFieldPath?: string; focusLine?: number; openRaw?: boolean }
  | { kind: "home" }
  | { kind: "settings" }
  | { kind: "reload" }
  | { kind: "rescan" }
  | { kind: "browse" }
  | { kind: "init-template"; template: ExampleTemplate };

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
  const [previewLocale, setPreviewLocale] = useState<Locale>();
  const [view, setView] = useState<View>("home");
  const [project, setProject] = useState<ProjectScanResult>();
  const [rootInput, setRootInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [formatFilter, setFormatFilter] = useState<ConfigFormat | "all">("all");
  const [activeFile, setActiveFile] = useState<ConfigFile>();
  const [schema, setSchema] = useState<ConfigFormSchema>();
  const [editorTab, setEditorTab] = useState<EditorTab>("form");
  const [busy, setBusy] = useState<BusyState>(null);
  const [toast, setToast] = useState<ToastState>();
  const [externalChange, setExternalChange] = useState(false);
  const [loadError, setLoadError] = useState<LoadErrorState>();
  const [savePreview, setSavePreview] = useState<SavePreview>();
  const [backupStatus, setBackupStatus] = useState<BackupStatus>();
  const [restorePreview, setRestorePreview] = useState<RestoreBackupPreview>();
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [focusFieldRequest, setFocusFieldRequest] = useState<{ file: string; path: string; token: number }>();
  const [focusLineRequest, setFocusLineRequest] = useState<{ file: string; line: number; token: number }>();
  const [pendingAction, setPendingAction] = useState<PendingAction>();
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsPageRevision, setSettingsPageRevision] = useState(0);
  const [pendingSettingsAction, setPendingSettingsAction] = useState<PendingAction>();
  const [afterSaveAction, setAfterSaveAction] = useState<PendingAction>();
  const [appVersion, setAppVersion] = useState("");
  const toastTimer = useRef<number>();
  const openSequence = useRef(0);
  const mainContentRef = useRef<HTMLDivElement>(null);

  const locale: Locale = previewLocale ?? settings?.locale ?? "zh-CN";
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
    translate(locale, key, params);

  const history = useEditorHistory();
  const { values, customFields, canUndo, canRedo } = history;

  const allFields = useMemo(
    () => (schema ? [...schema.fields, ...customFields] : []),
    [schema, customFields],
  );
  const customKeys = useMemo(
    () => new Set(customFields.map((field) => fieldKey(field))),
    [customFields],
  );
  const changes = useMemo(() => schema ? collectChanges(allFields, values) : [], [schema, allFields, values]);
  const errors = useMemo(
    () => schema ? validationErrors(allFields, values, schema.format, locale) : new Map<string, string>(),
    [schema, allFields, values, locale],
  );
  const dirty = useMemo(
    () => (schema ? isEditorDirty(allFields, values) : false),
    [schema, allFields, values],
  );

  const filteredFiles = useMemo(() => {
    const query = fileQuery.trim().toLowerCase();
    return (project?.files ?? []).filter((file) =>
      (formatFilter === "all" || file.format === formatFilter)
      && (!query || file.path.toLowerCase().includes(query)),
    );
  }, [project, fileQuery, formatFilter]);

  const openableFiles = useMemo(
    () => (project?.files ?? []).filter((file) => file.status === "ready" || file.status === "large"),
    [project],
  );

  const activeFileHasEnvGroup = useMemo(
    () => Boolean(activeFile && (project?.envGroups ?? []).some((group) => group.files.includes(activeFile.path))),
    [project, activeFile],
  );

  const secretPathsForExport = useMemo<PathSegment[][]>(
    () => allFields
      .filter((field) => field.secret || field.type === "secret")
      .map((field) => [...field.segments]),
    [allFields],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = locale === "en-US" ? "Confui · Config Editor" : "Confui · 配置编辑器";
  }, [locale]);

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

  const keydownHandlerRef = useRef<(event: KeyboardEvent) => void>();
  keydownHandlerRef.current = (event: KeyboardEvent) => {
    const anyBlockingModal = Boolean(
      savePreview || restorePreview || addKeyOpen || compareOpen || exportOpen || pendingAction || pendingSettingsAction,
    );
    const anyModalOpen = anyBlockingModal || commandPaletteOpen;
    const mod = event.ctrlKey || event.metaKey;
    const lower = event.key.toLowerCase();
    if (mod && lower === "k") {
      event.preventDefault();
      if (commandPaletteOpen) setCommandPaletteOpen(false);
      else if (!anyBlockingModal && busy === null) setCommandPaletteOpen(true);
      return;
    }
    if (mod && lower === "s") {
      event.preventDefault();
      if (view === "editor" && dirty && busy === null && !anyModalOpen) void beginSave();
      return;
    }
    if (mod && lower === "o") {
      event.preventDefault();
      if (!anyModalOpen) requestAction({ kind: "browse" });
      return;
    }
    if (view === "editor" && editorTab === "form" && busy === null && !anyModalOpen && mod) {
      const inEditable = isEditableKeyboardTarget(event.target) || isEditableKeyboardTarget(document.activeElement);
      if (!inEditable) {
        if (lower === "z" && !event.shiftKey && canUndo) {
          event.preventDefault();
          history.undo();
          return;
        }
        if ((lower === "y" || (lower === "z" && event.shiftKey)) && canRedo) {
          event.preventDefault();
          history.redo();
          return;
        }
      }
    }
    if (event.key === "Escape") {
      if (commandPaletteOpen) setCommandPaletteOpen(false);
      else if (savePreview) closeSavePreview();
      else if (restorePreview && busy !== "restore") setRestorePreview(undefined);
      else if (addKeyOpen) setAddKeyOpen(false);
      else if (compareOpen) setCompareOpen(false);
      else if (exportOpen) setExportOpen(false);
      else if (pendingAction) setPendingAction(undefined);
      else if (pendingSettingsAction) setPendingSettingsAction(undefined);
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keydownHandlerRef.current?.(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

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

  async function refreshBackupStatus(root: string, filePath: string, sequence?: number): Promise<void> {
    const status = await window.confui.getBackupStatus(root, filePath);
    if (sequence !== undefined && sequence !== openSequence.current) return;
    if (status.ok) setBackupStatus(status.data);
    else setBackupStatus({ exists: false });
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
      notify(t("toast.selectFolderFirst"), "error");
      return;
    }
    const trimmedGithub = githubUrl.trim();
    if (trimmedGithub && !normalizeGithubUrl(trimmedGithub)) {
      notify(t("toast.invalidGithubUrl"), "error");
      return;
    }
    const sequence = ++openSequence.current;
    setBusy("scan");
    try {
      const result = await window.confui.scanProject(root.trim(), trimmedGithub || undefined);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (sequence !== openSequence.current) return;
      const scanned = result.data;
      const resolvedGithub = scanned.detectedGithubUrl || "";
      setProject(scanned);
      setExternalChange(false);
      setLoadError(undefined);
      setBackupStatus(undefined);
      setRootInput(scanned.root);
      setGithubInput(resolvedGithub);
      setActiveFile(undefined);
      setSchema(undefined);
      history.reset({ values: {}, customFields: [] });
      setView("editor");
      const refreshedSettings = await window.confui.getSettings();
      if (sequence !== openSequence.current) return;
      if (refreshedSettings.ok) setSettings(refreshedSettings.data);
      const first = scanned.files.find((file) => file.status === "ready" || file.status === "large");
      if (first) await loadFile(first, scanned.root, resolvedGithub);
      else if (!scanned.files.length && !(scanned.templates?.length)) notify(t("toast.noSupportedFiles"), "info");
    } catch (error) {
      if (sequence === openSequence.current) notify(errorMessage(error, t("common.actionFailed")), "error");
    } finally {
      if (sequence === openSequence.current) setBusy(null);
    }
  }

  async function openRecent(recent: RecentProject): Promise<void> {
    setRootInput(recent.path);
    setGithubInput(recent.githubUrl ?? "");
    await openProject(recent.path, recent.githubUrl ?? "");
  }

  async function removeRecent(projectPath: string): Promise<void> {
    const result = await window.confui.removeRecentProject(projectPath);
    if (!result.ok) {
      notify(result.error.detail || result.error.message, "error");
      return;
    }
    setSettings(result.data);
  }

  async function loadFile(
    file: ConfigFile,
    root = project?.root,
    githubUrl = githubInput,
    targetLocale = locale,
    focusTarget?: { focusFieldPath?: string; focusLine?: number; openRaw?: boolean },
  ): Promise<void> {
    if (!root) return;
    if (file.status === "too-large" || file.status === "unsupported" || file.status === "unreadable") {
      notify(file.warning || t("toast.fileUnopenable"), "error");
      return;
    }
    const sequence = ++openSequence.current;
    setBusy("infer");
    setActiveFile(file);
    setSchema(undefined);
    setBackupStatus(undefined);
    history.reset({ values: {}, customFields: [] });
    setExternalChange(false);
    setLoadError(undefined);
    setView("editor");
    setEditorTab(focusTarget?.openRaw ? "raw" : "form");
    try {
      const result = await window.confui.inferSchema(root, file.path, {
        githubUrl: githubUrl || undefined,
        locale: targetLocale,
      });
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (sequence !== openSequence.current) return;
      setActiveFile(file);
      setSchema(result.data);
      history.reset({ values: initializeEditorValues(result.data.fields), customFields: [] });
      setExternalChange(false);
      void refreshBackupStatus(root, file.path, sequence);
      if (focusTarget?.focusFieldPath && !focusTarget.openRaw) {
        setFocusFieldRequest({ file: result.data.file, path: focusTarget.focusFieldPath, token: Date.now() });
      } else if (focusTarget?.focusLine && focusTarget.openRaw) {
        setFocusLineRequest({ file: result.data.file, line: focusTarget.focusLine, token: Date.now() });
      }
    } catch (error) {
      if (sequence === openSequence.current) {
        const message = errorMessage(error, t("common.actionFailed"));
        setLoadError({ file: file.path, message });
        notify(message, "error");
      }
    } finally {
      if (sequence === openSequence.current) setBusy(null);
    }
  }

  function requestAction(action: PendingAction): void {
    if (busy !== null || savePreview || restorePreview || addKeyOpen || compareOpen || exportOpen || pendingAction || pendingSettingsAction) return;
    if (view === "settings" && settingsDirty && action.kind !== "settings") {
      setPendingSettingsAction(action);
      return;
    }
    const sameFile = view !== "home" && action.kind === "file" && action.file.path === activeFile?.path;
    if (sameFile && !loadError) {
      setView("editor");
      if (action.openRaw) {
        setEditorTab("raw");
        if (action.focusLine) {
          setFocusLineRequest({ file: action.file.path, line: action.focusLine, token: Date.now() });
        }
      } else if (action.focusFieldPath) {
        setEditorTab("form");
        setFocusFieldRequest({ file: action.file.path, path: action.focusFieldPath, token: Date.now() });
      }
      return;
    }
    if (dirty) setPendingAction(action);
    else void performAction(action);
  }

  async function initTemplate(template: ExampleTemplate): Promise<void> {
    if (!project) return;
    setBusy("scan");
    try {
      const created = await window.confui.createFromExample(
        project.root,
        template.examplePath,
        template.targetPath,
      );
      if (!created.ok) throw new Error(created.error.detail || created.error.message);
      const scanned = await window.confui.scanProject(project.root, githubInput || undefined);
      if (!scanned.ok) throw new Error(scanned.error.detail || scanned.error.message);
      setProject(scanned.data);
      setBusy(null);
      notify(t("toast.templateCreated", { file: created.data.file }), "success");
      const createdFile = scanned.data.files.find(
        (file) => file.path.toLowerCase() === created.data.file.toLowerCase(),
      );
      if (createdFile) {
        await loadFile(createdFile, scanned.data.root, githubInput);
      }
    } catch (error) {
      notify(errorMessage(error, t("common.actionFailed")), "error");
      setBusy(null);
    }
  }

  async function performAction(action: PendingAction): Promise<void> {
    if (view === "settings" && action.kind !== "settings" && settings) {
      applyTheme(settings.theme);
      setPreviewLocale(undefined);
    }
    switch (action.kind) {
      case "file":
        await loadFile(action.file, project?.root, githubInput, locale, {
          focusFieldPath: action.focusFieldPath,
          focusLine: action.focusLine,
          openRaw: action.openRaw,
        });
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
        return;
      case "init-template":
        await initTemplate(action.template);
    }
  }

  async function beginSave(continuation?: PendingAction): Promise<void> {
    if (!schema || !project || !changes.length) return;
    if (errors.size) {
      notify(t("toast.fixFieldErrors", { count: errors.size }), "error");
      setEditorTab("form");
      const firstInvalid = allFields.find((field) => errors.has(fieldKey(field)));
      if (firstInvalid) {
        setFocusFieldRequest({ file: schema.file, path: firstInvalid.path, token: Date.now() });
      } else {
        window.setTimeout(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      }
      return;
    }
    setBusy("preview");
    try {
      const result = await window.confui.previewSave(project.root, schema.file, changes, schema.version);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (!result.data.changes.length) {
        const nextFields = schema.fields.map((field) => ({ ...field, value: effectiveValue(values[fieldKey(field)]) }));
        setSchema({ ...schema, fields: nextFields });
        history.reset({ values: initializeEditorValues(nextFields), customFields: [] });
        setAfterSaveAction(undefined);
        if (continuation) await performAction(continuation);
        return;
      }
      setAfterSaveAction(continuation);
      setSavePreview(result.data);
    } catch (error) {
      setAfterSaveAction(undefined);
      notify(errorMessage(error, t("common.actionFailed")), "error");
    } finally {
      setBusy(null);
    }
  }

  async function confirmSave(): Promise<void> {
    if (!savePreview || !project) return;
    setBusy("save");
    try {
      const result = await window.confui.saveConfig(project.root, savePreview);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      const isActiveTarget = Boolean(schema && savePreview.file === schema.file);
      const hasUnlistedKeys = isActiveTarget && savePreview.operations.some(
        (operation) => !allFields.some((field) => fieldKey(field) === JSON.stringify(operation.segments)),
      );
      setSavePreview(undefined);
      const backupName = result.data.backupPath.split(/[\\/]/).at(-1) ?? ".bak";
      if (isActiveTarget && schema && !hasUnlistedKeys) {
        const reconciled = reconcileSavedState(schema, values, customFields, savePreview, result.data.version);
        setSchema(reconciled.schema);
        history.reset({ values: reconciled.values, customFields: reconciled.customFields });
        setExternalChange(false);
        void refreshBackupStatus(project.root, schema.file);
        notify(t("toast.savedWithBackup", { backup: backupName }), "success");
      } else if (isActiveTarget && schema && activeFile && !dirty) {
        setBusy(null);
        notify(t("toast.savedWithBackup", { backup: backupName }), "success");
        await loadFile(activeFile, project.root, githubInput);
      } else if (isActiveTarget && schema) {
        const reconciled = reconcileSavedState(schema, values, customFields, savePreview, result.data.version);
        setSchema(reconciled.schema);
        history.reset({ values: reconciled.values, customFields: reconciled.customFields });
        setExternalChange(true);
        void refreshBackupStatus(project.root, schema.file);
        notify(t("toast.savedWithBackup", { backup: backupName }), "success");
      } else {
        notify(t("toast.savedWithBackup", { backup: backupName }), "success");
      }
      const action = afterSaveAction;
      setAfterSaveAction(undefined);
      if (action) await performAction(action);
    } catch (error) {
      notify(errorMessage(error, t("common.actionFailed")), "error");
    } finally {
      setBusy(null);
    }
  }

  async function beginRestoreBackup(): Promise<void> {
    if (!project || !schema || busy !== null) return;
    setBusy("preview");
    try {
      const result = await window.confui.previewRestoreBackup(project.root, schema.file, schema.version);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      setRestorePreview(result.data);
    } catch (error) {
      notify(errorMessage(error, t("common.actionFailed")), "error");
    } finally {
      setBusy(null);
    }
  }

  async function confirmRestoreBackup(): Promise<void> {
    if (!project || !activeFile || !restorePreview) return;
    setBusy("restore");
    try {
      const result = await window.confui.restoreBackup(project.root, restorePreview);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      const restoredFile = restorePreview.file;
      setRestorePreview(undefined);
      setBusy(null);
      notify(t("toast.restoredFromBackup", { file: restoredFile }), "success");
      await loadFile(activeFile, project.root, githubInput);
    } catch (error) {
      notify(errorMessage(error, t("common.actionFailed")), "error");
      setBusy(null);
    }
  }

  function discardAndContinue(): void {
    const action = pendingAction;
    setPendingAction(undefined);
    if (schema) history.reset({ values: initializeEditorValues(schema.fields), customFields: [] });
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
    setPreviewLocale(undefined);
    if (action) window.setTimeout(() => void performAction(action), 0);
  }

  async function saveSettings(next: AppSettings): Promise<void> {
    const previousLocale = settings?.locale;
    const result = await window.confui.setSettings(next);
    if (!result.ok) throw new Error(result.error.detail || result.error.message);
    setSettings(result.data);
    setPreviewLocale(undefined);
    applyTheme(result.data.theme);
    // Refresh built-in template descriptions if locale changed while a file is loaded cleanly.
    if (previousLocale !== result.data.locale && activeFile && project && !dirty) {
      void window.confui.inferSchema(project.root, activeFile.path, {
        githubUrl: githubInput || undefined,
        locale: result.data.locale,
      }).then((refreshed) => {
        if (refreshed.ok) {
          setSchema(refreshed.data);
          history.reset({ values: initializeEditorValues(refreshed.data.fields), customFields: [] });
        }
      });
    }
  }

  function updateField(field: FieldSpec, value: unknown, options?: { coalesce?: boolean }): void {
    const key = fieldKey(field);
    history.commit(
      (current) => ({
        ...current,
        values: { ...current.values, [key]: value },
      }),
      options?.coalesce ? { coalesceKey: key } : undefined,
    );
  }

  function resetField(field: FieldSpec): void {
    const key = fieldKey(field);
    history.commit((current) => ({
      ...current,
      values: { ...current.values, [key]: initialFieldEditorValue(field) },
    }));
  }

  function deleteField(field: FieldSpec): void {
    const key = fieldKey(field);
    if (customKeys.has(key)) {
      history.commit((current) => {
        const nextValues = { ...current.values };
        delete nextValues[key];
        return {
          values: nextValues,
          customFields: current.customFields.filter((item) => fieldKey(item) !== key),
        };
      });
      return;
    }
    history.commit((current) => ({
      ...current,
      values: {
        ...current.values,
        [key]: needsJsonEditor(field) ? createJsonDraft(undefined) : undefined,
      },
    }));
  }

  function addCustomField(segments: PathSegment[], type: FieldType, initialValue: unknown): void {
    const spec = createCustomFieldSpec(segments, type, t("common.customGroup"));
    const key = fieldKey(spec);
    const editorVal = needsJsonEditor(spec) ? createJsonDraft(initialValue) : initialValue;
    history.commit((current) => ({
      customFields: [...current.customFields, spec],
      values: { ...current.values, [key]: editorVal },
    }));
  }

  async function askAiAboutField(field: FieldSpec): Promise<FieldAssistResult> {
    if (!project || !schema) throw new Error(t("toast.noOpenConfig"));
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
    const result = await window.confui.explainField(project.root, schema.file, request, githubInput || undefined, locale);
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

  function handleSelectSearchHit(hit: ProjectSearchHit): void {
    if (!project) return;
    const targetFile = project.files.find((file) => file.path === hit.file);
    if (!targetFile) return;
    const openRaw = !hit.path;
    requestAction({
      kind: "file",
      file: targetFile,
      focusFieldPath: hit.path,
      focusLine: hit.line,
      openRaw,
    });
  }

  function quickSwitchTheme(theme: ThemePreference): void {
    if (!settings) return;
    void saveSettings({ ...settings, theme }).catch((err) => {
      notify(errorMessage(err, t("settings.toastSaveFailed")), "error");
    });
  }

  function quickSwitchLocale(nextLocale: Locale): void {
    if (!settings) return;
    void saveSettings({ ...settings, locale: nextLocale }).catch((err) => {
      notify(errorMessage(err, t("settings.toastSaveFailed")), "error");
    });
  }

  const paletteCommands: PaletteCommand[] = settings
    ? [
      {
        id: "save",
        label: t("palette.cmdSave"),
        description: schema ? schema.file : undefined,
        keywords: "save write commit 保存",
        shortcut: "Ctrl+S",
        icon: "save",
        disabled: !(view === "editor" && schema && changes.length > 0 && errors.size === 0),
        run: () => void beginSave(),
      },
      {
        id: "restore-backup",
        label: t("palette.cmdRestore"),
        description: schema ? `${schema.file}.bak` : undefined,
        keywords: "backup rollback restore bak 恢复 备份",
        icon: "history",
        disabled: !(view === "editor" && schema && backupStatus?.exists),
        run: () => void beginRestoreBackup(),
      },
      {
        id: "compare-sync",
        label: t("palette.cmdCompare"),
        description: t("editor.compareTooltip"),
        keywords: "compare diff sync env 对比 补齐",
        icon: "compare",
        disabled: !(project && openableFiles.length >= 2),
        run: () => setCompareOpen(true),
      },
      {
        id: "export-redacted",
        label: t("palette.cmdExportRedacted"),
        description: schema?.file,
        keywords: "export redact mask share template 导出 脱敏",
        icon: "download",
        disabled: !(view === "editor" && schema),
        run: () => setExportOpen(true),
      },
      {
        id: "add-key",
        label: t("palette.cmdAddKey"),
        description: schema?.file,
        keywords: "add key field new 新增 字段",
        icon: "plus",
        disabled: !(view === "editor" && schema),
        run: () => setAddKeyOpen(true),
      },
      {
        id: "toggle-tab",
        label: editorTab === "form" ? t("palette.cmdViewRaw") : t("palette.cmdViewForm"),
        keywords: "form raw source tab 表单 原始",
        icon: editorTab === "form" ? "code" : "layers",
        disabled: !(view === "editor" && schema),
        run: () => selectEditorTab(editorTab === "form" ? "raw" : "form"),
      },
      {
        id: "rescan",
        label: t("palette.cmdRescan"),
        description: project?.name,
        keywords: "rescan refresh project 重扫 刷新",
        icon: "refresh",
        disabled: !project,
        run: () => requestAction({ kind: "rescan" }),
      },
      {
        id: "open-folder",
        label: t("palette.cmdOpenFolder"),
        keywords: "open folder project browse 打开 项目",
        shortcut: "Ctrl+O",
        icon: "folder-open",
        run: () => requestAction({ kind: "browse" }),
      },
      {
        id: "theme-light",
        label: t("palette.cmdThemeLight"),
        keywords: "theme light appearance 浅色 主题",
        icon: "sparkles",
        disabled: settings.theme === "light" || (view === "settings" && settingsDirty),
        run: () => quickSwitchTheme("light"),
      },
      {
        id: "theme-dark",
        label: t("palette.cmdThemeDark"),
        keywords: "theme dark appearance 深色 主题",
        icon: "sparkles",
        disabled: settings.theme === "dark" || (view === "settings" && settingsDirty),
        run: () => quickSwitchTheme("dark"),
      },
      {
        id: "theme-system",
        label: t("palette.cmdThemeSystem"),
        keywords: "theme system appearance 跟随系统 主题",
        icon: "sparkles",
        disabled: settings.theme === "system" || (view === "settings" && settingsDirty),
        run: () => quickSwitchTheme("system"),
      },
      {
        id: "locale-toggle",
        label: locale === "zh-CN" ? t("palette.cmdSwitchEn") : t("palette.cmdSwitchZh"),
        keywords: "language locale english chinese 语言 中文 英文",
        icon: "info",
        disabled: view === "settings" && settingsDirty,
        run: () => quickSwitchLocale(locale === "zh-CN" ? "en-US" : "zh-CN"),
      },
      {
        id: "go-settings",
        label: t("palette.cmdSettings"),
        keywords: "settings preferences ai github 设置",
        icon: "settings",
        disabled: view === "settings",
        run: () => requestAction({ kind: "settings" }),
      },
      {
        id: "go-home",
        label: t("palette.cmdHome"),
        keywords: "home start recent 开始 首页",
        icon: "home",
        disabled: view === "home",
        run: () => requestAction({ kind: "home" }),
      },
    ]
    : [];

  if (!settings) {
    return (
      <I18nProvider locale={locale}>
        <div class="app-loading">
          <Logo/>
          <span><Icon name="loader" class="spin"/>{t("common.loadingApp")}</span>
        </div>
      </I18nProvider>
    );
  }

  return (
    <I18nProvider locale={locale}>
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
          onInitTemplate={(template) => requestAction({ kind: "init-template", template })}
        />

        <main class="main-shell" onWheel={forwardMainWheel}>
          <header class="topbar">
            <div class="topbar__title">
              {view === "home"
                ? <><span>{t("topbar.homeTitle")}</span><small>{t("topbar.homeSubtitle")}</small></>
                : view === "settings"
                  ? <><span>{t("topbar.settingsTitle")}</span><small>{t("topbar.settingsSubtitle")}</small></>
                  : schema
                    ? <><span>{schema.kind}{dirty && <i class="title-dirty"/>}</span><small title={schema.file}>{schema.file}</small></>
                    : <><span>{project?.name ?? t("topbar.editorFallbackTitle")}</span><small>{t("topbar.editorFallbackSubtitle")}</small></>}
            </div>
            <div class="topbar__actions">
              <button
                type="button"
                class="palette-trigger"
                disabled={busy !== null}
                onClick={() => setCommandPaletteOpen(true)}
                title={t("palette.triggerTooltip")}
              >
                <Icon name="search" size={14}/>
                <span>{t("palette.triggerLabel")}</span>
                <kbd>Ctrl+K</kbd>
              </button>
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
                      <Icon name="layers" size={15}/>{t("topbar.tabForm")}
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
                      <Icon name="code" size={15}/>{t("topbar.tabRaw")}
                    </button>
                  </div>
                  <Button
                    variant="primary"
                    icon="save"
                    disabled={!changes.length || errors.size > 0 || busy !== null}
                    busy={busy === "preview" || busy === "save"}
                    onClick={() => void beginSave()}
                  >
                    {changes.length ? t("topbar.saveCount", { count: changes.length }) : t("topbar.saved")}
                  </Button>
                </>
              )}
              {view === "home" && (
                <Button icon="folder-open" disabled={busy !== null} onClick={() => void browseForProject()}>
                  {t("topbar.chooseFolder")}
                </Button>
              )}
            </div>
          </header>

          {externalChange && view === "editor" && (
            <div class="external-banner" role="status">
              <Icon name="warning"/>
              <div>
                <strong>{t("external.title")}</strong>
                <span>{dirty ? t("external.dirtyHint") : t("external.cleanHint")}</span>
              </div>
              <Button onClick={() => requestAction({ kind: "reload" })}>{t("external.reload")}</Button>
              <button class="icon-button" onClick={() => setExternalChange(false)} aria-label={t("external.dismiss")}>
                <Icon name="x"/>
              </button>
            </div>
          )}

          <div ref={mainContentRef} class="main-content" role="region" aria-label={t("topbar.pageContent")} tabIndex={0}>
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
                onDropFolder={(folderPath) => {
                  setRootInput(folderPath);
                  void openProject(folderPath, githubInput);
                }}
                onDropInvalid={(message) => notify(message, "error")}
                onRecent={(item) => void openRecent(item)}
                onRemoveRecent={(path) => void removeRecent(path)}
              />
            )}

            {view === "settings" && (
              <SettingsPage
                key={settingsPageRevision}
                settings={settings}
                onSave={saveSettings}
                onThemePreview={applyTheme}
                onLocalePreview={setPreviewLocale}
                onToast={notify}
                onDirtyChange={setSettingsDirty}
              />
            )}

            {view === "editor" && busy === "infer" && !schema && <EditorSkeleton/>}

            {view === "editor" && !schema && busy !== "infer" && loadError?.file === activeFile?.path ? (
              <div class="editor-load-error" role="alert">
                <span class="editor-load-error__icon"><Icon name="warning"/></span>
                <h1>{t("editor.loadErrorTitle")}</h1>
                <p>{loadError?.message}</p>
                <Button variant="primary" icon="refresh" onClick={() => activeFile && void loadFile(activeFile)}>{t("common.retry")}</Button>
              </div>
            ) : view === "editor" && !schema && busy !== "infer" && (
              <div class="editor-empty">
                <EmptyIllustration/>
                <h1>
                  {project?.files.length
                    ? t("editor.emptySelectTitle")
                    : project?.templates?.length
                      ? t("editor.emptyTemplatesTitle")
                      : t("editor.emptyNoneTitle")}
                </h1>
                <p>
                  {project?.files.length
                    ? t("editor.emptySelectDesc")
                    : project?.templates?.length
                      ? t("editor.emptyTemplatesDesc", { count: project.templates.length })
                      : t("editor.emptyNoneDesc")}
                </p>
                {!project && (
                  <Button variant="primary" icon="folder-open" onClick={() => void browseForProject()}>
                    {t("editor.openLocalProject")}
                  </Button>
                )}
              </div>
            )}

            {view === "editor" && schema && editorTab === "form" && (
              <div id="editor-panel-form" class="editor-page page-wide" role="tabpanel" aria-labelledby="editor-tab-form">
                <EditorSummary
                  schema={schema}
                  fieldCount={allFields.length}
                  backupStatus={backupStatus}
                  busy={busy !== null}
                  canCompare={openableFiles.length >= 2}
                  hasEnvGroup={activeFileHasEnvGroup}
                  onOpenCompare={() => setCompareOpen(true)}
                  onOpenExportRedacted={() => setExportOpen(true)}
                  onRestoreBackup={() => void beginRestoreBackup()}
                />
                {allFields.length ? (
                  <FieldEditor
                    fileKey={`${project?.root ?? ""}:${schema.file}`}
                    fields={allFields}
                    customKeys={customKeys}
                    values={values}
                    errors={errors}
                    disabled={busy !== null}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    onUndo={history.undo}
                    onRedo={history.redo}
                    onOpenAddKey={() => setAddKeyOpen(true)}
                    onResetField={resetField}
                    onDeleteField={deleteField}
                    aiAvailable={settings.ai.enabled && Boolean(settings.ai.baseUrl.trim() && settings.ai.model.trim())}
                    onExplain={askAiAboutField}
                    onChange={updateField}
                    focusRequest={focusFieldRequest?.file === schema.file ? focusFieldRequest : undefined}
                  />
                ) : (
                  <div class="empty-card">
                    <Icon name="info"/>
                    <div>
                      <h2>{t("editor.noFormTitle")}</h2>
                      <p>{t("editor.noFormDesc")}</p>
                      <Button variant="primary" icon="plus" onClick={() => setAddKeyOpen(true)} class="empty-card__action">
                        {t("field.addKey")}
                      </Button>
                    </div>
                  </div>
                )}
                <div class="editor-bottom-space"/>
              </div>
            )}

            {view === "editor" && schema && editorTab === "raw" && (
              <RawViewer
                schema={schema}
                fields={allFields}
                focusLine={focusLineRequest?.file === schema.file ? focusLineRequest : undefined}
              />
            )}
          </div>

          {view === "editor" && schema && changes.length > 0 && (
            <div class="editor-savebar">
              <div>
                <i/>
                <strong>{t("savebar.unsavedCount", { count: changes.length })}</strong>
                {errors.size > 0 && <span>{t("savebar.errorCount", { count: errors.size })}</span>}
              </div>
              <div>
                <Button
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => history.commit(() => ({ values: initializeEditorValues(schema.fields), customFields: [] }))}
                >
                  {t("savebar.revertAll")}
                </Button>
                <Button
                  variant="primary"
                  icon="save"
                  disabled={errors.size > 0 || busy !== null}
                  busy={busy === "preview"}
                  onClick={() => void beginSave()}
                >
                  {t("savebar.reviewAndSave")}
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
            <button class="icon-button" onClick={() => setToast(undefined)} aria-label={t("common.closeToast")}>
              <Icon name="x" size={15}/>
            </button>
          </div>
        )}

        {savePreview && (
          <SaveConfirmModal
            savePreview={savePreview}
            schema={schema}
            allFields={allFields}
            saving={busy === "save"}
            onClose={closeSavePreview}
            onConfirm={() => void confirmSave()}
          />
        )}

        {restorePreview && (
          <RestoreBackupModal
            preview={restorePreview}
            fields={schema?.file === restorePreview.file ? allFields : undefined}
            restoring={busy === "restore"}
            onClose={() => { if (busy !== "restore") setRestorePreview(undefined); }}
            onConfirm={() => void confirmRestoreBackup()}
          />
        )}

        {addKeyOpen && schema && (
          <AddKeyModal
            format={schema.format}
            existingFields={allFields}
            onClose={() => setAddKeyOpen(false)}
            onAdd={addCustomField}
          />
        )}

        {compareOpen && project && openableFiles.length >= 2 && (
          <CompareSyncModal
            projectRoot={project.root}
            openableFiles={openableFiles}
            envGroups={project.envGroups ?? []}
            activeFilePath={activeFile?.path}
            activeFileDirty={dirty}
            onClose={() => setCompareOpen(false)}
            onPreviewReady={(preview) => {
              if (dirty && schema && preview.file === schema.file) {
                notify(t("compare.targetDirtyBlocked", { file: preview.file }), "error");
                return;
              }
              setCompareOpen(false);
              setSavePreview(preview);
            }}
          />
        )}

        {exportOpen && project && schema && (
          <ExportRedactedModal
            projectRoot={project.root}
            file={schema.file}
            secretPaths={secretPathsForExport}
            onClose={() => setExportOpen(false)}
            onToast={notify}
          />
        )}

        {commandPaletteOpen && (
          <CommandPalette
            project={project}
            openableFiles={openableFiles}
            commands={paletteCommands}
            onClose={() => setCommandPaletteOpen(false)}
            onSelectFile={(file) => requestAction({ kind: "file", file })}
            onSelectSearchHit={handleSelectSearchHit}
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
    </I18nProvider>
  );
}
