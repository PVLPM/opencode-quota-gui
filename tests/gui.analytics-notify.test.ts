import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CostedTokens, HomeSnapshot } from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import type { UsageActivityEntry, UsageActivityQuery } from "../src/contracts/usage-activity.js";
import type { AnalyticsTransport } from "../src/gui/analytics-protocol.js";
import { createAnalyticsReadService } from "../src/gui/analytics-service.js";
import { createGuiLogger } from "../src/gui/log.js";
import { createSnapshotService, type SnapshotSource } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import { createUsageSnapshotBuilder } from "../src/gui/usage-service.js";
import {
  openUsageStore,
  type UsageCycleSample,
  type UsageSeriesMetadata,
  type UsageStore,
} from "../src/lib/usage-store.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const MINUTE = 60_000;
const logger = createGuiLogger({ sink: () => {} });

const roots: string[] = [];
const stores: UsageStore[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // best effort
    }
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

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

function entry(): UsageActivityEntry {
  return {
    providerId: "anthropic",
    modelId: "claude-sonnet",
    tokens: costed(100, 1),
    stepCount: 2,
  };
}

/** Aligned with the query; certification comes from the caller's coverage. */
function activityIntervals(query: UsageActivityQuery) {
  return query.intervals.map((interval) => ({
    startMs: interval.startMs,
    endMs: interval.endMs,
    entries: [entry()],
    incomplete: false,
    unpricedTokens: 0,
    unknownTokens: 0,
  }));
}

function usageSeries(): UsageSeriesMetadata {
  return {
    rowId: "anthropic:aaaaaa#window:five_hour|quota:percent",
    cardId: "anthropic:aaaaaa",
    rowKey: "window:five_hour|quota:percent",
    providerId: "anthropic",
    providerLabel: "Anthropic",
    label: "5h",
    metricJson: JSON.stringify({ kind: "window", window: "five_hour" }),
    measurement: "provider-observed",
    source: "opencode-poll",
  };
}

async function storeWithBurn(): Promise<UsageStore> {
  const root = await mkdtemp(join(tmpdir(), "ocq-usage-notify-"));
  roots.push(root);
  const opened = await openUsageStore(join(root, "usage-history.sqlite"));
  stores.push(opened);
  const series = usageSeries();
  [80, 70].forEach((remaining, index) => {
    const sample: UsageCycleSample = {
      series,
      remainingPercent: remaining,
      measuredAtMs: NOW + index * MINUTE,
    };
    opened.recordCycle({
      collectorRunId: `run-${index}`,
      collectorSessionId: "session-1",
      intervalMs: MINUTE,
      observedCards: [
        { cardId: series.cardId, providerId: series.providerId, atMs: sample.measuredAtMs },
      ],
      providerIds: [series.providerId],
      samples: [sample],
      interruptions: [],
      nowMs: sample.measuredAtMs,
    });
  });
  return opened;
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function homeFor(range: RangeKey, input: number): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: [], polledAtMs: NOW },
    usage: {
      range,
      window: range === "lifetime" ? { untilMs: NOW } : { sinceMs: NOW - 3_600_000, untilMs: NOW },
      bucketUnit: "hour",
      timeZone: "UTC",
      buckets: [],
      totals: {
        input,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: input,
        apiEquivalentCostUsd: null,
        unpricedTokens: 0,
        unknownTokens: 0,
      },
      stepCount: 1,
      sessionCount: 1,
      stale: false,
    },
    projects: [],
  };
}

describe("analytics generation notifications", () => {
  it("re-derives cached analytics and emits sessions.changed immediately", async () => {
    let homeCalls = 0;
    let refreshCalls = 0;
    const subscriptions = new Set<() => void>();
    const source: SnapshotSource = {
      home: async ({ range }) => {
        homeCalls += 1;
        return homeFor(range, homeCalls);
      },
      project: async () => {
        throw new Error("unused");
      },
      session: async () => {
        throw new Error("unused");
      },
      refreshAnalytics: async () => {
        refreshCalls += 1;
      },
      subscribeAnalytics(listener) {
        subscriptions.add(listener);
        return () => subscriptions.delete(listener);
      },
    };
    const service = createSnapshotService({
      source,
      analyticsIntervalMs: 600_000,
      now: () => NOW,
      logger,
    });
    const topics: string[] = [];
    service.subscribe((event) => topics.push(event.topic));
    const release = service.addViewer();
    await service.home({ range: "24h" });
    expect(homeCalls).toBe(1);

    for (const listener of subscriptions) listener();
    await vi.waitFor(() => expect(homeCalls).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(topics).toContain("sessions.changed"));
    expect(topics.filter((topic) => topic === "sessions.changed")).toHaveLength(1);
    // A notification means data is already fresh; it must not force another
    // analytics refresh (that would create a feedback loop).
    expect(refreshCalls).toBe(0);

    release();
    // Notifications after the viewer session ends must not run work.
    for (const listener of subscriptions) listener();
    await flushAsync();
    expect(homeCalls).toBe(2);
    service.close();
  });

  it("subscribing alone never creates the analytics service", async () => {
    const createAnalyticsService = vi.fn();
    const source = createDashboardReadSource({
      client: {} as never,
      workspaceRoot: ".",
      createAnalyticsService: createAnalyticsService as never,
    });
    const unsubscribe = source.subscribeAnalytics?.(() => {});
    expect(createAnalyticsService).not.toHaveBeenCalled();
    unsubscribe?.();
    await source.close?.();
  });

  it("forwards the source notification only after analytics is initialized", async () => {
    let notify: (() => void) | undefined;
    const createAnalyticsService = vi.fn(() => ({
      async home({ range }: { range: RangeKey }) {
        return homeFor(range, 1);
      },
      async project() {
        throw new Error("unused");
      },
      async session() {
        throw new Error("unused");
      },
      async refresh() {},
      subscribe(listener: () => void) {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      async close() {},
    }));
    const source = createDashboardReadSource({
      client: {} as never,
      workspaceRoot: ".",
      createAnalyticsService: createAnalyticsService as never,
    });
    let delivered = 0;
    const unsubscribe = source.subscribeAnalytics?.(() => {
      delivered += 1;
    });
    expect(createAnalyticsService).not.toHaveBeenCalled();

    await source.home({ range: "24h" });
    expect(createAnalyticsService).toHaveBeenCalledTimes(1);
    notify?.();
    expect(delivered).toBe(1);
    unsubscribe?.();
    await source.close?.();
  });

  it("turns a completed background refresh into one fresh SSE event", async () => {
    let notify: (() => void) | undefined;
    let version = 1;
    let refreshCalls = 0;
    const transport: AnalyticsTransport = {
      async init() {},
      async home(range) {
        return homeFor(range, version);
      },
      async project() {
        throw new Error("unused");
      },
      async session() {
        throw new Error("unused");
      },
      async refresh() {
        refreshCalls += 1;
        version += 1;
        notify?.();
      },
      subscribe(listener) {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      async close() {},
    };
    const analytics = createAnalyticsReadService({ createTransport: () => transport });
    const source = createDashboardReadSource({
      client: {} as never,
      workspaceRoot: ".",
      analyticsService: analytics,
    });
    const snapshots = createSnapshotService({
      source,
      analyticsIntervalMs: 600_000,
      now: () => NOW,
      logger,
    });
    const topics: string[] = [];
    snapshots.subscribe((event) => topics.push(event.topic));
    const release = snapshots.addViewer();
    const initial = await snapshots.home({ range: "24h" });
    expect(initial.usage.totals.input).toBe(1);

    // Simulate the worker background refresh completing and notifying the host.
    await transport.refresh();
    await vi.waitFor(() =>
      expect(topics.filter((topic) => topic === "sessions.changed")).toHaveLength(1),
    );
    const fresh = await snapshots.home({ range: "24h" });
    expect(fresh.usage.totals.input).toBe(2);
    // The notification path derived fresh data; it did not force another refresh.
    expect(refreshCalls).toBe(1);

    release();
    snapshots.close();
    await source.close?.();
  });

  it("exposes the internal activity read without touching quota polling", async () => {
    const transport: AnalyticsTransport = {
      async init() {},
      async home(range) {
        return homeFor(range, 0);
      },
      async project() {
        throw new Error("unused");
      },
      async session() {
        throw new Error("unused");
      },
      async groups() {
        throw new Error("unused");
      },
      async refresh() {},
      async activity(query) {
        return {
          intervals: query.intervals.map(({ startMs, endMs }) => ({
            startMs,
            endMs,
            entries: [],
            incomplete: false,
            unpricedTokens: 0,
            unknownTokens: 0,
          })),
        };
      },
      async close() {},
    };
    const analytics = createAnalyticsReadService({ createTransport: () => transport });
    const collectProviderResults = vi.fn();
    const source = createDashboardReadSource({
      client: {} as never,
      workspaceRoot: ".",
      analyticsService: analytics,
      collectProviderResults,
    });

    const result = await source.activity({
      intervals: [{ startMs: NOW - 3_600_000, endMs: NOW }],
      providerIds: ["openai"],
    });
    expect(result.intervals[0]?.startMs).toBe(NOW - 3_600_000);
    expect(collectProviderResults).not.toHaveBeenCalled();
    await source.close?.();
  });

  it("re-derives the active Usage snapshot when only the coverage advances", async () => {
    const store = await storeWithBurn();
    // The index behind attribution reaches past the recorded quota history
    // until the queued refresh advances it.
    let coveredUntilMs = NOW;
    let usageReads = 0;
    const usage = createUsageSnapshotBuilder({
      store,
      now: () => NOW + MINUTE,
      timeZone: "UTC",
      activity: async (query) => ({
        intervals: activityIntervals(query),
        coverage: { complete: coveredUntilMs >= NOW + MINUTE, stale: false },
      }),
    });
    let notify: (() => void) | undefined;
    const source: SnapshotSource = {
      home: async () => {
        throw new Error("unused");
      },
      project: async () => {
        throw new Error("unused");
      },
      session: async () => {
        throw new Error("unused");
      },
      usage: async (input) => {
        usageReads += 1;
        return usage.usage(input);
      },
      subscribeAnalytics(listener) {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const service = createSnapshotService({
      source,
      analyticsIntervalMs: 600_000,
      quotaIntervalMs: 600_000,
      now: () => NOW + MINUTE,
      logger,
    });
    const topics: string[] = [];
    service.subscribe((event) => topics.push(event.topic));
    const release = service.addViewer();
    // Usage lives in the Quota area: it is the only active surface here.
    service.setViewScope("quota");

    const first = await service.usage({ range: "lifetime" });
    expect(first.activityUnavailable).toBe(true);
    expect(first.accounts[0]?.windows[0]?.intervals[0]?.attributedBurnPercentPoints).toBe(0);
    expect(topics).toEqual([]);

    // The background refresh advanced the extent without changing any indexed
    // row, so the generation notification is the only coverage signal.
    coveredUntilMs = NOW + MINUTE;
    notify?.();
    await vi.waitFor(() => expect(topics).toContain("quota.changed"));

    const published = await service.usage({ range: "lifetime" });
    expect(published.activityUnavailable).toBeUndefined();
    expect(published.accounts[0]?.windows[0]?.intervals[0]?.attributedBurnPercentPoints).toBe(10);
    expect(published.accounts[0]?.windows[0]?.breakdown).toHaveLength(1);
    // The notification re-derived the page; the read above joined that result
    // instead of starting a third compute.
    expect(usageReads).toBe(2);
    expect(topics.filter((topic) => topic === "quota.changed")).toHaveLength(1);

    release();
    service.close();
  });
});
