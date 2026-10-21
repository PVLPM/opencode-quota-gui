import { describe, expect, it, vi } from "vitest";

import type { HomeSnapshot } from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import type { AnalyticsTransport } from "../src/gui/analytics-protocol.js";
import { createAnalyticsReadService } from "../src/gui/analytics-service.js";
import { createGuiLogger } from "../src/gui/log.js";
import { createSnapshotService, type SnapshotSource } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const logger = createGuiLogger({ sink: () => {} });

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
});
