import { describe, expect, it, vi } from "vitest";

import type {
  CostedTokens,
  HomeSnapshot,
  ProjectSnapshot,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { AnalyticsReadError, type AnalyticsTransport } from "../src/gui/analytics-protocol.js";
import { createAnalyticsReadService } from "../src/gui/analytics-service.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 24 * 3_600_000;

function costed(input: number): CostedTokens {
  return {
    input,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: input,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function homeFor(range: RangeKey): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: [], polledAtMs: NOW },
    usage: {
      range,
      window: range === "lifetime" ? { untilMs: NOW } : { sinceMs: NOW - DAY, untilMs: NOW },
      bucketUnit: range === "24h" ? "hour" : "day",
      timeZone: "UTC",
      buckets: [],
      totals: costed(1),
      stepCount: 1,
      sessionCount: 1,
      stale: false,
    },
    projects: [],
  };
}

interface TransportTrace {
  init: number;
  calls: string[];
  closed: number;
  deferHome?: boolean;
}

function fakeTransport(trace: TransportTrace): AnalyticsTransport {
  let rejectHome: ((error: AnalyticsReadError) => void) | undefined;
  const transport: AnalyticsTransport = {
    async init() {
      trace.init += 1;
    },
    async home(range) {
      trace.calls.push(`home:${range}`);
      if (trace.deferHome) {
        return await new Promise<HomeSnapshot>((_resolve, reject) => {
          rejectHome = reject;
        });
      }
      return homeFor(range);
    },
    async project(projectId, range) {
      trace.calls.push(`project:${projectId}:${range}`);
      return {
        projectId,
        name: projectId,
        range,
        window: { sinceMs: NOW - DAY, untilMs: NOW },
        roots: [],
        totals: { ...costed(0), sessionCount: 0 },
        usage: homeFor(range).usage,
        stale: false,
      } satisfies ProjectSnapshot;
    },
    async session(sessionId) {
      trace.calls.push(`session:${sessionId}`);
      return {
        focusSessionId: sessionId,
        projectId: "project-1",
        projectName: "Project",
        breadcrumbs: [{ sessionId, title: sessionId, isFocus: true }],
        nodes: [],
        steps: [],
        compactionMarkers: [],
        ownSummary: { ...costed(0), stepCount: 0 },
        treeTotals: costed(0),
        stepSemantics: "synthetic",
      } satisfies SessionSnapshot;
    },
    async refresh() {
      trace.calls.push("refresh");
    },
    async close() {
      trace.closed += 1;
      rejectHome?.(new AnalyticsReadError("closed"));
      rejectHome = undefined;
    },
  };
  return transport;
}

describe("analytics read service", () => {
  it("starts the worker lazily, once per service, and does no work before the first call", async () => {
    const trace: TransportTrace = { init: 0, calls: [], closed: 0 };
    const createTransport = vi.fn(() => fakeTransport(trace));
    const service = createAnalyticsReadService({ createTransport: createTransport as never });

    expect(createTransport).not.toHaveBeenCalled();

    const home = await service.home({ range: "24h" });
    expect(home.providers.cards).toEqual([]);
    const project = await service.project({ projectId: "p1", range: "7d" });
    expect(project.projectId).toBe("p1");
    await service.session({ sessionId: "ses_1" });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(trace.init).toBe(1);
    expect(trace.calls).toEqual(["home:24h", "project:p1:7d", "session:ses_1"]);

    await service.close();
    await service.close();
    expect(trace.closed).toBe(1);
    await expect(service.home({ range: "24h" })).rejects.toMatchObject({ code: "closed" });
  });

  it("validates ranges and resource ids without starting a worker", async () => {
    const createTransport = vi.fn();
    const service = createAnalyticsReadService({ createTransport: createTransport as never });

    await expect(service.home({ range: "nope" as RangeKey })).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(service.project({ projectId: "", range: "24h" })).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(service.session({ sessionId: "" })).rejects.toMatchObject({
      code: "bad-request",
    });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("rejects outstanding work on close and never throws from close", async () => {
    const trace: TransportTrace = { init: 0, calls: [], closed: 0, deferHome: true };
    const service = createAnalyticsReadService({
      createTransport: () => fakeTransport(trace),
    });

    const pending = service.home({ range: "24h" });
    await vi.waitFor(() => {
      expect(trace.calls).toContain("home:24h");
    });
    await expect(service.close()).resolves.toBeUndefined();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
    expect(trace.closed).toBe(1);
  });

  it("keeps a slow transport response past the old worker budget without an added cap", async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const transport: AnalyticsTransport = {
        async init() {},
        home(range) {
          return new Promise<HomeSnapshot>((resolve) => {
            release = () => resolve(homeFor(range));
          });
        },
        async project() {
          throw new AnalyticsReadError("unavailable");
        },
        async session() {
          throw new AnalyticsReadError("unavailable");
        },
        async refresh() {},
        async close() {},
      };
      const service = createAnalyticsReadService({ createTransport: () => transport });

      const pending = service.home({ range: "30d" });
      await vi.advanceTimersByTimeAsync(45_000);
      if (release === undefined) throw new Error("home read was not started");
      release();
      await expect(pending).resolves.toMatchObject({ range: "30d" });
      await service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates controlled transport errors", async () => {
    const service = createAnalyticsReadService({
      createTransport: () => ({
        init: async () => {},
        home: async () => {
          throw new AnalyticsReadError("unavailable");
        },
        project: async () => {
          throw new AnalyticsReadError("project-not-found");
        },
        session: async () => {
          throw new AnalyticsReadError("session-not-found");
        },
        refresh: async () => {},
        close: async () => {},
      }),
    });

    await expect(service.home({ range: "24h" })).rejects.toMatchObject({ code: "unavailable" });
    await expect(service.project({ projectId: "p", range: "24h" })).rejects.toMatchObject({
      code: "project-not-found",
    });
    await expect(service.session({ sessionId: "s" })).rejects.toMatchObject({
      code: "session-not-found",
    });
    await service.close();
  });

  it("retries init with a bounded cap and never recreates forever", async () => {
    let created = 0;
    let initCalls = 0;
    const transport: AnalyticsTransport = {
      async init() {
        initCalls += 1;
        throw new AnalyticsReadError("unavailable");
      },
      async home(range) {
        return homeFor(range);
      },
      async project() {
        throw new AnalyticsReadError("unavailable");
      },
      async session() {
        throw new AnalyticsReadError("unavailable");
      },
      async refresh() {},
      async close() {},
    };
    const service = createAnalyticsReadService({
      createTransport: () => {
        created += 1;
        return transport;
      },
      maxTransportAttempts: 3,
      transportRetryBaseMs: 0,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.home({ range: "24h" })).rejects.toMatchObject({
        code: "unavailable",
      });
    }
    await expect(service.home({ range: "24h" })).rejects.toMatchObject({ code: "unavailable" });
    expect(created).toBe(1);
    expect(initCalls).toBe(3);
    await service.close();
  });

  it("forwards transport generation notifications only after initialization", async () => {
    let notify: (() => void) | undefined;
    const transport: AnalyticsTransport = {
      async init() {},
      async home(range) {
        return homeFor(range);
      },
      async project() {
        throw new AnalyticsReadError("unavailable");
      },
      async session() {
        throw new AnalyticsReadError("unavailable");
      },
      async refresh() {},
      subscribe(listener) {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      async close() {},
    };
    const service = createAnalyticsReadService({ createTransport: () => transport });
    let delivered = 0;
    const unsubscribe = service.subscribe(() => {
      delivered += 1;
    });

    await service.home({ range: "24h" });
    notify?.();
    expect(delivered).toBe(1);
    unsubscribe();
    notify?.();
    expect(delivered).toBe(1);
    await service.close();
  });
});
