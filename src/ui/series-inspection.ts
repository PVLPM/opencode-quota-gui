import { type Accessor, createSignal } from "solid-js";

/**
 * Cross-highlight state for a chart legend and its rows.
 *
 * Pointer inspection wins while the pointer is over an interactive element;
 * keyboard focus survives pointer exit until that element really blurs, the
 * same precedence the chart bucket inspector uses.
 */
export interface SeriesInspection {
  active: Accessor<string | undefined>;
  inspectPointer: (key: string | undefined) => void;
  inspectFocus: (key: string | undefined) => void;
  clearPointer: () => void;
  clearFocus: () => void;
  /** Drop only the pointer/focus keys that no longer exist in the current series. */
  reconcile: (validKeys: ReadonlySet<string>) => void;
}

export function createSeriesInspection(): SeriesInspection {
  const [pointerKey, setPointerKey] = createSignal<string | undefined>();
  const [focusKey, setFocusKey] = createSignal<string | undefined>();
  return {
    active: () => pointerKey() ?? focusKey(),
    inspectPointer: setPointerKey,
    inspectFocus: setFocusKey,
    clearPointer: () => setPointerKey(undefined),
    clearFocus: () => setFocusKey(undefined),
    reconcile: (validKeys) => {
      setPointerKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
      setFocusKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
    },
  };
}
