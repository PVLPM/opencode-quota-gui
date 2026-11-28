/**
 * Analytics worker protocol (transport-neutral).
 *
 * Only compact request frames and finished dashboard DTOs cross the worker
 * boundary. Raw storage rows, compact fingerprints, coverage windows, and the
 * analytics model stay inside the worker.
 */
import type {
  AnalyticsGroupQuery,
  AnalyticsGroupSnapshot,
  AnalyticsRangeReader,
  HomeSnapshot,
  ProjectSnapshot,
  SessionSnapshot,
} from "../contracts/dashboard.js";
import type { RangeKey } from "../contracts/ranges.js";
import type { UsageActivityQuery, UsageActivityResult } from "../contracts/usage-activity.js";
import type { PricingSnapshotConfig } from "../lib/types.js";

export const ANALYTICS_WORKER_PROTOCOL_VERSION = 1;

export { ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS } from "../contracts/dashboard.js";

export type AnalyticsErrorCode =
  | "bad-request"
  | "project-not-found"
  | "session-not-found"
  | "unavailable"
  | "closed"
  | "timeout";

/** A controlled analytics failure; messages are fixed and path-free. */
export class AnalyticsReadError extends Error {
  readonly code: AnalyticsErrorCode;

  constructor(code: AnalyticsErrorCode) {
    super(code);
    this.name = "AnalyticsReadError";
    this.code = code;
  }
}

export interface AnalyticsInitOptions {
  snapshotPath?: string;
  refreshIntervalMs?: number;
  /** Owner's pricing snapshot selection and freshness policy for the worker. */
  pricingSnapshot?: PricingSnapshotConfig;
}

/** Cumulative timing for one fixed worker phase; contains no identifying data. */
export interface AnalyticsPhaseTiming {
  count: number;
  totalMs: number;
}

/** Fixed-label phase metrics returned with worker stats. */
export type AnalyticsPhaseMetrics = Record<string, AnalyticsPhaseTiming>;

/** Worker-side memory sample used by the benchmark and diagnostics. */
export interface AnalyticsWorkerMemoryStats {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  peakHeapUsed: number;
  peakRss: number;
  /** Cumulative phase timings since worker start; labels/counts/times only. */
  phases?: AnalyticsPhaseMetrics;
}

/** A command sent to the one analytics worker. IDs are added by the bridge. */
export type AnalyticsWorkerCommand =
  | { kind: "init"; options: AnalyticsInitOptions }
  | { kind: "home"; range: RangeKey; exact?: boolean }
  | { kind: "project"; projectId: string; range: RangeKey }
  | { kind: "session"; sessionId: string }
  | { kind: "groups"; query: AnalyticsGroupQuery }
  | { kind: "activity"; query: UsageActivityQuery }
  | { kind: "refresh" }
  | { kind: "stats" }
  | { kind: "gc" }
  | { kind: "close" };

export interface AnalyticsWorkerRequest {
  id: number;
  command: AnalyticsWorkerCommand;
}

export type AnalyticsWorkerResult =
  | HomeSnapshot
  | ProjectSnapshot
  | SessionSnapshot
  | AnalyticsGroupSnapshot
  | UsageActivityResult
  | AnalyticsWorkerMemoryStats
  | boolean
  | undefined;

export type AnalyticsWorkerResponse =
  | { id: number; ok: true; result?: AnalyticsWorkerResult }
  | { id: number; ok: false; error: { code: AnalyticsErrorCode } };

/** Unsolicited worker -> host notification: a new data generation is ready. */
export interface AnalyticsGenerationNotification {
  type: "analytics-generation";
  generation: number;
}

/**
 * Unsolicited worker -> host notification: priced-snapshot upkeep (a models.dev
 * refresh and persistence) is running or has settled. The host keeps the worker
 * alive while upkeep is active so a refresh started after the last read reply
 * can finish instead of being cut off by idle retirement.
 */
export interface AnalyticsUpkeepNotification {
  type: "analytics-upkeep";
  active: boolean;
}

/**
 * Host-side transport seam. Production uses a Node/Bun worker bridge; tests
 * substitute a loopback transport over the same engine/protocol.
 */
export interface AnalyticsTransport extends AnalyticsRangeReader {
  init(options: AnalyticsInitOptions): Promise<void>;
  /** Internal usage-activity read; host-only, never part of the browser contract. */
  activity(query: UsageActivityQuery): Promise<UsageActivityResult>;
  /** Optional diagnostics seam; the real worker implements it. */
  stats?(): Promise<AnalyticsWorkerMemoryStats>;
  /** Optional GC seam; returns false when the runtime exposes no hook. */
  gc?(): Promise<boolean>;
  /** Optional generation notifications; returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void;
  close(): Promise<void>;
}
