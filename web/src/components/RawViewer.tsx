import type { ConfigFormSchema } from "../../../shared/schema.ts";
import { Icon } from "../icons.tsx";
import { SourceBadge } from "../ui.tsx";
import { FORMAT_LABELS } from "../utils/format.ts";

export function RawViewer({ schema }: { schema: ConfigFormSchema }) {
  return (
    <div id="editor-panel-raw" class="raw-page page-wide" role="tabpanel" aria-labelledby="editor-tab-raw">
      <div class="raw-notice">
        <Icon name="info"/>
        <span>原始内容用于核对格式和注释；请回到表单进行安全修改。</span>
        <SourceBadge source="heuristic"/>
      </div>
      <section class="raw-card">
        <header>
          <span>{schema.file}</span>
          <small>{FORMAT_LABELS[schema.format]} · 只读</small>
        </header>
        <pre><code>{schema.rawText}</code></pre>
      </section>
    </div>
  );
}
