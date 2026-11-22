import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";

/**
 * Foreground loading state (Session B §21).
 *
 * Fast loads must not flash anything, so a foreground wait becomes visible only
 * after a full second. The compact fixed panel is hidden the instant the request
 * settles — success, handled failure, or a supersede that changes what is on
 * screen. It carries no spinner: only the border fades while work continues.
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
  /** Whole seconds since the foreground request started. */
  elapsedSeconds: () => number;
  update: (state: BusyState) => void;
  dispose: () => void;
}

export const BUSY_DELAY_MS = 1000;

export function createBusyIndicator(delayMs: number = BUSY_DELAY_MS): BusyIndicator {
  const [visible, setVisible] = createSignal(false);
  const [hasData, setHasData] = createSignal(false);
  const [elapsedSeconds, setElapsedSeconds] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  return {
    visible,
    hasData,
    elapsedSeconds,
    update(state) {
      setHasData(state.hasData);
      if (!state.active) {
        clear();
        setVisible(false);
        return;
      }
      if (visible() || timer !== undefined) return;
      // Real wall-clock time since the request started; nothing is estimated.
      const startedAt = Date.now();
      setElapsedSeconds(0);
      ticker = setInterval(
        () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
        1000,
      );
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
    `${props.indicator.hasData() ? "Updating" : "Loading"} ${props.label}… ${props.indicator.elapsedSeconds()} s`;
  return (
    <Show when={props.indicator.visible()}>
      <output class="qg-busy" aria-live="polite">
        {copy()}
      </output>
    </Show>
  );
}
