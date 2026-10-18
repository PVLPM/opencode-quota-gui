import { describe, expect, it } from "vitest";

/**
 * P3 analytics lane — session detail (spec §6, R25–R27).
 *
 * Session detail is intentionally independent of the global range and counts
 * every physical completed row of the selected tree (no fork dedup).
 */
import {
  AnalyticsNotFoundError,
  createUsageAnalytics,
  UNTITLED_SESSION_TITLE,
  type UsageAnalyticsDataset,
} from "../src/gui/aggregation.js";
import type {
  OpenCodeCompactionMarker,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

type RawTokenCounts = OpenCodeRawAssistantRow["tokens"];

function assistantRow(
  sessionID: string,
  messageID: string,
  createdAtMs: number,
  tokens: Partial<RawTokenCounts> = {},
): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs,
    completedAtMs: createdAtMs + 1_000,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
  };
}

function sessionInfo(opts: {
  id: string;
  title?: string;
  parentID?: string;
  projectID?: string;
  directory?: string;
  createdMs?: number;
  updatedMs?: number;
}): OpenCodeSessionInfo {
  return {
    id: opts.id,
    title: opts.title,
    parentID: opts.parentID,
    projectID: opts.projectID,
    directory: opts.directory,
    time: { created: opts.createdMs, updated: opts.updatedMs ?? opts.createdMs },
  };
}

function projectInfo(id: string, name?: string): OpenCodeProjectInfo {
  return { id, name, directories: [], worktrees: [] };
}

function makeDataset(parts: {
  sessions?: OpenCodeSessionInfo[];
  projects?: OpenCodeProjectInfo[];
  messages?: OpenCodeRawAssistantRow[];
  compactions?: OpenCodeCompactionMarker[];
}): UsageAnalyticsDataset {
  const sessions: Record<string, OpenCodeSessionInfo> = {};
  for (const session of parts.sessions ?? []) sessions[session.id] = session;
  const projects: Record<string, OpenCodeProjectInfo> = {};
  for (const project of parts.projects ?? []) projects[project.id] = project;
  return {
    sessions,
    projects,
    messages: parts.messages ?? [],
    compactions: parts.compactions ?? [],
  };
}

describe("session tree scope", () => {
  it("returns the opened session plus all descendants only — never ancestors or siblings", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_g", title: "G", createdMs: NOW - 20 * HOUR_MS }),
        sessionInfo({ id: "ses_f", title: "F", parentID: "ses_g", createdMs: NOW - 10 * HOUR_MS }),
        sessionInfo({ id: "ses_s", title: "S", parentID: "ses_g", createdMs: NOW - 9 * HOUR_MS }),
        sessionInfo({ id: "ses_c1", title: "C1", parentID: "ses_f", createdMs: NOW - 8 * HOUR_MS }),
        sessionInfo({
          id: "ses_gc",
          title: "GC",
          parentID: "ses_c1",
          createdMs: NOW - 7 * HOUR_MS,
        }),
        sessionInfo({ id: "ses_c2", title: "C2", parentID: "ses_f", createdMs: NOW - 6 * HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_s", "msg_s", NOW - 5 * HOUR_MS, { input: 100 }),
        assistantRow("ses_gc", "msg_gc", NOW - 4 * HOUR_MS, { input: 2 }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");

    expect(snapshot.focusSessionId).toBe("ses_f");
    expect(snapshot.nodes.map((node) => node.sessionId)).toEqual([
      "ses_f",
      "ses_c1",
      "ses_gc",
      "ses_c2",
    ]);
    expect(snapshot.nodes.map((node) => node.depth)).toEqual([0, 1, 2, 1]);
    const byId = new Map(snapshot.nodes.map((node) => [node.sessionId, node]));
    expect(byId.get("ses_f")?.childIds).toEqual(["ses_c1", "ses_c2"]);
    expect(byId.get("ses_c1")?.childIds).toEqual(["ses_gc"]);
    expect(byId.get("ses_gc")?.childIds).toEqual([]);
    expect(byId.get("ses_c2")?.childIds).toEqual([]);
    expect(byId.get("ses_f")?.subtreeNodeCount).toBe(4);
    expect(byId.get("ses_c1")?.subtreeNodeCount).toBe(2);
    expect(byId.get("ses_gc")?.subtreeNodeCount).toBe(1);
    expect(snapshot.breadcrumbs).toEqual([
      { sessionId: "ses_g", title: "G", isFocus: false },
      { sessionId: "ses_f", title: "F", isFocus: true },
    ]);
    // Only the tree's physical rows are steps.
    expect(snapshot.steps.map((step) => step.sessionId)).toEqual(["ses_gc"]);
    expect(snapshot.steps.map((step) => step.messageId)).toEqual(["msg_gc"]);
  });

  it("handles arbitrary depth iteratively with no node cap", () => {
    const count = 12_000;
    const sessions: OpenCodeSessionInfo[] = [];
    for (let index = 0; index < count; index += 1) {
      sessions.push(
        sessionInfo({
          id: `ses_chain_${String(index).padStart(5, "0")}`,
          title: `Node ${index}`,
          parentID: index === 0 ? undefined : `ses_chain_${String(index - 1).padStart(5, "0")}`,
          createdMs: NOW - count - index,
        }),
      );
    }
    const dataset = makeDataset({
      sessions,
      messages: [
        assistantRow("ses_chain_00000", "msg_first", NOW - 5_000, { input: 1 }),
        assistantRow(`ses_chain_${String(count - 1).padStart(5, "0")}`, "msg_last", NOW - 4_000, {
          input: 2,
        }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_chain_00000");

    expect(snapshot.nodes).toHaveLength(count);
    expect(snapshot.nodes[count - 1]?.depth).toBe(count - 1);
    expect(snapshot.nodes[0]?.subtreeNodeCount).toBe(count);
    expect(snapshot.treeTotals.input).toBe(3);
    expect(snapshot.steps).toHaveLength(2);
  });

  it("uses all physical rows of the tree with no dedup, diverging from the global owned set", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_p",
          title: "P",
          projectID: "proj_p",
          createdMs: NOW - 10 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_c",
          title: "C",
          parentID: "ses_p",
          projectID: "proj_p",
          createdMs: NOW - 9 * HOUR_MS,
        }),
      ],
      projects: [projectInfo("proj_p", "P")],
      messages: [
        assistantRow("ses_p", "msg_p", NOW - 5 * HOUR_MS, { input: 10 }),
        // Fork copy: identical fingerprint, physically stored in the child session.
        assistantRow("ses_c", "msg_f", NOW - 5 * HOUR_MS, { input: 10 }),
      ],
    });
    const analytics = createUsageAnalytics(dataset);

    const snapshot = analytics.session("ses_p");
    // Same start time; ordered by message id (msg_f < msg_p).
    expect(snapshot.steps.map((step) => step.messageId)).toEqual(["msg_f", "msg_p"]);
    expect(snapshot.treeTotals.input).toBe(20);
    expect(snapshot.ownSummary.input).toBe(10);
    expect(snapshot.ownSummary.stepCount).toBe(1);

    const byId = new Map(snapshot.nodes.map((node) => [node.sessionId, node]));
    expect(byId.get("ses_c")?.ownTokens.input).toBe(10);
    expect(byId.get("ses_p")?.subtreeTokens.input).toBe(20);
    expect(snapshot.nodes[0]?.subtreeTokens).toEqual(snapshot.treeTotals);

    // The global path dedupes the fork copy to a single owned row.
    const home = analytics.home("24h", NOW);
    expect(home.usage.stepCount).toBe(1);
    expect(home.usage.totals.input).toBe(10);
    const project = analytics.project("proj_p", "24h", NOW);
    expect(project.totals.input).toBe(10);
  });

  it("reports own and subtree figures with recursive latest activity", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_f",
          title: "F",
          createdMs: NOW - 10 * HOUR_MS,
          updatedMs: NOW - 9 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_c",
          title: "C",
          parentID: "ses_f",
          createdMs: NOW - 8 * HOUR_MS,
          updatedMs: NOW - HOUR_MS,
        }),
      ],
      messages: [
        assistantRow("ses_f", "msg_f1", NOW - 7 * HOUR_MS, { input: 1 }),
        assistantRow("ses_f", "msg_f2", NOW - 6 * HOUR_MS, { input: 2 }),
        assistantRow("ses_c", "msg_c1", NOW - 5 * HOUR_MS, { input: 4 }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    const byId = new Map(snapshot.nodes.map((node) => [node.sessionId, node]));
    expect(byId.get("ses_f")?.ownTokens.input).toBe(3);
    expect(byId.get("ses_f")?.stepCount).toBe(2);
    expect(byId.get("ses_f")?.subtreeTokens.input).toBe(7);
    expect(byId.get("ses_c")?.ownTokens.input).toBe(4);
    expect(byId.get("ses_c")?.subtreeTokens.input).toBe(4);
    expect(byId.get("ses_f")?.latestActivityAtMs).toBe(NOW - HOUR_MS);
    expect(snapshot.ownSummary).toMatchObject({ input: 3, stepCount: 2 });
  });

  it("guards cycles deterministically and terminates", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_a", title: "A", parentID: "ses_b", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_b", title: "B", parentID: "ses_a", createdMs: NOW - 2 * HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_a", "msg_a", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_b", "msg_b", NOW - 30 * 60_000, { input: 2 }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_a");
    expect(snapshot.nodes.map((node) => node.sessionId)).toEqual(["ses_a", "ses_b"]);
    const byId = new Map(snapshot.nodes.map((node) => [node.sessionId, node]));
    expect(byId.get("ses_a")?.childIds).toEqual(["ses_b"]);
    // The back edge to the already-visited focus is not a rendered child link.
    expect(byId.get("ses_b")?.childIds).toEqual([]);
    expect(snapshot.treeTotals.input).toBe(3);

    const selfParent = makeDataset({
      sessions: [sessionInfo({ id: "ses_self", title: "Self", parentID: "ses_self" })],
      messages: [assistantRow("ses_self", "msg_self", NOW - HOUR_MS, { input: 8 })],
    });
    const selfSnapshot = createUsageAnalytics(selfParent).session("ses_self");
    expect(selfSnapshot.nodes.map((node) => node.sessionId)).toEqual(["ses_self"]);
    expect(selfSnapshot.nodes[0]?.childIds).toEqual([]);
    expect(selfSnapshot.treeTotals.input).toBe(8);
  });

  it("labels nodes with worktree basenames only", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_f",
          title: "F",
          directory: "C:\\work\\alpha\\wt-one",
          createdMs: NOW - 2 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_c",
          title: "C",
          parentID: "ses_f",
          directory: "/srv/repos/wt-two/",
          createdMs: NOW - HOUR_MS,
        }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    expect(snapshot.nodes.map((node) => node.worktreeLabel)).toEqual(["wt-one", "wt-two"]);
    for (const node of snapshot.nodes) {
      expect(node.worktreeLabel).not.toContain("/");
      expect(node.worktreeLabel).not.toContain("\\");
    }
  });

  it("uses breadcrumbs for ancestors and stops at missing links", () => {
    const withMissing = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_f", title: "F", parentID: "ses_gone", createdMs: NOW - HOUR_MS }),
      ],
    });
    const missing = createUsageAnalytics(withMissing).session("ses_f");
    expect(missing.breadcrumbs).toEqual([{ sessionId: "ses_f", title: "F", isFocus: true }]);

    const withAncestor = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_g", title: "G", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_f", title: "F", parentID: "ses_g", createdMs: NOW - HOUR_MS }),
      ],
    });
    const full = createUsageAnalytics(withAncestor).session("ses_f");
    expect(full.breadcrumbs).toEqual([
      { sessionId: "ses_g", title: "G", isFocus: false },
      { sessionId: "ses_f", title: "F", isFocus: true },
    ]);
  });

  it("falls back to the untitled title for sessions without one", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_f", createdMs: NOW - HOUR_MS })],
    });
    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    expect(snapshot.nodes[0]?.title).toBe(UNTITLED_SESSION_TITLE);
    expect(snapshot.breadcrumbs[0]?.title).toBe(UNTITLED_SESSION_TITLE);
  });

  it("rejects unknown sessions with a controlled generic error", () => {
    const analytics = createUsageAnalytics({
      sessions: {},
      projects: {},
      messages: [],
      compactions: [],
    });

    try {
      analytics.session("ses_missing");
      throw new Error("expected AnalyticsNotFoundError");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsNotFoundError);
      if (!(error instanceof AnalyticsNotFoundError)) {
        throw new Error("expected AnalyticsNotFoundError");
      }
      expect(error.resource).toBe("session");
      expect(error.resourceId).toBe("ses_missing");
      expect(error.message).toBe("Session not found");
      expect(error.message).not.toContain("/");
      expect(error.message).not.toContain("\\");
    }
  });
});
