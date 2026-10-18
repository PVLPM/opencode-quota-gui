import type { JSX } from "solid-js";
import { createComponent } from "solid-js";
import type { HomeSnapshot } from "../../src/contracts/dashboard";
import type { RangeKey } from "../../src/contracts/ranges";
import { QueryState } from "../../src/ui/components/states";
import type { LoadState } from "../../src/ui/view-model";
import { HomeView } from "../../src/ui/views/home";

/**
 * The Home section exactly as `HomeRoute` wires it, with the query replaced by
 * the caller's state accessor, so a render test can drive real payload changes
 * through the real `QueryState` and the real `HomeView` (design spec §10).
 *
 * Written with `createComponent` rather than JSX so this file needs no compiler
 * support of its own; the components it renders are the shipped ones.
 */
export function LiveHomeSection(props: {
  state: () => LoadState<HomeSnapshot>;
  range: () => RangeKey;
}): JSX.Element {
  return createComponent(QueryState, {
    get state() {
      return props.state();
    },
    label: "Loading quota",
    render: (snapshot: HomeSnapshot, stale: boolean) =>
      createComponent(HomeView, {
        snapshot,
        preferences: { percentMode: "remaining", showRunway: true, detailed: true },
        hiddenCards: [],
        hiddenRows: [],
        stale,
        get range() {
          return props.range();
        },
        onToggleCard: async () => {},
        onToggleRow: async () => {},
      }),
  });
}
