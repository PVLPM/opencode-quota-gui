/**
 * Public analytics read service.
 *
 * One lazy worker per service/host: no worker, timer, database read, or provider
 * work starts until the first analytics call. Worker construction and persisted
 * snapshot defaults are documented in
 * `.superpowers/sdd/unified-analytics-liveness/analytics-api.md`.
 */
import type { HomeSnapshot, ProjectSnapshot, SessionSnapshot } from "../contracts/dashboard.js";
import { isRangeKey, type RangeKey } from "../contracts/ranges.js";
import { createAnalyticsBridge } from "./analytics-bridge.js";
import {
  AnalyticsReadError,
  type AnalyticsTransport,
  type AnalyticsWorkerMemoryStats,
} from "./analytics-protocol.js";
import { createGuiLogger, type GuiLogger } from "./log.js";

export interface AnalyticsReadService {
  home(input: { range: RangeKey }): Promise<HomeSnapshot>;
  project(input: { projectId: string; range: RangeKey }): Promise<ProjectSnapshot>;
  session(input: { sessionId: string }): Promise<SessionSnapshot>;
  /** Coalesced forced refresh (optional in the spec; always present here). */
  refresh(): Promise<void>;
  /** Worker-side memory sample (benchmark/diagnostics; optional transport seam). */
  stats?(): Promise<AnalyticsWorkerMemoryStats>;
  /** Best-effort worker GC (benchmark/diagnostics; optional transport seam). */
  gc?(): Promise<boolean>;
  /** Generation notifications; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  close(): Promise<void>;
}

export interface AnalyticsReadServiceOptions {
  snapshotPath?: string;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  logger?: GuiLogger;
  /** Optional Node worker heap ceiling; omit for runtime-managed default. */
  workerHeapLimitMb?: number;
  /** Bounded transport init recovery (default 5 attempts). */
  maxTransportAttempts?: number;
  /** Base backoff for transport init recovery (default 250 ms). */
  transportRetryBaseMs?: number;
  /** Test/embedding seam; production default builds the Node/Bun worker bridge. */
  createTransport?: () => AnalyticsTransport | Promise<AnalyticsTransport>;
}

const DEFAULT_MAX_TRANSPORT_ATTEMPTS = 5;
const DEFAULT_TRANSPORT_RETRY_BASE_MS = 250;
const MAX_TRANSPORT_RETRY_DELAY_MS = 5_000;

function badRequest(): AnalyticsReadError {
  return new AnalyticsReadError("bad-request");
}

export function createAnalyticsReadService(
  options: AnalyticsReadServiceOptions = {},
): AnalyticsReadService {
  const logger = options.logger ?? createGuiLogger();
  const createTransport =
    options.createTransport ??
    (() =>
      createAnalyticsBridge({
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
        ...(options.workerHeapLimitMb === undefined
          ? {}
          : { workerHeapLimitMb: options.workerHeapLimitMb }),
        logger,
      }));
  const maxTransportAttempts =
    options.maxTransportAttempts !== undefined &&
    Number.isFinite(options.maxTransportAttempts) &&
    options.maxTransportAttempts > 0
      ? Math.floor(options.maxTransportAttempts)
      : DEFAULT_MAX_TRANSPORT_ATTEMPTS;
  const transportRetryBaseMs =
    options.transportRetryBaseMs !== undefined &&
    Number.isFinite(options.transportRetryBaseMs) &&
    options.transportRetryBaseMs >= 0
      ? options.transportRetryBaseMs
      : DEFAULT_TRANSPORT_RETRY_BASE_MS;

  let transportPromise: Promise<AnalyticsTransport> | undefined;
  let initialized = false;
  let failures = 0;
  let nextRetryAtMs = 0;
  let permanentlyUnavailable = false;
  let closed = false;
  let unsubscribeTransport: (() => void) | undefined;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // A subscriber failure never breaks delivery.
      }
    }
  }

  function attachSubscription(created: AnalyticsTransport): void {
    if (unsubscribeTransport || !created.subscribe) return;
    unsubscribeTransport = created.subscribe(notify);
  }

  function retryDelayMs(): number {
    return Math.min(
      MAX_TRANSPORT_RETRY_DELAY_MS,
      transportRetryBaseMs * 2 ** Math.max(0, failures - 1),
    );
  }

  function recordFailure(): void {
    failures += 1;
    nextRetryAtMs = Date.now() + retryDelayMs();
    if (failures >= maxTransportAttempts) permanentlyUnavailable = true;
    logger.warn("analytics transport unavailable", "transport-unavailable");
  }

  async function ensureTransport(): Promise<AnalyticsTransport> {
    if (closed) throw new AnalyticsReadError("closed");
    if (permanentlyUnavailable) throw new AnalyticsReadError("unavailable");
    if (!transportPromise) {
      transportPromise = (async () => await createTransport())().catch((error: unknown) => {
        transportPromise = undefined;
        recordFailure();
        if (error instanceof AnalyticsReadError) throw error;
        throw new AnalyticsReadError("unavailable");
      });
    }
    const created = await transportPromise;
    if (initialized) return created;
    if (Date.now() < nextRetryAtMs) throw new AnalyticsReadError("unavailable");
    try {
      await created.init({
        ...(options.snapshotPath === undefined ? {} : { snapshotPath: options.snapshotPath }),
        ...(options.refreshIntervalMs === undefined
          ? {}
          : { refreshIntervalMs: options.refreshIntervalMs }),
      });
      initialized = true;
      failures = 0;
      nextRetryAtMs = 0;
      attachSubscription(created);
      return created;
    } catch (error: unknown) {
      recordFailure();
      if (failures >= maxTransportAttempts) {
        transportPromise = undefined;
        try {
          await created.close();
        } catch {
          // Best effort.
        }
      }
      if (closed) throw new AnalyticsReadError("closed");
      if (error instanceof AnalyticsReadError) throw error;
      throw new AnalyticsReadError("unavailable");
    }
  }

  function validateRange(range: RangeKey): void {
    if (!isRangeKey(range)) throw badRequest();
  }

  return {
    async home(input) {
      validateRange(input.range);
      return (await ensureTransport()).home(input.range);
    },

    async project(input) {
      validateRange(input.range);
      if (typeof input.projectId !== "string" || input.projectId.length === 0) throw badRequest();
      return (await ensureTransport()).project(input.projectId, input.range);
    },

    async session(input) {
      if (typeof input.sessionId !== "string" || input.sessionId.length === 0) throw badRequest();
      return (await ensureTransport()).session(input.sessionId);
    },

    async refresh() {
      if (closed) throw new AnalyticsReadError("closed");
      await (await ensureTransport()).refresh();
    },

    async stats() {
      if (closed) throw new AnalyticsReadError("closed");
      const created = await ensureTransport();
      if (!created.stats) throw new AnalyticsReadError("unavailable");
      return await created.stats();
    },

    async gc() {
      if (closed) throw new AnalyticsReadError("closed");
      const created = await ensureTransport();
      if (!created.gc) return false;
      return await created.gc();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      if (unsubscribeTransport) {
        unsubscribeTransport();
        unsubscribeTransport = undefined;
      }
      const pending = transportPromise;
      transportPromise = undefined;
      if (pending) {
        try {
          const created = await pending.catch(() => undefined);
          if (created) await created.close();
        } catch {
          // Close is best effort and never throws.
        }
      }
      listeners.clear();
    },
  };
}
