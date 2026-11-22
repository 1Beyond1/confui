import { useCallback, useRef, useState } from "preact/hooks";
import type { FieldSpec } from "../../../shared/schema.ts";
import type { EditorValues } from "../editor-state.ts";

export interface EditorSnapshot {
  values: EditorValues;
  customFields: FieldSpec[];
}

const MAX_HISTORY = 100;
const COALESCE_WINDOW_MS = 500;

export function useEditorHistory() {
  const [state, setState] = useState<{
    past: EditorSnapshot[];
    present: EditorSnapshot;
    future: EditorSnapshot[];
  }>({
    past: [],
    present: { values: {}, customFields: [] },
    future: [],
  });

  const lastEditRef = useRef<{ coalesceKey?: string; at: number }>({ at: 0 });

  const reset = useCallback((snapshot: EditorSnapshot) => {
    lastEditRef.current = { at: 0 };
    setState({
      past: [],
      present: snapshot,
      future: [],
    });
  }, []);

  const commit = useCallback(
    (
      updater: (current: EditorSnapshot) => EditorSnapshot,
      options?: { coalesceKey?: string },
    ) => {
      const now = Date.now();
      const coalesceKey = options?.coalesceKey;
      const shouldCoalesce = Boolean(
        coalesceKey
        && lastEditRef.current.coalesceKey === coalesceKey
        && now - lastEditRef.current.at < COALESCE_WINDOW_MS,
      );
      lastEditRef.current = { coalesceKey, at: now };

      setState((prev) => {
        const nextPresent = updater(prev.present);
        if (nextPresent === prev.present) return prev;
        if (shouldCoalesce && prev.past.length > 0) {
          return {
            past: prev.past,
            present: nextPresent,
            future: [],
          };
        }
        const nextPast = [...prev.past, prev.present];
        if (nextPast.length > MAX_HISTORY) nextPast.shift();
        return {
          past: nextPast,
          present: nextPresent,
          future: [],
        };
      });
    },
    [],
  );

  const undo = useCallback(() => {
    lastEditRef.current = { at: 0 };
    setState((prev) => {
      if (!prev.past.length) return prev;
      const previous = prev.past[prev.past.length - 1]!;
      return {
        past: prev.past.slice(0, -1),
        present: previous,
        future: [prev.present, ...prev.future].slice(0, MAX_HISTORY),
      };
    });
  }, []);

  const redo = useCallback(() => {
    lastEditRef.current = { at: 0 };
    setState((prev) => {
      if (!prev.future.length) return prev;
      const next = prev.future[0]!;
      return {
        past: [...prev.past, prev.present].slice(-MAX_HISTORY),
        present: next,
        future: prev.future.slice(1),
      };
    });
  }, []);

  return {
    values: state.present.values,
    customFields: state.present.customFields,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    commit,
    undo,
    redo,
    reset,
  };
}
