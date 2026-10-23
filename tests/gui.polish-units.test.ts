import { beforeEach, describe, expect, it, vi } from "vitest";

// The node export of Solid resolves to its server runtime, whose signals are
// inert. These units only need an accessor/setter pair, so run them on the
// same semantics the browser build has instead of a frozen server snapshot.
vi.mock("solid-js", () => ({
  createSignal: <T>(initial: T): [() => T, (next: T) => void] => {
    let value = initial;
    return [
      () => value,
      (next: T) => {
        value = next;
      },
    ];
  },
  Show: () => null,
}));

// `estimate.tsx` pulls the public tooltip (and Kobalte's client-only portal)
// through the wrapper at module load. The string helper under test needs none
// of it, so stub the boundary rather than spin up a DOM.
vi.mock("../src/ui/opencode-ui.js", () => ({
  Icon: () => null,
  Tooltip: () => null,
}));

import type {
  Bucket,
  CostedTokens,
  ProjectActivityRow,
  ProjectRootRow,
  SessionNode,
  SessionSnapshot,
  StepPoint,
  TokenStack,
} from "../src/contracts/dashboard.js";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import type {
  OpenCodeCompactionMarker,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";
import {
  buildSessionChartGeometry,
  buildUsageGeometry,
  cacheHitRate,
} from "../src/ui/chart-geometry.js";
import { BUSY_DELAY_MS, createBusyIndicator } from "../src/ui/components/busy.js";
import { estimateExplanation } from "../src/ui/components/estimate.js";
import { sortProjectRows, sortRootRows, sortSessionTree } from "../src/ui/sorting.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function tokensOf(overrides: Partial<TokenStack> = {}): TokenStack {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, ...overrides };
}

function costed(overrides: Partial<TokenStack> = {}): CostedTokens {
  const stack = tokensOf(overrides);
  return {
    ...stack,
    total: stack.input + stack.cacheRead + stack.cacheWrite + stack.output + stack.reasoning,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function bucketOf(overrides: Partial<TokenStack> = {}): Bucket {
  return { startMs: 0, endMs: 1, tokens: costed(overrides) };
}

function sessionNode(sessionId: string, parentId?: string, depth = 0): SessionNode {
  return {
    sessionId,
    parentId,
    title: sessionId,
    depth,
    childIds: [],
    ownTokens: costed(),
    subtreeTokens: costed(),
    stepCount: 0,
    subtreeNodeCount: 1,
    latestActivityAtMs: 0,
  };
}

function sessionStep(
  sessionId: string,
  index: number,
  contextTokens: number,
  totalTokens: number,
): StepPoint {
  return {
    sessionId,
    messageId: `msg-${sessionId}-${index}`,
    atMs: 1000 + index * 1000,
    branch: 0,
    stack: tokensOf(),
    contextTokens,
    totalTokens,
  };
}

function sessionOf(
  focusSessionId: string,
  nodes: SessionNode[],
  steps: StepPoint[],
): SessionSnapshot {
  return {
    focusSessionId,
    timeZone: "UTC",
    projectId: "project",
    projectName: "Project",
    breadcrumbs: [{ sessionId: focusSessionId, title: focusSessionId, isFocus: true }],
    nodes,
    steps,
    compactionMarkers: [],
    ownSummary: {
      ...costed(),
      stepCount: steps.filter((step) => step.sessionId === focusSessionId).length,
    },
    treeTotals: costed(),
    stepSemantics: "Synthetic completed assistant steps.",
  };
}

type RawTokenCounts = OpenCodeRawAssistantRow["tokens"];

function assistantRow(
  sessionID: string,
  messageID: string,
  createdAtMs: number,
  completedAtMs: number,
  tokens: Partial<RawTokenCounts> = {},
): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs,
    completedAtMs,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
  };
}

function sessionInfo(opts: {
  id: string;
  title?: string;
  parentID?: string;
  projectID?: string;
  createdMs?: number;
}): OpenCodeSessionInfo {
  return {
    id: opts.id,
    title: opts.title,
    parentID: opts.parentID,
    projectID: opts.projectID,
    time: { created: opts.createdMs, updated: opts.createdMs },
  };
}

function projectInfo(id: string, name: string): OpenCodeProjectInfo {
  return { id, name, directories: [`/work/${id}`], worktrees: [] };
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

function projectRow(
  projectId: string,
  latestActivityAtMs: number,
  total: number,
): ProjectActivityRow {
  return {
    projectId,
    name: projectId,
    tokens: costed({ input: total }),
    rootSessionCount: 1,
    latestActivityAtMs,
  };
}

function rootRow(sessionId: string, latestActivityAtMs: number, total: number): ProjectRootRow {
  return {
    sessionId,
    title: sessionId,
    tokens: costed({ input: total }),
    latestActivityAtMs,
  };
}

function node(
  sessionId: string,
  opts: {
    childIds?: string[];
    own?: Partial<TokenStack>;
    subtree?: Partial<TokenStack>;
    latestActivityAtMs?: number;
    depth?: number;
  } = {},
): SessionNode {
  return {
    sessionId,
    title: sessionId,
    depth: opts.depth ?? 0,
    childIds: opts.childIds ?? [],
    ownTokens: costed(opts.own ?? {}),
    subtreeTokens: costed(opts.subtree ?? opts.own ?? {}),
    stepCount: 0,
    subtreeNodeCount: 1,
    latestActivityAtMs: opts.latestActivityAtMs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 1. Chart geometry: cache honesty
// ---------------------------------------------------------------------------

describe("cacheHitRate", () => {
  it("has no rate without input-side traffic, not a manufactured zero", () => {
    expect(cacheHitRate(tokensOf())).toBeNull();
    expect(cacheHitRate(tokensOf({ output: 500, reasoning: 500 }))).toBeNull();
  });

  it("reports 0% for input-only and 100% for cache-read-only tokens", () => {
    expect(cacheHitRate(tokensOf({ input: 42 }))).toBe(0);
    expect(cacheHitRate(tokensOf({ cacheRead: 42 }))).toBe(100);
  });

  it("counts cache writes in the denominator but never the numerator", () => {
    expect(cacheHitRate(tokensOf({ input: 10, cacheRead: 30, cacheWrite: 60 }))).toBeCloseTo(
      30,
      10,
    );
    // A write-only bucket is input-side traffic with no hit: 0%, not null.
    expect(cacheHitRate(tokensOf({ cacheWrite: 60 }))).toBe(0);
  });

  it("ignores output and reasoning entirely", () => {
    const base = tokensOf({ input: 10, cacheRead: 30, cacheWrite: 60 });
    const noisy = tokensOf({
      input: 10,
      cacheRead: 30,
      cacheWrite: 60,
      output: 9e6,
      reasoning: 8e6,
    });
    expect(cacheHitRate(noisy)).toBeCloseTo(cacheHitRate(base) as number, 10);
  });
});

describe("buildUsageGeometry external gaps and rounded segments", () => {
  it("keeps a one-unit segment at its true height with a constrained half-unit radius", () => {
    const bucket = bucketOf({ input: 223, reasoning: 1 });
    const geometry = buildUsageGeometry([bucket]);
    const bar = geometry.bars[0];
    const tiny = bar?.segments.find((segment) => segment.key === "reasoning");
    expect(tiny).toBeDefined();
    expect(tiny?.height).toBeCloseTo(1, 10);
    expect(tiny?.radius).toBeCloseTo(0.5, 10);
    const lower = bar?.segments.find((segment) => segment.key === "input");
    expect(lower).toBeDefined();
    expect((lower?.y as number) - ((tiny?.y as number) + (tiny?.height as number))).toBeCloseTo(
      1,
      10,
    );
    expect(bar?.top).toBeCloseTo(geometry.plot.top - 1, 10);
  });

  it("adds one external gap per adjacent pair and caps presentation growth at four units", () => {
    const bucket = bucketOf({
      cacheRead: 50,
      input: 100,
      reasoning: 24,
      output: 20,
      cacheWrite: 30,
    });
    const geometry = buildUsageGeometry([bucket]);
    const bar = geometry.bars[0];
    expect(bar?.segments).toHaveLength(5);
    const segments = bar?.segments ?? [];
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!segment) continue;
      expect(segment.height).toBeCloseTo(
        (segment.value / geometry.yMax) * geometry.plot.height,
        10,
      );
      expect(segment.radius).toBeCloseTo(Math.min(1, segment.width / 2, segment.height / 2), 10);
      if (index === 0) continue;
      const lower = segments[index - 1];
      if (!lower) continue;
      expect(lower.y - (segment.y + segment.height)).toBeCloseTo(1, 10);
    }
    const coloredHeight = segments.reduce((sum, segment) => sum + segment.height, 0);
    expect(coloredHeight).toBeCloseTo(224, 10);
    expect(geometry.plot.top).toBe(12);
    expect(bar?.top).toBe(8);
    expect(bar?.top).toBeCloseTo(geometry.plot.top - 4, 10);
    expect(bar?.top).toBeCloseTo(geometry.plot.bottom - coloredHeight - 4, 10);
    expect(bar?.total).toBe(224);

    const rate = cacheHitRate(bucket.tokens);
    expect(geometry.cacheRatePoints[0]?.y).toBeCloseTo(
      geometry.plot.bottom - ((rate as number) / 100) * geometry.plot.height,
      10,
    );
    expect(geometry.cacheRateTicks.at(-1)?.y).toBeCloseTo(geometry.plot.top, 10);
  });

  it("keeps dense narrow stacks finite, bounded, and on the unchanged token and cache scales", () => {
    const buckets = Array.from({ length: 900 }, () =>
      bucketOf({ input: 1, cacheRead: 1, cacheWrite: 1, output: 1, reasoning: 1 }),
    );
    const geometry = buildUsageGeometry(buckets, {
      width: 291,
      height: 220,
      padding: { top: 12, right: 12, bottom: 24, left: 48 },
    });
    expect(geometry.bars).toHaveLength(900);
    for (const bar of geometry.bars) {
      expect(bar.segments).toHaveLength(5);
      expect(bar.top).toBeCloseTo(geometry.plot.top - 4, 10);
      expect(bar.top).toBeGreaterThanOrEqual(0);
      for (let index = 0; index < bar.segments.length; index += 1) {
        const segment = bar.segments[index];
        if (!segment) continue;
        expect(Number.isFinite(segment.y)).toBe(true);
        expect(Number.isFinite(segment.height)).toBe(true);
        expect(segment.height).toBeGreaterThan(0);
        expect(segment.radius).toBeCloseTo(Math.min(1, segment.width / 2, segment.height / 2), 10);
        if (index === 0) continue;
        const lower = bar.segments[index - 1];
        if (!lower) continue;
        expect(lower.y - (segment.y + segment.height)).toBeCloseTo(1, 10);
      }
    }
    const rate = cacheHitRate(buckets[0]?.tokens ?? tokensOf());
    expect(geometry.cacheRatePoints[0]?.y).toBeCloseTo(
      geometry.plot.bottom - ((rate as number) / 100) * geometry.plot.height,
      10,
    );
    expect(geometry.cacheRateTicks.at(-1)?.y).toBeCloseTo(geometry.plot.top, 10);
  });
});

describe("buildSessionChartGeometry own, tree and context carry", () => {
  it("carries focus context through children while own cumulative stays flat on the shared scale", () => {
    const focus = "session-focus";
    const child = "session-child";
    const rootNode = sessionNode(focus);
    rootNode.childIds = [child];
    const geometry = buildSessionChartGeometry(
      sessionOf(
        focus,
        [rootNode, sessionNode(child, focus, 1)],
        [
          sessionStep(focus, 0, 500, 500),
          sessionStep(child, 1, 1200, 700),
          sessionStep(focus, 2, 300, 400),
          sessionStep(child, 3, 999, 50),
        ],
      ),
    );

    expect(geometry.hasDescendants).toBe(true);
    expect(geometry.focusStepCount).toBe(2);
    // The child context is never borrowed; the last focus value carries.
    expect(geometry.contextValues).toEqual([500, 500, 300, 300]);
    expect(geometry.context.points.map((point) => point.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(geometry.context.points.map((point) => point.value)).toEqual([500, 500, 300, 300]);
    expect(geometry.ownCumulativeValues).toEqual([500, 500, 900, 900]);
    expect(geometry.treeCumulativeValues).toEqual([500, 1200, 1600, 1650]);
    expect(geometry.own.points.map((point) => point.value)).toEqual([500, 500, 900, 900]);
    expect(geometry.tree.points.map((point) => point.value)).toEqual([500, 1200, 1600, 1650]);
    for (let index = 0; index < geometry.own.points.length; index += 1) {
      expect(geometry.ownCumulativeValues[index]).toBeLessThanOrEqual(
        geometry.treeCumulativeValues[index] as number,
      );
    }
    expect(geometry.own.domainMax).toBe(1650);
    expect(geometry.tree.domainMax).toBe(1650);
    expect(geometry.cumulativeTicks).toEqual(geometry.tree.ticks);
    expect(geometry.own.points[0]?.y).toBeCloseTo(geometry.tree.points[0]?.y as number, 10);
  });

  it("retains unknown context before the first focus sample and starts own cumulative at zero", () => {
    const focus = "session-focus";
    const child = "session-child";
    const geometry = buildSessionChartGeometry(
      sessionOf(
        focus,
        [sessionNode(focus), sessionNode(child, focus, 1)],
        [
          sessionStep(child, 0, 999, 100),
          sessionStep(focus, 1, 500, 200),
          sessionStep(child, 2, 999, 50),
        ],
      ),
    );

    expect(geometry.hasDescendants).toBe(true);
    expect(geometry.contextValues).toEqual([undefined, 500, 500]);
    expect(geometry.context.points.map((point) => point.stepIndex)).toEqual([1, 2]);
    expect(geometry.context.points.map((point) => point.value)).toEqual([500, 500]);
    expect(geometry.focusStepCount).toBe(1);
    expect(geometry.ownCumulativeValues).toEqual([0, 200, 200]);
    expect(geometry.treeCumulativeValues).toEqual([100, 300, 350]);
    expect(geometry.own.domainMax).toBe(350);
    expect(geometry.tree.domainMax).toBe(350);
  });

  it("shows own and tree for a subsession with descendants and only own for a leaf", () => {
    const focus = "session-child";
    const grandchild = "session-grandchild";
    const leaf = buildSessionChartGeometry(
      sessionOf(focus, [sessionNode(focus)], [sessionStep(focus, 0, 1200, 1400)]),
    );
    expect(leaf.hasDescendants).toBe(false);
    expect(leaf.contextValues).toEqual([1200]);
    expect(leaf.ownCumulativeValues).toEqual([1400]);
    expect(leaf.treeCumulativeValues).toEqual([1400]);
    expect(leaf.own.domainMax).toBe(1400);
    expect(leaf.tree.domainMax).toBe(1400);

    // Actual node membership, not parentId or a root-only assumption.
    const withDescendant = buildSessionChartGeometry(
      sessionOf(
        focus,
        [sessionNode(focus), sessionNode(grandchild, undefined, 2)],
        [sessionStep(focus, 0, 1200, 1400), sessionStep(grandchild, 1, 999, 100)],
      ),
    );
    expect(withDescendant.hasDescendants).toBe(true);
    expect(withDescendant.focusStepCount).toBe(1);
    expect(withDescendant.contextValues).toEqual([1200, 1200]);
    expect(withDescendant.ownCumulativeValues).toEqual([1400, 1400]);
    expect(withDescendant.treeCumulativeValues).toEqual([1400, 1500]);
    expect(withDescendant.own.domainMax).toBe(1500);
    expect(withDescendant.tree.domainMax).toBe(1500);
  });

  it("does not reset own or tree prefixes at compaction and does not count carried context as focus steps", () => {
    const focus = "session-focus";
    const child = "session-child";
    const snapshot = sessionOf(
      focus,
      [sessionNode(focus), sessionNode(child, focus, 1)],
      [
        sessionStep(focus, 0, 500, 500),
        sessionStep(focus, 1, 300, 400),
        sessionStep(child, 2, 999, 100),
      ],
    );
    snapshot.compactionMarkers = [{ sessionId: focus, atMs: 1500, messageId: "msg-compaction" }];
    const geometry = buildSessionChartGeometry(snapshot);

    expect(geometry.focusStepCount).toBe(2);
    expect(geometry.context.points.map((point) => point.stepIndex)).toEqual([0, 1, 2]);
    expect(geometry.contextValues).toEqual([500, 300, 300]);
    expect(geometry.ownCumulativeValues).toEqual([500, 900, 900]);
    expect(geometry.treeCumulativeValues).toEqual([500, 900, 1000]);
    expect(geometry.compaction).toEqual([
      expect.objectContaining({ sessionId: focus, stepIndex: 1 }),
    ]);
  });
});

describe("buildUsageGeometry cache overlay", () => {
  it("plots each bucket's own rate instead of averaging percentages", () => {
    // 10% and 90% individually; a global sum would read 50% in both buckets.
    const geometry = buildUsageGeometry([
      bucketOf({ input: 90, cacheRead: 10 }),
      bucketOf({ input: 10, cacheRead: 90 }),
    ]);
    expect(geometry.cacheRatePoints).toHaveLength(2);
    expect(geometry.cacheRatePoints.map((point) => point.bucketIndex)).toEqual([0, 1]);
    expect(geometry.cacheRatePoints[0]?.value).toBeCloseTo(10, 10);
    expect(geometry.cacheRatePoints[1]?.value).toBeCloseTo(90, 10);
    // The independent rate line is smoothed monotonically, not a polyline.
    expect(geometry.cacheRatePath).toContain(" C ");
  });

  it("omits a null-rate bucket and starts a new path run after the gap", () => {
    const geometry = buildUsageGeometry([
      bucketOf({ input: 10 }),
      bucketOf(),
      bucketOf({ input: 10, cacheRead: 10 }),
    ]);
    // The empty middle bucket has no meaningful rate, so no point is invented.
    expect(geometry.cacheRatePoints.map((point) => point.bucketIndex)).toEqual([0, 2]);
    expect(geometry.cacheRatePoints.map((point) => point.value)).toEqual([0, 50]);
    expect(geometry.cacheRatePath.match(/M /g)).toHaveLength(2);
    expect(geometry.cacheRatePath.match(/L /g)).toHaveLength(2);
    expect(geometry.cacheRatePath.match(/M ([-\d.]+) ([-\d.]+) L \1 \2/g)).toHaveLength(2);
  });

  it("keeps a contiguous monotone curve and paints an isolated rate without bridging the gap", () => {
    const geometry = buildUsageGeometry([
      bucketOf({ input: 90, cacheRead: 10 }),
      bucketOf({ input: 10, cacheRead: 90 }),
      bucketOf(),
      bucketOf({ input: 20, cacheRead: 10 }),
    ]);
    expect(geometry.cacheRatePoints.map((point) => point.bucketIndex)).toEqual([0, 1, 3]);
    expect(geometry.cacheRatePoints[2]?.value).toBeCloseTo(100 / 3, 10);
    expect(geometry.cacheRatePath).toContain(" C ");
    expect(geometry.cacheRatePath.match(/M /g)).toHaveLength(2);
    expect(geometry.cacheRatePath.match(/L /g)).toHaveLength(1);
    expect(geometry.cacheRatePath.match(/M ([-\d.]+) ([-\d.]+) L \1 \2/g)).toHaveLength(1);
  });

  it("draws one fixed 0/25/50/75/100 tick scale with monotone pixel y", () => {
    const geometry = buildUsageGeometry([bucketOf({ input: 10, cacheRead: 10 })]);
    expect(geometry.cacheRateTicks.map((tick) => tick.value)).toEqual([0, 25, 50, 75, 100]);
    const ys = geometry.cacheRateTicks.map((tick) => tick.y);
    for (let index = 1; index < ys.length; index += 1) {
      expect(ys[index] as number).toBeLessThan(ys[index - 1] as number);
    }
    expect(ys[0]).toBe(geometry.plot.bottom);
    expect(ys.at(-1)).toBe(geometry.plot.top);
  });
});

// ---------------------------------------------------------------------------
// 2. List ordering
// ---------------------------------------------------------------------------

describe("sortProjectRows and sortRootRows", () => {
  it("orders project rows by activity or displayed tokens, tie-breaking by id", () => {
    const rows = [
      projectRow("p_b", 300, 10),
      projectRow("p_a", 300, 30),
      projectRow("p_c", 200, 100),
    ];
    expect(sortProjectRows(rows, "activity").map((row) => row.projectId)).toEqual([
      "p_a",
      "p_b",
      "p_c",
    ]);
    expect(sortProjectRows(rows, "tokens").map((row) => row.projectId)).toEqual([
      "p_c",
      "p_a",
      "p_b",
    ]);
  });

  it("orders root rows by activity or token total, tie-breaking by session id", () => {
    const rows = [rootRow("ses_b", 300, 10), rootRow("ses_a", 300, 30), rootRow("ses_c", 200, 100)];
    expect(sortRootRows(rows, "activity").map((row) => row.sessionId)).toEqual([
      "ses_a",
      "ses_b",
      "ses_c",
    ]);
    expect(sortRootRows(rows, "tokens").map((row) => row.sessionId)).toEqual([
      "ses_c",
      "ses_a",
      "ses_b",
    ]);
  });

  it("leaves the caller's arrays untouched", () => {
    const projects = [projectRow("p_b", 100, 1), projectRow("p_a", 200, 2)];
    const roots = [rootRow("ses_b", 100, 1), rootRow("ses_a", 200, 2)];
    const projectsBefore = structuredClone(projects);
    const rootsBefore = structuredClone(roots);
    sortProjectRows(projects, "activity");
    sortRootRows(roots, "tokens");
    expect(projects).toEqual(projectsBefore);
    expect(roots).toEqual(rootsBefore);
  });
});

describe("sortSessionTree", () => {
  it("sorts siblings per parent and keeps the focus first, never flattening depths", () => {
    // `g` has the highest activity of all; a flattened sort would lift it above
    // its parent, which the tree must not allow.
    const nodes = [
      node("f", { childIds: ["c1", "c2"], latestActivityAtMs: 1 }),
      node("c1", { childIds: ["g"], latestActivityAtMs: 200 }),
      node("c2", { latestActivityAtMs: 300 }),
      node("g", { latestActivityAtMs: 999 }),
    ];
    const sorted = sortSessionTree(nodes, "activity");
    expect(sorted.map((entry) => entry.sessionId)).toEqual(["f", "c2", "c1", "g"]);
    expect(sorted[0]?.sessionId).toBe("f");
    // The grandchild stays directly under its own parent.
    expect(sorted.findIndex((entry) => entry.sessionId === "g")).toBe(
      sorted.findIndex((entry) => entry.sessionId === "c1") + 1,
    );
    expect(nodes.map((entry) => entry.sessionId)).toEqual(["f", "c1", "c2", "g"]);
  });

  it("uses subtree totals in tokens mode, not the node's own tokens", () => {
    const nodes = [
      node("f", { childIds: ["c1", "c2"] }),
      // c1 owns nothing but carries a huge subtree via g.
      node("c1", { childIds: ["g"], own: { input: 0 }, subtree: { input: 5_000 } }),
      node("c2", { own: { input: 1_000 }, subtree: { input: 1_000 } }),
      node("g", { own: { input: 5_000 }, subtree: { input: 5_000 } }),
    ];
    const sorted = sortSessionTree(nodes, "tokens");
    expect(sorted.map((entry) => entry.sessionId)).toEqual(["f", "c1", "g", "c2"]);
    expect(sorted[0]?.sessionId).toBe("f");
  });

  it("defaults to activity ordering and is deterministic across calls", () => {
    const nodes = [
      node("f", { childIds: ["c1", "c2"], latestActivityAtMs: 10 }),
      node("c1", { latestActivityAtMs: 100 }),
      node("c2", { latestActivityAtMs: 200 }),
    ];
    const first = sortSessionTree(nodes, "activity");
    const second = sortSessionTree(nodes, "activity");
    expect(first.map((entry) => entry.sessionId)).toEqual(["f", "c2", "c1"]);
    expect(second.map((entry) => entry.sessionId)).toEqual(first.map((entry) => entry.sessionId));
  });

  it("terminates on a child cycle and visits every node exactly once", () => {
    const nodes = [
      node("f", { childIds: ["a", "b"], latestActivityAtMs: 10 }),
      node("a", { childIds: ["f"], latestActivityAtMs: 20 }),
      node("b", { childIds: ["b"], latestActivityAtMs: 30 }),
    ];
    const sorted = sortSessionTree(nodes, "activity");
    const ids = sorted.map((entry) => entry.sessionId);
    expect(ids).toHaveLength(nodes.length);
    expect(new Set(ids).size).toBe(nodes.length);
    expect(new Set(ids)).toEqual(new Set(["f", "a", "b"]));
    expect(ids[0]).toBe("f");
  });

  it("appends unreachable nodes in their original order, once each", () => {
    const nodes = [
      node("f", { childIds: ["c1"], latestActivityAtMs: 10 }),
      node("c1", { latestActivityAtMs: 20 }),
      node("u2", { latestActivityAtMs: 900 }),
      node("u1", { latestActivityAtMs: 800 }),
    ];
    const sorted = sortSessionTree(nodes, "activity");
    expect(sorted.map((entry) => entry.sessionId)).toEqual(["f", "c1", "u2", "u1"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Foreground busy indicator
// ---------------------------------------------------------------------------

describe("createBusyIndicator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("stays hidden for the first second and appears at exactly 1000ms", () => {
    expect(BUSY_DELAY_MS).toBe(1000);
    const indicator = createBusyIndicator();
    expect(indicator.visible()).toBe(false);

    indicator.update({ active: true, hasData: false });
    vi.advanceTimersByTime(999);
    expect(indicator.visible()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(indicator.visible()).toBe(true);
    indicator.dispose();
  });

  it("hides immediately on settle and cancels the pending timer for good", () => {
    const indicator = createBusyIndicator();
    indicator.update({ active: true, hasData: false });
    vi.advanceTimersByTime(500);
    expect(indicator.visible()).toBe(false);

    indicator.update({ active: false, hasData: true });
    expect(indicator.visible()).toBe(false);
    vi.advanceTimersByTime(10 * 60_000);
    expect(indicator.visible()).toBe(false);
    indicator.dispose();
  });

  it("cancels a pending reveal when disposed", () => {
    const indicator = createBusyIndicator();
    indicator.update({ active: true, hasData: false });
    indicator.dispose();
    vi.advanceTimersByTime(10_000);
    expect(indicator.visible()).toBe(false);
    expect(indicator.hasData()).toBe(false);
  });

  it("reflects the latest hasData so copy can become 'Updating'", () => {
    const indicator = createBusyIndicator();
    indicator.update({ active: true, hasData: false });
    expect(indicator.hasData()).toBe(false);

    indicator.update({ active: true, hasData: true });
    expect(indicator.hasData()).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(indicator.visible()).toBe(true);
    expect(indicator.hasData()).toBe(true);
    indicator.dispose();
  });

  it("stays visible through a supersede instead of flickering off and on", () => {
    const indicator = createBusyIndicator();
    indicator.update({ active: true, hasData: false });
    vi.advanceTimersByTime(1000);
    expect(indicator.visible()).toBe(true);

    indicator.update({ active: true, hasData: true });
    expect(indicator.visible()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(indicator.visible()).toBe(true);
    indicator.dispose();
    expect(indicator.visible()).toBe(false);
  });

  it("honours a custom delay", () => {
    const indicator = createBusyIndicator(250);
    indicator.update({ active: true, hasData: false });
    vi.advanceTimersByTime(249);
    expect(indicator.visible()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(indicator.visible()).toBe(true);
    indicator.dispose();
  });
});

// ---------------------------------------------------------------------------
// 4. Estimate explanation copy
// ---------------------------------------------------------------------------

describe("estimateExplanation", () => {
  it("always names the figure as an API-equivalent estimate, not spend", () => {
    for (const totals of [
      { unknownTokens: 0, unpricedTokens: 0 },
      { unknownTokens: 1, unpricedTokens: 2 },
    ]) {
      const text = estimateExplanation(totals);
      expect(text).toContain("API-equivalent estimate");
      expect(text).toContain("not actual subscription spend");
    }
  });

  it("reports unknown tokens separately from unpriced tokens", () => {
    const unknownOnly = estimateExplanation({ unknownTokens: 5, unpricedTokens: 0 });
    expect(unknownOnly).toContain("5 unknown tokens are excluded from the estimate.");
    expect(unknownOnly).not.toContain("unpriced");

    const unpricedOnly = estimateExplanation({ unknownTokens: 0, unpricedTokens: 7 });
    expect(unpricedOnly).toContain("7 unpriced tokens are excluded from the estimate.");
    expect(unpricedOnly).not.toContain("unknown");
  });

  it("reports both exclusions with exact grouped counts", () => {
    const text = estimateExplanation({ unknownTokens: 1_200, unpricedTokens: 3_400 });
    expect(text).toContain("1,200 unknown tokens are excluded from the estimate.");
    expect(text).toContain("3,400 unpriced tokens are excluded from the estimate.");
  });

  it("says every token is priced when there is nothing to exclude", () => {
    const text = estimateExplanation({ unknownTokens: 0, unpricedTokens: 0 });
    expect(text).toContain("All reported tokens are priced");
    expect(text).not.toContain("are excluded from the estimate");
  });
});

// ---------------------------------------------------------------------------
// 5. Project Lifetime buckets
// ---------------------------------------------------------------------------

describe("project lifetime usage", () => {
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const ACTIVITY = Date.UTC(2026, 0, 12, 12, 0, 0);
  const ACTIVITY_DAY_START = Date.UTC(2026, 0, 12, 0, 0, 0);

  function dataset(): UsageAnalyticsDataset {
    return makeDataset({
      sessions: [
        sessionInfo({ id: "ses_p1", title: "P1", projectID: "p1", createdMs: ACTIVITY }),
        sessionInfo({
          id: "ses_p2",
          title: "P2",
          projectID: "p2",
          createdMs: NOW - 2 * HOUR_MS,
        }),
      ],
      projects: [projectInfo("p1", "Project One"), projectInfo("p2", "Project Two")],
      messages: [
        assistantRow("ses_p1", "msg_p1", ACTIVITY, ACTIVITY, { input: 120, cacheRead: 30 }),
        // Newer activity in another project must not leak into p1's totals.
        assistantRow("ses_p2", "msg_p2", NOW - HOUR_MS, NOW - HOUR_MS, { input: 9_999 }),
      ],
    });
  }

  it("opens the usage window at the first activity day and runs through now", () => {
    const snapshot = createUsageAnalytics(dataset(), { timeZone: "UTC" }).project(
      "p1",
      "lifetime",
      NOW,
    );

    expect(snapshot.usage.window).toEqual({ untilMs: NOW });
    expect(snapshot.usage.window).not.toHaveProperty("sinceMs");
    expect(snapshot.usage.bucketUnit).toBe("day");

    const buckets = snapshot.usage.buckets;
    expect(buckets[0]?.startMs).toBe(ACTIVITY_DAY_START);
    expect(buckets.at(-1)?.endMs).toBe(NOW);
    // Zero-filled calendar days after the last activity still render.
    expect(buckets).toHaveLength(4);
    expect(buckets[0]?.tokens.total).toBe(150);
    for (const bucket of buckets.slice(1)) expect(bucket.tokens.total).toBe(0);
    for (let index = 1; index < buckets.length; index += 1) {
      expect(buckets[index]?.startMs).toBe(buckets[index - 1]?.endMs);
    }

    // Totals cover the project only, never the unrelated newer project.
    expect(snapshot.totals.total).toBe(150);
    expect(snapshot.usage.totals.total).toBe(150);
    expect(snapshot.usage.totals.input).toBe(120);
    expect(snapshot.roots.map((root) => root.sessionId)).toEqual(["ses_p1"]);
  });

  it("keeps trailing empty days when now moves past an abandoned project", () => {
    const later = NOW + 2 * DAY_MS;
    const snapshot = createUsageAnalytics(dataset(), { timeZone: "UTC" }).project(
      "p1",
      "lifetime",
      later,
    );

    expect(snapshot.usage.window.untilMs).toBe(later);
    const buckets = snapshot.usage.buckets;
    expect(buckets[0]?.startMs).toBe(ACTIVITY_DAY_START);
    expect(buckets.at(-1)?.endMs).toBe(later);
    expect(buckets).toHaveLength(6);
    expect(buckets.slice(1).every((bucket) => bucket.tokens.total === 0)).toBe(true);
  });

  it("keeps the 7d window rolling while lifetime starts at first activity", () => {
    const analytics = createUsageAnalytics(dataset(), { timeZone: "UTC" });
    const sevenDay = analytics.project("p1", "7d", NOW);
    const lifetime = analytics.project("p1", "lifetime", NOW);

    expect(sevenDay.usage.window).toEqual({
      sinceMs: NOW - 7 * DAY_MS,
      untilMs: NOW,
    });
    // The finite range clips its partial edge bucket to the exact window start,
    // while lifetime opens at the first activity day's local midnight.
    expect(sevenDay.usage.buckets[0]?.startMs).toBe(NOW - 7 * DAY_MS);
    expect(lifetime.usage.buckets[0]?.startMs).toBe(ACTIVITY_DAY_START);
    expect(lifetime.usage.window.sinceMs).toBeUndefined();
    expect(sevenDay.usage.buckets.at(-1)?.endMs).toBe(NOW);
  });
});
