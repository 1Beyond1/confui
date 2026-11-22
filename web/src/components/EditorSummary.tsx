import type { BackupStatus, ConfigFormSchema } from "../../../shared/schema.ts";
import { Icon } from "../icons.tsx";
import { Button, SourceBadge } from "../ui.tsx";
import { FORMAT_LABELS, FORMAT_SHORT_LABELS, formatBytes } from "../utils/format.ts";

export function EditorSummary({
  schema,
  fieldCount,
  backupStatus,
  busy,
  onRestoreBackup,
}: {
  schema: ConfigFormSchema;
  fieldCount?: number;
  backupStatus?: BackupStatus;
  busy?: boolean;
  onRestoreBackup?: () => void;
}) {
  const totalFields = fieldCount ?? schema.fields.length;
  return (
    <section class="editor-summary">
      <div class="editor-summary__top">
        <div class="editor-summary__main">
          <span class={`format-icon format-icon--${schema.format}`}>{FORMAT_SHORT_LABELS[schema.format]}</span>
          <div>
            <h1>{schema.kind}</h1>
            <p>{totalFields} 个字段 · {FORMAT_LABELS[schema.format]} · {formatBytes(schema.version.size)}</p>
          </div>
        </div>
        {backupStatus?.exists && onRestoreBackup && (
          <Button
            variant="ghost"
            icon="history"
            disabled={busy}
            onClick={onRestoreBackup}
            title={backupStatus.modifiedAt ? `上次备份时间：${new Date(backupStatus.modifiedAt).toLocaleString()}` : undefined}
          >
            从 .bak 恢复
          </Button>
        )}
      </div>
      <div class="source-pipeline">
        {schema.sources.map((source) => (
          <span key={source.source} title={`${source.fieldCount} 个字段使用了此来源`}>
            <SourceBadge source={source.source}/>
            <small>{source.fieldCount}</small>
          </span>
        ))}
      </div>
      {(schema.warnings.length > 0 || schema.exampleFiles.length > 0 || schema.readmeSource) && (
        <div class="editor-summary__details">
          {schema.exampleFiles.length > 0 && (
            <span><Icon name="archive" size={14}/>{schema.exampleFiles.length} 个示例文件</span>
          )}
          {schema.readmeSource && (
            <span><Icon name="file" size={14}/>{schema.readmeSource === "local" ? "本地 README" : "GitHub README"}</span>
          )}
          {schema.warnings.map((warning) => (
            <span class="summary-warning" key={warning} title={warning}>
              <Icon name="warning" size={14}/>{warning}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

export function EditorSkeleton() {
  return (
    <div class="editor-page page-wide skeleton-page">
      <div class="skeleton skeleton--summary"/>
      <div class="skeleton-card"><span/><span/><span/><span/></div>
      <div class="skeleton-card"><span/><span/><span/></div>
    </div>
  );
}
