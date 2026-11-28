/**
 * Plugin-owned SQLite persistence for the recoverable Analytics index and its
 * warm presentation cache (`analytics.sqlite`, separate from the irreplaceable
 * `usage-history.sqlite`).
 *
 * The in-memory model and every certification rule stay in the engine; this
 * module only replaces how `AnalyticsState` and the warm sidecar are stored:
 *
 * - One row per physical occurrence with its contribution columns inline.
 *   Fingerprint indexes are process-local interning order and are never
 *   persisted; loading re-interns them exactly like the engine does at runtime.
 *   Repeated strings (session, provider, model, effort) go through an
 *   append-only dictionary so a load shares one string per distinct value.
 * - Writes are incremental: only occurrences the engine marked since the last
 *   durable write are upserted or deleted, inside one `BEGIN IMMEDIATE`
 *   transaction with the scalar cursor/coverage fields. A whole-file rewrite
 *   per refresh is gone.
 * - Writers are fenced by `(epoch, revision)`. A process may write a delta only
 *   on top of the exact revision it loaded or last wrote; otherwise it rewrites
 *   its whole index, which is the JSON file's last-writer-wins semantics. Two
 *   processes can therefore never interleave rows under one cursor.
 * - Occurrence rows keep the in-memory `Map` order (`ord` rowid), so a reload
 *   hydrates the model in the same order the JSON file did.
 *
 * The legacy `analytics-v3.json` (+ sidecar) is migrated once when valid and
 * removed only after the SQLite copy has committed and been read back.
 * Everything here is recoverable: a corrupt or unsupported database is rebuilt
 * from OpenCode history, never repaired by guessing.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  openOpenCodeSqliteWritable,
  type PreparedSqliteStatement,
  type WritableSqliteConn,
} from "../lib/opencode-sqlite.js";
import type { OpenCodeProjectInfo, OpenCodeSessionInfo } from "../lib/opencode-storage.js";
import {
  ANALYTICS_SNAPSHOT_VERSION,
  type AnalyticsState,
  type CompactFingerprint,
  decodeAnalyticsPresentation,
  defaultAnalyticsPresentationPath,
  encodeAnalyticsPresentation,
  fingerprintOf,
  identityFromTuple,
  identityToTuple,
  isSourceIdentityTuple,
  loadAnalyticsSnapshot,
  type Occurrence,
  type PersistedPresentationFile,
  PRESENTATION_MAX_SIDECAR_BYTES,
  removeLegacyAnalyticsFiles,
  rowFromFingerprint,
  sessionColumns,
  type WarmAnalyticsPresentation,
} from "./analytics-state.js";

/** Bumped for any table change; an older file is dropped and rebuilt. */
const ANALYTICS_STORE_SCHEMA_VERSION = 1;
const ANALYTICS_STORE_FILENAME = "analytics.sqlite";
/** The worker thread may wait this long behind another process's write. */
const ANALYTICS_STORE_BUSY_TIMEOUT_MS = 3_000;
/** WAL is truncated back to this size after checkpoints (bulk writes grow it). */
const ANALYTICS_STORE_JOURNAL_LIMIT_BYTES = 8 * 1024 * 1024;
/**
 * A load hands the worker's event loop back after this much work, so warm
 * cached responses are not queued behind one long synchronous scan. It is
 * time-based: every turn of Bun's event loop has a fixed cost on a large
 * heap, so a row-count cadence slowed big loads by more than half.
 */
const ANALYTICS_STORE_LOAD_SLICE_MS = 50;
const ANALYTICS_STORE_LOAD_CLOCK_ROWS = 1_024;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Occurrence changes since the last durable index write. The engine marks
 * every mutation; the store takes the batch synchronously inside its write
 * transaction so no later change can be certified by an earlier cursor.
 */
interface AnalyticsDeltaBatch {
  /** The whole index must be rewritten (source replacement or first write). */
  full: boolean;
  /** Message ids upserted or removed, in first-change order. */
  dirty: Set<string>;
  /** Message ids removed at least once (a re-added id moves to the end). */
  removed: Set<string>;
}

export interface AnalyticsPersistDelta {
  markChanged(messageId: string): void;
  markRemoved(messageId: string): void;
  markReplaced(): void;
  /** Forget pending changes: the in-memory state was just loaded from disk. */
  reset(): void;
  take(): AnalyticsDeltaBatch;
  /** Return a batch whose write failed; newer marks stay after it. */
  restore(batch: AnalyticsDeltaBatch): void;
}

export function createAnalyticsPersistDelta(): AnalyticsPersistDelta {
  let full = false;
  let dirty = new Set<string>();
  let removed = new Set<string>();
  return {
    markChanged(messageId) {
      if (full) return;
      // A removed id that comes back is appended to the in-memory Map, so its
      // row must move to the end as well: re-mark it after every newer id.
      if (removed.has(messageId)) dirty.delete(messageId);
      dirty.add(messageId);
    },
    markRemoved(messageId) {
      if (full) return;
      dirty.add(messageId);
      removed.add(messageId);
    },
    markReplaced() {
      full = true;
      dirty = new Set();
      removed = new Set();
    },
    reset() {
      full = false;
      dirty = new Set();
      removed = new Set();
    },
    take() {
      const batch = { full, dirty, removed };
      full = false;
      dirty = new Set();
      removed = new Set();
      return batch;
    },
    restore(batch) {
      if (batch.full || full) {
        full = true;
        dirty = new Set();
        removed = new Set();
        return;
      }
      for (const id of batch.removed) removed.add(id);
      const merged = new Set(batch.dirty);
      for (const id of dirty) {
        // Removed in either batch and marked again: it now sits last in the Map.
        if (removed.has(id)) merged.delete(id);
        merged.add(id);
      }
      dirty = merged;
    },
  };
}

interface AnalyticsStoreWriteMetrics {
  /** Occurrence rows inserted/updated/deleted by the last committed write. */
  rows: number;
  full: boolean;
}

export interface AnalyticsStore {
  readonly path: string;
  loadSnapshot(): Promise<AnalyticsState | undefined>;
  saveSnapshot(
    state: AnalyticsState,
    savedAtMs: number,
    delta?: AnalyticsPersistDelta,
  ): Promise<boolean>;
  loadPresentation(): Promise<WarmAnalyticsPresentation | undefined>;
  savePresentation(state: AnalyticsState, savedAtMs: number): Promise<boolean>;
  /** Diagnostics only: the last committed index write. */
  lastWrite(): AnalyticsStoreWriteMetrics | undefined;
  close(): void;
}

/** `<dir>/analytics.sqlite` beside the legacy `analytics-v3.json`; else `<path>.sqlite`. */
export function analyticsStorePathFor(snapshotPath: string): string {
  return basename(snapshotPath) === "analytics-v3.json"
    ? join(dirname(snapshotPath), ANALYTICS_STORE_FILENAME)
    : `${snapshotPath}.sqlite`;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS analytics_str (
    id INTEGER PRIMARY KEY,
    value TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS analytics_occurrence (
    ord INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL UNIQUE,
    session_ref INTEGER NOT NULL,
    updated_at INTEGER,
    variant_ref INTEGER,
    created_at INTEGER NOT NULL,
    completed_at INTEGER NOT NULL,
    provider_ref INTEGER,
    model_ref INTEGER,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    reasoning INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL,
    cost REAL,
    cache_missing INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS analytics_session (
    id TEXT PRIMARY KEY,
    title TEXT,
    parent_id TEXT,
    project_id TEXT,
    directory TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    agent TEXT
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS analytics_project (
    id TEXT PRIMARY KEY,
    name TEXT,
    directories TEXT NOT NULL,
    worktrees TEXT NOT NULL
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS analytics_presentation (
    slot TEXT PRIMARY KEY,
    ord INTEGER NOT NULL,
    hash TEXT NOT NULL,
    payload TEXT NOT NULL
  ) WITHOUT ROWID;
`;

const TABLES = [
  "analytics_str",
  "analytics_occurrence",
  "analytics_session",
  "analytics_project",
  "analytics_presentation",
] as const;

class StoreUnsupportedError extends Error {
  constructor() {
    super("analytics-store-unsupported");
  }
}

/** SQLITE_CORRUPT (11) / SQLITE_NOTADB (26) on either runtime's error shape. */
function isCorruptionError(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const record = error as { errcode?: unknown; code?: unknown; message?: unknown };
  if (record.errcode === 11 || record.errcode === 26) return true;
  if (record.code === "SQLITE_CORRUPT" || record.code === "SQLITE_NOTADB") return true;
  const message = typeof record.message === "string" ? record.message : "";
  return /malformed|not a database|file is encrypted|database disk image/iu.test(message);
}

function rollback(conn: WritableSqliteConn): void {
  try {
    conn.exec("ROLLBACK");
  } catch {
    // The original failure is the one that matters.
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha1(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

interface OccurrenceRow {
  ord: number;
  message_id: string;
  session_ref: number;
  updated_at: number | null;
  variant_ref: number | null;
  created_at: number;
  completed_at: number;
  provider_ref: number | null;
  model_ref: number | null;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost: number | null;
  cache_missing: number;
}

interface Statements {
  getMeta: PreparedSqliteStatement;
  setMeta: PreparedSqliteStatement;
  deleteMeta: PreparedSqliteStatement;
  findStr: PreparedSqliteStatement;
  insertStr: PreparedSqliteStatement;
  upsertOccurrence: PreparedSqliteStatement;
  insertOccurrence: PreparedSqliteStatement;
  deleteOccurrence: PreparedSqliteStatement;
  loadOccurrences: PreparedSqliteStatement;
  upsertSession: PreparedSqliteStatement;
  deleteSession: PreparedSqliteStatement;
  upsertProject: PreparedSqliteStatement;
  deleteProject: PreparedSqliteStatement;
}

function prepareStatements(conn: WritableSqliteConn): Statements {
  const occurrenceColumns =
    "message_id, session_ref, updated_at, variant_ref, created_at, completed_at, provider_ref, model_ref, input, output, reasoning, cache_read, cache_write, cost, cache_missing";
  const occurrenceValues = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?";
  return {
    getMeta: conn.prepare("SELECT value FROM analytics_meta WHERE key = ?"),
    setMeta: conn.prepare(
      "INSERT INTO analytics_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    deleteMeta: conn.prepare("DELETE FROM analytics_meta WHERE key = ?"),
    findStr: conn.prepare("SELECT id FROM analytics_str WHERE value = ?"),
    insertStr: conn.prepare("INSERT INTO analytics_str (value) VALUES (?)"),
    // An existing row keeps its `ord`: an in-place Map update keeps its order.
    upsertOccurrence: conn.prepare(
      `INSERT INTO analytics_occurrence (${occurrenceColumns}) VALUES (${occurrenceValues})
       ON CONFLICT(message_id) DO UPDATE SET
         session_ref = excluded.session_ref, updated_at = excluded.updated_at,
         variant_ref = excluded.variant_ref, created_at = excluded.created_at,
         completed_at = excluded.completed_at, provider_ref = excluded.provider_ref,
         model_ref = excluded.model_ref, input = excluded.input, output = excluded.output,
         reasoning = excluded.reasoning, cache_read = excluded.cache_read,
         cache_write = excluded.cache_write, cost = excluded.cost,
         cache_missing = excluded.cache_missing`,
    ),
    insertOccurrence: conn.prepare(
      `INSERT INTO analytics_occurrence (${occurrenceColumns}) VALUES (${occurrenceValues})`,
    ),
    deleteOccurrence: conn.prepare("DELETE FROM analytics_occurrence WHERE message_id = ?"),
    loadOccurrences: conn.prepare("SELECT * FROM analytics_occurrence ORDER BY ord"),
    // Unchanged metadata rows are skipped so a refresh does not rewrite pages.
    upsertSession: conn.prepare(
      `INSERT INTO analytics_session (id, title, parent_id, project_id, directory, created_at, updated_at, agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, parent_id = excluded.parent_id, project_id = excluded.project_id,
         directory = excluded.directory, created_at = excluded.created_at,
         updated_at = excluded.updated_at, agent = excluded.agent
       WHERE title IS NOT excluded.title OR parent_id IS NOT excluded.parent_id
         OR project_id IS NOT excluded.project_id OR directory IS NOT excluded.directory
         OR created_at IS NOT excluded.created_at OR updated_at IS NOT excluded.updated_at
         OR agent IS NOT excluded.agent`,
    ),
    deleteSession: conn.prepare("DELETE FROM analytics_session WHERE id = ?"),
    upsertProject: conn.prepare(
      `INSERT INTO analytics_project (id, name, directories, worktrees) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, directories = excluded.directories, worktrees = excluded.worktrees
       WHERE name IS NOT excluded.name OR directories IS NOT excluded.directories
         OR worktrees IS NOT excluded.worktrees`,
    ),
    deleteProject: conn.prepare("DELETE FROM analytics_project WHERE id = ?"),
  };
}

interface OpenStore {
  conn: WritableSqliteConn;
  statements: Statements;
  /** Dictionary cache; valid while `epoch` is unchanged (rows are never deleted). */
  strIds: Map<string, number>;
  strValues: Map<number, string>;
  epoch: string;
}

function newEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readCurrentSchema(conn: WritableSqliteConn): { version: number; epoch?: string } {
  const exists = conn.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'analytics_meta'",
  );
  if (exists === null) return { version: 0 };
  const versionRow = conn.get<{ value: string }>(
    "SELECT value FROM analytics_meta WHERE key = 'schema_version'",
  );
  const epochRow = conn.get<{ value: string }>(
    "SELECT value FROM analytics_meta WHERE key = 'store.epoch'",
  );
  const version = versionRow === null ? 0 : Number(versionRow.value);
  return {
    version: Number.isInteger(version) ? version : 0,
    ...(epochRow === null ? {} : { epoch: epochRow.value }),
  };
}

/**
 * Create or replace the schema; an older table layout never survives. The
 * common warm open is read-only: the write lock is taken only to create.
 */
function initializeSchema(conn: WritableSqliteConn): string {
  const observed = readCurrentSchema(conn);
  if (observed.version > ANALYTICS_STORE_SCHEMA_VERSION) {
    // A newer plugin owns this layout. It is recoverable, but rebuilding it
    // here would make two installed versions destroy each other's cache.
    throw new StoreUnsupportedError();
  }
  if (observed.version === ANALYTICS_STORE_SCHEMA_VERSION && observed.epoch !== undefined) {
    return observed.epoch;
  }
  conn.exec("BEGIN IMMEDIATE");
  try {
    conn.exec(
      "CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
    );
    // Re-read under the lock: another process may have just created it.
    const current = readCurrentSchema(conn);
    if (current.version > ANALYTICS_STORE_SCHEMA_VERSION) throw new StoreUnsupportedError();
    let epoch = current.epoch;
    if (current.version !== ANALYTICS_STORE_SCHEMA_VERSION || epoch === undefined) {
      for (const table of TABLES) conn.exec(`DROP TABLE IF EXISTS ${table}`);
      conn.exec("DELETE FROM analytics_meta");
      conn.exec(SCHEMA);
      epoch = newEpoch();
      conn.run("INSERT INTO analytics_meta (key, value) VALUES ('schema_version', ?)", [
        String(ANALYTICS_STORE_SCHEMA_VERSION),
      ]);
      conn.run("INSERT INTO analytics_meta (key, value) VALUES ('store.epoch', ?)", [epoch]);
      conn.run("INSERT INTO analytics_meta (key, value) VALUES ('store.revision', '0')");
    }
    conn.exec("COMMIT");
    return epoch;
  } catch (error) {
    rollback(conn);
    throw error;
  }
}

async function removeDatabaseFiles(path: string): Promise<boolean> {
  let ok = true;
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    try {
      if (existsSync(candidate)) await unlink(candidate);
    } catch {
      ok = false;
    }
  }
  return ok;
}

export interface AnalyticsStoreOptions {
  /** Legacy JSON index (migration source); `<dir>/analytics.sqlite` is derived from it. */
  snapshotPath: string;
  /** Override of the derived database path (tests). */
  databasePath?: string;
}

export function createAnalyticsStore(options: AnalyticsStoreOptions): AnalyticsStore {
  const snapshotPath = options.snapshotPath;
  const path = options.databasePath ?? analyticsStorePathFor(snapshotPath);
  const legacyPresentationPath = defaultAnalyticsPresentationPath(snapshotPath);
  let open: OpenStore | undefined;
  let opening: Promise<OpenStore | undefined> | undefined;
  /** A newer schema owns the file: persist nothing, never rebuild it. */
  let unsupported = false;
  /** `(epoch, revision)` this process's in-memory index was loaded from or last wrote. */
  let known: { epoch: string; revision: number } | undefined;
  let lastWrite: AnalyticsStoreWriteMetrics | undefined;
  let legacyCleanupDone = false;
  let closed = false;
  /** Every operation shares one connection and runs alone, in call order. */
  let queue: Promise<unknown> = Promise.resolve();
  let running = false;

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      running = true;
      try {
        return await operation();
      } finally {
        running = false;
        // A close() that arrived mid-operation is completed here.
        if (closed) closeHandle();
      }
    };
    const result = queue.then(run, run);
    queue = result.catch(() => undefined);
    return result;
  }

  function closeHandle(): void {
    const handle = open;
    open = undefined;
    handle?.conn.close();
  }

  async function openOnce(): Promise<OpenStore | undefined> {
    if (closed || unsupported) return undefined;
    if (open) return open;
    if (opening) return opening;
    opening = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let conn: WritableSqliteConn | undefined;
        try {
          conn = await openOpenCodeSqliteWritable(path, {
            busyTimeoutMs: ANALYTICS_STORE_BUSY_TIMEOUT_MS,
          });
          conn.exec(`PRAGMA journal_size_limit = ${ANALYTICS_STORE_JOURNAL_LIMIT_BYTES}`);
          // Random `message_id` index updates overflow the default page cache
          // in a large write; each spill rewrites pages to the WAL again (a
          // 1M-row upsert measured ~2.8 GB written instead of ~150 MB). Dirty
          // pages are held until COMMIT instead, so transient memory is bounded
          // by the pages the transaction changes.
          conn.exec("PRAGMA cache_spill = OFF");
          const epoch = initializeSchema(conn);
          const handle: OpenStore = {
            conn,
            statements: prepareStatements(conn),
            strIds: new Map(),
            strValues: new Map(),
            epoch,
          };
          open = handle;
          return handle;
        } catch (error) {
          conn?.close();
          if (error instanceof StoreUnsupportedError) {
            unsupported = true;
            return undefined;
          }
          // Recoverable data: a corrupt file is replaced, never repaired. The
          // removal only ever targets this database and its journals.
          if (attempt === 0 && isCorruptionError(error) && (await removeDatabaseFiles(path))) {
            continue;
          }
          return undefined;
        }
      }
      return undefined;
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }

  /** Drop a handle whose file turned out corrupt mid-use; the next call rebuilds. */
  async function discardIfCorrupt(error: unknown): Promise<void> {
    if (!isCorruptionError(error)) return;
    const handle = open;
    open = undefined;
    known = undefined;
    handle?.conn.close();
    await removeDatabaseFiles(path);
  }

  function readMeta(handle: OpenStore, key: string): string | undefined {
    const row = handle.statements.getMeta.get<{ value: string }>([key]);
    return row === null ? undefined : row.value;
  }

  function writeMeta(handle: OpenStore, key: string, value: string | null): void {
    if (value === null) handle.statements.deleteMeta.run([key]);
    else handle.statements.setMeta.run([key, value]);
  }

  function readRevision(handle: OpenStore): { epoch: string; revision: number } {
    const epoch = readMeta(handle, "store.epoch") ?? "";
    const revision = Number(readMeta(handle, "store.revision") ?? "0");
    return { epoch, revision: Number.isInteger(revision) ? revision : 0 };
  }

  function strId(handle: OpenStore, value: string | null | undefined): number | null {
    if (value === undefined || value === null) return null;
    const cached = handle.strIds.get(value);
    if (cached !== undefined) return cached;
    let id = handle.statements.findStr.get<{ id: number }>([value])?.id;
    if (id === undefined) {
      handle.statements.insertStr.run([value]);
      id = handle.statements.findStr.get<{ id: number }>([value])?.id;
    }
    if (id === undefined) throw new Error("analytics-store-dictionary");
    handle.strIds.set(value, id);
    handle.strValues.set(id, value);
    return id;
  }

  function occurrenceParams(
    handle: OpenStore,
    occurrence: Occurrence,
    fingerprint: CompactFingerprint,
  ): unknown[] {
    return [
      occurrence.messageID,
      strId(handle, occurrence.sessionID),
      occurrence.updatedAtMs,
      strId(handle, occurrence.variant),
      fingerprint[0],
      fingerprint[1],
      strId(handle, fingerprint[2]),
      strId(handle, fingerprint[3]),
      fingerprint[4],
      fingerprint[5],
      fingerprint[6],
      fingerprint[7],
      fingerprint[8],
      fingerprint[9],
      fingerprint[10],
    ];
  }

  function writeMetadata(handle: OpenStore, state: AnalyticsState, full: boolean): void {
    const { conn, statements } = handle;
    const sessionIds = new Set(Object.keys(state.sessions));
    if (!full) {
      for (const row of conn.all<{ id: string }>("SELECT id FROM analytics_session")) {
        if (!sessionIds.has(row.id)) statements.deleteSession.run([row.id]);
      }
    }
    for (const session of Object.values(state.sessions)) {
      statements.upsertSession.run(sessionColumns(session));
    }
    const projectIds = new Set(Object.keys(state.projects));
    if (!full) {
      for (const row of conn.all<{ id: string }>("SELECT id FROM analytics_project")) {
        if (!projectIds.has(row.id)) statements.deleteProject.run([row.id]);
      }
    }
    for (const project of Object.values(state.projects)) {
      statements.upsertProject.run([
        project.id,
        project.name ?? null,
        JSON.stringify(project.directories),
        JSON.stringify(project.worktrees),
      ]);
    }
  }

  function optionalMeta(value: number | undefined): string | null {
    return value === undefined ? null : String(value);
  }

  function writeIndexMeta(handle: OpenStore, state: AnalyticsState, savedAtMs: number): void {
    writeMeta(handle, "index.version", String(ANALYTICS_SNAPSHOT_VERSION));
    writeMeta(handle, "index.savedAt", String(savedAtMs));
    writeMeta(handle, "index.frontierAt", String(state.frontierAtMs));
    writeMeta(handle, "index.sourceCursorAt", optionalMeta(state.sourceCursorAtMs));
    writeMeta(handle, "index.lastFullRepairAt", optionalMeta(state.lastFullRepairAtMs));
    writeMeta(handle, "index.sourceSignature", state.sourceSignature ?? null);
    writeMeta(handle, "index.futureCompletionAt", optionalMeta(state.futureCompletionAtMs));
    writeMeta(
      handle,
      "index.sourceIdentity",
      state.sourceIdentity ? JSON.stringify(identityToTuple(state.sourceIdentity)) : null,
    );
    writeMeta(
      handle,
      "index.extent",
      state.extent === undefined
        ? null
        : JSON.stringify({ sinceMs: state.extent.sinceMs ?? null, untilMs: state.extent.untilMs }),
    );
    writeMeta(handle, "index.complete", "1");
  }

  /**
   * One index checkpoint. Runs synchronously from the delta take to COMMIT, so
   * the rows and the cursor/coverage fields describe the same in-memory state.
   */
  function writeIndex(
    handle: OpenStore,
    state: AnalyticsState,
    savedAtMs: number,
    delta: AnalyticsPersistDelta | undefined,
  ): boolean {
    const { conn, statements } = handle;
    conn.exec("BEGIN IMMEDIATE");
    const batch = delta?.take() ?? {
      full: true,
      dirty: new Set<string>(),
      removed: new Set<string>(),
    };
    try {
      const current = readRevision(handle);
      if (current.epoch !== handle.epoch) {
        // Another process rebuilt the schema: every cached dictionary id is void.
        handle.epoch = current.epoch;
        handle.strIds.clear();
        handle.strValues.clear();
      }
      const fenced =
        known === undefined ||
        known.epoch !== current.epoch ||
        known.revision !== current.revision ||
        readMeta(handle, "index.complete") !== "1" ||
        readMeta(handle, "index.version") !== String(ANALYTICS_SNAPSHOT_VERSION);
      const full = batch.full || fenced;
      let rows = 0;
      if (full) {
        conn.exec("DELETE FROM analytics_occurrence");
        conn.exec("DELETE FROM analytics_session");
        conn.exec("DELETE FROM analytics_project");
        for (const occurrence of state.occurrences.values()) {
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          if (!fingerprint) throw new Error("analytics-store-fingerprint");
          statements.insertOccurrence.run(occurrenceParams(handle, occurrence, fingerprint));
          rows += 1;
        }
      } else {
        for (const messageId of batch.dirty) {
          const occurrence = state.occurrences.get(messageId);
          if (!occurrence) {
            statements.deleteOccurrence.run([messageId]);
            rows += 1;
            continue;
          }
          const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
          if (!fingerprint) throw new Error("analytics-store-fingerprint");
          const params = occurrenceParams(handle, occurrence, fingerprint);
          if (batch.removed.has(messageId)) {
            statements.deleteOccurrence.run([messageId]);
            statements.insertOccurrence.run(params);
          } else {
            statements.upsertOccurrence.run(params);
          }
          rows += 1;
        }
      }
      writeMetadata(handle, state, full);
      writeIndexMeta(handle, state, savedAtMs);
      const revision = current.revision + 1;
      writeMeta(handle, "store.revision", String(revision));
      conn.exec("COMMIT");
      known = { epoch: current.epoch, revision };
      lastWrite = { rows, full };
      if (full) {
        try {
          conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
          // A reader may hold the WAL; the size limit applies on a later checkpoint.
        }
      }
      return true;
    } catch (error) {
      rollback(conn);
      // Dictionary ids interned inside the rolled-back transaction no longer
      // exist; drop the cache so the retry re-inserts them.
      handle.strIds.clear();
      handle.strValues.clear();
      delta?.restore(batch);
      throw error;
    }
  }

  async function loadIndex(handle: OpenStore): Promise<AnalyticsState | undefined> {
    const { conn } = handle;
    // One read transaction: a concurrent writer can never mix two revisions.
    // It stays open across the load's yields; store operations are serialized,
    // so no write on this connection can start inside it.
    conn.exec("BEGIN");
    try {
      if (readMeta(handle, "index.complete") !== "1") return undefined;
      if (readMeta(handle, "index.version") !== String(ANALYTICS_SNAPSHOT_VERSION))
        return undefined;
      const revision = readRevision(handle);
      const savedAtMs = Number(readMeta(handle, "index.savedAt"));
      const frontierAtMs = Number(readMeta(handle, "index.frontierAt"));
      if (!Number.isFinite(savedAtMs) || !Number.isFinite(frontierAtMs)) return undefined;
      const optionalNumber = (key: string): number | undefined | null => {
        const raw = readMeta(handle, key);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        return Number.isFinite(value) ? value : null;
      };
      const sourceCursorAtMs = optionalNumber("index.sourceCursorAt");
      const lastFullRepairAtMs = optionalNumber("index.lastFullRepairAt");
      const futureCompletionAtMs = optionalNumber("index.futureCompletionAt");
      if (
        sourceCursorAtMs === null ||
        lastFullRepairAtMs === null ||
        futureCompletionAtMs === null
      ) {
        return undefined;
      }
      const sourceSignature = readMeta(handle, "index.sourceSignature");
      if (
        sourceSignature !== undefined &&
        (sourceSignature.length === 0 || sourceSignature.length > 512)
      ) {
        return undefined;
      }
      let sourceIdentity: AnalyticsState["sourceIdentity"];
      const identityRaw = readMeta(handle, "index.sourceIdentity");
      if (identityRaw !== undefined) {
        const tuple = JSON.parse(identityRaw) as unknown;
        if (!isSourceIdentityTuple(tuple)) return undefined;
        sourceIdentity = identityFromTuple(tuple);
      }
      let extent: AnalyticsState["extent"];
      const extentRaw = readMeta(handle, "index.extent");
      if (extentRaw !== undefined) {
        const parsed = JSON.parse(extentRaw) as { sinceMs?: unknown; untilMs?: unknown };
        if (!isFiniteNumber(parsed.untilMs)) return undefined;
        if (parsed.sinceMs !== null && !isFiniteNumber(parsed.sinceMs)) return undefined;
        if (typeof parsed.sinceMs === "number" && parsed.sinceMs > parsed.untilMs) return undefined;
        extent =
          parsed.sinceMs === null
            ? { untilMs: parsed.untilMs }
            : { sinceMs: parsed.sinceMs as number, untilMs: parsed.untilMs };
      }

      for (const row of conn.all<{ id: number; value: string }>(
        "SELECT id, value FROM analytics_str",
      )) {
        handle.strIds.set(row.value, row.id);
        handle.strValues.set(row.id, row.value);
      }
      const str = (id: number | null): string | null | undefined => {
        if (id === null) return null;
        return handle.strValues.get(id);
      };

      const sessions: Record<string, OpenCodeSessionInfo> = {};
      const sessionRows = conn.all<{
        id: string;
        title: string | null;
        parent_id: string | null;
        project_id: string | null;
        directory: string | null;
        created_at: number | null;
        updated_at: number | null;
        agent: string | null;
      }>("SELECT * FROM analytics_session");
      sessionRows.sort((a, b) => compareIds(a.id, b.id));
      for (const row of sessionRows) {
        if (typeof row.id !== "string" || row.id.length === 0) return undefined;
        const info: OpenCodeSessionInfo = { id: row.id };
        if (stringOrNull(row.title) !== null) info.title = row.title as string;
        if (stringOrNull(row.parent_id) !== null) info.parentID = row.parent_id as string;
        if (stringOrNull(row.project_id) !== null) info.projectID = row.project_id as string;
        if (stringOrNull(row.directory) !== null) info.directory = row.directory as string;
        if (typeof row.agent === "string") info.agent = row.agent;
        const created = finiteOrNull(row.created_at);
        const updated = finiteOrNull(row.updated_at);
        if (created !== null || updated !== null) {
          info.time = {
            ...(created === null ? {} : { created }),
            ...(updated === null ? {} : { updated }),
          };
        }
        sessions[info.id] = info;
      }

      const projects: Record<string, OpenCodeProjectInfo> = {};
      const projectRows = conn.all<{
        id: string;
        name: string | null;
        directories: string;
        worktrees: string;
      }>("SELECT * FROM analytics_project");
      projectRows.sort((a, b) => compareIds(a.id, b.id));
      for (const row of projectRows) {
        const directories = JSON.parse(row.directories) as unknown;
        const worktrees = JSON.parse(row.worktrees) as unknown;
        if (
          !Array.isArray(directories) ||
          !directories.every((item) => typeof item === "string") ||
          !Array.isArray(worktrees) ||
          !worktrees.every((item) => typeof item === "string")
        ) {
          return undefined;
        }
        const info: OpenCodeProjectInfo = {
          id: row.id,
          directories: directories as string[],
          worktrees: worktrees as string[],
        };
        if (typeof row.name === "string") info.name = row.name;
        projects[info.id] = info;
      }

      const fingerprints: CompactFingerprint[] = [];
      const fingerprintIndex = new Map<string, number>();
      const occurrences = new Map<string, Occurrence>();
      // Rows are consumed in synchronous time slices; the load yields only
      // between slices, with the read transaction still open.
      const addRow = (row: OccurrenceRow): boolean => {
        const sessionID = str(row.session_ref);
        const provider = str(row.provider_ref);
        const model = str(row.model_ref);
        const variant = str(row.variant_ref);
        if (typeof sessionID !== "string" || sessionID.length === 0) return false;
        if (provider === undefined || model === undefined || variant === undefined) return false;
        if (typeof row.message_id !== "string" || row.message_id.length === 0) return false;
        if (
          !isFiniteNumber(row.created_at) ||
          !isFiniteNumber(row.completed_at) ||
          !isFiniteNumber(row.input) ||
          !isFiniteNumber(row.output) ||
          !isFiniteNumber(row.reasoning) ||
          !isFiniteNumber(row.cache_read) ||
          !isFiniteNumber(row.cache_write) ||
          (row.cost !== null && !isFiniteNumber(row.cost)) ||
          (row.updated_at !== null && !isFiniteNumber(row.updated_at)) ||
          (row.cache_missing !== 0 &&
            row.cache_missing !== 1 &&
            row.cache_missing !== 2 &&
            row.cache_missing !== 3)
        ) {
          return false;
        }
        const tuple: CompactFingerprint = [
          row.created_at,
          row.completed_at,
          provider,
          model,
          row.input,
          row.output,
          row.reasoning,
          row.cache_read,
          row.cache_write,
          row.cost,
          row.cache_missing,
        ];
        // Intern exactly like the engine's runtime `internFingerprint`.
        const key = fingerprintOf(rowFromFingerprint(tuple, { sessionID: "", messageID: "" }));
        let index = fingerprintIndex.get(key);
        if (index === undefined) {
          index = fingerprints.length;
          fingerprints.push(tuple);
          fingerprintIndex.set(key, index);
        }
        if (occurrences.has(row.message_id)) return false;
        occurrences.set(row.message_id, {
          fingerprintIndex: index,
          sessionID,
          messageID: row.message_id,
          updatedAtMs: row.updated_at,
          ...(variant === null ? {} : { variant }),
        });
        return true;
      };
      const rows = handle.statements.loadOccurrences.iterate<OccurrenceRow>();
      const takeChunk = (): "done" | "more" | "invalid" => {
        const sliceEndsAt = performance.now() + ANALYTICS_STORE_LOAD_SLICE_MS;
        for (let taken = 1; ; taken += 1) {
          const next = rows.next();
          if (next.done) return "done";
          if (!addRow(next.value)) return "invalid";
          if (taken % ANALYTICS_STORE_LOAD_CLOCK_ROWS === 0 && performance.now() >= sliceEndsAt) {
            return "more";
          }
        }
      };
      for (;;) {
        const status = takeChunk();
        if (status === "done") break;
        if (status === "invalid") {
          rows.return?.();
          return undefined;
        }
        await yieldToEventLoop();
        if (closed) {
          rows.return?.();
          return undefined;
        }
      }

      const state: AnalyticsState = {
        sessions,
        projects,
        fingerprints,
        fingerprintIndex,
        occurrences,
        ...(extent ? { extent } : {}),
        ...(sourceIdentity ? { sourceIdentity } : {}),
        frontierAtMs,
        savedAtMs,
        ...(sourceCursorAtMs === undefined ? {} : { sourceCursorAtMs }),
        ...(lastFullRepairAtMs === undefined ? {} : { lastFullRepairAtMs }),
      };
      if (sourceSignature !== undefined) state.sourceSignature = sourceSignature;
      if (futureCompletionAtMs !== undefined) state.futureCompletionAtMs = futureCompletionAtMs;
      known = revision;
      return state;
    } finally {
      rollback(conn);
    }
  }

  async function cleanupLegacyOnce(): Promise<void> {
    if (legacyCleanupDone) return;
    legacyCleanupDone = true;
    await removeLegacyAnalyticsFiles(snapshotPath);
  }

  /**
   * One-time import of a valid legacy JSON index. It is removed only after the
   * SQLite copy committed and reads back with the same occurrence count; an
   * invalid/unsupported file cannot be imported and is left for the rebuild.
   */
  async function migrateLegacyIndex(handle: OpenStore): Promise<AnalyticsState | undefined> {
    if (!existsSync(snapshotPath)) return undefined;
    const legacy = await loadAnalyticsSnapshot(snapshotPath);
    if (!legacy) return undefined;
    // Session DTOs never come from the compact file; presentation migrates separately.
    delete legacy.presentation;
    try {
      writeIndex(handle, legacy, legacy.savedAtMs ?? 0, undefined);
      const count = handle.conn.get<{ n: number }>(
        "SELECT count(*) AS n FROM analytics_occurrence",
      )?.n;
      if (count === legacy.occurrences.size) await cleanupLegacyOnce();
    } catch (error) {
      await discardIfCorrupt(error);
      // The decoded legacy state still serves this process; the next
      // checkpoint is a full write because `known` stayed unset.
    }
    return legacy;
  }

  /** Reassemble the legacy sidecar shape; `decodeAnalyticsPresentation` validates it. */
  function readPresentationFile(handle: OpenStore): unknown {
    const header = readMeta(handle, "presentation.header");
    if (header === undefined) return undefined;
    const file = JSON.parse(header) as Record<string, unknown>;
    if (file.presentation === null) return file;
    const home: Record<string, unknown> = {};
    const project: unknown[] = [];
    const session: unknown[] = [];
    for (const row of handle.conn.all<{ slot: string; payload: string }>(
      "SELECT slot, payload FROM analytics_presentation ORDER BY ord",
    )) {
      const payload = JSON.parse(row.payload) as unknown;
      if (row.slot.startsWith("home:")) home[row.slot.slice(5)] = payload;
      else if (row.slot.startsWith("project:")) project.push(payload);
      else if (row.slot.startsWith("session:")) session.push(payload);
      else return undefined;
    }
    return {
      ...file,
      presentation: { home, project, ...(session.length > 0 ? { session } : {}) },
    };
  }

  function writePresentationFile(handle: OpenStore, file: PersistedPresentationFile): void {
    const { conn } = handle;
    const slots: Array<{ slot: string; payload: string }> = [];
    const presentation = file.presentation;
    if (presentation) {
      for (const [range, snapshot] of Object.entries(presentation.home)) {
        if (snapshot) slots.push({ slot: `home:${range}`, payload: JSON.stringify(snapshot) });
      }
      for (const entry of presentation.project) {
        slots.push({
          slot: `project:${entry[0]}\u0000${entry[1]}`,
          payload: JSON.stringify(entry),
        });
      }
      // Session DTOs are the only evictable part: oldest go first so the warm
      // cache stays within the same disk budget as the legacy sidecar.
      const sessions = (presentation.session ?? []).map((entry) => ({
        slot: `session:${entry[0]}`,
        payload: JSON.stringify(entry),
      }));
      let bytes = slots.reduce((sum, slot) => sum + slot.payload.length, 0);
      for (const entry of sessions) bytes += entry.payload.length;
      while (sessions.length > 0 && bytes > PRESENTATION_MAX_SIDECAR_BYTES) {
        bytes -= sessions.shift()?.payload.length ?? 0;
      }
      slots.push(...sessions);
    }
    const header: PersistedPresentationFile = {
      ...file,
      presentation: presentation ? { home: {}, project: [] } : null,
    };
    conn.exec("BEGIN IMMEDIATE");
    try {
      const existing = new Map(
        conn
          .all<{ slot: string; ord: number; hash: string }>(
            "SELECT slot, ord, hash FROM analytics_presentation",
          )
          .map((row) => [row.slot, row]),
      );
      const keep = new Set<string>();
      slots.forEach((entry, ord) => {
        keep.add(entry.slot);
        const hash = sha1(entry.payload);
        const previous = existing.get(entry.slot);
        if (previous && previous.hash === hash) {
          if (previous.ord !== ord) {
            conn.run("UPDATE analytics_presentation SET ord = ? WHERE slot = ?", [ord, entry.slot]);
          }
          return;
        }
        conn.run(
          "INSERT INTO analytics_presentation (slot, ord, hash, payload) VALUES (?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET ord = excluded.ord, hash = excluded.hash, payload = excluded.payload",
          [entry.slot, ord, hash, entry.payload],
        );
      });
      for (const slot of existing.keys()) {
        if (!keep.has(slot)) conn.run("DELETE FROM analytics_presentation WHERE slot = ?", [slot]);
      }
      writeMeta(handle, "presentation.header", JSON.stringify(header));
      conn.exec("COMMIT");
    } catch (error) {
      rollback(conn);
      throw error;
    }
  }

  return {
    path,

    loadSnapshot() {
      return exclusive(async () => {
        const handle = await openOnce();
        if (!handle) return unsupported ? undefined : await loadAnalyticsSnapshot(snapshotPath);
        try {
          const loaded = await loadIndex(handle);
          if (loaded) {
            await cleanupLegacyOnce();
            return loaded;
          }
        } catch (error) {
          await discardIfCorrupt(error);
          return undefined;
        }
        if (closed) return undefined;
        return await migrateLegacyIndex(handle);
      });
    },

    saveSnapshot(state, savedAtMs, delta) {
      return exclusive(async () => {
        const handle = await openOnce();
        if (!handle) return false;
        try {
          writeIndex(handle, state, savedAtMs, delta);
        } catch (error) {
          await discardIfCorrupt(error);
          return false;
        }
        await cleanupLegacyOnce();
        return true;
      });
    },

    loadPresentation() {
      return exclusive(async () => {
        const handle = await openOnce();
        if (!handle) return undefined;
        try {
          const file = readPresentationFile(handle);
          if (file !== undefined) return decodeAnalyticsPresentation(file);
        } catch (error) {
          await discardIfCorrupt(error);
          return undefined;
        }
        // First run after the upgrade: import a valid legacy sidecar so the first
        // view stays warm. The file itself is removed with the legacy index.
        if (!existsSync(legacyPresentationPath)) return undefined;
        try {
          const parsed = JSON.parse(await readFile(legacyPresentationPath, "utf8")) as unknown;
          const decoded = decodeAnalyticsPresentation(parsed);
          if (!decoded) return undefined;
          writePresentationFile(handle, parsed as PersistedPresentationFile);
          return decoded;
        } catch (error) {
          await discardIfCorrupt(error);
          return undefined;
        }
      });
    },

    savePresentation(state, savedAtMs) {
      // Encode now: a write queued behind a load must not pick up a newer state.
      let file: PersistedPresentationFile;
      try {
        file = encodeAnalyticsPresentation(state, savedAtMs);
      } catch {
        return Promise.resolve(false);
      }
      return exclusive(async () => {
        const handle = await openOnce();
        if (!handle) return false;
        try {
          writePresentationFile(handle, file);
          return true;
        } catch (error) {
          await discardIfCorrupt(error);
          return false;
        }
      });
    },

    lastWrite() {
      return lastWrite;
    },

    close() {
      closed = true;
      // An operation in flight finishes on its handle and closes it after.
      if (!running) closeHandle();
    },
  };
}
