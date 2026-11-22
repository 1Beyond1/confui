import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AppInfo, AppSettings, Locale, ThemePreference, UpdateCheckResult } from "../../shared/schema.ts";
import { canReuseStoredAiApiKey } from "../../shared/validation.ts";
import { translate, useI18n } from "./i18n/index.tsx";
import { Icon } from "./icons.tsx";
import { Button } from "./ui.tsx";

const PROVIDER_DEFS = [
  { id: "openai", staticLabel: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  { id: "deepseek", staticLabel: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { id: "openrouter", staticLabel: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "" },
  { id: "ollama", labelKey: "settings.providerOllama" as const, baseUrl: "http://127.0.0.1:11434/v1", model: "" },
  { id: "custom", labelKey: "settings.providerCustom" as const, baseUrl: "", model: "" },
] as const;

export function SettingsPage({
  settings,
  onSave,
  onThemePreview,
  onLocalePreview,
  onToast,
  onDirtyChange,
}: {
  settings: AppSettings;
  onSave: (settings: AppSettings) => Promise<void>;
  onThemePreview: (theme: ThemePreference) => void;
  onLocalePreview: (locale: Locale) => void;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const [draft, setDraft] = useState<AppSettings>(() => structuredClone(settings));
  const [clearApiKey, setClearApiKey] = useState(false);
  const [clearGithubToken, setClearGithubToken] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo>();
  const [updateResult, setUpdateResult] = useState<UpdateCheckResult>();
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const testRun = useRef(0);
  const [apiKeysByProvider, setApiKeysByProvider] = useState<Record<string, string>>(() => ({
    [settings.ai.provider]: settings.ai.apiKey,
  }));

  useEffect(() => {
    setDraft(structuredClone(settings));
    setClearApiKey(false);
    setClearGithubToken(false);
  }, [settings]);
  useEffect(() => setApiKeysByProvider({ [settings.ai.provider]: settings.ai.apiKey }), [settings]);
  useEffect(() => {
    void window.confui.getAppInfo().then((result) => {
      if (result.ok) setAppInfo(result.data);
    });
  }, []);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(settings) || clearApiKey || clearGithubToken,
    [draft, settings, clearApiKey, clearGithubToken],
  );
  const aiErrors = useMemo(() => validateAiDraft(draft.ai, locale), [draft.ai, locale]);
  const locked = settings.lockedSecrets;
  const apiKeyOriginMatches = canReuseStoredAiApiKey(settings.ai, draft.ai);
  const apiKeyOriginChanged = Boolean(
    (settings.secrets?.hasApiKey || locked?.apiKey)
    && !apiKeyOriginMatches,
  );
  const hasStoredApiKey = Boolean(
    settings.secrets?.hasApiKey
    && apiKeyOriginMatches
    && !clearApiKey,
  );
  const canClearStoredApiKey = Boolean(
    (settings.secrets?.hasApiKey || locked?.apiKey)
    && apiKeyOriginMatches
    && !draft.ai.apiKey,
  );
  const hasStoredGithubToken = Boolean(settings.secrets?.hasGithubToken && !clearGithubToken);
  const canClearStoredGithubToken = Boolean(
    (settings.secrets?.hasGithubToken || locked?.githubToken)
    && !draft.github.token,
  );

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const setAi = (patch: Partial<AppSettings["ai"]>) => {
    testRun.current += 1;
    if (patch.apiKey) setClearApiKey(false);
    setDraft((current) => {
      const nextAi = { ...current.ai, ...patch };
      if ((patch.baseUrl !== undefined || patch.provider !== undefined) && !canReuseStoredAiApiKey(settings.ai, nextAi)) {
        setClearApiKey(false);
      }
      return { ...current, ai: nextAi };
    });
  };

  async function save(): Promise<void> {
    if (saving || testing) return;
    if (Object.keys(aiErrors).length) {
      onToast(t("settings.fixAiErrors"), "error");
      focusFirstAiError(aiErrors);
      return;
    }
    setSaving(true);
    try {
      const payload: AppSettings = {
        ...draft,
        clearSecrets: clearApiKey || clearGithubToken
          ? {
            apiKey: clearApiKey || undefined,
            githubToken: clearGithubToken || undefined,
          }
          : undefined,
      };
      await onSave(payload);
      onToast(translate(draft.locale, "settings.toastSaved"), "success");
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("settings.toastSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  }

  const shortcutRef = useRef({ dirty, saving, testing, save });
  shortcutRef.current = { dirty, saving, testing, save };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      const latest = shortcutRef.current;
      if (latest.dirty && !latest.saving && !latest.testing) void latest.save();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  async function testConnection(): Promise<void> {
    if (testing || saving) return;
    if (Object.keys(aiErrors).length) {
      onToast(t("settings.fixAiErrors"), "error");
      focusFirstAiError(aiErrors);
      return;
    }
    const run = ++testRun.current;
    const testedAi = {
      ...structuredClone(draft.ai),
      useStoredApiKey: !draft.ai.apiKey && hasStoredApiKey,
    };
    setTesting(true);
    try {
      const result = await window.confui.testAI(testedAi);
      if (!result.ok) throw new Error(result.error.detail || result.error.message);
      if (run !== testRun.current) return;
      onToast(t("settings.testSuccess", { ms: result.data.latencyMs }), "success");
    } catch (error) {
      if (run !== testRun.current) return;
      onToast(error instanceof Error ? error.message : t("settings.testFailed"), "error");
    } finally {
      setTesting(false);
    }
  }

  function chooseProvider(id: string): void {
    const provider = PROVIDER_DEFS.find((item) => item.id === id) ?? PROVIDER_DEFS.at(-1)!;
    setApiKeysByProvider((current) => ({ ...current, [draft.ai.provider]: draft.ai.apiKey }));
    setClearApiKey(false);
    setAi({
      provider: provider.id,
      apiKey: apiKeysByProvider[provider.id] ?? "",
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
          ? t("settings.toastNewVersion", { version: result.data.latestVersion })
          : currentRelease ? t("settings.toastLatest") : t("settings.toastAhead"),
        result.data.updateAvailable ? "info" : "success",
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : t("settings.toastUpdateFailed"), "error");
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
          <p class="eyebrow">{t("settings.eyebrow")}</p>
          <h1>{t("settings.title")}</h1>
          <p>{t("settings.subtitle")}</p>
        </div>
      </div>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--violet"><Icon name="sparkles"/></span>
          <div><h2>{t("settings.aiTitle")}</h2><p>{t("settings.aiDesc")}</p></div>
          <button
            type="button"
            class={`toggle ${draft.ai.enabled ? "toggle--on" : ""}`}
            role="switch"
            aria-label={t("settings.aiEnableAria")}
            aria-checked={draft.ai.enabled}
            disabled={saving || testing}
            onClick={() => setAi({ enabled: !draft.ai.enabled })}
          ><i/></button>
        </header>
        <div class={`settings-card__body ${!draft.ai.enabled ? "settings-card__body--disabled" : ""}`}>
          <div class="settings-grid">
            <label class="setting-field">
              <span>{t("settings.provider")}</span>
              <div class="select-wrap">
                <select class="control" value={draft.ai.provider} disabled={!draft.ai.enabled || saving || testing} onChange={(event) => chooseProvider(event.currentTarget.value)}>
                  {PROVIDER_DEFS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {"labelKey" in provider ? t(provider.labelKey) : provider.staticLabel}
                    </option>
                  ))}
                </select>
                <Icon name="chevron-down" size={16}/>
              </div>
            </label>
            <label class="setting-field">
              <span>{t("settings.model")}</span>
              <input id="settings-ai-model" class="control" value={draft.ai.model} disabled={!draft.ai.enabled || saving || testing} aria-invalid={Boolean(aiErrors.model)} aria-describedby={aiErrors.model ? "settings-ai-model-error" : undefined} placeholder={t("settings.modelPlaceholder")} onInput={(event) => setAi({ model: event.currentTarget.value })}/>
              {aiErrors.model && <small id="settings-ai-model-error" class="field-error"><Icon name="warning" size={14}/>{aiErrors.model}</small>}
            </label>
            <label class="setting-field setting-field--wide">
              <span>{t("settings.baseUrl")}</span>
              <input id="settings-ai-base-url" class="control" value={draft.ai.baseUrl} disabled={!draft.ai.enabled || saving || testing} aria-invalid={Boolean(aiErrors.baseUrl)} aria-describedby={aiErrors.baseUrl ? "settings-ai-base-url-error" : undefined} placeholder="https://api.example.com/v1" onInput={(event) => setAi({ baseUrl: event.currentTarget.value })}/>
              {aiErrors.baseUrl && <small id="settings-ai-base-url-error" class="field-error"><Icon name="warning" size={14}/>{aiErrors.baseUrl}</small>}
              <small>{t("settings.baseUrlHint")}</small>
            </label>
            <div class="setting-field setting-field--wide">
              <label for="settings-ai-api-key">{t("settings.apiKey")}</label>
              <div class="input-with-action">
                <input
                  id="settings-ai-api-key"
                  class="control"
                  type={showApiKey ? "text" : "password"}
                  value={draft.ai.apiKey}
                  maxlength={8_000}
                  disabled={!draft.ai.enabled || saving || testing}
                  autocomplete="off"
                  placeholder={clearApiKey
                    ? t("settings.apiKeyClearPlaceholder")
                    : apiKeyOriginChanged
                      ? t("settings.apiKeyReenterPlaceholder")
                      : hasStoredApiKey
                        ? t("settings.apiKeyStoredPlaceholder", { hint: settings.secrets?.apiKeyHint ?? "••••" })
                        : t("settings.apiKeyLocalPlaceholder")}
                  onInput={(event) => setAi({ apiKey: event.currentTarget.value })}
                />
                <button class="icon-button" type="button" disabled={!draft.ai.enabled || saving || testing} onClick={() => setShowApiKey(!showApiKey)} aria-label={showApiKey ? t("settings.hideApiKey") : t("settings.showApiKey")}><Icon name={showApiKey ? "eye-off" : "eye"}/></button>
                {canClearStoredApiKey && (
                  <button
                    class="icon-button"
                    type="button"
                    disabled={(!draft.ai.enabled && !locked?.apiKey) || saving || testing}
                    onClick={() => {
                      testRun.current += 1;
                      setClearApiKey(!clearApiKey);
                    }}
                    title={clearApiKey ? t("settings.undoClearApiKey") : t("settings.clearApiKey")}
                    aria-label={clearApiKey ? t("settings.undoClearApiKey") : t("settings.clearApiKey")}
                  >
                    <Icon name={clearApiKey ? "refresh" : "x"} size={15}/>
                  </button>
                )}
              </div>
              {clearApiKey
                ? <small class="secure-note"><Icon name="shield" size={14}/>{t("settings.apiKeyClearing")}</small>
                : apiKeyOriginChanged && !draft.ai.apiKey
                  ? <small class="secure-note secure-note--locked"><Icon name="warning" size={14}/>{t("settings.apiKeyOriginChanged")}</small>
                  : locked?.apiKey
                    ? <small class="secure-note secure-note--locked"><Icon name="shield" size={14}/>{t("settings.apiKeyLocked")}</small>
                    : hasStoredApiKey
                      ? <small class="secure-note"><Icon name="shield" size={14}/>{t("settings.apiKeyStored", { hint: settings.secrets?.apiKeyHint ?? "••••" })}</small>
                      : <small class="secure-note"><Icon name="shield" size={14}/>{t("settings.apiKeyDefaultNote")}</small>}
            </div>
          </div>
          <div class="settings-inline-action">
            <Button icon="refresh" onClick={() => void testConnection()} busy={testing} disabled={!draft.ai.enabled || testing || saving}>{t("settings.testConnection")}</Button>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--neutral"><Icon name="github"/></span>
          <div><h2>{t("settings.githubTitle")}</h2><p>{t("settings.githubDesc")}</p></div>
        </header>
        <div class="settings-card__body">
          <div class="setting-field setting-field--wide">
            <label for="settings-github-token">{t("settings.githubTokenLabel")} <em>{t("settings.optional")}</em></label>
            <div class="input-with-action">
              <input
                id="settings-github-token"
                class="control"
                type={showGithubToken ? "text" : "password"}
                value={draft.github.token}
                maxlength={8_000}
                disabled={saving}
                autocomplete="off"
                placeholder={clearGithubToken
                  ? t("settings.githubClearPlaceholder")
                  : hasStoredGithubToken
                    ? t("settings.githubStoredPlaceholder", { hint: settings.secrets?.githubTokenHint ?? "••••" })
                    : "github_pat_..."}
                onInput={(event) => {
                  const nextToken = event.currentTarget.value;
                  if (nextToken) setClearGithubToken(false);
                  setDraft((current) => ({ ...current, github: { token: nextToken } }));
                }}
              />
              <button class="icon-button" type="button" disabled={saving} onClick={() => setShowGithubToken(!showGithubToken)} aria-label={showGithubToken ? t("settings.hideGithubToken") : t("settings.showGithubToken")}><Icon name={showGithubToken ? "eye-off" : "eye"}/></button>
              {canClearStoredGithubToken && (
                <button
                  class="icon-button"
                  type="button"
                  disabled={saving}
                  onClick={() => setClearGithubToken(!clearGithubToken)}
                  title={clearGithubToken ? t("settings.undoClearGithubToken") : t("settings.clearGithubToken")}
                  aria-label={clearGithubToken ? t("settings.undoClearGithubToken") : t("settings.clearGithubToken")}
                >
                  <Icon name={clearGithubToken ? "refresh" : "x"} size={15}/>
                </button>
              )}
            </div>
            {clearGithubToken
              ? <small class="secure-note"><Icon name="shield" size={14}/>{t("settings.githubClearing")}</small>
              : locked?.githubToken
                ? <small class="secure-note secure-note--locked"><Icon name="shield" size={14}/>{t("settings.githubLocked")}</small>
                : hasStoredGithubToken
                  ? <small class="secure-note"><Icon name="shield" size={14}/>{t("settings.githubStored", { hint: settings.secrets?.githubTokenHint ?? "••••" })}</small>
                  : <small>{t("settings.githubDefaultNote")}</small>}
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--blue"><Icon name="shield"/></span>
          <div><h2>{t("settings.schemaStoreTitle")}</h2><p>{t("settings.schemaStoreDesc")}</p></div>
          <button
            type="button"
            class={`toggle ${draft.schemaStore.enabled ? "toggle--on" : ""}`}
            role="switch"
            aria-label={t("settings.schemaStoreEnableAria")}
            aria-checked={draft.schemaStore.enabled}
            disabled={saving}
            onClick={() => setDraft((current) => ({
              ...current,
              schemaStore: { enabled: !current.schemaStore.enabled },
            }))}
          ><i/></button>
        </header>
        <div class="settings-card__body">
          <div class="setting-field setting-field--wide">
            <small class="secure-note">
              <Icon name={draft.schemaStore.enabled ? "check" : "shield"} size={14}/>
              {draft.schemaStore.enabled ? t("settings.schemaStoreStatusOn") : t("settings.schemaStoreStatusOff")}
            </small>
            <small>{t("settings.schemaStoreNote")}</small>
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--blue"><Icon name="code"/></span>
          <div><h2>{t("settings.languageTitle")}</h2><p>{t("settings.languageDesc")}</p></div>
        </header>
        <div class="settings-card__body">
          <div class="locale-picker">
            {(["zh-CN", "en-US"] as Locale[]).map((item) => (
              <button
                key={item}
                type="button"
                class={draft.locale === item ? "active" : ""}
                aria-pressed={draft.locale === item}
                disabled={saving}
                onClick={() => {
                  setDraft((current) => ({ ...current, locale: item }));
                  onLocalePreview(item);
                }}
              >
                <strong>{item === "zh-CN" ? t("settings.langZh") : t("settings.langEn")}</strong>
                <small>{item}</small>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--blue"><Icon name="layers"/></span>
          <div><h2>{t("settings.appearanceTitle")}</h2><p>{t("settings.appearanceDesc")}</p></div>
        </header>
        <div class="settings-card__body">
          <div class="theme-picker">
            {(["system", "light", "dark"] as ThemePreference[]).map((theme) => (
              <button
                key={theme}
                type="button"
                class={draft.theme === theme ? "active" : ""}
                aria-pressed={draft.theme === theme}
                disabled={saving}
                onClick={() => {
                  setDraft((current) => ({ ...current, theme }));
                  onThemePreview(theme);
                }}
              >
                <span class={`theme-preview theme-preview--${theme}`}><i/><i/></span>
                <strong>{theme === "system" ? t("settings.themeSystem") : theme === "light" ? t("settings.themeLight") : t("settings.themeDark")}</strong>
              </button>
            ))}
          </div>
        </div>
      </section>

      <section class="settings-card">
        <header class="settings-card__header">
          <span class="settings-card__icon settings-card__icon--blue"><Icon name="refresh"/></span>
          <div><h2>{t("settings.updateTitle")}</h2><p>{t("settings.updateDesc")}</p></div>
        </header>
        <div class="settings-card__body">
          <div class={`update-panel ${updateResult?.updateAvailable ? "update-panel--available" : ""}`}>
            <div class="update-status">
              <span class="update-status__icon"><Icon name={updateResult?.updateAvailable ? "sparkles" : "check"}/></span>
              <div class="update-status__copy">
                <strong>{appInfo ? t("settings.currentVersion", { version: appInfo.version }) : t("settings.readingVersion")}</strong>
                <p>{updateResult
                  ? updateResult.updateAvailable
                    ? t("settings.updateFound", { version: updateResult.latestVersion, name: updateResult.releaseName })
                    : updateResult.currentVersion === updateResult.latestVersion
                      ? t("settings.updateLatest", { version: updateResult.latestVersion })
                      : t("settings.updateAhead", { version: updateResult.latestVersion })
                  : t("settings.updateClickHint")}</p>
              </div>
            </div>
            <div class="update-actions">
              <Button icon="refresh" busy={checkingUpdate} disabled={checkingUpdate} onClick={() => void checkUpdates()}>{t("settings.checkUpdates")}</Button>
              {updateResult?.updateAvailable && <Button variant="primary" icon="external-link" onClick={() => void openReleasePage()}>{t("settings.openDownload")}</Button>}
            </div>
          </div>
        </div>
      </section>

      <div class={`settings-savebar ${dirty ? "settings-savebar--visible" : ""}`}>
        <span>{dirty ? t("settings.savebarUnsaved") : t("settings.savebarSaved")}</span>
        <div>
          {dirty && (
            <Button
              variant="ghost"
              disabled={saving || testing}
              onClick={() => {
                setDraft(structuredClone(settings));
                setClearApiKey(false);
                setClearGithubToken(false);
                onThemePreview(settings.theme);
                onLocalePreview(settings.locale);
              }}
            >{t("common.undo")}</Button>
          )}
          <Button variant="primary" icon="save" disabled={!dirty || saving || testing} busy={saving} onClick={() => void save()}>{t("settings.saveButton")}</Button>
        </div>
      </div>
    </div>
  );
}

interface AiDraftErrors {
  model?: string;
  baseUrl?: string;
}

function validateAiDraft(ai: AppSettings["ai"], locale: Locale): AiDraftErrors {
  if (!ai.enabled) return {};
  const errors: AiDraftErrors = {};
  if (!ai.model.trim()) errors.model = translate(locale, "settings.aiErrModel");
  const baseUrl = ai.baseUrl.trim();
  if (!baseUrl) {
    errors.baseUrl = translate(locale, "settings.aiErrBaseUrlRequired");
  } else {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.baseUrl = translate(locale, "settings.aiErrBaseUrlProto");
      } else if (url.username || url.password) {
        errors.baseUrl = translate(locale, "settings.aiErrBaseUrlCreds");
      } else if (url.search || url.hash) {
        errors.baseUrl = translate(locale, "settings.aiErrBaseUrlQuery");
      }
    } catch {
      errors.baseUrl = translate(locale, "settings.aiErrBaseUrlInvalid");
    }
  }
  return errors;
}

function focusFirstAiError(errors: AiDraftErrors): void {
  const id = errors.model ? "settings-ai-model" : errors.baseUrl ? "settings-ai-base-url" : undefined;
  if (id) window.setTimeout(() => document.getElementById(id)?.focus(), 0);
}
