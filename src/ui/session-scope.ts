import type { SessionSnapshot } from "../contracts/dashboard";

/** Which steps the Session chart covers: the focused session alone, or it plus every descendant. */
export type SessionScope = "main" | "tree";

export const SESSION_SCOPES: readonly { value: SessionScope; label: string }[] = [
  { value: "main", label: "Main session" },
  { value: "tree", label: "Session tree" },
];

/** A root opens on the whole tree; any other session opens on its own steps only. */
export function defaultSessionScope(snapshot: SessionSnapshot): SessionScope {
  const focus = snapshot.nodes.find((node) => node.sessionId === snapshot.focusSessionId);
  return focus?.parentId === undefined ? "tree" : "main";
}

/**
 * The snapshot the chart reads for a scope. Main session narrows the one
 * observed step list to the focused session, so both scopes share the same
 * deduplicated observations and token accounting; nothing is recomputed.
 */
export function scopeSessionSnapshot(
  snapshot: SessionSnapshot,
  scope: SessionScope,
): SessionSnapshot {
  if (scope === "tree") return snapshot;
  const focus = snapshot.nodes.find((node) => node.sessionId === snapshot.focusSessionId);
  return {
    ...snapshot,
    nodes: focus === undefined ? [] : [{ ...focus, childIds: [] }],
    steps: snapshot.steps.filter((step) => step.sessionId === snapshot.focusSessionId),
    treeTotals: snapshot.ownSummary,
  };
}
