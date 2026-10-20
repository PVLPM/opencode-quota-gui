/**
 * Host-side worker bridge: one lazy worker, request ids, timeout/close
 * containment, generation notifications, and bounded recovery.
 *
 * A timed-out or crashed worker is retired; the next request recreates it and
 * replays the stored init options. Recovery attempts are backoff-bounded and
 * capped so a deterministic failure (for example repeated OOM) cannot spin
 * forever. The worker heap limit is optional: by default the runtime manages
 * the heap.
 */
import type {
  AnalyticsInitOptions,
  AnalyticsTransport,
  AnalyticsWorkerRequest,
  AnalyticsWorkerResponse,
} from "./analytics-protocol.js";
import { AnalyticsReadError } from "./analytics-protocol.js";
import { createGuiLogger, type GuiLogger } from "./log.js";

export interface AnalyticsWorkerLike {
  postMessage(message: unknown): void;
  terminate(): unknown;
  unref?(): void;
  on?(event: "message" | "error" | "exit", listener: (value: unknown) => void): unknown;
  addEventListener?(event: "message" | "error", listener: (value: unknown) => void): unknown;
  onmessage?: ((event: { data: unknown }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
}

export interface AnalyticsBridgeOptions {
  createWorker?: () => AnalyticsWorkerLike | Promise<AnalyticsWorkerLike>;
  requestTimeoutMs?: number;
  logger?: GuiLogger;
  /** Optional worker heap ceiling; omit to let the runtime manage the heap. */
  workerHeapLimitMb?: number;
  /** Base delay for bounded recreation backoff (default 250 ms). */
  retryBaseMs?: number;
  /** Stop retrying after this many consecutive failures (default 5). */
  maxRecoveryAttempts?: number;
}

/**
 * Cold 7d/30d/lifetime analytics catch-up reads the full source store and can
 * legitimately take tens of seconds on a slow local disk; a foreground request
 * queued behind one can add its own scoped read. The old 90 s budget retired
 * healthy workers mid-read on measured sources. Keep a finite budget above the
 * measured worst request (112.9 s on the reported source), so genuinely stuck
 * workers are still retired and recovered on the next request.
 */
export const ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 5_000;

/** Pure mapping for the optional Node worker heap limit. */
export function workerResourceLimits(
  limitMb: number | undefined,
): { maxOldGenerationSizeMb: number; maxYoungGenerationSizeMb: number } | undefined {
  if (limitMb === undefined || !Number.isFinite(limitMb) || limitMb <= 0) return undefined;
  const oldGeneration = Math.max(16, Math.floor(limitMb));
  return {
    maxOldGenerationSizeMb: oldGeneration,
    maxYoungGenerationSizeMb: Math.min(24, Math.max(8, Math.floor(oldGeneration / 8))),
  };
}

async function createDefaultWorker(
  workerHeapLimitMb: number | undefined,
): Promise<AnalyticsWorkerLike> {
  const url = new URL("./analytics-worker.js", import.meta.url);
  const globalWorker = (globalThis as { Worker?: unknown }).Worker;
  const bun = (globalThis as { Bun?: unknown }).Bun;
  if (bun !== undefined && typeof globalWorker === "function") {
    const ctor = globalWorker as new (
      script: string,
      options?: { type?: string },
    ) => AnalyticsWorkerLike;
    return new ctor(url.href, { type: "module" });
  }
  const { Worker } = await import("node:worker_threads");
  const limits = workerResourceLimits(workerHeapLimitMb);
  const worker =
    limits === undefined ? new Worker(url) : new Worker(url, { resourceLimits: limits });
  worker.unref();
  return worker as unknown as AnalyticsWorkerLike;
}

interface PendingRequest {
  resolve: (response: AnalyticsWorkerResponse) => void;
  reject: (error: AnalyticsReadError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Identity for a read that any number of callers can share while it is in
 * flight. Only pure, id-and-range-addressed reads qualify. `stats`, `gc`,
 * `init`, and `close` are diagnostics/lifecycle commands and must stay
 * one-per-call.
 */
function coalescedCommandKey(command: AnalyticsWorkerRequest["command"]): string | undefined {
  switch (command.kind) {
    case "home":
      return `home\u0000${command.range}`;
    case "project":
      return `project\u0000${command.projectId}\u0000${command.range}`;
    case "session":
      return `session\u0000${command.sessionId}`;
    case "refresh":
      return "refresh";
    default:
      return undefined;
  }
}

export function createAnalyticsBridge(options: AnalyticsBridgeOptions = {}): AnalyticsTransport {
  const logger = options.logger ?? createGuiLogger();
  const createWorker =
    options.createWorker ?? (() => createDefaultWorker(options.workerHeapLimitMb));
  const requestTimeoutMs =
    options.requestTimeoutMs !== undefined &&
    Number.isFinite(options.requestTimeoutMs) &&
    options.requestTimeoutMs > 0
      ? options.requestTimeoutMs
      : ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS;
  const retryBaseMs =
    options.retryBaseMs !== undefined &&
    Number.isFinite(options.retryBaseMs) &&
    options.retryBaseMs >= 0
      ? options.retryBaseMs
      : DEFAULT_RETRY_BASE_MS;
  const maxRecoveryAttempts =
    options.maxRecoveryAttempts !== undefined &&
    Number.isFinite(options.maxRecoveryAttempts) &&
    options.maxRecoveryAttempts > 0
      ? Math.floor(options.maxRecoveryAttempts)
      : DEFAULT_MAX_RECOVERY_ATTEMPTS;

  let worker: AnalyticsWorkerLike | undefined;
  let workerPromise: Promise<AnalyticsWorkerLike> | undefined;
  let initOptions: AnalyticsInitOptions = {};
  let closed = false;
  let broken = false;
  let failures = 0;
  let nextRetryAtMs = 0;
  let nextRequestId = 1;
  const pending = new Map<number, PendingRequest>();
  /**
   * In-flight reads keyed by command identity. Identical reads from reconnect
   * replays or duplicate viewers join this promise instead of posting another
   * worker frame. This shares compatible work; it does not abort the running
   * job (the protocol has no cancel command), so a shared read still finishes
   * even if every original caller has gone away.
   */
  const inFlightReads = new Map<string, Promise<unknown>>();
  const listeners = new Set<() => void>();
  const retiredInstances = new WeakSet<AnalyticsWorkerLike>();

  function failPending(code: "unavailable" | "closed"): void {
    const error = new AnalyticsReadError(code);
    // A failure retires every read belonging to this worker. Drop the shared
    // entries first so even a synchronous retry cannot join a settled promise.
    inFlightReads.clear();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  }

  function backoffMs(): number {
    const exponent = Math.max(0, failures - 1);
    return Math.min(MAX_RETRY_DELAY_MS, retryBaseMs * 2 ** exponent);
  }

  function registerFailure(): void {
    failures += 1;
    nextRetryAtMs = Date.now() + backoffMs();
    if (failures >= maxRecoveryAttempts) {
      broken = true;
      logger.warn("analytics worker recovery exhausted", "worker-unavailable");
    } else {
      logger.warn("analytics worker unavailable", "worker-unavailable");
    }
  }

  function retire(instance: AnalyticsWorkerLike | undefined, code: "unavailable" | "closed"): void {
    if (instance !== undefined) {
      retiredInstances.add(instance);
      if (worker === instance) {
        worker = undefined;
        workerPromise = undefined;
      }
      try {
        instance.terminate();
      } catch {
        // Termination is best effort.
      }
    }
    failPending(code);
    if (code === "unavailable" && !closed) registerFailure();
  }

  function onWorkerFailure(instance: AnalyticsWorkerLike): void {
    if (closed) return;
    if (retiredInstances.has(instance)) return;
    if (worker !== instance) return;
    retire(instance, "unavailable");
  }

  function attach(instance: AnalyticsWorkerLike): void {
    // A retired instance's late events must never affect its successor. During
    // close the current worker has already been detached from `worker`, so a
    // close reply from the instance being closed is still accepted.
    const isInactive = (): boolean =>
      retiredInstances.has(instance) || (worker !== undefined && worker !== instance);
    const onMessage = (value: unknown): void => {
      if (isInactive()) return;
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (record.type === "analytics-generation") {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch {
            // A subscriber failure never breaks the bridge.
          }
        }
        return;
      }
      const response = value as AnalyticsWorkerResponse;
      if (typeof response.id !== "number") return;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      clearTimeout(entry.timer);
      entry.resolve(response);
    };
    const onFailure = (): void => onWorkerFailure(instance);

    if (typeof instance.on === "function") {
      instance.on("message", onMessage);
      instance.on("error", onFailure);
      instance.on("exit", onFailure);
      return;
    }
    if (typeof instance.addEventListener === "function") {
      instance.addEventListener("message", (event) => {
        if (typeof event === "object" && event !== null && "data" in event) {
          onMessage((event as { data: unknown }).data);
        }
      });
      instance.addEventListener("error", onFailure);
      return;
    }
    instance.onmessage = (event) => onMessage(event.data);
    instance.onerror = onFailure;
  }

  function send(
    instance: AnalyticsWorkerLike,
    command: AnalyticsWorkerRequest["command"],
  ): Promise<AnalyticsWorkerResponse> {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<AnalyticsWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // A timed-out worker may still be alive but stuck (for example a
        // deterministic OOM loop). Retire it so the next call starts clean.
        retire(instance, "unavailable");
        reject(new AnalyticsReadError("timeout"));
      }, requestTimeoutMs);
      const unref = (timer as { unref?: () => void }).unref;
      if (typeof unref === "function") unref.call(timer);
      pending.set(id, { resolve, reject, timer });
      try {
        instance.postMessage({ id, command } satisfies AnalyticsWorkerRequest);
      } catch {
        pending.delete(id);
        clearTimeout(timer);
        retire(instance, "unavailable");
        reject(new AnalyticsReadError("unavailable"));
      }
    });
  }

  async function ensureWorker(): Promise<AnalyticsWorkerLike> {
    if (closed) throw new AnalyticsReadError("closed");
    if (broken) throw new AnalyticsReadError("unavailable");
    if (worker) return worker;
    if (workerPromise) return await workerPromise;
    if (Date.now() < nextRetryAtMs) throw new AnalyticsReadError("unavailable");

    const creation = (async () => {
      let instance: AnalyticsWorkerLike | undefined;
      try {
        instance = await createWorker();
        if (closed) {
          instance.terminate();
          throw new AnalyticsReadError("closed");
        }
        // Publish the instance before attaching so a synchronously delivered
        // failure is recognized as the current worker rather than a stale one.
        worker = instance;
        attach(instance);
        try {
          instance.unref?.();
        } catch {
          // Best effort.
        }
        const response = await send(instance, { kind: "init", options: initOptions });
        if (!response.ok) throw new AnalyticsReadError(response.error.code);
        failures = 0;
        nextRetryAtMs = 0;
        return instance;
      } catch (error: unknown) {
        const wasRetired = instance !== undefined && retiredInstances.has(instance);
        if (instance !== undefined) {
          // Even an init-failure instance gets no further event handling.
          retiredInstances.add(instance);
          if (worker === instance) {
            worker = undefined;
            workerPromise = undefined;
          }
          try {
            instance.terminate();
          } catch {
            // Best effort.
          }
        }
        if (closed) throw new AnalyticsReadError("closed");
        if (error instanceof AnalyticsReadError && error.code === "closed") throw error;
        if (instance === undefined || !wasRetired) registerFailure();
        throw new AnalyticsReadError("unavailable");
      }
    })().finally(() => {
      if (workerPromise === creation) workerPromise = undefined;
    });
    workerPromise = creation;
    return await creation;
  }

  async function call<TResult>(command: AnalyticsWorkerRequest["command"]): Promise<TResult> {
    const key = coalescedCommandKey(command);
    if (key !== undefined) {
      const existing = inFlightReads.get(key);
      // SAFETY: the key covers every input of the command, and all callers of
      // that key request the same result type.
      if (existing !== undefined) return existing as Promise<TResult>;
    }

    const request = (async () => {
      const instance = await ensureWorker();
      // `close` may have run, or the resolved worker may have crashed, while
      // this call was waiting. Never post into a dead instance that already
      // failed its other waiters.
      if (closed) throw new AnalyticsReadError("closed");
      if (retiredInstances.has(instance)) throw new AnalyticsReadError("unavailable");
      const response = await send(instance, command);
      if (!response.ok) throw new AnalyticsReadError(response.error.code);
      return response.result as TResult;
    })();

    if (key !== undefined) {
      inFlightReads.set(key, request);
      const clear = (): void => {
        if (inFlightReads.get(key) === request) inFlightReads.delete(key);
      };
      // Registered before any joiner awaits the promise, so a settled entry is
      // gone before a rejection reaches caller code: a retry always re-posts.
      void request.then(clear, clear);
    }
    return request;
  }

  return {
    async init(nextOptions: AnalyticsInitOptions) {
      if (closed) throw new AnalyticsReadError("closed");
      initOptions = nextOptions;
      await ensureWorker();
    },
    home: (range) => call({ kind: "home", range }),
    project: (projectId, range) => call({ kind: "project", projectId, range }),
    session: (sessionId) => call({ kind: "session", sessionId }),
    refresh: () => call<void>({ kind: "refresh" }),
    stats: () => call({ kind: "stats" }),
    gc: () => call({ kind: "gc" }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const instance = worker;
      worker = undefined;
      workerPromise = undefined;
      listeners.clear();
      failPending("closed");
      if (instance) {
        // Give the worker engine a bounded chance to drain queued persistence
        // before the thread is terminated.
        try {
          await Promise.race([
            send(instance, { kind: "close" }).catch(() => undefined),
            new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 2_500);
              const unref = (timer as { unref?: () => void }).unref;
              if (typeof unref === "function") unref.call(timer);
            }),
          ]);
        } catch {
          // Close remains best effort.
        }
        try {
          instance.terminate();
        } catch {
          // Termination is best effort; pending callers were already rejected.
        }
        failPending("closed");
      }
    },
  };
}
