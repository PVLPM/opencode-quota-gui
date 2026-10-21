/**
 * Worker-only analytics engine.
 *
 * Every refresh stages a complete candidate inside one
 * `withOpenCodeStorageSnapshot` transaction (identity + metadata + revision
 * membership + changed-ID payload). Historical extent, the trusted source
 * `time_updated` cursor, and wall-time frontier freshness are separate: normal
 * global refreshes read only the inclusive cursor-overlap delta, scoped reads
 * never advance the cursor, and a persisted 7-day repair re-reads the indexed
 * extent plus cached scopes. There is no autonomous timer; work is
 * request-driven.
 */
import { performance } from "node:perf_hooks";

import type { HomeSnapshot, ProjectSnapshot, SessionSnapshot } from "../contracts/dashboard.js";
import { isRangeKey, type RangeKey, rangeWindow } from "../contracts/ranges.js";
import {
  compareOpenCodeSourceIdentity,
  type OpenCodeMessageRevisionSnapshot,
  type OpenCodeRawAssistantRow,
  type OpenCodeSessionInfo,
  type OpenCodeSourceIdentity,
  type OpenCodeStorageSnapshot,
  type OpenCodeStorageSnapshotResult,
  type ReadCompletedAssistantRowsParams,
} from "../lib/opencode-storage.js";
import { createUsageAnalytics, UNKNOWN_PROJECT_ID } from "./aggregation.js";
import { createAnalyticsIndexes } from "./analytics-indexes.js";
import { type AnalyticsModel, createAnalyticsModel } from "./analytics-model.js";
import type { AnalyticsPhaseMetrics } from "./analytics-protocol.js";
import { type AnalyticsReader, createAnalyticsReader } from "./analytics-reader.js";
import {
  ANALYTICS_PRESENTATION_SESSION_LIMIT,
  type AnalyticsCoverage,
  type AnalyticsPresentation,
  type AnalyticsState,
  compactFingerprintOf,
  defaultAnalyticsPresentationPath,
  defaultAnalyticsSnapshotPath,
  fingerprintOf,
  loadAnalyticsPresentation,
  loadAnalyticsSnapshot,
  type Occurrence,
  rowFromFingerprint,
  saveAnalyticsPresentation,
  saveAnalyticsSnapshot,
  type WarmAnalyticsPresentation,
} from "./analytics-state.js";
import { resolveHostTimeZone } from "./time-zone.js";

export const ANALYTICS_REFRESH_INTERVAL_MS = 600_000;
/** Explicit, rare full reconciliation cadence (persisted across restarts). */
export const ANALYTICS_FULL_REPAIR_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** Inclusive replay overlap for equal/late `time_updated` values (clock skew). */
export const ANALYTICS_SOURCE_CURSOR_OVERLAP_MS = 5 * 60_000;
const MAX_SCOPE_BATCH = 8;
const MAX_PROJECT_CACHE = 12;
const PRESENTATION_SAVE_INTERVAL_MS = 60_000;
/**
 * Idle grace before the automatic 7d -> 30d extension starts. A zero-delay
 * timer only yields one event-loop turn and can immediately queue a long
 * synchronous SQL read ahead of foreground navigation.
 */
export const ANALYTICS_THIRTY_DAY_EXTENSION_DELAY_MS = 2_000;
/** Bounded busy retries; a later 7d response schedules a fresh attempt. */
const LOW_PRIORITY_EXTENSION_MAX_DEFERRALS = 1;
const HOME_PRECOMPUTE_RANGES: readonly RangeKey[] = ["24h", "7d", "30d"];

type LowPriorityTimer = ReturnType<typeof setTimeout> & { unref?: () => void };

/**
 * Fixed instrumentation labels. Each phase is timed around the operation it
 * names and accumulates for the engine lifetime:
 *
 * - `presentationLoad` / `indexLoad`: the awaited sidecar/index loads only.
 * - `metadataRead`: session and project index reads (one count per read).
 * - `revisionDiscovery`: the projected revision scan read.
 * - `historicalPayloadRead`: every non-changed-ID row payload read, including
 *   global extent windows, scoped project/tree reads, and compaction markers.
 * - `changedPayloadRead`: `messageIDs`-keyed payload reads after revision diffs.
 * - `modelUpdate`: model clear/setMetadata/apply work, including hydration.
 * - `dtoAggregation`: model home/project derivation and session DTO assembly;
 *   `ensureModel()` is excluded and counted under `modelUpdate` instead.
 * - `persistenceWrite`: each awaited snapshot/presentation save.
 *
 * Phases deliberately exclude cache hits and queueing. Metrics contain only
 * these labels plus counts and durations; no session/project/message identity
 * or other data is recorded.
 */
const PHASE_LABELS = [
  "presentationLoad",
  "indexLoad",
  "metadataRead",
  "revisionDiscovery",
  "historicalPayloadRead",
  "changedPayloadRead",
  "modelUpdate",
  "dtoAggregation",
  "persistenceWrite",
] as const;

type PhaseLabel = (typeof PHASE_LABELS)[number];

export interface AnalyticsEngineOptions {
  reader?: AnalyticsReader;
  snapshotPath?: string;
  now?: () => number;
  refreshIntervalMs?: number;
  /** Testable override for the persisted full-reconciliation cadence. */
  fullRepairIntervalMs?: number;
  loadSnapshot?: (path: string) => Promise<AnalyticsState | undefined>;
  saveSnapshot?: (path: string, state: AnalyticsState, savedAtMs: number) => Promise<boolean>;
  loadPresentation?: (path: string) => Promise<WarmAnalyticsPresentation | undefined>;
  savePresentation?: (path: string, state: AnalyticsState, savedAtMs: number) => Promise<boolean>;
  /** Host calendar zone; defaults to the machine running the worker. */
  timeZone?: string;
  /** Host notification after a refresh produced a new data generation. */
  onGeneration?: (generation: number) => void;
  /** Bound on draining queued persistence during close. */
  closeWriteTimeoutMs?: number;
}

export interface AnalyticsWorkerMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  /** Highest heap sample observed during refresh work since engine start. */
  peakHeapUsed: number;
  peakRss: number;
  /**
   * Cumulative phase timings since engine start. Always contains every fixed
   * phase label; never contains source identifiers or raw data.
   */
  phases?: AnalyticsPhaseMetrics;
}

export interface AnalyticsEngine {
  home(range: RangeKey): Promise<HomeSnapshot>;
  project(projectId: string, range: RangeKey): Promise<ProjectSnapshot>;
  session(sessionId: string): Promise<SessionSnapshot>;
  refresh(): Promise<void>;
  stats(): Promise<AnalyticsWorkerMemory>;
  /** Best-effort GC trigger; false when the runtime exposes no hook. */
  gc(): Promise<boolean>;
  close(): Promise<void>;
}

class AnalyticsLookupError extends Error {
  readonly code: "project-not-found" | "session-not-found" | "unavailable" | "bad-request";

  constructor(code: "project-not-found" | "session-not-found" | "unavailable" | "bad-request") {
    super(code);
    this.name = "AnalyticsLookupError";
    this.code = code;
  }
}

interface RefreshJob {
  globalRange?: RangeKey;
  detailSessionIds: string[];
  projectScopes: Array<{ projectId: string; range: RangeKey }>;
  /** Set only by the engine when a persisted full reconciliation is due. */
  repair?: boolean;
}

interface StagedUpsert {
  row: OpenCodeRawAssistantRow;
  updatedAtMs: number | null;
  agent?: string;
  /** The payload reader projected the agent field (absence is authoritative). */
  agentProjected?: boolean;
}

/** Explicit loaded extent for a remembered project scope. */
interface ProjectScopeCoverage {
  signature: string;
  sessionIds: string[];
  sinceMs?: number;
  untilMs: number;
}

/** Explicit loaded tree extent for a warm session detail. */
interface DetailScopeCoverage {
  signature: string;
  untilMs: number;
}

/**
 * Revision watermark attached to a bulk payload row without allocating a
 * parallel map for every row.
 */
const WATERMARK: unique symbol = Symbol("analyticsWatermark");
type WatermarkedRow = OpenCodeRawAssistantRow & { [WATERMARK]?: number | null };

interface Candidate {
  identity: OpenCodeSourceIdentity;
  sessions: Record<string, OpenCodeSessionInfo>;
  projects: AnalyticsState["projects"];
  replaced: boolean;
  /** Bulk rows: extent/project/detail reads (deduplicated against changedMap). */
  bulkRows: OpenCodeRawAssistantRow[];
  changedMap: Map<string, StagedUpsert>;
  removalKeys: Set<string>;
  nextExtent: AnalyticsCoverage | undefined;
  extentChanged: boolean;
  detailSignatures: Array<[string, string]>;
  detailCompactions: Array<[string, Array<{ sessionId: string; atMs: number; messageId: string }>]>;
  /** Detail focuses whose full tree payload (agents included) is now loaded. */
  detailCoverageChanges: Array<[string, DetailScopeCoverage]>;
  projectSignatures: Array<[string, string]>;
  projectCoverages: Array<[string, ProjectScopeCoverage]>;
  /**
   * Global-refresh cursor outcome: a number establishes the next half-open
   * source frontier, `null` clears it because timestamps are unusable, and
   * `undefined` means this scoped refresh must not touch it.
   */
  sourceCursorAtMs?: number | null;
  /** Set when this global refresh completed a baseline/full repair. */
  repairCompletedAtMs?: number;
}

const RANGE_WIDTH: Record<RangeKey, number> = {
  "24h": 1,
  "7d": 7,
  "30d": 30,
  lifetime: 10_000,
};

function widerRange(a: RangeKey | undefined, b: RangeKey): RangeKey {
  if (a === undefined) return b;
  return RANGE_WIDTH[a] >= RANGE_WIDTH[b] ? a : b;
}

function emptyState(): AnalyticsState {
  return {
    sessions: {},
    projects: {},
    fingerprints: [],
    fingerprintIndex: new Map(),
    occurrences: new Map(),
    frontierAtMs: 0,
  };
}

function projectIdOf(session: OpenCodeSessionInfo): string {
  const value = session.projectID?.trim();
  return value ? value : UNKNOWN_PROJECT_ID;
}

function coversSince(sinceMs: number | undefined, extent: AnalyticsCoverage | undefined): boolean {
  if (!extent) return false;
  if (sinceMs === undefined) return extent.sinceMs === undefined;
  if (extent.sinceMs !== undefined && extent.sinceMs > sinceMs) return false;
  return extent.untilMs >= sinceMs;
}

function mergeExtent(
  current: AnalyticsCoverage | undefined,
  sinceMs: number | undefined,
  untilMs: number,
): AnalyticsCoverage {
  if (!current) {
    return sinceMs === undefined ? { untilMs } : { sinceMs, untilMs };
  }
  if (current.sinceMs === undefined || sinceMs === undefined) {
    return { untilMs: Math.max(current.untilMs, untilMs) };
  }
  return {
    sinceMs: Math.min(current.sinceMs, sinceMs),
    untilMs: Math.max(current.untilMs, untilMs),
  };
}

function sessionRevisionSignature(
  sessions: Record<string, OpenCodeSessionInfo>,
  ids: readonly string[],
): string {
  return ids
    .map((id) => {
      const session = sessions[id];
      return `${id}:${session?.title ?? ""}:${session?.parentID ?? ""}:${
        session?.time?.created ?? ""
      }:${session?.time?.updated ?? ""}`;
    })
    .join("|");
}

/** Parent/project topology only; title and timestamp churn must not reindex. */
function sessionIndexSignature(sessions: Record<string, OpenCodeSessionInfo>): string {
  return Object.values(sessions)
    .map((session) => `${session.id}\u0000${session.parentID ?? ""}\u0000${projectIdOf(session)}`)
    .sort()
    .join("\u0001");
}

function projectSignature(
  projectId: string,
  range: RangeKey,
  sessionIds: readonly string[],
): string {
  return `${projectId}|${range}|${sessionIds.join(",")}`;
}

function metadataChanged(previous: unknown, next: unknown): boolean {
  return JSON.stringify(previous) !== JSON.stringify(next);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Positive completion time only for completed assistant rows; 0 otherwise. */
function revisionCompletedAt(revision: { type: string; completedAtMs: number | null }): number {
  return revision.type === "assistant" &&
    revision.completedAtMs !== null &&
    revision.completedAtMs > 0
    ? revision.completedAtMs
    : 0;
}

export function createAnalyticsEngine(options: AnalyticsEngineOptions = {}): AnalyticsEngine {
  const reader = options.reader ?? createAnalyticsReader();
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? resolveHostTimeZone();
  const snapshotPath = options.snapshotPath ?? defaultAnalyticsSnapshotPath();
  const refreshIntervalMs =
    options.refreshIntervalMs !== undefined && Number.isFinite(options.refreshIntervalMs)
      ? Math.max(0, options.refreshIntervalMs)
      : ANALYTICS_REFRESH_INTERVAL_MS;
  const fullRepairIntervalMs =
    options.fullRepairIntervalMs !== undefined && Number.isFinite(options.fullRepairIntervalMs)
      ? Math.max(0, options.fullRepairIntervalMs)
      : ANALYTICS_FULL_REPAIR_INTERVAL_MS;
  const loadSnapshot = options.loadSnapshot ?? loadAnalyticsSnapshot;
  const saveSnapshot = options.saveSnapshot ?? saveAnalyticsSnapshot;
  const presentationPath =
    options.snapshotPath === undefined
      ? defaultAnalyticsPresentationPath(snapshotPath)
      : `${snapshotPath}.presentation.json`;
  const loadPresentation = options.loadPresentation ?? loadAnalyticsPresentation;
  const savePresentation = options.savePresentation ?? saveAnalyticsPresentation;

  // Instrumentation-only accounting; it never affects control flow or results.
  const phaseTotals = new Map<PhaseLabel, { count: number; totalMs: number }>();

  function recordPhase(label: PhaseLabel, startedAtMs: number): void {
    const totalMs = performance.now() - startedAtMs;
    const entry = phaseTotals.get(label);
    if (entry) {
      entry.count += 1;
      entry.totalMs += totalMs;
    } else {
      phaseTotals.set(label, { count: 1, totalMs });
    }
  }

  function measureSync<T>(label: PhaseLabel, work: () => T): T {
    const startedAtMs = performance.now();
    try {
      return work();
    } finally {
      recordPhase(label, startedAtMs);
    }
  }

  async function measureAsync<T>(label: PhaseLabel, work: () => Promise<T>): Promise<T> {
    const startedAtMs = performance.now();
    try {
      return await work();
    } finally {
      recordPhase(label, startedAtMs);
    }
  }

  function phaseMetrics(): AnalyticsPhaseMetrics {
    const metrics: AnalyticsPhaseMetrics = {};
    for (const label of PHASE_LABELS) {
      const entry = phaseTotals.get(label);
      metrics[label] = entry
        ? { count: entry.count, totalMs: entry.totalMs }
        : { count: 0, totalMs: 0 };
    }
    return metrics;
  }

  const model: AnalyticsModel = createAnalyticsModel({ timeZone });
  const indexes = createAnalyticsIndexes();
  let state = emptyState();
  let lastSessionIndexSignature = "";
  let loaded = false;
  let loading: Promise<void> | undefined;
  let indexLoaded = false;
  let indexLoading: Promise<void> | undefined;
  let warmPresentation: WarmAnalyticsPresentation | undefined;
  let warmSourceIdentity: OpenCodeSourceIdentity | undefined;
  let warmIdentityVerification: Promise<boolean> | undefined;
  let warmIdentityVerifiedGeneration = -1;
  let coverageTrusted = false;
  let sidecarNewerThanIndex = false;
  let lowPriorityTimer: LowPriorityTimer | undefined;
  let closed = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let modelHydrated = false;
  let modelDirty = true;
  let lastPresentationSaveAtMs = 0;
  let presentationSavedAtMs = 0;
  let generation = 0;
  const projectFreshAt = new Map<string, number>();
  const detailFreshAt = new Map<string, number>();
  const closeWriteTimeoutMs =
    options.closeWriteTimeoutMs !== undefined && Number.isFinite(options.closeWriteTimeoutMs)
      ? Math.max(0, options.closeWriteTimeoutMs)
      : 2_000;

  let pendingGlobal: RangeKey | undefined;
  let pendingMetadataOnly = false;
  const pendingDetailSessions = new Set<string>();
  const pendingProjectScopes = new Map<string, RangeKey>();
  let refreshPromise: Promise<void> | undefined;
  const lastGlobalRange = { value: undefined as RangeKey | undefined };
  const lastDetailSessionIds = new Set<string>();
  const lastProjectScopes = new Map<string, RangeKey>();

  let lastGlobalAttemptAtMs = 0;
  let lastScopedAttemptAtMs = 0;
  let unavailable = false;
  let peakHeapUsed = 0;
  let peakRss = 0;

  // Persistence is serialized so an older generation can never rename over a
  // newer one, and writes capture the generation they are allowed to publish.
  let writeChain: Promise<void> = Promise.resolve();
  let snapshotWritePending: { revision: number; atMs: number } | undefined;
  let presentationWritePending:
    | { generation: number; atMs: number; savedAtMs: number; force: boolean }
    | undefined;
  let compactRevision = 0;
  let compactDirty = false;
  let writeDrainScheduled = false;

  function samplePeak(): void {
    const usage = process.memoryUsage();
    if (usage.heapUsed > peakHeapUsed) peakHeapUsed = usage.heapUsed;
    if (usage.rss > peakRss) peakRss = usage.rss;
  }

  function setWatermark(row: OpenCodeRawAssistantRow, value: number | null): void {
    (row as WatermarkedRow)[WATERMARK] = value;
  }

  const detailSignatures = new Map<string, string>();
  const detailCompactions = new Map<
    string,
    Array<{ sessionId: string; atMs: number; messageId: string }>
  >();
  const projectSignatures = new Map<string, string>();
  const projectCoverage = new Map<string, ProjectScopeCoverage>();
  const detailCoverage = new Map<string, DetailScopeCoverage>();

  function rowOf(occurrence: Occurrence): OpenCodeRawAssistantRow | undefined {
    const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
    if (!fingerprint) return undefined;
    return rowFromFingerprint(fingerprint, occurrence);
  }

  function internFingerprint(row: OpenCodeRawAssistantRow): {
    index: number;
    fingerprint: string;
  } {
    const fingerprint = fingerprintOf(row);
    let index = state.fingerprintIndex.get(fingerprint);
    if (index === undefined) {
      index = state.fingerprints.length;
      state.fingerprints.push(compactFingerprintOf(row));
      state.fingerprintIndex.set(fingerprint, index);
    }
    return { index, fingerprint };
  }

  function setRow(row: OpenCodeRawAssistantRow, updatedAtMs: number | null, agent?: string): void {
    const { index } = internFingerprint(row);
    const occurrence: Occurrence = {
      fingerprintIndex: index,
      sessionID: row.sessionID,
      messageID: row.messageID,
      updatedAtMs,
    };
    if (agent !== undefined) occurrence.agent = agent;
    state.occurrences.set(row.messageID, occurrence);
    indexes.upsert(occurrence);
  }

  function trimMap<K, V>(map: Map<K, V>, limit: number): void {
    while (map.size > limit) {
      const oldest = map.keys().next().value as K | undefined;
      if (oldest === undefined) return;
      map.delete(oldest);
    }
  }

  function trimSet<T>(set: Set<T>, limit: number): void {
    while (set.size > limit) {
      const oldest = set.values().next().value as T | undefined;
      if (oldest === undefined) return;
      set.delete(oldest);
    }
  }

  /**
   * Loads only the small warm presentation sidecar. The big index loads lazily
   * so the first useful home/project/session view never waits for occurrences.
   */
  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        warmPresentation = await measureAsync("presentationLoad", () =>
          loadPresentation(presentationPath),
        );
      } catch {
        warmPresentation = undefined;
      }
      if (warmPresentation) {
        state.presentation = warmPresentation;
        warmSourceIdentity = warmPresentation.sourceIdentity;
        presentationSavedAtMs = warmPresentation.savedAtMs ?? 0;
        if (warmPresentation.coverage) state.extent = warmPresentation.coverage;
        const warmFreshness = warmPresentation.frontierAtMs ?? warmPresentation.savedAtMs;
        if (warmFreshness !== undefined) {
          state.frontierAtMs = Math.max(state.frontierAtMs, warmFreshness);
        }
      }
      loaded = true;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  /**
   * A sidecar hit must not bypass a definite source replacement. This opens the
   * lightweight identity-only snapshot (no metadata, revision, or payload scan).
   * An unavailable source keeps the last good DTOs for a stale response.
   */
  function warmCacheAllowed(): Promise<boolean> {
    if (!warmPresentation) return Promise.resolve(true);
    if (warmIdentityVerification && warmIdentityVerifiedGeneration === generation) {
      return warmIdentityVerification;
    }
    const checkGeneration = generation;
    warmIdentityVerifiedGeneration = checkGeneration;
    warmIdentityVerification = (async () => {
      let result: OpenCodeStorageSnapshotResult<OpenCodeSourceIdentity>;
      try {
        result = await reader.withSnapshot((snapshot) => snapshot.identity);
      } catch {
        unavailable = true;
        return true;
      }
      if (result.status !== "ok") {
        unavailable = true;
        return true;
      }
      if (
        compareOpenCodeSourceIdentity(warmPresentation?.sourceIdentity, result.value) !== "changed"
      ) {
        return true;
      }
      warmPresentation = undefined;
      warmSourceIdentity = undefined;
      warmIdentityVerifiedGeneration = -1;
      state.presentation = undefined;
      state.extent = undefined;
      state.frontierAtMs = 0;
      return false;
    })();
    return warmIdentityVerification;
  }

  /** Loads the persisted compact index (occurrences/fingerprints/identity). */
  async function ensureIndexLoaded(): Promise<void> {
    await ensureLoaded();
    if (indexLoaded) return;
    if (indexLoading) return indexLoading;
    indexLoading = (async () => {
      let persisted: AnalyticsState | undefined;
      try {
        persisted = await measureAsync("indexLoad", () => loadSnapshot(snapshotPath));
      } catch {
        persisted = undefined;
      }
      if (persisted) {
        state = persisted;
        coverageTrusted = true;
        const persistedIdentity = persisted.sourceIdentity;
        const warmIdentity = warmPresentation?.sourceIdentity;
        const warmSavedAtMs = warmPresentation?.savedAtMs;
        const persistedSavedAtMs = persisted.savedAtMs;
        const sameIdentity =
          warmPresentation !== undefined &&
          persistedIdentity !== undefined &&
          warmIdentity !== undefined &&
          compareOpenCodeSourceIdentity(persistedIdentity, warmIdentity) === "same";
        const notOlder =
          warmSavedAtMs !== undefined &&
          persistedSavedAtMs !== undefined &&
          warmSavedAtMs >= persistedSavedAtMs;
        if (sameIdentity && notOlder) {
          // The sidecar may serve its cached DTOs, but only the compact index
          // certifies loaded occurrences, cursor, extent, and freshness. A
          // newer savedAt alone is not checkpoint proof; merging sidecar
          // coverage would let a failed snapshot write hide missing history.
          state.presentation = warmPresentation;
          const uncertified =
            warmPresentation?.frontierAtMs === 0 || warmPresentation?.coverage === undefined;
          sidecarNewerThanIndex =
            uncertified ||
            (warmSavedAtMs !== undefined &&
              persistedSavedAtMs !== undefined &&
              warmSavedAtMs > persistedSavedAtMs);
          if (sidecarNewerThanIndex) coverageTrusted = false;
          // Re-check the source lazily on the next cached serve after loading
          // the compact index; a replacement may have happened while the index
          // was being read.
          warmIdentityVerification = undefined;
          warmIdentityVerifiedGeneration = -1;
        } else if (warmPresentation) {
          // A missing/mismatched token or an older sidecar cannot certify these
          // DTOs against the persisted index; never let it shadow newer data.
          state.presentation = undefined;
          warmPresentation = undefined;
          warmSourceIdentity = undefined;
          sidecarNewerThanIndex = false;
        }
        presentationSavedAtMs =
          state.presentation !== undefined
            ? (warmSavedAtMs ?? presentationSavedAtMs)
            : (persistedSavedAtMs ?? presentationSavedAtMs);
      }
      indexes.rebuild(state.occurrences.values(), state.sessions);
      lastSessionIndexSignature = sessionIndexSignature(state.sessions);
      indexLoaded = true;
    })().finally(() => {
      indexLoading = undefined;
    });
    return indexLoading;
  }

  function ensureModel(): void {
    if (modelHydrated && !modelDirty) return;
    measureSync("modelUpdate", () => {
      model.clear();
      model.setMetadata(state.sessions, state.projects);
      const rows = function* rowsForModel(): Generator<OpenCodeRawAssistantRow> {
        for (const occurrence of state.occurrences.values()) {
          const row = rowOf(occurrence);
          if (row) yield row;
        }
      };
      model.apply(rows(), []);
    });
    modelHydrated = true;
    modelDirty = false;
  }

  /**
   * Minimal scoped dataset for the shared session DTO builder: tree rows plus
   * every stored occurrence that shares a tree fingerprint (fork owners). The
   * metadata is narrowed to those rows' sessions plus their ancestors so the
   * shared builder never rebuilds unrelated session/project trees.
   */
  function sessionDataset(sessionId: string): {
    sessions: AnalyticsState["sessions"];
    projects: AnalyticsState["projects"];
    messages: OpenCodeRawAssistantRow[];
    compactions: Array<{ sessionId: string; atMs: number; messageId: string }>;
  } {
    const ids = indexes.treeIds(sessionId);
    const fingerprintIndexes = new Set<number>();
    const includedSessionIds = new Set(ids);
    for (const messageID of indexes.sessionMessages(ids)) {
      const occurrence = state.occurrences.get(messageID);
      if (occurrence) fingerprintIndexes.add(occurrence.fingerprintIndex);
    }

    const messages: OpenCodeRawAssistantRow[] = [];
    for (const messageID of indexes.fingerprintMessages(fingerprintIndexes)) {
      const occurrence = state.occurrences.get(messageID);
      if (!occurrence) continue;
      const row = rowOf(occurrence);
      if (!row) continue;
      messages.push(row);
      includedSessionIds.add(occurrence.sessionID);
    }

    const sessions: AnalyticsState["sessions"] = {};
    for (const id of includedSessionIds) {
      let ancestorId: string | undefined = id;
      const seen = new Set<string>();
      while (ancestorId !== undefined && !seen.has(ancestorId)) {
        seen.add(ancestorId);
        const session: OpenCodeSessionInfo | undefined = state.sessions[ancestorId];
        if (!session) break;
        sessions[ancestorId] = session;
        ancestorId = session.parentID;
      }
    }

    const projects: AnalyticsState["projects"] = {};
    const focus = state.sessions[sessionId];
    if (focus) {
      const projectId = projectIdOf(focus);
      const info = state.projects[projectId];
      if (info) projects[projectId] = info;
    }

    return {
      sessions,
      projects,
      messages,
      compactions: detailCompactions.get(sessionId) ?? [],
    };
  }

  function stateHasProject(projectId: string): boolean {
    return (
      Object.hasOwn(state.projects, projectId) || indexes.projectSessions(projectId).length > 0
    );
  }

  function isStale(atMs: number): boolean {
    if (unavailable) return true;
    return atMs - state.frontierAtMs >= refreshIntervalMs;
  }

  function isDetailFresh(sessionId: string, atMs: number): boolean {
    const freshAt = detailFreshAt.get(sessionId);
    return freshAt !== undefined && atMs - freshAt < refreshIntervalMs;
  }

  function dueForAttempt(job: RefreshJob, atMs: number): boolean {
    const baseline =
      job.globalRange !== undefined
        ? Math.max(state.frontierAtMs, lastGlobalAttemptAtMs)
        : lastScopedAttemptAtMs;
    return atMs - baseline >= refreshIntervalMs;
  }

  function setHomeCache(range: RangeKey, snapshot: HomeSnapshot): void {
    const presentation: AnalyticsPresentation = state.presentation ?? { home: {}, project: [] };
    presentation.home[range] = snapshot;
    state.presentation = presentation;
  }

  function cacheHome(range: RangeKey, snapshot: HomeSnapshot, atMs: number): void {
    setHomeCache(range, snapshot);
    persistPresentation(atMs);
  }

  function cacheProject(snapshot: ProjectSnapshot, atMs: number): void {
    const presentation: AnalyticsPresentation = state.presentation ?? { home: {}, project: [] };
    const filtered = presentation.project.filter(
      ([projectId, range]) => projectId !== snapshot.projectId || range !== snapshot.range,
    );
    filtered.push([snapshot.projectId, snapshot.range, snapshot]);
    while (filtered.length > MAX_PROJECT_CACHE) filtered.shift();
    presentation.project = filtered;
    state.presentation = presentation;
    persistPresentation(atMs);
  }

  function cachedProject(projectId: string, range: RangeKey): ProjectSnapshot | undefined {
    const entry = state.presentation?.project.find(
      ([id, entryRange]) => id === projectId && entryRange === range,
    );
    const snapshot = entry?.[2];
    return snapshot?.usage.timeZone === timeZone ? snapshot : undefined;
  }

  function projectScopeCovered(projectId: string, range: RangeKey, atMs: number): boolean {
    const coverage = projectCoverage.get(projectId);
    if (!coverage) return false;
    if (
      coverage.signature !== projectSignature(projectId, range, indexes.projectSessions(projectId))
    ) {
      return false;
    }
    return coversSince(rangeWindow(range, atMs).sinceMs, coverage);
  }

  /**
   * The only epochs a cached Home/Project window may be advanced to are actual
   * successful sync epochs. Wall-clock time, a cached DTO's generatedAt, or a
   * project-only scope refresh must never create one.
   */
  function homeCertifiedSyncAtMs(range: RangeKey, atMs: number): number | undefined {
    if (!indexLoaded || !coverageTrusted || state.frontierAtMs <= 0) return undefined;
    if (!coversSince(rangeWindow(range, atMs).sinceMs, state.extent)) return undefined;
    return state.frontierAtMs;
  }

  function projectCertifiedSyncAtMs(
    projectId: string,
    range: RangeKey,
    atMs: number,
  ): number | undefined {
    let certified: number | undefined;
    if (
      indexLoaded &&
      coverageTrusted &&
      state.frontierAtMs > 0 &&
      coversSince(rangeWindow(range, atMs).sinceMs, state.extent)
    ) {
      certified = state.frontierAtMs;
    }
    const projectFresh = projectFreshAt.get(projectId);
    if (projectFresh !== undefined && projectScopeCovered(projectId, range, atMs)) {
      certified = certified === undefined ? projectFresh : Math.max(certified, projectFresh);
    }
    return certified;
  }

  function cachedSession(sessionId: string): SessionSnapshot | undefined {
    const entry = state.presentation?.session?.find(([id]) => id === sessionId);
    const snapshot = entry?.[1];
    return snapshot?.timeZone === timeZone ? snapshot : undefined;
  }

  /** Cache a fresh session DTO as the newest LRU entry (oldest-first order). */
  function cacheSession(sessionId: string, snapshot: SessionSnapshot, atMs: number): void {
    const presentation: AnalyticsPresentation = state.presentation ?? { home: {}, project: [] };
    const session = (presentation.session ?? []).filter(([id]) => id !== sessionId);
    session.push([sessionId, snapshot]);
    while (session.length > ANALYTICS_PRESENTATION_SESSION_LIMIT) session.shift();
    presentation.session = session;
    state.presentation = presentation;
    persistPresentation(atMs);
  }

  function touchSessionCache(sessionId: string, atMs: number): void {
    const presentation = state.presentation;
    const session = presentation?.session;
    if (!presentation || !session) return;
    const index = session.findIndex(([id]) => id === sessionId);
    if (index < 0) return;
    const [entry] = session.splice(index, 1);
    if (!entry) return;
    session.push(entry);
    while (session.length > ANALYTICS_PRESENTATION_SESSION_LIMIT) session.shift();
    persistPresentation(atMs);
  }

  /**
   * Drops cached session DTOs for a changed detail tree. The compact index
   * carries no detail markers, so a marker-only scoped refresh must notify the
   * host and rewrite the small sidecar even when usage data is unchanged.
   */
  function invalidateCachedSessions(sessionIds: ReadonlySet<string>): boolean {
    const presentation = state.presentation;
    const session = presentation?.session;
    if (!presentation || !session || session.length === 0) return false;
    const next = session.filter(([, snapshot]) => {
      if (sessionIds.has(snapshot.focusSessionId)) return false;
      return !snapshot.nodes.some((node) => sessionIds.has(node.sessionId));
    });
    if (next.length === session.length) return false;
    if (next.length > 0) presentation.session = next;
    else delete presentation.session;
    state.presentation = presentation;
    return true;
  }

  function hasUsefulPresentation(): boolean {
    const presentation = state.presentation;
    return (
      presentation !== undefined &&
      (Object.keys(presentation.home).length > 0 ||
        presentation.project.length > 0 ||
        (presentation.session?.length ?? 0) > 0)
    );
  }

  /**
   * Before the compact index is loaded, the sidecar identity is not installed
   * on the state (it must not certify indexed data). Preserve it only in the
   * serialized DTO sidecar so a restart can still validate the warm cache.
   */
  function presentationStateForWrite(): AnalyticsState {
    let view = state;
    if (view.sourceIdentity === undefined && warmSourceIdentity !== undefined) {
      view = { ...view, sourceIdentity: warmSourceIdentity };
    }
    if (compactDirty) {
      // The DTOs may be newer than the last successful compact checkpoint.
      // Omit coverage/freshness so restart cannot derive missing ranges from
      // that unchecked index; cached DTOs can still be served while catching up.
      view = { ...view };
      delete view.extent;
      view.frontierAtMs = 0;
    }
    return view;
  }

  async function drainWrites(): Promise<void> {
    for (;;) {
      const snapshotJob = snapshotWritePending;
      snapshotWritePending = undefined;
      const presentationJob = presentationWritePending;
      presentationWritePending = undefined;
      if (!snapshotJob && !presentationJob) return;
      if (snapshotJob) {
        const writtenRevision = snapshotJob.revision;
        const saved = await measureAsync("persistenceWrite", () =>
          saveSnapshot(snapshotPath, state, snapshotJob.atMs).catch(() => false),
        );
        if (saved && compactRevision === writtenRevision) {
          compactDirty = false;
        } else if (!saved) {
          compactDirty = true;
        }
      }
      if (
        presentationJob &&
        presentationJob.generation === generation &&
        (presentationJob.force || hasUsefulPresentation())
      ) {
        presentationSavedAtMs = presentationJob.savedAtMs;
        await measureAsync("persistenceWrite", () =>
          savePresentation(
            presentationPath,
            presentationStateForWrite(),
            presentationJob.savedAtMs,
          ).catch(() => false),
        );
      }
    }
  }

  function scheduleWriteDrain(): void {
    if (writeDrainScheduled) return;
    writeDrainScheduled = true;
    writeChain = writeChain.then(drainWrites, drainWrites).finally(() => {
      writeDrainScheduled = false;
      if (snapshotWritePending || presentationWritePending) scheduleWriteDrain();
    });
  }

  /** Wait for the serialized writer to become idle after a final queue. */
  async function drainAllWrites(): Promise<void> {
    for (;;) {
      const chain = writeChain;
      await chain.catch(() => undefined);
      if (!writeDrainScheduled && !snapshotWritePending && !presentationWritePending) return;
      if (!writeDrainScheduled) scheduleWriteDrain();
    }
  }

  function queueSnapshotWrite(atMs: number, force = false): void {
    if ((closed || closing) && !force) return;
    compactDirty = true;
    snapshotWritePending = { revision: compactRevision, atMs };
    scheduleWriteDrain();
  }

  function queuePresentationWrite(atMs: number, savedAtMs = atMs, force = false): void {
    if (closed || closing) return;
    if (!force && !hasUsefulPresentation()) return;
    if (!state.presentation) return;
    presentationWritePending = { generation, atMs, savedAtMs, force };
    scheduleWriteDrain();
  }

  /** Final flush bypasses the cache-write throttle during close. */
  function queueFinalPresentationWrite(atMs: number, savedAtMs: number): void {
    if (!hasUsefulPresentation()) return;
    lastPresentationSaveAtMs = atMs;
    presentationWritePending = { generation, atMs, savedAtMs, force: false };
    scheduleWriteDrain();
  }

  function persistPresentation(atMs: number): void {
    if (closed || closing || atMs - lastPresentationSaveAtMs < PRESENTATION_SAVE_INTERVAL_MS) {
      return;
    }
    lastPresentationSaveAtMs = atMs;
    // Before the compact index is loaded, keep the sidecar's original save
    // time. A warm LRU touch must not make an older sidecar look newer than a
    // newer persisted index.
    queuePresentationWrite(atMs, indexLoaded ? atMs : presentationSavedAtMs);
  }

  function homeSnapshotWithStaleness(
    snapshot: HomeSnapshot,
    range: RangeKey,
    atMs: number,
    stale: boolean,
  ): HomeSnapshot {
    return {
      ...snapshot,
      generatedAtMs: atMs,
      range,
      stale,
      providers: { ...snapshot.providers, polledAtMs: atMs },
      usage: { ...snapshot.usage, stale },
    };
  }

  function projectSnapshotWithStaleness(
    snapshot: ProjectSnapshot,
    stale: boolean,
  ): ProjectSnapshot {
    return {
      ...snapshot,
      stale,
      usage: { ...snapshot.usage, stale },
    };
  }

  function deriveProjectSnapshot(
    projectId: string,
    range: RangeKey,
    atMs: number,
  ): ProjectSnapshot {
    const stale = isStale(atMs);
    const snapshot = measureSync("dtoAggregation", () => model.project(projectId, range, atMs));
    return {
      ...snapshot,
      stale,
      usage: { ...snapshot.usage, stale },
    };
  }

  /**
   * Advance cached finite Home/Project DTOs to their actual certified sync
   * epoch. Home only moves on a successful global refresh; project entries may
   * also move on a matching scoped refresh. If the model cannot rebuild a
   * moved entry, expire it so the next request hydrates/rebuilds lazily.
   */
  function refreshFinitePresentationWindows(atMs: number, globalRefresh: boolean): boolean {
    const presentation = state.presentation;
    if (!presentation) return false;
    const canDerive = modelHydrated && !modelDirty;
    let changed = false;
    if (globalRefresh) {
      for (const key of Object.keys(presentation.home)) {
        if (!isRangeKey(key) || key === "lifetime") continue;
        const snapshot = presentation.home[key];
        const certified = homeCertifiedSyncAtMs(key, atMs);
        if (!snapshot || certified === undefined || snapshot.usage.window.untilMs >= certified) {
          continue;
        }
        if (canDerive) {
          presentation.home[key] = deriveHomeSnapshot(key, certified);
        } else {
          delete presentation.home[key];
        }
        changed = true;
      }
    }
    if (presentation.project.length > 0) {
      let projectChanged = false;
      const next: typeof presentation.project = [];
      for (const [projectId, range, snapshot] of presentation.project) {
        const certified = projectCertifiedSyncAtMs(projectId, range, atMs);
        if (range === "lifetime" || certified === undefined) {
          next.push([projectId, range, snapshot]);
          continue;
        }
        if (snapshot.usage.window.untilMs >= certified) {
          next.push([projectId, range, snapshot]);
          continue;
        }
        if (canDerive) {
          next.push([projectId, range, deriveProjectSnapshot(projectId, range, certified)]);
        }
        projectChanged = true;
      }
      if (projectChanged) {
        presentation.project = next;
        changed = true;
      }
    }
    if (changed) state.presentation = presentation;
    return changed;
  }

  function deriveHomeSnapshot(range: RangeKey, atMs: number): HomeSnapshot {
    const stale = isStale(atMs);
    const snapshot = measureSync("dtoAggregation", () => model.home(range, atMs));
    return {
      generatedAtMs: atMs,
      range,
      stale,
      providers: { cards: [], enabledProviders: [], polledAtMs: atMs },
      usage: { ...snapshot.usage, stale },
      projects: snapshot.projects,
    };
  }

  /**
   * Once 30d is indexed, derive the three bounded Home DTOs together while the
   * model is already hydrated. Missing entries are filled; this never triggers
   * a second model hydration.
   */
  function precomputeHomeSnapshots(atMs: number): void {
    if (!modelHydrated || modelDirty || !coverageTrusted) return;
    if (!coversSince(rangeWindow("30d", atMs).sinceMs, state.extent)) return;
    let changed = false;
    for (const range of HOME_PRECOMPUTE_RANGES) {
      const cachedHome = state.presentation?.home[range];
      if (cachedHome !== undefined && cachedHome.usage.timeZone === timeZone) continue;
      if (cachedHome !== undefined) delete state.presentation?.home[range];
      const certified = homeCertifiedSyncAtMs(range, atMs);
      if (certified === undefined) continue;
      setHomeCache(range, deriveHomeSnapshot(range, certified));
      changed = true;
    }
    if (changed) queuePresentationWrite(atMs);
  }

  /**
   * The UI's default finite view is 7d. After that response is ready, extend
   * once to 30d after a short idle grace. A foreground request that arrives
   * during the grace (or a refresh already in flight) wins: the extension
   * retries at most once, then leaves rescheduling to the next 7d response.
   * This is not preemption; a synchronous SQLite read that has already started
   * still runs to completion. Lifetime is never scheduled automatically.
   */
  function scheduleThirtyDayExtension(range: RangeKey, atMs: number): void {
    if (range !== "7d" || closed || closing || lowPriorityTimer !== undefined) return;
    if (coversSince(rangeWindow("30d", atMs).sinceMs, state.extent)) return;

    const hasPendingRefreshWork = (): boolean =>
      refreshPromise !== undefined ||
      pendingGlobal !== undefined ||
      pendingMetadataOnly ||
      pendingDetailSessions.size > 0 ||
      pendingProjectScopes.size > 0;

    let deferrals = 0;
    const arm = (): void => {
      const timer = setTimeout(() => {
        lowPriorityTimer = undefined;
        if (closed || closing) return;
        const scheduledAtMs = now();
        if (coversSince(rangeWindow("30d", scheduledAtMs).sinceMs, state.extent)) return;
        if (hasPendingRefreshWork()) {
          if (deferrals < LOW_PRIORITY_EXTENSION_MAX_DEFERRALS) {
            deferrals += 1;
            arm();
          }
          return;
        }
        void requestRefresh({
          globalRange: "30d",
          detailSessionIds: [],
          projectScopes: [],
        }).catch(() => {});
      }, ANALYTICS_THIRTY_DAY_EXTENSION_DELAY_MS) as LowPriorityTimer;
      timer.unref?.();
      lowPriorityTimer = timer;
    };

    arm();
  }

  function buildCandidate(
    snapshot: OpenCodeStorageSnapshot,
    job: RefreshJob,
    atMs: number,
  ): Candidate | "unavailable" {
    const identity = snapshot.identity;
    const comparison = compareOpenCodeSourceIdentity(state.sourceIdentity, identity);
    if (comparison === "unavailable") return "unavailable";
    // A truly pristine in-memory state is the first baseline, not a source
    // replacement; it has nothing to clear and needs no lifetime projection.
    const pristine =
      comparison === "changed" &&
      state.sourceIdentity === undefined &&
      state.occurrences.size === 0 &&
      Object.keys(state.sessions).length === 0 &&
      state.presentation === undefined;
    const replaced = comparison === "changed" && !pristine;

    const readHistoricalRows = (
      params: ReadCompletedAssistantRowsParams = {},
    ): OpenCodeRawAssistantRow[] =>
      measureSync("historicalPayloadRead", () => snapshot.readCompletedAssistantRows(params));
    const readChangedRows = (messageIDs: readonly string[]): OpenCodeRawAssistantRow[] =>
      measureSync("changedPayloadRead", () => snapshot.readCompletedAssistantRows({ messageIDs }));

    const sessions = measureSync("metadataRead", () => snapshot.readAllSessionsIndex());
    const projects = measureSync("metadataRead", () => snapshot.readProjectsIndex());
    // Stage metadata topology without touching committed indexes until commit.
    const candidateIndexes = createAnalyticsIndexes();
    candidateIndexes.setSessions(sessions);

    const globalRefresh = job.globalRange !== undefined;
    const effectiveExtent = replaced ? undefined : state.extent;
    const priorCursor = replaced ? undefined : state.sourceCursorAtMs;
    const priorRepairAtMs = replaced ? undefined : state.lastFullRepairAtMs;
    const repairDue =
      globalRefresh &&
      (job.repair === true ||
        priorRepairAtMs === undefined ||
        atMs - priorRepairAtMs >= fullRepairIntervalMs ||
        // A wall-clock rollback can move the inclusive window past unseen
        // source timestamps; reconcile fully rather than skip them.
        (priorCursor !== undefined && atMs < priorCursor));

    // Establish the source cursor either from a cheap physical frontier (no
    // stored contribution needs membership) or from one full revision
    // projection. Normal refreshes use only the cursor-overlap delta.
    let revisionSnapshot: OpenCodeMessageRevisionSnapshot | undefined;
    let fullProjection = false;
    let cursorBaseline = false;
    let deltaValid = false;
    let sourceCursorAtMs: number | null | undefined;

    if (globalRefresh) {
      const emptyBaseline = priorCursor === undefined && state.occurrences.size === 0 && !replaced;
      if (emptyBaseline) {
        const frontier = measureSync("revisionDiscovery", () =>
          snapshot.readMessageRevisionFrontier(),
        );
        sourceCursorAtMs =
          frontier.available && frontier.updatedAtAvailable
            ? Math.min(frontier.maxUpdatedAtMs ?? 0, atMs)
            : null;
        cursorBaseline = true;
      } else if (priorCursor !== undefined && !repairDue) {
        revisionSnapshot = measureSync("revisionDiscovery", () =>
          snapshot.readMessageRevisions({
            updatedSinceMs: Math.max(0, priorCursor - ANALYTICS_SOURCE_CURSOR_OVERLAP_MS),
          }),
        );
        if (!revisionSnapshot.available) return "unavailable";
        if (!revisionSnapshot.updatedAtAvailable) {
          // The storage filter is not applicable without a time_updated column,
          // so this result is already the full identity set.
          fullProjection = true;
        } else if (!revisionSnapshot.completedAtAvailable) {
          // The timestamp filter applied, but completion identity is missing;
          // reconcile the full identity set conservatively.
          revisionSnapshot = measureSync("revisionDiscovery", () =>
            snapshot.readMessageRevisions(),
          );
          if (!revisionSnapshot.available) return "unavailable";
          fullProjection = true;
        }
      } else {
        revisionSnapshot = measureSync("revisionDiscovery", () => snapshot.readMessageRevisions());
        if (!revisionSnapshot.available) return "unavailable";
        fullProjection = true;
      }

      if (revisionSnapshot) {
        fullProjection =
          fullProjection ||
          !revisionSnapshot.updatedAtAvailable ||
          !revisionSnapshot.completedAtAvailable;
        const revisions = revisionSnapshot.revisions;
        if (!fullProjection) {
          // Deterministic time-then-id order keeps equal timestamps and
          // lexically earlier late commits replayable and idempotent.
          revisions.sort(
            (a, b) =>
              (a.updatedAtMs ?? Number.NEGATIVE_INFINITY) -
                (b.updatedAtMs ?? Number.NEGATIVE_INFINITY) || compareIds(a.messageID, b.messageID),
          );
        }
        let maxUpdated = priorCursor;
        for (const revision of revisions) {
          if (
            revision.updatedAtMs !== null &&
            (maxUpdated === undefined || revision.updatedAtMs > maxUpdated)
          ) {
            maxUpdated = revision.updatedAtMs;
          }
        }
        sourceCursorAtMs =
          revisionSnapshot.updatedAtAvailable && revisionSnapshot.completedAtAvailable
            ? Math.min(maxUpdated ?? 0, atMs)
            : null;
      }
      deltaValid = !fullProjection && revisionSnapshot !== undefined && !repairDue;
    }

    const bulkRows: OpenCodeRawAssistantRow[] = [];
    const bulkMap = new Map<string, OpenCodeRawAssistantRow>();
    const changedMap = new Map<string, StagedUpsert>();
    const changedIds = new Map<string, { updatedAtMs: number | null }>();
    const removalKeys = new Set<string>();
    const authoritativePayloadIDs = new Set<string>();
    const watermarks =
      revisionSnapshot !== undefined && !fullProjection && revisionSnapshot.updatedAtAvailable
        ? new Map<string, number | null>(
            revisionSnapshot.revisions.map((revision) => [
              revision.messageID,
              revision.updatedAtMs,
            ]),
          )
        : undefined;

    const stageChanged = (row: OpenCodeRawAssistantRow, updatedAtMs: number | null): void => {
      const key = row.messageID;
      authoritativePayloadIDs.add(key);
      const entry: StagedUpsert = {
        row,
        updatedAtMs,
        // The source payload reader projects the agent field; an absent agent
        // is authoritative there and must not be confused with a cached
        // synthetic occurrence that simply has no transient agent loaded.
        agentProjected: true,
      };
      if (row.agent !== undefined) entry.agent = row.agent;
      changedMap.set(key, entry);
      removalKeys.delete(key);
    };

    const stageBulk = (row: OpenCodeRawAssistantRow, updatedAtMs?: number | null): void => {
      const key = row.messageID;
      authoritativePayloadIDs.add(key);
      const existing = bulkMap.get(key);
      if (existing) {
        if (updatedAtMs !== undefined) setWatermark(existing, updatedAtMs);
        return;
      }
      setWatermark(
        row,
        updatedAtMs !== undefined
          ? updatedAtMs
          : row.updatedAtMs !== undefined
            ? row.updatedAtMs
            : (watermarks?.get(key) ?? null),
      );
      bulkMap.set(key, row);
      bulkRows.push(row);
    };

    // Removed session metadata is authoritative for its stored occurrences.
    // The session index narrows the walk to messages of sessions that actually
    // disappeared; the committed occurrence index is never rebuilt here.
    if (!replaced) {
      const removedSessionIds = new Set<string>();
      for (const id of Object.keys(state.sessions)) {
        if (!Object.hasOwn(sessions, id)) removedSessionIds.add(id);
      }
      if (removedSessionIds.size > 0) {
        for (const messageID of indexes.sessionMessages(removedSessionIds)) {
          removalKeys.add(messageID);
        }
      }
    }

    const fullRepairRead = fullProjection && !replaced && effectiveExtent !== undefined;
    // Even a scope-only snapshot has no global extent but can carry cached
    // occurrences. A full projection/baseline must still refresh those cached
    // payloads by id, not only the newly requested extent.
    const fullCachedRepairRead = fullProjection && !replaced;
    const window = job.globalRange ? rangeWindow(job.globalRange, atMs) : undefined;
    let nextExtent = effectiveExtent;
    let extentChanged = false;
    if (window) {
      const prior = effectiveExtent;
      if (!prior) {
        for (const row of readHistoricalRows({
          ...(window.sinceMs === undefined ? {} : { completedSinceMs: window.sinceMs }),
          completedUntilMs: atMs,
        })) {
          stageBulk(row);
        }
      } else if (!fullRepairRead) {
        // Extend only the actually missing older side of the extent.
        if (window.sinceMs === undefined) {
          if (prior.sinceMs !== undefined) {
            for (const row of readHistoricalRows({ completedUntilMs: prior.sinceMs })) {
              stageBulk(row);
            }
          }
        } else if (prior.sinceMs !== undefined && window.sinceMs < prior.sinceMs) {
          // Bounded requests inside an already-lifetime extent are covered;
          // only a genuinely older requested start needs an extra read.
          for (const row of readHistoricalRows({
            completedSinceMs: window.sinceMs,
            completedUntilMs: prior.sinceMs,
          })) {
            stageBulk(row);
          }
        }
        // The completion frontier is already supplied by a valid revision
        // delta, and a full repair below re-reads the whole extent; do not
        // re-read the same leaving payload every refresh.
        if (prior.untilMs < atMs && !deltaValid) {
          for (const row of readHistoricalRows({
            completedSinceMs: prior.untilMs,
            completedUntilMs: atMs,
          })) {
            stageBulk(row);
          }
        }
      }
      nextExtent = mergeExtent(effectiveExtent, window.sinceMs, atMs);
      extentChanged = true;
    }

    // A full reconciliation re-reads the indexed extent (and, below, cached
    // scopes) so payload edits that did not move the source timestamp repair.
    if (fullRepairRead && nextExtent) {
      for (const row of readHistoricalRows({
        ...(nextExtent.sinceMs === undefined ? {} : { completedSinceMs: nextExtent.sinceMs }),
        completedUntilMs: nextExtent.untilMs,
      })) {
        stageBulk(row);
      }
    }

    const completedMembership = revisionSnapshot?.completedAtAvailable === true;
    if (fullProjection && !completedMembership && !replaced && nextExtent) {
      // No completion identity: the extent payload read above is authoritative
      // for completion/type membership inside the indexed extent.
      for (const [key, occurrence] of state.occurrences) {
        const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
        if (!fingerprint) continue;
        if (fingerprint[1] > atMs) continue;
        if (nextExtent.sinceMs !== undefined && fingerprint[1] < nextExtent.sinceMs) continue;
        removalKeys.add(key);
      }
    }

    interface ScopeRead {
      ids: Set<string>;
      fingerprints: Set<string>;
      times: Set<number>;
    }
    const detailSignatureChanges: Array<[string, string]> = [];
    const detailCompactionChanges: Array<
      [string, Array<{ sessionId: string; atMs: number; messageId: string }>]
    > = [];
    const detailCoverageChanges: Array<[string, DetailScopeCoverage]> = [];
    const projectSignatureChanges: Array<[string, string]> = [];
    const projectCoverageChanges: Array<[string, ProjectScopeCoverage]> = [];
    const reusedScopes: Array<{
      sessionIds: Set<string>;
      sinceMs?: number;
      untilMs: number;
      read: ScopeRead;
      dirty: boolean;
    }> = [];
    const reconciledOwnerMessageIDs = new Set<string>();

    /**
     * Safe owner-read elision: a valid global delta reconciled in this same
     * transaction already staged every external row that could share a scoped
     * fingerprint, but only when the loaded completion extent covers every
     * scoped time. Wall-clock/global freshness alone proves nothing about
     * external source changes and never takes this path.
     */
    const ownershipReconciledInSnapshot = globalRefresh && deltaValid && nextExtent !== undefined;
    const timesCoveredByExtent = (times: ReadonlySet<number>): boolean => {
      if (!ownershipReconciledInSnapshot || !nextExtent) return false;
      for (const time of times) {
        if (time > nextExtent.untilMs) return false;
        if (nextExtent.sinceMs !== undefined && time < nextExtent.sinceMs) return false;
      }
      return true;
    };

    /**
     * Cross-scope fork owners must stay in the contribution set for exact
     * ownership. Query only the exact completion timestamps of the scope
     * instead of projecting every row in the min/max span.
     */
    /**
     * Scoped-only reads have no global revision scan, so a known external fork
     * owner can be stale. Resolve its current identity through the fingerprint
     * reverse index and the scoped message-ID revision projection; update or
     * remove it before ownership is evaluated. A same-snapshot global delta
     * already reconciled every stored occurrence, so this is skipped then.
     */
    const reconcileKnownExternalOwners = (read: ScopeRead): void => {
      if (ownershipReconciledInSnapshot || read.fingerprints.size === 0) return;
      const candidates = new Set<string>();
      for (const fingerprint of read.fingerprints) {
        const fingerprintIndex = state.fingerprintIndex.get(fingerprint);
        if (fingerprintIndex === undefined) continue;
        for (const messageID of indexes.fingerprintMessages([fingerprintIndex])) {
          if (reconciledOwnerMessageIDs.has(messageID)) continue;
          if (bulkMap.has(messageID) || changedMap.has(messageID)) continue;
          const occurrence = state.occurrences.get(messageID);
          if (!occurrence || read.ids.has(occurrence.sessionID)) continue;
          candidates.add(messageID);
        }
      }
      if (candidates.size === 0) return;

      const revisions = measureSync("revisionDiscovery", () =>
        snapshot.readMessageRevisions({ messageIDs: [...candidates] }),
      );
      if (!revisions.available) return;
      const byId = new Map(revisions.revisions.map((revision) => [revision.messageID, revision]));
      const changedForOwner = new Map<string, number | null>();
      for (const messageID of candidates) {
        reconciledOwnerMessageIDs.add(messageID);
        const occurrence = state.occurrences.get(messageID);
        if (!occurrence) continue;
        const revision = byId.get(messageID);
        if (!revision) {
          removalKeys.add(messageID);
          continue;
        }
        if (revisions.completedAtAvailable) {
          if (revisionCompletedAt(revision) === 0) {
            removalKeys.add(messageID);
            continue;
          }
        }
        const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
        const identityChanged =
          !revisions.updatedAtAvailable ||
          !revisions.completedAtAvailable ||
          revision.updatedAtMs === null ||
          !fingerprint ||
          revision.sessionID !== occurrence.sessionID ||
          revision.completedAtMs !== fingerprint[1] ||
          revision.updatedAtMs !== occurrence.updatedAtMs;
        if (identityChanged) changedForOwner.set(messageID, revision.updatedAtMs);
      }

      if (changedForOwner.size === 0) return;
      const resolved = new Set<string>();
      const rows = readChangedRows([...changedForOwner.keys()]);
      for (const row of rows) {
        if (!changedForOwner.has(row.messageID)) continue;
        const updatedAtMs = changedForOwner.get(row.messageID) ?? null;
        resolved.add(row.messageID);
        stageChanged(row, updatedAtMs);
      }
      for (const messageID of changedForOwner.keys()) {
        if (!resolved.has(messageID) && state.occurrences.has(messageID)) {
          removalKeys.add(messageID);
        }
      }
    };

    const discoverExternalOwners = (read: ScopeRead): void => {
      if (read.times.size === 0) return;
      reconcileKnownExternalOwners(read);
      if (timesCoveredByExtent(read.times)) return;
      const candidates = readHistoricalRows({ completedAtTimes: [...read.times] });
      for (const row of candidates) {
        if (read.ids.has(row.sessionID)) continue;
        if (!read.times.has(row.completedAtMs)) continue;
        if (!read.fingerprints.has(fingerprintOf(row))) continue;
        if (bulkMap.has(row.messageID) || changedMap.has(row.messageID)) continue;
        const occurrence = state.occurrences.get(row.messageID);
        if (occurrence) {
          const stored = state.fingerprints[occurrence.fingerprintIndex];
          if (
            stored &&
            occurrence.sessionID === row.sessionID &&
            occurrence.updatedAtMs === (row.updatedAtMs ?? null) &&
            fingerprintOf(rowFromFingerprint(stored, occurrence)) === fingerprintOf(row)
          ) {
            continue;
          }
        }
        stageChanged(row, row.updatedAtMs ?? null);
      }
    };

    const markReusedScopesDirty = (sessionID: string, completedAtMs: number): void => {
      for (const scope of reusedScopes) {
        if (!scope.sessionIds.has(sessionID)) {
          // A new/changed external copy at a cached scope time can change the
          // deterministic owner even though it belongs to another session.
          if (completedAtMs > 0 && scope.read.times.has(completedAtMs)) scope.dirty = true;
          continue;
        }
        if (completedAtMs === 0) {
          scope.dirty = true;
          continue;
        }
        if (completedAtMs > scope.untilMs) continue;
        if (scope.sinceMs !== undefined && completedAtMs < scope.sinceMs) continue;
        scope.dirty = true;
      }
    };

    const revisionEligibleInReusedScope = (sessionID: string, completedAtMs: number): boolean => {
      for (const scope of reusedScopes) {
        if (!scope.sessionIds.has(sessionID)) continue;
        if (completedAtMs > scope.untilMs) continue;
        if (scope.sinceMs !== undefined && completedAtMs < scope.sinceMs) continue;
        return true;
      }
      return false;
    };

    for (const scope of job.projectScopes) {
      const scopeWindow = rangeWindow(scope.range, atMs);
      const ids = candidateIndexes.projectSessions(scope.projectId);
      if (ids.length === 0) continue;
      const signature = projectSignature(scope.projectId, scope.range, ids);
      const scopeSessions = new Set(ids);
      const priorCoverage = projectCoverage.get(scope.projectId);
      const coveredByGlobalExtent =
        globalRefresh && deltaValid && coversSince(scopeWindow.sinceMs, nextExtent);
      const reusableCoverage =
        globalRefresh && deltaValid && priorCoverage?.signature === signature;

      if (coveredByGlobalExtent) {
        // The valid global delta already reconciles this whole window; the
        // project DTO derives from the shared model, so no scoped payload.
      } else if (reusableCoverage) {
        // Cached coverage: the valid global delta already updates existing
        // occurrences and stages new eligible ids. No historical payload read.
        const read: ScopeRead = { ids: scopeSessions, fingerprints: new Set(), times: new Set() };
        for (const messageID of indexes.sessionMessages(scopeSessions)) {
          if (removalKeys.has(messageID)) continue;
          const occurrence = state.occurrences.get(messageID);
          if (!occurrence) continue;
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          if (!fingerprint) continue;
          if (fingerprint[1] > atMs) continue;
          if (scopeWindow.sinceMs !== undefined && fingerprint[1] < scopeWindow.sinceMs) continue;
          read.fingerprints.add(fingerprintOf(rowFromFingerprint(fingerprint, occurrence)));
          read.times.add(fingerprint[1]);
        }
        reusedScopes.push({
          sessionIds: scopeSessions,
          sinceMs: scopeWindow.sinceMs,
          untilMs: atMs,
          read,
          dirty: false,
        });
      } else {
        for (const messageID of indexes.sessionMessages(scopeSessions)) {
          const occurrence = state.occurrences.get(messageID);
          if (!occurrence) continue;
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          if (
            fingerprint &&
            fingerprint[1] <= atMs &&
            (scopeWindow.sinceMs === undefined || fingerprint[1] >= scopeWindow.sinceMs)
          ) {
            removalKeys.add(messageID);
          }
        }
        const rows = readHistoricalRows({
          sessionIDs: ids,
          ...(scopeWindow.sinceMs === undefined ? {} : { completedSinceMs: scopeWindow.sinceMs }),
          completedUntilMs: atMs,
        });
        const read: ScopeRead = { ids: scopeSessions, fingerprints: new Set(), times: new Set() };
        for (const row of rows) {
          read.fingerprints.add(fingerprintOf(row));
          read.times.add(row.completedAtMs);
          stageBulk(row);
        }
        discoverExternalOwners(read);
      }
      projectCoverageChanges.push([
        scope.projectId,
        {
          signature,
          sessionIds: ids,
          ...(scopeWindow.sinceMs === undefined ? {} : { sinceMs: scopeWindow.sinceMs }),
          untilMs: atMs,
        },
      ]);
      projectSignatureChanges.push([scope.projectId, signature]);
    }

    for (const focusId of job.detailSessionIds) {
      const focus = sessions[focusId];
      if (!focus) {
        detailSignatureChanges.push([focusId, ""]);
        continue;
      }
      const ids = candidateIndexes.treeIds(focusId);
      const idSet = new Set(ids);
      const scopedRevisions = measureSync("revisionDiscovery", () =>
        snapshot.readMessageRevisions({ sessionIDs: ids }),
      );
      const scopedWatermarks = new Map<string, number | null>();
      if (scopedRevisions.available) {
        for (const revision of scopedRevisions.revisions) {
          scopedWatermarks.set(revision.messageID, revision.updatedAtMs);
        }
      }
      const signature = sessionRevisionSignature(sessions, ids);
      const read: ScopeRead = { ids: idSet, fingerprints: new Set(), times: new Set() };
      const warmPayloads =
        !replaced &&
        !repairDue &&
        detailCoverage.has(focusId) &&
        detailCompactions.has(focusId) &&
        scopedRevisions.available &&
        scopedRevisions.updatedAtAvailable &&
        scopedRevisions.completedAtAvailable;

      if (warmPayloads) {
        // Warm detail: the full tree payload (including transient agents) was
        // already loaded. Reconcile identities through the revision diff and
        // fetch payloads only for changed/new ids.
        const previousMessageIDs = new Set(indexes.sessionMessages(ids));
        const seenMessageIDs = new Set<string>();
        const changedForDetail = new Map<string, number | null>();
        let detailDirty = false;
        for (const revision of scopedRevisions.revisions) {
          seenMessageIDs.add(revision.messageID);
          const occurrence = state.occurrences.get(revision.messageID);
          const completed = revisionCompletedAt(revision);
          if (completed === 0) {
            if (occurrence) {
              removalKeys.add(revision.messageID);
              detailDirty = true;
            }
            continue;
          }
          if (!occurrence) {
            changedForDetail.set(revision.messageID, revision.updatedAtMs);
            detailDirty = true;
            continue;
          }
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          if (
            revision.updatedAtMs === null ||
            !fingerprint ||
            occurrence.sessionID !== revision.sessionID ||
            completed !== fingerprint[1] ||
            revision.updatedAtMs !== occurrence.updatedAtMs
          ) {
            changedForDetail.set(revision.messageID, revision.updatedAtMs);
            detailDirty = true;
            continue;
          }
          const row = rowOf(occurrence);
          if (row) {
            read.fingerprints.add(fingerprintOf(row));
            read.times.add(row.completedAtMs);
          }
        }
        for (const messageID of previousMessageIDs) {
          if (!seenMessageIDs.has(messageID)) {
            removalKeys.add(messageID);
            detailDirty = true;
          }
        }
        if (changedForDetail.size > 0) {
          const resolved = new Set<string>();
          const rows = readChangedRows([...changedForDetail.keys()]);
          for (const row of rows) {
            if (!changedForDetail.has(row.messageID)) continue;
            const entry = changedForDetail.get(row.messageID) ?? null;
            resolved.add(row.messageID);
            stageChanged(row, entry);
            read.fingerprints.add(fingerprintOf(row));
            read.times.add(row.completedAtMs);
          }
          for (const messageID of changedForDetail.keys()) {
            if (!resolved.has(messageID) && state.occurrences.has(messageID)) {
              removalKeys.add(messageID);
              detailDirty = true;
            }
          }
        }
        if (globalRefresh && deltaValid) {
          // The same-snapshot global delta can certify exact owner discovery;
          // defer it until changed payloads are known so no-change warm detail
          // performs no historical payload read.
          reusedScopes.push({
            sessionIds: idSet,
            untilMs: atMs,
            read,
            dirty: detailDirty,
          });
        } else {
          discoverExternalOwners(read);
        }
        const markers = measureSync("historicalPayloadRead", () =>
          snapshot.readCompactionMarkers({ sessionIDs: ids }),
        );
        detailCompactionChanges.push([focusId, markers]);
        detailCoverageChanges.push([focusId, { signature: ids.join("\u0001"), untilMs: atMs }]);
      } else {
        // First detail load (or a schema without revision times) needs the full
        // tree payload because agents and compaction markers are not in the
        // revision projection.
        for (const messageID of indexes.sessionMessages(idSet)) removalKeys.add(messageID);
        const rows = readHistoricalRows({ sessionIDs: ids });
        for (const row of rows) {
          read.fingerprints.add(fingerprintOf(row));
          read.times.add(row.completedAtMs);
          stageBulk(row, scopedWatermarks.get(row.messageID) ?? null);
        }
        discoverExternalOwners(read);
        const markers = measureSync("historicalPayloadRead", () =>
          snapshot.readCompactionMarkers({ sessionIDs: ids }),
        );
        detailCompactionChanges.push([focusId, markers]);
        detailCoverageChanges.push([focusId, { signature: ids.join("\u0001"), untilMs: atMs }]);
      }
      detailSignatureChanges.push([focusId, signature]);
    }

    // A full repair must revisit every cached payload outside this refresh's
    // authoritative extent/scope reads. Otherwise an unchanged timestamp or
    // completion token hides a payload edit in an older/evicted scope or a
    // restart-restored occurrence.
    if (fullCachedRepairRead) {
      const unreadIDs: string[] = [];
      for (const key of state.occurrences.keys()) {
        if (!authoritativePayloadIDs.has(key) && !removalKeys.has(key)) unreadIDs.push(key);
      }
      if (unreadIDs.length > 0) {
        const resolved = new Set<string>();
        const rows = readChangedRows(unreadIDs);
        for (const row of rows) {
          resolved.add(row.messageID);
          stageChanged(row, row.updatedAtMs ?? null);
        }
        for (const key of unreadIDs) {
          if (!resolved.has(key)) removalKeys.add(key);
        }
      }
    }

    // Apply the projected revision delta after every payload/membership read.
    // Only a full projection may sweep stored rows as deleted.
    const seenKeys =
      fullProjection && revisionSnapshot?.completedAtAvailable ? new Set<string>() : undefined;
    const extentSince = nextExtent?.sinceMs;
    const extentUntil = nextExtent?.untilMs ?? atMs;
    if (revisionSnapshot?.completedAtAvailable) {
      for (const revision of revisionSnapshot.revisions) {
        const key = revision.messageID;
        const completed = revisionCompletedAt(revision);
        const bulkRow = bulkMap.get(key);
        if (bulkRow) setWatermark(bulkRow, revision.updatedAtMs);
        const occurrence = replaced ? undefined : state.occurrences.get(key);
        if (occurrence) {
          seenKeys?.add(key);
          if (completed === 0) {
            // Completion/type reversal is authoritative for this id only.
            removalKeys.add(key);
            markReusedScopesDirty(revision.sessionID, 0);
            continue;
          }
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          // A null/non-numeric source timestamp cannot prove the payload is
          // unchanged, so re-read it conservatively on every delta.
          const unknownTimestamp =
            revisionSnapshot.updatedAtAvailable && revision.updatedAtMs === null;
          const changed =
            unknownTimestamp ||
            !fingerprint ||
            occurrence.sessionID !== revision.sessionID ||
            completed !== fingerprint[1] ||
            (revisionSnapshot.updatedAtAvailable &&
              revision.updatedAtMs !== occurrence.updatedAtMs);
          if (changed) {
            markReusedScopesDirty(revision.sessionID, completed);
            if (!bulkRow) changedIds.set(key, { updatedAtMs: revision.updatedAtMs });
          }
        } else if (!replaced && !bulkRow && completed > 0 && window) {
          markReusedScopesDirty(revision.sessionID, completed);
          const inGlobalExtent =
            completed <= extentUntil && (extentSince === undefined || completed >= extentSince);
          if (inGlobalExtent || revisionEligibleInReusedScope(revision.sessionID, completed)) {
            changedIds.set(key, { updatedAtMs: revision.updatedAtMs });
          }
        }
      }
      if (seenKeys && !replaced) {
        for (const key of state.occurrences.keys()) {
          if (!seenKeys.has(key)) removalKeys.add(key);
        }
      }
    }

    if (changedIds.size > 0) {
      const resolved = new Set<string>();
      const rows = readChangedRows([...changedIds.keys()]);
      for (const row of rows) {
        const entry = changedIds.get(row.messageID);
        if (!entry) continue;
        resolved.add(row.messageID);
        stageChanged(row, entry.updatedAtMs);
      }
      for (const key of changedIds.keys()) {
        if (!resolved.has(key) && state.occurrences.has(key)) removalKeys.add(key);
      }
    }

    // Cached project scopes skipped their payload read. If the delta touched
    // them, recover exact cross-scope fork owners from stored/changed rows
    // without rereading the project's historical payload.
    for (const scope of reusedScopes) {
      if (!scope.dirty) continue;
      const read: ScopeRead = { ids: scope.sessionIds, fingerprints: new Set(), times: new Set() };
      const seen = new Set<string>();
      const addRow = (row: OpenCodeRawAssistantRow): void => {
        if (!scope.sessionIds.has(row.sessionID)) return;
        if (row.completedAtMs > scope.untilMs) return;
        if (scope.sinceMs !== undefined && row.completedAtMs < scope.sinceMs) return;
        read.fingerprints.add(fingerprintOf(row));
        read.times.add(row.completedAtMs);
      };
      for (const messageID of indexes.sessionMessages(scope.sessionIds)) {
        seen.add(messageID);
        if (removalKeys.has(messageID)) continue;
        const changed = changedMap.get(messageID);
        if (changed) {
          addRow(changed.row);
          continue;
        }
        const occurrence = state.occurrences.get(messageID);
        if (!occurrence) continue;
        const row = rowOf(occurrence);
        if (row) addRow(row);
      }
      for (const [messageID, entry] of changedMap) {
        if (seen.has(messageID)) continue;
        addRow(entry.row);
      }
      discoverExternalOwners(read);
    }

    return {
      identity,
      sessions,
      projects,
      replaced,
      bulkRows,
      changedMap,
      removalKeys,
      nextExtent,
      extentChanged,
      detailSignatures: detailSignatureChanges,
      detailCompactions: detailCompactionChanges,
      detailCoverageChanges,
      projectSignatures: projectSignatureChanges,
      projectCoverages: projectCoverageChanges,
      ...(globalRefresh ? { sourceCursorAtMs } : {}),
      ...(globalRefresh && (cursorBaseline || fullProjection) ? { repairCompletedAtMs: atMs } : {}),
    };
  }
  /** Drops fingerprint tuples no occurrence references (small periodic GC). */
  function pruneFingerprints(): void {
    const used = new Set<number>();
    for (const occurrence of state.occurrences.values()) {
      used.add(occurrence.fingerprintIndex);
    }
    if (used.size === state.fingerprints.length) return;
    const remap = new Map<number, number>();
    const next: AnalyticsState["fingerprints"] = [];
    const nextIndex = new Map<string, number>();
    for (let oldIndex = 0; oldIndex < state.fingerprints.length; oldIndex += 1) {
      if (!used.has(oldIndex)) continue;
      const tuple = state.fingerprints[oldIndex];
      if (!tuple) continue;
      const fingerprint = fingerprintOf(
        rowFromFingerprint(tuple, { sessionID: "", messageID: "" }),
      );
      const newIndex = next.length;
      remap.set(oldIndex, newIndex);
      next.push(tuple);
      nextIndex.set(fingerprint, newIndex);
    }
    for (const occurrence of state.occurrences.values()) {
      const mapped = remap.get(occurrence.fingerprintIndex);
      if (mapped !== undefined) occurrence.fingerprintIndex = mapped;
    }
    state.fingerprints = next;
    state.fingerprintIndex = nextIndex;
    // Fingerprint buckets are positional: rebuild them once after the remap.
    indexes.rebuild(state.occurrences.values(), state.sessions);
  }

  async function refreshBatch(job: RefreshJob): Promise<void> {
    await ensureIndexLoaded();
    const atMs = now();
    const priorSourceCursorAtMs = state.sourceCursorAtMs;
    const priorLastFullRepairAtMs = state.lastFullRepairAtMs;
    const priorExtentSinceMs = state.extent?.sinceMs;
    const priorSourceIdentity = state.sourceIdentity;
    if (job.globalRange !== undefined) lastGlobalAttemptAtMs = atMs;
    else lastScopedAttemptAtMs = atMs;

    // The rare full reconciliation is explicit and clock-driven. It also
    // repairs the scopes this worker has cached, so unchanged/backdated edits
    // in scoped data are caught by the same persisted cadence.
    let effectiveJob = job;
    const repairDue =
      job.globalRange !== undefined &&
      (state.lastFullRepairAtMs === undefined ||
        atMs - state.lastFullRepairAtMs >= fullRepairIntervalMs ||
        (state.sourceCursorAtMs !== undefined && atMs < state.sourceCursorAtMs) ||
        job.repair === true);
    if (repairDue) {
      const projectScopes = new Map<string, RangeKey>();
      for (const scope of job.projectScopes) {
        projectScopes.set(
          scope.projectId,
          widerRange(projectScopes.get(scope.projectId), scope.range),
        );
      }
      for (const [projectId, range] of lastProjectScopes) {
        projectScopes.set(projectId, widerRange(projectScopes.get(projectId), range));
      }
      // Persisted project DTO entries are a scoped cache too; repair them when
      // they survived a restart even though the in-memory scope list is empty.
      for (const [projectId, range] of state.presentation?.project ?? []) {
        projectScopes.set(projectId, widerRange(projectScopes.get(projectId), range));
      }
      effectiveJob = {
        ...job,
        repair: true,
        projectScopes: [...projectScopes.entries()].map(([projectId, range]) => ({
          projectId,
          range,
        })),
        detailSessionIds: [...new Set([...job.detailSessionIds, ...lastDetailSessionIds])],
      };
    }

    let result: OpenCodeStorageSnapshotResult<Candidate | "unavailable">;
    try {
      result = await reader.withSnapshot((snapshot) =>
        buildCandidate(snapshot, effectiveJob, atMs),
      );
    } catch {
      unavailable = true;
      return;
    }
    if (result.status !== "ok") {
      unavailable = true;
      return;
    }
    if (result.value === "unavailable") {
      unavailable = true;
      return;
    }
    const candidate = result.value;
    samplePeak();

    const sessionsChanged = metadataChanged(state.sessions, candidate.sessions);
    const projectsChanged = metadataChanged(state.projects, candidate.projects);
    const nextSessionIndexSignature = sessionIndexSignature(candidate.sessions);
    const sessionIndexChanged =
      candidate.replaced || nextSessionIndexSignature !== lastSessionIndexSignature;

    // Apply synchronously after the transaction has returned.
    if (candidate.replaced) {
      state.occurrences.clear();
      state.fingerprints = [];
      state.fingerprintIndex.clear();
      state.extent = undefined;
      state.presentation = undefined;
      state.sourceCursorAtMs = undefined;
      state.lastFullRepairAtMs = undefined;
      warmPresentation = undefined;
      warmSourceIdentity = undefined;
      warmIdentityVerification = undefined;
      warmIdentityVerifiedGeneration = -1;
      projectSignatures.clear();
      detailSignatures.clear();
      detailCompactions.clear();
      detailCoverage.clear();
      projectCoverage.clear();
      projectFreshAt.clear();
      detailFreshAt.clear();
      indexes.rebuild([], {});
      lastSessionIndexSignature = "";
      measureSync("modelUpdate", () => model.clear());
      modelHydrated = false;
      modelDirty = true;
    }

    const removals: OpenCodeRawAssistantRow[] = [];
    const upserts: OpenCodeRawAssistantRow[] = [];
    const agentUpserts: OpenCodeRawAssistantRow[] = [];
    const agentAffectedSessionIds = new Set<string>();
    let updatedAtChanged = false;
    let occurrenceRemoved = false;

    // The final staged row is the only authoritative payload for a message id:
    // changedMap wins over a bulk projection, and a retained row cancels any
    // provisional scope removal. Classify it against the still-committed
    // occurrence before applying removals so unchanged rows stay no-ops.
    const changedKeys = new Set(candidate.changedMap.keys());
    const finalKeys = new Set(changedKeys);
    for (const row of candidate.bulkRows) finalKeys.add(row.messageID);

    const applyStagedRow = (
      row: OpenCodeRawAssistantRow,
      updatedAtMs: number | null,
      agentProjected: boolean,
    ): void => {
      const key = row.messageID;
      const occurrence = state.occurrences.get(key);
      if (!occurrence) {
        setRow(row, updatedAtMs, row.agent);
        upserts.push(row);
        return;
      }
      const oldRow = rowOf(occurrence);
      const sameContribution =
        oldRow !== undefined &&
        occurrence.sessionID === row.sessionID &&
        fingerprintOf(oldRow) === fingerprintOf(row);
      if (!sameContribution) {
        if (oldRow) removals.push(oldRow);
        setRow(row, updatedAtMs, row.agent);
        upserts.push(row);
        return;
      }
      if (updatedAtMs !== occurrence.updatedAtMs) {
        occurrence.updatedAtMs = updatedAtMs;
        updatedAtChanged = true;
      }
      if (agentProjected && row.agent !== occurrence.agent) {
        if (row.agent === undefined) delete occurrence.agent;
        else occurrence.agent = row.agent;
        agentUpserts.push(row);
        agentAffectedSessionIds.add(row.sessionID);
      }
    };

    for (const entry of candidate.changedMap.values()) {
      applyStagedRow(entry.row, entry.updatedAtMs, entry.agentProjected ?? true);
    }
    for (const row of candidate.bulkRows) {
      if (changedKeys.has(row.messageID)) continue;
      // Both bulk and changed payloads come from the source reader, which
      // projects agent; cached synthetic rows never enter this final set.
      applyStagedRow(row, (row as WatermarkedRow)[WATERMARK] ?? null, true);
    }

    for (const key of candidate.removalKeys) {
      if (finalKeys.has(key)) continue;
      const occurrence = state.occurrences.get(key);
      if (!occurrence) continue;
      const row = rowOf(occurrence);
      if (row) removals.push(row);
      state.occurrences.delete(key);
      indexes.remove(key);
      occurrenceRemoved = true;
    }

    state.sessions = candidate.sessions;
    state.projects = candidate.projects;
    if (sessionIndexChanged) {
      indexes.setSessions(candidate.sessions);
      lastSessionIndexSignature = nextSessionIndexSignature;
    }
    state.sourceIdentity = candidate.identity;
    if (candidate.extentChanged) state.extent = candidate.nextExtent;
    // A scoped-only refresh never certifies global freshness or advances the
    // source cursor; only a successful global candidate may do either.
    if (effectiveJob.globalRange !== undefined) {
      state.frontierAtMs = atMs;
      coverageTrusted = true;
      sidecarNewerThanIndex = false;
    }
    if (candidate.sourceCursorAtMs !== undefined) {
      if (candidate.sourceCursorAtMs === null) state.sourceCursorAtMs = undefined;
      else state.sourceCursorAtMs = candidate.sourceCursorAtMs;
    }
    if (candidate.repairCompletedAtMs !== undefined) {
      state.lastFullRepairAtMs = candidate.repairCompletedAtMs;
    }
    unavailable = false;

    for (const [focusId, signature] of candidate.detailSignatures) {
      if (signature === "") {
        detailSignatures.delete(focusId);
        detailCompactions.delete(focusId);
        detailCoverage.delete(focusId);
        detailFreshAt.delete(focusId);
      } else {
        detailSignatures.set(focusId, signature);
        detailFreshAt.set(focusId, atMs);
      }
    }
    for (const [focusId, coverage] of candidate.detailCoverageChanges) {
      detailCoverage.set(focusId, coverage);
    }
    const markerChangedFocusIds = new Set<string>();
    for (const [focusId, markers] of candidate.detailCompactions) {
      if (metadataChanged(detailCompactions.get(focusId) ?? [], markers)) {
        markerChangedFocusIds.add(focusId);
      }
      detailCompactions.set(focusId, markers);
    }
    for (const [projectId, signature] of candidate.projectSignatures) {
      projectSignatures.set(projectId, signature);
      projectFreshAt.set(projectId, atMs);
    }
    for (const [projectId, coverage] of candidate.projectCoverages) {
      projectCoverage.set(projectId, coverage);
    }
    trimMap(detailSignatures, MAX_SCOPE_BATCH * 4);
    trimMap(detailCompactions, MAX_SCOPE_BATCH * 4);
    trimMap(detailCoverage, MAX_SCOPE_BATCH * 4);
    trimMap(detailFreshAt, MAX_SCOPE_BATCH * 4);
    trimMap(projectSignatures, MAX_SCOPE_BATCH * 4);
    trimMap(projectCoverage, MAX_SCOPE_BATCH * 4);
    trimMap(projectFreshAt, MAX_SCOPE_BATCH * 4);

    const dataChanged =
      candidate.replaced ||
      occurrenceRemoved ||
      removals.length > 0 ||
      upserts.length > 0 ||
      sessionsChanged ||
      projectsChanged;
    const cursorChanged =
      candidate.sourceCursorAtMs !== undefined && state.sourceCursorAtMs !== priorSourceCursorAtMs;
    const repairChanged =
      candidate.repairCompletedAtMs !== undefined &&
      state.lastFullRepairAtMs !== priorLastFullRepairAtMs;
    const extentSinceChanged = state.extent?.sinceMs !== priorExtentSinceMs;
    const identityEstablished =
      priorSourceIdentity === undefined && state.sourceIdentity !== undefined;
    let sessionCacheInvalidated = false;
    if (!dataChanged && agentAffectedSessionIds.size > 0) {
      sessionCacheInvalidated = invalidateCachedSessions(agentAffectedSessionIds);
    }
    if (!dataChanged && markerChangedFocusIds.size > 0) {
      const affectedSessionIds = new Set<string>();
      for (const focusId of markerChangedFocusIds) {
        affectedSessionIds.add(focusId);
        for (const sessionId of indexes.treeIds(focusId)) affectedSessionIds.add(sessionId);
      }
      if (invalidateCachedSessions(affectedSessionIds)) sessionCacheInvalidated = true;
    }
    if (dataChanged || candidate.extentChanged || sessionCacheInvalidated) {
      generation += 1;
      // Extending empty coverage is not a visible data change; keep the sidecar
      // and avoid a no-op host notification in that case.
      if (dataChanged) state.presentation = undefined;
    }

    if (modelHydrated) {
      const modelUpserts = agentUpserts.length > 0 ? [...upserts, ...agentUpserts] : upserts;
      if (removals.length > 0 || modelUpserts.length > 0 || sessionsChanged || projectsChanged) {
        measureSync("modelUpdate", () => {
          if (sessionsChanged || projectsChanged) {
            model.setMetadata(candidate.sessions, candidate.projects);
          }
          if (removals.length > 0 || modelUpserts.length > 0) {
            model.apply(modelUpserts, removals);
          }
        });
      }
    } else {
      modelDirty = true;
    }
    if (removals.length > 0 && state.fingerprints.length > state.occurrences.size + 32) {
      pruneFingerprints();
    }
    const globalRefresh = effectiveJob.globalRange !== undefined;
    const finitePresentationChanged = refreshFinitePresentationWindows(atMs, globalRefresh);
    if (globalRefresh) precomputeHomeSnapshots(atMs);
    samplePeak();

    // A no-change refresh only moves wall freshness (and possibly the extent's
    // until bound); the compact index already carries the prior cursor/data.
    // Persist it only when an index-bearing field actually changed.
    const snapshotNeeded =
      dataChanged ||
      updatedAtChanged ||
      cursorChanged ||
      repairChanged ||
      extentSinceChanged ||
      identityEstablished;
    if (snapshotNeeded) {
      compactRevision += 1;
      queueSnapshotWrite(atMs);
    } else if (compactDirty) {
      // A failed/blocked compact write stays dirty across no-change refreshes
      // until the checkpoint for its revision succeeds.
      queueSnapshotWrite(atMs);
    }
    if (hasUsefulPresentation() || sessionCacheInvalidated || finitePresentationChanged) {
      queuePresentationWrite(atMs, atMs, sessionCacheInvalidated || finitePresentationChanged);
    }
    if ((dataChanged || sessionCacheInvalidated) && !closed && !closing) {
      try {
        options.onGeneration?.(generation);
      } catch {
        // A host notification failure never breaks the refresh.
      }
    }
  }

  function takeBatch(): RefreshJob | undefined {
    const globalRange = pendingGlobal;
    pendingGlobal = undefined;
    const detailSessionIds = [...pendingDetailSessions].slice(0, MAX_SCOPE_BATCH);
    for (const id of detailSessionIds) pendingDetailSessions.delete(id);
    const projectScopes = [...pendingProjectScopes.entries()]
      .slice(0, MAX_SCOPE_BATCH)
      .map(([projectId, range]) => ({ projectId, range }));
    for (const scope of projectScopes) pendingProjectScopes.delete(scope.projectId);
    if (globalRange === undefined && detailSessionIds.length === 0 && projectScopes.length === 0) {
      if (!pendingMetadataOnly) return undefined;
      pendingMetadataOnly = false;
    }
    return { globalRange, detailSessionIds, projectScopes };
  }

  function kickRefresh(): Promise<void> {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        await Promise.resolve();
        for (;;) {
          const batch = takeBatch();
          if (!batch) {
            await Promise.resolve();
            const retry = takeBatch();
            if (!retry) break;
            await refreshBatch(retry);
            continue;
          }
          await refreshBatch(batch);
        }
      })().finally(() => {
        refreshPromise = undefined;
        if (
          pendingGlobal !== undefined ||
          pendingDetailSessions.size > 0 ||
          pendingProjectScopes.size > 0
        ) {
          void kickRefresh();
        }
      });
    }
    return refreshPromise;
  }

  function requestRefresh(job: RefreshJob): Promise<void> {
    if (closed) return Promise.reject(new Error("analytics closed"));
    if (job.globalRange !== undefined) {
      pendingGlobal = widerRange(pendingGlobal, job.globalRange);
      lastGlobalRange.value = widerRange(lastGlobalRange.value, job.globalRange);
    }
    for (const id of job.detailSessionIds) {
      pendingDetailSessions.add(id);
      lastDetailSessionIds.add(id);
      trimSet(lastDetailSessionIds, MAX_SCOPE_BATCH * 4);
    }
    for (const scope of job.projectScopes) {
      pendingProjectScopes.set(
        scope.projectId,
        widerRange(pendingProjectScopes.get(scope.projectId), scope.range),
      );
      lastProjectScopes.set(
        scope.projectId,
        widerRange(lastProjectScopes.get(scope.projectId), scope.range),
      );
      trimMap(lastProjectScopes, MAX_SCOPE_BATCH * 4);
    }
    return kickRefresh();
  }

  function requestBackground(job: RefreshJob, force = false): void {
    if (closed || closing || (!force && !dueForAttempt(job, now()))) return;
    void requestRefresh(job).catch(() => {});
  }

  return {
    async home(range) {
      if (!isRangeKey(range)) throw new AnalyticsLookupError("bad-request");
      if (closed) throw new Error("analytics closed");
      await ensureLoaded();
      const atMs = now();
      const window = rangeWindow(range, atMs);
      lastGlobalRange.value = widerRange(lastGlobalRange.value, range);
      const cachedEntry = state.presentation?.home[range];
      const cached = cachedEntry?.usage.timeZone === timeZone ? cachedEntry : undefined;
      if (cached && (await warmCacheAllowed())) {
        let current = cached;
        let expired = false;
        const certified = homeCertifiedSyncAtMs(range, atMs);
        if (
          range !== "lifetime" &&
          certified !== undefined &&
          current.usage.window.untilMs < certified
        ) {
          if (modelHydrated && !modelDirty) {
            current = deriveHomeSnapshot(range, certified);
            cacheHome(range, current, atMs);
          } else {
            delete state.presentation?.home[range];
            expired = true;
          }
        }
        if (!expired) {
          const missingCoverage = !coversSince(window.sinceMs, state.extent);
          const stale = sidecarNewerThanIndex || isStale(atMs) || missingCoverage;
          if (stale) {
            requestBackground(
              { globalRange: range, detailSessionIds: [], projectScopes: [] },
              sidecarNewerThanIndex || missingCoverage,
            );
          }
          scheduleThirtyDayExtension(range, atMs);
          return homeSnapshotWithStaleness(current, range, atMs, stale);
        }
      }
      await ensureIndexLoaded();
      if (!coverageTrusted || !coversSince(window.sinceMs, state.extent)) {
        await requestRefresh({ globalRange: range, detailSessionIds: [], projectScopes: [] });
        if (
          unavailable &&
          state.occurrences.size === 0 &&
          Object.keys(state.sessions).length === 0
        ) {
          throw new AnalyticsLookupError("unavailable");
        }
      }
      const stale = isStale(now());
      if (stale) {
        requestBackground({ globalRange: range, detailSessionIds: [], projectScopes: [] });
      }
      ensureModel();
      const certified = homeCertifiedSyncAtMs(range, atMs);
      const result = deriveHomeSnapshot(
        range,
        range !== "lifetime" && certified !== undefined ? certified : atMs,
      );
      cacheHome(range, result, atMs);
      precomputeHomeSnapshots(atMs);
      scheduleThirtyDayExtension(range, atMs);
      return homeSnapshotWithStaleness(result, range, atMs, stale);
    },

    async project(projectId, range) {
      if (!isRangeKey(range)) throw new AnalyticsLookupError("bad-request");
      if (closed) throw new Error("analytics closed");
      if (!projectId) throw new AnalyticsLookupError("bad-request");
      await ensureLoaded();
      const atMs = now();
      lastProjectScopes.set(projectId, widerRange(lastProjectScopes.get(projectId), range));
      const cached = cachedProject(projectId, range);
      if (cached && (await warmCacheAllowed())) {
        let current = cached;
        let expired = false;
        const certified = projectCertifiedSyncAtMs(projectId, range, atMs);
        if (certified !== undefined && current.usage.window.untilMs < certified) {
          if (modelHydrated && !modelDirty) {
            current = deriveProjectSnapshot(projectId, range, certified);
            cacheProject(current, atMs);
          } else if (range !== "lifetime") {
            const presentation = state.presentation;
            if (presentation) {
              presentation.project = presentation.project.filter(
                ([id, entryRange]) => id !== projectId || entryRange !== range,
              );
              state.presentation = presentation;
            }
            expired = true;
          }
        }
        if (!expired) {
          const stale =
            sidecarNewerThanIndex ||
            certified === undefined ||
            unavailable ||
            atMs - certified >= refreshIntervalMs;
          if (stale) {
            requestBackground(
              { detailSessionIds: [], projectScopes: [{ projectId, range }] },
              sidecarNewerThanIndex || certified === undefined,
            );
          }
          return projectSnapshotWithStaleness(current, stale);
        }
      }
      await ensureIndexLoaded();

      const certifiedBefore = projectCertifiedSyncAtMs(projectId, range, atMs);
      const covered = certifiedBefore !== undefined;
      if (!covered || !stateHasProject(projectId)) {
        await requestRefresh({
          detailSessionIds: [],
          projectScopes: [{ projectId, range }],
        });
      }
      if (!stateHasProject(projectId)) throw new AnalyticsLookupError("project-not-found");
      const certified = projectCertifiedSyncAtMs(projectId, range, atMs);
      const stale =
        sidecarNewerThanIndex ||
        certified === undefined ||
        unavailable ||
        atMs - certified >= refreshIntervalMs;
      if (stale) {
        requestBackground(
          { detailSessionIds: [], projectScopes: [{ projectId, range }] },
          sidecarNewerThanIndex || certified === undefined,
        );
      }
      ensureModel();
      const result = measureSync("dtoAggregation", (): ProjectSnapshot => {
        const snapshot = model.project(
          projectId,
          range,
          range !== "lifetime" && certified !== undefined ? certified : atMs,
        );
        return {
          ...snapshot,
          stale,
          usage: { ...snapshot.usage, stale },
        };
      });
      cacheProject(result, atMs);
      return result;
    },

    async session(sessionId) {
      if (closed) throw new Error("analytics closed");
      if (!sessionId) throw new AnalyticsLookupError("bad-request");
      await ensureLoaded();
      lastDetailSessionIds.add(sessionId);
      trimSet(lastDetailSessionIds, MAX_SCOPE_BATCH * 4);
      const cached = cachedSession(sessionId);
      if (cached && (await warmCacheAllowed())) {
        touchSessionCache(sessionId, now());
        requestBackground(
          { detailSessionIds: [sessionId], projectScopes: [] },
          sidecarNewerThanIndex,
        );
        return cached;
      }
      await ensureIndexLoaded();
      let focus = state.sessions[sessionId];
      if (!focus) {
        await requestRefresh({ detailSessionIds: [sessionId], projectScopes: [] });
        focus = state.sessions[sessionId];
        if (!focus) throw new AnalyticsLookupError("session-not-found");
      }
      const ids = indexes.treeIds(sessionId);
      const signature = sessionRevisionSignature(state.sessions, ids);
      const markers = detailCompactions.get(sessionId);
      if (detailSignatures.get(sessionId) !== signature || markers === undefined) {
        await requestRefresh({ detailSessionIds: [sessionId], projectScopes: [] });
      }
      if (!isDetailFresh(sessionId, now())) {
        requestBackground({ detailSessionIds: [sessionId], projectScopes: [] });
      }
      // Session detail reuses the shared aggregation DTO builder over the
      // scoped tree plus global owner candidates instead of duplicating it.
      try {
        const result = measureSync("dtoAggregation", () =>
          createUsageAnalytics(sessionDataset(sessionId), { timeZone }).session(sessionId),
        );
        cacheSession(sessionId, result, now());
        return result;
      } catch {
        throw new AnalyticsLookupError("session-not-found");
      }
    },

    async refresh() {
      if (closed) throw new Error("analytics closed");
      await ensureIndexLoaded();
      const atMs = now();
      const hasInterests =
        lastGlobalRange.value !== undefined ||
        lastDetailSessionIds.size > 0 ||
        lastProjectScopes.size > 0;
      if (!hasInterests) pendingMetadataOnly = true;
      await requestRefresh({
        ...(lastGlobalRange.value === undefined ? {} : { globalRange: lastGlobalRange.value }),
        detailSessionIds: [...lastDetailSessionIds],
        projectScopes: [...lastProjectScopes.entries()]
          .filter(
            ([, range]) =>
              lastGlobalRange.value === undefined ||
              !coversSince(rangeWindow(range, atMs).sinceMs, state.extent),
          )
          .map(([projectId, range]) => ({ projectId, range })),
      });
    },

    async stats() {
      const usage = process.memoryUsage();
      samplePeak();
      return {
        rss: usage.rss,
        heapTotal: usage.heapTotal,
        heapUsed: usage.heapUsed,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        peakHeapUsed,
        peakRss,
        phases: phaseMetrics(),
      };
    },

    async gc() {
      const periodic = (globalThis as { gc?: () => void }).gc;
      if (typeof periodic === "function") {
        periodic();
        return true;
      }
      const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun;
      if (bun?.gc) {
        bun.gc(true);
        return true;
      }
      return false;
    },

    async close() {
      if (closePromise) return closePromise;
      if (closed) return;
      closing = true;
      closePromise = (async () => {
        if (lowPriorityTimer !== undefined) {
          clearTimeout(lowPriorityTimer);
          lowPriorityTimer = undefined;
        }
        pendingGlobal = undefined;
        pendingMetadataOnly = false;
        pendingDetailSessions.clear();
        pendingProjectScopes.clear();
        const closeAtMs = now();
        if (compactDirty) queueSnapshotWrite(closeAtMs, true);
        queueFinalPresentationWrite(closeAtMs, indexLoaded ? closeAtMs : presentationSavedAtMs);
        const drained = drainAllWrites();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, closeWriteTimeoutMs);
          void drained.finally(() => {
            clearTimeout(timer);
            resolve();
          });
        });
        closed = true;
        lastDetailSessionIds.clear();
        lastProjectScopes.clear();
        detailSignatures.clear();
        detailCompactions.clear();
        detailCoverage.clear();
        projectSignatures.clear();
        projectCoverage.clear();
        projectFreshAt.clear();
        detailFreshAt.clear();
      })();
      return await closePromise;
    },
  };
}
