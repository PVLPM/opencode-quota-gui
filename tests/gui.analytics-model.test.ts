import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Model-only lane: deterministic fork ownership, incremental rollups, hour
 * boundaries, and exact price status. All fixtures are synthetic.
 *
 * The delegated mock lets one provider resolve to a mapped key without rates,
 * which the bundled models.dev snapshot cannot express, so the unpriced
 * classification is exercised without touching real pricing data.
 */
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>();
  const FAKE_PROVIDER = "unpriced-labs";
  const FAKE_MODEL = "mystery-1";
  const EDGE_PROVIDER = "edge-labs";
  const EDGE_MODEL = "dual|||model";
  const MIXED_PROVIDER = "mixed-labs";
  const MIXED_PRICED_MODEL = "priced-1";
  const MIXED_UNPRICED_MODEL = "flat-1";
  const ZERO_PROVIDER = "zero-labs";
  const ZERO_MODEL = "zero-1";
  const FREE_PROVIDER = "free-labs";
  const FREE_MODEL = "free-1";
  const TEMPORAL_PROVIDER = "temporal-labs";
  const TEMPORAL_MODEL = "peak-1";
  const RATES = { input: 1, output: 1, reasoning: 1, cache_read: 1, cache_write: 1 };
  const FREE_RATES = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
  const PRICEY_RATES = {
    input: 1_000_000_000,
    output: 1_000_000_000,
    reasoning: 1_000_000_000,
    cache_read: 1_000_000_000,
    cache_write: 1_000_000_000,
  };
  const EXTRA_PROVIDERS: ReadonlySet<string> = new Set([
    FAKE_PROVIDER,
    EDGE_PROVIDER,
    MIXED_PROVIDER,
    ZERO_PROVIDER,
    FREE_PROVIDER,
    TEMPORAL_PROVIDER,
  ]);
  const PRICED_MODELS: ReadonlySet<string> = new Set([
    `${EDGE_PROVIDER}\u0000${EDGE_MODEL}`,
    `${MIXED_PROVIDER}\u0000${MIXED_PRICED_MODEL}`,
    `${ZERO_PROVIDER}\u0000${ZERO_MODEL}`,
    `${FREE_PROVIDER}\u0000${FREE_MODEL}`,
    `${TEMPORAL_PROVIDER}\u0000${TEMPORAL_MODEL}`,
  ]);
  const KNOWN_MODELS: ReadonlySet<string> = new Set([
    `${FAKE_PROVIDER}\u0000${FAKE_MODEL}`,
    `${MIXED_PROVIDER}\u0000${MIXED_UNPRICED_MODEL}`,
    ...PRICED_MODELS,
  ]);
  return {
    ...actual,
    hasProvider: (providerID: string) =>
      EXTRA_PROVIDERS.has(providerID) || actual.hasProvider(providerID),
    isModelsDevProviderId: (providerID: string) =>
      EXTRA_PROVIDERS.has(providerID) || actual.isModelsDevProviderId(providerID),
    hasCost: (providerID: string, modelID: string) =>
      PRICED_MODELS.has(`${providerID}\u0000${modelID}`) || actual.hasCost(providerID, modelID),
    hasModel: (providerID: string, modelID: string) =>
      KNOWN_MODELS.has(`${providerID}\u0000${modelID}`) || actual.hasModel(providerID, modelID),
    lookupCost: (providerID: string, modelID: string) => {
      if (providerID === EDGE_PROVIDER) {
        return modelID === EDGE_MODEL ? PRICEY_RATES : null;
      }
      if (providerID === MIXED_PROVIDER) {
        return modelID === MIXED_PRICED_MODEL ? RATES : null;
      }
      if (providerID === ZERO_PROVIDER) {
        return modelID === ZERO_MODEL ? RATES : null;
      }
      if (providerID === FREE_PROVIDER) {
        return modelID === FREE_MODEL ? FREE_RATES : null;
      }
      if (providerID === TEMPORAL_PROVIDER) {
        return modelID === TEMPORAL_MODEL ? RATES : null;
      }
      if (providerID === FAKE_PROVIDER) return null;
      return actual.lookupCost(providerID, modelID);
    },
  };
});

import type { CostedTokens } from "../src/contracts/dashboard.js";
import { RANGE_KEYS } from "../src/contracts/ranges.js";
import {
  type AnalyticsModel,
  createAnalyticsModel,
  type HomeAnalyticsRollup,
} from "../src/gui/analytics-model.js";
import {
  __resetTemporalSnapshotForTests,
  normalizeTemporalSnapshot,
  setTemporalSnapshotForTests,
} from "../src/lib/modelsdev-temporal.js";
import type {
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const NOW_HOUR = Math.floor(NOW / HOUR) * HOUR;
const PROJECT_IDS = ["p1", "p2"];
const TEMPORAL_REVISION = "b".repeat(40);
const TEMPORAL_TEST_PROVIDER = "temporal-labs";
const TEMPORAL_TEST_MODEL = "peak-1";
const CN_2026 = {
  timeZone: "Asia/Shanghai",
  source: "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
  published: "2025-11-04",
  intervals: [
    {
      id: "new-year",
      localStart: "2026-01-01",
      localEnd: "2026-01-04",
      startMs: 1_767_196_800_000,
      endMs: 1_767_456_000_000,
    },
  ],
  makeupWorkdays: [],
};

/** UTC day boundary; the default analytics model zone is UTC. */
function utcDayStart(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

type RawTokenCounts = OpenCodeRawAssistantRow["tokens"];

function row(input: {
  sessionID: string;
  messageID: string;
  completedAtMs: number;
  createdAtMs?: number;
  tokens?: Partial<RawTokenCounts>;
  providerID?: string;
  modelID?: string;
  cost?: number;
  agent?: string;
}): OpenCodeRawAssistantRow {
  const result: OpenCodeRawAssistantRow = {
    sessionID: input.sessionID,
    messageID: input.messageID,
    createdAtMs: input.createdAtMs ?? input.completedAtMs - 1_000,
    completedAtMs: input.completedAtMs,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      ...input.tokens,
    },
    cost: input.cost ?? 1,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  };
  // An explicit `undefined` leaves the raw identity missing; omitting the
  // property keeps the common default. Empty strings stay present.
  if ("providerID" in input) {
    if (input.providerID !== undefined) result.providerID = input.providerID;
  } else {
    result.providerID = "openai";
  }
  if ("modelID" in input) {
    if (input.modelID !== undefined) result.modelID = input.modelID;
  } else {
    result.modelID = "gpt-5";
  }
  return result;
}

function sessionInfo(
  id: string,
  projectID: string,
  extra: Partial<OpenCodeSessionInfo> = {},
): OpenCodeSessionInfo {
  return {
    id,
    projectID,
    title: id,
    time: { created: NOW - 10 * HOUR, updated: NOW - 5 * HOUR },
    ...extra,
  };
}

function projectInfo(id: string): OpenCodeProjectInfo {
  return { id, name: id, directories: [`/tmp/${id}`], worktrees: [] };
}

function metadata(
  sessions: readonly OpenCodeSessionInfo[],
  projects: readonly string[] = PROJECT_IDS,
): {
  sessions: Record<string, OpenCodeSessionInfo>;
  projects: Record<string, OpenCodeProjectInfo>;
} {
  const sessionRecords: Record<string, OpenCodeSessionInfo> = {};
  for (const session of sessions) sessionRecords[session.id] = session;
  const projectRecords: Record<string, OpenCodeProjectInfo> = {};
  for (const id of projects) projectRecords[id] = projectInfo(id);
  return { sessions: sessionRecords, projects: projectRecords };
}

function createModel(
  sessions: readonly OpenCodeSessionInfo[],
  rows: readonly OpenCodeRawAssistantRow[] = [],
  projects: readonly string[] = PROJECT_IDS,
): AnalyticsModel {
  const model = createAnalyticsModel();
  const records = metadata(sessions, projects);
  model.setMetadata(records.sessions, records.projects);
  if (rows.length > 0) model.apply(rows, []);
  return model;
}

const DIMENSIONS = ["model", "provider"] as const;

function allGroupOutputs(model: AnalyticsModel): ReturnType<AnalyticsModel["groups"]>[] {
  return RANGE_KEYS.flatMap((range) =>
    DIMENSIONS.map((dimension) => model.groups({ range, dimension }, NOW)),
  );
}

function allOutputs(model: AnalyticsModel): {
  homes: HomeAnalyticsRollup[];
  projects: ReturnType<AnalyticsModel["project"]>[];
  groups: ReturnType<AnalyticsModel["groups"]>[];
} {
  const homes = RANGE_KEYS.map((range) => model.home(range, NOW));
  const projects = RANGE_KEYS.flatMap((range) =>
    PROJECT_IDS.map((projectId) => model.project(projectId, range, NOW)),
  );
  return { homes, projects, groups: allGroupOutputs(model) };
}

function expectSameModelOutputs(actual: AnalyticsModel, expected: AnalyticsModel): void {
  expect(allOutputs(actual)).toEqual(allOutputs(expected));
  expect(actual.ownedStepCount()).toBe(expected.ownedStepCount());
  expect(actual.earliestActivityMs()).toBe(expected.earliestActivityMs());
}

describe("analytics model: deterministic fork ownership", () => {
  it("keeps max multiplicity and promotes the next owner on removal", () => {
    const sessions = [
      sessionInfo("ses_parent", "p1"),
      sessionInfo("ses_fork_a", "p1"),
      sessionInfo("ses_fork_b", "p2"),
    ];
    const completedAtMs = NOW_HOUR - 4 * HOUR;
    const copies = [
      row({
        sessionID: "ses_parent",
        messageID: "msg_p1",
        completedAtMs,
        tokens: { input: 100 },
        cost: 7,
      }),
      row({
        sessionID: "ses_parent",
        messageID: "msg_p2",
        completedAtMs,
        tokens: { input: 100 },
        cost: 7,
      }),
      row({
        sessionID: "ses_fork_a",
        messageID: "msg_a1",
        completedAtMs,
        tokens: { input: 100 },
        cost: 7,
      }),
      row({
        sessionID: "ses_fork_a",
        messageID: "msg_a2",
        completedAtMs,
        tokens: { input: 100 },
        cost: 7,
      }),
      row({
        sessionID: "ses_fork_b",
        messageID: "msg_b",
        completedAtMs,
        tokens: { input: 100 },
        cost: 7,
      }),
    ];
    const [parent1, , forkA1, forkA2] = copies;
    const model = createModel(sessions, copies);

    // Two sessions carry the fingerprint twice, so multiplicity 2 is owned.
    expect(model.ownedStepCount()).toBe(2);
    expect(model.home("24h", NOW).usage.totals.input).toBe(200);
    expect(model.home("24h", NOW).usage.stepCount).toBe(2);

    // Removing one owned copy leaves the other copy plus the parent promotion.
    model.apply([], [forkA1]);
    expect(model.ownedStepCount()).toBe(2);
    expect(model.home("24h", NOW).usage.totals.input).toBe(200);

    // Dropping the second fork copy promotes both remaining parent rows.
    model.apply([], [forkA2]);
    expect(model.ownedStepCount()).toBe(2);
    expect(model.home("24h", NOW).usage.totals.input).toBe(200);

    // Finally, one parent copy is owned as a singleton group.
    model.apply([], [parent1]);
    expect(model.ownedStepCount()).toBe(1);
    expect(model.home("24h", NOW).usage.totals.input).toBe(100);
    expect(model.home("24h", NOW).usage.stepCount).toBe(1);
  });

  it("selects the same owners regardless of read order and preserves multiplicity", () => {
    const sessions = [sessionInfo("ses_parent", "p1"), sessionInfo("ses_fork", "p2")];
    const completedAtMs = NOW_HOUR - 3 * HOUR;
    const copies = [
      row({
        sessionID: "ses_parent",
        messageID: "msg_p1",
        completedAtMs,
        tokens: { input: 10 },
        cost: 1,
      }),
      row({
        sessionID: "ses_parent",
        messageID: "msg_p2",
        completedAtMs,
        tokens: { input: 10 },
        cost: 1,
      }),
      row({
        sessionID: "ses_fork",
        messageID: "msg_f1",
        completedAtMs,
        tokens: { input: 10 },
        cost: 1,
      }),
      row({
        sessionID: "ses_fork",
        messageID: "msg_f2",
        completedAtMs,
        tokens: { input: 10 },
        cost: 1,
      }),
      row({
        sessionID: "ses_fork",
        messageID: "msg_f3",
        completedAtMs,
        tokens: { input: 10 },
        cost: 1,
      }),
    ];
    const forward = createModel(sessions, copies);
    const reversed = createModel(sessions, [...copies].reverse());

    expect(forward.ownedStepCount()).toBe(3);
    expect(reversed.ownedStepCount()).toBe(3);
    expectSameModelOutputs(forward, reversed);
  });
});

describe("analytics model: incremental upserts", () => {
  it("keeps counts, cost, and every range unchanged on a repeated upsert", () => {
    const sessions = [sessionInfo("ses_a", "p1"), sessionInfo("ses_b", "p2")];
    const rows = [
      row({
        sessionID: "ses_a",
        messageID: "msg_a1",
        completedAtMs: NOW_HOUR - 2 * HOUR,
        tokens: { input: 10, output: 2 },
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_a2",
        completedAtMs: NOW_HOUR - 20 * HOUR,
        tokens: { input: 20, cacheRead: 3 },
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_b1",
        completedAtMs: NOW - 30 * HOUR,
        tokens: { input: 30, output: 4 },
        providerID: "no-such-provider",
        modelID: "no-such-model",
      }),
    ];
    const model = createModel(sessions, rows);
    const before = allOutputs(model);
    const beforeCount = model.ownedStepCount();
    const beforeEarliest = model.earliestActivityMs();
    const beforeCost = model.home("30d", NOW).usage.totals.apiEquivalentCostUsd;

    model.apply(
      rows.map((entry) => ({ ...entry, tokens: { ...entry.tokens } })),
      [],
    );

    expect(allOutputs(model)).toEqual(before);
    expect(model.ownedStepCount()).toBe(beforeCount);
    expect(model.earliestActivityMs()).toBe(beforeEarliest);
    expect(model.home("30d", NOW).usage.totals.apiEquivalentCostUsd).toBe(beforeCost);
  });

  it("keeps a reassigned session in its new project across an unchanged upsert", () => {
    const sessions = [sessionInfo("ses_a", "p1"), sessionInfo("ses_b", "p1")];
    const rowA = row({
      sessionID: "ses_a",
      messageID: "msg_a",
      completedAtMs: NOW_HOUR - 2 * HOUR,
      tokens: { input: 11 },
    });
    const rowB = row({
      sessionID: "ses_b",
      messageID: "msg_b",
      completedAtMs: NOW_HOUR - 2 * HOUR,
      tokens: { input: 22 },
    });
    const model = createModel(sessions, [rowA, rowB]);

    expect(model.home("24h", NOW).usage.totals.input).toBe(33);
    const moved = metadata([sessionInfo("ses_a", "p2"), sessionInfo("ses_b", "p1")]);
    model.setMetadata(moved.sessions, moved.projects);

    const p1 = model.project("p1", "24h", NOW);
    const p2 = model.project("p2", "24h", NOW);
    expect(p1.totals.input).toBe(22);
    expect(p2.totals.input).toBe(11);

    // An unchanged re-upsert must not detach the moved canonical object and
    // resurrect the old project assignment.
    model.apply([{ ...rowA, tokens: { ...rowA.tokens } }], []);

    expect(model.project("p1", "24h", NOW).totals.input).toBe(22);
    expect(model.project("p2", "24h", NOW).totals.input).toBe(11);
    expect(
      model.home("24h", NOW).projects.find((entry) => entry.projectId === "p2")?.tokens.input,
    ).toBe(11);
  });

  it("recomputes an edited fingerprint and releases a fully removed one", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const original = row({
      sessionID: "ses_a",
      messageID: "msg_a",
      completedAtMs: NOW_HOUR - 2 * HOUR,
      tokens: { input: 100 },
    });
    const model = createModel(sessions, [original]);

    expect(model.home("24h", NOW).usage.totals.input).toBe(100);
    expect(model.home("24h", NOW).usage.totals.apiEquivalentCostUsd).not.toBeNull();

    const edited = row({
      sessionID: "ses_a",
      messageID: "msg_a",
      completedAtMs: original.completedAtMs,
      tokens: { input: 40 },
      providerID: "no-such-provider",
      modelID: "no-such-model",
    });
    model.apply([edited], [original]);

    expect(model.ownedStepCount()).toBe(1);
    expect(model.home("24h", NOW).usage.totals.input).toBe(40);
    expect(model.home("24h", NOW).usage.totals.unknownTokens).toBe(40);
    expect(model.home("24h", NOW).usage.totals.apiEquivalentCostUsd).toBeNull();

    model.apply([], [edited]);
    expect(model.ownedStepCount()).toBe(0);
    expect(model.home("24h", NOW).usage.totals.input).toBe(0);
    expect(model.home("24h", NOW).usage.stepCount).toBe(0);
    expect(model.home("24h", NOW).usage.buckets.every((bucket) => bucket.tokens.total === 0)).toBe(
      true,
    );
  });
});

describe("analytics model: hour boundaries and extrema", () => {
  it("assigns rows at exact hour boundaries and excludes the window end", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const hourStart = NOW_HOUR - 2 * HOUR;
    const rows = [
      row({
        sessionID: "ses_a",
        messageID: "msg_start",
        completedAtMs: hourStart,
        tokens: { input: 1 },
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_last",
        completedAtMs: hourStart + HOUR - 1,
        tokens: { input: 2 },
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_next",
        completedAtMs: hourStart + HOUR,
        tokens: { input: 4 },
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_end",
        completedAtMs: NOW,
        tokens: { input: 8 },
      }),
    ];
    const model = createModel(sessions, rows);
    const usage = model.home("24h", NOW).usage;

    expect(usage.buckets).toHaveLength(24);
    expect(usage.buckets.find((bucket) => bucket.startMs === hourStart)?.tokens.input).toBe(3);
    expect(usage.buckets.find((bucket) => bucket.startMs === hourStart + HOUR)?.tokens.input).toBe(
      4,
    );
    // The window is half-open, so a row completed exactly at now is excluded.
    expect(usage.totals.input).toBe(7);
    expect(usage.stepCount).toBe(3);
  });

  it("tracks the earliest step and the latest activity for scoped views", () => {
    const sessions = [
      sessionInfo("ses_a", "p1", {
        time: { created: NOW - 10 * HOUR, updated: NOW - 9 * HOUR },
      }),
    ];
    const earliest = row({
      sessionID: "ses_a",
      messageID: "msg_oldest",
      completedAtMs: NOW - 30 * HOUR,
      tokens: { input: 1 },
    });
    const recent = row({
      sessionID: "ses_a",
      messageID: "msg_recent",
      completedAtMs: NOW - 2 * HOUR,
      tokens: { input: 2 },
    });
    const model = createModel(sessions, [recent, earliest]);

    expect(model.earliestActivityMs()).toBe(NOW - 30 * HOUR);
    expect(model.project("p1", "24h", NOW).roots[0]?.latestActivityAtMs).toBe(NOW - 2 * HOUR);
    expect(
      model.home("24h", NOW).projects.find((entry) => entry.projectId === "p1")?.latestActivityAtMs,
    ).toBe(NOW - 2 * HOUR);

    // Removing the oldest step falls back to session metadata time.
    model.apply([], [earliest]);
    expect(model.earliestActivityMs()).toBe(NOW - 10 * HOUR);
  });
});

describe("analytics model: grouped lifetime bucket origins", () => {
  it("starts lifetime grouped buckets at the earliest positive owned step, not metadata", () => {
    const sessions = [
      sessionInfo("ses_a", "p1", {
        time: { created: NOW - 120 * DAY, updated: NOW - 110 * DAY },
      }),
    ];
    const zeroAt = NOW - 60 * DAY;
    const olderAt = NOW - 30 * DAY;
    const newerAt = NOW - 2 * DAY;
    // Zero-token rows carry no owned usage and must not anchor the range.
    const zeroRow = row({
      sessionID: "ses_a",
      messageID: "msg_zero_anchor",
      completedAtMs: zeroAt,
      tokens: {},
      providerID: "p-zero",
      modelID: "zero-only",
    });
    const olderRow = row({
      sessionID: "ses_a",
      messageID: "msg_older_anchor",
      completedAtMs: olderAt,
      tokens: { input: 10 },
      providerID: "p-old",
      modelID: "old-model",
    });
    const newerRow = row({
      sessionID: "ses_a",
      messageID: "msg_newer_anchor",
      completedAtMs: newerAt,
      tokens: { input: 20 },
      providerID: "p-new",
      modelID: "new-model",
    });
    const model = createModel(sessions, [zeroRow, olderRow, newerRow]);

    // Public activity and Home lifetime still include session metadata; only
    // the grouped range anchors on positive owned usage.
    expect(model.earliestActivityMs()).toBe(NOW - 120 * DAY);
    expect(model.home("lifetime", NOW).usage.buckets[0]?.startMs).toBe(
      utcDayStart(NOW - 120 * DAY),
    );

    const lifetime = model.groups({ range: "lifetime", dimension: "model" }, NOW);
    // Session metadata reaches back 120 days; the chart starts at 30 days.
    expect(lifetime.buckets[0]?.startMs).toBe(utcDayStart(olderAt));
    expect(lifetime.window).toEqual({ untilMs: NOW });
    expect(lifetime.totals.input).toBe(30);
    expect(lifetime.stepCount).toBe(2);
    expect(lifetime.sessionCount).toBe(1);
    expect(lifetime.series.reduce((sum, series) => sum + series.tokens.total, 0)).toBe(30);

    for (const dimension of DIMENSIONS) {
      const global = model.groups({ range: "lifetime", dimension }, NOW);
      expect(global.buckets[0]?.startMs).toBe(utcDayStart(olderAt));
      expect(global.totals.input).toBe(30);
    }

    const olderOnly = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "model", identity: known("old-model") },
      },
      NOW,
    );
    expect(olderOnly.buckets[0]?.startMs).toBe(utcDayStart(olderAt));
    expect(olderOnly.totals.input).toBe(10);
    expect(olderOnly.series.reduce((sum, series) => sum + series.tokens.total, 0)).toBe(10);

    // The exact filter's own earliest positive owned step anchors the detail
    // range, independent of older models or session metadata.
    const newerOnly = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "model", identity: known("new-model") },
      },
      NOW,
    );
    expect(newerOnly.buckets[0]?.startMs).toBe(utcDayStart(newerAt));
    expect(newerOnly.totals.input).toBe(20);
    expect(newerOnly.stepCount).toBe(1);
    expect(newerOnly.series.reduce((sum, series) => sum + series.tokens.total, 0)).toBe(20);

    const newerProvider = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "provider", identity: known("p-new") },
      },
      NOW,
    );
    expect(newerProvider.buckets[0]?.startMs).toBe(utcDayStart(newerAt));
    expect(newerProvider.totals.input).toBe(20);

    const absent = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "model", identity: known("absent-model") },
      },
      NOW,
    );
    expect(absent.buckets).toEqual([{ startMs: utcDayStart(NOW), endMs: NOW }]);
    expect(absent.totals.total).toBe(0);
    expect(absent.stepCount).toBe(0);
    expect(absent.sessionCount).toBe(0);

    // Finite ranges keep their exact rolling-window boundaries.
    for (const range of ["24h", "7d", "30d"] as const) {
      const usage = model.home(range, NOW).usage;
      for (const dimension of DIMENSIONS) {
        const snapshot = model.groups({ range, dimension }, NOW);
        expect(snapshot.buckets).toEqual(
          usage.buckets.map((bucket) => ({ startMs: bucket.startMs, endMs: bucket.endMs })),
        );
        expect(snapshot.totals).toEqual(usage.totals);
      }
    }

    // Removing the anchoring owned step moves the start to the next oldest.
    model.apply([], [olderRow]);
    const afterRemoval = model.groups({ range: "lifetime", dimension: "model" }, NOW);
    expect(afterRemoval.buckets[0]?.startMs).toBe(utcDayStart(newerAt));
    expect(afterRemoval.totals.input).toBe(20);
    expect(afterRemoval.stepCount).toBe(1);
    expect(afterRemoval.series.reduce((sum, series) => sum + series.tokens.total, 0)).toBe(20);
  });

  it("anchors unknown-identity filtered lifetime buckets at the earliest owned unknown", () => {
    const sessions = [
      sessionInfo("ses_a", "p1", {
        time: { created: NOW - 120 * DAY, updated: NOW - 100 * DAY },
      }),
    ];
    const unknownAt = NOW - 20 * DAY;
    const unknownLatestAt = NOW - DAY;
    const knownAt = NOW - 40 * DAY;
    const model = createModel(sessions, [
      row({
        sessionID: "ses_a",
        messageID: "msg_unknown_early",
        completedAtMs: unknownAt,
        tokens: { input: 10 },
        providerID: undefined,
        modelID: undefined,
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_unknown_late",
        completedAtMs: unknownLatestAt,
        tokens: { input: 20 },
        providerID: undefined,
        modelID: undefined,
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_known_older",
        completedAtMs: knownAt,
        tokens: { input: 30 },
        providerID: "known-provider",
        modelID: "known-model",
      }),
    ]);

    // The unknown identity is exact on either filter dimension, including the
    // opposite-dimension detail shape. The older known row never anchors it.
    for (const query of [
      {
        range: "lifetime" as const,
        dimension: "model" as const,
        filter: { dimension: "model" as const, identity: UNKNOWN_IDENTITY },
      },
      {
        range: "lifetime" as const,
        dimension: "provider" as const,
        filter: { dimension: "provider" as const, identity: UNKNOWN_IDENTITY },
      },
      {
        range: "lifetime" as const,
        dimension: "model" as const,
        filter: { dimension: "provider" as const, identity: UNKNOWN_IDENTITY },
      },
    ]) {
      const snapshot = model.groups(query, NOW);
      expect(snapshot.filter).toEqual(query.filter);
      expect(snapshot.buckets[0]?.startMs).toBe(utcDayStart(unknownAt));
      expect(snapshot.totals.input).toBe(30);
      expect(snapshot.stepCount).toBe(2);
      expect(snapshot.sessionCount).toBe(1);
      expect(snapshot.series.reduce((sum, series) => sum + series.tokens.total, 0)).toBe(30);
      expect(snapshot.rows.every((entry) => entry.identity.kind === "unknown")).toBe(true);
    }

    const knownOnly = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "model", identity: known("known-model") },
      },
      NOW,
    );
    expect(knownOnly.buckets[0]?.startMs).toBe(utcDayStart(knownAt));
    expect(knownOnly.totals.input).toBe(30);

    const global = model.groups({ range: "lifetime", dimension: "model" }, NOW);
    expect(global.buckets[0]?.startMs).toBe(utcDayStart(knownAt));
    expect(global.totals.input).toBe(60);
  });

  it("keeps lifetime origin exact across fork owner promotion and removal", () => {
    const sessions = [
      sessionInfo("ses_parent", "p1", {
        time: { created: NOW - 120 * DAY, updated: NOW - 100 * DAY },
      }),
      sessionInfo("ses_fork", "p1", {
        time: { created: NOW - 120 * DAY, updated: NOW - 100 * DAY },
      }),
    ];
    const forkAt = NOW - 30 * DAY;
    const laterAt = NOW - 2 * DAY;
    // Identical fork copies: one owner is selected by deterministic tie-break.
    const forkCopyA = row({
      sessionID: "ses_parent",
      messageID: "msg_fork_a",
      completedAtMs: forkAt,
      tokens: { input: 10 },
      providerID: "p-fork",
      modelID: "m-fork",
    });
    const forkCopyB = row({
      sessionID: "ses_fork",
      messageID: "msg_fork_b",
      completedAtMs: forkAt,
      tokens: { input: 10 },
      providerID: "p-fork",
      modelID: "m-fork",
    });
    const later = row({
      sessionID: "ses_fork",
      messageID: "msg_after_fork",
      completedAtMs: laterAt,
      tokens: { input: 5 },
      providerID: "p-later",
      modelID: "m-later",
    });
    const model = createModel(sessions, [forkCopyA, forkCopyB, later]);

    expect(model.ownedStepCount()).toBe(2);
    const initial = model.groups({ range: "lifetime", dimension: "model" }, NOW);
    expect(initial.buckets[0]?.startMs).toBe(utcDayStart(forkAt));
    expect(initial.totals.input).toBe(15);
    expect(initial.stepCount).toBe(2);

    // Removing the owner promotes the other copy at the same instant: totals
    // and the bucket origin must stay unchanged, not fall through to "later".
    model.apply([], [forkCopyA]);
    expect(model.ownedStepCount()).toBe(2);
    const promoted = model.groups({ range: "lifetime", dimension: "model" }, NOW);
    expect(promoted.buckets[0]?.startMs).toBe(utcDayStart(forkAt));
    expect(promoted.totals.input).toBe(15);
    expect(promoted.stepCount).toBe(2);
    const promotedFork = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "model", identity: known("m-fork") },
      },
      NOW,
    );
    expect(promotedFork.buckets[0]?.startMs).toBe(utcDayStart(forkAt));
    expect(promotedFork.totals.input).toBe(10);

    // Removing the last owned copy of the old fingerprint advances the origin
    // to the next positive owned step.
    model.apply([], [forkCopyB]);
    expect(model.ownedStepCount()).toBe(1);
    const afterForkRemoval = model.groups({ range: "lifetime", dimension: "model" }, NOW);
    expect(afterForkRemoval.buckets[0]?.startMs).toBe(utcDayStart(laterAt));
    expect(afterForkRemoval.totals.input).toBe(5);
    expect(afterForkRemoval.stepCount).toBe(1);

    const absentFork = model.groups(
      {
        range: "lifetime",
        dimension: "model",
        filter: { dimension: "model", identity: known("m-fork") },
      },
      NOW,
    );
    expect(absentFork.buckets).toEqual([{ startMs: utcDayStart(NOW), endMs: NOW }]);
    expect(absentFork.totals.total).toBe(0);
  });
});

describe("analytics model: price status", () => {
  afterEach(() => {
    __resetTemporalSnapshotForTests();
  });

  it("keeps priced, unpriced, unknown, and zero-token rows distinct", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const priced = row({
      sessionID: "ses_a",
      messageID: "msg_priced",
      completedAtMs,
      tokens: { input: 10 },
    });
    const priced2 = row({
      sessionID: "ses_a",
      messageID: "msg_priced_2",
      completedAtMs,
      tokens: { input: 20 },
    });
    const unpriced = row({
      sessionID: "ses_a",
      messageID: "msg_unpriced",
      completedAtMs,
      tokens: { input: 30 },
      providerID: "unpriced-labs",
      modelID: "mystery-1",
    });
    const unknown = row({
      sessionID: "ses_a",
      messageID: "msg_unknown",
      completedAtMs,
      tokens: { input: 40 },
      providerID: "no-such-provider",
      modelID: "no-such-model",
    });
    const zero = row({
      sessionID: "ses_a",
      messageID: "msg_zero",
      completedAtMs,
      tokens: {},
    });
    const model = createModel(sessions, [priced, priced2, unpriced, unknown, zero]);
    const totals = model.home("24h", NOW).usage.totals;

    expect(totals.input).toBe(100);
    expect(totals.apiEquivalentCostUsd).not.toBeNull();
    expect(totals.apiEquivalentCostUsd).toBeGreaterThan(0);
    expect(totals.unpricedTokens).toBe(30);
    expect(totals.unknownTokens).toBe(40);

    model.apply([], [priced, priced2, zero]);
    const onlyUnpricedAndUnknown = model.home("24h", NOW).usage.totals;
    expect(onlyUnpricedAndUnknown.apiEquivalentCostUsd).toBeNull();
    expect(onlyUnpricedAndUnknown.unpricedTokens).toBe(30);
    expect(onlyUnpricedAndUnknown.unknownTokens).toBe(40);
    expect(
      model
        .home("24h", NOW)
        .usage.buckets.every((bucket) => bucket.tokens.apiEquivalentCostUsd === null),
    ).toBe(true);
  });

  it("prices each physical row at its assistant completion instant", () => {
    setTemporalSnapshotForTests(
      normalizeTemporalSnapshot({
        version: 1,
        revision: TEMPORAL_REVISION,
        source: `https://github.com/anomalyco/models.dev/tree/${TEMPORAL_REVISION}`,
        generatedAt: NOW,
        jurisdictions: { CN: { "2026": CN_2026 } },
        providers: {
          [TEMPORAL_TEST_PROVIDER]: {
            [TEMPORAL_TEST_MODEL]: {
              status: "supported",
              source: "providers/temporal-labs/models/peak-1.toml",
              overrides: [],
              multipliers: [
                {
                  id: "multipliers[0]",
                  when: { type: "utc_hours", op: "gte", value: "10:00" },
                  factor: 2,
                },
              ],
            },
          },
        },
      }),
    );

    const sessions = [sessionInfo("ses_a", "p1")];
    const model = createModel(sessions, [
      row({
        sessionID: "ses_a",
        messageID: "msg_off_peak",
        completedAtMs: NOW_HOUR - 6 * HOUR,
        tokens: { input: 1_000_000 },
        providerID: TEMPORAL_TEST_PROVIDER,
        modelID: TEMPORAL_TEST_MODEL,
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_peak",
        completedAtMs: NOW_HOUR - 30 * 60_000,
        tokens: { input: 1_000_000 },
        providerID: TEMPORAL_TEST_PROVIDER,
        modelID: TEMPORAL_TEST_MODEL,
      }),
    ]);

    const totals = model.home("24h", NOW).usage.totals;
    expect(totals.input).toBe(2_000_000);
    expect(totals.apiEquivalentCostUsd).toBeCloseTo(3, 10);
  });
});

type GroupSnapshot = ReturnType<AnalyticsModel["groups"]>;
type GroupRow = GroupSnapshot["rows"][number];
type GroupIdentity = GroupRow["identity"];

function known(id: string): GroupIdentity {
  return { kind: "known", id };
}

const UNKNOWN_IDENTITY: GroupIdentity = { kind: "unknown" };

function rawIdentityOf(identity: GroupIdentity): string | undefined {
  return identity.kind === "known" ? identity.id : undefined;
}

function findGroupRow(rows: readonly GroupRow[], identity: GroupIdentity): GroupRow | undefined {
  return rows.find((row) => rawIdentityOf(row.identity) === rawIdentityOf(identity));
}

function flattenGroupRows(rows: readonly GroupRow[]): GroupRow[] {
  return rows.flatMap((row) => [row, ...flattenGroupRows(row.children)]);
}

function seriesBucketInput(series: readonly GroupSnapshot["series"][number]): number {
  return series.reduce(
    (sum, entry) => sum + entry.buckets.reduce((total, b) => total + b.input, 0),
    0,
  );
}

function seriesIdentity(series: GroupSnapshot["series"][number]): GroupIdentity | null {
  return series.kind === "entity" ? series.identity : null;
}

function bucketAt(snapshot: GroupSnapshot, completedAtMs: number): number {
  return snapshot.buckets.findIndex(
    (bucket) => completedAtMs >= bucket.startMs && completedAtMs < bucket.endMs,
  );
}

interface BucketShare {
  identity: GroupIdentity;
  tokens: CostedTokens;
}

function shareKey(share: BucketShare): string {
  return share.identity.kind === "unknown" ? "unknown" : `known:${share.identity.id}`;
}

/**
 * In-bar subdivision is additive: every category, numeric cost, unpriced count
 * and unknown count in a bucket equals the sum of its exact share entries.
 * Exact identities are unique inside one bucket (no cross-product rows).
 */
function expectSharesConserve(
  totals: CostedTokens,
  buckets: readonly CostedTokens[],
  shares: readonly (readonly BucketShare[])[] | undefined,
): void {
  expect(shares).toHaveLength(buckets.length);
  const shareBuckets = shares ?? [];
  buckets.forEach((bucket, bucketIndex) => {
    const entries = shareBuckets[bucketIndex] ?? [];
    expect(new Set(entries.map(shareKey)).size).toBe(entries.length);
    expect(entries.reduce((sum, entry) => sum + entry.tokens.input, 0)).toBe(bucket.input);
    expect(entries.reduce((sum, entry) => sum + entry.tokens.cacheRead, 0)).toBe(bucket.cacheRead);
    expect(entries.reduce((sum, entry) => sum + entry.tokens.cacheWrite, 0)).toBe(
      bucket.cacheWrite,
    );
    expect(entries.reduce((sum, entry) => sum + entry.tokens.output, 0)).toBe(bucket.output);
    expect(entries.reduce((sum, entry) => sum + entry.tokens.reasoning, 0)).toBe(bucket.reasoning);
    expect(entries.reduce((sum, entry) => sum + entry.tokens.total, 0)).toBe(bucket.total);
    expect(entries.reduce((sum, entry) => sum + entry.tokens.unpricedTokens, 0)).toBe(
      bucket.unpricedTokens,
    );
    expect(entries.reduce((sum, entry) => sum + entry.tokens.unknownTokens, 0)).toBe(
      bucket.unknownTokens,
    );
    const costs = entries.flatMap((entry) =>
      entry.tokens.apiEquivalentCostUsd === null ? [] : [entry.tokens.apiEquivalentCostUsd],
    );
    if (bucket.apiEquivalentCostUsd === null) {
      expect(costs).toEqual([]);
    } else {
      expect(costs.length).toBeGreaterThan(0);
      expect(costs.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(
        bucket.apiEquivalentCostUsd,
        12,
      );
    }
  });

  const allShares = shareBuckets.flat();
  expect(allShares.reduce((sum, entry) => sum + entry.tokens.total, 0)).toBe(totals.total);
  expect(allShares.reduce((sum, entry) => sum + entry.tokens.unpricedTokens, 0)).toBe(
    totals.unpricedTokens,
  );
  expect(allShares.reduce((sum, entry) => sum + entry.tokens.unknownTokens, 0)).toBe(
    totals.unknownTokens,
  );
  const allCosts = allShares.flatMap((entry) =>
    entry.tokens.apiEquivalentCostUsd === null ? [] : [entry.tokens.apiEquivalentCostUsd],
  );
  if (totals.apiEquivalentCostUsd === null) {
    expect(allCosts).toEqual([]);
  } else {
    expect(allCosts.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(
      totals.apiEquivalentCostUsd,
      12,
    );
  }
}

function expectChildBucketsConserve(series: GroupSnapshot["series"][number]): void {
  expectSharesConserve(series.tokens, series.buckets, series.childBuckets);
}

function expectParentBucketsConserve(series: {
  tokens: CostedTokens;
  buckets: CostedTokens[];
  parentBuckets?: readonly (readonly BucketShare[])[];
}): void {
  expectSharesConserve(series.tokens, series.buckets, series.parentBuckets);
}

/** Serialized size with and without the additive Other parent breakdown. */
function parentBucketsSerializedSize(snapshot: GroupSnapshot): {
  beforeBytes: number;
  afterBytes: number;
} {
  const before = JSON.stringify({
    ...snapshot,
    series: snapshot.series.map((series) => {
      const rest = { ...series } as Record<string, unknown>;
      delete rest.parentBuckets;
      return rest;
    }),
  });
  const after = JSON.stringify(snapshot);
  return { beforeBytes: Buffer.byteLength(before), afterBytes: Buffer.byteLength(after) };
}

describe("analytics model: grouped model and provider identities", () => {
  it("keeps colliding provider/model pairs distinct in both insertion orders", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const priced = row({
      sessionID: "ses_a",
      messageID: "msg_priced_edge",
      completedAtMs,
      tokens: { input: 10 },
      providerID: "edge-labs",
      modelID: "dual|||model",
    });
    const colliding = row({
      sessionID: "ses_a",
      messageID: "msg_colliding_edge",
      completedAtMs,
      tokens: { input: 5 },
      providerID: "edge-labs|||dual",
      modelID: "model",
    });
    const forward = createModel(sessions, [priced, colliding]);
    const reverse = createModel(sessions, [colliding, priced]);

    // A `|||` cache or rollup key would make one order price and the other
    // classify this pair as unknown.
    expect(allGroupOutputs(forward)).toEqual(allGroupOutputs(reverse));

    const byModel = forward.groups({ range: "24h", dimension: "model" }, NOW);
    const pricedRow = findGroupRow(byModel.rows, known("dual|||model"));
    expect(pricedRow?.tokens.input).toBe(10);
    expect(pricedRow?.children.map((child) => child.identity)).toEqual([known("edge-labs")]);
    expect(pricedRow?.children[0]?.tokens.input).toBe(10);

    const collidingRow = findGroupRow(byModel.rows, known("model"));
    expect(collidingRow?.tokens.input).toBe(5);
    expect(collidingRow?.children.map((child) => child.identity)).toEqual([
      known("edge-labs|||dual"),
    ]);
    expect(byModel.totals.input).toBe(15);
    expect(byModel.totals.unknownTokens).toBe(5);
    expect(byModel.totals).toEqual(forward.home("24h", NOW).usage.totals);

    const pricedOnly = createModel(sessions, [priced]);
    expect(byModel.totals.apiEquivalentCostUsd).toBe(
      pricedOnly.home("24h", NOW).usage.totals.apiEquivalentCostUsd,
    );

    const byProvider = forward.groups({ range: "24h", dimension: "provider" }, NOW);
    expect(findGroupRow(byProvider.rows, known("edge-labs"))?.tokens.input).toBe(10);
    expect(findGroupRow(byProvider.rows, known("edge-labs|||dual"))?.tokens.input).toBe(5);
  });

  it("separates missing, empty, and whitespace raw identities on both dimensions", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const missing = row({
      sessionID: "ses_a",
      messageID: "msg_missing",
      completedAtMs,
      tokens: { input: 7 },
      providerID: undefined,
      modelID: undefined,
    });
    const empty = row({
      sessionID: "ses_a",
      messageID: "msg_empty",
      completedAtMs,
      tokens: { input: 11 },
      providerID: "",
      modelID: "",
    });
    const spaced = row({
      sessionID: "ses_a",
      messageID: "msg_spaced",
      completedAtMs,
      tokens: { input: 13 },
      providerID: " ",
      modelID: " ",
    });
    const model = createModel(sessions, [missing, empty, spaced]);

    for (const dimension of DIMENSIONS) {
      const snapshot = model.groups({ range: "24h", dimension }, NOW);
      expect(snapshot.rows.map((row) => row.identity)).toEqual([
        known(" "),
        known(""),
        UNKNOWN_IDENTITY,
      ]);
      expect(findGroupRow(snapshot.rows, UNKNOWN_IDENTITY)?.tokens.input).toBe(7);
      expect(findGroupRow(snapshot.rows, known(""))?.tokens.input).toBe(11);
      expect(findGroupRow(snapshot.rows, known(" "))?.tokens.input).toBe(13);
      expect(snapshot.totals.input).toBe(31);
      expect(snapshot.totals).toEqual(model.home("24h", NOW).usage.totals);
      expect(snapshot.sessionCount).toBe(1);

      // Child buckets keep the same exact identities: missing is not empty.
      for (const series of snapshot.series) expectChildBucketsConserve(series);
      const bucketIndex = bucketAt(snapshot, completedAtMs);
      expect(bucketIndex).toBeGreaterThanOrEqual(0);
      expect(
        snapshot.series.flatMap((series) => series.childBuckets?.[bucketIndex] ?? []),
      ).toMatchObject([
        { identity: known(" "), tokens: { input: 13 } },
        { identity: known(""), tokens: { input: 11 } },
        { identity: UNKNOWN_IDENTITY, tokens: { input: 7 } },
      ]);
    }

    const filteredEmpty = model.groups(
      { range: "24h", dimension: "model", filter: { dimension: "model", identity: known("") } },
      NOW,
    );
    expect(filteredEmpty.rows).toHaveLength(1);
    expect(filteredEmpty.rows[0]?.identity).toEqual(known(""));
    expect(filteredEmpty.rows[0]?.tokens.input).toBe(11);
    expect(filteredEmpty.rows[0]?.children.map((child) => child.identity)).toEqual([known("")]);
    expect(filteredEmpty.totals).toEqual(filteredEmpty.rows[0]?.tokens);

    const filteredUnknown = model.groups(
      {
        range: "24h",
        dimension: "provider",
        filter: { dimension: "provider", identity: UNKNOWN_IDENTITY },
      },
      NOW,
    );
    expect(filteredUnknown.rows).toHaveLength(1);
    expect(filteredUnknown.rows[0]?.identity).toEqual(UNKNOWN_IDENTITY);
    expect(filteredUnknown.rows[0]?.tokens.input).toBe(7);
    expect(filteredUnknown.totals.input).toBe(7);

    // Filtering by the opposite entity kind selects the grouping rows for
    // that entity (the Model/Provider detail query shape).
    const unknownModelDetail = model.groups(
      {
        range: "24h",
        dimension: "provider",
        filter: { dimension: "model", identity: UNKNOWN_IDENTITY },
      },
      NOW,
    );
    expect(unknownModelDetail.rows.map((grouped) => grouped.identity)).toEqual([UNKNOWN_IDENTITY]);
    expect(unknownModelDetail.rows[0]?.tokens.input).toBe(7);
    expect(unknownModelDetail.rows[0]?.children.map((child) => child.identity)).toEqual([
      UNKNOWN_IDENTITY,
    ]);
    expect(unknownModelDetail.totals.input).toBe(7);
    expect(unknownModelDetail.series.map(seriesIdentity)).toEqual([UNKNOWN_IDENTITY]);

    const absent = model.groups(
      {
        range: "24h",
        dimension: "model",
        filter: { dimension: "model", identity: known("absent") },
      },
      NOW,
    );
    expect(absent.filter).toEqual({ dimension: "model", identity: known("absent") });
    expect(absent.rows).toEqual([]);
    expect(absent.totals.total).toBe(0);
    expect(absent.totals.apiEquivalentCostUsd).toBeNull();
    expect(absent.sessionCount).toBe(0);
    expect(absent.stepCount).toBe(0);
    expect(absent.series).toEqual([]);
  });

  it("groups one model across providers and one provider across models", () => {
    const sessions = [sessionInfo("ses_a", "p1"), sessionInfo("ses_b", "p2")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const rows = [
      row({
        sessionID: "ses_a",
        messageID: "msg_shared_a",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "provider-a",
        modelID: "shared-model",
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_shared_b",
        completedAtMs,
        tokens: { input: 20 },
        providerID: "provider-b",
        modelID: "shared-model",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_model_a",
        completedAtMs,
        tokens: { input: 30 },
        providerID: "shared-provider",
        modelID: "model-a",
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_model_b",
        completedAtMs,
        tokens: { input: 40 },
        providerID: "shared-provider",
        modelID: "model-b",
      }),
    ];
    const model = createModel(sessions, rows);

    const byModel = model.groups({ range: "24h", dimension: "model" }, NOW);
    const sharedModel = findGroupRow(byModel.rows, known("shared-model"));
    expect(sharedModel?.tokens.input).toBe(30);
    expect(sharedModel?.sessionCount).toBe(2);
    expect(sharedModel?.children.map((child) => rawIdentityOf(child.identity))).toEqual([
      "provider-b",
      "provider-a",
    ]);

    const byProvider = model.groups({ range: "24h", dimension: "provider" }, NOW);
    const sharedProvider = findGroupRow(byProvider.rows, known("shared-provider"));
    expect(sharedProvider?.tokens.input).toBe(70);
    expect(sharedProvider?.sessionCount).toBe(2);
    expect(sharedProvider?.children.map((child) => rawIdentityOf(child.identity))).toEqual([
      "model-b",
      "model-a",
    ]);
    expect(findGroupRow(byProvider.rows, known("provider-a"))?.children).toHaveLength(1);

    // Model detail: group by provider while filtering the selected model.
    const modelDetail = model.groups(
      {
        range: "24h",
        dimension: "provider",
        filter: { dimension: "model", identity: known("shared-model") },
      },
      NOW,
    );
    expect(modelDetail.filter).toEqual({
      dimension: "model",
      identity: known("shared-model"),
    });
    expect(modelDetail.rows.map((grouped) => grouped.identity)).toEqual([
      known("provider-b"),
      known("provider-a"),
    ]);
    expect(modelDetail.rows[0]?.children.map((child) => child.identity)).toEqual([
      known("shared-model"),
    ]);
    expect(modelDetail.totals.input).toBe(30);
    expect(modelDetail.series.map(seriesIdentity)).toEqual([
      known("provider-b"),
      known("provider-a"),
    ]);

    // Provider detail: group by model while filtering the selected provider.
    const providerDetail = model.groups(
      {
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: known("shared-provider") },
      },
      NOW,
    );
    expect(providerDetail.rows.map((grouped) => grouped.identity)).toEqual([
      known("model-b"),
      known("model-a"),
    ]);
    expect(providerDetail.totals.input).toBe(70);
    expect(providerDetail.series.map(seriesIdentity)).toEqual([known("model-b"), known("model-a")]);
  });

  it("counts a union of distinct owning sessions and keeps singleton children", () => {
    const sessions = [sessionInfo("ses_a", "p1"), sessionInfo("ses_b", "p2")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      row({
        sessionID: "ses_a",
        messageID: "msg_a1",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "p1",
        modelID: "m",
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_a2",
        completedAtMs,
        tokens: { input: 20 },
        providerID: "p1",
        modelID: "m",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_b1",
        completedAtMs,
        tokens: { input: 5 },
        providerID: "p2",
        modelID: "m",
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_solo",
        completedAtMs,
        tokens: { input: 7 },
        providerID: "p3",
        modelID: "solo",
      }),
    ]);

    const byModel = model.groups({ range: "24h", dimension: "model" }, NOW);
    const parent = findGroupRow(byModel.rows, known("m"));
    expect(parent?.stepCount).toBe(3);
    expect(parent?.sessionCount).toBe(2);
    expect(parent?.children.map((child) => rawIdentityOf(child.identity))).toEqual(["p1", "p2"]);
    expect(parent?.children[0]?.sessionCount).toBe(2);
    expect(parent?.children[1]?.sessionCount).toBe(1);
    // Sessions overlap across children, so the parent count is a set union.
    expect(parent?.children.reduce((sum, child) => sum + child.sessionCount, 0)).toBe(3);

    const solo = findGroupRow(byModel.rows, known("solo"));
    expect(solo?.children).toHaveLength(1);
    expect(solo?.children[0]?.identity).toEqual(known("p3"));

    const byProvider = model.groups({ range: "24h", dimension: "provider" }, NOW);
    const provider = findGroupRow(byProvider.rows, known("p1"));
    expect(provider?.sessionCount).toBe(2);
    expect(provider?.children).toHaveLength(1);
    expect(provider?.children[0]?.identity).toEqual(known("m"));
    expect(provider?.children[0]?.sessionCount).toBe(2);
  });

  it("matches Analytics totals, windows, and bucket boundaries on every range", () => {
    const sessions = [
      sessionInfo("ses_a", "p1"),
      sessionInfo("ses_b", "p1"),
      sessionInfo("ses_c", "p2"),
      sessionInfo("ses_d", "p2"),
    ];
    const rows = [
      row({
        sessionID: "ses_a",
        messageID: "msg_24h",
        completedAtMs: NOW - 2 * HOUR,
        tokens: { input: 10 },
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_7d",
        completedAtMs: NOW - 3 * 24 * HOUR,
        tokens: { input: 20 },
        providerID: "anthropic",
        modelID: "claude-sonnet-4-5",
      }),
      row({
        sessionID: "ses_c",
        messageID: "msg_30d",
        completedAtMs: NOW - 10 * 24 * HOUR,
        tokens: { input: 30 },
        providerID: "no-such-provider",
        modelID: "no-such-model",
      }),
      row({
        sessionID: "ses_d",
        messageID: "msg_lifetime",
        completedAtMs: NOW - 100 * 24 * HOUR,
        tokens: { input: 40 },
        providerID: "",
        modelID: "",
      }),
    ];
    const model = createModel(sessions, rows);

    for (const range of RANGE_KEYS) {
      const usage = model.home(range, NOW).usage;
      for (const dimension of DIMENSIONS) {
        const snapshot = model.groups({ range, dimension }, NOW);
        expect(snapshot.totals).toEqual(usage.totals);
        expect(snapshot.sessionCount).toBe(usage.sessionCount);
        expect(snapshot.stepCount).toBe(usage.stepCount);
        expect(snapshot.window).toEqual(usage.window);
        expect(snapshot.timeZone).toBe(usage.timeZone);
        expect(snapshot.bucketUnit).toBe(usage.bucketUnit);
        expect(snapshot.buckets).toEqual(
          usage.buckets.map((bucket) => ({ startMs: bucket.startMs, endMs: bucket.endMs })),
        );
        expect(snapshot.rows.reduce((sum, grouped) => sum + grouped.tokens.total, 0)).toBe(
          snapshot.totals.total,
        );
        for (const grouped of snapshot.rows) {
          expect(grouped.children.reduce((sum, child) => sum + child.tokens.total, 0)).toBe(
            grouped.tokens.total,
          );
        }
        // Breakdown rows and children intentionally carry totals only.
        for (const grouped of flattenGroupRows(snapshot.rows)) {
          expect("buckets" in grouped).toBe(false);
        }
        expect(snapshot.series.reduce((sum, series) => sum + series.tokens.total, 0)).toBe(
          snapshot.totals.total,
        );
        for (const series of snapshot.series) {
          expect(series.buckets).toHaveLength(snapshot.buckets.length);
          expect(series.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(
            series.tokens.total,
          );
          expectChildBucketsConserve(series);
        }
      }
    }
  });

  it("uses the configured host zone for grouped bucket boundaries", () => {
    const model = createAnalyticsModel({ timeZone: "Asia/Kathmandu" });
    const sessions = [sessionInfo("ses_a", "p1")];
    const records = metadata(sessions);
    model.setMetadata(records.sessions, records.projects);
    model.apply(
      [
        row({
          sessionID: "ses_a",
          messageID: "msg_zone",
          completedAtMs: NOW - 2 * HOUR,
          tokens: { input: 9 },
          modelID: "zone-model",
        }),
      ],
      [],
    );

    const usage = model.home("24h", NOW).usage;
    const snapshot = model.groups({ range: "24h", dimension: "model" }, NOW);
    expect(snapshot.timeZone).toBe("Asia/Kathmandu");
    expect(snapshot.buckets).toEqual(
      usage.buckets.map((bucket) => ({ startMs: bucket.startMs, endMs: bucket.endMs })),
    );
    // A +05:45 zone aligns interior hour starts to :15 UTC, not :00.
    expect(new Date(snapshot.buckets[1]?.startMs ?? 0).getUTCMinutes()).toBe(15);
    expect(findGroupRow(snapshot.rows, known("zone-model"))?.tokens.input).toBe(9);
    expect(snapshot.series[0]?.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(9);
  });

  it("deduplicates fork copies before grouping", () => {
    const sessions = [
      sessionInfo("ses_parent", "p1"),
      sessionInfo("ses_fork_a", "p1"),
      sessionInfo("ses_fork_b", "p2"),
    ];
    const completedAtMs = NOW_HOUR - 4 * HOUR;
    const copies = [
      row({ sessionID: "ses_parent", messageID: "msg_p1", completedAtMs, tokens: { input: 100 } }),
      row({ sessionID: "ses_fork_a", messageID: "msg_a1", completedAtMs, tokens: { input: 100 } }),
      row({ sessionID: "ses_fork_b", messageID: "msg_b1", completedAtMs, tokens: { input: 100 } }),
    ];
    const model = createModel(sessions, copies);

    for (const dimension of DIMENSIONS) {
      const snapshot = model.groups({ range: "24h", dimension }, NOW);
      expect(snapshot.rows).toHaveLength(1);
      expect(snapshot.rows[0]?.tokens.input).toBe(100);
      expect(snapshot.rows[0]?.stepCount).toBe(1);
      expect(snapshot.rows[0]?.sessionCount).toBe(1);
      expect(snapshot.stepCount).toBe(1);
      expect(snapshot.sessionCount).toBe(1);
    }
  });

  it("reflects identity edits and removals in grouped output", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const original = row({
      sessionID: "ses_a",
      messageID: "msg_edit",
      completedAtMs,
      tokens: { input: 40 },
      providerID: "p1",
      modelID: "old-model",
    });
    const keep = row({
      sessionID: "ses_a",
      messageID: "msg_keep",
      completedAtMs,
      tokens: { input: 10 },
      providerID: "p1",
      modelID: "keep-model",
    });
    const edited = row({
      sessionID: "ses_a",
      messageID: "msg_edit",
      completedAtMs,
      tokens: { input: 45 },
      providerID: "p2",
      modelID: "new-model",
    });
    const model = createModel(sessions, [original, keep]);
    model.apply([edited], [original]);

    const byModel = model.groups({ range: "24h", dimension: "model" }, NOW);
    expect(findGroupRow(byModel.rows, known("old-model"))).toBeUndefined();
    const moved = findGroupRow(byModel.rows, known("new-model"));
    expect(moved?.tokens.input).toBe(45);
    expect(moved?.children.map((child) => child.identity)).toEqual([known("p2")]);
    expect(findGroupRow(byModel.rows, known("keep-model"))?.tokens.input).toBe(10);
    expect(byModel.totals.input).toBe(55);

    const editedModel = createModel(sessions, [edited, keep]);
    expect(allGroupOutputs(model)).toEqual(allGroupOutputs(editedModel));

    model.apply([], [edited]);
    const afterRemoval = model.groups({ range: "24h", dimension: "model" }, NOW);
    expect(afterRemoval.rows.map((grouped) => grouped.identity)).toEqual([known("keep-model")]);
    expect(afterRemoval.totals.input).toBe(10);

    const removedLookup = model.groups(
      {
        range: "24h",
        dimension: "provider",
        filter: { dimension: "model", identity: known("new-model") },
      },
      NOW,
    );
    expect(removedLookup.rows).toEqual([]);
    expect(removedLookup.totals.total).toBe(0);
    expect(removedLookup.series).toEqual([]);
  });

  it("keeps partial pricing and valid zero costs distinct from null costs", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      row({
        sessionID: "ses_a",
        messageID: "msg_mixed_priced",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "mixed-labs",
        modelID: "priced-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_mixed_unpriced",
        completedAtMs,
        tokens: { input: 30 },
        providerID: "mixed-labs",
        modelID: "flat-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_zero_priced",
        completedAtMs,
        tokens: {},
        providerID: "zero-labs",
        modelID: "zero-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_zero_unpriced",
        completedAtMs,
        tokens: {},
        providerID: "unpriced-labs",
        modelID: "mystery-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_free_priced",
        completedAtMs,
        tokens: { input: 5 },
        providerID: "free-labs",
        modelID: "free-1",
      }),
    ]);

    const byProvider = model.groups({ range: "24h", dimension: "provider" }, NOW);
    const mixed = findGroupRow(byProvider.rows, known("mixed-labs"));
    expect(mixed?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(mixed?.tokens.unpricedTokens).toBe(30);
    expect(mixed?.tokens.unknownTokens).toBe(0);
    expect(
      findGroupRow(mixed?.children ?? [], known("priced-1"))?.tokens.apiEquivalentCostUsd,
    ).not.toBeNull();
    expect(
      findGroupRow(mixed?.children ?? [], known("flat-1"))?.tokens.apiEquivalentCostUsd,
    ).toBeNull();
    expect(findGroupRow(mixed?.children ?? [], known("flat-1"))?.tokens.unpricedTokens).toBe(30);

    // A priced model with zero rates is a valid zero estimate; zero-token rows
    // never create a group, an estimate, or unpriced/unknown accounting.
    expect(findGroupRow(byProvider.rows, known("free-labs"))?.tokens.apiEquivalentCostUsd).toBe(0);
    expect(findGroupRow(byProvider.rows, known("zero-labs"))).toBeUndefined();
    expect(findGroupRow(byProvider.rows, known("unpriced-labs"))).toBeUndefined();
    expect(byProvider.totals.apiEquivalentCostUsd).not.toBeNull();
    expect(byProvider.totals.unpricedTokens).toBe(30);
    expect(byProvider.totals.unknownTokens).toBe(0);
    expect(byProvider.totals.input).toBe(45);

    const byModel = model.groups({ range: "24h", dimension: "model" }, NOW);
    expect(findGroupRow(byModel.rows, known("free-1"))?.tokens.apiEquivalentCostUsd).toBe(0);
    expect(findGroupRow(byModel.rows, known("zero-1"))).toBeUndefined();
    expect(findGroupRow(byModel.rows, known("mystery-1"))).toBeUndefined();
    expect(findGroupRow(byModel.rows, known("flat-1"))?.tokens.apiEquivalentCostUsd).toBeNull();
  });

  it("ranks top five series by selected-range tokens and conserves Other buckets", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const rows = [
      row({
        sessionID: "ses_a",
        messageID: "msg_m100",
        completedAtMs,
        tokens: { input: 100 },
        modelID: "m100",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_m90",
        completedAtMs,
        tokens: { input: 90 },
        modelID: "m90",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_m80",
        completedAtMs,
        tokens: { input: 80 },
        modelID: "m80",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_m70",
        completedAtMs,
        tokens: { input: 70 },
        modelID: "m70",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_m60",
        completedAtMs,
        tokens: { input: 60 },
        modelID: "m60",
      }),
      // Token-rank must ignore a low-volume, high-cost group.
      row({
        sessionID: "ses_a",
        messageID: "msg_pricey",
        completedAtMs,
        tokens: { input: 1 },
        providerID: "edge-labs",
        modelID: "dual|||model",
      }),
    ];
    const model = createModel(sessions, rows);
    const snapshot = model.groups({ range: "24h", dimension: "model" }, NOW);

    expect(snapshot.series.map((series) => series.kind)).toEqual([
      "entity",
      "entity",
      "entity",
      "entity",
      "entity",
      "other",
    ]);
    expect(snapshot.series.map(seriesIdentity).slice(0, 5)).toEqual([
      known("m100"),
      known("m90"),
      known("m80"),
      known("m70"),
      known("m60"),
    ]);
    const other = snapshot.series[5];
    expect(other?.kind).toBe("other");
    expect(other?.tokens.input).toBe(1);
    expect(other?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(snapshot.series.reduce((sum, series) => sum + series.tokens.input, 0)).toBe(401);
    expect(seriesBucketInput(snapshot.series)).toBe(401);
    expect(flattenGroupRows(snapshot.rows).every((grouped) => !("buckets" in grouped))).toBe(true);
    for (const series of snapshot.series) {
      expect(series.buckets).toHaveLength(snapshot.buckets.length);
    }

    const bucketIndex = snapshot.buckets.findIndex(
      (bucket) => completedAtMs >= bucket.startMs && completedAtMs < bucket.endMs,
    );
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    expect(
      snapshot.series
        .slice(0, 5)
        .reduce((sum, series) => sum + (series.buckets[bucketIndex]?.input ?? 0), 0),
    ).toBe(400);
    expect(other?.buckets[bucketIndex]?.input).toBe(1);
    expect(
      snapshot.series.reduce((sum, series) => sum + (series.buckets[bucketIndex]?.input ?? 0), 0),
    ).toBe(snapshot.totals.input);
  });

  it("subdivides a top-series bucket by exact child identity and conserves cost status", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      row({
        sessionID: "ses_a",
        messageID: "msg_child_priced",
        completedAtMs,
        tokens: { input: 10, output: 2 },
        providerID: "mixed-labs",
        modelID: "priced-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_child_unpriced",
        completedAtMs,
        tokens: { input: 30, cacheRead: 3 },
        providerID: "mixed-labs",
        modelID: "flat-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_child_unknown",
        completedAtMs,
        tokens: { input: 40, reasoning: 4 },
        providerID: "mixed-labs",
        modelID: "no-such-model",
      }),
    ]);
    const snapshot = model.groups({ range: "24h", dimension: "provider" }, NOW);
    const series = snapshot.series[0];
    if (series === undefined) throw new Error("expected the mixed-labs series");
    expect(series.kind).toBe("entity");
    expect(seriesIdentity(series)).toEqual(known("mixed-labs"));
    expectChildBucketsConserve(series);

    const bucketIndex = bucketAt(snapshot, completedAtMs);
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    const children = series.childBuckets?.[bucketIndex] ?? [];
    // Child rank is token volume, never insertion order or cost.
    expect(children.map((child) => rawIdentityOf(child.identity))).toEqual([
      "no-such-model",
      "flat-1",
      "priced-1",
    ]);
    expect(children.map((child) => child.tokens.input)).toEqual([40, 30, 10]);
    const unpriced = children.find((child) => rawIdentityOf(child.identity) === "flat-1");
    expect(unpriced?.tokens.apiEquivalentCostUsd).toBeNull();
    expect(unpriced?.tokens.unpricedTokens).toBe(33);
    expect(unpriced?.tokens.unknownTokens).toBe(0);
    const unknown = children.find((child) => rawIdentityOf(child.identity) === "no-such-model");
    expect(unknown?.tokens.apiEquivalentCostUsd).toBeNull();
    expect(unknown?.tokens.unpricedTokens).toBe(0);
    expect(unknown?.tokens.unknownTokens).toBe(44);
    const priced = children.find((child) => rawIdentityOf(child.identity) === "priced-1");
    expect(priced?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(priced?.tokens.unpricedTokens).toBe(0);
    expect(priced?.tokens.unknownTokens).toBe(0);

    const bucket = series.buckets[bucketIndex];
    if (bucket === undefined) throw new Error("expected a populated bucket");
    expect(bucket.unpricedTokens).toBe(33);
    expect(bucket.unknownTokens).toBe(44);
    expect(bucket.apiEquivalentCostUsd).not.toBeNull();
    expect(children.reduce((sum, child) => sum + child.tokens.total, 0)).toBe(bucket.total);
  });

  it("keeps Other child buckets truthful without top-series or duplicate rows", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      ...["m100", "m90", "m80", "m70", "m60"].map((modelID, index) =>
        row({
          sessionID: "ses_a",
          messageID: `msg_top_${index}`,
          completedAtMs,
          tokens: { input: 100 - index * 10 },
          modelID,
        }),
      ),
      // Two Other parents share the mixed-labs child; their tokens aggregate
      // once per bucket rather than appearing as a parent × child cross-product.
      row({
        sessionID: "ses_a",
        messageID: "msg_other_unpriced",
        completedAtMs,
        tokens: { input: 40 },
        providerID: "mixed-labs",
        modelID: "flat-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_other_priced",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "mixed-labs",
        modelID: "priced-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_other_unknown",
        completedAtMs,
        tokens: { input: 5 },
        providerID: "no-such-provider",
        modelID: "priced-1",
      }),
    ]);
    const snapshot = model.groups({ range: "24h", dimension: "model" }, NOW);

    expect(snapshot.series.map(seriesIdentity).slice(0, 5)).toEqual([
      known("m100"),
      known("m90"),
      known("m80"),
      known("m70"),
      known("m60"),
    ]);
    const other = snapshot.series[5];
    if (other === undefined) throw new Error("expected an Other series");
    expect(other.kind).toBe("other");
    expect(other.tokens.input).toBe(55);
    expectChildBucketsConserve(other);
    for (const series of snapshot.series) expectChildBucketsConserve(series);

    const bucketIndex = bucketAt(snapshot, completedAtMs);
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    expect(
      other.childBuckets?.[bucketIndex]?.map((child) => rawIdentityOf(child.identity)),
    ).toEqual(["mixed-labs", "no-such-provider"]);
    const otherChildren = other.childBuckets?.[bucketIndex] ?? [];
    expect(otherChildren.map((child) => child.tokens.input)).toEqual([50, 5]);
    const mixed = otherChildren[0];
    expect(mixed?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(mixed?.tokens.unpricedTokens).toBe(40);
    expect(mixed?.tokens.unknownTokens).toBe(0);
    const unknown = otherChildren[1];
    expect(unknown?.tokens.apiEquivalentCostUsd).toBeNull();
    expect(unknown?.tokens.unknownTokens).toBe(5);
    expect(other.buckets[bucketIndex]?.unpricedTokens).toBe(40);
    expect(other.buckets[bucketIndex]?.unknownTokens).toBe(5);

    // A top series keeps only its own child: its 100 tokens stay with openai
    // and neither the 5 Other unknown tokens nor Other's 55 total leak in.
    const top = snapshot.series[0];
    if (top === undefined) throw new Error("expected the m100 series");
    const topChildren = top.childBuckets?.[bucketIndex] ?? [];
    expect(topChildren).toHaveLength(1);
    expect(topChildren[0]?.identity).toEqual(known("openai"));
    expect(topChildren[0]?.tokens.input).toBe(100);
    expect(topChildren[0]?.tokens.unknownTokens).toBe(top.buckets[bucketIndex]?.unknownTokens);
    expect(top.tokens.input).toBe(100);
  });

  it("exposes sparse same-dimension parent shares for Other in both groupings", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      ...["top-1", "top-2", "top-3", "top-4", "top-5"].map((modelID, index) =>
        row({
          sessionID: "ses_a",
          messageID: `msg_top_${index}`,
          completedAtMs,
          tokens: { input: 100 - index * 10 },
          providerID: `p${index + 1}`,
          modelID,
        }),
      ),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_a_6",
        completedAtMs,
        tokens: { input: 40 },
        providerID: "p6",
        modelID: "hidden-a",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_a_7",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "p7",
        modelID: "hidden-a",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_b_6",
        completedAtMs,
        tokens: { input: 30 },
        providerID: "p6",
        modelID: "hidden-b",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_c_7",
        completedAtMs,
        tokens: { input: 5 },
        providerID: "p7",
        modelID: "hidden-c",
      }),
    ]);
    const bucketIndex = bucketAt(
      model.groups({ range: "24h", dimension: "model" }, NOW),
      completedAtMs,
    );
    expect(bucketIndex).toBeGreaterThanOrEqual(0);

    const expectations = [
      {
        dimension: "model" as const,
        otherInput: 85,
        parents: ["hidden-a", "hidden-b", "hidden-c"],
        parentInputs: [50, 30, 5],
        children: ["p6", "p7"],
        childInputs: [70, 15],
      },
      {
        dimension: "provider" as const,
        otherInput: 75,
        parents: ["p5", "p7"],
        parentInputs: [60, 15],
        children: ["top-5", "hidden-a", "hidden-c"],
        childInputs: [60, 10, 5],
      },
    ];

    for (const expected of expectations) {
      const snapshot = model.groups({ range: "24h", dimension: expected.dimension }, NOW);
      expect(snapshot.series).toHaveLength(6);
      expect(
        snapshot.series.slice(0, 5).every((series) => !Object.hasOwn(series, "parentBuckets")),
      ).toBe(true);
      const other = snapshot.series[5];
      if (other === undefined || other.kind !== "other") throw new Error("expected Other");
      expect(other.tokens.input).toBe(expected.otherInput);
      expect(other.buckets[bucketIndex]?.input).toBe(expected.otherInput);
      expectChildBucketsConserve(other);
      expectParentBucketsConserve(other);

      expect(
        other.parentBuckets?.[bucketIndex]?.map((share) => rawIdentityOf(share.identity)),
      ).toEqual(expected.parents);
      expect(other.parentBuckets?.[bucketIndex]?.map((share) => share.tokens.input)).toEqual(
        expected.parentInputs,
      );
      expect(
        other.childBuckets?.[bucketIndex]?.map((share) => rawIdentityOf(share.identity)),
      ).toEqual(expected.children);
      expect(other.childBuckets?.[bucketIndex]?.map((share) => share.tokens.input)).toEqual(
        expected.childInputs,
      );

      // Sparse per populated bucket: hidden parents appear once, never as a
      // dense hidden-count × bucket matrix and never in empty buckets.
      const parentShares = other.parentBuckets ?? [];
      expect(parentShares).toHaveLength(snapshot.buckets.length);
      expect(parentShares.flat()).toHaveLength(expected.parents.length);
      expect(parentShares.filter((shares) => shares.length > 0)).toHaveLength(1);
      expect(parentShares.every((shares) => shares.length <= expected.parents.length)).toBe(true);
      expect(parentShares[bucketIndex]?.map(shareKey).sort()).toEqual(
        expected.parents.map((id) => `known:${id}`).sort(),
      );

      // The added field is additive: existing series/bucket geometry and the
      // opposite-dimension child breakdown stay unchanged.
      expect(other.buckets).toHaveLength(snapshot.buckets.length);
      expect(other.buckets.reduce((sum, bucket) => sum + bucket.total, 0)).toBe(
        expected.otherInput,
      );
      expect(snapshot.series.reduce((sum, series) => sum + series.tokens.input, 0)).toBe(485);

      const { beforeBytes, afterBytes } = parentBucketsSerializedSize(snapshot);
      expect(afterBytes).toBeGreaterThan(beforeBytes);
      expect(afterBytes - beforeBytes).toBeLessThan(beforeBytes);
    }
  });

  it("conserves parent cost status for hidden Other parents", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      ...["t1", "t2", "t3", "t4", "t5"].map((providerID, index) =>
        row({
          sessionID: "ses_a",
          messageID: `msg_top_provider_${index}`,
          completedAtMs,
          tokens: { input: 100 },
          providerID,
          modelID: "gpt-5",
        }),
      ),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_priced",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "mixed-labs",
        modelID: "priced-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_unpriced",
        completedAtMs,
        tokens: { input: 30 },
        providerID: "mixed-labs",
        modelID: "flat-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_unknown",
        completedAtMs,
        tokens: { input: 40 },
        providerID: "mixed-labs",
        modelID: "no-such-model",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_unpriced_only",
        completedAtMs,
        tokens: { input: 20 },
        providerID: "unpriced-labs",
        modelID: "mystery-1",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_hidden_unknown_only",
        completedAtMs,
        tokens: { input: 20 },
        providerID: "no-such-provider",
        modelID: "no-such-model",
      }),
    ]);
    const snapshot = model.groups({ range: "24h", dimension: "provider" }, NOW);
    const bucketIndex = bucketAt(snapshot, completedAtMs);
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    const other = snapshot.series[5];
    if (other === undefined || other.kind !== "other") throw new Error("expected Other");
    expect(other.tokens.input).toBe(120);
    expectChildBucketsConserve(other);
    expectParentBucketsConserve(other);

    const parents = other.parentBuckets?.[bucketIndex] ?? [];
    expect(parents.map((share) => rawIdentityOf(share.identity))).toEqual([
      "mixed-labs",
      "no-such-provider",
      "unpriced-labs",
    ]);
    expect(parents.map((share) => share.tokens.input)).toEqual([80, 20, 20]);
    const mixed = parents[0];
    expect(mixed?.tokens.apiEquivalentCostUsd).not.toBeNull();
    expect(mixed?.tokens.unpricedTokens).toBe(30);
    expect(mixed?.tokens.unknownTokens).toBe(40);
    const unknownOnly = parents[1];
    expect(unknownOnly?.tokens.apiEquivalentCostUsd).toBeNull();
    expect(unknownOnly?.tokens.unpricedTokens).toBe(0);
    expect(unknownOnly?.tokens.unknownTokens).toBe(20);
    const unpricedOnly = parents[2];
    expect(unpricedOnly?.tokens.apiEquivalentCostUsd).toBeNull();
    expect(unpricedOnly?.tokens.unpricedTokens).toBe(20);
    expect(unpricedOnly?.tokens.unknownTokens).toBe(0);

    const bucket = other.buckets[bucketIndex];
    expect(bucket?.apiEquivalentCostUsd).not.toBeNull();
    expect(bucket?.unpricedTokens).toBe(50);
    expect(bucket?.unknownTokens).toBe(60);
    // The opposite-dimension breakdown still merges the same model across
    // hidden parents exactly once.
    expect(
      other.childBuckets?.[bucketIndex]?.map((share) => rawIdentityOf(share.identity)),
    ).toEqual(["no-such-model", "flat-1", "mystery-1", "priced-1"]);
    expect(other.childBuckets?.[bucketIndex]?.map((share) => share.tokens.input)).toEqual([
      60, 30, 20, 10,
    ]);
  });

  it("keeps unknown and empty hidden parents in a filtered Other breakdown", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const model = createModel(sessions, [
      ...["top-1", "top-2", "top-3", "top-4", "top-5"].map((modelID, index) =>
        row({
          sessionID: "ses_a",
          messageID: `msg_filtered_top_${index}`,
          completedAtMs,
          tokens: { input: 100 - index * 10 },
          providerID: "p1",
          modelID,
        }),
      ),
      row({
        sessionID: "ses_a",
        messageID: "msg_filtered_hidden",
        completedAtMs,
        tokens: { input: 30 },
        providerID: "p1",
        modelID: "hidden-model",
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_filtered_unknown",
        completedAtMs,
        tokens: { input: 20 },
        providerID: "p1",
        modelID: undefined,
      }),
      row({
        sessionID: "ses_a",
        messageID: "msg_filtered_empty",
        completedAtMs,
        tokens: { input: 10 },
        providerID: "p1",
        modelID: "",
      }),
      // Outside the provider filter; must not leak into rows or Other.
      row({
        sessionID: "ses_a",
        messageID: "msg_filtered_out",
        completedAtMs,
        tokens: { input: 1_000 },
        providerID: "p2",
        modelID: "excluded-model",
      }),
    ]);
    const snapshot = model.groups(
      {
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: known("p1") },
      },
      NOW,
    );
    expect(snapshot.filter).toEqual({ dimension: "provider", identity: known("p1") });
    expect(snapshot.totals.input).toBe(460);
    expect(snapshot.rows).toHaveLength(8);
    expect(snapshot.series).toHaveLength(6);
    expect(snapshot.rows.some((entry) => rawIdentityOf(entry.identity) === "excluded-model")).toBe(
      false,
    );

    const bucketIndex = bucketAt(snapshot, completedAtMs);
    expect(bucketIndex).toBeGreaterThanOrEqual(0);
    const other = snapshot.series[5];
    if (other === undefined || other.kind !== "other") throw new Error("expected Other");
    expect(other.tokens.input).toBe(60);
    expectChildBucketsConserve(other);
    expectParentBucketsConserve(other);
    expect(other.parentBuckets?.[bucketIndex]?.map((share) => share.identity)).toEqual([
      known("hidden-model"),
      UNKNOWN_IDENTITY,
      known(""),
    ]);
    expect(other.parentBuckets?.[bucketIndex]?.map((share) => share.tokens.input)).toEqual([
      30, 20, 10,
    ]);
    expect(
      other.parentBuckets?.[bucketIndex]?.filter((share) => share.identity.kind === "unknown"),
    ).toHaveLength(1);
    expect(other.childBuckets?.[bucketIndex]?.map((share) => share.identity)).toEqual([
      known("p1"),
    ]);
    expect(other.childBuckets?.[bucketIndex]?.[0]?.tokens.input).toBe(60);
  });

  it("returns empty ranges and exactly five groups without an Other series", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const emptyModel = createModel(sessions, []);
    for (const dimension of DIMENSIONS) {
      const snapshot = emptyModel.groups({ range: "24h", dimension }, NOW);
      expect(snapshot.rows).toEqual([]);
      expect(snapshot.series).toEqual([]);
      expect(snapshot.totals).toEqual(emptyModel.home("24h", NOW).usage.totals);
      expect(snapshot.stepCount).toBe(0);
      expect(snapshot.sessionCount).toBe(0);
      expect(snapshot.buckets.length).toBeGreaterThan(0);
    }

    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const five = createModel(
      sessions,
      [1, 2, 3, 4, 5].map((index) =>
        row({
          sessionID: "ses_a",
          messageID: `msg_five_${index}`,
          completedAtMs,
          tokens: { input: index * 10 },
          modelID: `five-${index}`,
        }),
      ),
    );
    const snapshot = five.groups({ range: "24h", dimension: "model" }, NOW);
    expect(snapshot.series).toHaveLength(5);
    expect(snapshot.series.every((series) => series.kind === "entity")).toBe(true);
    expect(snapshot.series.reduce((sum, series) => sum + series.tokens.input, 0)).toBe(150);
  });

  it("keeps lifetime bucket output bounded by series rather than group cardinality", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const firstStepMs = NOW - 800 * 24 * HOUR;
    const rows = Array.from({ length: 120 }, (_, index) =>
      row({
        sessionID: "ses_a",
        messageID: `msg_high_${index}`,
        completedAtMs: firstStepMs + index * 6 * 24 * HOUR,
        tokens: { input: 100 + index },
        providerID: `provider-${index % 3}`,
        modelID: `high-${index}`,
      }),
    );
    const model = createModel(sessions, rows);
    const snapshot = model.groups({ range: "lifetime", dimension: "model" }, NOW);

    expect(snapshot.rows).toHaveLength(120);
    expect(snapshot.series).toHaveLength(6);
    expect(snapshot.series[5]?.kind).toBe("other");
    expect(snapshot.buckets.length).toBeGreaterThan(600);
    for (const grouped of flattenGroupRows(snapshot.rows)) {
      expect("buckets" in grouped).toBe(false);
    }

    const bucketSlots = snapshot.series.reduce((sum, series) => sum + series.buckets.length, 0);
    expect(bucketSlots).toBe(6 * snapshot.buckets.length);
    expect(bucketSlots).toBeLessThanOrEqual(6 * snapshot.buckets.length);
    expect(snapshot.totals).toEqual(model.home("lifetime", NOW).usage.totals);
    expect(snapshot.series.reduce((sum, series) => sum + series.tokens.input, 0)).toBe(
      snapshot.totals.input,
    );

    const other = snapshot.series[5];
    if (other === undefined || other.kind !== "other") throw new Error("expected Other");
    expectChildBucketsConserve(other);
    expectParentBucketsConserve(other);
    const parentShares = other.parentBuckets ?? [];
    const populatedBuckets = other.buckets.filter((bucket) => bucket.total > 0).length;
    // 115 hidden models, each in its own populated day: the parent breakdown
    // stays linear in hidden entities rather than hidden × 700+dense buckets.
    expect(populatedBuckets).toBe(115);
    expect(parentShares.flat()).toHaveLength(115);
    expect(parentShares.flat().length).toBeLessThan(115 * populatedBuckets);
    const { beforeBytes, afterBytes } = parentBucketsSerializedSize(snapshot);
    expect(afterBytes).toBeGreaterThan(beforeBytes);
    expect(afterBytes - beforeBytes).toBeLessThan(beforeBytes);
  });

  it("breaks more than five equal token totals deterministically", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW_HOUR - 2 * HOUR;
    const rows = [1, 2, 3, 4, 5, 6, 7].map((index) =>
      row({
        sessionID: "ses_a",
        messageID: `msg_tie_${index}`,
        completedAtMs,
        tokens: { input: 50 },
        modelID: `tie-${index}`,
      }),
    );
    const forward = createModel(sessions, rows);
    const reverse = createModel(sessions, [...rows].reverse());

    expect(allGroupOutputs(forward)).toEqual(allGroupOutputs(reverse));

    const snapshot = forward.groups({ range: "24h", dimension: "model" }, NOW);
    expect(
      snapshot.series
        .slice(0, 5)
        .map((series) => (series.kind === "entity" ? rawIdentityOf(series.identity) : undefined)),
    ).toEqual(["tie-1", "tie-2", "tie-3", "tie-4", "tie-5"]);
    const other = snapshot.series[5];
    expect(other?.kind).toBe("other");
    expect(other?.tokens.input).toBe(100);
    expect(snapshot.series.reduce((sum, series) => sum + series.tokens.input, 0)).toBe(350);
  });
});

describe("analytics model: zero-token usage exclusion", () => {
  it("excludes zero-token rows from ownership, pricing, groups, and activity extents", () => {
    const sessions = [
      sessionInfo("ses_a", "p1", {
        time: { created: NOW - 6 * HOUR, updated: NOW - HOUR },
      }),
    ];
    const zeroAt = NOW - 3 * 24 * HOUR;
    const zero = row({
      sessionID: "ses_a",
      messageID: "msg_zero_priced",
      completedAtMs: zeroAt,
      tokens: {},
      providerID: "zero-labs",
      modelID: "zero-1",
    });
    const positive = row({
      sessionID: "ses_a",
      messageID: "msg_positive",
      completedAtMs: NOW - 2 * HOUR,
      tokens: { input: 7 },
    });
    const model = createModel(sessions, [zero, positive]);

    const lifetime = model.home("lifetime", NOW).usage;
    expect(lifetime.totals.input).toBe(7);
    expect(lifetime.totals.total).toBe(7);
    expect(lifetime.stepCount).toBe(1);
    expect(lifetime.sessionCount).toBe(1);
    expect(model.ownedStepCount()).toBe(1);

    // A zero-token row must not extend a user-visible activity extent; the
    // session metadata timestamp remains authoritative.
    expect(model.earliestActivityMs()).toBe(NOW - 6 * HOUR);

    for (const dimension of DIMENSIONS) {
      const snapshot = model.groups({ range: "lifetime", dimension }, NOW);
      expect(snapshot.totals).toEqual(model.home("lifetime", NOW).usage.totals);
      expect(snapshot.stepCount).toBe(1);
      expect(snapshot.sessionCount).toBe(1);
      expect(flattenGroupRows(snapshot.rows).map((entry) => entry.identity)).not.toContainEqual(
        known("zero-1"),
      );
      expect(flattenGroupRows(snapshot.rows).map((entry) => entry.identity)).not.toContainEqual(
        known("zero-labs"),
      );
    }

    const filtered = model.groups(
      {
        range: "lifetime",
        dimension: "provider",
        filter: { dimension: "model", identity: known("zero-1") },
      },
      NOW,
    );
    expect(filtered.rows).toEqual([]);
    expect(filtered.series).toEqual([]);
    expect(filtered.stepCount).toBe(0);
    expect(filtered.sessionCount).toBe(0);
    expect(filtered.totals.total).toBe(0);
    expect(filtered.totals.apiEquivalentCostUsd).toBeNull();
  });

  it("keeps zero-token-only session and project metadata visible", () => {
    const sessions = [
      sessionInfo("ses_a", "p1", {
        time: { created: NOW - 2 * HOUR, updated: NOW - 30 * 60_000 },
      }),
    ];
    const model = createModel(sessions, [
      row({
        sessionID: "ses_a",
        messageID: "msg_zero_only",
        completedAtMs: NOW - 3 * 24 * HOUR,
        tokens: {},
        providerID: "unpriced-labs",
        modelID: "mystery-1",
      }),
    ]);

    expect(model.hasSession("ses_a")).toBe(true);
    expect(model.hasProject("p1")).toBe(true);

    const home = model.home("24h", NOW);
    const project = home.projects.find((entry) => entry.projectId === "p1");
    expect(project?.tokens.total).toBe(0);
    expect(project?.latestActivityAtMs).toBe(NOW - 30 * 60_000);
    expect(home.usage.stepCount).toBe(0);
    expect(home.usage.sessionCount).toBe(0);

    const detail = model.project("p1", "24h", NOW);
    expect(detail.roots).toHaveLength(1);
    expect(detail.roots[0]?.tokens.total).toBe(0);
    expect(detail.totals.total).toBe(0);

    // Lifetime buckets start at session metadata activity, never at the zero
    // row's completion time.
    expect(model.earliestActivityMs()).toBe(NOW - 2 * HOUR);
    const firstLifetimeBucket = model.home("lifetime", NOW).usage.buckets.at(0);
    expect(firstLifetimeBucket?.startMs).toBeGreaterThan(NOW - 3 * 24 * HOUR);
    expect(firstLifetimeBucket?.startMs).toBeLessThanOrEqual(NOW - 2 * HOUR);
    expect(firstLifetimeBucket?.endMs).toBeGreaterThan(NOW - 2 * HOUR);
  });

  it("applies positive↔zero updates, removals, and full repair without stale usage", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW - 2 * HOUR;
    const positive = row({
      sessionID: "ses_a",
      messageID: "msg_switch",
      completedAtMs,
      tokens: { input: 12 },
    });
    const zero = row({
      sessionID: "ses_a",
      messageID: "msg_switch",
      completedAtMs,
      tokens: {},
    });
    const model = createModel(sessions, [positive]);
    expect(model.home("24h", NOW).usage.totals.input).toBe(12);

    // A positive→zero update without a separate removal row must drop the
    // previously owned contribution.
    model.apply([zero], []);
    expect(model.ownedStepCount()).toBe(0);
    expect(model.home("24h", NOW).usage.totals.total).toBe(0);
    expect(model.groups({ range: "24h", dimension: "model" }, NOW).rows).toEqual([]);
    expectSameModelOutputs(model, createModel(sessions, [zero]));

    // Zero→positive restores exactly one contribution.
    model.apply([positive], []);
    expect(model.ownedStepCount()).toBe(1);
    expect(model.home("24h", NOW).usage.totals.input).toBe(12);
    expectSameModelOutputs(model, createModel(sessions, [positive]));

    // Removing the row keeps metadata but removes all usage.
    model.apply([], [positive]);
    expect(model.hasSession("ses_a")).toBe(true);
    expect(model.ownedStepCount()).toBe(0);
    expect(model.home("24h", NOW).usage.totals.total).toBe(0);
    expectSameModelOutputs(model, createModel(sessions, []));
  });

  it("keeps fork dedup exact when zero-token copies share a time window", () => {
    const sessions = [
      sessionInfo("ses_a", "p1"),
      sessionInfo("ses_b", "p1"),
      sessionInfo("ses_c", "p1"),
    ];
    const completedAtMs = NOW - 2 * HOUR;
    const original = row({
      sessionID: "ses_a",
      messageID: "msg_fork_original",
      completedAtMs,
      tokens: { input: 25 },
    });
    const forkCopy = row({
      sessionID: "ses_b",
      messageID: "msg_fork_copy",
      completedAtMs,
      tokens: { input: 25 },
    });
    const zeroCopy = row({
      sessionID: "ses_c",
      messageID: "msg_fork_zero",
      completedAtMs,
      tokens: {},
    });
    const withZero = createModel(sessions, [original, forkCopy, zeroCopy]);
    const withoutZero = createModel(sessions, [original, forkCopy]);

    expectSameModelOutputs(withZero, withoutZero);
    expect(withZero.ownedStepCount()).toBe(1);
    expect(withZero.home("24h", NOW).usage.totals.input).toBe(25);
  });

  it("consumes a mixed zero/positive iterable once during hydration", () => {
    const sessions = [sessionInfo("ses_a", "p1")];
    const completedAtMs = NOW - 2 * HOUR;
    const zeros = Array.from({ length: 400 }, (_, index) =>
      row({
        sessionID: "ses_a",
        messageID: `msg_zero_${index}`,
        completedAtMs,
        tokens: {},
      }),
    );
    const positives = Array.from({ length: 20 }, (_, index) =>
      row({
        sessionID: "ses_a",
        messageID: `msg_positive_${index}`,
        completedAtMs,
        tokens: { input: 2 },
        modelID: `positive-${index}`,
      }),
    );
    function* batch(): Generator<OpenCodeRawAssistantRow> {
      yield* zeros;
      yield* positives;
    }

    const model = createModel(sessions, []);
    model.apply(batch(), []);

    expect(model.ownedStepCount()).toBe(20);
    expect(model.home("24h", NOW).usage.totals.input).toBe(40);
    const grouped = model.groups({ range: "24h", dimension: "model" }, NOW);
    expect(grouped.rows).toHaveLength(20);
    expect(
      flattenGroupRows(grouped.rows).some(
        (entry) => entry.identity.kind === "known" && entry.identity.id === "gpt-5",
      ),
    ).toBe(false);
  });
});

describe("analytics model: rebuild equivalence", () => {
  it("clear plus rebuild matches a fresh model", () => {
    const sessions = [sessionInfo("ses_a", "p1"), sessionInfo("ses_b", "p2")];
    const first = [
      row({
        sessionID: "ses_a",
        messageID: "msg_a",
        completedAtMs: NOW_HOUR - 2 * HOUR,
        tokens: { input: 10 },
      }),
      row({
        sessionID: "ses_b",
        messageID: "msg_b",
        completedAtMs: NOW_HOUR - 26 * HOUR,
        tokens: { input: 20 },
        providerID: "no-such-provider",
        modelID: "no-such-model",
      }),
    ];
    const added = row({
      sessionID: "ses_b",
      messageID: "msg_c",
      completedAtMs: NOW_HOUR - 1 * HOUR,
      tokens: { input: 30 },
      providerID: "unpriced-labs",
      modelID: "mystery-1",
    });
    const model = createModel(sessions, first);
    model.apply([added], []);

    model.clear();
    const rebuiltMetadata = metadata(sessions);
    model.setMetadata(rebuiltMetadata.sessions, rebuiltMetadata.projects);
    model.apply([...first, added], []);

    const fresh = createModel(sessions, [...first, added]);
    expectSameModelOutputs(model, fresh);
  });

  it("incremental edits, removals, and moves match a fresh model on every range", () => {
    const sessions = [
      sessionInfo("ses_a", "p1"),
      sessionInfo("ses_b", "p1"),
      sessionInfo("ses_c", "p2"),
    ];
    const stayA = row({
      sessionID: "ses_a",
      messageID: "msg_stay_a",
      completedAtMs: NOW_HOUR - 2 * HOUR,
      tokens: { input: 10, output: 1 },
    });
    const moved = row({
      sessionID: "ses_b",
      messageID: "msg_moved",
      completedAtMs: NOW_HOUR - 5 * HOUR,
      tokens: { input: 20, cacheRead: 2 },
      providerID: "unpriced-labs",
      modelID: "mystery-1",
    });
    const removed = row({
      sessionID: "ses_c",
      messageID: "msg_removed",
      completedAtMs: NOW_HOUR - 8 * HOUR,
      tokens: { input: 30, output: 3 },
      providerID: "no-such-provider",
      modelID: "no-such-model",
    });
    const editedOriginal = row({
      sessionID: "ses_c",
      messageID: "msg_edit",
      completedAtMs: NOW - 26 * HOUR,
      tokens: { input: 40 },
    });
    const edited = row({
      sessionID: "ses_c",
      messageID: "msg_edit",
      completedAtMs: editedOriginal.completedAtMs,
      tokens: { input: 45 },
      providerID: "no-such-provider",
      modelID: "no-such-model",
    });
    const fork = row({
      sessionID: "ses_c",
      messageID: "msg_fork",
      completedAtMs: NOW_HOUR - 2 * HOUR,
      tokens: { input: 10, output: 1 },
    });
    const addedFork = row({
      sessionID: "ses_a",
      messageID: "msg_fork_copy",
      completedAtMs: NOW_HOUR - 2 * HOUR,
      tokens: { input: 10, output: 1 },
    });

    const model = createModel(sessions, [stayA, moved, removed, editedOriginal]);

    // Metadata move: ses_b leaves p1 for p2 before any upsert.
    const finalSessions = [
      sessionInfo("ses_a", "p1"),
      sessionInfo("ses_b", "p2"),
      sessionInfo("ses_c", "p2"),
    ];
    const movedMetadata = metadata(finalSessions);
    model.setMetadata(movedMetadata.sessions, movedMetadata.projects);

    model.apply([edited, fork, addedFork], [editedOriginal, removed]);
    // Unchanged repeated upserts must not drift counts, cost, or ranges.
    model.apply([stayA, moved, edited, fork, addedFork], []);
    model.apply([], []);

    const finalRows = [stayA, moved, edited, fork, addedFork];
    const fresh = createModel(finalSessions, finalRows);
    expectSameModelOutputs(model, fresh);
    expect(model.ownedStepCount()).toBe(4);
  });
});
