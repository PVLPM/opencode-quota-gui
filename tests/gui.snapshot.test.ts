import { describe, expect, it, vi } from "vitest";
import type {
  CostedTokens,
  DashboardEvent,
  HomeSnapshot,
  ProjectSnapshot,
  ProviderCard,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import { createGuiLogger } from "../src/gui/log.js";
import {
  createSnapshotService,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_TRACKED_PAGES,
  type SnapshotService,
  type SnapshotSource,
} from "../src/gui/snapshot-service.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");

function quiet() {
  return createGuiLogger({ sink: () => {} });
}

function costed(total: number): CostedTokens {
  return {
    input: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function countdownCard(countdown: string): ProviderCard {
  // SAFETY: CardId/RowId are compile-time-only string brands; the literals below
  // are the exact id texts asserted by the snapshot tests.
  return {
    cardId: "alpha#card-1" as CardId,
    providerId: "alpha",
    providerLabel: "Alpha",
    labelSource: "provider",
    rows: [
      {
        rowId: "alpha#card-1#aggregate" as RowId,
        label: "Quota",
        kind: "percent",
        resultType: "quota",
        percentRemaining: 50,
        countdown,
      },
    ],
    errors: [],
  };
}

function usageFor(range: RangeKey, total: number): HomeSnapshot["usage"] {
  return {
    range,
    window: rangeWindow(range, NOW),
    bucketUnit: rangeBucketUnit(range),
    buckets: planRangeBuckets(range, NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
    totals: costed(total),
    stepCount: 1,
    sessionCount: 1,
    stale: false,
  };
}

function home(
  range: RangeKey,
  variant: {
    total?: number;
    generatedAtMs?: number;
    polledAtMs?: number;
    countdown?: string;
  } = {},
): HomeSnapshot {
  const total = variant.total ?? 10;
  return {
    generatedAtMs: variant.generatedAtMs ?? NOW,
    range,
    stale: false,
    providers: {
      cards: variant.countdown === undefined ? [] : [countdownCard(variant.countdown)],
      enabledProviders: "auto",
      polledAtMs: variant.polledAtMs ?? NOW,
    },
    usage: usageFor(range, total),
    projects: [
      {
        projectId: "p1",
        name: "Project 1",
        tokens: costed(total),
        rootSessionCount: 1,
        latestActivityAtMs: NOW,
      },
    ],
  };
}

function project(range: RangeKey, projectId = "p1", total = 5): ProjectSnapshot {
  return {
    projectId,
    name: `Project ${projectId}`,
    range,
    window: rangeWindow(range, NOW),
    roots: [{ sessionId: "s1", title: "Root", tokens: costed(total), latestActivityAtMs: NOW }],
    totals: { ...costed(total), sessionCount: 1 },
    usage: usageFor(range, total),
    stale: false,
  };
}

function session(sessionId = "s1"): SessionSnapshot {
  return {
    focusSessionId: sessionId,
    breadcrumbs: [{ sessionId, title: "Root", isFocus: true }],
    nodes: [
      {
        sessionId,
        title: "Root",
        depth: 0,
        childIds: [],
        ownTokens: costed(3),
        subtreeTokens: costed(3),
        stepCount: 1,
        subtreeNodeCount: 1,
        latestActivityAtMs: NOW,
      },
    ],
    steps: [
      {
        sessionId,
        messageId: "m1",
        atMs: NOW,
        branch: 0,
        stack: { input: 3, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
        contextTokens: 3,
        totalTokens: 3,
      },
    ],
    compactionMarkers: [],
    ownSummary: { ...costed(3), stepCount: 1 },
    treeTotals: costed(3),
    stepSemantics: "one completed assistant message row is one step",
  };
}

interface FakeSource {
  calls: { home: number; project: number; session: number };
  source: SnapshotSource;
}

function fakeSource(overrides: Partial<SnapshotSource> = {}): FakeSource {
  const calls = { home: 0, project: 0, session: 0 };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      calls.home += 1;
      return home(range);
    },
    project: async ({ projectId, range }) => {
      calls.project += 1;
      return project(range, projectId);
    },
    session: async ({ sessionId }) => {
      calls.session += 1;
      return session(sessionId);
    },
    ...overrides,
  };
  return { calls, source };
}

function makeService(
  source: SnapshotSource,
  extra: { minIntervalMs?: number | (() => number) } = {},
): SnapshotService {
  return createSnapshotService({ source, logger: quiet(), ...extra });
}

/** Project source that records one count per projectId. */
function countedProjectSource(): { calls: Map<string, number>; source: SnapshotSource } {
  const calls = new Map<string, number>();
  const source: SnapshotSource = {
    home: async ({ range }) => home(range),
    project: async ({ projectId, range }) => {
      calls.set(projectId, (calls.get(projectId) ?? 0) + 1);
      return project(range, projectId);
    },
    session: async ({ sessionId }) => session(sessionId),
  };
  return { calls, source };
}

describe("GUI snapshot service", () => {
  it("shares one in-flight computation per cache key", async () => {
    let release!: (value: HomeSnapshot) => void;
    const pending = new Promise<HomeSnapshot>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { source } = fakeSource({
      home: () => {
        calls += 1;
        return pending;
      },
    });
    const service = makeService(source);

    const first = service.home({ range: "7d" });
    const second = service.home({ range: "7d" });
    expect(calls).toBe(1);

    release(home("7d"));
    await expect(first).resolves.toEqual(home("7d"));
    await expect(second).resolves.toEqual(home("7d"));
    expect(calls).toBe(1);

    await expect(service.home({ range: "7d" })).resolves.toEqual(home("7d"));
    expect(calls).toBe(1);
  });

  it("keys the cache by kind, resource id and range", async () => {
    const { calls, source } = fakeSource();
    const service = makeService(source);

    await service.home({ range: "7d" });
    await service.home({ range: "7d" });
    expect(calls.home).toBe(1);
    await service.home({ range: "24h" });
    expect(calls.home).toBe(2);

    await service.project({ projectId: "p1", range: "7d" });
    await service.project({ projectId: "p1", range: "7d" });
    expect(calls.project).toBe(1);
    await service.project({ projectId: "p2", range: "7d" });
    expect(calls.project).toBe(2);
    await service.project({ projectId: "p1", range: "24h" });
    expect(calls.project).toBe(3);

    await service.session({ sessionId: "s1" });
    await service.session({ sessionId: "s1" });
    expect(calls.session).toBe(1);
    await service.session({ sessionId: "s2" });
    expect(calls.session).toBe(2);
  });

  it("polls only the bounded most recently loaded pages after churn", async () => {
    vi.useFakeTimers();
    const { calls, source } = countedProjectSource();
    const service = makeService(source, { minIntervalMs: 50 });
    const pageCount = MAX_TRACKED_PAGES + 3;
    for (let index = 0; index < pageCount; index += 1) {
      await service.project({ projectId: `p${index}`, range: "7d" });
    }

    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(60);
    for (let index = 0; index < 3; index += 1) {
      expect(calls.get(`p${index}`)).toBe(1);
    }
    for (let index = 3; index < pageCount; index += 1) {
      expect(calls.get(`p${index}`)).toBe(2);
    }

    // Another tick does not change which keys are registered.
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.get("p0")).toBe(1);
    expect(calls.get(`p${pageCount - 1}`)).toBe(3);
    viewer();
  });

  it("refreshes a revisited page and keeps it in the bounded poll set", async () => {
    vi.useFakeTimers();
    const { calls, source } = countedProjectSource();
    const service = makeService(source, { minIntervalMs: 50 });
    for (let index = 0; index <= MAX_TRACKED_PAGES; index += 1) {
      await service.project({ projectId: `p${index}`, range: "7d" });
    }
    expect(calls.get("p0")).toBe(1);

    // p0 was evicted by the churn above: revisiting it is a real load again.
    await service.project({ projectId: "p0", range: "7d" });
    expect(calls.get("p0")).toBe(2);
    await service.project({ projectId: `p${MAX_TRACKED_PAGES + 1}`, range: "7d" });

    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.get("p0")).toBe(3);
    expect(calls.get("p1")).toBe(1);
    expect(calls.get(`p${MAX_TRACKED_PAGES + 1}`)).toBe(2);
    viewer();
  });

  it("resolves an evicted in-flight request without caching or re-registering it", async () => {
    vi.useFakeTimers();
    let resolveTarget!: (value: ProjectSnapshot) => void;
    let targetCalls = 0;
    let otherCalls = 0;
    const source: SnapshotSource = {
      home: async ({ range }) => home(range),
      project: ({ projectId, range }) => {
        if (projectId === "target") {
          targetCalls += 1;
          if (targetCalls === 1) {
            return new Promise<ProjectSnapshot>((resolve) => {
              resolveTarget = resolve;
            });
          }
          return Promise.resolve(project(range, projectId));
        }
        otherCalls += 1;
        return Promise.resolve(project(range, projectId));
      },
      session: async ({ sessionId }) => session(sessionId),
    };
    const service = makeService(source, { minIntervalMs: 50 });

    const target = service.project({ projectId: "target", range: "7d" });
    expect(targetCalls).toBe(1);
    for (let index = 0; index < MAX_TRACKED_PAGES; index += 1) {
      await service.project({ projectId: `p${index}`, range: "7d" });
    }
    expect(otherCalls).toBe(MAX_TRACKED_PAGES);

    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(60);
    expect(targetCalls).toBe(1);
    expect(otherCalls).toBe(MAX_TRACKED_PAGES * 2);

    resolveTarget(project("7d", "target", 77));
    await expect(target).resolves.toEqual(project("7d", "target", 77));

    // The late completion is not polled...
    await vi.advanceTimersByTimeAsync(60);
    expect(targetCalls).toBe(1);

    // ...and it did not reinsert a cache entry: a fresh load recomputes.
    await expect(service.project({ projectId: "target", range: "7d" })).resolves.toEqual(
      project("7d", "target"),
    );
    expect(targetCalls).toBe(2);

    await vi.advanceTimersByTimeAsync(60);
    expect(targetCalls).toBe(3);
    viewer();
  });

  it("drops a late poll result for a page evicted mid-poll", async () => {
    vi.useFakeTimers();
    let deferPoll = false;
    let resolveSlow!: (value: ProjectSnapshot) => void;
    const counts = new Map<string, number>();
    const source: SnapshotSource = {
      home: async ({ range }) => home(range),
      project: ({ projectId, range }) => {
        counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
        if (projectId === "slow" && deferPoll) {
          deferPoll = false;
          return new Promise<ProjectSnapshot>((resolve) => {
            resolveSlow = resolve;
          });
        }
        return Promise.resolve(project(range, projectId));
      },
      session: async ({ sessionId }) => session(sessionId),
    };
    const service = makeService(source, { minIntervalMs: 50 });
    await service.project({ projectId: "slow", range: "7d" });
    for (let index = 0; index < MAX_TRACKED_PAGES - 1; index += 1) {
      await service.project({ projectId: `old${index}`, range: "7d" });
    }

    deferPoll = true;
    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(60);
    expect(counts.get("slow")).toBe(2);

    // Evict `slow` (and every page loaded before it) while its poll is pending.
    for (let index = 0; index < MAX_TRACKED_PAGES; index += 1) {
      await service.project({ projectId: `new${index}`, range: "7d" });
    }

    resolveSlow(project("7d", "slow", 99));
    await vi.advanceTimersByTimeAsync(0);

    // The late poll result neither cached nor re-registered the evicted pages.
    await vi.advanceTimersByTimeAsync(60);
    expect(counts.get("slow")).toBe(2);
    expect(counts.get("old0")).toBe(1);
    await service.project({ projectId: "slow", range: "7d" });
    expect(counts.get("slow")).toBe(3);
    viewer();
  });

  it("clears registrations on the last viewer disconnect and re-arms only loaded pages", async () => {
    vi.useFakeTimers();
    const { calls, source } = fakeSource();
    const service = makeService(source, { minIntervalMs: 50 });
    await service.home({ range: "7d" });
    await service.project({ projectId: "p1", range: "7d" });

    let viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.home).toBe(2);
    expect(calls.project).toBe(2);

    viewer();
    viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(120);
    expect(calls.home).toBe(2);
    expect(calls.project).toBe(2);

    // A reconnect polls only what is loaded again; retained cache stays dirty.
    await service.home({ range: "7d" });
    expect(calls.home).toBe(3);
    await vi.advanceTimersByTimeAsync(60);
    expect(calls.home).toBe(4);
    expect(calls.project).toBe(2);
    viewer();
  });

  it("abandons an in-flight tick when the last viewer disconnects", async () => {
    vi.useFakeTimers();
    let firstCalls = 0;
    let secondCalls = 0;
    let resolveFirstPoll!: (value: ProjectSnapshot) => void;
    const source: SnapshotSource = {
      home: async ({ range }) => home(range),
      project: ({ projectId, range }) => {
        if (projectId === "first") {
          firstCalls += 1;
          if (firstCalls === 2) {
            return new Promise<ProjectSnapshot>((resolve) => {
              resolveFirstPoll = resolve;
            });
          }
          return Promise.resolve(project(range, projectId, firstCalls === 1 ? 10 : 20));
        }
        secondCalls += 1;
        return Promise.resolve(project(range, projectId, 5));
      },
      session: async ({ sessionId }) => session(sessionId),
    };
    const service = makeService(source, { minIntervalMs: 50 });
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.project({ projectId: "first", range: "7d" });
    await service.project({ projectId: "second", range: "7d" });

    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(60);
    expect(firstCalls).toBe(2);

    // The viewer leaves while the first poll of the tick is still pending.
    viewer();

    resolveFirstPoll(project("7d", "first", 99));
    await vi.advanceTimersByTimeAsync(120);

    // No late snapshot accepted, no invalidation, and no next key polled.
    expect(events).toEqual([]);
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(1);

    // A reconnect polls nothing until a page is loaded again; the still-dirty
    // retained entry recomputes instead of serving the abandoned late result.
    const reconnected = service.addViewer();
    await vi.advanceTimersByTimeAsync(120);
    expect(firstCalls).toBe(2);
    expect(secondCalls).toBe(1);

    const refreshed = await service.project({ projectId: "first", range: "7d" });
    expect(refreshed.totals.total).toBe(20);
    expect(firstCalls).toBe(3);
    expect(events).toEqual([]);
    reconnected();
  });

  it("does not let a pre-disconnect load re-freshen a dirtied page", async () => {
    let calls = 0;
    let deferred = false;
    let resolveOld!: (value: HomeSnapshot) => void;
    let total = 10;
    const { source } = fakeSource({
      home: ({ range }) => {
        calls += 1;
        if (deferred) {
          deferred = false;
          return new Promise<HomeSnapshot>((resolve) => {
            resolveOld = resolve;
          });
        }
        return Promise.resolve(home(range, { total }));
      },
    });
    const service = makeService(source);

    const viewer = service.addViewer();
    deferred = true;
    const old = service.home({ range: "7d" });
    expect(calls).toBe(1);

    // The viewer leaves (dirtying retained entries) before the load settles.
    viewer();
    total = 20;
    resolveOld(home("7d", { total: 10 }));
    await expect(old).resolves.toEqual(home("7d", { total: 10 }));

    // The reconnect load recomputes and caches within the new viewer epoch.
    const refreshed = await service.home({ range: "7d" });
    expect(refreshed.stale).toBe(false);
    expect(refreshed.usage.totals.total).toBe(20);
    expect(calls).toBe(2);

    await service.home({ range: "7d" });
    expect(calls).toBe(2);
  });

  it("runs a fresh compute when a reconnect load finds a pre-disconnect task pending", async () => {
    let calls = 0;
    let resolveOld!: (value: HomeSnapshot) => void;
    let resolveNew!: (value: HomeSnapshot) => void;
    const { source } = fakeSource({
      home: () =>
        new Promise<HomeSnapshot>((resolve) => {
          calls += 1;
          if (calls === 1) resolveOld = resolve;
          else resolveNew = resolve;
        }),
    });
    const service = makeService(source);
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    const viewer = service.addViewer();
    const old = service.home({ range: "7d" });
    viewer();

    // The reconnect request must not join the pre-disconnect task.
    const fresh = service.home({ range: "7d" });
    expect(calls).toBe(2);

    // The newer result completes first and commits.
    resolveNew(home("7d", { total: 20 }));
    await expect(fresh).resolves.toEqual(home("7d", { total: 20 }));

    // The late old result still resolves its caller but cannot overwrite it.
    resolveOld(home("7d", { total: 10 }));
    await expect(old).resolves.toEqual(home("7d", { total: 10 }));

    const cached = await service.home({ range: "7d" });
    expect(cached.usage.totals.total).toBe(20);
    expect(calls).toBe(2);
    expect(events).toEqual([]);
  });

  it("keeps the reconnect task intact when the old pending load settles first", async () => {
    let calls = 0;
    let resolveOld!: (value: HomeSnapshot) => void;
    let resolveNew!: (value: HomeSnapshot) => void;
    const { source } = fakeSource({
      home: () =>
        new Promise<HomeSnapshot>((resolve) => {
          calls += 1;
          if (calls === 1) resolveOld = resolve;
          else resolveNew = resolve;
        }),
    });
    const service = makeService(source);

    const viewer = service.addViewer();
    const old = service.home({ range: "7d" });
    viewer();
    const fresh = service.home({ range: "7d" });
    expect(calls).toBe(2);

    // The old task settles first; it must not delete the current inflight task.
    resolveOld(home("7d", { total: 10 }));
    await expect(old).resolves.toEqual(home("7d", { total: 10 }));

    const joined = service.home({ range: "7d" });
    expect(calls).toBe(2);

    resolveNew(home("7d", { total: 20 }));
    await expect(fresh).resolves.toEqual(home("7d", { total: 20 }));
    await expect(joined).resolves.toEqual(home("7d", { total: 20 }));

    const cached = await service.home({ range: "7d" });
    expect(cached.usage.totals.total).toBe(20);
    expect(calls).toBe(2);
  });

  it("cleans up on close while a pending result still resolves its caller", async () => {
    vi.useFakeTimers();
    let release!: (value: HomeSnapshot) => void;
    let calls = 0;
    const { source } = fakeSource({
      home: ({ range }) => {
        calls += 1;
        if (calls === 1) {
          return new Promise<HomeSnapshot>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(home(range));
      },
    });
    const service = makeService(source, { minIntervalMs: 25 });
    const pending = service.home({ range: "7d" });
    service.addViewer();
    service.close();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(1);

    release(home("7d"));
    await expect(pending).resolves.toEqual(home("7d"));

    // close() dropped cached state: a probe load recomputes instead of
    // resurfacing the pre-close computation.
    await service.home({ range: "7d" });
    expect(calls).toBe(2);
  });

  it("serves the retained last-good snapshot as stale when polling fails", async () => {
    vi.useFakeTimers();
    let failing = false;
    let homeCalls = 0;
    const { source } = fakeSource({
      home: async ({ range }) => {
        homeCalls += 1;
        if (failing) throw new Error("probe failed");
        return home(range, { total: 21 });
      },
    });
    const service = makeService(source, { minIntervalMs: 50 });
    await service.home({ range: "7d" });
    for (let index = 0; index < MAX_TRACKED_PAGES - 1; index += 1) {
      await service.project({ projectId: `p${index}`, range: "7d" });
    }

    const viewer = service.addViewer();
    failing = true;
    await vi.advanceTimersByTimeAsync(60);
    expect(homeCalls).toBe(2);

    const stale = await service.home({ range: "7d" });
    expect(stale.stale).toBe(true);
    expect(stale.usage.totals.total).toBe(21);
    expect(homeCalls).toBe(3);
    viewer();
  });

  it("serves refreshed data from polls and recomputes after settings invalidation", async () => {
    vi.useFakeTimers();
    let total = 10;
    let calls = 0;
    const { source } = fakeSource({
      home: async ({ range }) => {
        calls += 1;
        return home(range, { total });
      },
    });
    const service = makeService(source, { minIntervalMs: 50 });
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    expect((await service.home({ range: "7d" })).usage.totals.total).toBe(10);
    const viewer = service.addViewer();

    total = 20;
    await vi.advanceTimersByTimeAsync(60);
    expect(calls).toBe(2);
    expect((await service.home({ range: "7d" })).usage.totals.total).toBe(20);
    expect(calls).toBe(2);
    expect(events.map((event) => event.topic)).toEqual(["quota.changed"]);

    total = 30;
    service.notifySettingsChanged();
    expect((await service.home({ range: "7d" })).usage.totals.total).toBe(30);
    expect(calls).toBe(3);
    expect(events.map((event) => event.topic)).toEqual(["quota.changed", "settings.changed"]);
    viewer();
  });

  it("serves the last good snapshot marked stale when a recompute fails", async () => {
    let failing = false;
    const { calls, source } = fakeSource({
      home: async ({ range }) => {
        calls.home += 1;
        if (failing) throw new Error("probe failed");
        return home(range, { total: 21 });
      },
    });
    const service = makeService(source);

    const fresh = await service.home({ range: "7d" });
    expect(fresh.stale).toBe(false);

    failing = true;
    service.notifySettingsChanged();
    const stale = await service.home({ range: "7d" });
    expect(stale.stale).toBe(true);
    expect(stale.usage.totals.total).toBe(21);
    expect(calls.home).toBe(2);
  });

  it("rejects a failed first computation when no previous snapshot exists", async () => {
    const { source } = fakeSource({
      home: async () => {
        throw new Error("database unavailable");
      },
    });
    const service = makeService(source);

    await expect(service.home({ range: "7d" })).rejects.toThrow("database unavailable");
  });

  it("polls only while a viewer is connected, with no extra floor, and dirties on the last disconnect", async () => {
    vi.useFakeTimers();
    const { calls, source } = fakeSource();
    const service = makeService(source, { minIntervalMs: 25 });

    await service.home({ range: "7d" });
    expect(calls.home).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(calls.home).toBe(1);

    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(24);
    expect(calls.home).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.home).toBe(2);

    viewer();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.home).toBe(2);

    await service.home({ range: "7d" });
    expect(calls.home).toBe(3);
  });

  it("serializes ticks so a running recompute makes the next tick skip", async () => {
    vi.useFakeTimers();
    let deferred = false;
    let release!: (value: HomeSnapshot) => void;
    const { calls, source } = fakeSource({
      home: ({ range }) => {
        calls.home += 1;
        if (!deferred) return Promise.resolve(home(range));
        return new Promise<HomeSnapshot>((resolve) => {
          release = resolve;
        });
      },
    });
    const service = makeService(source, { minIntervalMs: 100 });

    await service.home({ range: "7d" });
    expect(calls.home).toBe(1);
    const viewer = service.addViewer();

    deferred = true;
    await vi.advanceTimersByTimeAsync(120);
    expect(calls.home).toBe(2);
    await vi.advanceTimersByTimeAsync(120);
    expect(calls.home).toBe(2);

    deferred = false;
    release(home("7d"));
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(120);
    expect(calls.home).toBe(3);
    viewer();
  });

  it("broadcasts only substantive changes, ignoring generatedAtMs, polledAtMs and countdown text", async () => {
    vi.useFakeTimers();
    let current = home("7d", { total: 42, countdown: "1m 0s" });
    const { source } = fakeSource({ home: async () => current });
    const service = makeService(source, { minIntervalMs: 50 });
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.home({ range: "7d" });
    service.addViewer();

    current = home("7d", {
      total: 42,
      countdown: "0m 59s",
      generatedAtMs: NOW + 1000,
      polledAtMs: NOW + 1000,
    });
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toEqual([]);

    current = home("7d", { total: 52, countdown: "0m 58s", generatedAtMs: NOW + 2000 });
    await vi.advanceTimersByTimeAsync(60);
    expect(events.map((event) => event.topic)).toEqual(["quota.changed"]);
    expect(events[0]?.at).toBeTypeOf("number");
  });

  it("ignores advancing clock boundaries in windows and clipped buckets without token or row changes", async () => {
    vi.useFakeTimers();
    const HOUR_MS = 3_600_000;
    let clock = NOW;
    let total = 10;
    let rows = 1;
    let bucketTrim = 0;

    const source: SnapshotSource = {
      home: async ({ range }) => {
        const snapshot = home(range, { total, generatedAtMs: clock, polledAtMs: clock });
        // A real source reads the clock per snapshot: window edges and clipped
        // bucket boundaries advance while the token data stays identical.
        snapshot.usage.window = rangeWindow(range, clock);
        const planned = planRangeBuckets(range, clock);
        snapshot.usage.buckets = planned
          .slice(0, planned.length - bucketTrim)
          .map((bucket, index) => ({ ...bucket, tokens: index === 0 ? costed(total) : costed(0) }));
        snapshot.projects = Array.from({ length: rows }, (_, index) => ({
          projectId: `p${index + 1}`,
          name: `Project ${index + 1}`,
          tokens: costed(total),
          rootSessionCount: 1,
          latestActivityAtMs: NOW,
        }));
        return snapshot;
      },
      project: async ({ projectId, range }) => project(range, projectId),
      session: async ({ sessionId }) => session(sessionId),
    };

    const service = makeService(source, { minIntervalMs: 50 });
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.home({ range: "7d" });
    service.addViewer();

    // Clock-only drift: no event.
    clock = NOW + HOUR_MS;
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toEqual([]);

    // A token value change is substantive: exactly one home event.
    total = 25;
    clock = NOW + 2 * HOUR_MS;
    await vi.advanceTimersByTimeAsync(60);
    expect(events.map((event) => event.topic)).toEqual(["quota.changed"]);
    expect(events[0]?.scope).toBeUndefined();

    // Row-set changes stay substantive.
    rows = 2;
    clock = NOW + 3 * HOUR_MS;
    await vi.advanceTimersByTimeAsync(60);
    expect(events.map((event) => event.topic)).toEqual(["quota.changed", "quota.changed"]);

    // Bucket-count changes stay substantive too.
    bucketTrim = 1;
    clock = NOW + 4 * HOUR_MS;
    await vi.advanceTimersByTimeAsync(60);
    expect(events.map((event) => event.topic)).toEqual([
      "quota.changed",
      "quota.changed",
      "quota.changed",
    ]);
  });

  it("broadcasts sessions.changed for project aggregates and re-broadcasts a recovered poll", async () => {
    vi.useFakeTimers();
    let failing = false;
    let current = project("7d", "p1", 5);
    const { source } = fakeSource({
      project: async () => {
        if (failing) throw new Error("project aggregation failed");
        return current;
      },
    });
    const service = makeService(source, { minIntervalMs: 50 });
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.project({ projectId: "p1", range: "7d" });
    service.addViewer();

    current = project("7d", "p1", 9);
    await vi.advanceTimersByTimeAsync(60);
    expect(events.map((event) => event.topic)).toEqual(["sessions.changed"]);

    failing = true;
    await vi.advanceTimersByTimeAsync(60);
    expect(events).toHaveLength(1);

    failing = false;
    await vi.advanceTimersByTimeAsync(60);
    expect(events.map((event) => event.topic)).toEqual(["sessions.changed", "sessions.changed"]);
  });

  it("invalidates home and project on settings writes, visibility broadcasts only", async () => {
    const { calls, source } = fakeSource();
    const service = makeService(source);
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.home({ range: "7d" });
    await service.project({ projectId: "p1", range: "7d" });
    await service.session({ sessionId: "s1" });

    service.notifySettingsChanged({ scope: "visibility" });
    expect(events).toEqual([
      { topic: "settings.changed", at: expect.any(Number), scope: "visibility" },
    ]);

    await service.home({ range: "7d" });
    await service.project({ projectId: "p1", range: "7d" });
    await service.session({ sessionId: "s1" });
    expect(calls.home).toBe(1);
    expect(calls.project).toBe(1);
    expect(calls.session).toBe(1);

    service.notifySettingsChanged();
    expect(events).toHaveLength(2);
    expect(events[1]?.scope).toBeUndefined();

    await service.home({ range: "7d" });
    await service.project({ projectId: "p1", range: "7d" });
    await service.session({ sessionId: "s1" });
    expect(calls.home).toBe(2);
    expect(calls.project).toBe(2);
    expect(calls.session).toBe(1);
  });

  it("re-reads a minIntervalMs getter when settings change", async () => {
    vi.useFakeTimers();
    let interval = 60_000;
    const { calls, source } = fakeSource();
    const service = makeService(source, { minIntervalMs: () => interval });

    await service.home({ range: "7d" });
    const viewer = service.addViewer();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.home).toBe(1);

    interval = 25;
    service.notifySettingsChanged();
    await vi.advanceTimersByTimeAsync(25);
    expect(calls.home).toBe(2);
    viewer();
  });

  it("falls back to the default poll interval when the getter yields a non-positive value", async () => {
    vi.useFakeTimers();
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(300_000);

    const { calls, source } = fakeSource();
    const service = makeService(source, { minIntervalMs: () => 0 });
    await service.home({ range: "7d" });
    service.addViewer();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.home).toBe(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS);
    expect(calls.home).toBe(2);
  });

  it("stops polling and emitting after close()", async () => {
    vi.useFakeTimers();
    const { calls, source } = fakeSource();
    const service = makeService(source, { minIntervalMs: 25 });
    const events: DashboardEvent[] = [];
    service.subscribe((event) => events.push(event));

    await service.home({ range: "7d" });
    service.addViewer();
    await vi.advanceTimersByTimeAsync(30);
    expect(calls.home).toBe(2);

    service.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.home).toBe(2);
    expect(events).toEqual([]);
  });
});
