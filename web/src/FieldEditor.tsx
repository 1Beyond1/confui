import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FieldAssistResult, FieldSpec } from "../../shared/schema.ts";
import { isHexColor6 } from "../../shared/validation.ts";
import { StructuredArrayControl, StructuredObjectControl } from "./components/StructuredControls.tsx";
import {
  effectiveValue,
  enumValueEqual,
  fieldKey,
  filterFieldsByStatus,
  isFieldModified,
  isInactiveExamplePlaceholder,
  type EditorValues,
  type FieldStatusFilter,
} from "./editor-state.ts";
import { useI18n } from "./i18n/index.tsx";
import { Icon } from "./icons.tsx";
import { SourceBadge } from "./ui.tsx";

export function FieldEditor({
  fileKey,
  fields,
  customKeys,
  values,
  errors,
  onChange,
  onResetField,
  onDeleteField,
  onOpenAddKey,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  aiAvailable = false,
  onExplain,
  disabled = false,
  focusRequest,
}: {
  fileKey?: string;
  fields: FieldSpec[];
  customKeys?: ReadonlySet<string>;
  values: EditorValues;
  errors: Map<string, string>;
  onChange: (field: FieldSpec, value: unknown, options?: { coalesce?: boolean }) => void;
  onResetField?: (field: FieldSpec) => void;
  onDeleteField?: (field: FieldSpec) => void;
  onOpenAddKey?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  aiAvailable?: boolean;
  onExplain?: (field: FieldSpec) => Promise<FieldAssistResult>;
  disabled?: boolean;
  focusRequest?: { path: string; token: number };
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<FieldStatusFilter>("all");
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [highlightedPath, setHighlightedPath] = useState<string>();
  const editorRef = useRef<HTMLDivElement>(null);
  const defaultGroupName = t("common.generalGroup");

  useEffect(() => {
    setQuery("");
    setStatusFilter("all");
    setCollapsedGroups({});
    setHighlightedPath(undefined);
  }, [fileKey]);

  useEffect(() => {
    if (!focusRequest?.path) return;
    setQuery("");
    setStatusFilter("all");
    const targetField = fields.find((item) => item.path === focusRequest.path);
    if (targetField) {
      const targetGroup = normalizeGroupName(targetField.group, defaultGroupName);
      setCollapsedGroups((prev) => (prev[targetGroup] ? { ...prev, [targetGroup]: false } : prev));
    }
    setHighlightedPath(focusRequest.path);
    const scrollTimer = window.setTimeout(() => {
      const rows = editorRef.current?.querySelectorAll<HTMLElement>("[data-field-path]");
      const target = rows ? [...rows].find((el) => el.dataset.fieldPath === focusRequest.path) : undefined;
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        const focusable = target.querySelector<HTMLElement>("input, select, textarea, button[role='switch']");
        focusable?.focus({ preventScroll: true });
      }
    }, 30);
    const clearTimer = window.setTimeout(() => {
      setHighlightedPath((current) => (current === focusRequest.path ? undefined : current));
    }, 2_600);
    return () => {
      window.clearTimeout(scrollTimer);
      window.clearTimeout(clearTimer);
    };
  }, [focusRequest?.path, focusRequest?.token, fields, defaultGroupName]);

  const statusCounts = useMemo(() => {
    let modified = 0;
    let errorCount = 0;
    let required = 0;
    for (const field of fields) {
      const key = fieldKey(field);
      if (customKeys?.has(key) || isFieldModified(field, values[key])) modified += 1;
      if (errors.has(key)) errorCount += 1;
      if (field.required === true) required += 1;
    }
    return { all: fields.length, modified, error: errorCount, required };
  }, [fields, values, errors, customKeys]);

  const statusFilteredFields = useMemo(
    () => filterFieldsByStatus(fields, values, errors, customKeys, statusFilter),
    [fields, values, errors, customKeys, statusFilter],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFields = normalizedQuery
    ? statusFilteredFields.filter((field) => [field.label, field.path, field.description, field.group]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase()
      .includes(normalizedQuery))
    : statusFilteredFields;
  const groups = groupFields(visibleFields, defaultGroupName);
  const allCollapsed = groups.length > 0 && groups.every(([name]) => Boolean(collapsedGroups[name]));
  const controlIds = new Map(fields.map((field, index) => [fieldKey(field), `field-${index}`]));

  function toggleGroup(name: string): void {
    setCollapsedGroups((prev) => ({ ...prev, [name]: !prev[name] }));
  }

  function toggleAllGroups(): void {
    if (allCollapsed) {
      setCollapsedGroups({});
    } else {
      const next: Record<string, boolean> = {};
      for (const [name] of groups) next[name] = true;
      setCollapsedGroups(next);
    }
  }

  return (
    <div ref={editorRef} class="field-editor" aria-busy={disabled}>
      <div class="field-toolbar">
        <label class="field-search">
          <Icon name="search" size={15}/>
          <input
            value={query}
            disabled={disabled}
            placeholder={t("field.searchPlaceholder")}
            aria-label={t("field.searchPlaceholder")}
            onInput={(event) => setQuery(event.currentTarget.value)}
          />
          {query && (
            <button type="button" class="icon-button" disabled={disabled} onClick={() => setQuery("")} aria-label={t("field.clearSearch")}>
              <Icon name="x" size={14}/>
            </button>
          )}
        </label>
        <div class="field-toolbar__actions">
          <span class="field-toolbar__count">
            {visibleFields.length === fields.length
              ? t("field.countAll", { count: fields.length })
              : t("field.countFiltered", { visible: visibleFields.length, total: fields.length })}
          </span>
          {onUndo && onRedo && (
            <div class="toolbar-history">
              <button
                type="button"
                class="icon-button"
                disabled={disabled || !canUndo}
                onClick={onUndo}
                aria-label={t("common.undo")}
                title={t("field.undoTooltip")}
              >
                <Icon name="undo" size={15}/>
              </button>
              <button
                type="button"
                class="icon-button"
                disabled={disabled || !canRedo}
                onClick={onRedo}
                aria-label={t("common.redo")}
                title={t("field.redoTooltip")}
              >
                <Icon name="redo" size={15}/>
              </button>
            </div>
          )}
          {onOpenAddKey && (
            <button
              type="button"
              class="toolbar-add-key"
              disabled={disabled}
              onClick={onOpenAddKey}
            >
              <Icon name="plus" size={14}/>
              <span>{t("field.addKey")}</span>
            </button>
          )}
        </div>
      </div>

      <div class="field-status-bar">
        <div class="field-status-pills" role="group" aria-label={t("field.statusFilterAria")}>
          {([
            ["all", t("field.filterAll"), statusCounts.all],
            ["modified", t("field.filterModified"), statusCounts.modified],
            ["error", t("field.filterError"), statusCounts.error],
            ["required", t("field.filterRequired"), statusCounts.required],
          ] as Array<[FieldStatusFilter, string, number]>).map(([id, label, count]) => (
            <button
              key={id}
              type="button"
              class={`status-pill ${statusFilter === id ? "active" : ""} ${id === "error" && count > 0 ? "status-pill--danger" : ""}`}
              aria-pressed={statusFilter === id}
              disabled={disabled}
              onClick={() => setStatusFilter(id)}
            >
              <span>{label}</span>
              <small>{count}</small>
            </button>
          ))}
        </div>
        {groups.length > 1 && (
          <button
            type="button"
            class="field-action-btn"
            disabled={disabled}
            onClick={toggleAllGroups}
          >
            <Icon name="chevron-down" size={12} class={allCollapsed ? "icon-rotate-neg90" : ""}/>
            <span>{allCollapsed ? t("field.expandAllGroups") : t("field.collapseAllGroups")}</span>
          </button>
        )}
      </div>

      {groups.length ? (
        <div class="field-groups">
          {groups.map(([name, groupedFields], groupIdx) => {
            const collapsed = Boolean(collapsedGroups[name]);
            const bodyId = `field-group-body-${groupIdx}`;
            let groupModified = 0;
            let groupErrors = 0;
            for (const field of groupedFields) {
              const key = fieldKey(field);
              if (customKeys?.has(key) || isFieldModified(field, values[key])) groupModified += 1;
              if (errors.has(key)) groupErrors += 1;
            }
            return (
              <section class={`form-card ${collapsed ? "form-card--collapsed" : ""}`} key={name}>
                <header class="form-card__header">
                  <button
                    type="button"
                    class="form-card__toggle"
                    aria-expanded={!collapsed}
                    aria-controls={bodyId}
                    onClick={() => toggleGroup(name)}
                  >
                    <Icon name="chevron-down" size={15} class={`form-card__chevron ${collapsed ? "icon-rotate-neg90" : ""}`}/>
                    <div class="form-card__title-block">
                      <h2>{name}</h2>
                      <p>{t("field.groupCount", { count: groupedFields.length })}</p>
                    </div>
                    <div class="form-card__badges">
                      {groupModified > 0 && (
                        <span class="group-pill group-pill--modified">
                          {t("field.groupModified", { count: groupModified })}
                        </span>
                      )}
                      {groupErrors > 0 && (
                        <span class="group-pill group-pill--error">
                          {t("field.groupErrors", { count: groupErrors })}
                        </span>
                      )}
                    </div>
                  </button>
                </header>
                {!collapsed && (
                  <div id={bodyId} class="form-card__body">
                    {groupedFields.map((field) => {
                      const key = fieldKey(field);
                      return (
                        <FieldRow
                          key={key}
                          field={field}
                          isCustom={Boolean(customKeys?.has(key))}
                          highlighted={highlightedPath === field.path}
                          value={values[key]}
                          error={errors.get(key)}
                          controlId={controlIds.get(key) ?? `field-${key}`.replace(/[^\w-]/g, "-")}
                          disabled={disabled}
                          aiAvailable={aiAvailable}
                          onExplain={onExplain ? () => onExplain(field) : undefined}
                          onChange={(value, coalesce) => onChange(field, value, { coalesce })}
                          onReset={onResetField ? () => onResetField(field) : undefined}
                          onDelete={onDeleteField ? () => onDeleteField(field) : undefined}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div class="field-filter-empty">
          <Icon name="search"/>
          <span>{t("field.noMatch")}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setQuery("");
              setStatusFilter("all");
            }}
          >
            {t("sidebar.clearFilter")}
          </button>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field,
  isCustom,
  highlighted = false,
  value,
  error,
  controlId,
  disabled,
  aiAvailable,
  onExplain,
  onChange,
  onReset,
  onDelete,
}: {
  field: FieldSpec;
  isCustom: boolean;
  highlighted?: boolean;
  value: unknown;
  error?: string;
  controlId: string;
  disabled: boolean;
  aiAvailable: boolean;
  onExplain?: () => Promise<FieldAssistResult>;
  onChange: (value: unknown, coalesce?: boolean) => void;
  onReset?: () => void;
  onDelete?: () => void;
}) {
  const { t } = useI18n();
  const [assist, setAssist] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "success"; result: FieldAssistResult }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const evidenceTitle = field.evidence
    .map((item) => `${item.property}: ${item.source} (${Math.round(item.confidence * 100)}%)`)
    .join("\n");
  async function requestAssist(): Promise<void> {
    if (!onExplain || assist.status === "loading") return;
    setAssist({ status: "loading" });
    try {
      setAssist({ status: "success", result: await onExplain() });
    } catch (err) {
      setAssist({ status: "error", message: err instanceof Error ? err.message : t("field.aiExplainFailed") });
    }
  }

  function handleChange(nextValue: unknown, coalesce = false): void {
    onChange(nextValue, coalesce);
  }

  const currentEffective = effectiveValue(value);
  const modified = isCustom || isFieldModified(field, value);
  const markedDeleted = !isCustom && field.value !== undefined && currentEffective === undefined;
  const canDelete = isCustom || field.value !== undefined;
  const inactiveExampleRequired = isInactiveExamplePlaceholder(field, currentEffective);

  return (
    <div
      data-field-path={field.path}
      class={`field-row ${field.confidence < 0.7 ? "field-row--suggested" : ""} ${error ? "field-row--error" : ""} ${modified && !error ? "field-row--modified" : ""} ${markedDeleted ? "field-row--deleted" : ""} ${highlighted ? "field-row--highlighted" : ""}`}
    >
      <div class="field-row__meta">
        <div class="field-row__title">
          <label for={controlId}>{field.label}</label>
          {isCustom && <span class="field-badge field-badge--added">{t("field.badgeAdded")}</span>}
          {markedDeleted && <span class="field-badge field-badge--deleted">{t("field.badgeDeleted")}</span>}
          {field.required && !markedDeleted && (
            <span
              class="required-mark"
              title={inactiveExampleRequired ? t("field.recommendedTitle") : t("field.required")}
            >
              {inactiveExampleRequired ? t("field.recommended") : t("field.required")}
            </span>
          )}
        </div>
        <code>{field.path}</code>
        <div class="field-row__meta-bottom">
          <div title={evidenceTitle}><SourceBadge source={field.source} confidence={field.confidence}/></div>
        </div>
      </div>
      <div class="field-row__content">
        <div class="field-description-line">
          {field.description ? (
            <p id={`${controlId}-description`} class="field-description">{field.description}</p>
          ) : (
            <span class="field-description-spacer"/>
          )}
          <div class="field-row__quick-actions">
            {modified && !isCustom && onReset && (
              <button
                type="button"
                class="field-action-btn"
                disabled={disabled}
                onClick={onReset}
                title={markedDeleted ? t("field.cancelDeleteTitle") : t("field.restoreValueTitle")}
              >
                <Icon name="undo" size={12}/>
                <span>{markedDeleted ? t("field.cancelDelete") : t("field.restoreValue")}</span>
              </button>
            )}
            {canDelete && !markedDeleted && onDelete && (
              <button
                type="button"
                class="field-action-btn field-action-btn--danger"
                disabled={disabled}
                onClick={onDelete}
                title={isCustom ? t("field.removeCustomTitle") : t("field.markDeleteTitle")}
              >
                <Icon name="trash" size={12}/>
                <span>{t("common.delete")}</span>
              </button>
            )}
            {aiAvailable && onExplain && !isCustom && (
              <button
                type="button"
                class="field-ai-button"
                disabled={disabled || assist.status === "loading"}
                onClick={() => void requestAssist()}
                title={t("field.aiExplainTitle")}
              >
                <Icon name={assist.status === "loading" ? "loader" : "sparkles"} class={assist.status === "loading" ? "spin" : undefined} size={13}/>
                <span>{assist.status === "loading" ? t("field.aiLoading") : assist.status === "success" ? t("field.aiAskAgain") : t("field.aiExplain")}</span>
              </button>
            )}
          </div>
        </div>
        <FieldControl
          id={controlId}
          field={field}
          value={value}
          error={error}
          descriptionId={field.description ? `${controlId}-description` : undefined}
          disabled={disabled}
          onChange={handleChange}
        />
        {error && <p class="field-error" id={`${controlId}-error`}><Icon name="warning" size={14}/>{error}</p>}
        {!error && field.default !== undefined && (
          <div class="field-hint">
            <span>{t("field.defaultLabel")}<code>{field.secret || field.type === "secret" ? "••••••••" : formatCompact(field.default)}</code></span>
            {currentEffective === undefined && !field.secret && field.type !== "secret" && (
              <button type="button" class="field-default-button" disabled={disabled} onClick={() => handleChange(cloneDefault(field.default))}>{t("field.useDefault")}</button>
            )}
          </div>
        )}
        {assist.status === "success" && (
          <div class="field-ai-result" role="status" aria-live="polite">
            <div class="field-ai-result__heading"><Icon name="sparkles" size={14}/><strong>{t("field.aiResultTitle")}</strong></div>
            <p>{assist.result.explanation}</p>
            {assist.result.recommendation && <p><b>{t("field.aiRecommendation")}</b>{assist.result.recommendation}</p>}
            {assist.result.caution && <p class="field-ai-result__caution"><b>{t("field.aiCaution")}</b>{assist.result.caution}</p>}
          </div>
        )}
        {assist.status === "error" && (
          <div class="field-ai-result field-ai-result--error" role="alert">
            <span>{assist.message}</span>
            {onExplain && <button type="button" onClick={() => void requestAssist()} disabled={disabled}>{t("common.retry")}</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldControl({
  id,
  field,
  value,
  error,
  descriptionId,
  disabled,
  onChange,
}: {
  id: string;
  field: FieldSpec;
  value: unknown;
  error?: string;
  descriptionId?: string;
  disabled: boolean;
  onChange: (value: unknown, coalesce?: boolean) => void;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const [numberText, setNumberText] = useState(() => formatNumberInput(value));
  const lastNumberValue = useRef<unknown>(value);
  useEffect(() => {
    if (Object.is(value, lastNumberValue.current)) return;
    lastNumberValue.current = value;
    setNumberText(formatNumberInput(value));
  }, [value, field.type]);
  const describedBy = [descriptionId, error ? `${id}-error` : undefined].filter(Boolean).join(" ") || undefined;

  if (field.type === "boolean") {
    const checked = value === true;
    const state = value === undefined
      ? t("common.unset")
      : checked
        ? t("field.boolEnabled")
        : t("field.boolDisabled");
    return (
      <div class="boolean-control">
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-label={`${field.label}: ${state}`}
          class={`switch-control ${checked ? "switch-control--on" : ""} ${value === undefined ? "switch-control--unset" : ""}`}
          disabled={disabled}
          onClick={() => onChange(value === undefined ? true : !checked)}
        >
          <span class="switch-control__track"><i/></span>
          <span>{state}</span>
        </button>
        <button
          type="button"
          class="boolean-control__reset"
          disabled={disabled || value === undefined}
          onClick={() => onChange(undefined)}
          aria-label={t("field.setUnsetAria", { label: field.label })}
        >
          {t("common.reset")}
        </button>
      </div>
    );
  }

  if (field.type === "enum") {
    const options = field.enum ?? [];
    const exactIndex = options.findIndex((option) => Object.is(option, value));
    const selectedIndex = exactIndex >= 0
      ? exactIndex
      : options.findIndex((option) => enumValueEqual(option, value));
    const hasNonPresetValue = value !== undefined && selectedIndex < 0;
    const selectValue = selectedIndex >= 0
      ? String(selectedIndex)
      : hasNonPresetValue
        ? "__non_preset__"
        : "";
    return (
      <div class="select-wrap">
        <select
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          value={selectValue}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onChange={(event) => {
            if (event.currentTarget.value === "__non_preset__") return;
            if (event.currentTarget.value === "") {
              onChange(undefined);
              return;
            }
            const index = Number(event.currentTarget.value);
            onChange(Number.isSafeInteger(index) && index >= 0 ? options[index] : undefined);
          }}
        >
          <option value="">{t("field.selectPlaceholder")}</option>
          {hasNonPresetValue && (
            <option value="__non_preset__">
              {`${value === "" ? t("common.emptyStringOption") : formatCompact(value)}${t("field.nonPresetSuffix")}`}
            </option>
          )}
          {options.map((option, index) => (
            <option value={String(index)} key={`${typeof option}:${String(option)}:${index}`}>
              {option === "" ? t("common.emptyStringOption") : String(option)}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={16}/>
      </div>
    );
  }

  if (field.type === "array") {
    return (
      <StructuredArrayControl
        id={id}
        field={field}
        value={value}
        error={error}
        describedBy={describedBy}
        disabled={disabled}
        onChange={(next) => onChange(next, false)}
      />
    );
  }

  if (field.type === "json") {
    return (
      <StructuredObjectControl
        id={id}
        field={field}
        value={value}
        error={error}
        describedBy={describedBy}
        disabled={disabled}
        onChange={(next) => onChange(next, false)}
      />
    );
  }

  if (field.type === "color") {
    const pickerEnabled = value === undefined || value === "" || isHexColor6(value);
    const color = pickerEnabled && isHexColor6(value) ? value : "#2563eb";
    return (
      <div class="color-control">
        <input
          id={`${id}-picker`}
          type="color"
          value={color}
          title={pickerEnabled ? t("field.colorPickerTitle") : t("field.colorPickerDisabledTitle")}
          aria-label={t("field.colorPickerAria", { label: field.label })}
          aria-describedby={describedBy}
          disabled={disabled || !pickerEnabled}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
        <input
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          value={String(value ?? "")}
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value, true)}
          placeholder="#2563eb"
        />
      </div>
    );
  }

  if (field.type === "secret") {
    return (
      <div class="input-with-action">
        <input
          id={id}
          class={`control ${error ? "control--error" : ""}`}
          type={revealed ? "text" : "password"}
          value={String(value ?? "")}
          placeholder={field.placeholder || t("field.secretPlaceholder")}
          autocomplete="off"
          aria-describedby={describedBy}
          aria-invalid={Boolean(error)}
          aria-required={field.required}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value, true)}
        />
        <button
          type="button"
          class="icon-button"
          disabled={disabled}
          onClick={() => setRevealed(!revealed)}
          aria-label={revealed ? t("field.hideSecret") : t("field.showSecret")}
        >
          <Icon name={revealed ? "eye-off" : "eye"}/>
        </button>
      </div>
    );
  }

  if (field.type === "number" || field.type === "integer") {
    const current = typeof value === "number" && Number.isFinite(value) ? value : undefined;
    const { minimum, maximum } = field;
    const slidable = field.type === "integer"
      && typeof minimum === "number" && Number.isSafeInteger(minimum)
      && typeof maximum === "number" && Number.isSafeInteger(maximum)
      && maximum > minimum && maximum - minimum <= 1000;
    if (slidable) {
      const sliderValue = current !== undefined
        ? Math.min(maximum, Math.max(minimum, current))
        : minimum;
      return (
        <div class={`range-control ${error ? "range-control--error" : ""}`}>
          <input
            id={id}
            type="range"
            min={minimum}
            max={maximum}
            step={1}
            value={sliderValue}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            aria-required={field.required}
            aria-valuetext={current === undefined ? t("common.unset") : String(current)}
            disabled={disabled}
            onInput={(event) => {
              const next = event.currentTarget.valueAsNumber;
              lastNumberValue.current = next;
              setNumberText(String(next));
              onChange(next);
            }}
            onClick={(event) => {
              if (current === undefined) {
                const next = event.currentTarget.valueAsNumber;
                lastNumberValue.current = next;
                setNumberText(String(next));
                onChange(next);
              }
            }}
            onKeyDown={(event) => {
              if (current === undefined && ["ArrowLeft", "ArrowDown", "Home", "PageDown", "Enter", " "].includes(event.key)) {
                event.preventDefault();
                lastNumberValue.current = minimum;
                setNumberText(String(minimum));
                onChange(minimum);
              }
            }}
          />
          <input
            id={`${id}-exact`}
            class={`control range-control__input ${error ? "control--error" : ""}`}
            type="text"
            inputMode="numeric"
            value={numberText}
            placeholder="—"
            aria-label={t("field.exactNumberAria", { label: field.label })}
            aria-describedby={describedBy}
            aria-invalid={Boolean(error)}
            disabled={disabled}
            onInput={(event) => {
              const raw = event.currentTarget.value;
              setNumberText(raw);
              if (!raw.trim()) {
                lastNumberValue.current = undefined;
                onChange(undefined);
                return;
              }
              const parsed = Number(raw);
              const valid = Number.isFinite(parsed) && Number.isSafeInteger(parsed);
              lastNumberValue.current = valid ? parsed : raw;
              onChange(valid ? parsed : raw, true);
            }}
            onBlur={() => {
              const parsed = Number(numberText);
              if (numberText.trim() && Number.isFinite(parsed) && Number.isSafeInteger(parsed)) {
                setNumberText(String(parsed));
              }
            }}
          />
          <button
            type="button"
            class="boolean-control__reset range-control__reset"
            disabled={disabled || value === undefined}
            onClick={() => {
              lastNumberValue.current = undefined;
              setNumberText("");
              onChange(undefined);
            }}
            aria-label={t("field.setUnsetAria", { label: field.label })}
          >
            {t("common.reset")}
          </button>
        </div>
      );
    }
    return (
      <input
        id={id}
        class={`control ${error ? "control--error" : ""}`}
        type="text"
        inputMode={field.type === "integer" ? "numeric" : "decimal"}
        value={numberText}
        placeholder={field.placeholder}
        aria-describedby={describedBy}
        aria-invalid={Boolean(error)}
        aria-required={field.required}
        disabled={disabled}
        onInput={(event) => {
          const raw = event.currentTarget.value;
          setNumberText(raw);
          if (!raw.trim()) {
            lastNumberValue.current = undefined;
            onChange(undefined);
            return;
          }
          const parsed = Number(raw);
          const valid = Number.isFinite(parsed)
            && (field.type !== "integer" || Number.isSafeInteger(parsed))
            && (field.type !== "number" || !Number.isInteger(parsed) || Number.isSafeInteger(parsed));
          lastNumberValue.current = valid ? parsed : raw;
          onChange(valid ? parsed : raw, true);
        }}
        onBlur={() => {
          const parsed = Number(numberText);
          if (numberText.trim() && Number.isFinite(parsed)
            && (field.type !== "integer" || Number.isSafeInteger(parsed))
            && (field.type !== "number" || !Number.isInteger(parsed) || Number.isSafeInteger(parsed))) {
            setNumberText(String(parsed));
          }
        }}
      />
    );
  }

  return (
    <input
      id={id}
      class={`control ${error ? "control--error" : ""}`}
      type="text"
      value={String(value ?? "")}
      placeholder={field.placeholder}
      minlength={field.minLength}
      maxlength={field.maxLength}
      aria-describedby={describedBy}
      aria-invalid={Boolean(error)}
      aria-required={field.required}
      disabled={disabled}
      onInput={(event) => onChange(event.currentTarget.value, true)}
    />
  );
}

function normalizeGroupName(group: string | undefined, defaultGroup: string): string {
  const rawGroup = group || defaultGroup;
  return rawGroup === "常规" ? defaultGroup : rawGroup;
}

function groupFields(fields: FieldSpec[], defaultGroup: string): Array<[string, FieldSpec[]]> {
  const groups = new Map<string, FieldSpec[]>();
  for (const field of fields) {
    const name = normalizeGroupName(field.group, defaultGroup);
    const current = groups.get(name) ?? [];
    current.push(field);
    groups.set(name, current);
  }
  return [...groups.entries()];
}

function formatCompact(value: unknown): string {
  if (typeof value === "string") return value;
  const text = JSON.stringify(value);
  return text && text.length > 80 ? `${text.slice(0, 77)}…` : text ?? String(value);
}

function cloneDefault(value: unknown): unknown {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

function formatNumberInput(value: unknown): string {
  return typeof value === "number" || typeof value === "string" ? String(value) : "";
}
