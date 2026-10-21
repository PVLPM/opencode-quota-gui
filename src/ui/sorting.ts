import type { ProjectActivityRow, ProjectRootRow, SessionNode } from "../contracts/dashboard";

/**
 * List ordering (Session B): two explicit keys, always descending.
 *
 * Activity is the existing server-computed `latestActivityAtMs` for the
 * current view/range — never a new score. Tokens is the row's displayed token
 * total. A deterministic id tie-break keeps equal keys stable across renders.
 */
export type SortMode = "activity" | "tokens";

export const DEFAULT_SORT_MODE: SortMode = "activity";

export const SORT_MODES: readonly { value: SortMode; label: string }[] = [
  { value: "activity", label: "Activity" },
  { value: "tokens", label: "Tokens" },
];

interface SortableRow {
  latestActivityAtMs: number;
  tokens: number;
  id: string;
}

function compareRows(a: SortableRow, b: SortableRow, mode: SortMode): number {
  const primary =
    mode === "tokens" ? b.tokens - a.tokens : b.latestActivityAtMs - a.latestActivityAtMs;
  if (primary !== 0) return primary;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortProjectRows(rows: ProjectActivityRow[], mode: SortMode): ProjectActivityRow[] {
  return rows
    .map((row) => ({
      row,
      key: {
        latestActivityAtMs: row.latestActivityAtMs,
        tokens: row.tokens.total,
        id: row.projectId,
      },
    }))
    .sort((a, b) => compareRows(a.key, b.key, mode))
    .map((entry) => entry.row);
}

export function sortRootRows(rows: ProjectRootRow[], mode: SortMode): ProjectRootRow[] {
  return rows
    .map((row) => ({
      row,
      key: {
        latestActivityAtMs: row.latestActivityAtMs,
        tokens: row.tokens.total,
        id: row.sessionId,
      },
    }))
    .sort((a, b) => compareRows(a.key, b.key, mode))
    .map((entry) => entry.row);
}

/**
 * Sorts **siblings only** and keeps the canonical tree.
 *
 * `childIds` is the builder's rendered-edge set (cycle back-edges are already
 * removed), so this walks the same tree the page renders rather than raw
 * `parentId`. A defensive visited set makes a malformed or cyclic payload
 * terminate, and any node unreachable from the focus is appended in its
 * original order instead of disappearing.
 */
export function sortSessionTree(nodes: SessionNode[], mode: SortMode): SessionNode[] {
  if (nodes.length <= 1) return nodes;
  const byId = new Map(nodes.map((node) => [node.sessionId, node]));
  const focus = nodes[0];
  if (!focus) return nodes;

  const keyOf = (node: SessionNode): SortableRow => ({
    latestActivityAtMs: node.latestActivityAtMs,
    tokens: node.subtreeTokens.total,
    id: node.sessionId,
  });
  const childrenOf = (node: SessionNode): SessionNode[] => {
    const children: SessionNode[] = [];
    for (const childId of node.childIds) {
      const child = byId.get(childId);
      if (child !== undefined) children.push(child);
    }
    return children.sort((a, b) => compareRows(keyOf(a), keyOf(b), mode));
  };

  const ordered: SessionNode[] = [];
  const visited = new Set<string>();
  const visit = (start: SessionNode): void => {
    const stack: SessionNode[] = [start];
    while (stack.length > 0) {
      const node = stack.pop() as SessionNode;
      if (visited.has(node.sessionId)) continue;
      visited.add(node.sessionId);
      ordered.push(node);
      const children = childrenOf(node);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index] as SessionNode;
        if (!visited.has(child.sessionId)) stack.push(child);
      }
    }
  };
  visit(focus);
  for (const node of nodes) {
    if (!visited.has(node.sessionId)) {
      visited.add(node.sessionId);
      ordered.push(node);
    }
  }
  return ordered;
}
