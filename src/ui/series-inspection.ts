import { type Accessor, createSignal } from "solid-js";

/**
 * One opposite-dimension child inside an active chart series. The series key
 * keeps children from different parents apart, because the same raw identity
 * can appear under several parents.
 */
export interface SeriesChildSelection {
  seriesKey: string;
  childKey: string;
}

/**
 * Cross-highlight state for a chart legend and its rows.
 *
 * Pointer inspection wins while the pointer is over an interactive element;
 * keyboard focus survives pointer exit until that element really blurs; an
 * explicit click can pin one key as the fallback emphasis. The same precedence
 * the chart bucket inspector uses. Toggling the pinned key off also clears
 * that key's transient pointer/focus state so the reset is immediately visible.
 *
 * A child selection is transient only: it always travels with its parent
 * series, so moving to a parent row or another series clears it. Keyboard focus
 * keeps it alive exactly like its parent until the child row blurs.
 */
export interface SeriesInspection {
  active: Accessor<string | undefined>;
  activeChild: Accessor<SeriesChildSelection | undefined>;
  pinned: Accessor<string | undefined>;
  inspectPointer: (key: string | undefined) => void;
  inspectPointerChild: (selection: SeriesChildSelection | undefined) => void;
  inspectFocus: (key: string | undefined) => void;
  inspectFocusChild: (selection: SeriesChildSelection | undefined) => void;
  clearPointer: () => void;
  clearFocus: () => void;
  /** Click a legend entry: pin it, or unpin it and its transient emphasis. */
  togglePinned: (key: string) => void;
  clearPinned: () => void;
  /** Drop only the pointer/focus/pinned keys that no longer exist. */
  reconcile: (validKeys: ReadonlySet<string>) => void;
}

export function createSeriesInspection(): SeriesInspection {
  const [pointerKey, setPointerKey] = createSignal<string | undefined>();
  const [pointerChild, setPointerChild] = createSignal<SeriesChildSelection | undefined>();
  const [focusKey, setFocusKey] = createSignal<string | undefined>();
  const [focusChild, setFocusChild] = createSignal<SeriesChildSelection | undefined>();
  const [pinnedKey, setPinnedKey] = createSignal<string | undefined>();
  return {
    active: () => pointerKey() ?? focusKey() ?? pinnedKey(),
    activeChild: () => {
      if (pointerKey() !== undefined) return pointerChild();
      if (focusKey() !== undefined) return focusChild();
      return undefined;
    },
    pinned: pinnedKey,
    inspectPointer: (key) => {
      setPointerKey(key);
      setPointerChild(undefined);
    },
    inspectPointerChild: (selection) => {
      setPointerKey(selection?.seriesKey);
      setPointerChild(selection);
    },
    inspectFocus: (key) => {
      setFocusKey(key);
      setFocusChild(undefined);
    },
    inspectFocusChild: (selection) => {
      setFocusKey(selection?.seriesKey);
      setFocusChild(selection);
    },
    clearPointer: () => {
      setPointerKey(undefined);
      setPointerChild(undefined);
    },
    clearFocus: () => {
      setFocusKey(undefined);
      setFocusChild(undefined);
    },
    togglePinned: (key) => {
      if (pinnedKey() === key) {
        setPinnedKey(undefined);
        setPointerKey((current) => (current === key ? undefined : current));
        setPointerChild((current) => (current?.seriesKey === key ? undefined : current));
        setFocusKey((current) => (current === key ? undefined : current));
        setFocusChild((current) => (current?.seriesKey === key ? undefined : current));
        return;
      }
      setPinnedKey(key);
    },
    clearPinned: () => setPinnedKey(undefined),
    reconcile: (validKeys) => {
      setPointerKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
      setPointerChild((current) =>
        current !== undefined && !validKeys.has(current.seriesKey) ? undefined : current,
      );
      setFocusKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
      setFocusChild((current) =>
        current !== undefined && !validKeys.has(current.seriesKey) ? undefined : current,
      );
      setPinnedKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
    },
  };
}
