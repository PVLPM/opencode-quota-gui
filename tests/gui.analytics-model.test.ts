import { describe, expect, it, vi } from "vitest";

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
  const RATES = { input: 1, output: 1, reasoning: 1, cache_read: 1, cache_write: 1 };
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
  ]);
  const PRICED_MODELS: ReadonlySet<string> = new Set([
    `${EDGE_PROVIDER}\u0000${EDGE_MODEL}`,
    `${MIXED_PROVIDER}\u0000${MIXED_PRICED_MODEL}`,
    `${ZERO_PROVIDER}\u0000${ZERO_MODEL}`,
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
      if (providerID === FAKE_PROVIDER) return null;
      return actual.lookupCost(providerID, modelID);
    },
  };
});

import { RANGE_KEYS } from "../src/contracts/ranges.js";
import {
  type AnalyticsModel,
  createAnalyticsModel,
  type HomeAnalyticsRollup,
} from "../src/gui/analytics-model.js";
import type {
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const NOW_HOUR = Math.floor(NOW / HOUR) * HOUR;
const PROJECT_IDS = ["p1", "p2"];

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

describe("analytics model: price status", () => {
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

    expect(findGroupRow(byProvider.rows, known("zero-labs"))?.tokens.apiEquivalentCostUsd).toBe(0);
    expect(
      findGroupRow(byProvider.rows, known("unpriced-labs"))?.tokens.apiEquivalentCostUsd,
    ).toBeNull();
    expect(byProvider.totals.apiEquivalentCostUsd).not.toBeNull();
    expect(byProvider.totals.unpricedTokens).toBe(30);
    expect(byProvider.totals.unknownTokens).toBe(0);

    const byModel = model.groups({ range: "24h", dimension: "model" }, NOW);
    expect(findGroupRow(byModel.rows, known("zero-1"))?.tokens.apiEquivalentCostUsd).toBe(0);
    expect(findGroupRow(byModel.rows, known("mystery-1"))?.tokens.apiEquivalentCostUsd).toBeNull();
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
