import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";

/**
 * Foreground loading state (Session B §21).
 *
 * Fast loads must not flash anything, so a foreground wait becomes visible only
 * after a full second. The indicator is rendered as a fixed overlay, never as a
 * row in the document flow, and it is hidden the instant the request settles —
 * success, handled failure, or a supersede that changes what is on screen.
 */
export interface BusyState {
  /** A foreground request whose requested scope is not on screen yet. */
  active: boolean;
  /** Usable content is already visible (copy becomes "Updating …"). */
  hasData: boolean;
}

export interface BusyIndicator {
  visible: () => boolean;
  hasData: () => boolean;
  update: (state: BusyState) => void;
  dispose: () => void;
}

export const BUSY_DELAY_MS = 1000;

export function createBusyIndicator(delayMs: number = BUSY_DELAY_MS): BusyIndicator {
  const [visible, setVisible] = createSignal(false);
  const [hasData, setHasData] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    visible,
    hasData,
    update(state) {
      setHasData(state.hasData);
      if (!state.active) {
        clear();
        setVisible(false);
        return;
      }
      if (visible() || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        setVisible(true);
      }, delayMs);
    },
    dispose() {
      clear();
      setVisible(false);
    },
  };
}

export function BusyOverlay(props: { indicator: BusyIndicator; label: string }): JSX.Element {
  const copy = (): string =>
    props.indicator.hasData() ? `Updating ${props.label}…` : `Loading ${props.label}…`;
  return (
    <Show when={props.indicator.visible()}>
      <output class="qg-busy" aria-live="polite">
        <span class="qg-busy__dot" aria-hidden="true" />
        <span>{copy()}</span>
      </output>
    </Show>
  );
}
