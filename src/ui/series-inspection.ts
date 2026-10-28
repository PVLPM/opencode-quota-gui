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
 * One same-dimension hidden parent inside the chart-only Other series. The
 * parent key is shared with the breakdown row, so pointer and keyboard focus
 * on that row can single out the exact Other slice while its siblings dim.
 */
export interface SeriesParentSelection {
  seriesKey: string;
  parentKey: string;
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
 *
 * A parent selection is the same-dimension sibling of a child selection: it
 * lives inside Other and clears whenever its series loses pointer/focus.
 */
export interface SeriesInspection {
  active: Accessor<string | undefined>;
  activeChild: Accessor<SeriesChildSelection | undefined>;
  activeParent: Accessor<SeriesParentSelection | undefined>;
  pinned: Accessor<string | undefined>;
  inspectPointer: (key: string | undefined) => void;
  inspectPointerChild: (selection: SeriesChildSelection | undefined) => void;
  inspectPointerParent: (selection: SeriesParentSelection | undefined) => void;
  inspectFocus: (key: string | undefined) => void;
  inspectFocusChild: (selection: SeriesChildSelection | undefined) => void;
  inspectFocusParent: (selection: SeriesParentSelection | undefined) => void;
  clearPointer: () => void;
  clearFocus: () => void;
  /** Click a legend entry: pin it, or unpin it and its transient emphasis. */
  togglePinned: (key: string) => void;
  clearPinned: () => void;
  /**
   * Drop only the pointer/focus/pinned keys that no longer exist. When the
   * caller knows the exact hidden-parent keys, an obsolete parent selection is
   * cleared too instead of leaving every Other row dimmed with no slice marked.
   */
  reconcile: (validKeys: ReadonlySet<string>, validParentKeys?: ReadonlySet<string>) => void;
}

export function createSeriesInspection(): SeriesInspection {
  const [pointerKey, setPointerKey] = createSignal<string | undefined>();
  const [pointerChild, setPointerChild] = createSignal<SeriesChildSelection | undefined>();
  const [pointerParent, setPointerParent] = createSignal<SeriesParentSelection | undefined>();
  const [focusKey, setFocusKey] = createSignal<string | undefined>();
  const [focusChild, setFocusChild] = createSignal<SeriesChildSelection | undefined>();
  const [focusParent, setFocusParent] = createSignal<SeriesParentSelection | undefined>();
  const [pinnedKey, setPinnedKey] = createSignal<string | undefined>();
  return {
    active: () => pointerKey() ?? focusKey() ?? pinnedKey(),
    activeChild: () => {
      if (pointerKey() !== undefined) return pointerChild();
      if (focusKey() !== undefined) return focusChild();
      return undefined;
    },
    activeParent: () => {
      if (pointerKey() !== undefined) return pointerParent();
      if (focusKey() !== undefined) return focusParent();
      return undefined;
    },
    pinned: pinnedKey,
    inspectPointer: (key) => {
      setPointerKey(key);
      setPointerChild(undefined);
      setPointerParent(undefined);
    },
    inspectPointerChild: (selection) => {
      setPointerKey(selection?.seriesKey);
      setPointerChild(selection);
      setPointerParent(undefined);
    },
    inspectPointerParent: (selection) => {
      setPointerKey(selection?.seriesKey);
      setPointerParent(selection);
      setPointerChild(undefined);
    },
    inspectFocus: (key) => {
      setFocusKey(key);
      setFocusChild(undefined);
      setFocusParent(undefined);
    },
    inspectFocusChild: (selection) => {
      setFocusKey(selection?.seriesKey);
      setFocusChild(selection);
      setFocusParent(undefined);
    },
    inspectFocusParent: (selection) => {
      setFocusKey(selection?.seriesKey);
      setFocusParent(selection);
      setFocusChild(undefined);
    },
    clearPointer: () => {
      setPointerKey(undefined);
      setPointerChild(undefined);
      setPointerParent(undefined);
    },
    clearFocus: () => {
      setFocusKey(undefined);
      setFocusChild(undefined);
      setFocusParent(undefined);
    },
    togglePinned: (key) => {
      if (pinnedKey() === key) {
        setPinnedKey(undefined);
        setPointerKey((current) => (current === key ? undefined : current));
        setPointerChild((current) => (current?.seriesKey === key ? undefined : current));
        setPointerParent((current) => (current?.seriesKey === key ? undefined : current));
        setFocusKey((current) => (current === key ? undefined : current));
        setFocusChild((current) => (current?.seriesKey === key ? undefined : current));
        setFocusParent((current) => (current?.seriesKey === key ? undefined : current));
        return;
      }
      setPinnedKey(key);
    },
    clearPinned: () => setPinnedKey(undefined),
    reconcile: (validKeys, validParentKeys) => {
      const parentValid = (current: SeriesParentSelection | undefined): boolean =>
        current !== undefined &&
        validKeys.has(current.seriesKey) &&
        (validParentKeys === undefined || validParentKeys.has(current.parentKey));
      setPointerKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
      setPointerChild((current) =>
        current !== undefined && !validKeys.has(current.seriesKey) ? undefined : current,
      );
      setPointerParent((current) => (parentValid(current) ? current : undefined));
      setFocusKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
      setFocusChild((current) =>
        current !== undefined && !validKeys.has(current.seriesKey) ? undefined : current,
      );
      setFocusParent((current) => (parentValid(current) ? current : undefined));
      setPinnedKey((current) =>
        current !== undefined && !validKeys.has(current) ? undefined : current,
      );
    },
  };
}
