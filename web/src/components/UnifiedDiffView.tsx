import { useMemo } from "preact/hooks";
import { computeUnifiedDiff } from "../../../shared/diff.ts";
import { useI18n } from "../i18n/index.tsx";

export function UnifiedDiffView({
  oldText,
  newText,
  fileName,
  emptyLabel,
}: {
  oldText: string;
  newText: string;
  fileName: string;
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  const diff = useMemo(() => computeUnifiedDiff(oldText, newText, 3), [oldText, newText]);

  if (!diff.hunks.length) {
    return <div class="udiff-empty">{emptyLabel ?? t("diff.empty")}</div>;
  }

  return (
    <div class="udiff">
      <div class="udiff__header">
        <code>{fileName}</code>
        <span class="udiff__stats">
          <em class="udiff__stat-add">+{diff.added}</em>
          <em class="udiff__stat-remove">-{diff.removed}</em>
        </span>
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
