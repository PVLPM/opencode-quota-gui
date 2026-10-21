import type { JSX } from "solid-js";
import { For } from "solid-js";
import { SegmentedControl, SegmentedControlItem } from "../opencode-ui";
import { SORT_MODES, type SortMode } from "../sorting";

/** Compact two-option ordering control; activity is always the default. */
export function SortControl(props: {
  label: string;
  value: SortMode;
  onChange: (mode: SortMode) => void;
}): JSX.Element {
  return (
    <SegmentedControl
      class="qg-sort"
      aria-label={`Sort ${props.label}`}
      value={props.value}
      onChange={(value) => {
        if (value === "activity" || value === "tokens") props.onChange(value);
      }}
    >
      <For each={SORT_MODES}>
        {(mode) => <SegmentedControlItem value={mode.value}>{mode.label}</SegmentedControlItem>}
      </For>
    </SegmentedControl>
  );
}
