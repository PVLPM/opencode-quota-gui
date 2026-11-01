import type { PanelState, SessionRef } from "@opencode/plugin/gui";

/**
 * Click behaviour for the `session.header` Slot (Stage 6).
 *
 * Clicking a quota token reveals the dashboard tab without resetting the
 * Panel's internal route. `Layout.state` distinguishes a closed tab from one
 * that is in the strip but hidden or already visible:
 *
 * - closed → open; the Panel mounts at its default Quota route because no
 *   previous internal state exists;
 * - open/active → open selects the stored tab or shows its hidden pane, while
 *   the still-mounted Panel keeps its last view;
 * - visible → no write at all, so its route is never reset.
 */
export interface DashboardPanelLayout {
  state(key: string, session: SessionRef): PanelState;
  open(key: string, session: SessionRef): void;
}

export type RevealPanelOutcome = "opened" | "already-visible";

export function revealDashboardPanel(
  layout: DashboardPanelLayout,
  key: string,
  session: SessionRef,
): RevealPanelOutcome {
  if (layout.state(key, session) === "visible") return "already-visible";
  layout.open(key, session);
  return "opened";
}
