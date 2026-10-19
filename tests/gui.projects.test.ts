import { describe, expect, it } from "vitest";

/**
 * P3 analytics lane — project snapshots (spec §6, R22–R24, R50).
 *
 * All fixtures are synthetic; token values and ids are invented in this file.
 */
import type { CostedTokens, TokenStack } from "../src/contracts/dashboard.js";
import {
  AnalyticsNotFoundError,
  createUsageAnalytics,
  UNKNOWN_PROJECT_ID,
  type UsageAnalyticsDataset,
} from "../src/gui/aggregation.js";
import type {
  OpenCodeCompactionMarker,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

type RawTokenCounts = OpenCodeRawAssistantRow["tokens"];

function assistantRow(
  sessionID: string,
  messageID: string,
  createdAtMs: number,
  tokens: Partial<RawTokenCounts> = {},
  opts: { providerID?: string; modelID?: string; cost?: number } = {},
): OpenCodeRawAssistantRow {
  const row: OpenCodeRawAssistantRow = {
    sessionID,
    messageID,
    createdAtMs,
    completedAtMs: createdAtMs + 1_000,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
  };
  if (opts.providerID !== undefined) row.providerID = opts.providerID;
  if (opts.modelID !== undefined) row.modelID = opts.modelID;
  if (opts.cost !== undefined) row.cost = opts.cost;
  return row;
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

function projectInfo(
  id: string,
  opts: { name?: string; directories?: string[]; worktrees?: string[] } = {},
): OpenCodeProjectInfo {
  return {
    id,
    name: opts.name,
    directories: opts.directories ?? [],
    worktrees: opts.worktrees ?? [],
  };
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

function zeroCosted(): CostedTokens {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function costed(
  stack: Partial<TokenStack>,
  extras: Partial<
    Pick<CostedTokens, "apiEquivalentCostUsd" | "unpricedTokens" | "unknownTokens">
  > = {},
): CostedTokens {
  const base = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, ...stack };
  return {
    ...base,
    total: base.input + base.cacheRead + base.cacheWrite + base.output + base.reasoning,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
    ...extras,
  };
}

describe("project roots and recursive totals", () => {
  it("sums a root's own and descendant steps exactly once and never double counts", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_r",
          title: "Root R",
          projectID: "proj_p",
          createdMs: NOW - 10 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_c",
          title: "Child C",
          parentID: "ses_r",
          projectID: "proj_p",
          createdMs: NOW - 9 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_d",
          title: "Root D",
          projectID: "proj_p",
          createdMs: NOW - 8 * HOUR_MS,
        }),
      ],
      projects: [projectInfo("proj_p", { name: "P" })],
      messages: [
        assistantRow("ses_r", "msg_r", NOW - 9 * HOUR_MS, { input: 1 }),
        assistantRow("ses_c", "msg_c", NOW - 8 * HOUR_MS, { input: 2 }),
        assistantRow("ses_d", "msg_d", NOW - 7 * HOUR_MS, { input: 4 }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).project("proj_p", "24h", NOW);

    expect(snapshot.projectId).toBe("proj_p");
    expect(snapshot.name).toBe("P");
    expect(snapshot.range).toBe("24h");
    expect(snapshot.roots).toEqual([
      {
        sessionId: "ses_d",
        title: "Root D",
        tokens: costed({ input: 4 }, { unknownTokens: 4 }),
        latestActivityAtMs: NOW - 7 * HOUR_MS + 1_000,
      },
      {
        sessionId: "ses_r",
        title: "Root R",
        tokens: costed({ input: 3 }, { unknownTokens: 3 }),
        latestActivityAtMs: NOW - 8 * HOUR_MS + 1_000,
      },
    ]);
    expect(snapshot.totals).toEqual({
      ...costed({ input: 7 }, { unknownTokens: 7 }),
      sessionCount: 3,
    });
    const rootSum = snapshot.roots.reduce((sum, root) => sum + root.tokens.input, 0);
    expect(rootSum).toBe(snapshot.totals.input);

    const home = createUsageAnalytics(dataset).home("24h", NOW);
    expect(home.projects).toHaveLength(1);
    expect(home.projects[0]?.tokens.input).toBe(7);
    expect(home.projects[0]?.rootSessionCount).toBe(2);
  });

  it("aggregates every worktree under one project id and labels roots with basenames only", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_r1",
          title: "One",
          projectID: "proj_p",
          directory: "/work/alpha/wt-one",
          createdMs: NOW - 2 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_r2",
          title: "Two",
          projectID: "proj_p",
          directory: "/work/alpha/wt-two",
          createdMs: NOW - 2 * HOUR_MS,
        }),
      ],
      projects: [
        projectInfo("proj_p", {
          name: "Alpha",
          directories: ["/work/alpha"],
          worktrees: ["/work/alpha/wt-one", "/work/alpha/wt-two"],
        }),
      ],
      messages: [
        assistantRow("ses_r1", "msg_1", NOW - HOUR_MS, { input: 10 }),
        assistantRow("ses_r2", "msg_2", NOW - HOUR_MS, { input: 20 }),
      ],
    });

    const analytics = createUsageAnalytics(dataset);
    const home = analytics.home("24h", NOW);
    expect(home.projects).toHaveLength(1);
    expect(home.projects[0]).toMatchObject({
      projectId: "proj_p",
      name: "Alpha",
      rootSessionCount: 2,
    });
    expect(home.projects[0]?.tokens.input).toBe(30);

    const snapshot = analytics.project("proj_p", "24h", NOW);
    expect(snapshot.name).toBe("Alpha");
    expect(snapshot.roots.map((root) => root.worktreeLabel)).toEqual(["wt-one", "wt-two"]);
    for (const root of snapshot.roots) {
      expect(root.worktreeLabel).not.toContain("/");
      expect(root.worktreeLabel).not.toContain("\\");
    }
  });

  it("attributes orphans and cycles to stable roots and counts each physical session once", () => {
    const build = (sessions: OpenCodeSessionInfo[], messages: OpenCodeRawAssistantRow[]) =>
      makeDataset({ sessions, projects: [projectInfo("proj_p", { name: "P" })], messages });

    const sessions = [
      sessionInfo({
        id: "ses_b",
        title: "B",
        parentID: "ses_a",
        projectID: "proj_p",
        createdMs: NOW - 10 * HOUR_MS,
      }),
      sessionInfo({
        id: "ses_a",
        title: "A",
        parentID: "ses_b",
        projectID: "proj_p",
        createdMs: NOW - 10 * HOUR_MS,
      }),
      sessionInfo({
        id: "ses_o",
        title: "Orphan",
        parentID: "ses_outside",
        projectID: "proj_p",
        createdMs: NOW - 10 * HOUR_MS,
      }),
      sessionInfo({
        id: "ses_u",
        title: "Loner",
        projectID: "proj_p",
        createdMs: NOW - 10 * HOUR_MS,
      }),
    ];
    const messages = [
      assistantRow("ses_b", "msg_b", NOW - 5 * HOUR_MS, { input: 5 }),
      assistantRow("ses_o", "msg_o", NOW - 4 * HOUR_MS, { input: 7 }),
      assistantRow("ses_u", "msg_u", NOW - 3 * HOUR_MS, { input: 1 }),
    ];

    const analytics = createUsageAnalytics(build(sessions, messages));
    const snapshot = analytics.project("proj_p", "24h", NOW);

    // The two-cycle collapses to its smallest stable id; the orphan and the parentless session are roots.
    expect(snapshot.roots.map((root) => root.sessionId)).toEqual(["ses_u", "ses_o", "ses_a"]);
    expect(snapshot.roots.map((root) => root.tokens.input)).toEqual([1, 7, 5]);
    expect(snapshot.totals.input).toBe(13);
    expect(snapshot.totals.sessionCount).toBe(3);
    expect(snapshot.roots.reduce((sum, root) => sum + root.tokens.input, 0)).toBe(13);

    // Reordered reads produce byte-identical snapshots.
    const reversed = createUsageAnalytics(
      build([...sessions].reverse(), [...messages].reverse()),
    ).project("proj_p", "24h", NOW);
    expect(reversed).toEqual(snapshot);
  });

  it("takes the latest activity recursively from session created/updated and step times", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_r",
          title: "R",
          projectID: "proj_p",
          createdMs: NOW - 10 * HOUR_MS,
          updatedMs: NOW - 10 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_c",
          title: "C",
          parentID: "ses_r",
          projectID: "proj_p",
          createdMs: NOW - 9 * HOUR_MS,
          updatedMs: NOW - HOUR_MS,
        }),
        sessionInfo({
          id: "ses_z",
          title: "Z",
          parentID: "ses_r",
          projectID: "proj_p",
          createdMs: NOW - 30 * 60_000,
          updatedMs: NOW - 30 * 60_000,
        }),
      ],
      projects: [projectInfo("proj_p", { name: "P" })],
      messages: [assistantRow("ses_r", "msg_r", NOW - 5 * HOUR_MS, { input: 2 })],
    });

    const snapshot = createUsageAnalytics(dataset).project("proj_p", "24h", NOW);
    expect(snapshot.roots).toHaveLength(1);
    // A zero-token descendant updated 30 minutes ago is still activity for the root.
    expect(snapshot.roots[0]?.latestActivityAtMs).toBe(NOW - 30 * 60_000);
    expect(snapshot.roots[0]?.tokens.input).toBe(2);
  });

  it("hides roots without in-range activity in finite ranges and keeps every root in lifetime", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_active",
          title: "Active",
          projectID: "proj_p",
          createdMs: NOW - HOUR_MS,
        }),
        sessionInfo({
          id: "ses_stale",
          title: "Stale",
          projectID: "proj_p",
          createdMs: NOW - 40 * DAY_MS,
        }),
        sessionInfo({ id: "ses_never", title: "Never", projectID: "proj_p" }),
      ],
      projects: [projectInfo("proj_p", { name: "P" })],
      messages: [
        assistantRow("ses_active", "msg_a", NOW - 30 * 60_000, { input: 3 }),
        assistantRow("ses_stale", "msg_s", NOW - 40 * DAY_MS, { input: 5 }),
      ],
    });

    const finite = createUsageAnalytics(dataset).project("proj_p", "24h", NOW);
    expect(finite.roots.map((root) => root.sessionId)).toEqual(["ses_active"]);
    expect(finite.totals.input).toBe(3);
    expect(finite.totals.sessionCount).toBe(1);

    const lifetime = createUsageAnalytics(dataset).project("proj_p", "lifetime", NOW);
    expect(lifetime.roots.map((root) => root.sessionId)).toEqual([
      "ses_active",
      "ses_stale",
      "ses_never",
    ]);
    expect(lifetime.roots.map((root) => root.tokens.input)).toEqual([3, 5, 0]);
    expect(lifetime.roots[2]?.latestActivityAtMs).toBe(0);
    expect(lifetime.totals.input).toBe(8);
    expect(lifetime.totals.sessionCount).toBe(2);
    expect(lifetime.roots.reduce((sum, root) => sum + root.tokens.input, 0)).toBe(8);
  });

  it("orders roots and project rows by latest activity desc with stable id ties, never by tokens", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_alpha",
          title: "Alpha",
          projectID: "proj_p",
          createdMs: NOW - HOUR_MS,
        }),
        sessionInfo({
          id: "ses_beta",
          title: "Beta",
          projectID: "proj_p",
          createdMs: NOW - HOUR_MS,
        }),
        sessionInfo({
          id: "ses_sa",
          title: "SA",
          projectID: "proj_a",
          createdMs: NOW - 5 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_sb",
          title: "SB",
          projectID: "proj_b",
          createdMs: NOW - 5 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_sz",
          title: "SZ",
          projectID: "proj_z",
          createdMs: NOW - 5 * HOUR_MS,
        }),
      ],
      projects: [
        projectInfo("proj_z", { name: "Z" }),
        projectInfo("proj_b", { name: "B" }),
        projectInfo("proj_a", { name: "A" }),
      ],
      messages: [
        assistantRow("ses_sa", "msg_a", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_sb", "msg_b", NOW - 2 * HOUR_MS, { input: 5_000 }),
        assistantRow("ses_sz", "msg_z", NOW - 2 * HOUR_MS, { input: 1 }),
      ],
    });
    const analytics = createUsageAnalytics(dataset);

    const project = analytics.project("proj_p", "24h", NOW);
    expect(project.roots.map((root) => root.sessionId)).toEqual(["ses_alpha", "ses_beta"]);

    const home = analytics.home("24h", NOW);
    // proj_a and proj_p tie on latest (both NOW-1h) and sort by id; proj_b and
    // proj_z tie at NOW-2h and sort by id, despite proj_b's huge tokens.
    expect(home.projects.map((row) => row.projectId)).toEqual([
      "proj_a",
      "proj_p",
      "proj_b",
      "proj_z",
    ]);
  });

  it("counts distinct contributing sessions once for repeated fingerprints and fork copies", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_r1",
          title: "R1",
          projectID: "proj_p",
          createdMs: NOW - 2 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_r2",
          title: "R2",
          projectID: "proj_p",
          createdMs: NOW - 2 * HOUR_MS,
        }),
      ],
      projects: [projectInfo("proj_p", { name: "P" })],
      messages: [
        // One fingerprint, two occurrences in ses_r1 and a fork copy in ses_r2.
        assistantRow("ses_r1", "msg_f1", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_r1", "msg_f2", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_r2", "msg_f3", NOW - HOUR_MS, { input: 1 }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).project("proj_p", "24h", NOW);
    expect(snapshot.roots.map((root) => root.sessionId)).toEqual(["ses_r1", "ses_r2"]);
    expect(snapshot.roots.map((root) => root.tokens.input)).toEqual([2, 0]);
    expect(snapshot.totals.input).toBe(2);
    expect(snapshot.totals.sessionCount).toBe(1);
  });
});

describe("project lookup and naming", () => {
  it("rejects unknown project ids with a controlled generic error", () => {
    const analytics = createUsageAnalytics({
      sessions: {},
      projects: {},
      messages: [],
      compactions: [],
    });

    try {
      analytics.project("proj_missing", "24h", NOW);
      throw new Error("expected AnalyticsNotFoundError");
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsNotFoundError);
      if (!(error instanceof AnalyticsNotFoundError)) {
        throw new Error("expected AnalyticsNotFoundError");
      }
      expect(error.name).toBe("AnalyticsNotFoundError");
      expect(error.resource).toBe("project");
      expect(error.resourceId).toBe("proj_missing");
      expect(error.message).toBe("Project not found");
      expect(error.message).not.toContain("/");
      expect(error.message).not.toContain("\\");
    }
  });

  it("groups sessions without a project id under the unknown project", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_p", title: "P", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_x", title: "X", createdMs: NOW - 2 * HOUR_MS }),
      ],
      projects: [projectInfo("proj_p", { name: "P" })],
      messages: [
        assistantRow("ses_p", "msg_p", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_x", "msg_x", NOW - 2 * HOUR_MS, { input: 2 }),
      ],
    });

    const analytics = createUsageAnalytics(dataset);
    const home = analytics.home("24h", NOW);
    expect(home.projects.map((row) => row.projectId).sort()).toEqual([
      "proj_p",
      UNKNOWN_PROJECT_ID,
    ]);

    const unknown = analytics.project(UNKNOWN_PROJECT_ID, "24h", NOW);
    expect(unknown.name).toBe("Project");
    expect(unknown.roots.map((root) => root.sessionId)).toEqual(["ses_x"]);
    expect(unknown.totals.input).toBe(2);
  });

  it("falls back from project.name to a directory basename and finally to Project", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_1",
          title: "One",
          projectID: "proj_1",
          createdMs: NOW - 2 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_2",
          title: "Two",
          projectID: "proj_2",
          createdMs: NOW - 2 * HOUR_MS,
        }),
        sessionInfo({
          id: "ses_3",
          title: "Three",
          projectID: "proj_3",
          directory: "/x/delta",
          createdMs: NOW - 2 * HOUR_MS,
        }),
      ],
      projects: [
        projectInfo("proj_1", { name: "  ", directories: ["/a/beta"] }),
        projectInfo("proj_2", { name: "Gamma" }),
      ],
      messages: [
        assistantRow("ses_1", "msg_1", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_2", "msg_2", NOW - HOUR_MS, { input: 1 }),
        assistantRow("ses_3", "msg_3", NOW - HOUR_MS, { input: 1 }),
      ],
    });

    const home = createUsageAnalytics(dataset).home("24h", NOW);
    const names = new Map(home.projects.map((row) => [row.projectId, row.name]));
    expect(names.get("proj_1")).toBe("beta");
    expect(names.get("proj_2")).toBe("Gamma");
    expect(names.get("proj_3")).toBe("Project");
  });

  it("keeps explicit project.name and otherwise uses the canonical root basename", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_e", projectID: "proj_explicit", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_f", projectID: "proj_fallback", createdMs: NOW - 2 * HOUR_MS }),
      ],
      projects: [
        projectInfo("proj_explicit", {
          name: "Explicit",
          directories: ["/srv/canonical-root", "/srv/aaa-linked"],
        }),
        projectInfo("proj_fallback", {
          directories: ["/srv/canonical-root", "/srv/aaa-linked"],
          worktrees: ["/srv/aaa-linked"],
        }),
      ],
    });

    const home = createUsageAnalytics(dataset).home("lifetime", NOW);
    const names = new Map(home.projects.map((row) => [row.projectId, row.name]));

    expect(names.get("proj_explicit")).toBe("Explicit");
    // The canonical root is first even though the linked worktree sorts first
    // lexicographically; the fallback name is its basename, not the linked one.
    expect(names.get("proj_fallback")).toBe("canonical-root");
  });

  it("keeps totals under the same project id when the canonical root is renamed", () => {
    const parts = {
      sessions: [
        sessionInfo({
          id: "ses_r",
          title: "Root",
          projectID: "proj_p",
          directory: "/srv/root-old",
          createdMs: NOW - 2 * HOUR_MS,
        }),
      ],
      messages: [assistantRow("ses_r", "msg_r", NOW - HOUR_MS, { input: 9 })],
    };
    const before = createUsageAnalytics(
      makeDataset({
        ...parts,
        projects: [projectInfo("proj_p", { name: "P", directories: ["/srv/root-old"] })],
      }),
    );
    const after = createUsageAnalytics(
      makeDataset({
        ...parts,
        projects: [projectInfo("proj_p", { name: "P", directories: ["/srv/root-new"] })],
      }),
    );

    expect(after.home("24h", NOW).usage).toEqual(before.home("24h", NOW).usage);
    expect(after.project("proj_p", "24h", NOW)).toEqual(before.project("proj_p", "24h", NOW));
  });

  it("keeps sessions from retired worktrees visible and counted", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({
          id: "ses_retired",
          title: "Retired",
          projectID: "proj_p",
          directory: "/srv/retired-linked",
          createdMs: NOW - 2 * HOUR_MS,
        }),
      ],
      projects: [
        projectInfo("proj_p", {
          name: "P",
          directories: ["/srv/canonical-root"],
          // The retired linked worktree is no longer listed in current metadata.
          worktrees: [],
        }),
      ],
      messages: [assistantRow("ses_retired", "msg_r", NOW - HOUR_MS, { input: 9 })],
    });

    const analytics = createUsageAnalytics(dataset);
    const snapshot = analytics.project("proj_p", "24h", NOW);

    expect(snapshot.totals.input).toBe(9);
    expect(snapshot.roots.map((root) => root.sessionId)).toEqual(["ses_retired"]);
    expect(snapshot.roots[0]?.worktreeLabel).toBe("retired-linked");
    expect(analytics.home("24h", NOW).projects[0]?.tokens.input).toBe(9);
  });

  it("returns an empty project snapshot for a record-only project", () => {
    const dataset = makeDataset({
      sessions: [],
      projects: [projectInfo("proj_ghost", { name: "Ghost" })],
    });

    const snapshot = createUsageAnalytics(dataset).project("proj_ghost", "24h", NOW);
    expect(snapshot.name).toBe("Ghost");
    expect(snapshot.roots).toEqual([]);
    expect(snapshot.totals).toEqual({ ...zeroCosted(), sessionCount: 0 });
    expect(snapshot.usage.buckets).toHaveLength(24);
    expect(snapshot.usage.buckets.every((bucket) => bucket.tokens.total === 0)).toBe(true);

    const home = createUsageAnalytics(dataset).home("24h", NOW);
    expect(home.projects).toEqual([]);
    const lifetime = createUsageAnalytics(dataset).home("lifetime", NOW);
    expect(lifetime.projects.map((row) => row.projectId)).toEqual(["proj_ghost"]);
  });
});
