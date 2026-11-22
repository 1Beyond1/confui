import type { ComponentChildren, JSX } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import type { FieldSource } from "../../shared/schema.ts";
import { sourceLabel, useI18n } from "./i18n/index.tsx";
import { Icon, type IconName } from "./icons.tsx";

export const SOURCE_LABELS: Record<FieldSource, string> = {
  "json-schema": "JSON Schema",
  "known-template": "内置模板",
  schemastore: "SchemaStore",
  comment: "文件注释",
  example: "示例文件",
  readme: "README",
  ai: "AI 分析",
  heuristic: "结构推断",
};

export function Logo({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  return (
    <div class={`brand ${compact ? "brand--compact" : ""}`}>
      <img class="brand__mark" src="./confui-icon.png" alt="" aria-hidden="true"/>
      {!compact && <span class="brand__copy"><strong>Con<em>fui</em></strong><small>{t("brand.tagline")}</small></span>}
    </div>
  );
}

export function Button({
  children,
  variant = "secondary",
  icon,
  busy = false,
  class: className = "",
  ...props
}: {
  children: ComponentChildren;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: IconName;
  busy?: boolean;
  class?: string;
} & Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "class" | "icon">) {
  return (
    <button class={`button button--${variant} ${className}`} {...props}>
      {busy ? <Icon name="loader" class="spin"/> : icon ? <Icon name={icon}/> : null}
      <span>{children}</span>
    </button>
  );
}

export function SourceBadge({ source, confidence }: { source: FieldSource; confidence?: number }) {
  const { locale } = useI18n();
  return (
    <span class={`source-badge source-badge--${source} ${confidence !== undefined && confidence < 0.7 ? "source-badge--suggested" : ""}`}>
      {sourceLabel(locale, source)}
    </span>
  );
}

export function Modal({
  title,
  description,
  children,
  footer,
  onClose,
  width = "560px",
}: {
  title: string;
  description?: string;
  children?: ComponentChildren;
  footer: ComponentChildren;
  onClose: () => void;
  width?: string;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const modalId = useId();
  const titleId = `${modalId}-title`;
  const descriptionId = `${modalId}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ) ?? [])].filter((element) => !element.hidden && element.getClientRects().length > 0);
    (focusable()[0] ?? dialog)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div class="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} class="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} style={{ maxWidth: width }}>
        <header class="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <button class="icon-button" onClick={onClose} aria-label={t("common.close")}><Icon name="x"/></button>
        </header>
        {children && <div class="modal__body">{children}</div>}
        <footer class="modal__footer">{footer}</footer>
      </section>
    </div>
  );
}

export function EmptyIllustration() {
  return (
    <div class="empty-illustration" aria-hidden="true">
      <div class="empty-illustration__back"/>
      <div class="empty-illustration__file"><span/><span/><span/></div>
      <div class="empty-illustration__control"><i/><i/><i/></div>
    </div>
  );
}
