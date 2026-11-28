/**
 * Host-side Usage snapshot builder: account grouping, activity attribution,
 * per-range axes, labels and the activity-unavailable fallback.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  type UsageCycleInterruption,
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
  interruptions: UsageCycleInterruption[] = [],
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
    interruptions,
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
    // Without a store, point at a missing temp file: never the real private history.
    ...(db !== undefined ? { store: db } : { path: join(root, "absent-usage-history.sqlite") }),
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

  it("sums available imported costs instead of blanking a partially priced section", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      importStatus: async () => [{ harness: "codex", enabled: true, status: "ok" }],
      importedActivity: async (query) =>
        aligned(query, () => [
          entry({
            providerId: "openai",
            modelId: "gpt-5",
            effort: "high",
            tokens: costed(200, 2),
            stepCount: 1,
          }),
          entry({
            providerId: "openai",
            modelId: "gpt-5",
            effort: "high",
            tokens: {
              ...costed(100, 0),
              apiEquivalentCostUsd: null,
              unpricedTokens: 100,
            },
            stepCount: 1,
          }),
        ]),
    }).usage({ range: "24h" });

    const section = snapshot.importedActivity[0];
    // Partial pricing mirrors CostedTokens: the priced read contributes, the
    // unpriced one is reported as incomplete instead of making the total null.
    expect(section?.models[0]?.tokens.apiEquivalentCostUsd).toBe(2);
    expect(section?.models[0]?.tokens.unpricedTokens).toBe(100);
    expect(section?.totals.apiEquivalentCostUsd).toBe(2);
    expect(section?.incomplete).toBe(true);
    expect(isUsageSnapshot(snapshot)).toBe(true);
  });

  it("serves all imported history for lifetime without a live quota account", async () => {
    const importedQueries: UsageActivityQuery[] = [];
    const snapshot = await build(undefined, {
      importStatus: async () => [{ harness: "codex", enabled: true, status: "ok" }],
      importedActivity: async (query) => {
        importedQueries.push(query);
        return aligned(query, () => [
          entry({
            providerId: "openai",
            modelId: "gpt-5",
            effort: "high",
            tokens: costed(10, 1),
            stepCount: 1,
            firstAtMs: at(30),
            lastAtMs: at(120),
          }),
        ]);
      },
    }).usage({ range: "lifetime" });

    // Lifetime is all imported history, even when there is no live account
    // whose quota axis could have supplied a span.
    expect(importedQueries[0]?.intervals).toEqual([{ startMs: 0, endMs: at(240) }]);
    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.importedActivity).toHaveLength(1);
    expect(snapshot.importedActivity[0]?.span).toEqual({ startMs: at(30), endMs: at(120) });
    expect(snapshot.importedActivity[0]?.totals.apiEquivalentCostUsd).toBe(1);
    expect(isUsageSnapshot(snapshot)).toBe(true);
  });

  it("does not fabricate an imported span for current", async () => {
    const importedQueries: UsageActivityQuery[] = [];
    const snapshot = await build(undefined, {
      importStatus: async () => [{ harness: "codex", enabled: true, status: "ok" }],
      importedActivity: async (query) => {
        importedQueries.push(query);
        return aligned(query, () => [entry({ providerId: "openai", modelId: "gpt-5" })]);
      },
    }).usage({ range: "current" });

    expect(snapshot.accounts).toEqual([]);
    expect(snapshot.importedActivity).toEqual([]);
    expect(importedQueries).toEqual([]);
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

  it("attributes each account when their observed epochs do not overlap", async () => {
    const db = await store();
    const first = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const second = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: first, remaining: 80 }]);
    record(db, at(1), [{ series: first, remaining: 70 }]);
    record(db, at(10), [{ series: second, remaining: 60 }]);
    record(db, at(11), [{ series: second, remaining: 55 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
    }).usage({ range: "lifetime" });

    expect(snapshot.accounts).toHaveLength(2);
    for (const account of snapshot.accounts) {
      const interval = account.windows[0]?.intervals[0];
      expect(interval?.attributedBurnPercentPoints).toBeGreaterThan(0);
      expect(interval?.unattributedReason).toBeUndefined();
    }
  });

  it("keeps a lone conflicted run inspectable and carries its stored source", async () => {
    const db = await store();
    const codex = series("codex-import:aaaaaa", "window:five_hour|quota:percent", {
      providerId: "openai",
      providerLabel: "OpenAI Codex (imported)",
      source: "codex-import",
    });
    record(db, at(0), [{ series: codex, remaining: 80 }]);
    record(db, at(1), [{ series: codex, remaining: 80 }]);
    record(db, at(0.5), [{ series: codex, remaining: 40 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => []),
    }).usage({ range: "lifetime" });

    expect(isUsageSnapshot(snapshot)).toBe(true);
    const window = snapshot.accounts[0]?.windows[0];
    expect(window?.points.map((point) => point.source)).toEqual(["codex-import"]);
    expect(window?.intervals[0]).toMatchObject({
      fromPoint: 0,
      toPoint: 0,
      link: "boundary",
      burnPercentPoints: null,
      conflictAtMs: at(0.5),
    });
  });

  it("marks an account ambiguous when a rival's older epoch overlaps its current interval", async () => {
    const db = await store();
    const first = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const second = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: first, remaining: 80 }]);
    record(db, at(1), [{ series: first, remaining: 70 }]);
    // The rival resets at minute 5; its older epoch still overlaps minutes 0-1.
    record(db, at(0), [{ series: second, remaining: 60 }]);
    record(db, at(0.5), [{ series: second, remaining: 60 }]);
    record(db, at(5), [{ series: second, remaining: 100 }]);
    record(db, at(6), [{ series: second, remaining: 90 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
    }).usage({ range: "current" });

    const firstAccount = snapshot.accounts.find((account) => account.accountKey === first.cardId);
    const interval = firstAccount?.windows[0]?.intervals[0];
    expect(interval?.burnPercentPoints).toBe(10);
    expect(interval?.attributedBurnPercentPoints).toBe(0);
    expect(interval?.unattributedReason).toBe("ambiguous-account");
  });

  it("isolates imported Codex quota history from rivals and OpenCode activity", async () => {
    const db = await store();
    const live = series("openai:aaaaaa", "window:five_hour|quota:percent", {
      providerId: "openai",
      providerLabel: "OpenAI",
    });
    // Legacy/adversarial imported series that shares the live provider id: the
    // source, not the id string, must decide isolation.
    const imported = series("codex-import:bbbbbb", "window:five_hour|quota:percent", {
      providerId: "openai",
      providerLabel: "OpenAI Codex (imported)",
      source: "codex-import",
    });
    record(db, at(0), [
      { series: live, remaining: 80 },
      { series: imported, remaining: 80 },
    ]);
    record(db, at(1), [
      { series: live, remaining: 70 },
      { series: imported, remaining: 70 },
    ]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [
        entry({ providerId: "openai", modelId: "gpt-5", effort: "high" }),
      ]),
    }).usage({ range: "24h" });

    // The imported series must not count as a rival coverage epoch: the live
    // account keeps its activity attribution.
    const liveInterval = snapshot.accounts.find((account) => account.accountKey === live.cardId)
      ?.windows[0]?.intervals[0];
    expect(liveInterval?.attributedBurnPercentPoints).toBe(10);
    expect(liveInterval?.unattributedReason).toBeUndefined();

    // Imported quota history has no OpenCode activity: its burn stays
    // unattributed rather than consuming the live account's hourly activity.
    const importedInterval = snapshot.accounts.find(
      (account) => account.accountKey === imported.cardId,
    )?.windows[0]?.intervals[0];
    expect(importedInterval?.burnPercentPoints).toBe(10);
    expect(importedInterval?.attributedBurnPercentPoints).toBe(0);
    expect(importedInterval?.unattributedBurnPercentPoints).toBe(10);
    expect(importedInterval?.unattributedReason).toBe("no-activity");
    expect(importedInterval?.activity).toEqual([]);
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

  it("keeps burn ambiguous when a second account is configured but was never measured", async () => {
    const db = await store();
    const measured = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: measured, remaining: 80 }]);
    record(db, at(1), [{ series: measured, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      // Two accounts exist for one provider; only one produced quota history.
      latestQuotaCards: () => [card("anthropic:aaaaaa", []), card("anthropic:bbbbbb", [])],
    }).usage({ range: "lifetime" });

    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.burnPercentPoints).toBe(10);
    expect(interval?.attributedBurnPercentPoints).toBe(0);
    expect(interval?.unattributedBurnPercentPoints).toBe(10);
    expect(interval?.unattributedReason).toBe("ambiguous-account");
  });

  it("keeps burn ambiguous when a rival account's quota request failed in the interval", async () => {
    const db = await store();
    const measured = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: measured, remaining: 80 }]);
    record(
      db,
      at(1),
      [{ series: measured, remaining: 70 }],
      [{ cardId: "anthropic:bbbbbb", providerId: "anthropic", kind: "error", atMs: at(0.5) }],
    );

    // No successful rival measurement exists, but the failed attempt proves the
    // rival account was live during the interval.
    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
    }).usage({ range: "lifetime" });

    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.burnPercentPoints).toBe(10);
    expect(interval?.attributedBurnPercentPoints).toBe(0);
    expect(interval?.unattributedReason).toBe("ambiguous-account");
  });

  it("still attributes burn for a provider with a single configured account", async () => {
    const db = await store();
    const sole = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: sole, remaining: 80 }]);
    record(db, at(1), [{ series: sole, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      latestQuotaCards: () => [card("anthropic:aaaaaa", [])],
    }).usage({ range: "lifetime" });

    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.attributedBurnPercentPoints).toBe(10);
    expect(interval?.unattributedBurnPercentPoints).toBe(0);
    expect(interval?.unattributedReason).toBeUndefined();
  });

  it("attributes an interval whose only rival was removed and never overlapped it", async () => {
    const db = await store();
    const kept = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const removed = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: kept, remaining: 80 }]);
    record(db, at(1), [{ series: kept, remaining: 70 }]);
    // The removed account was measured later; only its history remains.
    record(db, at(10), [{ series: removed, remaining: 60 }]);
    record(db, at(11), [{ series: removed, remaining: 55 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      latestQuotaCards: () => [card("anthropic:aaaaaa", [])],
    }).usage({ range: "lifetime" });

    const keptAccount = snapshot.accounts.find((account) => account.accountKey === kept.cardId);
    const interval = keptAccount?.windows[0]?.intervals[0];
    expect(interval?.attributedBurnPercentPoints).toBe(10);
    expect(interval?.unattributedReason).toBeUndefined();
  });

  it("attributes history that predates a rival's first recorded evidence", async () => {
    const db = await store();
    const kept = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const later = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: kept, remaining: 80 }]);
    record(db, at(1), [{ series: kept, remaining: 70 }]);
    // The rival enters the collector snapshot only at minute 10; the collector
    // records every configured account every cycle, so minutes 0-1 predate it.
    record(db, at(10), [{ series: later, remaining: 60 }]);
    record(db, at(11), [{ series: later, remaining: 55 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      latestQuotaCards: () => [card("anthropic:aaaaaa", []), card("anthropic:bbbbbb", [])],
    }).usage({ range: "lifetime" });

    const keptInterval = snapshot.accounts.find((account) => account.accountKey === kept.cardId)
      ?.windows[0]?.intervals[0];
    expect(keptInterval?.attributedBurnPercentPoints).toBe(10);
    expect(keptInterval?.unattributedReason).toBeUndefined();
    // The rival's own first interval still overlaps the kept account's presence,
    // which is live again now, so it stays ambiguous.
    const laterInterval = snapshot.accounts.find((account) => account.accountKey === later.cardId)
      ?.windows[0]?.intervals[0];
    expect(laterInterval?.unattributedReason).toBe("ambiguous-account");
  });

  it("marks only the newest interval ambiguous for a live rival with no recorded evidence", async () => {
    const db = await store();
    const kept = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: kept, remaining: 90 }]);
    record(db, at(1), [{ series: kept, remaining: 80 }]);
    record(db, at(2), [{ series: kept, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      // The second account was just configured: no cycle has recorded it yet,
      // so its configuration time is unknown and only "now" is proven.
      latestQuotaCards: () => [card("anthropic:aaaaaa", []), card("anthropic:bbbbbb", [])],
    }).usage({ range: "lifetime" });

    const intervals = snapshot.accounts[0]?.windows[0]?.intervals;
    expect(intervals?.map((interval) => interval.attributedBurnPercentPoints)).toEqual([10, 0]);
    expect(intervals?.[0]?.unattributedReason).toBeUndefined();
    expect(intervals?.[1]?.unattributedReason).toBe("ambiguous-account");
  });

  it("keeps a rival's presence conservative across a removal and re-add gap", async () => {
    const db = await store();
    const kept = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const rival = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: rival, remaining: 40 }]);
    record(db, at(1), [{ series: rival, remaining: 35 }]);
    record(db, at(5), [{ series: kept, remaining: 80 }]);
    record(db, at(6), [{ series: kept, remaining: 70 }]);
    record(db, at(10), [{ series: rival, remaining: 30 }]);
    record(db, at(11), [{ series: rival, remaining: 25 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      // The rival is not configured now; its span still brackets the interval.
      latestQuotaCards: () => [card("anthropic:aaaaaa", [])],
    }).usage({ range: "lifetime" });

    const keptInterval = snapshot.accounts.find((account) => account.accountKey === kept.cardId)
      ?.windows[0]?.intervals[0];
    expect(keptInterval?.burnPercentPoints).toBe(10);
    expect(keptInterval?.unattributedReason).toBe("ambiguous-account");
  });

  it("attributes an interval that ends before a removed rival's first evidence", async () => {
    const db = await store();
    const kept = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const removed = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: removed, remaining: 60 }]);
    record(db, at(1), [{ series: removed, remaining: 55 }]);
    record(db, at(10), [{ series: kept, remaining: 80 }]);
    record(db, at(11), [{ series: kept, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      latestQuotaCards: () => [card("anthropic:aaaaaa", [])],
    }).usage({ range: "lifetime" });

    const keptAccount = snapshot.accounts.find((account) => account.accountKey === kept.cardId);
    const interval = keptAccount?.windows[0]?.intervals[0];
    expect(interval?.attributedBurnPercentPoints).toBe(10);
    expect(interval?.unattributedReason).toBeUndefined();
  });

  it("never calls the store's first cycle sole when two accounts enter together", async () => {
    const db = await store();
    const first = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    const second = series("anthropic:bbbbbb", "window:five_hour|quota:percent");
    // History starts with the store: neither account predates the other.
    for (const minute of [0, 1]) {
      record(db, at(minute), [
        { series: first, remaining: minute === 0 ? 80 : 70 },
        { series: second, remaining: minute === 0 ? 60 : 55 },
      ]);
    }

    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
      latestQuotaCards: () => [card("anthropic:aaaaaa", []), card("anthropic:bbbbbb", [])],
    }).usage({ range: "lifetime" });

    for (const account of snapshot.accounts) {
      const interval = account.windows[0]?.intervals[0];
      expect(interval?.attributedBurnPercentPoints).toBe(0);
      expect(interval?.unattributedReason).toBe("ambiguous-account");
    }
  });

  it("reports a failed rival in the current range", async () => {
    const db = await store();
    const kept = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: kept, remaining: 80 }]);
    record(
      db,
      at(1),
      [{ series: kept, remaining: 70 }],
      [{ cardId: "anthropic:bbbbbb", providerId: "anthropic", kind: "cooldown", atMs: at(0.5) }],
    );

    // The latest-epoch read must carry interruption evidence: a rival that only
    // ever failed still defeats a "sole account" claim.
    const snapshot = await build(db, {
      activity: activityReturning(() => [entry()]),
    }).usage({ range: "current" });

    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.burnPercentPoints).toBe(10);
    expect(interval?.unattributedReason).toBe("ambiguous-account");
  });
});

describe("usage snapshot: history availability", () => {
  it("distinguishes a fresh install from an unreadable history database", async () => {
    const fresh = await build(undefined, { path: join(root, "missing.sqlite") }).usage({
      range: "7d",
    });
    expect(fresh.historyUnavailable).toBeUndefined();
    expect(fresh.accounts).toEqual([]);

    await writeFile(path, "not a usage-history database");
    const broken = await build(undefined, { path }).usage({ range: "7d" });
    expect(broken.historyUnavailable).toBe(true);
    expect(broken.accounts).toEqual([]);
    expect(isUsageSnapshot(broken)).toBe(true);
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

  it("starts the current axis at a proven exact reset", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent", { label: "5h" });
    record(db, at(0), [{ series: fiveHour, remaining: 80, resetAtMs: at(1) }]);
    record(db, at(2), [{ series: fiveHour, remaining: 95, resetAtMs: at(4) }]);

    const snapshot = await build(db, {
      now: () => at(3),
      activity: activityReturning(() => []),
    }).usage({ range: "current" });

    const window = snapshot.accounts[0]?.windows[0];
    // The window began at the provider's exact reset, so the axis covers the
    // prefix that was never observed while the point stays where it was seen.
    expect(window?.axis).toEqual({ startMs: at(1), endMs: at(4) });
    expect(window?.points.map((point) => point.remainingPercent)).toEqual([95]);
    expect(window?.points[0]?.startMs).toBe(at(2));
    expect(window?.coverage.firstObservedAtMs).toBe(at(2));
    expect(window?.totals.observedBurnPercentPoints).toBe(0);
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
  it("never certifies attribution from an activity index that does not cover the intervals", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: async (query) => ({
        ...aligned(query, () => [entry()]),
        coverage: { complete: false, stale: true },
      }),
    }).usage({ range: "lifetime" });

    // A partially indexed or stale index cannot prove that no activity was
    // missed, so no interval may be certified as completely attributed.
    expect(snapshot.activityUnavailable).toBe(true);
    expect(snapshot.models).toEqual([]);
    const window = snapshot.accounts[0]?.windows[0];
    // Recorded quota history stays available and displayed.
    expect(window?.points).toHaveLength(2);
    expect(window?.intervals[0]?.burnPercentPoints).toBe(10);
    expect(window?.intervals[0]?.attributedBurnPercentPoints).toBe(0);
    expect(window?.intervals[0]?.unattributedBurnPercentPoints).toBe(10);
    expect(window?.intervals[0]?.activity).toEqual([]);
    expect(window?.breakdown).toEqual([]);
  });

  it("attributes burn when the activity index certifies its coverage", async () => {
    const db = await store();
    const fiveHour = series("anthropic:aaaaaa", "window:five_hour|quota:percent");
    record(db, at(0), [{ series: fiveHour, remaining: 80 }]);
    record(db, at(1), [{ series: fiveHour, remaining: 70 }]);

    const snapshot = await build(db, {
      activity: async (query) => ({
        ...aligned(query, () => [entry()]),
        coverage: { complete: true, stale: false },
      }),
    }).usage({ range: "lifetime" });

    expect(snapshot.activityUnavailable).toBeUndefined();
    const interval = snapshot.accounts[0]?.windows[0]?.intervals[0];
    expect(interval?.attributedBurnPercentPoints).toBe(10);
    expect(interval?.unattributedReason).toBeUndefined();
  });

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
  it("names identity-less import sessions as unknown accounts, told apart by session", async () => {
    const db = await store();
    const first = series("codex-import:unknown:aa11bb22cc33", "window:five_hour|quota:percent", {
      providerLabel: "Codex",
    });
    const second = series("codex-import:unknown:dd44ee55ff66", "window:five_hour|quota:percent", {
      providerLabel: "Codex",
    });
    const bare = series("codex-import:unknown", "window:week|quota:percent", {
      providerLabel: "Codex",
    });
    record(db, at(0), [
      { series: first, remaining: 80 },
      { series: second, remaining: 60 },
      { series: bare, remaining: 50 },
    ]);

    const snapshot = await build(db, { now: () => at(1) }).usage({ range: "lifetime" });
    expect(snapshot.accounts.map((account) => account.accountLabel).sort()).toEqual([
      "Codex unknown account",
      "Codex unknown account aa11bb",
      "Codex unknown account dd44ee",
    ]);
  });

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
