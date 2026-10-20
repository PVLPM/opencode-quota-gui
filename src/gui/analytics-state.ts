/**
 * Compact, versioned analytics snapshot persistence (schema v3).
 *
 * The worker owns the large in-memory analytics index. Persistence keeps one
 * compact fingerprint contribution dictionary (referenced by numeric index),
 * occurrence membership (message/session identity + revision watermark), the
 * stable source identity, the coverage extent/frontier, the trusted source
 * cursor and rare-repair wall time, and a bounded warm presentation cache for
 * home/project DTOs. It never stores raw message JSON, agent strings,
 * compaction markers, or a duplicate raw dataset.
 */
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HomeSnapshot, ProjectSnapshot } from "../contracts/dashboard.js";
import { isRangeKey, type RangeKey } from "../contracts/ranges.js";
import { getOpencodeRuntimeDirs } from "../lib/opencode-runtime-paths.js";
import {
  type OpenCodeProjectInfo,
  type OpenCodeRawAssistantRow,
  type OpenCodeSessionInfo,
  type OpenCodeSourceIdentity,
  rawAssistantRowFingerprint,
} from "../lib/opencode-storage.js";

export const ANALYTICS_SNAPSHOT_VERSION = 3;
export const ANALYTICS_SNAPSHOT_SCHEMA = "ocq-analytics-state";

export interface AnalyticsCoverage {
  /** Inclusive start; absent means the lifetime read reached the beginning. */
  sinceMs?: number;
  /** Inclusive end of the loaded completion window. */
  untilMs: number;
}

/** One compact contribution tuple: the ten upstream fingerprint fields. */
export type CompactFingerprint = [
  createdAtMs: number,
  completedAtMs: number,
  providerID: string | null,
  modelID: string | null,
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number | null,
];

/** One physical occurrence of a fingerprint contribution. */
export interface Occurrence {
  /** Index into `AnalyticsState.fingerprints`. */
  fingerprintIndex: number;
  sessionID: string;
  messageID: string;
  /** `session_message.time_updated`; null when unavailable/non-numeric. */
  updatedAtMs: number | null;
  /** In-memory only: never persisted, so detail-only agents stay transient. */
  agent?: string;
}

/**
 * Bounded warm presentation cache. Home/project DTOs are compact (buckets and
 * roots, no steps), so a warm worker can answer the first useful view without
 * rebuilding ownership/rollups from every occurrence.
 */
export interface AnalyticsPresentation {
  home: Partial<Record<RangeKey, HomeSnapshot>>;
  /** LRU-ordered [projectId, range, snapshot] entries. */
  project: Array<[projectId: string, range: RangeKey, snapshot: ProjectSnapshot]>;
}

/**
 * A warm sidecar plus the source identity it was written for. The token is
 * optional only for legacy files; an absent/invalid token can never certify the
 * DTOs against a different database.
 */
export interface WarmAnalyticsPresentation extends AnalyticsPresentation {
  sourceIdentity?: OpenCodeSourceIdentity;
}

export interface AnalyticsState {
  sessions: Record<string, OpenCodeSessionInfo>;
  projects: Record<string, OpenCodeProjectInfo>;
  /** Compact contribution tuples. */
  fingerprints: CompactFingerprint[];
  /** fingerprint string -> index (in-memory; rebuilt on decode). */
  fingerprintIndex: Map<string, number>;
  /** rowKey -> occurrence. */
  occurrences: Map<string, Occurrence>;
  /** Historical extent of loaded global rows; frontier freshness is separate. */
  extent?: AnalyticsCoverage;
  /** Stable replacement identity from the core snapshot transaction. */
  sourceIdentity?: OpenCodeSourceIdentity;
  /** Wall time of the last successful refresh (frontier freshness). */
  frontierAtMs: number;
  /**
   * Trusted source `time_updated` frontier, capped at the wall time observed
   * when it was established. Absent means a full source baseline is required;
   * it must never be inferred from `frontierAtMs` or cached occurrence times.
   */
  sourceCursorAtMs?: number;
  /** Wall time of the last completed full reconciliation (7-day repair). */
  lastFullRepairAtMs?: number;
  presentation?: AnalyticsPresentation;
}

export function rowKey(sessionID: string, messageID: string): string {
  return `${sessionID}\u0000${messageID}`;
}

export function fingerprintOf(row: OpenCodeRawAssistantRow): string {
  return rawAssistantRowFingerprint(row);
}

export function compactFingerprintOf(row: OpenCodeRawAssistantRow): CompactFingerprint {
  return [
    row.createdAtMs,
    row.completedAtMs,
    row.providerID ?? null,
    row.modelID ?? null,
    row.tokens.input,
    row.tokens.output,
    row.tokens.reasoning,
    row.tokens.cacheRead,
    row.tokens.cacheWrite,
    row.cost ?? null,
  ];
}

export function rowFromFingerprint(
  fingerprint: CompactFingerprint,
  occurrence: Pick<Occurrence, "sessionID" | "messageID" | "agent">,
): OpenCodeRawAssistantRow {
  const row: OpenCodeRawAssistantRow = {
    sessionID: occurrence.sessionID,
    messageID: occurrence.messageID,
    createdAtMs: fingerprint[0],
    completedAtMs: fingerprint[1],
    tokens: {
      input: fingerprint[4],
      output: fingerprint[5],
      reasoning: fingerprint[6],
      cacheRead: fingerprint[7],
      cacheWrite: fingerprint[8],
    },
  };
  if (fingerprint[2] !== null) row.providerID = fingerprint[2];
  if (fingerprint[3] !== null) row.modelID = fingerprint[3];
  if (fingerprint[9] !== null) row.cost = fingerprint[9];
  if (occurrence.agent !== undefined) row.agent = occurrence.agent;
  return row;
}

interface PersistedAnalyticsStateV3 {
  version: typeof ANALYTICS_SNAPSHOT_VERSION;
  schema: typeof ANALYTICS_SNAPSHOT_SCHEMA;
  savedAtMs: number;
  frontierAtMs: number;
  /** Additive v3 field: absent/null in legacy files means "baseline required". */
  sourceCursorAtMs: number | null;
  /** Additive v3 field: absent/null in legacy files means "repair due". */
  lastFullRepairAtMs: number | null;
  sourceIdentity: SourceIdentityTuple | null;
  extent: { sinceMs: number | null; untilMs: number } | null;
  fingerprints: CompactFingerprint[];
  occurrences: Array<
    [fingerprintIndex: number, sessionID: string, messageID: string, updatedAtMs: number | null]
  >;
  sessions: Array<
    [
      id: string,
      title: string | null,
      parentID: string | null,
      projectID: string | null,
      directory: string | null,
      createdMs: number | null,
      updatedMs: number | null,
    ]
  >;
  projects: Array<[id: string, name: string | null, directories: string[], worktrees: string[]]>;
  presentation: {
    home: Partial<Record<RangeKey, HomeSnapshot>>;
    project: Array<[projectId: string, range: RangeKey, snapshot: ProjectSnapshot]>;
  } | null;
}

/** Stable fields only; size/mtime are informational and never persisted. */
type SourceIdentityTuple = [
  dbPath: string,
  exists: boolean,
  status: "ok" | "missing" | "unreadable",
  realPath: string | null,
  device: string | null,
  inode: string | null,
  birthtimeMs: number | null,
  schemaToken: string | null,
];

export type PersistedAnalyticsState = PersistedAnalyticsStateV3;

export function encodeAnalyticsState(
  state: AnalyticsState,
  savedAtMs: number,
): PersistedAnalyticsStateV3 {
  const occurrences: PersistedAnalyticsStateV3["occurrences"] = [];
  for (const occurrence of state.occurrences.values()) {
    occurrences.push([
      occurrence.fingerprintIndex,
      occurrence.sessionID,
      occurrence.messageID,
      occurrence.updatedAtMs,
    ]);
  }

  const sessions: PersistedAnalyticsStateV3["sessions"] = Object.values(state.sessions)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((session) => [
      session.id,
      session.title ?? null,
      session.parentID ?? null,
      session.projectID ?? null,
      session.directory ?? null,
      session.time?.created ?? null,
      session.time?.updated ?? null,
    ]);

  const projects: PersistedAnalyticsStateV3["projects"] = Object.values(state.projects)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((project) => [
      project.id,
      project.name ?? null,
      [...project.directories],
      [...project.worktrees],
    ]);

  return {
    version: ANALYTICS_SNAPSHOT_VERSION,
    schema: ANALYTICS_SNAPSHOT_SCHEMA,
    savedAtMs,
    frontierAtMs: state.frontierAtMs,
    sourceCursorAtMs: state.sourceCursorAtMs ?? null,
    lastFullRepairAtMs: state.lastFullRepairAtMs ?? null,
    sourceIdentity: state.sourceIdentity ? identityToTuple(state.sourceIdentity) : null,
    extent:
      state.extent === undefined
        ? null
        : { sinceMs: state.extent.sinceMs ?? null, untilMs: state.extent.untilMs },
    fingerprints: state.fingerprints,
    occurrences,
    sessions,
    projects,
    // The warm presentation cache lives in its own small sidecar so the big
    // index can load lazily after the first useful view.
    presentation: null,
  };
}

function identityToTuple(identity: OpenCodeSourceIdentity): SourceIdentityTuple {
  return [
    identity.dbPath,
    identity.exists,
    identity.status,
    identity.realPath ?? null,
    identity.device ?? null,
    identity.inode ?? null,
    identity.birthtimeMs ?? null,
    identity.schemaToken ?? null,
  ];
}

function identityFromTuple(tuple: SourceIdentityTuple): OpenCodeSourceIdentity {
  const identity: OpenCodeSourceIdentity = {
    dbPath: tuple[0],
    exists: tuple[1],
    status: tuple[2],
  };
  if (tuple[3] !== null) identity.realPath = tuple[3];
  if (tuple[4] !== null) identity.device = tuple[4];
  if (tuple[5] !== null) identity.inode = tuple[5];
  if (tuple[6] !== null) identity.birthtimeMs = tuple[6];
  if (tuple[7] !== null) identity.schemaToken = tuple[7];
  return identity;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isCompactFingerprint(value: unknown): value is CompactFingerprint {
  if (!Array.isArray(value) || value.length !== 10) return false;
  if (!isFiniteNumber(value[0]) || !isFiniteNumber(value[1])) return false;
  if (!isStringOrNull(value[2]) || !isStringOrNull(value[3])) return false;
  for (let index = 4; index <= 8; index += 1) {
    if (!isFiniteNumber(value[index])) return false;
  }
  return value[9] === null || isFiniteNumber(value[9]);
}

function isOccurrenceTuple(value: unknown, fingerprintCount: number): boolean {
  if (!Array.isArray(value) || value.length !== 4) return false;
  if (!Number.isInteger(value[0]) || value[0] < 0 || value[0] >= fingerprintCount) return false;
  return (
    typeof value[1] === "string" &&
    value[1].length > 0 &&
    typeof value[2] === "string" &&
    value[2].length > 0 &&
    (value[3] === null || isFiniteNumber(value[3]))
  );
}

function isCompactSession(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 7) return false;
  if (typeof value[0] !== "string" || value[0].length === 0) return false;
  if (!isStringOrNull(value[1]) || !isStringOrNull(value[2])) return false;
  if (!isStringOrNull(value[3]) || !isStringOrNull(value[4])) return false;
  return (
    (value[5] === null || isFiniteNumber(value[5])) &&
    (value[6] === null || isFiniteNumber(value[6]))
  );
}

function isCompactProject(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 4) return false;
  return (
    typeof value[0] === "string" &&
    value[0].length > 0 &&
    isStringOrNull(value[1]) &&
    isStringArray(value[2]) &&
    isStringArray(value[3])
  );
}

function isSourceIdentityTuple(value: unknown): value is SourceIdentityTuple {
  if (!Array.isArray(value) || value.length !== 8) return false;
  if (typeof value[0] !== "string" || typeof value[1] !== "boolean") return false;
  if (value[2] !== "ok" && value[2] !== "missing" && value[2] !== "unreadable") return false;
  for (let index = 3; index <= 5; index += 1) {
    if (!isStringOrNull(value[index])) return false;
  }
  if (value[6] !== null && !isFiniteNumber(value[6])) return false;
  return isStringOrNull(value[7]);
}

function isPresentation(value: unknown): value is PersistedAnalyticsStateV3["presentation"] {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const home = record.home;
  if (home !== null && typeof home !== "object") return false;
  if (home) {
    for (const [range, snapshot] of Object.entries(home as Record<string, unknown>)) {
      if (!isRangeKey(range)) return false;
      if (typeof snapshot !== "object" || snapshot === null) return false;
      const candidate = snapshot as Record<string, unknown>;
      if (!Array.isArray(candidate.projects)) return false;
      if (typeof candidate.usage !== "object" || candidate.usage === null) return false;
    }
  }
  const project = record.project;
  if (!Array.isArray(project)) return false;
  for (const entry of project) {
    if (!Array.isArray(entry) || entry.length !== 3) return false;
    if (typeof entry[0] !== "string" || !isRangeKey(entry[1])) return false;
    if (typeof entry[2] !== "object" || entry[2] === null) return false;
    const snapshot = entry[2] as Record<string, unknown>;
    if (!Array.isArray(snapshot.roots)) return false;
    if (typeof snapshot.usage !== "object" || snapshot.usage === null) return false;
  }
  return true;
}

/** Parse and validate a persisted snapshot; any mismatch returns `undefined`. */
export function decodeAnalyticsState(value: unknown): AnalyticsState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== ANALYTICS_SNAPSHOT_VERSION) return undefined;
  if (record.schema !== ANALYTICS_SNAPSHOT_SCHEMA) return undefined;
  if (!isFiniteNumber(record.frontierAtMs)) return undefined;
  if (!isFiniteNumber(record.savedAtMs)) return undefined;

  // Additive fields. A missing value is the safe legacy state: it forces a full
  // source baseline instead of guessing a cursor from wall/cached timestamps.
  const cursorValue = record.sourceCursorAtMs;
  if (cursorValue !== undefined && cursorValue !== null && !isFiniteNumber(cursorValue)) {
    return undefined;
  }
  const repairValue = record.lastFullRepairAtMs;
  if (repairValue !== undefined && repairValue !== null && !isFiniteNumber(repairValue)) {
    return undefined;
  }

  const identityValue = record.sourceIdentity;
  if (
    identityValue !== null &&
    identityValue !== undefined &&
    !isSourceIdentityTuple(identityValue)
  ) {
    return undefined;
  }

  const coverageValue = record.extent;
  let extent: AnalyticsCoverage | undefined;
  if (coverageValue !== null && coverageValue !== undefined) {
    if (typeof coverageValue !== "object" || coverageValue === null) return undefined;
    const coverageRecord = coverageValue as Record<string, unknown>;
    const sinceMs = coverageRecord.sinceMs;
    const untilMs = coverageRecord.untilMs;
    if (!isFiniteNumber(untilMs)) return undefined;
    if (sinceMs !== null && !isFiniteNumber(sinceMs)) return undefined;
    if (typeof sinceMs === "number" && sinceMs > untilMs) return undefined;
    extent = sinceMs === null ? { untilMs } : { sinceMs, untilMs };
  }

  const sessionsValue = record.sessions;
  const projectsValue = record.projects;
  const fingerprintsValue = record.fingerprints;
  const occurrencesValue = record.occurrences;
  if (!Array.isArray(sessionsValue) || !sessionsValue.every(isCompactSession)) return undefined;
  if (!Array.isArray(projectsValue) || !projectsValue.every(isCompactProject)) return undefined;
  if (!Array.isArray(fingerprintsValue) || !fingerprintsValue.every(isCompactFingerprint)) {
    return undefined;
  }
  if (
    !Array.isArray(occurrencesValue) ||
    !occurrencesValue.every((entry) => isOccurrenceTuple(entry, fingerprintsValue.length))
  ) {
    return undefined;
  }
  if (!isPresentation(record.presentation)) return undefined;

  const sessions: Record<string, OpenCodeSessionInfo> = {};
  for (const session of sessionsValue as PersistedAnalyticsStateV3["sessions"]) {
    const info: OpenCodeSessionInfo = { id: session[0] };
    if (session[1] !== null) info.title = session[1];
    if (session[2] !== null) info.parentID = session[2];
    if (session[3] !== null) info.projectID = session[3];
    if (session[4] !== null) info.directory = session[4];
    if (session[5] !== null || session[6] !== null) {
      info.time = {
        ...(session[5] === null ? {} : { created: session[5] }),
        ...(session[6] === null ? {} : { updated: session[6] }),
      };
    }
    sessions[info.id] = info;
  }

  const projects: Record<string, OpenCodeProjectInfo> = {};
  for (const project of projectsValue as PersistedAnalyticsStateV3["projects"]) {
    const info: OpenCodeProjectInfo = {
      id: project[0],
      directories: [...project[2]],
      worktrees: [...project[3]],
    };
    if (project[1] !== null) info.name = project[1];
    projects[info.id] = info;
  }

  const fingerprints = fingerprintsValue as CompactFingerprint[];
  const fingerprintIndex = new Map<string, number>();
  for (let index = 0; index < fingerprints.length; index += 1) {
    const fingerprint = fingerprints[index];
    if (!fingerprint) return undefined;
    const key = rawAssistantRowFingerprint(
      rowFromFingerprint(fingerprint, { sessionID: "decoded", messageID: "decoded" }),
    );
    fingerprintIndex.set(key, index);
  }

  const occurrences = new Map<string, Occurrence>();
  for (const tuple of occurrencesValue as PersistedAnalyticsStateV3["occurrences"]) {
    const key = tuple[2];
    if (occurrences.has(key)) return undefined;
    occurrences.set(key, {
      fingerprintIndex: tuple[0],
      sessionID: tuple[1],
      messageID: tuple[2],
      updatedAtMs: tuple[3],
    });
  }

  const persistedPresentation = record.presentation as
    | PersistedAnalyticsStateV3["presentation"]
    | undefined;

  return {
    sessions,
    projects,
    fingerprints,
    fingerprintIndex,
    occurrences,
    ...(extent ? { extent } : {}),
    ...(identityValue === null || identityValue === undefined
      ? {}
      : { sourceIdentity: identityFromTuple(identityValue) }),
    frontierAtMs: record.frontierAtMs,
    ...(typeof cursorValue === "number" ? { sourceCursorAtMs: cursorValue } : {}),
    ...(typeof repairValue === "number" ? { lastFullRepairAtMs: repairValue } : {}),
    ...(persistedPresentation
      ? {
          presentation: {
            home: persistedPresentation.home,
            project: persistedPresentation.project.map(
              ([projectId, range, snapshot]) =>
                [projectId, range, snapshot] as [string, RangeKey, ProjectSnapshot],
            ),
          },
        }
      : {}),
  };
}

export function defaultAnalyticsSnapshotPath(): string {
  return join(getOpencodeRuntimeDirs().stateDir, "opencode-quota-gui", "analytics-v3.json");
}

export function defaultAnalyticsPresentationPath(snapshotPath: string): string {
  return `${snapshotPath}.presentation.json`;
}

interface PersistedPresentationFile {
  version: typeof ANALYTICS_SNAPSHOT_VERSION;
  savedAtMs: number;
  sourceIdentity: SourceIdentityTuple | null;
  presentation: {
    home: Partial<Record<RangeKey, HomeSnapshot>>;
    project: Array<[projectId: string, range: RangeKey, snapshot: ProjectSnapshot]>;
  } | null;
}

export function encodeAnalyticsPresentation(
  state: AnalyticsState,
  savedAtMs: number,
): PersistedPresentationFile {
  return {
    version: ANALYTICS_SNAPSHOT_VERSION,
    savedAtMs,
    sourceIdentity: state.sourceIdentity ? identityToTuple(state.sourceIdentity) : null,
    presentation: state.presentation
      ? {
          home: state.presentation.home,
          project: state.presentation.project.map(
            ([projectId, range, snapshot]) =>
              [projectId, range, snapshot] as [string, RangeKey, ProjectSnapshot],
          ),
        }
      : null,
  };
}

export function decodeAnalyticsPresentation(value: unknown): WarmAnalyticsPresentation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== ANALYTICS_SNAPSHOT_VERSION) return undefined;
  if (!isFiniteNumber(record.savedAtMs)) return undefined;
  const identityValue = record.sourceIdentity;
  // Absent/null token is a readable legacy sidecar but cannot be verified.
  if (
    identityValue !== undefined &&
    identityValue !== null &&
    !isSourceIdentityTuple(identityValue)
  ) {
    return undefined;
  }
  if (!isPresentation(record.presentation)) return undefined;
  const presentation = record.presentation;
  if (!presentation) return undefined;
  return {
    home: presentation.home,
    project: presentation.project.map(
      ([projectId, range, snapshot]) =>
        [projectId, range, snapshot] as [string, RangeKey, ProjectSnapshot],
    ),
    sourceIdentity:
      identityValue === undefined || identityValue === null
        ? undefined
        : identityFromTuple(identityValue),
  };
}

/** Atomically replace the small warm presentation sidecar. */
export async function saveAnalyticsPresentation(
  path: string,
  state: AnalyticsState,
  savedAtMs: number,
  hooks: AtomicSaveHooks = {},
): Promise<boolean> {
  let payload: string;
  try {
    // Capture the generation before the first await so queued writes cannot
    // encode a newer state under an older generation's completion.
    payload = JSON.stringify(encodeAnalyticsPresentation(state, savedAtMs));
  } catch {
    return false;
  }
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hooks.beforeRename) await hooks.beforeRename();
    await rename(temporary, path);
    return true;
  } catch {
    try {
      if (existsSync(temporary)) await unlink(temporary);
    } catch {
      // Best effort: a stale temp file never becomes the live sidecar.
    }
    return false;
  }
}

export async function loadAnalyticsPresentation(
  path: string,
): Promise<WarmAnalyticsPresentation | undefined> {
  try {
    if (!existsSync(path)) return undefined;
    const text = await readFile(path, "utf8");
    return decodeAnalyticsPresentation(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export interface AtomicSaveHooks {
  /** Test seam: runs after the temp file is durable and before the rename. */
  beforeRename?: () => void | Promise<void>;
}

/** Atomically replace the snapshot; a crash leaves the previous file intact. */
export async function saveAnalyticsSnapshot(
  path: string,
  state: AnalyticsState,
  savedAtMs: number,
  hooks: AtomicSaveHooks = {},
): Promise<boolean> {
  let payload: string;
  try {
    payload = JSON.stringify(encodeAnalyticsState(state, savedAtMs));
  } catch {
    return false;
  }
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(temporary, "w");
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (hooks.beforeRename) await hooks.beforeRename();
    await rename(temporary, path);
    return true;
  } catch {
    try {
      if (existsSync(temporary)) await unlink(temporary);
    } catch {
      // Best effort: a stale temp file never becomes the live snapshot.
    }
    return false;
  }
}

/** Load a snapshot; missing, corrupt, or unsupported files are ignored. */
export async function loadAnalyticsSnapshot(path: string): Promise<AnalyticsState | undefined> {
  try {
    if (!existsSync(path)) return undefined;
    const text = await readFile(path, "utf8");
    return decodeAnalyticsState(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}
