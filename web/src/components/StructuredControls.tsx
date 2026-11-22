import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FieldSpec, ItemFieldSpec, PathSegment } from "../../../shared/schema.ts";
import {
  containsSecretValuePattern,
  isForbiddenKey,
  isHexColor6,
  setSafeProperty,
  valueContainsSecret,
} from "../../../shared/validation.ts";
import {
  clearJsonDraftSubErrors,
  createDefaultObjectItem,
  createJsonDraft,
  enumValueEqual,
  extractCardSummary,
  formatSegmentPath,
  isEditableScalar,
  isJsonDraft,
  isNestedKeySensitive,
  isObjectArray,
  isPlainObject,
  isScalarArray,
  MAX_NESTED_TREE_DEPTH,
  objectHasSchemaSecret,
  parseJsonDraft,
  withJsonDraftSubError,
  type DeepFocusTarget,
  type JsonDraft,
} from "../editor-state.ts";
import { useI18n } from "../i18n/index.tsx";
import { Icon } from "../icons.tsx";

const EMPTY_ARRAY: readonly unknown[] = [];
const EMPTY_OBJECT: Record<string, unknown> = {};
const EMPTY_OBJECT_ARRAY: Array<Record<string, unknown>> = [];

export interface StructuredControlProps {
  id: string;
  field: FieldSpec;
  value: unknown;
  error?: string;
  describedBy?: string;
  disabled: boolean;
  onChange: (value: unknown) => void;
  deepFocusTarget?: DeepFocusTarget;
}

/* -------------------------------------------------------------------------- */
/* 1. StructuredArrayControl (dispatches object arrays -> Card Editor)        */
/* -------------------------------------------------------------------------- */

export function StructuredArrayControl(props: StructuredControlProps) {
  const draft = isJsonDraft(props.value) ? props.value : createJsonDraft(props.value);
  const parsed = draft.error ? undefined : draft.parsed;

  if (!draft.error && isObjectArray(parsed, props.field.itemFields)) {
    return <StructuredObjectArrayControl {...props}/>;
  }

  return <ScalarArrayControl {...props}/>;
}

function ScalarArrayControl({
  id,
  field,
  value,
  error,
  describedBy,
  disabled,
  onChange,
}: StructuredControlProps) {
  const { t } = useI18n();
  const draft = isJsonDraft(value) ? value : createJsonDraft(value);
  const parsed = draft.error ? undefined : draft.parsed;
  const visualEligible = !draft.error && (parsed === undefined || isScalarArray(parsed));
  const [jsonMode, setJsonMode] = useState(!visualEligible);
  const [jsonRevealed, setJsonRevealed] = useState(false);
  const [revealedItems, setRevealedItems] = useState<Record<number, boolean>>({});
  const useJson = jsonMode || !visualEligible;

  const items: Array<string | number | boolean | null> = Array.isArray(parsed) && isScalarArray(parsed)
    ? parsed
    : [];
  const allNumeric = items.length > 0 && items.every((item) => typeof item === "number");
  const fieldSecret = useMemo(
    () => Boolean(
      field.secret
      || field.type === "secret"
      || isNestedKeySensitive(String(field.segments.at(-1) ?? ""), field.segments),
    ),
    [field.secret, field.type, field.segments],
  );
  const hasSecret = useMemo(
    () => fieldSecret || valueContainsSecret(items) || (draft.text.length > 0 && containsSecretValuePattern(draft.text)),
    [fieldSecret, items, draft.text],
  );

  function emitArray(next: Array<string | number | boolean | null>): void {
    onChange(createJsonDraft(next));
  }

  function updateItem(index: number, raw: string): void {
    const prev = items[index];
    let nextVal: string | number | boolean | null = raw;
    if (typeof prev === "number" || allNumeric) {
      const trimmed = raw.trim();
      const num = Number(trimmed);
      if (trimmed !== "" && Number.isFinite(num) && (!Number.isInteger(num) || Number.isSafeInteger(num))) {
        nextVal = num;
      }
    } else if (typeof prev === "boolean") {
      if (raw === "true") nextVal = true;
      else if (raw === "false") nextVal = false;
    }
    const next = [...items];
    next[index] = nextVal;
    emitArray(next);
  }

  function moveItem(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setRevealedItems({});
    emitArray(next);
  }

  function removeItem(index: number): void {
    setRevealedItems({});
    emitArray(items.filter((_, i) => i !== index));
  }

  function addItem(): void {
    emitArray([...items, allNumeric ? 0 : ""]);
  }

  return (
    <div class="code-control structured-control">
      <div class="code-control__bar">
        <div class="structured-control__title">
          <span>{useJson ? "JSON" : "LIST"}</span>
          <small>{useJson ? t("structured.arraySource") : t("structured.itemCount", { count: items.length })}</small>
        </div>
        <button
          type="button"
          class="structured-mode-toggle"
          disabled={disabled || (useJson && !visualEligible)}
          title={!visualEligible && useJson ? t("structured.nestedOnlyJson") : undefined}
          onClick={() => {
            setJsonRevealed(false);
            setJsonMode(!useJson);
          }}
        >
          <Icon name={useJson ? "layers" : "code"} size={13}/>
          <span>{useJson ? t("structured.visualList") : t("structured.jsonSource")}</span>
        </button>
      </div>
      {useJson ? (
        hasSecret && !jsonRevealed ? (
          <div class="structured-secret-gate">
            <div class="structured-secret-gate__info">
              <Icon name="shield" size={15}/>
              <span>{t("structured.treeSecretMasked")}</span>
            </div>
            <button
              type="button"
              class="structured-mode-toggle"
              disabled={disabled}
              onClick={() => setJsonRevealed(true)}
            >
              <Icon name="eye" size={13}/>
              <span>{t("structured.treeRevealJson")}</span>
            </button>
          </div>
        ) : (
          <div class="structured-json-wrap">
            {hasSecret && (
              <div class="structured-secret-gate structured-secret-gate--inline">
                <span><Icon name="shield" size={13}/> {t("structured.treeSecretMasked")}</span>
                <button type="button" class="structured-mode-toggle" onClick={() => setJsonRevealed(false)}>
                  <Icon name="eye-off" size={12}/>
                  <span>{t("structured.treeHideJson")}</span>
                </button>
              </div>
            )}
            <textarea
              id={id}
              class={`control control--code ${error ? "control--error" : ""}`}
              value={draft.text}
              rows={Math.min(14, Math.max(4, draft.text.split("\n").length + 1))}
              spellcheck={false}
              aria-describedby={describedBy}
              aria-invalid={Boolean(error)}
              aria-required={field.required}
              disabled={disabled}
              onInput={(event) => onChange(parseJsonDraft(event.currentTarget.value))}
            />
          </div>
        )
      ) : (
        <div class="structured-list" id={id} aria-describedby={describedBy}>
          {items.length === 0 ? (
            <div class="structured-empty">{t("structured.emptyArray")}</div>
          ) : (
            items.map((item, index) => {
              const itemSecret = fieldSecret || (typeof item === "string" && containsSecretValuePattern(item));
              const isItemRevealed = Boolean(revealedItems[index]);
              return (
                <div class="structured-row" key={index}>
                  <span class="structured-row__index">{index + 1}</span>
                  {typeof item === "boolean" && !itemSecret ? (
                    <button
                      type="button"
                      class={`switch-control structured-bool ${item ? "switch-control--on" : ""}`}
                      role="switch"
                      aria-checked={item}
                      disabled={disabled}
                      onClick={() => {
                        const next = [...items];
                        next[index] = !item;
                        emitArray(next);
                      }}
                    >
                      <span class="switch-control__track"><i/></span>
                      <span>{item ? "true" : "false"}</span>
                    </button>
                  ) : itemSecret ? (
                    <div class="input-with-action structured-row__input">
                      <input
                        class="control"
                        type={isItemRevealed ? "text" : "password"}
                        value={item === null ? "" : String(item)}
                        placeholder={t("field.secretPlaceholder")}
                        autocomplete="off"
                        disabled={disabled}
                        aria-label={t("structured.itemAria", { label: field.label, index: index + 1 })}
                        onInput={(event) => updateItem(index, event.currentTarget.value)}
                      />
                      <button
                        type="button"
                        class="icon-button"
                        disabled={disabled}
                        onClick={() => setRevealedItems((prev) => ({ ...prev, [index]: !prev[index] }))}
                        aria-label={isItemRevealed ? t("field.hideSecret") : t("field.showSecret")}
                        title={isItemRevealed ? t("field.hideSecret") : t("field.showSecret")}
                      >
                        <Icon name={isItemRevealed ? "eye-off" : "eye"} size={14}/>
                      </button>
                    </div>
                  ) : (
                    <input
                      class="control structured-row__input"
                      type="text"
                      inputMode={typeof item === "number" ? "decimal" : undefined}
                      value={item === null ? "" : String(item)}
                      placeholder={item === null ? "null" : t("structured.inputValuePlaceholder")}
                      disabled={disabled}
                      aria-label={t("structured.itemAria", { label: field.label, index: index + 1 })}
                      onInput={(event) => updateItem(index, event.currentTarget.value)}
                    />
                  )}
                  <div class="structured-row__actions">
                    <button
                      type="button"
                      class="icon-button"
                      disabled={disabled || index === 0}
                      onClick={() => moveItem(index, -1)}
                      aria-label={t("structured.moveUp")}
                      title={t("structured.moveUp")}
                    >
                      <Icon name="arrow-up" size={14}/>
                    </button>
                    <button
                      type="button"
                      class="icon-button"
                      disabled={disabled || index === items.length - 1}
                      onClick={() => moveItem(index, 1)}
                      aria-label={t("structured.moveDown")}
                      title={t("structured.moveDown")}
                    >
                      <Icon name="arrow-down" size={14}/>
                    </button>
                    <button
                      type="button"
                      class="icon-button structured-row__delete"
                      disabled={disabled}
                      onClick={() => removeItem(index)}
                      aria-label={t("structured.deleteItem")}
                      title={t("structured.deleteItem")}
                    >
                      <Icon name="trash" size={14}/>
                    </button>
                  </div>
                </div>
              );
            })
          )}
          <div class="structured-footer">
            <button type="button" class="structured-add-btn" disabled={disabled} onClick={addItem}>
              <Icon name="plus" size={14}/>
              <span>{t("structured.addItem")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. StructuredObjectArrayControl (Collapsible Card Editor for Object Arrays)*/
/* -------------------------------------------------------------------------- */

export function StructuredObjectArrayControl({
  id,
  field,
  value,
  error,
  describedBy,
  disabled,
  onChange,
  deepFocusTarget,
}: StructuredControlProps) {
  const { t } = useI18n();
  const draft = isJsonDraft(value) ? value : createJsonDraft(value);
  const parsed = draft.error ? undefined : draft.parsed;
  const cardEligible = !draft.error && isObjectArray(parsed, field.itemFields);
  const items: Array<Record<string, unknown>> = cardEligible ? parsed : EMPTY_OBJECT_ARRAY;

  const [groupJsonMode, setGroupJsonMode] = useState(!cardEligible);
  const [groupJsonRevealed, setGroupJsonRevealed] = useState(false);
  const [collapsedCards, setCollapsedCards] = useState<Record<number, boolean>>(() => {
    // Expand the first card by default when there are few items; collapse others for readability.
    const initial: Record<number, boolean> = {};
    if (items.length > 2) {
      for (let i = 1; i < items.length; i += 1) initial[i] = true;
    }
    return initial;
  });
  const [cardJsonDrafts, setCardJsonDrafts] = useState<Record<number, { text: string; error?: string }>>({});
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [addingPropForCard, setAddingPropForCard] = useState<Record<number, { key: string; val: string; error?: string }>>({});
  const [highlightedDeepPath, setHighlightedDeepPath] = useState<string>();
  const lastEmittedDraftRef = useRef<unknown>(value);
  const handledFocusTokenRef = useRef<number>();
  const highlightTimerRef = useRef<number>();
  const [externalSyncVersion, setExternalSyncVersion] = useState(0);

  const useGroupJson = groupJsonMode || !cardEligible;
  const fieldSecret = useMemo(
    () => Boolean(
      field.secret
      || field.type === "secret"
      || isNestedKeySensitive(String(field.segments.at(-1) ?? ""), field.segments),
    ),
    [field.secret, field.type, field.segments],
  );
  const hasGroupSecret = useMemo(
    () => fieldSecret || items.some((item) => objectHasSchemaSecret(item, field.itemFields, false)),
    [fieldSecret, items, field.itemFields],
  );
  const itemSpecByKey = useMemo(
    () => new Map((field.itemFields ?? []).map((spec) => [spec.key, spec])),
    [field.itemFields],
  );

  function emitDraft(nextDraft: JsonDraft): void {
    lastEmittedDraftRef.current = nextDraft;
    onChange(nextDraft);
  }

  function reportSubError(subKey: string, err?: string): void {
    const nextDraft = err === undefined
      ? clearJsonDraftSubErrors(draft, subKey)
      : withJsonDraftSubError(draft, subKey, err);
    if (nextDraft !== draft) emitDraft(nextDraft);
  }

  useEffect(() => () => {
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
  }, []);

  // Synchronize open single-card JSON drafts and nested fallback blocks when
  // `value` changes externally (Ctrl+Z Undo, Restore Value, Revert All, file switch).
  useEffect(() => {
    if (value === lastEmittedDraftRef.current) return;
    lastEmittedDraftRef.current = value;
    setExternalSyncVersion((prev) => prev + 1);
    setCardJsonDrafts((prev) => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const next: Record<number, { text: string; error?: string }> = {};
      for (const k of keys) {
        const idx = Number(k);
        if (Number.isSafeInteger(idx) && idx >= 0 && idx < items.length) {
          next[idx] = { text: JSON.stringify(items[idx], null, 2) };
        }
      }
      return next;
    });
  }, [value, items]);

  // Auto-expand card & exit JSON mode when Ctrl+K jumps into a card or nested property inside this array.
  useEffect(() => {
    if (!deepFocusTarget?.segments?.length) return;
    if (handledFocusTokenRef.current === deepFocusTarget.token) return;
    const baseLen = field.segments.length;
    if (
      deepFocusTarget.segments.length <= baseLen
      || !field.segments.every((seg, i) => deepFocusTarget.segments![i] === seg)
    ) {
      return;
    }
    const cardIdx = deepFocusTarget.segments[baseLen];
    if (typeof cardIdx !== "number" || cardIdx < 0 || cardIdx >= items.length) return;

    handledFocusTokenRef.current = deepFocusTarget.token;
    if (cardEligible) setGroupJsonMode(false);
    setCollapsedCards((prev) => ({ ...prev, [cardIdx]: false }));
    setCardJsonDrafts((prev) => {
      if (!(cardIdx in prev)) return prev;
      const next = { ...prev };
      delete next[cardIdx];
      return next;
    });
    if (draft.subErrors?.[`card:${cardIdx}`]) {
      reportSubError(`card:${cardIdx}`, undefined);
    }
    const targetPath = deepFocusTarget.path;
    setHighlightedDeepPath(targetPath);
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = undefined;
      setHighlightedDeepPath((current) => (current === targetPath ? undefined : current));
    }, 2_600);
  }, [deepFocusTarget?.path, deepFocusTarget?.segments, deepFocusTarget?.token, field.segments, items.length, cardEligible]);

  function emitCards(next: Array<Record<string, unknown>>, clearSubErrorPrefix?: string): void {
    const baseDraft = createJsonDraft(next);
    if (!draft.subErrors || Object.keys(draft.subErrors).length === 0 || clearSubErrorPrefix === "*") {
      emitDraft(baseDraft);
      return;
    }
    const cleaned = clearSubErrorPrefix
      ? clearJsonDraftSubErrors({ ...baseDraft, subErrors: draft.subErrors }, clearSubErrorPrefix)
      : { ...baseDraft, subErrors: draft.subErrors };
    emitDraft(cleaned);
  }

  function updateCardObject(index: number, nextObj: Record<string, unknown>, clearSubErrorPrefix?: string): void {
    const next = [...items];
    next[index] = nextObj;
    emitCards(next, clearSubErrorPrefix);
  }

  function updateCardProp(index: number, key: string, nextVal: unknown, clearSubErrorPrefix?: string): void {
    const current = items[index] ?? {};
    const cloned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(current)) {
      if (k === key && nextVal === undefined) continue;
      setSafeProperty(cloned, k, v);
    }
    if (nextVal !== undefined) {
      setSafeProperty(cloned, key, nextVal);
    }
    updateCardObject(index, cloned, clearSubErrorPrefix);
  }

  function moveCard(index: number, delta: -1 | 1): void {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    setCardJsonDrafts({});
    setRevealedSecrets({});
    setCollapsedCards((prev) => {
      const copy = { ...prev };
      const a = Boolean(copy[index]);
      const b = Boolean(copy[target]);
      copy[index] = b;
      copy[target] = a;
      return copy;
    });
    emitCards(next, "*");
  }

  function duplicateCard(index: number): void {
    const source = items[index];
    if (!source) return;
    const clone = structuredClone(source);
    const next = [...items];
    next.splice(index + 1, 0, clone);
    setCardJsonDrafts({});
    setRevealedSecrets({});
    setCollapsedCards((prev) => {
      const shifted: Record<number, boolean> = {};
      for (const [k, v] of Object.entries(prev)) {
        const idx = Number(k);
        shifted[idx > index ? idx + 1 : idx] = v;
      }
      shifted[index + 1] = false;
      return shifted;
    });
    emitCards(next, "*");
  }

  function removeCard(index: number): void {
    setCardJsonDrafts({});
    setRevealedSecrets({});
    setCollapsedCards({});
    emitCards(items.filter((_, i) => i !== index), "*");
  }

  function addCard(): void {
    const created = createDefaultObjectItem(items, field.itemFields);
    const nextIndex = items.length;
    setCollapsedCards((prev) => ({ ...prev, [nextIndex]: false }));
    emitCards([...items, created]);
  }

  function toggleCardJson(index: number): void {
    const cardPath = formatSegmentPath([...field.segments, index]);
    if (index in cardJsonDrafts) {
      setCardJsonDrafts((prev) => {
        const next = { ...prev };
        delete next[index];
        return next;
      });
      let nextDraft = clearJsonDraftSubErrors(draft, `card:${index}`);
      nextDraft = clearJsonDraftSubErrors(nextDraft, cardPath);
      if (nextDraft !== draft) emitDraft(nextDraft);
      return;
    }
    const cleared = clearJsonDraftSubErrors(draft, cardPath);
    if (cleared !== draft) emitDraft(cleared);
    const card = items[index] ?? {};
    setCollapsedCards((prev) => ({ ...prev, [index]: false }));
    setCardJsonDrafts((prev) => ({
      ...prev,
      [index]: { text: JSON.stringify(card, null, 2) },
    }));
  }

  function handleCardJsonInput(index: number, rawText: string): void {
    const errMsg = t("structured.cardJsonError");
    const subKey = `card:${index}`;
    try {
      const parsedCard = JSON.parse(rawText);
      if (!isPlainObject(parsedCard)) {
        setCardJsonDrafts((prev) => ({
          ...prev,
          [index]: { text: rawText, error: errMsg },
        }));
        reportSubError(subKey, errMsg);
        return;
      }
      setCardJsonDrafts((prev) => ({ ...prev, [index]: { text: rawText } }));
      updateCardObject(index, parsedCard, subKey);
    } catch {
      setCardJsonDrafts((prev) => ({
        ...prev,
        [index]: { text: rawText, error: errMsg },
      }));
      reportSubError(subKey, errMsg);
    }
  }

  function addPropertyToCard(index: number): void {
    const draftAdd = addingPropForCard[index] ?? { key: "", val: "" };
    const trimmed = draftAdd.key.trim();
    const card = items[index] ?? {};
    if (!trimmed) {
      setAddingPropForCard((prev) => ({ ...prev, [index]: { ...draftAdd, error: t("structured.kvEnterKey") } }));
      return;
    }
    if (isForbiddenKey(trimmed)) {
      setAddingPropForCard((prev) => ({ ...prev, [index]: { ...draftAdd, error: t("structured.kvEmptyOrForbidden") } }));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(card, trimmed)) {
      setAddingPropForCard((prev) => ({ ...prev, [index]: { ...draftAdd, error: t("structured.kvDuplicate", { key: trimmed }) } }));
      return;
    }
    updateCardProp(index, trimmed, draftAdd.val);
    setAddingPropForCard((prev) => ({ ...prev, [index]: { key: "", val: "" } }));
  }

  const allCollapsed = items.length > 0 && items.every((_, idx) => Boolean(collapsedCards[idx]));

  function toggleAllCards(): void {
    if (allCollapsed) {
      setCollapsedCards({});
    } else {
      const next: Record<number, boolean> = {};
      for (let i = 0; i < items.length; i += 1) next[i] = true;
      setCollapsedCards(next);
      const fieldPrefix = formatSegmentPath(field.segments);
      const cleared = clearJsonDraftSubErrors(draft, fieldPrefix);
      if (cleared !== draft) emitDraft(cleared);
    }
  }

  return (
    <div class="code-control structured-control structured-cards-control">
      <div class="code-control__bar">
        <div class="structured-control__title">
          <span>{useGroupJson ? "JSON" : "CARDS"}</span>
          <small>{useGroupJson ? t("structured.arraySource") : t("structured.cardCount", { count: items.length })}</small>
        </div>
        <div class="structured-bar-actions">
          {!useGroupJson && items.length > 1 && (
            <button
              type="button"
              class="structured-mode-toggle"
              disabled={disabled}
              onClick={toggleAllCards}
            >
              <Icon name="chevron-down" size={12} class={allCollapsed ? "icon-rotate-neg90" : ""}/>
              <span>{allCollapsed ? t("structured.cardExpandAll") : t("structured.cardCollapseAll")}</span>
            </button>
          )}
          <button
            type="button"
            class="structured-mode-toggle"
            disabled={disabled || (useGroupJson && !cardEligible)}
            title={!cardEligible && useGroupJson ? t("structured.nestedOnlyJson") : undefined}
            onClick={() => {
              setGroupJsonRevealed(false);
              if (!useGroupJson) {
                setCardJsonDrafts({});
                const cleared = clearJsonDraftSubErrors(draft);
                if (cleared !== draft) emitDraft(cleared);
              }
              setGroupJsonMode(!useGroupJson);
            }}
          >
            <Icon name={useGroupJson ? "layers" : "code"} size={13}/>
            <span>{useGroupJson ? t("structured.cardView") : t("structured.jsonSource")}</span>
          </button>
        </div>
      </div>

      {useGroupJson ? (
        hasGroupSecret && !groupJsonRevealed ? (
          <div class="structured-secret-gate">
            <div class="structured-secret-gate__info">
              <Icon name="shield" size={15}/>
              <span>{t("structured.treeSecretMasked")}</span>
            </div>
            <button
              type="button"
              class="structured-mode-toggle"
              disabled={disabled}
              onClick={() => setGroupJsonRevealed(true)}
            >
              <Icon name="eye" size={13}/>
              <span>{t("structured.treeRevealJson")}</span>
            </button>
          </div>
        ) : (
          <div class="structured-json-wrap">
            {hasGroupSecret && (
              <div class="structured-secret-gate structured-secret-gate--inline">
                <span><Icon name="shield" size={13}/> {t("structured.treeSecretMasked")}</span>
                <button type="button" class="structured-mode-toggle" onClick={() => setGroupJsonRevealed(false)}>
                  <Icon name="eye-off" size={12}/>
                  <span>{t("structured.treeHideJson")}</span>
                </button>
              </div>
            )}
            <textarea
              id={id}
              class={`control control--code ${error ? "control--error" : ""}`}
              value={draft.text}
              rows={Math.min(18, Math.max(5, draft.text.split("\n").length + 1))}
              spellcheck={false}
              aria-describedby={describedBy}
              aria-invalid={Boolean(error)}
              aria-required={field.required}
              disabled={disabled}
              onInput={(event) => emitDraft(parseJsonDraft(event.currentTarget.value))}
            />
          </div>
        )
      ) : (
        <div class="structured-cards" id={id} aria-describedby={describedBy}>
          {items.length === 0 ? (
            <div class="structured-empty">{t("structured.cardEmpty")}</div>
          ) : (
            items.map((item, cardIdx) => {
              const cardSegments: PathSegment[] = [...field.segments, cardIdx];
              const cardPath = formatSegmentPath(cardSegments);
              const collapsed = Boolean(collapsedCards[cardIdx]);
              const cardJson = cardJsonDrafts[cardIdx];
              const summary = extractCardSummary(item, field.itemFields, cardSegments, fieldSecret);
              const cardTitle = summary.title || t("structured.cardFallbackTitle", { index: cardIdx + 1 });
              const cardSecret = objectHasSchemaSecret(item, field.itemFields, fieldSecret);
              const cardJsonRevealKey = `card-json:${cardIdx}`;
              const cardHighlighted = highlightedDeepPath === cardPath;

              // Ordered property keys: schema itemFields first (if present on card or required/explicit), then extra card keys.
              const orderedKeys: string[] = [];
              const seenKeys = new Set<string>();
              for (const spec of field.itemFields ?? []) {
                if (!seenKeys.has(spec.key)) {
                  orderedKeys.push(spec.key);
                  seenKeys.add(spec.key);
                }
              }
              for (const key of Object.keys(item)) {
                if (!isForbiddenKey(key) && !seenKeys.has(key)) {
                  orderedKeys.push(key);
                  seenKeys.add(key);
                }
              }

              const addDraft = addingPropForCard[cardIdx] ?? { key: "", val: "" };

              return (
                <article
                  key={cardIdx}
                  data-deep-path={cardPath}
                  class={`array-card ${collapsed ? "array-card--collapsed" : ""} ${cardHighlighted ? "deep-node--highlighted" : ""}`}
                >
                  <header class="array-card__header">
                    <button
                      type="button"
                      class="array-card__toggle"
                      aria-expanded={!collapsed}
                      onClick={() => {
                        if (!collapsed) {
                          const cleared = clearJsonDraftSubErrors(draft, cardPath);
                          if (cleared !== draft) emitDraft(cleared);
                        }
                        setCollapsedCards((prev) => ({ ...prev, [cardIdx]: !collapsed }));
                      }}
                    >
                      <Icon name="chevron-down" size={14} class={`array-card__chevron ${collapsed ? "icon-rotate-neg90" : ""}`}/>
                      <span class="array-card__index">#{cardIdx + 1}</span>
                      <strong class="array-card__title">{cardTitle}</strong>
                      {summary.badges.length > 0 && (
                        <span class="array-card__badges">
                          {summary.badges.map((badge) => (
                            <span class="array-card__badge" key={badge.key}>
                              <em>{badge.key}</em>
                              <span>{badge.value}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                    <div class="array-card__actions">
                      <button
                        type="button"
                        class="icon-button"
                        disabled={disabled || cardIdx === 0}
                        onClick={() => moveCard(cardIdx, -1)}
                        aria-label={t("structured.moveUp")}
                        title={t("structured.moveUp")}
                      >
                        <Icon name="arrow-up" size={13}/>
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        disabled={disabled || cardIdx === items.length - 1}
                        onClick={() => moveCard(cardIdx, 1)}
                        aria-label={t("structured.moveDown")}
                        title={t("structured.moveDown")}
                      >
                        <Icon name="arrow-down" size={13}/>
                      </button>
                      <button
                        type="button"
                        class="icon-button"
                        disabled={disabled}
                        onClick={() => duplicateCard(cardIdx)}
                        aria-label={t("structured.cardDuplicate")}
                        title={t("structured.cardDuplicate")}
                      >
                        <Icon name="copy" size={13}/>
                      </button>
                      <button
                        type="button"
                        class={`icon-button ${cardJson ? "array-card__action--active" : ""}`}
                        disabled={disabled}
                        onClick={() => toggleCardJson(cardIdx)}
                        aria-label={cardJson ? t("structured.cardBackToForm") : t("structured.cardToggleJson")}
                        title={cardJson ? t("structured.cardBackToForm") : t("structured.cardToggleJson")}
                      >
                        <Icon name={cardJson ? "layers" : "code"} size={13}/>
                      </button>
                      <button
                        type="button"
                        class="icon-button structured-row__delete"
                        disabled={disabled}
                        onClick={() => removeCard(cardIdx)}
                        aria-label={t("structured.deleteItem")}
                        title={t("structured.deleteItem")}
                      >
                        <Icon name="trash" size={13}/>
                      </button>
                    </div>
                  </header>

                  {!collapsed && (
                    <div class="array-card__body">
                      {cardJson ? (
                        cardSecret && !revealedSecrets[cardJsonRevealKey] ? (
                          <div class="structured-secret-gate">
                            <div class="structured-secret-gate__info">
                              <Icon name="shield" size={14}/>
                              <span>{t("structured.treeSecretMasked")}</span>
                            </div>
                            <button
                              type="button"
                              class="structured-mode-toggle"
                              disabled={disabled}
                              onClick={() => setRevealedSecrets((prev) => ({ ...prev, [cardJsonRevealKey]: true }))}
                            >
                              <Icon name="eye" size={12}/>
                              <span>{t("structured.treeRevealJson")}</span>
                            </button>
                          </div>
                        ) : (
                          <div class="array-card__json">
                            <textarea
                              class={`control control--code ${cardJson.error ? "control--error" : ""}`}
                              value={cardJson.text}
                              rows={Math.min(14, Math.max(4, cardJson.text.split("\n").length + 1))}
                              spellcheck={false}
                              aria-invalid={Boolean(cardJson.error)}
                              disabled={disabled}
                              onInput={(event) => handleCardJsonInput(cardIdx, event.currentTarget.value)}
                            />
                            {cardJson.error && (
                              <p class="field-error"><Icon name="warning" size={13}/>{cardJson.error}</p>
                            )}
                          </div>
                        )
                      ) : (
                        <>
                          <div class="array-card__fields">
                            {orderedKeys.map((propKey) => {
                              const spec = itemSpecByKey.get(propKey);
                              const propVal = Object.prototype.hasOwnProperty.call(item, propKey) ? item[propKey] : undefined;
                              const propSegments: PathSegment[] = [...cardSegments, propKey];
                              const propPath = formatSegmentPath(propSegments);
                              const isHighlighted = highlightedDeepPath === propPath;
                              const isFallbackHighlighted = isDeepTargetWithin(highlightedDeepPath, propSegments);
                              const sensitive = fieldSecret || isNestedKeySensitive(propKey, propSegments, propVal, spec);
                              const secretRevealId = `card:${cardIdx}:${propKey}`;
                              const isRevealed = Boolean(revealedSecrets[secretRevealId]);
                              const hasProp = Object.prototype.hasOwnProperty.call(item, propKey);

                              return (
                                <div
                                  key={propKey}
                                  data-deep-path={propPath}
                                  class={`card-field-row ${isHighlighted ? "deep-node--highlighted" : ""}`}
                                >
                                  <div class="card-field-row__meta">
                                    <div class="card-field-row__label">
                                      <span>{spec?.label ?? propKey}</span>
                                      {spec?.required && <em class="card-field-row__req">*</em>}
                                      {sensitive && (
                                        <span class="card-field-row__shield" title={t("diff.secretsMaskedHint")}>
                                          <Icon name="shield" size={11}/>
                                        </span>
                                      )}
                                    </div>
                                    <code>{propKey}</code>
                                    {spec?.description && <small class="card-field-row__desc">{spec.description}</small>}
                                  </div>
                                  <div class="card-field-row__control">
                                    <CardPropertyInput
                                      propKey={propKey}
                                      spec={spec}
                                      value={propVal}
                                      segments={propSegments}
                                      sensitive={sensitive}
                                      revealed={isRevealed}
                                      onToggleReveal={() =>
                                        setRevealedSecrets((prev) => ({ ...prev, [secretRevealId]: !prev[secretRevealId] }))
                                      }
                                      disabled={disabled}
                                      deepFocusTarget={deepFocusTarget}
                                      highlighted={isFallbackHighlighted}
                                      externalSyncVersion={externalSyncVersion}
                                      onSubError={reportSubError}
                                      onChange={(nextVal, clearSubErrorPrefix) =>
                                        updateCardProp(cardIdx, propKey, nextVal, clearSubErrorPrefix ?? propPath)
                                      }
                                    />
                                    {hasProp && !spec?.required && (
                                      <button
                                        type="button"
                                        class="icon-button structured-row__delete card-field-row__remove"
                                        disabled={disabled}
                                        onClick={() => updateCardProp(cardIdx, propKey, undefined, propPath)}
                                        aria-label={t("structured.kvDeleteAria", { key: propKey })}
                                        title={t("common.delete")}
                                      >
                                        <Icon name="x" size={13}/>
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                          <div class="structured-kv-add array-card__add-prop">
                            <input
                              class="control"
                              type="text"
                              value={addDraft.key}
                              placeholder={t("structured.newKeyPlaceholder")}
                              disabled={disabled}
                              onInput={(event) =>
                                setAddingPropForCard((prev) => ({
                                  ...prev,
                                  [cardIdx]: { ...addDraft, key: event.currentTarget.value, error: undefined },
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addPropertyToCard(cardIdx);
                                }
                              }}
                            />
                            <input
                              class="control"
                              type="text"
                              value={addDraft.val}
                              placeholder={t("structured.valuePlaceholder")}
                              disabled={disabled}
                              onInput={(event) =>
                                setAddingPropForCard((prev) => ({
                                  ...prev,
                                  [cardIdx]: { ...addDraft, val: event.currentTarget.value, error: undefined },
                                }))
                              }
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  addPropertyToCard(cardIdx);
                                }
                              }}
                            />
                            <button
                              type="button"
                              class="structured-add-btn"
                              disabled={disabled}
                              onClick={() => addPropertyToCard(cardIdx)}
                            >
                              <Icon name="plus" size={13}/>
                              <span>{t("structured.cardAddProp")}</span>
                            </button>
                          </div>
                          {addDraft.error && (
                            <p class="field-error structured-kv-error"><Icon name="warning" size={13}/>{addDraft.error}</p>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </article>
              );
            })
          )}
          <div class="structured-footer">
            <button type="button" class="structured-add-btn" disabled={disabled} onClick={addCard}>
              <Icon name="plus" size={14}/>
              <span>{t("structured.cardAdd")}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CardPropertyInput({
  propKey,
  spec,
  value,
  segments,
  sensitive,
  revealed,
  onToggleReveal,
  disabled,
  deepFocusTarget,
  highlighted = false,
  externalSyncVersion,
  onSubError,
  onChange,
}: {
  propKey: string;
  spec?: ItemFieldSpec;
  value: unknown;
  segments: PathSegment[];
  sensitive: boolean;
  revealed: boolean;
  onToggleReveal: () => void;
  disabled: boolean;
  deepFocusTarget?: DeepFocusTarget;
  highlighted?: boolean;
  externalSyncVersion?: number;
  onSubError?: (subKey: string, error?: string) => void;
  onChange: (nextVal: unknown, clearSubErrorPrefix?: string) => void;
}) {
  const { t } = useI18n();
  const propPath = formatSegmentPath(segments);

  // Nested plain object inside a card -> delegate to NestedObjectTree (recursive up to 4 levels!)
  if (isPlainObject(value)) {
    return (
      <div class="card-field-row__nested">
        <NestedObjectTree
          value={value}
          baseSegments={segments}
          depth={1}
          disabled={disabled}
          ancestorSecret={sensitive}
          deepFocusTarget={deepFocusTarget}
          externalSyncVersion={externalSyncVersion}
          onSubError={onSubError}
          onChange={(nextObj, clearSubErrorPrefix) => onChange(nextObj, clearSubErrorPrefix)}
        />
      </div>
    );
  }

  // Nested array inside a card -> inline JSON fallback with error propagation & highlight
  if (Array.isArray(value) || spec?.type === "array") {
    return (
      <DeepJsonFallbackBlock
        value={value ?? EMPTY_ARRAY}
        sensitive={sensitive || valueContainsSecret(value)}
        disabled={disabled}
        compact
        deepPath={propPath}
        highlighted={highlighted}
        externalSyncVersion={externalSyncVersion}
        onErrorChange={(err) => onSubError?.(propPath, err)}
        onChange={(nextVal) => onChange(nextVal, propPath)}
      />
    );
  }

  // Sensitive scalar -> strictly masked password input with one-click eye reveal/hide
  if (sensitive) {
    return (
      <div class="input-with-action card-secret-input">
        <input
          class="control structured-kv-row__val"
          type={revealed ? "text" : "password"}
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={spec?.placeholder || t("field.secretPlaceholder")}
          autocomplete="off"
          disabled={disabled}
          aria-label={propKey}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
        <button
          type="button"
          class="icon-button"
          disabled={disabled}
          onClick={onToggleReveal}
          aria-label={revealed ? t("field.hideSecret") : t("field.showSecret")}
          title={revealed ? t("field.hideSecret") : t("field.showSecret")}
        >
          <Icon name={revealed ? "eye-off" : "eye"} size={14}/>
        </button>
      </div>
    );
  }

  // Enum from schema items.properties
  if (spec?.enum?.length) {
    const options = spec.enum;
    const selectedIndex = options.findIndex((opt) => Object.is(opt, value) || enumValueEqual(opt, value));
    const hasCustom = value !== undefined && selectedIndex < 0;
    const selectValue = selectedIndex >= 0 ? String(selectedIndex) : hasCustom ? "__custom__" : "";
    return (
      <div class="select-wrap card-select-wrap">
        <select
          class="control structured-kv-row__val"
          value={selectValue}
          disabled={disabled}
          aria-label={spec.label}
          onChange={(event) => {
            const raw = event.currentTarget.value;
            if (raw === "__custom__") return;
            if (raw === "") {
              onChange(undefined);
              return;
            }
            const idx = Number(raw);
            onChange(Number.isSafeInteger(idx) && idx >= 0 ? options[idx] : undefined);
          }}
        >
          <option value="">{t("field.selectPlaceholder")}</option>
          {hasCustom && <option value="__custom__">{String(value)}</option>}
          {options.map((opt, i) => (
            <option key={`${typeof opt}:${String(opt)}:${i}`} value={String(i)}>
              {String(opt)}
            </option>
          ))}
        </select>
        <Icon name="chevron-down" size={14}/>
      </div>
    );
  }

  // Boolean switch
  if (typeof value === "boolean" || spec?.type === "boolean") {
    const checked = value === true;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        class={`switch-control structured-bool ${checked ? "switch-control--on" : ""}`}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span class="switch-control__track"><i/></span>
        <span>{value === undefined ? t("common.unset") : checked ? "true" : "false"}</span>
      </button>
    );
  }

  // Color
  if (spec?.type === "color") {
    const color = isHexColor6(value) ? value : "#2563eb";
    return (
      <div class="color-control card-color-control">
        <input
          type="color"
          value={color}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
        <input
          class="control structured-kv-row__val"
          type="text"
          value={String(value ?? "")}
          placeholder="#2563eb"
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
        />
      </div>
    );
  }

  // Numeric
  if (typeof value === "number" || spec?.type === "integer" || spec?.type === "number") {
    return (
      <input
        class="control structured-kv-row__val"
        type="text"
        inputMode={spec?.type === "integer" ? "numeric" : "decimal"}
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={spec?.placeholder ?? t("structured.valuePlaceholder")}
        disabled={disabled}
        aria-label={propKey}
        onInput={(event) => {
          const raw = event.currentTarget.value;
          if (!raw.trim()) {
            onChange(undefined);
            return;
          }
          const num = Number(raw.trim());
          if (Number.isFinite(num) && (!Number.isInteger(num) || Number.isSafeInteger(num))) {
            onChange(num);
          } else {
            onChange(raw);
          }
        }}
      />
    );
  }

  // Default string input
  return (
    <input
      class="control structured-kv-row__val"
      type="text"
      value={value === undefined || value === null ? "" : String(value)}
      placeholder={spec?.placeholder ?? (value === null ? "null" : t("structured.valuePlaceholder"))}
      disabled={disabled}
      aria-label={propKey}
      onInput={(event) => onChange(event.currentTarget.value)}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* 3. StructuredObjectControl & Recursive NestedObjectTree (Max 4 Levels)     */
/* -------------------------------------------------------------------------- */

export function StructuredObjectControl({
  id,
  field,
  value,
  error,
  describedBy,
  disabled,
  onChange,
  deepFocusTarget,
}: StructuredControlProps) {
  const { t } = useI18n();
  const draft = isJsonDraft(value) ? value : createJsonDraft(value);
  const parsed = draft.error ? undefined : draft.parsed;
  const treeEligible = !draft.error && (parsed === undefined || isPlainObject(parsed));
  const [jsonMode, setJsonMode] = useState(!treeEligible);
  const [jsonRevealed, setJsonRevealed] = useState(false);
  const useJson = jsonMode || !treeEligible;
  const lastEmittedDraftRef = useRef<unknown>(value);
  const handledFocusTokenRef = useRef<number>();
  const [externalSyncVersion, setExternalSyncVersion] = useState(0);

  const objectVal: Record<string, unknown> = isPlainObject(parsed) ? parsed : EMPTY_OBJECT;
  const isNested = useMemo(
    () => Object.values(objectVal).some((v) => !isEditableScalar(v)),
    [objectVal],
  );
  const fieldSecret = useMemo(
    () => Boolean(
      field.secret
      || field.type === "secret"
      || isNestedKeySensitive(String(field.segments.at(-1) ?? ""), field.segments),
    ),
    [field.secret, field.type, field.segments],
  );
  const hasSecret = useMemo(
    () => fieldSecret || valueContainsSecret(objectVal) || (draft.text.length > 0 && containsSecretValuePattern(draft.text)),
    [fieldSecret, objectVal, draft.text],
  );

  function emitDraft(nextDraft: JsonDraft): void {
    lastEmittedDraftRef.current = nextDraft;
    onChange(nextDraft);
  }

  function reportSubError(subKey: string, err?: string): void {
    const nextDraft = err === undefined
      ? clearJsonDraftSubErrors(draft, subKey)
      : withJsonDraftSubError(draft, subKey, err);
    if (nextDraft !== draft) emitDraft(nextDraft);
  }

  function emitObject(nextObj: Record<string, unknown>, clearSubErrorPrefix?: string): void {
    const baseDraft = createJsonDraft(nextObj);
    if (!draft.subErrors || Object.keys(draft.subErrors).length === 0 || clearSubErrorPrefix === "*") {
      emitDraft(baseDraft);
      return;
    }
    const cleaned = clearSubErrorPrefix
      ? clearJsonDraftSubErrors({ ...baseDraft, subErrors: draft.subErrors }, clearSubErrorPrefix)
      : { ...baseDraft, subErrors: draft.subErrors };
    emitDraft(cleaned);
  }

  useEffect(() => {
    if (value === lastEmittedDraftRef.current) return;
    lastEmittedDraftRef.current = value;
    setExternalSyncVersion((prev) => prev + 1);
  }, [value]);

  useEffect(() => {
    if (!deepFocusTarget?.segments?.length || !treeEligible) return;
    if (handledFocusTokenRef.current === deepFocusTarget.token) return;
    if (
      deepFocusTarget.segments.length > field.segments.length
      && field.segments.every((seg, idx) => deepFocusTarget.segments![idx] === seg)
    ) {
      handledFocusTokenRef.current = deepFocusTarget.token;
      setJsonMode(false);
    }
  }, [deepFocusTarget?.segments, deepFocusTarget?.token, field.segments, treeEligible]);

  return (
    <div class="code-control structured-control">
      <div class="code-control__bar">
        <div class="structured-control__title">
          <span>{useJson ? "JSON" : isNested ? "TREE" : "KEY / VALUE"}</span>
          <small>
            {useJson
              ? t("structured.objectSource")
              : t("structured.kvCount", { count: Object.keys(objectVal).length })}
          </small>
        </div>
        <button
          type="button"
          class="structured-mode-toggle"
          disabled={disabled || (useJson && !treeEligible)}
          title={!treeEligible && useJson ? t("structured.nestedOnlyJson") : undefined}
          onClick={() => {
            setJsonRevealed(false);
            if (!useJson) {
              const cleared = clearJsonDraftSubErrors(draft);
              if (cleared !== draft) emitDraft(cleared);
            }
            setJsonMode(!useJson);
          }}
        >
          <Icon name={useJson ? "layers" : "code"} size={13}/>
          <span>
            {useJson
              ? (isNested ? t("structured.treeView") : t("structured.kvTable"))
              : t("structured.jsonSource")}
          </span>
        </button>
      </div>

      {useJson ? (
        hasSecret && !jsonRevealed ? (
          <div class="structured-secret-gate">
            <div class="structured-secret-gate__info">
              <Icon name="shield" size={15}/>
              <span>{t("structured.treeSecretMasked")}</span>
            </div>
            <button
              type="button"
              class="structured-mode-toggle"
              disabled={disabled}
              onClick={() => setJsonRevealed(true)}
            >
              <Icon name="eye" size={13}/>
              <span>{t("structured.treeRevealJson")}</span>
            </button>
          </div>
        ) : (
          <div class="structured-json-wrap">
            {hasSecret && (
              <div class="structured-secret-gate structured-secret-gate--inline">
                <span><Icon name="shield" size={13}/> {t("structured.treeSecretMasked")}</span>
                <button type="button" class="structured-mode-toggle" onClick={() => setJsonRevealed(false)}>
                  <Icon name="eye-off" size={12}/>
                  <span>{t("structured.treeHideJson")}</span>
                </button>
              </div>
            )}
            <textarea
              id={id}
              class={`control control--code ${error ? "control--error" : ""}`}
              value={draft.text}
              rows={Math.min(16, Math.max(4, draft.text.split("\n").length + 1))}
              spellcheck={false}
              aria-describedby={describedBy}
              aria-invalid={Boolean(error)}
              aria-required={field.required}
              disabled={disabled}
              onInput={(event) => emitDraft(parseJsonDraft(event.currentTarget.value))}
            />
          </div>
        )
      ) : (
        <div class="structured-list nested-tree-root" id={id} aria-describedby={describedBy}>
          <NestedObjectTree
            value={objectVal}
            baseSegments={field.segments}
            depth={1}
            disabled={disabled}
            ancestorSecret={fieldSecret}
            deepFocusTarget={deepFocusTarget}
            externalSyncVersion={externalSyncVersion}
            onSubError={reportSubError}
            onChange={(nextObj, clearSubErrorPrefix) => emitObject(nextObj, clearSubErrorPrefix)}
          />
        </div>
      )}
    </div>
  );
}

type NewChildType = "string" | "number" | "boolean" | "object";

export interface NestedObjectTreeProps {
  value: Record<string, unknown>;
  baseSegments: readonly PathSegment[];
  /** Current 1-based depth within the nested tree (max 4; deeper objects gracefully fall back to JSON). */
  depth: number;
  disabled: boolean;
  /** True when any enclosing field or ancestor object is marked secret (e.g. schema `writeOnly: true`). */
  ancestorSecret?: boolean;
  deepFocusTarget?: DeepFocusTarget;
  externalSyncVersion?: number;
  onSubError?: (subKey: string, error?: string) => void;
  onChange: (next: Record<string, unknown>, clearSubErrorPrefix?: string) => void;
}

export function NestedObjectTree({
  value,
  baseSegments,
  depth,
  disabled,
  ancestorSecret = false,
  deepFocusTarget,
  externalSyncVersion,
  onSubError,
  onChange,
}: NestedObjectTreeProps) {
  const { t } = useI18n();
  const entries = Object.entries(value).filter(([k]) => !isForbiddenKey(k));
  const [expandedNodes, setExpandedNodes] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    // Expand first level nested objects cleanly if compact.
    if (depth === 1 && entries.length <= 6) {
      for (const [k, v] of entries) {
        if (isPlainObject(v)) initial[k] = true;
      }
    }
    return initial;
  });
  const [revealedSecrets, setRevealedSecrets] = useState<Record<string, boolean>>({});
  const [newKey, setNewKey] = useState("");
  const [newVal, setNewVal] = useState("");
  const [newType, setNewType] = useState<NewChildType>("string");
  const [kvError, setKvError] = useState<string>();
  const [highlightedPath, setHighlightedPath] = useState<string>();
  const basePath = formatSegmentPath(baseSegments);
  const baseSegmentsRef = useRef(baseSegments);
  baseSegmentsRef.current = baseSegments;
  const handledFocusTokenRef = useRef<number>();
  const highlightTimerRef = useRef<number>();

  useEffect(() => () => {
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = undefined;
    }
  }, []);

  // Auto-expand ancestor node once per deepFocusTarget token whenever Ctrl+K targets a descendant path.
  useEffect(() => {
    if (!deepFocusTarget?.segments?.length) return;
    if (handledFocusTokenRef.current === deepFocusTarget.token) return;
    const currentBase = baseSegmentsRef.current;
    const baseLen = currentBase.length;
    if (
      deepFocusTarget.segments.length <= baseLen
      || !currentBase.every((seg, idx) => deepFocusTarget.segments![idx] === seg)
    ) {
      return;
    }
    handledFocusTokenRef.current = deepFocusTarget.token;
    const childSeg = deepFocusTarget.segments[baseLen];
    if (typeof childSeg === "string") {
      setExpandedNodes((prev) => (prev[childSeg] ? prev : { ...prev, [childSeg]: true }));
    }
    const targetPath = deepFocusTarget.path;
    setHighlightedPath(targetPath);
    if (highlightTimerRef.current !== undefined) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightTimerRef.current = window.setTimeout(() => {
      highlightTimerRef.current = undefined;
      setHighlightedPath((current) => (current === targetPath ? undefined : current));
    }, 2_600);
  }, [deepFocusTarget?.path, deepFocusTarget?.segments, deepFocusTarget?.token, basePath]);

  function emitWithEntries(nextEntries: Array<[string, unknown]>, clearSubErrorPrefix?: string): void {
    const next: Record<string, unknown> = {};
    for (const [k, v] of nextEntries) {
      setSafeProperty(next, k, v);
    }
    onChange(next, clearSubErrorPrefix);
  }

  function updateValue(key: string, nextVal: unknown, clearSubErrorPrefix?: string): void {
    emitWithEntries(entries.map(([k, v]) => (k === key ? [k, nextVal] : [k, v])), clearSubErrorPrefix);
  }

  function renameKey(oldKey: string, candidateKey: string): void {
    const trimmed = candidateKey.trim();
    if (!trimmed || isForbiddenKey(trimmed)) {
      setKvError(t("structured.kvEmptyOrForbidden"));
      return;
    }
    if (trimmed !== oldKey && entries.some(([k]) => k === trimmed)) {
      setKvError(t("structured.kvDuplicate", { key: trimmed }));
      return;
    }
    setKvError(undefined);
    const oldPath = formatSegmentPath([...baseSegments, oldKey]);
    emitWithEntries(entries.map(([k, v]) => (k === oldKey ? [trimmed, v] : [k, v])), oldPath);
  }

  function removeKey(key: string): void {
    setKvError(undefined);
    setRevealedSecrets((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    const removedPath = formatSegmentPath([...baseSegments, key]);
    emitWithEntries(entries.filter(([k]) => k !== key), removedPath);
  }

  function addChild(): void {
    const trimmed = newKey.trim();
    if (!trimmed) {
      setKvError(t("structured.kvEnterKey"));
      return;
    }
    if (isForbiddenKey(trimmed)) {
      setKvError(t("structured.kvEmptyOrForbidden"));
      return;
    }
    if (entries.some(([k]) => k === trimmed)) {
      setKvError(t("structured.kvDuplicate", { key: trimmed }));
      return;
    }
    setKvError(undefined);
    let initialVal: unknown = newVal;
    if (newType === "boolean") {
      initialVal = newVal.trim().toLowerCase() === "true";
    } else if (newType === "number") {
      const parsedNum = Number(newVal.trim());
      initialVal = newVal.trim() !== "" && Number.isFinite(parsedNum) ? parsedNum : 0;
    } else if (newType === "object") {
      initialVal = {};
    }
    emitWithEntries([...entries, [trimmed, initialVal]]);
    if (newType === "object") {
      setExpandedNodes((prev) => ({ ...prev, [trimmed]: true }));
    }
    setNewKey("");
    setNewVal("");
  }

  function updateScalarFromText(key: string, prev: unknown, raw: string): void {
    let nextVal: unknown = raw;
    if (typeof prev === "number") {
      const num = Number(raw.trim());
      if (raw.trim() !== "" && Number.isFinite(num) && (!Number.isInteger(num) || Number.isSafeInteger(num))) {
        nextVal = num;
      }
    } else if (typeof prev === "boolean") {
      if (raw === "true") nextVal = true;
      else if (raw === "false") nextVal = false;
    }
    updateValue(key, nextVal);
  }

  return (
    <div class={`nested-tree nested-tree--depth-${Math.min(depth, MAX_NESTED_TREE_DEPTH)}`}>
      {entries.length === 0 ? (
        <div class="structured-empty">{t("structured.emptyObject")}</div>
      ) : (
        entries.map(([key, val]) => {
          const childSegments: PathSegment[] = [...baseSegments, key];
          const childPath = formatSegmentPath(childSegments);
          const sensitive = ancestorSecret || isNestedKeySensitive(key, childSegments, val);
          const isHighlighted = highlightedPath === childPath;
          const isFallbackHighlighted = isDeepTargetWithin(highlightedPath, childSegments);

          // Nested plain object child
          if (isPlainObject(val)) {
            const expanded = Boolean(expandedNodes[key]);
            const childCount = Object.keys(val).length;
            const exceedsDepth = depth >= MAX_NESTED_TREE_DEPTH;
            const subtreeHasSecret = sensitive || valueContainsSecret(val);

            return (
              <div
                key={key}
                data-deep-path={childPath}
                class={`nested-node ${expanded ? "nested-node--expanded" : ""} ${isHighlighted ? "deep-node--highlighted" : ""}`}
              >
                <div class="nested-node__header">
                  <button
                    type="button"
                    class="nested-node__toggle"
                    aria-expanded={expanded}
                    onClick={() => {
                      if (expanded) onSubError?.(childPath, undefined);
                      setExpandedNodes((prev) => ({ ...prev, [key]: !expanded }));
                    }}
                  >
                    <Icon name="chevron-down" size={13} class={`nested-node__chevron ${expanded ? "" : "icon-rotate-neg90"}`}/>
                    <code class="nested-node__key">{key}</code>
                    <span class="nested-node__count">{t("structured.treeChildCount", { count: childCount })}</span>
                    {subtreeHasSecret && (
                      <span class="card-field-row__shield" title={t("diff.secretsMaskedHint")}>
                        <Icon name="shield" size={11}/>
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    class="icon-button structured-row__delete"
                    disabled={disabled}
                    onClick={() => removeKey(key)}
                    aria-label={t("structured.kvDeleteAria", { key })}
                    title={t("common.delete")}
                  >
                    <Icon name="trash" size={13}/>
                  </button>
                </div>

                {expanded && (
                  <div class="nested-node__children">
                    {exceedsDepth ? (
                      <div class="nested-depth-fallback">
                        <div class="nested-depth-fallback__hint">
                          <Icon name="info" size={12}/>
                          <span>{t("structured.treeDepthFallback")}</span>
                        </div>
                        <DeepJsonFallbackBlock
                          value={val}
                          sensitive={subtreeHasSecret}
                          disabled={disabled}
                          deepPath={childPath}
                          highlighted={isFallbackHighlighted}
                          externalSyncVersion={externalSyncVersion}
                          onErrorChange={(err) => onSubError?.(childPath, err)}
                          onChange={(nextVal) => updateValue(key, nextVal, childPath)}
                        />
                      </div>
                    ) : (
                      <NestedObjectTree
                        value={val}
                        baseSegments={childSegments}
                        depth={depth + 1}
                        disabled={disabled}
                        ancestorSecret={sensitive}
                        deepFocusTarget={deepFocusTarget}
                        externalSyncVersion={externalSyncVersion}
                        onSubError={onSubError}
                        onChange={(nextChild, clearSubErrorPrefix) => updateValue(key, nextChild, clearSubErrorPrefix)}
                      />
                    )}
                  </div>
                )}
              </div>
            );
          }

          // Nested array child inside an object
          if (Array.isArray(val)) {
            const expanded = Boolean(expandedNodes[key]);
            const arrayHasSecret = sensitive || valueContainsSecret(val);
            return (
              <div
                key={key}
                data-deep-path={childPath}
                class={`nested-node ${expanded ? "nested-node--expanded" : ""} ${isHighlighted ? "deep-node--highlighted" : ""}`}
              >
                <div class="nested-node__header">
                  <button
                    type="button"
                    class="nested-node__toggle"
                    aria-expanded={expanded}
                    onClick={() => {
                      if (expanded) onSubError?.(childPath, undefined);
                      setExpandedNodes((prev) => ({ ...prev, [key]: !expanded }));
                    }}
                  >
                    <Icon name="chevron-down" size={13} class={`nested-node__chevron ${expanded ? "" : "icon-rotate-neg90"}`}/>
                    <code class="nested-node__key">{key}</code>
                    <span class="nested-node__count">[{val.length}]</span>
                    {arrayHasSecret && (
                      <span class="card-field-row__shield" title={t("diff.secretsMaskedHint")}>
                        <Icon name="shield" size={11}/>
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    class="icon-button structured-row__delete"
                    disabled={disabled}
                    onClick={() => removeKey(key)}
                    aria-label={t("structured.kvDeleteAria", { key })}
                    title={t("common.delete")}
                  >
                    <Icon name="trash" size={13}/>
                  </button>
                </div>
                {expanded && (
                  <div class="nested-node__children">
                    <DeepJsonFallbackBlock
                      value={val}
                      sensitive={arrayHasSecret}
                      disabled={disabled}
                      deepPath={childPath}
                      highlighted={isFallbackHighlighted}
                      externalSyncVersion={externalSyncVersion}
                      onErrorChange={(err) => onSubError?.(childPath, err)}
                      onChange={(nextVal) => updateValue(key, nextVal, childPath)}
                    />
                  </div>
                )}
              </div>
            );
          }

          // Scalar leaf inside NestedObjectTree
          const isRevealed = Boolean(revealedSecrets[key]);
          return (
            <div
              key={key}
              data-deep-path={childPath}
              class={`structured-kv-row nested-leaf-row ${isHighlighted ? "deep-node--highlighted" : ""}`}
            >
              <div class="nested-leaf-row__key-wrap">
                <input
                  class="control structured-kv-row__key"
                  type="text"
                  value={key}
                  disabled={disabled}
                  aria-label={t("structured.kvKeyAria", { label: formatSegmentPath(baseSegments), key })}
                  onBlur={(event) => {
                    if (event.currentTarget.value !== key) renameKey(key, event.currentTarget.value);
                  }}
                />
                {sensitive && (
                  <span class="nested-leaf-row__shield" title={t("diff.secretsMaskedHint")}>
                    <Icon name="shield" size={11}/>
                  </span>
                )}
              </div>

              {sensitive ? (
                <div class="input-with-action nested-secret-input">
                  <input
                    class="control structured-kv-row__val"
                    type={isRevealed ? "text" : "password"}
                    value={val === null || val === undefined ? "" : String(val)}
                    placeholder={t("field.secretPlaceholder")}
                    autocomplete="off"
                    disabled={disabled}
                    aria-label={t("structured.kvValAria", { label: formatSegmentPath(baseSegments), key })}
                    onInput={(event) => updateScalarFromText(key, val, event.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="icon-button"
                    disabled={disabled}
                    onClick={() => setRevealedSecrets((prev) => ({ ...prev, [key]: !prev[key] }))}
                    aria-label={isRevealed ? t("field.hideSecret") : t("field.showSecret")}
                    title={isRevealed ? t("field.hideSecret") : t("field.showSecret")}
                  >
                    <Icon name={isRevealed ? "eye-off" : "eye"} size={14}/>
                  </button>
                </div>
              ) : typeof val === "boolean" ? (
                <button
                  type="button"
                  role="switch"
                  aria-checked={val}
                  class={`switch-control structured-bool ${val ? "switch-control--on" : ""}`}
                  disabled={disabled}
                  onClick={() => updateValue(key, !val)}
                >
                  <span class="switch-control__track"><i/></span>
                  <span>{val ? "true" : "false"}</span>
                </button>
              ) : (
                <input
                  class="control structured-kv-row__val"
                  type="text"
                  inputMode={typeof val === "number" ? "decimal" : undefined}
                  value={val === null || val === undefined ? "" : String(val)}
                  placeholder={val === null ? "null" : t("structured.valuePlaceholder")}
                  disabled={disabled}
                  aria-label={t("structured.kvValAria", { label: formatSegmentPath(baseSegments), key })}
                  onInput={(event) => updateScalarFromText(key, val, event.currentTarget.value)}
                />
              )}

              <button
                type="button"
                class="icon-button structured-row__delete"
                disabled={disabled}
                onClick={() => removeKey(key)}
                aria-label={t("structured.kvDeleteAria", { key })}
                title={t("common.delete")}
              >
                <Icon name="trash" size={14}/>
              </button>
            </div>
          );
        })
      )}

      <div class="structured-kv-add nested-tree__add">
        <input
          class="control"
          type="text"
          value={newKey}
          placeholder={t("structured.newKeyPlaceholder")}
          disabled={disabled}
          onInput={(event) => setNewKey(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addChild(); } }}
        />
        {newType === "object" ? (
          <span class="nested-tree__obj-hint">{"{ }"}</span>
        ) : (
          <input
            class="control"
            type="text"
            value={newVal}
            placeholder={newType === "boolean" ? "true / false" : t("structured.valuePlaceholder")}
            disabled={disabled}
            onInput={(event) => setNewVal(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addChild(); } }}
          />
        )}
        <select
          class="control nested-tree__type-select"
          value={newType}
          disabled={disabled}
          aria-label={t("addKeyModal.typeLabel")}
          onChange={(event) => setNewType(event.currentTarget.value as NewChildType)}
        >
          <option value="string">{t("structured.treeTypeString")}</option>
          <option value="number">{t("structured.treeTypeNumber")}</option>
          <option value="boolean">{t("structured.treeTypeBoolean")}</option>
          {depth < MAX_NESTED_TREE_DEPTH && (
            <option value="object">{t("structured.treeTypeObject")}</option>
          )}
        </select>
        <button type="button" class="structured-add-btn" disabled={disabled} onClick={addChild}>
          <Icon name="plus" size={13}/>
          <span>{t("structured.treeAddChild")}</span>
        </button>
      </div>
      {kvError && <p class="field-error structured-kv-error"><Icon name="warning" size={13}/>{kvError}</p>}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Shared secret-aware structured JSON fallback block                         */
/* -------------------------------------------------------------------------- */

function isDeepTargetWithin(
  highlightedPath: string | undefined,
  prefixSegments: readonly PathSegment[],
): boolean {
  if (!highlightedPath) return false;
  const prefixPath = formatSegmentPath(prefixSegments);
  return highlightedPath === prefixPath
    || highlightedPath.startsWith(`${prefixPath}.`)
    || highlightedPath.startsWith(`${prefixPath}[`);
}

function DeepJsonFallbackBlock({
  value,
  sensitive,
  disabled,
  compact = false,
  deepPath,
  highlighted = false,
  externalSyncVersion = 0,
  onErrorChange,
  onChange,
}: {
  value: unknown;
  sensitive: boolean;
  disabled: boolean;
  compact?: boolean;
  deepPath?: string;
  highlighted?: boolean;
  externalSyncVersion?: number;
  onErrorChange?: (error?: string) => void;
  onChange: (nextValue: unknown) => void;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState<string>();
  const lastEmittedValueRef = useRef<unknown>(value);
  const lastSyncVersionRef = useRef<number>(externalSyncVersion);
  const parseErrorRef = useRef<string | undefined>(parseError);
  parseErrorRef.current = parseError;
  const onErrorChangeRef = useRef(onErrorChange);
  onErrorChangeRef.current = onErrorChange;

  useEffect(() => {
    // External history/reset/switch or genuine external value replacement
    // overwrites stale local draft/parseError and clears any lingering parent subError.
    const syncChanged = externalSyncVersion !== lastSyncVersionRef.current;
    const valueChanged = value !== lastEmittedValueRef.current;
    if (!syncChanged && !valueChanged) return;
    lastSyncVersionRef.current = externalSyncVersion;
    lastEmittedValueRef.current = value;
    setText(JSON.stringify(value, null, 2));
    setParseError(undefined);
    if (parseErrorRef.current !== undefined) {
      parseErrorRef.current = undefined;
      onErrorChangeRef.current?.(undefined);
    }
  }, [value, externalSyncVersion]);

  if (sensitive && !revealed) {
    return (
      <div
        data-deep-path={deepPath}
        class={`structured-secret-gate ${highlighted ? "deep-node--highlighted" : ""}`}
      >
        <div class="structured-secret-gate__info">
          <Icon name="shield" size={14}/>
          <span>{t("structured.treeSecretMasked")}</span>
        </div>
        <button
          type="button"
          class="structured-mode-toggle"
          disabled={disabled}
          onClick={() => setRevealed(true)}
        >
          <Icon name="eye" size={12}/>
          <span>{t("structured.treeRevealJson")}</span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-deep-path={deepPath}
      class={`deep-json-fallback ${highlighted ? "deep-node--highlighted" : ""}`}
    >
      {sensitive && (
        <div class="structured-secret-gate structured-secret-gate--inline">
          <span><Icon name="shield" size={12}/> {t("structured.treeSecretMasked")}</span>
          <button type="button" class="structured-mode-toggle" onClick={() => setRevealed(false)}>
            <Icon name="eye-off" size={12}/>
            <span>{t("structured.treeHideJson")}</span>
          </button>
        </div>
      )}
      <textarea
        class={`control control--code ${parseError ? "control--error" : ""}`}
        value={text}
        rows={Math.min(compact ? 8 : 12, Math.max(3, text.split("\n").length + 1))}
        spellcheck={false}
        aria-invalid={Boolean(parseError)}
        disabled={disabled}
        onInput={(event) => {
          const nextText = event.currentTarget.value;
          setText(nextText);
          try {
            const parsed = JSON.parse(nextText);
            parseErrorRef.current = undefined;
            setParseError(undefined);
            lastEmittedValueRef.current = parsed;
            onChange(parsed);
          } catch {
            const errMsg = t("structured.treeJsonInvalid");
            parseErrorRef.current = errMsg;
            setParseError(errMsg);
            onErrorChange?.(errMsg);
          }
        }}
      />
      {parseError && <p class="field-error"><Icon name="warning" size={13}/>{parseError}</p>}
    </div>
  );
}
