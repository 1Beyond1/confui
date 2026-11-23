import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  DiagnosticCategory,
  DiagnosticSeverity,
  ProjectDiagnosticIssue,
  ProjectDiagnosticsResult,
} from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";
import { Button, Modal } from "../ui.tsx";
import { FORMAT_SHORT_LABELS } from "../utils/format.ts";

type SeverityFilter = "all" | DiagnosticSeverity;

export function ProjectDiagnosticsModal({
  projectRoot,
  projectName,
  onClose,
  onSelectIssue,
}: {
  projectRoot: string;
  projectName: string;
  onClose: () => void;
  onSelectIssue: (issue: ProjectDiagnosticIssue) => void;
}) {
  const { locale, t } = useI18n();
  const [result, setResult] = useState<ProjectDiagnosticsResult>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const runSeqRef = useRef(0);
  const mountedRef = useRef(true);

  async function runDiagnostics(): Promise<void> {
    const seq = ++runSeqRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const response = await window.confui.diagnoseProject(projectRoot, { locale });
      if (!mountedRef.current || seq !== runSeqRef.current) return;
      if (!response.ok) {
        setResult(undefined);
        setError(response.error.detail || response.error.message);
        return;
      }
      setResult(response.data);
    } catch (err) {
      if (!mountedRef.current || seq !== runSeqRef.current) return;
      setResult(undefined);
      setError(err instanceof Error ? err.message : t("common.actionFailed"));
    } finally {
      if (mountedRef.current && seq === runSeqRef.current) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    void runDiagnostics();
    return () => {
      mountedRef.current = false;
      runSeqRef.current += 1;
      window.confui.cancelDiagnostics();
    };
  }, [projectRoot, locale]);

  const visibleIssues = useMemo(() => {
    if (!result) return [];
    const needle = searchQuery.trim().toLowerCase();
    return result.issues.filter((issue) => {
      if (severityFilter !== "all" && issue.severity !== severityFilter) return false;
      if (!needle) return true;
      return (
        issue.file.toLowerCase().includes(needle)
        || (issue.path ?? "").toLowerCase().includes(needle)
        || issue.message.toLowerCase().includes(needle)
        || (issue.sourceFile ?? "").toLowerCase().includes(needle)
      );
    });
  }, [result, severityFilter, searchQuery]);

  function severityLabel(severity: DiagnosticSeverity): string {
    switch (severity) {
      case "error": return t("diag.severityError");
      case "warning": return t("diag.severityWarning");
      case "info": return t("diag.severityInfo");
    }
  }

  function categoryLabel(category: DiagnosticCategory): string {
    switch (category) {
      case "parse-error": return t("diag.catParseError");
      case "schema-violation": return t("diag.catSchemaViolation");
      case "missing-from-example": return t("diag.catMissingExample");
      case "plaintext-secret": return t("diag.catPlaintextSecret");
    }
  }

  return (
    <Modal
      title={t("diag.title")}
      description={t("diag.desc", { project: projectName })}
      width="880px"
      onClose={onClose}
      footer={(
        <>
          <Button
            icon="refresh"
            busy={loading}
            disabled={loading}
            onClick={() => void runDiagnostics()}
          >
            {t("diag.rescan")}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t("common.close")}
          </Button>
        </>
      )}
    >
      {error && (
        <div class="modal-warning compare-error" role="alert">
          <Icon name="warning"/>
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div class="compare-loading">
          <Icon name="loader" class="spin"/>
          <span>{t("diag.loading")}</span>
        </div>
      )}

      {result && !loading && (
        <>
          <div class="diag-meta-bar">
            <span>{t("diag.summaryMeta", { scanned: result.scannedFiles, skipped: result.skippedFiles, ms: result.durationMs })}</span>
            {result.truncated && (
              <span class="diag-truncated">
                <Icon name="warning" size={12}/>
                {t("diag.truncated")}
              </span>
            )}
          </div>

          <div class="compare-toolbar diag-toolbar">
            <div class="compare-filters" role="tablist" aria-label={t("diag.filterAria")}>
              <button
                type="button"
                role="tab"
                aria-selected={severityFilter === "all"}
                class={severityFilter === "all" ? "active" : ""}
                onClick={() => setSeverityFilter("all")}
              >
                {t("diag.filterAll", { count: result.issues.length })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={severityFilter === "error"}
                class={severityFilter === "error" ? "active" : ""}
                onClick={() => setSeverityFilter("error")}
              >
                {t("diag.filterError", { count: result.summary.errors })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={severityFilter === "warning"}
                class={severityFilter === "warning" ? "active" : ""}
                onClick={() => setSeverityFilter("warning")}
              >
                {t("diag.filterWarning", { count: result.summary.warnings })}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={severityFilter === "info"}
                class={severityFilter === "info" ? "active" : ""}
                onClick={() => setSeverityFilter("info")}
              >
                {t("diag.filterInfo", { count: result.summary.infos })}
              </button>
            </div>
            <div class="diag-search">
              <Icon name="search" size={14}/>
              <input
                class="control"
                value={searchQuery}
                placeholder={t("diag.searchPlaceholder")}
                aria-label={t("diag.searchPlaceholder")}
                onInput={(event) => setSearchQuery(event.currentTarget.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  class="icon-button"
                  onClick={() => setSearchQuery("")}
                  aria-label={t("common.clear")}
                >
                  <Icon name="x" size={13}/>
                </button>
              )}
            </div>
          </div>

          {result.issues.length === 0 ? (
            <div class="diag-empty">
              <span class="diag-empty__icon"><Icon name="check" size={20}/></span>
              <strong>{t("diag.cleanTitle")}</strong>
              <p>{t("diag.cleanDesc", { count: result.scannedFiles })}</p>
            </div>
          ) : visibleIssues.length === 0 ? (
            <div class="udiff-empty">{t("diag.noFilteredIssues")}</div>
          ) : (
            <div class="diag-list" role="list">
              {visibleIssues.map((issue) => (
                <button
                  key={issue.id}
                  type="button"
                  role="listitem"
                  class={`diag-row diag-row--${issue.severity}`}
                  onClick={() => {
                    onClose();
                    onSelectIssue(issue);
                  }}
                >
                  <span class={`diag-severity-dot diag-severity-dot--${issue.severity}`} aria-hidden="true">
                    <Icon name={issue.severity === "error" ? "warning" : issue.severity === "warning" ? "warning" : "shield"} size={14}/>
                  </span>
                  <div class="diag-row__body">
                    <div class="diag-row__head">
                      <span class={`diff-badge diag-badge--${issue.severity}`}>{severityLabel(issue.severity)}</span>
                      <span class={`diag-cat-pill diag-cat-pill--${issue.category}`}>{categoryLabel(issue.category)}</span>
                      <span class={`format-icon format-icon--${issue.format} diag-format-pill`}>{FORMAT_SHORT_LABELS[issue.format]}</span>
                      <code class="diag-row__file">
                        {issue.file}{issue.line ? `:${issue.line}` : ""}
                      </code>
                      {issue.documentIndex !== undefined && (
                        <span class="palette__doc-badge">
                          {issue.documentLabel || t("editor.yamlDocFallback", { index: issue.documentIndex + 1 })}
                        </span>
                      )}
                    </div>
                    <strong class="diag-row__message">{issue.message}</strong>
                    <div class="diag-row__meta">
                      {issue.path && <code class="diag-row__path">{issue.path}</code>}
                      {issue.detail && <span class="diag-row__detail">{issue.detail}</span>}
                    </div>
                  </div>
                  <span class="diag-row__jump" title={t("diag.jumpTooltip")}>
                    <Icon name="arrow-right" size={15}/>
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
