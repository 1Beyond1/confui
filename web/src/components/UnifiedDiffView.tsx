import { useMemo } from "preact/hooks";
import { computeUnifiedDiff, maskUnifiedDiff, type DocumentLineSecrets } from "../../../shared/diff.ts";
import type { ConfigFormat } from "../../../shared/schema.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";

export function UnifiedDiffView({
  oldText,
  newText,
  fileName,
  format,
  emptyLabel,
  maskSecrets = false,
  secretKeys,
  secretValues,
  oldDocumentSecrets,
  newDocumentSecrets,
  onToggleRevealSecrets,
}: {
  oldText: string;
  newText: string;
  fileName: string;
  format?: ConfigFormat;
  emptyLabel?: string;
  maskSecrets?: boolean;
  secretKeys?: readonly string[];
  secretValues?: readonly string[];
  oldDocumentSecrets?: readonly DocumentLineSecrets[];
  newDocumentSecrets?: readonly DocumentLineSecrets[];
  onToggleRevealSecrets?: () => void;
}) {
  const { t } = useI18n();
  const rawDiff = useMemo(() => computeUnifiedDiff(oldText, newText, 3), [oldText, newText]);
  const hasScopedDocSecrets = Boolean(oldDocumentSecrets?.length || newDocumentSecrets?.length);
  const maskedResult = useMemo(
    () => maskUnifiedDiff(rawDiff, {
      format,
      oldText,
      newText,
      secretKeys: hasScopedDocSecrets ? undefined : secretKeys,
      secretValues: hasScopedDocSecrets ? undefined : secretValues,
      oldDocumentSecrets,
      newDocumentSecrets,
    }),
    [rawDiff, format, oldText, newText, hasScopedDocSecrets, secretKeys, secretValues, oldDocumentSecrets, newDocumentSecrets],
  );
  const diff = maskSecrets ? maskedResult.diff : rawDiff;
  const hasDocScopedEntries = Boolean(
    oldDocumentSecrets?.some((sec) => (sec.secretKeys?.length ?? 0) > 0 || (sec.secretValues?.length ?? 0) > 0)
    || newDocumentSecrets?.some((sec) => (sec.secretKeys?.length ?? 0) > 0 || (sec.secretValues?.length ?? 0) > 0),
  );
  const hasSensitiveLines = maskedResult.maskedLineCount > 0 || Boolean(secretKeys?.length) || hasDocScopedEntries;

  if (!diff.hunks.length) {
    return <div class="udiff-empty">{emptyLabel ?? t("diff.empty")}</div>;
  }

  return (
    <div class="udiff">
      <div class="udiff__header">
        <div class="udiff__title">
          <code>{fileName}</code>
          {maskSecrets && maskedResult.maskedLineCount > 0 && (
            <span class="udiff__masked-pill" title={t("diff.secretsMaskedHint")}>
              <Icon name="shield" size={12}/>
              <span>{t("diff.secretsMaskedBadge")}</span>
            </span>
          )}
        </div>
        <div class="udiff__header-right">
          {onToggleRevealSecrets && hasSensitiveLines && (
            <button
              type="button"
              class="udiff__secret-toggle"
              aria-pressed={!maskSecrets}
              onClick={onToggleRevealSecrets}
            >
              <Icon name={maskSecrets ? "eye" : "eye-off"} size={13}/>
              <span>{maskSecrets ? t("diff.showSecrets") : t("diff.hideSecrets")}</span>
            </button>
          )}
          <span class="udiff__stats">
            <em class="udiff__stat-add">+{diff.added}</em>
            <em class="udiff__stat-remove">-{diff.removed}</em>
          </span>
        </div>
      </div>
      <div class="udiff__scroll">
        <div class="udiff__table" role="region" aria-label={`Unified diff: ${fileName}`}>
          {diff.hunks.map((hunk, hunkIdx) => (
            <div key={hunkIdx}>
              <div class="udiff__hunk">
                @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
              </div>
              {hunk.lines.map((line, lineIdx) => (
                <div class={`udiff__line udiff__line--${line.kind}`} key={lineIdx}>
                  <span class="udiff__ln">{line.oldLine ?? ""}</span>
                  <span class="udiff__ln">{line.newLine ?? ""}</span>
                  <span class="udiff__sig">
                    {line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " "}
                  </span>
                  <span class="udiff__code">{line.text}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
