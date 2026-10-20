/**
 * Analytics worker protocol (transport-neutral).
 *
 * Only compact request frames and finished dashboard DTOs cross the worker
 * boundary. Raw storage rows, compact fingerprints, coverage windows, and the
 * analytics model stay inside the worker.
 */
import type { HomeSnapshot, ProjectSnapshot, SessionSnapshot } from "../contracts/dashboard.js";
import type { RangeKey } from "../contracts/ranges.js";

export const ANALYTICS_WORKER_PROTOCOL_VERSION = 1;

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
  | { kind: "home"; range: RangeKey }
  | { kind: "project"; projectId: string; range: RangeKey }
  | { kind: "session"; sessionId: string }
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
 * Host-side transport seam. Production uses a Node/Bun worker bridge; tests
 * substitute a loopback transport over the same engine/protocol.
 */
export interface AnalyticsTransport {
  init(options: AnalyticsInitOptions): Promise<void>;
  home(range: RangeKey): Promise<HomeSnapshot>;
  project(projectId: string, range: RangeKey): Promise<ProjectSnapshot>;
  session(sessionId: string): Promise<SessionSnapshot>;
  refresh(): Promise<void>;
  /** Optional diagnostics seam; the real worker implements it. */
  stats?(): Promise<AnalyticsWorkerMemoryStats>;
  /** Optional GC seam; returns false when the runtime exposes no hook. */
  gc?(): Promise<boolean>;
  /** Optional generation notifications; returns an unsubscribe function. */
  subscribe?(listener: () => void): () => void;
  close(): Promise<void>;
}
