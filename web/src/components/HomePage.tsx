import type { RecentProject } from "../../../shared/schema.ts";
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
}: HomePageProps) {
  return (
    <div class="home-page page-wide">
      <div class="home-heading">
        <span class="home-heading__icon"><Icon name="layers" size={24}/></span>
        <div>
          <p class="eyebrow">本地配置工作台</p>
          <h1>打开项目，直接开始配置</h1>
          <p>Confui 会识别常见配置格式，把字段说明和正确控件放到同一个桌面界面里。</p>
        </div>
      </div>
      <section class="open-project-card">
        <div class="open-project-card__head">
          <div>
            <h2>选择本地项目</h2>
            <p>配置文件只在你的电脑上读取和保存。</p>
          </div>
          <span class="local-pill"><Icon name="shield" size={14}/>本地处理</span>
        </div>
        <div class="project-input-block">
          <label for="project-root">项目文件夹 <em>必选</em></label>
          <div class="path-control">
            <Icon name="folder"/>
            <input
              id="project-root"
              value={root}
              disabled={busy}
              placeholder="选择或粘贴项目文件夹路径"
              onInput={(event) => onRoot(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}
            />
            <Button disabled={busy} onClick={onBrowse}>浏览</Button>
          </div>
        </div>
        <div class="project-input-block">
          <label for="github-url">GitHub 仓库 <span>可选，用于本地无 README 时补充说明</span></label>
          <div class="path-control">
            <Icon name="github"/>
            <input
              id="github-url"
              value={github}
              disabled={busy}
              placeholder="https://github.com/owner/repository"
              onInput={(event) => onGithub(event.currentTarget.value)}
              onKeyDown={(event) => { if (event.key === "Enter") onOpen(); }}
            />
          </div>
        </div>
        <div class="open-project-card__footer">
          <p><Icon name="info" size={15}/>优先读取本地 Schema、示例文件和 README；AI 只是最后一层补充。</p>
          <Button variant="primary" icon="folder-open" busy={busy} disabled={busy || !root.trim()} onClick={onOpen}>
            识别并打开
          </Button>
        </div>
      </section>

      {recent.length > 0 && (
        <section class="recent-section">
          <div class="section-heading">
            <div>
              <h2>最近打开</h2>
              <p>继续处理之前的本地项目</p>
            </div>
          </div>
          <div class="recent-grid">
            {recent.slice(0, 6).map((item) => (
              <button class="recent-card" key={item.path} onClick={() => onRecent(item)}>
                <span class="recent-card__icon"><Icon name="folder"/></span>
                <span>
                  <strong>{item.name}</strong>
                  <small title={item.path}>{item.path}</small>
                </span>
                <Icon name="arrow-left" class="recent-card__arrow"/>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
