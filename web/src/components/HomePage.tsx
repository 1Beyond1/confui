import { useRef, useState } from "preact/hooks";
import type { RecentProject } from "../../../shared/schema.ts";
import { normalizeGithubUrl } from "../../../shared/validation.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button } from "../ui.tsx";

export function isFileDragEvent(
  dataTransfer: { types?: ArrayLike<string> | Iterable<string> } | null | undefined,
): boolean {
  if (!dataTransfer?.types) return false;
  return Array.from(dataTransfer.types).includes("Files");
}

export interface HomePageProps {
  root: string;
  github: string;
  recent: RecentProject[];
  busy: boolean;
  onRoot: (value: string) => void;
  onGithub: (value: string) => void;
  onBrowse: () => void;
  onOpen: () => void;
  onDropFolder: (folderPath: string) => void;
  onDropInvalid: (message: string) => void;
  onDropNotice?: (message: string) => void;
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
  onDropFolder,
  onDropInvalid,
  onDropNotice,
  onRecent,
  onRemoveRecent,
}: HomePageProps) {
  const { t } = useI18n();
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const trimmedGithub = github.trim();
  const githubError = trimmedGithub && !normalizeGithubUrl(trimmedGithub)
    ? t("home.githubInvalid")
    : undefined;

  function handleDragEnter(event: DragEvent): void {
    if (busy || !isFileDragEvent(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current += 1;
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }

  function handleDragOver(event: DragEvent): void {
    if (busy || !isFileDragEvent(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent): void {
    if (!isFileDragEvent(event.dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent): void {
    if (!isFileDragEvent(event.dataTransfer)) {
      dragDepth.current = 0;
      setDragActive(false);
      return;
    }
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    if (busy) return;

    const fileItems = event.dataTransfer?.items
      ? Array.from(event.dataTransfer.items).filter((item) => item.kind === "file")
      : [];
    const droppedFiles = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
    if (Math.max(fileItems.length, droppedFiles.length) > 1) {
      (onDropNotice ?? onDropInvalid)(t("home.dropMultipleFolders"));
      return;
    }

    const firstItem = fileItems[0] ?? event.dataTransfer?.items?.[0];
    const webkitEntry = typeof firstItem?.webkitGetAsEntry === "function"
      ? firstItem.webkitGetAsEntry()
      : null;
    if (webkitEntry && !webkitEntry.isDirectory) {
      onDropInvalid(t("home.dropFolderOnly"));
      return;
    }

    const droppedFile = droppedFiles[0];
    if (!droppedFile) {
      onDropInvalid(t("home.dropFolderOnly"));
      return;
    }
    const resolvedPath = window.confui.getPathForFile?.(droppedFile)
      || (droppedFile as File & { path?: string }).path
      || "";
    if (!resolvedPath.trim()) {
      onDropInvalid(t("home.dropFolderOnly"));
      return;
    }
    onDropFolder(resolvedPath.trim());
  }

  return (
    <div
      class="home-page page-wide"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div class="home-heading">
        <span class="home-heading__icon"><Icon name="layers" size={24}/></span>
        <div>
          <p class="eyebrow">{t("home.eyebrow")}</p>
          <h1>{t("home.title")}</h1>
          <p>{t("home.subtitle")}</p>
        </div>
      </div>
      <section class={`open-project-card ${dragActive ? "open-project-card--dragging" : ""}`}>
        {dragActive && (
          <div class="drop-overlay" role="status">
            <span class="drop-overlay__icon"><Icon name="folder-open" size={28}/></span>
            <strong>{t("home.dropOverlayTitle")}</strong>
            <span>{t("home.dropOverlayHint")}</span>
          </div>
        )}
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
          <p class="drop-inline-hint"><Icon name="upload" size={13}/>{t("home.dropInlineHint")}</p>
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
