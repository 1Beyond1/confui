import type { BackupStatus, ConfigFormSchema } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, SourceBadge } from "../ui.tsx";
import { FORMAT_LABELS, FORMAT_SHORT_LABELS, formatBytes } from "../utils/format.ts";

export function EditorSummary({
  schema,
  fieldCount,
  backupStatus,
  busy,
  canCompare = false,
  hasEnvGroup = false,
  onSelectYamlDocument,
  onOpenCompare,
  onOpenExportRedacted,
  onRestoreBackup,
}: {
  schema: ConfigFormSchema;
  fieldCount?: number;
  backupStatus?: BackupStatus;
  busy?: boolean;
  canCompare?: boolean;
  hasEnvGroup?: boolean;
  onSelectYamlDocument?: (documentIndex: number) => void;
  onOpenCompare?: () => void;
  onOpenExportRedacted?: () => void;
  onRestoreBackup?: () => void;
}) {
  const { locale, t } = useI18n();
  const totalFields = fieldCount ?? schema.fields.length;
  const yamlDocs = schema.yamlDocuments && schema.yamlDocuments.length > 1 ? schema.yamlDocuments : undefined;
  const activeDocIndex = schema.activeDocumentIndex ?? 0;

  return (
    <section class="editor-summary">
      <div class="editor-summary__top">
        <div class="editor-summary__main">
          <span class={`format-icon format-icon--${schema.format}`}>{FORMAT_SHORT_LABELS[schema.format]}</span>
          <div>
            <h1>{schema.kind}</h1>
            <p>{t("editor.summaryMeta", { count: totalFields, format: FORMAT_LABELS[schema.format], size: formatBytes(schema.version.size) })}</p>
          </div>
        </div>
        <div class="editor-summary__actions">
          {canCompare && onOpenCompare && (
            <Button
              variant="ghost"
              icon="compare"
              disabled={busy}
              onClick={onOpenCompare}
              title={hasEnvGroup ? t("editor.compareEnvGroupTooltip") : t("editor.compareTooltip")}
            >
              {t("editor.compareAction")}
            </Button>
          )}
          {onOpenExportRedacted && (
            <Button
              variant="ghost"
              icon="download"
              disabled={busy}
              onClick={onOpenExportRedacted}
              title={t("editor.exportRedactedTooltip")}
            >
              {t("editor.exportRedactedAction")}
            </Button>
          )}
          {backupStatus?.exists && onRestoreBackup && (
            <Button
              variant="ghost"
              icon="history"
              disabled={busy}
              onClick={onRestoreBackup}
              title={backupStatus.modifiedAt
                ? t("editor.backupTimeTooltip", { time: new Date(backupStatus.modifiedAt).toLocaleString(locale) })
                : undefined}
            >
              {t("editor.restoreBackup")}
            </Button>
          )}
        </div>
      </div>

      {yamlDocs && onSelectYamlDocument && (
        <div class="yaml-doc-bar" role="region" aria-label={t("editor.yamlDocsLabel")}>
          <div class="yaml-doc-bar__head">
            <Icon name="layers" size={13}/>
            <span>{t("editor.yamlDocsLabel")}</span>
            <small>{t("editor.yamlDocsCount", { count: yamlDocs.length })}</small>
          </div>
          <div class="yaml-doc-tabs" role="tablist" aria-label={t("editor.yamlDocsLabel")}>
            {yamlDocs.map((doc) => {
              const active = doc.index === activeDocIndex;
              const label = doc.label || t("editor.yamlDocFallback", { index: doc.index + 1 });
              return (
                <button
                  key={doc.index}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={busy}
                  class={`yaml-doc-tab ${active ? "active" : ""}`}
                  title={t("editor.yamlDocLineTooltip", { line: doc.startLine })}
                  onClick={() => {
                    if (!active) onSelectYamlDocument(doc.index);
                  }}
                >
                  <span class="yaml-doc-tab__idx">#{doc.index + 1}</span>
                  <span class="yaml-doc-tab__label">{label}</span>
                  <small class="yaml-doc-tab__count">{t("editor.yamlDocKeyCount", { count: doc.keyCount })}</small>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div class="source-pipeline">
        {schema.sources.map((source) => (
          <span key={source.source} title={t("editor.summarySourceTitle", { count: source.fieldCount })}>
            <SourceBadge source={source.source}/>
            <small>{source.fieldCount}</small>
          </span>
        ))}
      </div>
      {(schema.warnings.length > 0 || schema.exampleFiles.length > 0 || schema.readmeSource || schema.schemaStore) && (
        <div class="editor-summary__details">
          {schema.schemaStore && (
            <span title={schema.schemaStore.url}>
              <Icon name="shield" size={14}/>
              {schema.schemaStore.fromCache
                ? t("editor.summarySchemaStoreCached", { name: schema.schemaStore.name })
                : t("editor.summarySchemaStore", { name: schema.schemaStore.name })}
            </span>
          )}
          {schema.exampleFiles.length > 0 && (
            <span><Icon name="archive" size={14}/>{t("editor.summaryExamples", { count: schema.exampleFiles.length })}</span>
          )}
          {schema.readmeSource && (
            <span><Icon name="file" size={14}/>{schema.readmeSource === "local" ? t("editor.summaryLocalReadme") : t("editor.summaryGithubReadme")}</span>
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
