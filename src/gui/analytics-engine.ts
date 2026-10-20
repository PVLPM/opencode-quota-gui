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
import { createUsageAnalytics } from "./aggregation.js";
import { type AnalyticsModel, createAnalyticsModel } from "./analytics-model.js";
import type { AnalyticsPhaseMetrics } from "./analytics-protocol.js";
import { type AnalyticsReader, createAnalyticsReader } from "./analytics-reader.js";
import {
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

export const ANALYTICS_REFRESH_INTERVAL_MS = 600_000;
/** Explicit, rare full reconciliation cadence (persisted across restarts). */
export const ANALYTICS_FULL_REPAIR_INTERVAL_MS = 7 * 24 * 60 * 60_000;
/** Inclusive replay overlap for equal/late `time_updated` values (clock skew). */
export const ANALYTICS_SOURCE_CURSOR_OVERLAP_MS = 5 * 60_000;
const MAX_SCOPE_BATCH = 8;
const MAX_PROJECT_CACHE = 12;
const PRESENTATION_SAVE_INTERVAL_MS = 60_000;

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
  projectSignatures: Array<[string, string]>;
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
  return value ? value : "unknown";
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

function projectSessionIds(
  sessions: Record<string, OpenCodeSessionInfo>,
  projectId: string,
): string[] {
  return Object.values(sessions)
    .filter((session) => projectIdOf(session) === projectId)
    .map((session) => session.id)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function treeIds(sessions: Record<string, OpenCodeSessionInfo>, focusId: string): string[] {
  const childrenByParent = new Map<string, string[]>();
  for (const session of Object.values(sessions)) {
    if (!session.parentID) continue;
    let children = childrenByParent.get(session.parentID);
    if (!children) {
      children = [];
      childrenByParent.set(session.parentID, children);
    }
    children.push(session.id);
  }
  for (const children of childrenByParent.values()) children.sort();
  const ids: string[] = [];
  const seen = new Set<string>();
  const pending = [focusId];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    const children = childrenByParent.get(id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return ids;
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

function projectSignature(
  sessions: Record<string, OpenCodeSessionInfo>,
  projectId: string,
  range: RangeKey,
): string {
  return `${projectId}|${range}|${projectSessionIds(sessions, projectId).join(",")}`;
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

  const model: AnalyticsModel = createAnalyticsModel();
  let state = emptyState();
  let loaded = false;
  let loading: Promise<void> | undefined;
  let indexLoaded = false;
  let indexLoading: Promise<void> | undefined;
  let warmPresentation: WarmAnalyticsPresentation | undefined;
  let closed = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let modelHydrated = false;
  let modelDirty = true;
  let lastPresentationSaveAtMs = 0;
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
  let snapshotWritePending: { generation: number; atMs: number } | undefined;
  let presentationWritePending: { generation: number; atMs: number } | undefined;
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
   * so the first useful home/project view never waits for 120k occurrences.
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
      if (warmPresentation) state.presentation = warmPresentation;
      loaded = true;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
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
        const persistedIdentity = persisted.sourceIdentity;
        const warmIdentity = warmPresentation?.sourceIdentity;
        if (
          warmPresentation &&
          persistedIdentity !== undefined &&
          warmIdentity !== undefined &&
          compareOpenCodeSourceIdentity(persistedIdentity, warmIdentity) === "same"
        ) {
          state.presentation = warmPresentation;
        } else if (warmPresentation) {
          // A missing/mismatched token cannot certify these DTOs against the
          // persisted index; never let an old-DB sidecar shadow fresh data.
          state.presentation = undefined;
        }
      }
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
   * every stored occurrence that shares a tree fingerprint (fork owners).
   */
  function sessionDataset(sessionId: string): {
    sessions: AnalyticsState["sessions"];
    projects: AnalyticsState["projects"];
    messages: OpenCodeRawAssistantRow[];
    compactions: Array<{ sessionId: string; atMs: number; messageId: string }>;
  } {
    const tree = new Set(treeIds(state.sessions, sessionId));
    const fingerprintIndexes = new Set<number>();
    for (const occurrence of state.occurrences.values()) {
      if (tree.has(occurrence.sessionID)) fingerprintIndexes.add(occurrence.fingerprintIndex);
    }
    const messages: OpenCodeRawAssistantRow[] = [];
    for (const occurrence of state.occurrences.values()) {
      if (!tree.has(occurrence.sessionID) && !fingerprintIndexes.has(occurrence.fingerprintIndex)) {
        continue;
      }
      const row = rowOf(occurrence);
      if (row) messages.push(row);
    }
    return {
      sessions: state.sessions,
      projects: state.projects,
      messages,
      compactions: detailCompactions.get(sessionId) ?? [],
    };
  }

  function stateHasProject(projectId: string): boolean {
    if (Object.hasOwn(state.projects, projectId)) return true;
    for (const session of Object.values(state.sessions)) {
      if (projectIdOf(session) === projectId) return true;
    }
    return false;
  }

  function isStale(atMs: number): boolean {
    if (unavailable) return true;
    return atMs - state.frontierAtMs >= refreshIntervalMs;
  }

  function isProjectFresh(projectId: string, atMs: number): boolean {
    const freshAt = projectFreshAt.get(projectId);
    return freshAt !== undefined && atMs - freshAt < refreshIntervalMs;
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

  function cacheHome(range: RangeKey, snapshot: HomeSnapshot, atMs: number): void {
    const presentation: AnalyticsPresentation = state.presentation ?? { home: {}, project: [] };
    presentation.home[range] = snapshot;
    state.presentation = presentation;
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
    return entry?.[2];
  }

  function hasUsefulPresentation(): boolean {
    const presentation = state.presentation;
    return (
      presentation !== undefined &&
      (Object.keys(presentation.home).length > 0 || presentation.project.length > 0)
    );
  }

  async function drainWrites(): Promise<void> {
    for (;;) {
      const snapshotJob = snapshotWritePending;
      snapshotWritePending = undefined;
      const presentationJob = presentationWritePending;
      presentationWritePending = undefined;
      if (!snapshotJob && !presentationJob) return;
      if (snapshotJob && snapshotJob.generation === generation) {
        await measureAsync("persistenceWrite", () =>
          saveSnapshot(snapshotPath, state, snapshotJob.atMs).catch(() => false),
        );
      }
      if (presentationJob && presentationJob.generation === generation && hasUsefulPresentation()) {
        await measureAsync("persistenceWrite", () =>
          savePresentation(presentationPath, state, presentationJob.atMs).catch(() => false),
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

  function queueSnapshotWrite(atMs: number): void {
    if (closed || closing) return;
    snapshotWritePending = { generation, atMs };
    scheduleWriteDrain();
  }

  function queuePresentationWrite(atMs: number): void {
    if (closed || closing || !hasUsefulPresentation()) return;
    presentationWritePending = { generation, atMs };
    scheduleWriteDrain();
  }

  function persistPresentation(atMs: number): void {
    if (closed || closing || atMs - lastPresentationSaveAtMs < PRESENTATION_SAVE_INTERVAL_MS) {
      return;
    }
    lastPresentationSaveAtMs = atMs;
    queuePresentationWrite(atMs);
    if (indexLoaded) queueSnapshotWrite(atMs);
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
      Object.keys(state.sessions).length === 0;
    const replaced = comparison === "changed" && !pristine;

    const readHistoricalRows = (
      params: ReadCompletedAssistantRowsParams = {},
    ): OpenCodeRawAssistantRow[] =>
      measureSync("historicalPayloadRead", () => snapshot.readCompletedAssistantRows(params));
    const readChangedRows = (messageIDs: readonly string[]): OpenCodeRawAssistantRow[] =>
      measureSync("changedPayloadRead", () => snapshot.readCompletedAssistantRows({ messageIDs }));

    const sessions = measureSync("metadataRead", () => snapshot.readAllSessionsIndex());
    const projects = measureSync("metadataRead", () => snapshot.readProjectsIndex());

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
      const entry: StagedUpsert = { row, updatedAtMs };
      if (row.agent !== undefined) entry.agent = row.agent;
      changedMap.set(key, entry);
      removalKeys.delete(key);
    };

    const stageBulk = (row: OpenCodeRawAssistantRow, updatedAtMs?: number | null): void => {
      const key = row.messageID;
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
    // The session key walk is small; the occurrence walk only runs when a
    // session actually disappeared.
    if (!replaced) {
      const removedSessionIds = new Set<string>();
      for (const id of Object.keys(state.sessions)) {
        if (!Object.hasOwn(sessions, id)) removedSessionIds.add(id);
      }
      if (removedSessionIds.size > 0) {
        for (const [key, occurrence] of state.occurrences) {
          if (removedSessionIds.has(occurrence.sessionID)) removalKeys.add(key);
        }
      }
    }

    const fullRepairRead = fullProjection && !replaced && effectiveExtent !== undefined;
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
    const projectSignatureChanges: Array<[string, string]> = [];

    /**
     * Cross-scope fork owners must stay in the contribution set for exact
     * ownership. For new/unknown scoped fingerprints, query only the completed
     * time span of the scope instead of paying a global revision projection.
     */
    const discoverExternalOwners = (read: ScopeRead): void => {
      if (read.times.size === 0) return;
      let minMs = Number.POSITIVE_INFINITY;
      let maxMs = Number.NEGATIVE_INFINITY;
      for (const time of read.times) {
        if (time < minMs) minMs = time;
        if (time > maxMs) maxMs = time;
      }
      const candidates = readHistoricalRows({
        completedSinceMs: minMs,
        completedUntilMs: maxMs,
      });
      for (const row of candidates) {
        if (read.ids.has(row.sessionID)) continue;
        if (!read.times.has(row.completedAtMs)) continue;
        if (!read.fingerprints.has(fingerprintOf(row))) continue;
        if (bulkMap.has(row.messageID) || changedMap.has(row.messageID)) continue;
        if (state.occurrences.has(row.messageID)) continue;
        stageChanged(row, row.updatedAtMs ?? null);
      }
    };

    for (const scope of job.projectScopes) {
      const scopeWindow = rangeWindow(scope.range, atMs);
      const ids = projectSessionIds(sessions, scope.projectId);
      if (ids.length === 0) continue;
      const scopeSessions = new Set(ids);
      for (const [key, occurrence] of state.occurrences) {
        if (!scopeSessions.has(occurrence.sessionID)) continue;
        const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
        if (
          fingerprint &&
          fingerprint[1] <= atMs &&
          (scopeWindow.sinceMs === undefined || fingerprint[1] >= scopeWindow.sinceMs)
        ) {
          removalKeys.add(key);
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
      projectSignatureChanges.push([
        scope.projectId,
        projectSignature(sessions, scope.projectId, scope.range),
      ]);
    }

    for (const focusId of job.detailSessionIds) {
      const focus = sessions[focusId];
      if (!focus) {
        detailSignatureChanges.push([focusId, ""]);
        continue;
      }
      const ids = treeIds(sessions, focusId);
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
      for (const [key, occurrence] of state.occurrences) {
        if (idSet.has(occurrence.sessionID)) removalKeys.add(key);
      }
      const rows = readHistoricalRows({ sessionIDs: ids });
      const read: ScopeRead = { ids: idSet, fingerprints: new Set(), times: new Set() };
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
      detailSignatureChanges.push([focusId, sessionRevisionSignature(sessions, ids)]);
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
            continue;
          }
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          // A null/non-numeric source timestamp cannot prove the payload is
          // unchanged, so re-read it conservatively on every delta.
          const unknownTimestamp =
            revisionSnapshot.updatedAtAvailable && revision.updatedAtMs === null;
          if (
            !bulkRow &&
            (unknownTimestamp ||
              !fingerprint ||
              completed !== fingerprint[1] ||
              (revisionSnapshot.updatedAtAvailable &&
                revision.updatedAtMs !== occurrence.updatedAtMs))
          ) {
            changedIds.set(key, { updatedAtMs: revision.updatedAtMs });
          }
        } else if (!replaced && !bulkRow && completed > 0 && window) {
          if (completed <= extentUntil && (extentSince === undefined || completed >= extentSince)) {
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
      projectSignatures: projectSignatureChanges,
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
  }

  async function refreshBatch(job: RefreshJob): Promise<void> {
    await ensureIndexLoaded();
    const atMs = now();
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

    // Apply synchronously after the transaction has returned.
    if (candidate.replaced) {
      state.occurrences.clear();
      state.fingerprints = [];
      state.fingerprintIndex.clear();
      state.extent = undefined;
      state.presentation = undefined;
      state.sourceCursorAtMs = undefined;
      state.lastFullRepairAtMs = undefined;
      projectSignatures.clear();
      detailSignatures.clear();
      detailCompactions.clear();
      projectFreshAt.clear();
      detailFreshAt.clear();
      measureSync("modelUpdate", () => model.clear());
      modelHydrated = false;
      modelDirty = true;
    }

    const removals: OpenCodeRawAssistantRow[] = [];
    for (const key of candidate.removalKeys) {
      const occurrence = state.occurrences.get(key);
      if (!occurrence) continue;
      const row = rowOf(occurrence);
      if (row) removals.push(row);
      state.occurrences.delete(key);
    }

    const upserts: OpenCodeRawAssistantRow[] = [];
    const changedKeys = new Set(candidate.changedMap.keys());
    for (const row of candidate.bulkRows) {
      const key = row.messageID;
      if (changedKeys.has(key)) continue;
      const existing = state.occurrences.get(key);
      if (existing) {
        const oldRow = rowOf(existing);
        if (oldRow) removals.push(oldRow);
      }
      setRow(row, (row as WatermarkedRow)[WATERMARK] ?? null);
      upserts.push(row);
    }
    for (const [key, entry] of candidate.changedMap) {
      const existing = state.occurrences.get(key);
      if (existing) {
        const oldRow = rowOf(existing);
        if (oldRow) removals.push(oldRow);
      }
      setRow(entry.row, entry.updatedAtMs, entry.agent);
      upserts.push(entry.row);
    }

    state.sessions = candidate.sessions;
    state.projects = candidate.projects;
    state.sourceIdentity = candidate.identity;
    if (candidate.extentChanged) state.extent = candidate.nextExtent;
    // A scoped-only refresh never certifies global freshness or advances the
    // source cursor; only a successful global candidate may do either.
    if (effectiveJob.globalRange !== undefined) state.frontierAtMs = atMs;
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
        detailFreshAt.delete(focusId);
      } else {
        detailSignatures.set(focusId, signature);
        detailFreshAt.set(focusId, atMs);
      }
    }
    for (const [focusId, markers] of candidate.detailCompactions) {
      detailCompactions.set(focusId, markers);
    }
    trimMap(detailSignatures, MAX_SCOPE_BATCH * 4);
    trimMap(detailCompactions, MAX_SCOPE_BATCH * 4);
    trimMap(detailFreshAt, MAX_SCOPE_BATCH * 4);
    for (const [projectId, signature] of candidate.projectSignatures) {
      projectSignatures.set(projectId, signature);
      projectFreshAt.set(projectId, atMs);
    }
    trimMap(projectSignatures, MAX_SCOPE_BATCH * 4);
    trimMap(projectFreshAt, MAX_SCOPE_BATCH * 4);

    const dataChanged =
      candidate.replaced ||
      removals.length > 0 ||
      upserts.length > 0 ||
      sessionsChanged ||
      projectsChanged;
    if (dataChanged || candidate.extentChanged) {
      generation += 1;
      // Extending empty coverage is not a visible data change; keep the sidecar
      // and avoid a no-op host notification in that case.
      if (dataChanged) state.presentation = undefined;
    }

    if (modelHydrated) {
      if (removals.length > 0 || upserts.length > 0 || sessionsChanged || projectsChanged) {
        measureSync("modelUpdate", () => {
          if (sessionsChanged || projectsChanged) {
            model.setMetadata(candidate.sessions, candidate.projects);
          }
          if (removals.length > 0 || upserts.length > 0) {
            model.apply(upserts, removals);
          }
        });
      }
    } else {
      modelDirty = true;
    }
    if (removals.length > 0 && state.fingerprints.length > state.occurrences.size + 32) {
      pruneFingerprints();
    }
    samplePeak();

    queueSnapshotWrite(atMs);
    if (hasUsefulPresentation()) queuePresentationWrite(atMs);
    if (dataChanged && !closed && !closing) {
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

  function requestBackground(job: RefreshJob): void {
    if (closed || closing || !dueForAttempt(job, now())) return;
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
      const cached = state.presentation?.home[range];
      if (cached) {
        const stale = isStale(atMs) || !coversSince(window.sinceMs, state.extent);
        if (stale) {
          requestBackground({ globalRange: range, detailSessionIds: [], projectScopes: [] });
        }
        return homeSnapshotWithStaleness(cached, range, atMs, stale);
      }
      await ensureIndexLoaded();
      if (!coversSince(window.sinceMs, state.extent)) {
        await requestRefresh({ globalRange: range, detailSessionIds: [], projectScopes: [] });
        if (
          unavailable &&
          state.occurrences.size === 0 &&
          Object.keys(state.sessions).length === 0
        ) {
          throw new AnalyticsLookupError("unavailable");
        }
      }
      if (isStale(now())) {
        requestBackground({ globalRange: range, detailSessionIds: [], projectScopes: [] });
      }
      const stale = isStale(now());
      ensureModel();
      const result = measureSync("dtoAggregation", (): HomeSnapshot => {
        const snapshot = model.home(range, atMs);
        return {
          generatedAtMs: atMs,
          range,
          stale,
          providers: { cards: [], enabledProviders: [], polledAtMs: atMs },
          usage: { ...snapshot.usage, stale },
          projects: snapshot.projects,
        };
      });
      cacheHome(range, result, atMs);
      return result;
    },

    async project(projectId, range) {
      if (!isRangeKey(range)) throw new AnalyticsLookupError("bad-request");
      if (closed) throw new Error("analytics closed");
      if (!projectId) throw new AnalyticsLookupError("bad-request");
      await ensureLoaded();
      const atMs = now();
      lastProjectScopes.set(projectId, widerRange(lastProjectScopes.get(projectId), range));
      const cached = cachedProject(projectId, range);
      if (cached) {
        const stale = isStale(atMs) && !isProjectFresh(projectId, atMs);
        if (stale) {
          requestBackground({ detailSessionIds: [], projectScopes: [{ projectId, range }] });
        }
        return projectSnapshotWithStaleness(cached, stale);
      }
      await ensureIndexLoaded();

      const window = rangeWindow(range, atMs);
      const signature = projectSignature(state.sessions, projectId, range);
      const covered =
        isProjectFresh(projectId, atMs) ||
        coversSince(window.sinceMs, state.extent) ||
        projectSignatures.get(projectId) === signature;
      if (!covered || !stateHasProject(projectId)) {
        await requestRefresh({
          detailSessionIds: [],
          projectScopes: [{ projectId, range }],
        });
      }
      if (!stateHasProject(projectId)) throw new AnalyticsLookupError("project-not-found");
      if (isStale(now())) {
        requestBackground({ detailSessionIds: [], projectScopes: [{ projectId, range }] });
      }
      const stale = isStale(now());
      ensureModel();
      const result = measureSync("dtoAggregation", (): ProjectSnapshot => {
        const snapshot = model.project(projectId, range, atMs);
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
      await ensureIndexLoaded();
      lastDetailSessionIds.add(sessionId);
      trimSet(lastDetailSessionIds, MAX_SCOPE_BATCH * 4);
      let focus = state.sessions[sessionId];
      if (!focus) {
        await requestRefresh({ detailSessionIds: [sessionId], projectScopes: [] });
        focus = state.sessions[sessionId];
        if (!focus) throw new AnalyticsLookupError("session-not-found");
      }
      const ids = treeIds(state.sessions, sessionId);
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
        return measureSync("dtoAggregation", () =>
          createUsageAnalytics(sessionDataset(sessionId)).session(sessionId),
        );
      } catch {
        throw new AnalyticsLookupError("session-not-found");
      }
    },

    async refresh() {
      if (closed) throw new Error("analytics closed");
      await ensureIndexLoaded();
      const hasInterests =
        lastGlobalRange.value !== undefined ||
        lastDetailSessionIds.size > 0 ||
        lastProjectScopes.size > 0;
      if (!hasInterests) pendingMetadataOnly = true;
      await requestRefresh({
        ...(lastGlobalRange.value === undefined ? {} : { globalRange: lastGlobalRange.value }),
        detailSessionIds: [...lastDetailSessionIds],
        projectScopes: [...lastProjectScopes.entries()].map(([projectId, range]) => ({
          projectId,
          range,
        })),
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
        pendingGlobal = undefined;
        pendingMetadataOnly = false;
        pendingDetailSessions.clear();
        pendingProjectScopes.clear();
        const drained = writeChain.catch(() => undefined);
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
        projectSignatures.clear();
        projectFreshAt.clear();
        detailFreshAt.clear();
      })();
      return await closePromise;
    },
  };
}
