import { describe, expect, it, vi } from "vitest";

import {
  type AnalyticsWorkerLike,
  createAnalyticsBridge,
  workerResourceLimits,
} from "../src/gui/analytics-bridge.js";
import type { AnalyticsWorkerRequest } from "../src/gui/analytics-protocol.js";
import { createGuiLogger } from "../src/gui/log.js";

const logger = createGuiLogger({ sink: () => {} });

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

  it("keeps the default timeout finite: retires a stuck worker at 90 s and recovers", async () => {
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

      await vi.advanceTimersByTimeAsync(89_999);
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

  it("uses an optional runtime-managed heap limit only when configured", () => {
    expect(workerResourceLimits(undefined)).toBeUndefined();
    expect(workerResourceLimits(Number.NaN)).toBeUndefined();
    expect(workerResourceLimits(128)).toEqual({
      maxOldGenerationSizeMb: 128,
      maxYoungGenerationSizeMb: 16,
    });
  });
});
