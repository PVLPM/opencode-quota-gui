/**
 * Host-side Usage snapshot builder: account grouping, activity attribution,
 * per-range axes, labels and the activity-unavailable fallback.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AccountingMetric,
  CostedTokens,
  ProviderCard,
  QuotaCardRow,
} from "../src/contracts/dashboard.js";
import { isUsageSnapshot } from "../src/contracts/dto-guards.js";
import type { RowId } from "../src/contracts/identity.js";
import type { UsageActivityEntry, UsageActivityQuery } from "../src/contracts/usage-activity.js";
import { isUsageActivityQuery } from "../src/contracts/usage-activity.js";
import {
  createUsageSnapshotBuilder,
  type UsageSnapshotBuilderOptions,
} from "../src/gui/usage-service.js";
import {
  openUsageStore,
  type UsageCycleSample,
  type UsageSeriesMetadata,
  type UsageStore,
} from "../src/lib/usage-store.js";

const BASE = Date.parse("2026-05-01T00:00:00.000Z");
const MINUTE = 60_000;
const at = (minutes: number): number => BASE + minutes * MINUTE;

let root: string;
let path: string;
let stores: UsageStore[];
let runSequence: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ocq-usage-service-"));
  path = join(root, "usage-history.sqlite");
  stores = [];
  runSequence = 0;
});

afterEach(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // best effort
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function store(): Promise<UsageStore> {
  const opened = await openUsageStore(path);
  stores.push(opened);
  return opened;
}

function series(
  cardId: string,
  rowKey: string,
  overrides: Partial<UsageSeriesMetadata> = {},
): UsageSeriesMetadata {
  return {
    rowId: `${cardId}#${rowKey}`,
    cardId,
    rowKey,
    providerId: "anthropic",
    providerLabel: "Anthropic",
    label: "Quota",
    metricJson: JSON.stringify({ kind: "window", window: "five_hour" }),
    measurement: "provider-observed",
    source: "opencode-poll",
    ...overrides,
  };
}

function cardRow(
  cardId: string,
  rowKey: string,
  label: string,
  metric: AccountingMetric,
): QuotaCardRow {
  return {
    rowId: `${cardId}#${rowKey}` as RowId,
    label,
    kind: "percent",
    resultType: "quota",
    percentRemaining: 50,
    metric,
  };
}

function card(
  cardId: string,
  rows: QuotaCardRow[],
  overrides: Partial<ProviderCard> = {},
): ProviderCard {
  return {
    cardId: cardId as ProviderCard["cardId"],
    providerId: "anthropic",
    providerLabel: "Anthropic",
    labelSource: "provider",
    rows,
    errors: [],
    ...overrides,
  };
}

function record(
  db: UsageStore,
  atMs: number,
  items: readonly { series: UsageSeriesMetadata; remaining: number; resetAtMs?: number }[],
): void {
  const cards = new Map(
    items.map((item) => [
      item.series.cardId,
      { cardId: item.series.cardId, providerId: item.series.providerId, atMs },
    ]),
  );
  const samples: UsageCycleSample[] = items.map((item) => ({
    series: item.series,
    remainingPercent: item.remaining,
    measuredAtMs: atMs,
    ...(item.resetAtMs !== undefined ? { resetAtMs: item.resetAtMs } : {}),
  }));
  db.recordCycle({
    collectorRunId: `run-${runSequence}`,
    collectorSessionId: "session-1",
    intervalMs: MINUTE,
    observedCards: [...cards.values()],
    providerIds: [...new Set(items.map((item) => item.series.providerId))],
    samples,
    interruptions: [],
    nowMs: atMs,
  });
  runSequence += 1;
}

function costed(input: number, apiEquivalentCostUsd: number): CostedTokens {
  return {
    input,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: input,
    apiEquivalentCostUsd,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function entry(overrides: Partial<UsageActivityEntry> = {}): UsageActivityEntry {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet",
    effort: "high",
    tokens: costed(100, 1),
    stepCount: 2,
    ...overrides,
  };
}

function activityReturning(
  entries: (interval: { startMs: number; endMs: number }) => UsageActivityEntry[],
): (query: UsageActivityQuery) => Promise<ReturnType<typeof aligned>> {
  return async (query) => aligned(query, entries);
}

function aligned(
  query: UsageActivityQuery,
  entries: (interval: { startMs: number; endMs: number }) => UsageActivityEntry[],
) {
  return {
    intervals: query.intervals.map((interval) => ({
      startMs: interval.startMs,
      endMs: interval.endMs,
      entries: entries(interval),
      incomplete: false,
      unpricedTokens: 0,
      unknownTokens: 0,
    })),
  };
}

function build(db: UsageStore | undefined, overrides: Partial<UsageSnapshotBuilderOptions> = {}) {
  return createUsageSnapshotBuilder({
    ...(db !== undefined ? { store: db } : {}),
    now: () => at(240),
    timeZone: "UTC",
    ...overrides,
  });
}

describe("usage snapshot: attribution", () => {
  it("attributes burn end to end for a sole account and fills the models dictionary", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", {
      label: "5h",
    });
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);
    record(db, at(2), [{ series: fiveHour, remaining: 60 }]);

    const queries: UsageActivityQuery[] = [];
    const snapshot = await build(db, {
      activity: async (query) => {
        queries.push(query);
        return aligned(query, () => [entry()]);
      },
    }).usage({ range: "lifetime" });

    expect(snapshot.activityUnavailable).toBeUndefined();
    expect(snapshot.accounts).toHaveLength(1);
    const account = snapshot.accounts[0];
    expect(account?.providerId).toBe("anthropic");
    const window = account?.windows[0];
    expect(window?.points).toHaveLength(3);
    expect(window?.intervals).toHaveLength(2);
    expect(window?.intervals.map((interval) => interval.link)).toEqual(["observed", "observed"]);
    expect(window?.intervals.map((interval) => interval.attributedBurnPercentPoints)).toEqual([
      10, 10,
    ]);
    expect(window?.totals).toEqual({
      observedBurnPercentPoints: 20,
      attributedBurnPercentPoints: 20,
      unattributedBurnPercentPoints: 0,
    });
    expect(window?.breakdown).toHaveLength(1);
    expect(window?.breakdown[0]?.tokens.total).toBe(200);
    expect(window?.breakdown[0]?.stepCount).toBe(4);
    expect(window?.breakdown[0]?.estimatedBurnPercentPoints).toBeCloseTo(20);

    expect(queries).toHaveLength(1);
    expect(isUsageActivityQuery(queries[0])).toBe(true);
    expect(queries[0]?.intervals).toEqual([
      { startMs: at(0), endMs: at(1) },
      { startMs: at(1), endMs: at(2) },
    ]);
    expect(queries[0]?.providerIds).toEqual(["anthropic"]);

    expect(snapshot.models).toEqual([
      { providerId: "anthropic", modelId: "claude-sonnet", effort: "high" },
    ]);
    expect(window?.intervals[0]?.activity[0]).toMatchObject({
      model: 0,
      source: "opencode-poll",
    });
    expect(window?.intervals[0]?.activity[0]?.estimatedBurnPercentPoints).toBeCloseTo(10);
    expect(snapshot.imports).toEqual([
      { harness: "claude-code", enabled: false, status: "disabled" },
      { harness: "codex", enabled: false, status: "disabled" },
    ]);
    expect(snapshot.importedActivity).toEqual([]);
    expect(isUsageSnapshot(snapshot)).toBe(true);
  });

  it("keeps imported harness activity in separate sections, never quota intervals or models", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", {
      label: "5h",
    });
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const importedQueries: UsageActivityQuery[] = [];
    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      importStatus: async () => [
        { harness: "claude-code", enabled: true, status: "ok" },
        { harness: "codex", enabled: true, status: "ok" },
      ],
      importedActivity: async (query) => {
        importedQueries.push(query);
        return aligned(query, () => [
          entry({
            providerId: "anthropic",
            modelId: "claude-sonnet-4-5",
            effort: "high",
            tokens: costed(300, 3),
            stepCount: 3,
          }),
          entry({
            providerId: "openai",
            modelId: "gpt-5.2-codex",
            effort: "xhigh",
            tokens: costed(200, 2),
            stepCount: 2,
          }),
        ]);
      },
    }).usage({ range: "24h" });

    expect(importedQueries).toHaveLength(1);
    expect(importedQueries[0]?.intervals).toEqual([snapshot.span]);
    expect(importedQueries[0]?.providerIds.sort()).toEqual(["anthropic", "openai"]);

    // Both harnesses are reported, each with its own model/effort totals.
    expect(snapshot.importedActivity.map((section) => section.harness)).toEqual([
      "claude-code",
      "codex",
    ]);
    const [claude, codex] = snapshot.importedActivity;
    expect(claude?.models).toMatchObject([
      {
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5",
        stepCount: 3,
        efforts: [{ effort: "high", stepCount: 3 }],
      },
    ]);
    expect(claude?.totals.apiEquivalentCostUsd).toBe(3);
    expect(claude?.stepCount).toBe(3);
    expect(codex?.models[0]?.modelId).toBe("gpt-5.2-codex");
    expect(codex?.totals.apiEquivalentCostUsd).toBe(2);

    // Nothing imported leaks into attribution: the OpenCode model dictionary
    // and every quota interval keep only OpenCode activity.
    expect(snapshot.models).toEqual([
      { providerId: "anthropic", modelId: "claude-sonnet", effort: "high" },
    ]);
    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.activity).toHaveLength(1);
    expect(interval?.activity[0]?.source).toBe("opencode-poll");
    expect(interval?.attributedBurnPercentPoints).toBe(10);
    expect(isUsageSnapshot(snapshot)).toBe(true);
  });

  it("leaves burn unattributed as ambiguous when two accounts share the provider", async () => {
    const db = await store();
    const first = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const second = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    for (const minute of [0, 1]) {
      record(db, at(minute), [
        { series: first, remaining: minute === 0 ? 80 : 70 },
        { series: second, remaining: minute === 0 ? 60 : 55 },
      ]);
    }

    const queries: UsageActivityQuery[] = [];
    const snapshot = await build(db, {
      activity: async (query) => {
        queries.push(query);
        return aligned(query, () => [entry()]);
      },
    }).usage({ range: "lifetime" });

    expect(queries).toHaveLength(1);
    expect(snapshot.accounts).toHaveLength(2);
    for (const account of snapshot.accounts) {
      const interval = account.windows[0]?.intervals[0];
      expect(interval?.burnPercentPoints).toBeGreaterThan(0);
      expect(interval?.attributedBurnPercentPoints).toBe(0);
      expect(interval?.unattributedBurnPercentPoints).toBe(interval?.burnPercentPoints ?? 0);
      expect(interval?.unattributedReason).toBe("ambiguous-account");
    }
  });

  it("narrows a model-specific named window to its model family", async () => {
    const db = await store();
    const fable = series("claude-agent:cccccc", "named:Fable weekly|quota:percent", {
      providerId: "claude-agent",
      providerLabel: "Claude Agent",
      label: "Fable weekly",
      metricJson: JSON.stringify({ kind: "named", name: "Fable weekly" }),
    });
    record(db, at(0), [{ series: fable, remaining: 80 }]);
    record(db, at(1), [{ series: fable, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [
        entry({
          providerId: "claude-agent",
          modelId: "claude-fable-5",
          tokens: costed(100, 1),
        }),
        entry({
          providerId: "claude-code",
          modelId: "claude-sonnet-4-5",
          effort: undefined,
          tokens: costed(300, 3),
        }),
      ]),
    }).usage({ range: "lifetime" });

    const window = snapshot.accounts[0]?.windows[0];
    expect(window?.rowId).toBe(fable.rowId);
    expect(window?.intervals[0]?.attributedBurnPercentPoints).toBe(10);
    expect(window?.breakdown.map((model) => model.modelId)).toEqual(["claude-fable-5"]);
    expect(snapshot.models.map((model) => model.modelId)).toEqual(["claude-fable-5"]);
  });

  it("never attributes a row whose billing scope is unknown", async () => {
    const db = await store();
    const codeReview = series("openai:aaaaaa", "window:code_review|rate_limit:percent", {
      providerId: "openai",
      providerLabel: "OpenAI",
      label: "Code review",
      metricJson: JSON.stringify({ kind: "window", window: "code_review" }),
    });
    record(db, at(0), [{ series: codeReview, remaining: 80 }]);
    record(db, at(1), [{ series: codeReview, remaining: 70 }]);

    const queries: UsageActivityQuery[] = [];
    const snapshot = await build(db, {
      activity: async (query) => {
        queries.push(query);
        return aligned(query, () => [entry()]);
      },
    }).usage({ range: "lifetime" });

    expect(queries).toEqual([]);
    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.attributedBurnPercentPoints).toBe(0);
    expect(interval?.unattributedBurnPercentPoints).toBe(10);
    expect(interval?.unattributedReason).toBe("no-activity");
    expect(interval?.activity).toEqual([]);
  });

  it("reports unidentified activity instead of attributing around it", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: async (query) => ({
        intervals: query.intervals.map((interval) => ({
          startMs: interval.startMs,
          endMs: interval.endMs,
          entries: [entry()],
          incomplete: true,
          unpricedTokens: 0,
          unknownTokens: 0,
          unidentifiedTokens: 50,
          unidentifiedSteps: 1,
        })),
      }),
    }).usage({ range: "lifetime" });

    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.attributedBurnPercentPoints).toBe(0);
    expect(interval?.unattributedReason).toBe("unidentified-activity");
    expect(interval?.activity).toHaveLength(1);
  });
});

describe("usage snapshot: ranges and coverage", () => {
  it("uses each series' own latest epoch for the current range", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", { label: "5h" });
    const day = series("anthropic:aaaaaa", "window:day|quota:percent", {
      label: "Day",
      metricJson: JSON.stringify({ kind: "window", window: "day" }),
    });
    const values = [
      { fiveHour: 90, day: 70 },
      { fiveHour: 80, day: 65 },
      { fiveHour: 95, day: 60 },
      { fiveHour: 90, day: 55 },
    ];
    values.forEach((value, minute) => {
      record(db, at(minute), [
        { series: fiveHour, remaining: value.fiveHour },
        { series: day, remaining: value.day },
      ]);
    });

    const snapshot = await build(db, {
      now: () => at(4),
      activity: activityReturning(() => []),
    }).usage({ range: "current" });

    expect(snapshot.span).toBeUndefined();
    const windows = snapshot.accounts[0]?.windows ?? [];
    expect(windows.map((window) => window.rowId)).toEqual([fiveHour.rowId, day.rowId]);
    expect(windows[0]?.points.map((point) => point.remainingPercent)).toEqual([95, 90]);
    expect(windows[0]?.axis).toEqual({ startMs: at(2), endMs: at(4) });
    expect(windows[1]?.points.map((point) => point.remainingPercent)).toEqual([70, 65, 60, 55]);
    expect(windows[1]?.axis).toEqual({ startMs: at(0), endMs: at(4) });
  });

  it("keeps the full requested axis when observation is incomplete", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", { label: "5h" });
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(60), [{ series: fiveHour, remaining: 70 }]);

    const now = at(3 * 24 * 60);
    const snapshot = await build(db, {
      now: () => now,
      activity: activityReturning(() => []),
    }).usage({ range: "7d" });

    expect(snapshot.span).toEqual({ startMs: now - 7 * 24 * 60 * MINUTE, endMs: now });
    const window = snapshot.accounts[0]?.windows[0];
    expect(window?.axis).toEqual(snapshot.span);
    expect(window?.coverage.firstObservedAtMs).toBe(at(0));
    expect(window?.coverage.lastObservedAtMs).toBe(at(60));
    expect(window?.coverage.observedMs).toBe(0);
    expect(window?.links).toEqual([{ kind: "unobserved" }]);
    expect(window?.totals).toEqual({
      observedBurnPercentPoints: 10,
      attributedBurnPercentPoints: 0,
      unattributedBurnPercentPoints: 10,
    });
  });

  it("queries activity once per provider for the de-duplicated interval union", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", { label: "5h" });
    const day = series("anthropic:aaaaaa", "window:day|quota:percent", {
      label: "Day",
      metricJson: JSON.stringify({ kind: "window", window: "day" }),
    });
    for (const minute of [0, 1, 2]) {
      record(db, at(minute), [
        { series: fiveHour, remaining: 90 - minute * 10 },
        { series: day, remaining: 70 - minute * 5 },
      ]);
    }

    const queries: UsageActivityQuery[] = [];
    const snapshot = await build(db, {
      now: () => at(2),
      activity: async (query) => {
        queries.push(query);
        return aligned(query, () => [entry()]);
      },
    }).usage({ range: "lifetime" });

    expect(queries).toHaveLength(1);
    expect(queries[0]?.intervals).toEqual([
      { startMs: at(0), endMs: at(1) },
      { startMs: at(1), endMs: at(2) },
    ]);

    const ordered = await build(db, {
      now: () => at(2),
      activity: activityReturning(() => []),
      latestQuotaCards: () => [
        card("anthropic:aaaaaa", [
          cardRow("anthropic:aaaaaa", "window:day|quota:percent", "Day live", {
            kind: "window",
            window: "day",
          }),
          cardRow("anthropic:aaaaaa", "window:five_hour|quota:percent", "5h live", {
            kind: "window",
            window: "five_hour",
          }),
        ]),
      ],
    }).usage({ range: "lifetime" });
    expect(ordered.accounts[0]?.windows.map((window) => window.label)).toEqual([
      "Day live",
      "5h live",
    ]);
    expect(snapshot.models).toHaveLength(1);
  });

  it("dedupes model keys across windows and points activity.model at the dictionary", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", { label: "5h" });
    const day = series("anthropic:aaaaaa", "window:day|quota:percent", {
      label: "Day",
      metricJson: JSON.stringify({ kind: "window", window: "day" }),
    });
    for (const minute of [0, 1]) {
      record(db, at(minute), [
        { series: fiveHour, remaining: 80 - minute * 10 },
        { series: day, remaining: 60 - minute * 5 },
      ]);
    }

    const snapshot = await build(db, {
      now: () => at(1),
      activity: activityReturning(() => [
        entry({ providerId: "anthropic", modelId: "a-model", effort: "high" }),
        entry({ providerId: "anthropic", modelId: "b-model", effort: "low" }),
      ]),
    }).usage({ range: "lifetime" });

    expect(snapshot.models).toEqual([
      { providerId: "anthropic", modelId: "a-model", effort: "high" },
      { providerId: "anthropic", modelId: "b-model", effort: "low" },
    ]);
    for (const window of snapshot.accounts[0]?.windows ?? []) {
      const modelIndexes = window.intervals.flatMap((interval) =>
        interval.activity.map((activity) => activity.model),
      );
      expect(modelIndexes).toEqual([0, 1]);
    }
  });
});

describe("usage snapshot: unavailable activity and storage", () => {
  it("returns quota history without attribution when activity throws", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: async () => {
        throw new Error("analytics not ready");
      },
    }).usage({ range: "24h" });

    expect(snapshot.activityUnavailable).toBe(true);
    expect(snapshot.models).toEqual([]);
    const window = snapshot.accounts[0]?.windows[0];
    expect(window?.points).toHaveLength(2);
    expect(window?.intervals[0]?.attributedBurnPercentPoints).toBe(0);
    expect(window?.intervals[0]?.unattributedBurnPercentPoints).toBe(10);
    expect(window?.intervals[0]?.unattributedReason).toBeUndefined();
    expect(window?.breakdown).toEqual([]);
  });

  it("treats a misaligned or absent activity read as unavailable", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const misaligned = await build(db, {
      activity: async () => ({ intervals: [] }),
    }).usage({ range: "lifetime" });
    expect(misaligned.activityUnavailable).toBe(true);

    const absent = await build(db).usage({ range: "lifetime" });
    expect(absent.activityUnavailable).toBe(true);
    expect(absent.accounts[0]?.windows[0]?.points).toHaveLength(2);
  });

  it("returns empty accounts when the database does not exist and creates nothing", async () => {
    const missing = join(root, "missing", "usage-history.sqlite");
    const snapshot = await build(undefined, { path: missing }).usage({ range: "24h" });

    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.activityUnavailable).toBeUndefined();
    expect(snapshot.span).toEqual({ startMs: at(240) - 24 * 60 * MINUTE, endMs: at(240) });
    expect(existsSync(missing)).toBe(false);
  });
});

describe("usage snapshot: labels", () => {
  it("uses live card labels only and neutral labels without a live card", async () => {
    const db = await store();
    const fiveHour = series("anthropic:abcdef123456", "window:five_hour|quota:percent", {
      providerLabel: "Anthropic",
      label: "Stored 5h",
      accountLabel: "secret@example.com",
      planLabel: "Stored Plan",
    });
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);

    const stored = await build(db, { now: () => at(1) }).usage({ range: "lifetime" });
    const storedAccount = stored.accounts[0];
    expect(storedAccount?.providerLabel).toBe("Anthropic");
    expect(storedAccount?.accountLabel).toBe("Anthropic account abcdef");
    expect(storedAccount?.planLabel).toBeUndefined();
    expect(storedAccount?.windows[0]?.label).toBe("Stored 5h");
    expect(JSON.stringify(stored)).not.toContain("secret@example.com");
    expect(JSON.stringify(stored)).not.toContain("Stored Plan");

    const live = await build(db, {
      now: () => at(1),
      latestQuotaCards: () => [
        card(
          "anthropic:abcdef123456",
          [
            cardRow("anthropic:abcdef123456", "window:five_hour|quota:percent", "5h live", {
              kind: "window",
              window: "five_hour",
            }),
          ],
          { accountLabel: "Live Account", planLabel: "Live Plan", providerLabel: "Live Provider" },
        ),
      ],
    }).usage({ range: "lifetime" });
    expect(live.accounts[0]).toMatchObject({
      providerLabel: "Live Provider",
      accountLabel: "Live Account",
      planLabel: "Live Plan",
    });
    expect(live.accounts[0]?.windows[0]?.label).toBe("5h live");
  });
});
