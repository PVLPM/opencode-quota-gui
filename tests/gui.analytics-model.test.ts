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
  return {
    ...actual,
    hasProvider: (providerID: string) =>
      providerID === FAKE_PROVIDER || actual.hasProvider(providerID),
    isModelsDevProviderId: (providerID: string) =>
      providerID === FAKE_PROVIDER || actual.isModelsDevProviderId(providerID),
    hasModel: (providerID: string, modelID: string) =>
      (providerID === FAKE_PROVIDER && modelID === FAKE_MODEL) ||
      actual.hasModel(providerID, modelID),
    lookupCost: (providerID: string, modelID: string) =>
      providerID === FAKE_PROVIDER ? null : actual.lookupCost(providerID, modelID),
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
  return {
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
    providerID: input.providerID ?? "openai",
    modelID: input.modelID ?? "gpt-5",
    cost: input.cost ?? 1,
    ...(input.agent === undefined ? {} : { agent: input.agent }),
  };
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

function allOutputs(model: AnalyticsModel): {
  homes: HomeAnalyticsRollup[];
  projects: ReturnType<AnalyticsModel["project"]>[];
} {
  const homes = RANGE_KEYS.map((range) => model.home(range, NOW));
  const projects = RANGE_KEYS.flatMap((range) =>
    PROJECT_IDS.map((projectId) => model.project(projectId, range, NOW)),
  );
  return { homes, projects };
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
