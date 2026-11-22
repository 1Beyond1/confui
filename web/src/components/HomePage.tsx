import type { RecentProject } from "../../../shared/schema.ts";
import { normalizeGithubUrl } from "../../../shared/validation.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button } from "../ui.tsx";

export interface HomePageProps {
  root: string;
  github: string;
  recent: RecentProject[];
  busy: boolean;
  onRoot: (value: string) => void;
  onGithub: (value: string) => void;
  onBrowse: () => void;
  onOpen: () => void;
  onRecent: (item: RecentProject) => void;
  onRemoveRecent: (path: string) => void;
}

export function HomePage({
  root,
  github,
  recent,
  busy,
  onRoot,
  onGithub,
  onBrowse,
  onOpen,
  onRecent,
  onRemoveRecent,
}: HomePageProps) {
  const { t } = useI18n();
  const trimmedGithub = github.trim();
  const githubError = trimmedGithub && !normalizeGithubUrl(trimmedGithub)
    ? t("home.githubInvalid")
    : undefined;

  return (
    <div class="home-page page-wide">
      <div class="home-heading">
        <span class="home-heading__icon"><Icon name="layers" size={24}/></span>
        <div>
          <p class="eyebrow">{t("home.eyebrow")}</p>
          <h1>{t("home.title")}</h1>
          <p>{t("home.subtitle")}</p>
        </div>
      </div>
      <section class="open-project-card">
        <div class="open-project-card__head">
          <div>
            <h2>{t("home.cardTitle")}</h2>
            <p>{t("home.cardSubtitle")}</p>
          </div>
          <span class="local-pill"><Icon name="shield" size={14}/>{t("home.localBadge")}</span>
        </div>
        <div class="project-input-block">
          <label for="project-root">{t("home.projectFolder")} <em>{t("home.required")}</em></label>
          <div class="path-control">
            <Icon name="folder"/>
            <input
              id="project-root"
              value={root}
              disabled={busy}
              placeholder={t("home.projectPlaceholder")}
              onInput={(event) => onRoot(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !githubError) onOpen(); }}
            />
            <Button disabled={busy} onClick={onBrowse}>{t("home.browse")}</Button>
          </div>
        </div>
        <div class="project-input-block">
          <label for="github-url">{t("home.githubLabel")} <span>{t("home.githubHint")}</span></label>
          <div class="path-control">
            <Icon name="github"/>
            <input
              id="github-url"
              class={githubError ? "control--error" : undefined}
              value={github}
              disabled={busy}
              aria-invalid={Boolean(githubError)}
              aria-describedby={githubError ? "github-url-error" : undefined}
              placeholder="https://github.com/owner/repository"
              onInput={(event) => onGithub(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !githubError) onOpen(); }}
            />
          </div>
          {githubError && (
            <p id="github-url-error" class="field-error" role="alert">
              <Icon name="warning" size={14}/>{githubError}
            </p>
          )}
        </div>
        <div class="open-project-card__footer">
          <p><Icon name="info" size={15}/>{t("home.footerHint")}</p>
          <Button
            variant="primary"
            icon="folder-open"
            busy={busy}
            disabled={busy || !root.trim() || Boolean(githubError)}
            onClick={onOpen}
          >
            {t("home.openButton")}
          </Button>
        </div>
      </section>

      {recent.length > 0 && (
        <section class="recent-section">
          <div class="section-heading">
            <div>
              <h2>{t("home.recentTitle")}</h2>
              <p>{t("home.recentSubtitle")}</p>
            </div>
          </div>
          <div class="recent-grid">
            {recent.slice(0, 10).map((item) => (
              <div class="recent-card" key={item.path}>
                <button
                  type="button"
                  class="recent-card__main"
                  disabled={busy}
                  onClick={() => onRecent(item)}
                >
                  <span class="recent-card__icon"><Icon name="folder"/></span>
                  <span class="recent-card__copy">
                    <strong>{item.name}</strong>
                    <small title={item.path}>{item.path}</small>
                  </span>
                  <Icon name="arrow-left" class="recent-card__arrow"/>
                </button>
                <button
                  type="button"
                  class="icon-button recent-card__remove"
                  disabled={busy}
                  aria-label={t("home.removeRecentAria", { name: item.name })}
                  title={t("home.removeRecentTitle")}
                  onClick={() => onRemoveRecent(item.path)}
                >
                  <Icon name="x" size={14}/>
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
