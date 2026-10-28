import { describe, expect, it, vi } from "vitest";
import type { AnalyticsGroupQuery, AnalyticsGroupSnapshot } from "../src/contracts/dashboard.js";
import {
  ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS,
  type AnalyticsWorkerLike,
  createAnalyticsBridge,
  workerResourceLimits,
} from "../src/gui/analytics-bridge.js";
import type { AnalyticsEngine } from "../src/gui/analytics-engine.js";
import type { AnalyticsWorkerRequest } from "../src/gui/analytics-protocol.js";
import { createAnalyticsWorkerRuntime } from "../src/gui/analytics-worker-runtime.js";
import { createGuiLogger } from "../src/gui/log.js";

const logger = createGuiLogger({ sink: () => {} });
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 86_400_000;

class FakeWorker implements AnalyticsWorkerLike {
  readonly messages: AnalyticsWorkerRequest[] = [];
  terminated = 0;
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  constructor(private readonly answer: (command: AnalyticsWorkerRequest["command"]) => unknown) {}

  postMessage(value: unknown): void {
    const request = value as AnalyticsWorkerRequest;
    this.messages.push(request);
    queueMicrotask(() => {
      const result = this.answer(request.command);
      if (result === "ignore") return;
      this.emit("message", { id: request.id, ok: true, result });
    });
  }

  terminate(): unknown {
    this.terminated += 1;
    return undefined;
  }

  on(event: "message" | "error" | "exit", listener: (value: unknown) => void): unknown {
    const entries = this.listeners.get(event) ?? [];
    entries.push(listener);
    this.listeners.set(event, entries);
    return this;
  }

  emit(event: "message" | "error" | "exit", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }
}

function answerHome(command: AnalyticsWorkerRequest["command"]): unknown {
  if (command.kind === "init") return undefined;
  return { marker: "fresh" };
}

function answerEcho(command: AnalyticsWorkerRequest["command"]): unknown {
  switch (command.kind) {
    case "home":
      return { marker: `home:${command.range}` };
    case "project":
      return { marker: `project:${command.projectId}:${command.range}` };
    case "session":
      return { marker: `session:${command.sessionId}` };
    case "groups": {
      const filter = command.query.filter;
      const marker = filter
        ? `${filter.dimension}:${filter.identity.kind}:${
            filter.identity.kind === "known" ? filter.identity.id : ""
          }`
        : "none";
      return { marker: `groups:${command.query.dimension}:${command.query.range}:${marker}` };
    }
    default:
      return undefined;
  }
}

function framesOf(
  worker: FakeWorker,
  kind: AnalyticsWorkerRequest["command"]["kind"],
): AnalyticsWorkerRequest[] {
  return worker.messages.filter((message) => message.command.kind === kind);
}

async function flushMicrotasks(rounds = 50): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

describe("analytics worker bridge", () => {
  it("retires a timed-out worker, recreates it, and replays init", async () => {
    let created = 0;
    const first = new FakeWorker((command) => (command.kind === "home" ? "ignore" : undefined));
    const second = new FakeWorker(answerHome);
    const bridge = createAnalyticsBridge({
      createWorker: () => {
        created += 1;
        return created === 1 ? first : second;
      },
      requestTimeoutMs: 20,
      retryBaseMs: 0,
      logger,
    });

    await expect(bridge.home("24h")).rejects.toMatchObject({ code: "timeout" });
    expect(first.terminated).toBe(1);

    const result = await bridge.home("24h");
    expect(result).toMatchObject({ marker: "fresh" });
    expect(created).toBe(2);
    expect(second.messages[0]?.command.kind).toBe("init");
    expect(second.messages.at(-1)?.command.kind).toBe("home");
    await bridge.close();
    // Close asks the engine to drain persistence before terminating.
    expect(second.messages.at(-1)?.command.kind).toBe("close");
    expect(second.terminated).toBe(1);
  });

  it("coalesces identical in-flight reads into one worker frame per command", async () => {
    const worker = new FakeWorker(answerEcho);
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });

    const [homeA, homeB] = await Promise.all([bridge.home("24h"), bridge.home("24h")]);
    expect(homeA).toEqual(homeB);
    expect(framesOf(worker, "home")).toHaveLength(1);

    const [projectA, projectB] = await Promise.all([
      bridge.project("p1", "7d"),
      bridge.project("p1", "7d"),
    ]);
    expect(projectA).toEqual(projectB);
    expect(framesOf(worker, "project")).toHaveLength(1);

    const [sessionA, sessionB] = await Promise.all([
      bridge.session("ses_1"),
      bridge.session("ses_1"),
    ]);
    expect(sessionA).toEqual(sessionB);
    expect(framesOf(worker, "session")).toHaveLength(1);

    await Promise.all([bridge.refresh(), bridge.refresh()]);
    expect(framesOf(worker, "refresh")).toHaveLength(1);

    // A settled command is not reused: the next identical read is a new frame.
    await bridge.home("24h");
    expect(framesOf(worker, "home")).toHaveLength(2);
    await bridge.close();
  });

  it("keeps diagnostics one-per-call instead of coalescing them", async () => {
    const worker = new FakeWorker(() => undefined);
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });

    await Promise.all([bridge.stats?.(), bridge.stats?.()]);
    expect(framesOf(worker, "stats")).toHaveLength(2);
    await Promise.all([bridge.gc?.(), bridge.gc?.()]);
    expect(framesOf(worker, "gc")).toHaveLength(2);

    // Refresh is a shared read: concurrent callers join one forced refresh.
    await Promise.all([bridge.refresh(), bridge.refresh()]);
    expect(framesOf(worker, "refresh")).toHaveLength(1);
    await bridge.close();
  });

  it("never merges different ranges or resource identities", async () => {
    const worker = new FakeWorker(answerEcho);
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });

    const results = await Promise.all([
      bridge.home("24h"),
      bridge.home("24h"),
      bridge.home("7d"),
      bridge.project("p1", "24h"),
      bridge.project("p1", "24h"),
      bridge.project("p1", "7d"),
      bridge.project("p2", "24h"),
      bridge.session("ses_1"),
      bridge.session("ses_1"),
      bridge.session("ses_2"),
    ]);

    expect(results).toEqual([
      { marker: "home:24h" },
      { marker: "home:24h" },
      { marker: "home:7d" },
      { marker: "project:p1:24h" },
      { marker: "project:p1:24h" },
      { marker: "project:p1:7d" },
      { marker: "project:p2:24h" },
      { marker: "session:ses_1" },
      { marker: "session:ses_1" },
      { marker: "session:ses_2" },
    ]);
    expect(framesOf(worker, "home")).toHaveLength(2);
    expect(framesOf(worker, "project")).toHaveLength(3);
    expect(framesOf(worker, "session")).toHaveLength(2);
    await bridge.close();
  });

  it("fails every identical joiner on an error and retries with a new frame", async () => {
    const worker = new FakeWorker(() => undefined);
    let homeAttempts = 0;
    worker.postMessage = (value: unknown): void => {
      const request = value as AnalyticsWorkerRequest;
      worker.messages.push(request);
      queueMicrotask(() => {
        if (request.command.kind === "home") {
          homeAttempts += 1;
          if (homeAttempts === 1) {
            worker.emit("message", {
              id: request.id,
              ok: false,
              error: { code: "unavailable" },
            });
            return;
          }
        }
        worker.emit("message", { id: request.id, ok: true, result: { marker: "retry" } });
      });
    };
    const bridge = createAnalyticsBridge({
      createWorker: () => worker,
      requestTimeoutMs: 1_000,
      logger,
    });

    const first = bridge.home("24h");
    const second = bridge.home("24h");
    await expect(first).rejects.toMatchObject({ code: "unavailable" });
    await expect(second).rejects.toMatchObject({ code: "unavailable" });
    expect(framesOf(worker, "home")).toHaveLength(1);

    await expect(bridge.home("24h")).resolves.toMatchObject({ marker: "retry" });
    expect(framesOf(worker, "home")).toHaveLength(2);
    await bridge.close();
  });

  it("fails every joiner on a worker crash and recreates for the next read", async () => {
    let created = 0;
    const crashed = new FakeWorker((command) => (command.kind === "home" ? "ignore" : undefined));
    const healthy = new FakeWorker(answerEcho);
    const bridge = createAnalyticsBridge({
      createWorker: () => {
        created += 1;
        return created === 1 ? crashed : healthy;
      },
      retryBaseMs: 0,
      logger,
    });

    const first = bridge.home("24h");
    const second = bridge.home("24h");
    await flushMicrotasks();
    expect(framesOf(crashed, "home")).toHaveLength(1);

    crashed.emit("error", new Error("crashed"));
    await expect(first).rejects.toMatchObject({ code: "unavailable" });
    await expect(second).rejects.toMatchObject({ code: "unavailable" });
    expect(crashed.terminated).toBe(1);

    await expect(bridge.home("24h")).resolves.toMatchObject({ marker: "home:24h" });
    expect(created).toBe(2);
    expect(framesOf(healthy, "home")).toHaveLength(1);
    await bridge.close();
  });

  it("ignores delayed failures and messages from a retired worker after recovery", async () => {
    let created = 0;
    const retired = new FakeWorker((command) => (command.kind === "home" ? "ignore" : undefined));
    let holdHome = false;
    const healthy = new FakeWorker((command) => {
      if (command.kind === "init") return undefined;
      if (holdHome && command.kind === "home") return "ignore";
      return answerEcho(command);
    });
    const bridge = createAnalyticsBridge({
      createWorker: () => {
        created += 1;
        return created === 1 ? retired : healthy;
      },
      requestTimeoutMs: 20,
      retryBaseMs: 0,
      maxRecoveryAttempts: 2,
      logger,
    });
    let notifications = 0;
    bridge.subscribe?.(() => {
      notifications += 1;
    });

    await expect(bridge.home("24h")).rejects.toMatchObject({ code: "timeout" });
    expect(retired.terminated).toBe(1);
    await expect(bridge.home("24h")).resolves.toMatchObject({ marker: "home:24h" });
    expect(created).toBe(2);
    expect(healthy.terminated).toBe(0);

    holdHome = true;
    const first = bridge.home("7d");
    const second = bridge.home("7d");
    await flushMicrotasks();
    const held = framesOf(healthy, "home").at(-1);
    if (held === undefined) throw new Error("held home request was not sent");

    // The retired worker can still deliver late lifecycle events and frames.
    retired.emit("exit", 1);
    retired.emit("error", new Error("late failure"));
    retired.emit("message", { type: "analytics-generation", generation: 99 });
    retired.emit("message", {
      id: held.id,
      ok: true,
      result: { marker: "stale" },
    });
    await flushMicrotasks();

    expect(notifications).toBe(0);
    expect(healthy.terminated).toBe(0);

    healthy.emit("message", {
      id: held.id,
      ok: true,
      result: { marker: "b-shared" },
    });
    await expect(first).resolves.toMatchObject({ marker: "b-shared" });
    await expect(second).resolves.toMatchObject({ marker: "b-shared" });

    // Late failures must not consume the bounded recovery budget.
    holdHome = false;
    await expect(bridge.home("24h")).resolves.toMatchObject({ marker: "home:24h" });
    expect(created).toBe(2);
    await bridge.close();
  });

  it("does not post a read onto a worker retired before the frame was sent", async () => {
    const worker = new FakeWorker(answerEcho);
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });
    await bridge.init({});

    const pending = bridge.home("24h");
    // Retire synchronously before the resolved-worker continuation can post.
    worker.emit("error", new Error("crashed"));
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(framesOf(worker, "home")).toHaveLength(0);
    await bridge.close();
  });

  it("rejects every shared waiter on close and sends no further reads", async () => {
    const worker = new FakeWorker((command) => (command.kind === "home" ? "ignore" : undefined));
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });

    const first = bridge.home("24h");
    const second = bridge.home("24h");
    await flushMicrotasks();
    expect(framesOf(worker, "home")).toHaveLength(1);

    const closing = bridge.close();
    await expect(first).rejects.toMatchObject({ code: "closed" });
    await expect(second).rejects.toMatchObject({ code: "closed" });
    await closing;

    await expect(bridge.home("24h")).rejects.toMatchObject({ code: "closed" });
    expect(framesOf(worker, "home")).toHaveLength(1);
  });

  it("allows a cold request to outlive the old 30 s budget at the new default", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker((command) => (command.kind === "home" ? "ignore" : undefined));
      const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });

      const pending = bridge.home("30d");
      await flushMicrotasks();
      const request = worker.messages.find((message) => message.command.kind === "home");
      if (request === undefined) throw new Error("home request was not sent");

      await vi.advanceTimersByTimeAsync(30_001);
      expect(worker.terminated).toBe(0);

      worker.emit("message", { id: request.id, ok: true, result: { marker: "cold" } });
      await expect(pending).resolves.toMatchObject({ marker: "cold" });
      expect(worker.terminated).toBe(0);
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the default timeout finite: retires a stuck worker at the budget and recovers", async () => {
    vi.useFakeTimers();
    try {
      let created = 0;
      const stuck = new FakeWorker((command) => (command.kind === "home" ? "ignore" : undefined));
      const healthy = new FakeWorker(answerHome);
      const bridge = createAnalyticsBridge({
        createWorker: () => {
          created += 1;
          return created === 1 ? stuck : healthy;
        },
        retryBaseMs: 0,
        logger,
      });

      const pending = bridge.home("lifetime");
      const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await flushMicrotasks();
      expect(stuck.messages.at(-1)?.command.kind).toBe("home");

      await vi.advanceTimersByTimeAsync(ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS - 1);
      expect(stuck.terminated).toBe(0);

      await vi.advanceTimersByTimeAsync(2);
      await rejection;
      expect(stuck.terminated).toBe(1);

      await expect(bridge.home("lifetime")).resolves.toMatchObject({ marker: "fresh" });
      expect(created).toBe(2);
      await bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays init after an init failure and resets recovery state on success", async () => {
    let created = 0;
    const failing = new FakeWorker(() => undefined);
    failing.postMessage = (value: unknown): void => {
      const request = value as AnalyticsWorkerRequest;
      failing.messages.push(request);
      queueMicrotask(() => {
        failing.emit("message", {
          id: request.id,
          ok: false,
          error: { code: "unavailable" },
        });
      });
    };
    const working = new FakeWorker(answerHome);
    const bridge = createAnalyticsBridge({
      createWorker: () => {
        created += 1;
        return created === 1 ? failing : working;
      },
      requestTimeoutMs: 50,
      retryBaseMs: 0,
      logger,
    });

    await expect(bridge.home("24h")).rejects.toMatchObject({ code: "unavailable" });
    expect(failing.terminated).toBe(1);
    await expect(bridge.home("24h")).resolves.toMatchObject({ marker: "fresh" });
    expect(created).toBe(2);
    expect(working.messages[0]?.command.kind).toBe("init");
    await bridge.close();
  });

  it("caps deterministic recovery failures instead of retrying forever", async () => {
    let created = 0;
    const bridge = createAnalyticsBridge({
      createWorker: () => {
        created += 1;
        throw new Error("out of memory");
      },
      retryBaseMs: 0,
      maxRecoveryAttempts: 3,
      logger,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(bridge.home("24h")).rejects.toMatchObject({ code: "unavailable" });
    }
    await expect(bridge.home("24h")).rejects.toMatchObject({ code: "unavailable" });
    expect(created).toBe(3);
    await bridge.close();
  });

  it("maps notifications to subscribers without a request id", async () => {
    const worker = new FakeWorker(answerHome);
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });
    let notifications = 0;
    const unsubscribe = bridge.subscribe?.(() => {
      notifications += 1;
    });
    await bridge.init({});
    worker.emit("message", { type: "analytics-generation", generation: 1 });
    expect(notifications).toBe(1);
    unsubscribe?.();
    worker.emit("message", { type: "analytics-generation", generation: 2 });
    expect(notifications).toBe(1);
    await bridge.close();
  });

  it("coalesces identical group reads and keeps dimensions/filters distinct", async () => {
    const worker = new FakeWorker(answerEcho);
    const bridge = createAnalyticsBridge({ createWorker: () => worker, logger });
    const query: AnalyticsGroupQuery = { range: "7d", dimension: "model" };

    const [first, second] = await Promise.all([bridge.groups(query), bridge.groups({ ...query })]);
    expect(first).toEqual(second);
    expect(framesOf(worker, "groups")).toHaveLength(1);

    await bridge.groups({ range: "7d", dimension: "provider" });
    await bridge.groups({
      ...query,
      filter: { dimension: "model", identity: { kind: "known", id: "" } },
    });
    await bridge.groups({
      ...query,
      filter: { dimension: "model", identity: { kind: "unknown" } },
    });
    await bridge.groups({
      ...query,
      filter: { dimension: "model", identity: { kind: "known", id: "unknown" } },
    });
    expect(framesOf(worker, "groups")).toHaveLength(5);
    await bridge.close();
  });

  it("round-trips one typed groups command through the worker runtime", async () => {
    const query: AnalyticsGroupQuery = {
      range: "30d",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "a|||b" } },
    };
    const snapshot: AnalyticsGroupSnapshot = {
      dimension: "provider",
      range: "30d",
      window: { sinceMs: NOW - DAY, untilMs: NOW },
      bucketUnit: "day",
      timeZone: "UTC",
      filter: query.filter,
      buckets: [{ startMs: NOW - DAY, endMs: NOW }],
      totals: {
        input: 1,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        total: 1,
        apiEquivalentCostUsd: null,
        unpricedTokens: 0,
        unknownTokens: 0,
      },
      sessionCount: 1,
      stepCount: 1,
      rows: [],
      series: [],
      stale: false,
    };
    const groups = vi.fn(async () => snapshot);
    const engine = {
      home: async () => {
        throw new Error("not used");
      },
      project: async () => {
        throw new Error("not used");
      },
      session: async () => {
        throw new Error("not used");
      },
      groups,
      refresh: async () => {},
      stats: async () => ({
        rss: 0,
        heapTotal: 0,
        heapUsed: 0,
        external: 0,
        arrayBuffers: 0,
        peakHeapUsed: 0,
        peakRss: 0,
      }),
      gc: async () => false,
      close: async () => {},
    } satisfies AnalyticsEngine;
    const runtime = createAnalyticsWorkerRuntime({ createEngine: () => engine });

    await runtime.handle({ kind: "init", options: {} });
    await expect(runtime.handle({ kind: "groups", query })).resolves.toEqual(snapshot);
    expect(groups).toHaveBeenCalledWith(query);

    await expect(
      runtime.handle({
        kind: "groups",
        query: { range: "1d", dimension: "model" } as unknown as AnalyticsGroupQuery,
      }),
    ).rejects.toMatchObject({ code: "bad-request" });
    await expect(
      runtime.handle({
        kind: "groups",
        query: {
          range: "24h",
          dimension: "model",
          filter: { dimension: "model", identity: { kind: "known", id: 7 } },
        } as unknown as AnalyticsGroupQuery,
      }),
    ).rejects.toMatchObject({ code: "bad-request" });
    expect(groups).toHaveBeenCalledTimes(1);
    await runtime.close();
  });

  it("uses an optional runtime-managed heap limit only when configured", () => {
    expect(workerResourceLimits(undefined)).toBeUndefined();
    expect(workerResourceLimits(Number.NaN)).toBeUndefined();
    expect(workerResourceLimits(128)).toEqual({
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 16,
    });
  });
});
