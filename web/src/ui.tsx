import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { FieldSource } from "../../shared/schema.ts";
import { Icon, type IconName } from "./icons.tsx";

export const SOURCE_LABELS: Record<FieldSource, string> = {
  "json-schema": "JSON Schema",
  "known-template": "内置模板",
  example: "示例文件",
  readme: "README",
  ai: "AI 分析",
  heuristic: "结构推断",
};

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div class={`brand ${compact ? "brand--compact" : ""}`}>
      <span class="brand__mark" aria-hidden="true"><span/><span/><span/></span>
      {!compact && <span class="brand__copy"><strong>Confui</strong><small>配置，终于看得懂</small></span>}
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
  return (
    <span class={`source-badge source-badge--${source} ${confidence !== undefined && confidence < 0.7 ? "source-badge--suggested" : ""}`}>
      {SOURCE_LABELS[source]}
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
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

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
      <section ref={dialogRef} class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" aria-describedby={description ? "modal-description" : undefined} tabIndex={-1} style={{ maxWidth: width }}>
        <header class="modal__header">
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p id="modal-description">{description}</p>}
          </div>
          <button class="icon-button" onClick={onClose} aria-label="关闭"><Icon name="x"/></button>
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
