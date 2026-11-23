import type { JSX } from "solid-js";
import { Show } from "solid-js";

/**
 * A range button's label. While that range is still being prefetched it shows a
 * small spinning ring and marks itself busy; the ring is decorative and the
 * label text never changes.
 */
export function RangeLabel(props: { label: string; pending: boolean }): JSX.Element {
  return (
    <span class="qg-range__label" aria-busy={props.pending ? "true" : undefined}>
      {props.label}
      <Show when={props.pending}>
        <span class="qg-range__spinner" aria-hidden="true" />
      </Show>
    </span>
  );
}
