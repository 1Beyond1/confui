import { useRef } from "preact/hooks";
import type { ConfigFile, ConfigFormat, ExampleTemplate, ProjectScanResult } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Logo } from "../ui.tsx";
import { FORMAT_LABELS, FORMAT_SHORT_LABELS, formatBytes, parentPath } from "../utils/format.ts";

export interface SidebarProps {
  view: "home" | "editor" | "settings";
  project?: ProjectScanResult;
  filteredFiles: ConfigFile[];
  activeFile?: ConfigFile;
  fileQuery: string;
  formatFilter: ConfigFormat | "all";
  dirty: boolean;
  busy: boolean;
  appVersion: string;
  onFileQuery: (value: string) => void;
  onFormatFilter: (value: ConfigFormat | "all") => void;
  onHome: () => void;
  onSettings: () => void;
  onRescan: () => void;
  onSelectFile: (file: ConfigFile) => void;
  onInitTemplate?: (template: ExampleTemplate) => void;
}

export function Sidebar({
  view,
  project,
  filteredFiles,
  activeFile,
  fileQuery,
  formatFilter,
  dirty,
  busy,
  appVersion,
  onFileQuery,
  onFormatFilter,
  onHome,
  onSettings,
  onRescan,
  onSelectFile,
  onInitTemplate,
}: SidebarProps) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const templates = project?.templates ?? [];

  const activeIndex = filteredFiles.findIndex((file) => activeFile?.path === file.path && view === "editor");

  function handleListKeyDown(event: KeyboardEvent): void {
    if (!filteredFiles.length) return;
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const options = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex = currentIndex >= 0 ? currentIndex : Math.max(0, activeIndex);
    if (event.key === "ArrowDown") nextIndex = (nextIndex + 1) % options.length;
    else if (event.key === "ArrowUp") nextIndex = (nextIndex - 1 + options.length) % options.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = options.length - 1;
    event.preventDefault();
    const target = options[nextIndex];
    if (target) {
      target.focus();
      target.scrollIntoView({ block: "nearest" });
    }
  }

  return (
    <aside class="sidebar">
      <div class="sidebar__brand"><Logo/></div>
      <nav class="primary-nav" aria-label={t("nav.primary")}>
        <button class={view === "home" ? "active" : ""} disabled={busy} onClick={onHome}>
          <Icon name="home"/>
          <span>{t("nav.home")}</span>
        </button>
      </nav>

      {project ? (
        <div class="project-panel">
          <div class="project-card">
            <div class="project-card__icon"><Icon name="folder-open"/></div>
            <div>
              <strong title={project.root}>{project.name}</strong>
              <span>{t("sidebar.fileCount", { count: project.files.length })}</span>
            </div>
            <button
              class="icon-button"
              aria-label={t("sidebar.rescan")}
              title={t("sidebar.rescan")}
              disabled={busy}
              onClick={onRescan}
            >
              <Icon name="refresh" size={16}/>
            </button>
          </div>
          <div class="file-tools">
            <label class="search-box">
              <Icon name="search" size={15}/>
              <input
                value={fileQuery}
                onInput={(event) => onFileQuery(event.currentTarget.value)}
                placeholder={t("sidebar.filterFiles")}
                aria-label={t("sidebar.filterFiles")}
              />
              {fileQuery && (
                <button onClick={() => onFileQuery("")} aria-label={t("sidebar.clearFilter")}>
                  <Icon name="x" size={14}/>
                </button>
              )}
            </label>
            <div class="format-filter">
              <select
                value={formatFilter}
                onChange={(event) => onFormatFilter(event.currentTarget.value as ConfigFormat | "all")}
                aria-label={t("sidebar.filterByFormat")}
              >
                <option value="all">{t("sidebar.allFormats")}</option>
                {Object.entries(FORMAT_LABELS).map(([format, label]) => (
                  <option key={format} value={format}>{label}</option>
                ))}
              </select>
              <Icon name="chevron-down" size={14}/>
            </div>
          </div>
          <div
            ref={listRef}
            class="file-list"
            role="listbox"
            aria-label={t("sidebar.fileListLabel")}
            onKeyDown={handleListKeyDown}
          >
            {filteredFiles.map((file, index) => {
              const selected = activeFile?.path === file.path && view === "editor";
              const tabStop = activeIndex >= 0 ? index === activeIndex : index === 0;
              return (
                <button
                  key={file.path}
                  role="option"
                  tabIndex={tabStop ? 0 : -1}
                  aria-selected={selected}
                  class={`file-item ${selected ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => onSelectFile(file)}
                  title={file.warning || file.path}
                >
                  <span class={`format-icon format-icon--${file.format}`}>{FORMAT_SHORT_LABELS[file.format]}</span>
                  <span class="file-item__copy">
                    <strong>{file.path.split("/").at(-1)}</strong>
                    <small>{parentPath(file.path, t("common.rootDir"))} · {formatBytes(file.size)}</small>
                  </span>
                  {activeFile?.path === file.path && dirty && <i class="dirty-dot" title={t("sidebar.unsavedTooltip")}/>}
                  {file.status !== "ready" && <Icon name="warning" size={14} class="file-warning"/>}
                </button>
              );
            })}
            {!filteredFiles.length && (
              <div class="file-list__empty"><Icon name="search"/><span>{t("sidebar.noMatchingFiles")}</span></div>
            )}
          </div>
          {templates.length > 0 && onInitTemplate && (
            <div class="sidebar-templates" aria-label={t("sidebar.templatesTitle")}>
              <div class="sidebar-templates__head">
                <span>{t("sidebar.templatesTitle")}</span>
                <small>{templates.length}</small>
              </div>
              <div class="sidebar-templates__list">
                {templates.map((template) => (
                  <div class="template-item" key={template.examplePath}>
                    <span class={`format-icon format-icon--${template.format}`}>{FORMAT_SHORT_LABELS[template.format]}</span>
                    <span class="template-item__copy">
                      <strong title={template.targetPath}>{template.targetPath.split("/").at(-1)}</strong>
                      <small title={template.examplePath}>{t("sidebar.templateFrom", { source: template.examplePath })}</small>
                    </span>
                    <button
                      type="button"
                      class="template-init-btn"
                      disabled={busy}
                      onClick={() => onInitTemplate(template)}
                      title={t("sidebar.templateInitTitle", { target: template.targetPath, source: template.examplePath })}
                    >
                      <Icon name="plus" size={12}/>
                      <span>{t("sidebar.templateInit")}</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div class="sidebar-empty">
          <Icon name="folder"/>
          <p>{t("sidebar.emptyHint")}</p>
        </div>
      )}

      <nav class="sidebar-footer" aria-label={t("nav.settings")}>
        <button class={view === "settings" ? "active" : ""} disabled={busy} onClick={onSettings}>
          <Icon name="settings"/>
          <span>{t("nav.settings")}</span>
        </button>
        <small>{appVersion ? `Confui ${appVersion}` : "Confui"}</small>
      </nav>
    </aside>
  );
}
