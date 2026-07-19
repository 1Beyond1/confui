import { useEffect, useMemo, useState } from "preact/hooks";
import type { AppInfo, AppSettings, ThemePreference, UpdateCheckResult } from "../../shared/schema.ts";
import { Icon } from "./icons.tsx";
import { Button } from "./ui.tsx";

const PROVIDERS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  { id: "ollama", label: "Ollama（本地）", baseUrl: "http://127.0.0.1:11434/v1", model: "" },
  { id: "custom", label: "自定义供应商", baseUrl: "", model: "" },
] as const;

export function SettingsPage({
  settings,
  onSave,
  onThemePreview,
  onToast,
  onDirtyChange,
}: {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onThemePreview: (theme: ThemePreference) => void;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  useEffect(() => setDraft(structuredClone(settings)), [settings]);
  useEffect(() => {
    void window.confui.getAppInfo().then((result) => {
      if (result.ok) setAppInfo(result.data);
    });
  }, []);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings), [draft, settings]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const setAi = (patch: Partial<AppSettings["ai"]>) => setDraft((current) => ({
    ...current,
    ai: { ...current.ai, ...patch },
  }));

  async function save(): Promise<void> {
    if (draft.ai.enabled && (!draft.ai.baseUrl || !draft.ai.model)) {
      onToast("启用 AI 后需要填写 Base URL 和模型名称", "error");
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      onToast("设置已安全保存", "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "设置保存失败", "error");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection(): Promise<void> {
    if (!draft.ai.baseUrl || !draft.ai.model) {
      onToast("请先填写 Base URL 和模型名称", "error");
      return;
    }
    setTesting(true);
    try {
      const result = await window.confui.testAI(draft.ai);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      onToast(`连接成功 · ${result.data.latencyMs} ms`, "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "连接测试失败", "error");
    } finally {
      setTesting(false);
    }
  }

  function chooseProvider(id: string): void {
    const provider = PROVIDERS.find((item) => item.id === id) ?? PROVIDERS.at(-1)!;
    setAi({
      provider: provider.id,
      ...(provider.id !== "custom" ? { baseUrl: provider.baseUrl, model: provider.model } : {}),
    });
  }

  async function checkUpdates(): Promise<void> {
    setCheckingUpdate(true);
    try {
      const result = await window.confui.checkForUpdates();
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      setUpdateResult(result.data);
      const currentRelease = result.data.currentVersion === result.data.latestVersion;
      onToast(
        result.data.updateAvailable
          ? `发现新版本 v${result.data.latestVersion}`
          : currentRelease ? "当前已是最新版本" : "当前版本已领先于公开版本",
        result.data.updateAvailable ? "info" : "success",
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : "检查更新失败", "error");
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function openReleasePage(): Promise<void> {
    const result = await window.confui.openReleasePage();
    if (!result.ok) onToast(result.error.detail || result.error.message, "error");
  }

  return (
    <div class="settings-page page-narrow">
      <div class="page-heading">
        <div>
          <p class="eyebrow">偏好设置</p>
          <h1>设置</h1>
          <p>连接你自己的 AI 服务，并控制 Confui 在这台电脑上的显示方式。</p>
        </div>
      </div>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--violet"><Icon name="sparkles"/></span>
          <div><h2>AI 字段分析</h2><p>只在 Schema、模板、示例和 README 仍无法说明字段时补充分析。</p></div>
          <button
            type="button"
            class={`toggle ${draft.ai.enabled ? "toggle--on" : ""}`}
            role="switch"
            aria-label="启用 AI 字段分析"
            aria-checked={draft.ai.enabled}
            onClick={() => setAi({ enabled: !draft.ai.enabled })}
          ><i/></button>
        </header>
        <div class={`settings-card__body ${!draft.ai.enabled ? "settings-card__body--disabled" : ""}`}>
          <div class="settings-grid">
            <label class="setting-field">
              <span>供应商</span>
              <div class="select-wrap">
                <select class="control" value={draft.ai.provider} disabled={!draft.ai.enabled} onChange={(event) => chooseProvider(event.currentTarget.value)}>
                  {PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                </select>
                <Icon name="chevron-down" size={16}/>
              </div>
            </label>
            <label class="setting-field">
              <span>模型名称</span>
              <input class="control" value={draft.ai.model} disabled={!draft.ai.enabled} placeholder="例如 gpt-4.1-mini" onInput={(event) => setAi({ model: event.currentTarget.value })}/>
            </label>
            <label class="setting-field setting-field--wide">
              <span>Base URL</span>
              <input class="control" value={draft.ai.baseUrl} disabled={!draft.ai.enabled} placeholder="https://api.example.com/v1" onInput={(event) => setAi({ baseUrl: event.currentTarget.value })}/>
              <small>兼容 OpenAI 的 /chat/completions 接口；也可以填写本地 Ollama。</small>
            </label>
            <div class="setting-field setting-field--wide">
              <label for="settings-ai-api-key">API Key</label>
              <div class="input-with-action">
                <input id="settings-ai-api-key" class="control" type={showApiKey ? "text" : "password"} value={draft.ai.apiKey} disabled={!draft.ai.enabled} autocomplete="off" placeholder="本地模型可留空" onInput={(event) => setAi({ apiKey: event.currentTarget.value })}/>
                <button class="icon-button" type="button" disabled={!draft.ai.enabled} onClick={() => setShowApiKey(!showApiKey)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}><Icon name={showApiKey ? "eye-off" : "eye"}/></button>
              </div>
              <small class="secure-note"><Icon name="shield" size={14}/>使用 Windows 安全存储加密，不会写入项目文件。</small>
            </div>
          </div>
          <div class="settings-inline-action">
            <Button icon="refresh" onClick={() => void testConnection()} busy={testing} disabled={!draft.ai.enabled || testing}>测试连接</Button>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--neutral"><Icon name="github"/></span>
          <div><h2>GitHub 文档</h2><p>本地没有 README 时，使用仓库链接补充读取；私有仓库需要 Token。</p></div>
        </header>
        <div class="settings-card__body">
          <div class="setting-field setting-field--wide">
            <label for="settings-github-token">Personal Access Token <em>可选</em></label>
            <div class="input-with-action">
              <input id="settings-github-token" class="control" type={showGithubToken ? "text" : "password"} value={draft.github.token} autocomplete="off" placeholder="github_pat_..." onInput={(event) => setDraft((current) => ({ ...current, github: { token: event.currentTarget.value } }))}/>
              <button class="icon-button" type="button" onClick={() => setShowGithubToken(!showGithubToken)} aria-label={showGithubToken ? "隐藏 GitHub Token" : "显示 GitHub Token"}><Icon name={showGithubToken ? "eye-off" : "eye"}/></button>
            </div>
            <small>公开仓库通常无需填写。Token 同样会加密保存。</small>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--blue"><Icon name="layers"/></span>
          <div><h2>外观</h2><p>可以跟随 Windows，也可以固定为浅色或深色。</p></div>
        </header>
        <div class="settings-card__body">
          <div class="theme-picker">
            {(["system", "light", "dark"] as ThemePreference[]).map((theme) => (
              <button
                key={theme}
                type="button"
                class={draft.theme === theme ? "active" : ""}
                aria-pressed={draft.theme === theme}
                onClick={() => {
                  setDraft((current) => ({ ...current, theme }));
                  onThemePreview(theme);
                }}
              >
                <span class={`theme-preview theme-preview--${theme}`}><i/><i/></span>
                <strong>{theme === "system" ? "跟随系统" : theme === "light" ? "浅色" : "深色"}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--blue"><Icon name="refresh"/></span>
          <div><h2>软件更新</h2><p>从 GitHub Release 检查 Confui 是否有新版本。</p></div>
        </header>
        <div class="settings-card__body">
          <div class={`update-panel ${updateResult?.updateAvailable ? "update-panel--available" : ""}`}>
            <div class="update-status">
              <span class="update-status__icon"><Icon name={updateResult?.updateAvailable ? "sparkles" : "check"}/></span>
              <div class="update-status__copy">
                <strong>{appInfo ? `当前版本 v${appInfo.version}` : "正在读取当前版本"}</strong>
                <p>{updateResult
                  ? updateResult.updateAvailable
                    ? `发现 v${updateResult.latestVersion} · ${updateResult.releaseName}`
                    : updateResult.currentVersion === updateResult.latestVersion
                      ? `已是最新版本 v${updateResult.latestVersion}`
                      : `当前版本已领先于公开版本 v${updateResult.latestVersion}`
                  : "点击按钮检查 GitHub 上的最新 Release"}</p>
              </div>
            </div>
            <div class="update-actions">
              <Button icon="refresh" busy={checkingUpdate} disabled={checkingUpdate} onClick={() => void checkUpdates()}>检查更新</Button>
              {updateResult?.updateAvailable && <Button variant="primary" icon="external-link" onClick={() => void openReleasePage()}>打开下载页</Button>}
            </div>
          </div>
        </div>
      </section>

      <div class={`settings-savebar ${dirty ? "settings-savebar--visible" : ""}`}>
        <span>{dirty ? "设置有未保存的更改" : "设置已保存"}</span>
        <div>
          {dirty && <Button variant="ghost" onClick={() => { setDraft(structuredClone(settings)); onThemePreview(settings.theme); }}>撤销</Button>}
          <Button variant="primary" icon="save" disabled={!dirty || saving} busy={saving} onClick={() => void save()}>保存设置</Button>
        </div>
      </div>
    </div>
  );
}
