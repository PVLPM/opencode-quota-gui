import type { SessionSnapshot } from "../contracts/dashboard";

/**
 * The snapshot one session's individual chart reads: its own steps and node,
 * with no descendants. Totals become that session's own summary, so the
 * cumulative scale and legend never account for children.
 */
export function focusSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const focus = snapshot.nodes.find((node) => node.sessionId === snapshot.focusSessionId);
  return {
    ...snapshot,
    nodes: focus === undefined ? [] : [{ ...focus, childIds: [] }],
    steps: snapshot.steps.filter((step) => step.sessionId === snapshot.focusSessionId),
    treeTotals: snapshot.ownSummary,
  };
}
