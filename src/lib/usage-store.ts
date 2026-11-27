/**
 * Plugin-owned quota usage history (v1.4.0 workstream B).
 *
 * One series per `(cardId, rowKey)`, one run per stretch of identical
 * consecutive measurements, and one run-length compressed interruption span
 * per card. The store is deliberately dumb about reset epochs: boundary
 * classification is pure and lives in `src/gui/usage-intervals.ts`. Writes for
 * one collector cycle happen in one `BEGIN IMMEDIATE` transaction and re-read
 * the latest run inside it, so concurrent writers from separate processes
 * idempotently collapse the same measurement. A unique index cannot model
 * aggregated runs: a split leaves two rows sharing an endpoint.
 */
import type { AccountingMetric, AccountingUnit, CostedTokens } from "../contracts/dashboard.js";
import type { UsageMeasurementKind, UsageSource } from "../contracts/usage.js";
import type {
  UsageActivityEntry,
  UsageActivityQuery,
  UsageActivityResult,
} from "../contracts/usage-activity.js";
import { openOpenCodeSqliteWritable, type WritableSqliteConn } from "./opencode-sqlite.js";
import { hashQuotaCardIdentity } from "./quota-identity.js";
import { type PricingResolution, priceTokenBuckets } from "./quota-stats.js";
import { type TokenBuckets, totalTokenBuckets } from "./token-buckets.js";
import type { UsageImportTokens, UsageResetPrecision } from "./usage-import.js";

export const USAGE_HISTORY_SCHEMA_VERSION = 4;

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE usage_series (
    series_id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    row_key TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_label TEXT NOT NULL,
    account_label TEXT,
    plan_label TEXT,
    label TEXT NOT NULL,
    metric_json TEXT,
    measurement TEXT NOT NULL,
    source TEXT NOT NULL,
    first_at_ms INTEGER NOT NULL,
    last_at_ms INTEGER NOT NULL
  );
  CREATE INDEX usage_series_card ON usage_series(card_id);
  CREATE INDEX usage_series_provider ON usage_series(provider_id);

  CREATE TABLE usage_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id TEXT NOT NULL REFERENCES usage_series(series_id),
    first_at_ms INTEGER NOT NULL,
    last_at_ms INTEGER NOT NULL,
    sample_count INTEGER NOT NULL,
    remaining_percent REAL NOT NULL,
    quantity_decimal TEXT,
    quantity_unit_json TEXT,
    reset_at_ms INTEGER,
    linked INTEGER NOT NULL,
    collector_run_id TEXT NOT NULL,
    collector_session_id TEXT NOT NULL,
    collector_interval_ms INTEGER NOT NULL
  );
  CREATE INDEX usage_runs_series_time ON usage_runs(series_id, first_at_ms);
  CREATE INDEX usage_runs_series_last ON usage_runs(series_id, last_at_ms);
  CREATE INDEX usage_runs_time ON usage_runs(last_at_ms);

  CREATE TABLE usage_interruptions (
    interruption_id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    first_at_ms INTEGER NOT NULL,
    last_at_ms INTEGER NOT NULL,
    count INTEGER NOT NULL,
    collector_session_id TEXT NOT NULL
  );
  CREATE INDEX usage_interruptions_card ON usage_interruptions(card_id, last_at_ms);
  CREATE INDEX usage_interruptions_time ON usage_interruptions(last_at_ms);
  `,
  `
  CREATE TABLE usage_import_invocations (
    harness TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    at_ms INTEGER NOT NULL,
    model TEXT NOT NULL,
    effort TEXT,
    input_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER NOT NULL,
    session_key TEXT,
    thread_key TEXT,
    account_hint TEXT,
    PRIMARY KEY (harness, dedupe_key)
  );
  CREATE INDEX usage_import_invocations_time ON usage_import_invocations(at_ms);

  CREATE TABLE usage_import_invocation_keys (
    harness TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    message_key TEXT NOT NULL,
    PRIMARY KEY (harness, dedupe_key, message_key)
  );
  CREATE INDEX usage_import_invocation_keys_key ON usage_import_invocation_keys(message_key);

  CREATE TABLE usage_import_exclusions (
    exclusion_key TEXT PRIMARY KEY
  );
  `,
  `
  ALTER TABLE usage_runs ADD COLUMN reset_precision TEXT;
  `,
  `
  ALTER TABLE usage_runs ADD COLUMN capacity_key TEXT;
  ALTER TABLE usage_runs ADD COLUMN attempted_at_ms INTEGER;

  -- Account and plan labels can contain identifiers (emails, workspace names).
  -- History is display-neutral: Usage resolves labels from live cards only.
  UPDATE usage_series SET account_label = NULL, plan_label = NULL;

  CREATE TABLE usage_conflicts (
    conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id TEXT NOT NULL REFERENCES usage_series(series_id),
    at_ms INTEGER NOT NULL,
    remaining_percent REAL NOT NULL,
    existing_remaining_percent REAL NOT NULL,
    kind TEXT NOT NULL,
    collector_run_id TEXT NOT NULL,
    collector_session_id TEXT NOT NULL
  );
  CREATE UNIQUE INDEX usage_conflicts_unique ON usage_conflicts(series_id, at_ms, remaining_percent);
  CREATE INDEX usage_conflicts_series_time ON usage_conflicts(series_id, at_ms);
  CREATE INDEX usage_conflicts_time ON usage_conflicts(at_ms);
  `,
];

export const USAGE_INTERRUPTION_KINDS = ["error", "cooldown", "retained", "missing-row"] as const;
export type UsageInterruptionKind = (typeof USAGE_INTERRUPTION_KINDS)[number];

/** Last-seen display metadata for one quota window. Never tokens or raw errors. */
export interface UsageSeriesMetadata {
  rowId: string;
  cardId: string;
  rowKey: string;
  providerId: string;
  providerLabel: string;
  /** Accepted for compatibility but never persisted (privacy, schema v4). */
  accountLabel?: string;
  /** Accepted for compatibility but never persisted (privacy, schema v4). */
  planLabel?: string;
  label: string;
  metricJson?: string;
  measurement: UsageMeasurementKind;
  source: UsageSource;
}

export interface UsageSeriesInfo extends UsageSeriesMetadata {
  firstAtMs: number;
  lastAtMs: number;
}

export interface UsageStoredRun {
  runId: number;
  seriesId: string;
  firstAtMs: number;
  lastAtMs: number;
  sampleCount: number;
  remainingPercent: number;
  quantity?: { decimal: string; unit: AccountingUnit };
  resetAtMs?: number;
  /** `exact` when the provider supplied the reset instant, `estimated` when derived. */
  reset_precision?: UsageResetPrecision;
  /** Normalized capacity/limit + unit + plan identity; a change is an identity change. */
  capacityKey?: string;
  /** Evidence of continuous observation from the preceding run. */
  linked: boolean;
}

export interface UsageInterruptionRecord {
  interruptionId: number;
  cardId: string;
  providerId: string;
  kind: UsageInterruptionKind;
  firstAtMs: number;
  lastAtMs: number;
  count: number;
}

/** A sample that disagreed with already-stored evidence at overlapping time. */
export interface UsageConflictRecord {
  conflictId: number;
  seriesId: string;
  atMs: number;
  remainingPercent: number;
  existingRemainingPercent: number;
  kind: "inside-run" | "same-time";
}

export interface UsageCycleSample {
  series: UsageSeriesMetadata;
  remainingPercent: number;
  quantity?: { decimal: string; unit: AccountingUnit };
  resetAtMs?: number;
  resetPrecision?: UsageResetPrecision;
  /** Normalized percent capacity/limit + plan identity, when known. */
  capacityKey?: string;
  measuredAtMs: number;
}

export interface UsageCycleInterruption {
  cardId: string;
  providerId: string;
  kind: UsageInterruptionKind;
  atMs: number;
}

export interface UsageCycleObservation {
  collectorRunId: string;
  collectorSessionId: string;
  /** Collector poll interval at this cycle; continuity tolerance is 2×. */
  intervalMs: number;
  /** Collector attempt time; interruption evidence is stamped with it. Defaults to `nowMs`. */
  attemptedAtMs?: number;
  /** Every card present in the live snapshot, including excluded ones. */
  observedCards: readonly { cardId: string; providerId: string; atMs: number }[];
  /** Providers the collector attempted this cycle. */
  providerIds: readonly string[];
  samples: readonly UsageCycleSample[];
  interruptions: readonly UsageCycleInterruption[];
  nowMs: number;
}

export interface UsageHistorySlice {
  series: UsageSeriesInfo[];
  runs: UsageStoredRun[];
  /** The last run strictly before the queried span, per returned series. */
  preceding: UsageStoredRun[];
  interruptions: UsageInterruptionRecord[];
  /** Overlapping-time disagreements; the derivation renders them as uncertain. */
  conflicts: UsageConflictRecord[];
}

export const USAGE_IMPORT_HARNESSES = ["claude-code", "codex"] as const;
export type UsageImportHarness = (typeof USAGE_IMPORT_HARNESSES)[number];
export type UsageImportStatusKind = "ok" | "unavailable" | "error";

/** Persisted per-harness importer state; opaque cursors stay JSON text. */
export interface UsageImportState {
  cursor?: string;
  lastImportedAtMs?: number;
  status?: UsageImportStatusKind;
  enabled?: boolean;
}

/** One imported invocation, already stripped to numbers and hashed ids. */
export interface UsageImportedInvocation {
  atMs: number;
  model: string;
  effort?: string;
  tokens: UsageImportTokens;
  dedupeKey: string;
  nativeSessionKey?: string;
  nativeMessageKeys?: readonly string[];
  threadKey?: string;
  accountHint?: string;
}

/** One imported Codex rate-limit reading for one window. */
export interface UsageImportedCodexRateLimit {
  atMs: number;
  window: "primary" | "secondary";
  windowMinutes?: number;
  usedPercent: number;
  resetsAtMs?: number;
  /** `exact` for a provider-supplied reset instant, `estimated` for an offset. */
  resetPrecision?: UsageResetPrecision;
  planType?: string;
  limitId?: string;
  /** Hashed account hint; absent means "unknown". */
  accountHint?: string;
}

export interface UsageStore {
  readonly path: string;
  /** One full collector cycle; synchronous and single-transaction. */
  recordCycle(observation: UsageCycleObservation): void;
  query(span: { startMs: number; endMs: number }): UsageHistorySlice;
  /** Upsert imported invocations; counters take the per-counter maximum. */
  recordImportedInvocations(
    harness: UsageImportHarness,
    invocations: readonly UsageImportedInvocation[],
  ): void;
  /** Write Codex rate-limit readings as `codex-import` series runs. */
  recordCodexRateLimitObservations(observations: readonly UsageImportedCodexRateLimit[]): void;
  /** Hash-only cross-harness exclusion set; Claude Code session/message keys. */
  addImportExclusionKeys(keys: readonly string[]): void;
  getImportState(harness: UsageImportHarness): UsageImportState | undefined;
  setImportState(harness: UsageImportHarness, state: UsageImportState): void;
  /** Priced imported activity, aligned with the given query intervals. */
  queryImportedActivity(
    query: UsageActivityQuery,
    harnesses: readonly UsageImportHarness[],
  ): UsageActivityResult;
  close(): void;
}

interface SeriesRow {
  series_id: string;
  card_id: string;
  row_key: string;
  provider_id: string;
  provider_label: string;
  account_label: string | null;
  plan_label: string | null;
  label: string;
  metric_json: string | null;
  measurement: string;
  source: string;
  first_at_ms: number;
  last_at_ms: number;
}

interface RunRow {
  run_id: number;
  series_id: string;
  first_at_ms: number;
  last_at_ms: number;
  sample_count: number;
  remaining_percent: number;
  quantity_decimal: string | null;
  quantity_unit_json: string | null;
  reset_at_ms: number | null;
  reset_precision: string | null;
  capacity_key: string | null;
  attempted_at_ms: number | null;
  linked: number;
  collector_run_id: string;
  collector_session_id: string;
  collector_interval_ms: number;
}

interface InterruptionRow {
  interruption_id: number;
  card_id: string;
  provider_id: string;
  kind: string;
  first_at_ms: number;
  last_at_ms: number;
  count: number;
}

const RUN_COLUMNS =
  "run_id, series_id, first_at_ms, last_at_ms, sample_count, remaining_percent, quantity_decimal, quantity_unit_json, reset_at_ms, reset_precision, capacity_key, attempted_at_ms, linked, collector_run_id, collector_session_id, collector_interval_ms";

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function seriesRowToInfo(row: SeriesRow): UsageSeriesInfo {
  return {
    rowId: row.series_id,
    cardId: row.card_id,
    rowKey: row.row_key,
    providerId: row.provider_id,
    providerLabel: row.provider_label,
    // account_label / plan_label are cleared and never selected for display.
    label: row.label,
    ...(row.metric_json !== null ? { metricJson: row.metric_json } : {}),
    measurement: row.measurement as UsageMeasurementKind,
    source: row.source as UsageSource,
    firstAtMs: row.first_at_ms,
    lastAtMs: row.last_at_ms,
  };
}

function runRowToStored(row: RunRow): UsageStoredRun {
  return {
    runId: row.run_id,
    seriesId: row.series_id,
    firstAtMs: row.first_at_ms,
    lastAtMs: row.last_at_ms,
    sampleCount: row.sample_count,
    remainingPercent: row.remaining_percent,
    ...(row.quantity_decimal !== null && row.quantity_unit_json !== null
      ? { quantity: { decimal: row.quantity_decimal, unit: JSON.parse(row.quantity_unit_json) } }
      : {}),
    ...(row.reset_at_ms !== null ? { resetAtMs: row.reset_at_ms } : {}),
    ...(row.reset_precision === "exact" || row.reset_precision === "estimated"
      ? { reset_precision: row.reset_precision }
      : {}),
    ...(row.capacity_key !== null ? { capacityKey: row.capacity_key } : {}),
    linked: row.linked === 1,
  };
}

function quantityParts(
  quantity: { decimal: string; unit: AccountingUnit } | undefined,
): [string | null, string | null] {
  return quantity === undefined ? [null, null] : [quantity.decimal, JSON.stringify(quantity.unit)];
}

const CODEX_IMPORT_PROVIDER = "openai";
const CODEX_IMPORT_PROVIDER_LABEL = "OpenAI Codex (imported)";
let codexImportSequence = 0;
const IMPORT_PROVIDER_BY_HARNESS: Readonly<Record<UsageImportHarness, string>> = {
  "claude-code": "anthropic",
  codex: "openai",
};
const CODEX_WINDOW_SEMANTICS: Partial<
  Record<number, { window: "five_hour" | "week"; label: string }>
> = {
  300: { window: "five_hour", label: "5h" },
  10080: { window: "week", label: "Week" },
};

/** A bounded safe token for labels and row keys; raw strings are never needed. */
function importToken(value: string | undefined, fallback: string): string {
  const safe = (value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 64)
    .replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe : fallback;
}

function codexWindowIdentity(observation: UsageImportedCodexRateLimit): {
  rowKey: string;
  metric: AccountingMetric;
  label: string;
} {
  const exact =
    observation.windowMinutes === undefined
      ? undefined
      : CODEX_WINDOW_SEMANTICS[observation.windowMinutes];
  if (exact !== undefined) {
    return {
      rowKey: `window:${exact.window}`,
      metric: { kind: "window", window: exact.window },
      label: exact.label,
    };
  }
  const limit = importToken(observation.limitId, "codex");
  const suffix = observation.windowMinutes === undefined ? "" : `${observation.windowMinutes}m`;
  const name = `${limit}|${observation.window}|${observation.windowMinutes ?? ""}`;
  return {
    rowKey: `named:${name}`,
    metric: { kind: "named", name },
    label: [limit, observation.window, suffix].filter((part) => part.length > 0).join(" "),
  };
}

function counter(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Value identity of a sample: remaining, quantity and capacity. */
function sameValue(
  run: RunRow,
  remainingPercent: number,
  quantity: { decimal: string; unit: AccountingUnit } | undefined,
  capacityKey: string | undefined,
): boolean {
  const [decimal, unitJson] = quantityParts(quantity);
  return (
    run.remaining_percent === remainingPercent &&
    run.quantity_decimal === decimal &&
    run.quantity_unit_json === unitJson &&
    run.capacity_key === (capacityKey ?? null)
  );
}

/**
 * Reset epoch identity. Exact resets must match; estimated resets jitter by up
 * to about a poll interval, so a small forward/backward drift still describes
 * the same window and must not split a run.
 */
function sameResetEpoch(
  run: RunRow,
  resetAtMs: number | undefined,
  resetPrecision: UsageResetPrecision | undefined,
  intervalMs: number,
): boolean {
  if (run.reset_at_ms === null || resetAtMs === undefined) {
    return run.reset_at_ms === null && resetAtMs === undefined;
  }
  if (run.reset_at_ms === resetAtMs) return true;
  const estimated = run.reset_precision === "estimated" || resetPrecision === "estimated";
  if (!estimated) return false;
  const tolerance = 2 * Math.max(intervalMs, run.collector_interval_ms);
  return Math.abs(run.reset_at_ms - resetAtMs) <= tolerance;
}

function sameMeasurement(run: RunRow, sample: UsageCycleSample, intervalMs: number): boolean {
  return (
    sameValue(run, sample.remainingPercent, sample.quantity, sample.capacityKey) &&
    sameResetEpoch(run, sample.resetAtMs, sample.resetPrecision, intervalMs)
  );
}

function readSchemaVersion(conn: WritableSqliteConn): number {
  const row = conn.get<{ value: string }>(
    "SELECT value FROM usage_meta WHERE key = 'schema_version'",
  );
  return row === null ? 0 : Number(row.value);
}

function migrate(conn: WritableSqliteConn): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS usage_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Re-read the version inside the write transaction: a second process opening
  // the same fresh database waits here instead of racing the migration.
  conn.exec("BEGIN IMMEDIATE");
  try {
    const current = readSchemaVersion(conn);
    if (!Number.isInteger(current) || current > USAGE_HISTORY_SCHEMA_VERSION) {
      throw new Error("usage-history-schema-unsupported");
    }
    for (let version = current + 1; version <= USAGE_HISTORY_SCHEMA_VERSION; version += 1) {
      const sql = MIGRATIONS[version - 1];
      if (sql === undefined) throw new Error("usage-history-migration-missing");
      conn.exec(sql);
      conn.run(
        "INSERT INTO usage_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [String(version)],
      );
    }
    conn.exec("COMMIT");
  } catch (error) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      // the original failure is the one worth reporting
    }
    throw error;
  }
}

function createStore(conn: WritableSqliteConn, path: string): UsageStore {
  // A shared in-flight snapshot can reach the observer twice. Cycle ids are
  // process/session scoped, so an in-memory recent window is idempotent without
  // growing forever; a cross-process replay cannot reuse the same id.
  const RECENT_CYCLE_LIMIT = 64;
  const recentCycles = new Set<string>();
  const recentCycleOrder: string[] = [];

  function rememberCycle(collectorRunId: string): void {
    if (recentCycles.has(collectorRunId)) return;
    recentCycles.add(collectorRunId);
    recentCycleOrder.push(collectorRunId);
    if (recentCycleOrder.length > RECENT_CYCLE_LIMIT) {
      const dropped = recentCycleOrder.shift();
      if (dropped !== undefined) recentCycles.delete(dropped);
    }
  }

  function latestRun(seriesId: string): RunRow | null {
    return conn.get<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM usage_runs WHERE series_id = ? ORDER BY first_at_ms DESC, run_id DESC LIMIT 1`,
      [seriesId],
    );
  }

  function coveringRuns(seriesId: string, measuredAtMs: number): RunRow[] {
    return conn.all<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM usage_runs
       WHERE series_id = ? AND last_at_ms >= ? AND first_at_ms <= ?
       ORDER BY first_at_ms, last_at_ms, run_id`,
      [seriesId, measuredAtMs, measuredAtMs],
    );
  }

  function upsertSeries(series: UsageSeriesMetadata, measuredAtMs: number): void {
    // Display labels are never persisted. A late sample also must not overwrite
    // newer metadata (label/metric/source) from a later measurement.
    conn.run(
      `INSERT INTO usage_series (
         series_id, card_id, row_key, provider_id, provider_label, account_label, plan_label,
         label, metric_json, measurement, source, first_at_ms, last_at_ms
       ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET
         provider_label = CASE
           WHEN excluded.last_at_ms >= usage_series.last_at_ms THEN excluded.provider_label
           ELSE usage_series.provider_label
         END,
         label = CASE
           WHEN excluded.last_at_ms >= usage_series.last_at_ms THEN excluded.label
           ELSE usage_series.label
         END,
         metric_json = CASE
           WHEN excluded.last_at_ms >= usage_series.last_at_ms THEN excluded.metric_json
           ELSE usage_series.metric_json
         END,
         measurement = CASE
           WHEN excluded.last_at_ms >= usage_series.last_at_ms THEN excluded.measurement
           ELSE usage_series.measurement
         END,
         source = CASE
           WHEN excluded.last_at_ms >= usage_series.last_at_ms THEN excluded.source
           ELSE usage_series.source
         END,
         first_at_ms = MIN(usage_series.first_at_ms, excluded.first_at_ms),
         last_at_ms = MAX(usage_series.last_at_ms, excluded.last_at_ms)`,
      [
        series.rowId,
        series.cardId,
        series.rowKey,
        series.providerId,
        series.providerLabel,
        series.label,
        series.metricJson ?? null,
        series.measurement,
        series.source,
        measuredAtMs,
        measuredAtMs,
      ],
    );
  }

  function insertRun(
    sample: UsageCycleSample,
    measuredAtMs: number,
    linked: boolean,
    run: {
      collectorRunId: string;
      collectorSessionId: string;
      intervalMs: number;
      attemptedAtMs: number;
    },
  ): void {
    const [decimal, unitJson] = quantityParts(sample.quantity);
    conn.run(
      `INSERT INTO usage_runs (
         series_id, first_at_ms, last_at_ms, sample_count, remaining_percent,
         quantity_decimal, quantity_unit_json, reset_at_ms, reset_precision, capacity_key,
         attempted_at_ms, linked, collector_run_id, collector_session_id, collector_interval_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sample.series.rowId,
        measuredAtMs,
        measuredAtMs,
        sample.remainingPercent,
        decimal,
        unitJson,
        sample.resetAtMs ?? null,
        sample.resetPrecision ?? null,
        sample.capacityKey ?? null,
        run.attemptedAtMs,
        linked ? 1 : 0,
        run.collectorRunId,
        run.collectorSessionId,
        run.intervalMs,
      ],
    );
  }

  function interruptionWatermark(cardId: string, watermarks: Map<string, number>): number {
    const cached = watermarks.get(cardId);
    if (cached !== undefined) return cached;
    const row = conn.get<{ last_at_ms: number | null }>(
      "SELECT MAX(last_at_ms) AS last_at_ms FROM usage_interruptions WHERE card_id = ?",
      [cardId],
    );
    const value = typeof row?.last_at_ms === "number" ? row.last_at_ms : 0;
    watermarks.set(cardId, value);
    return value;
  }

  function isContinuous(
    latest: RunRow,
    cardId: string,
    measuredAtMs: number,
    observation: UsageCycleObservation,
    watermarks: Map<string, number>,
  ): boolean {
    // The previous run stores the poll interval that governed the gap after it.
    // Interruption evidence is ordered against the last successful attempt, not
    // the (possibly older) measurement time, so a failed attempt between two
    // successes always breaks the link.
    const successAtMs = latest.attempted_at_ms ?? latest.last_at_ms;
    return (
      latest.collector_session_id === observation.collectorSessionId &&
      measuredAtMs > latest.last_at_ms &&
      measuredAtMs - latest.last_at_ms <= 2 * latest.collector_interval_ms &&
      interruptionWatermark(cardId, watermarks) <= successAtMs
    );
  }

  function writeConflict(
    run: RunRow,
    sample: UsageCycleSample,
    measuredAtMs: number,
    kind: UsageConflictRecord["kind"],
    observation: UsageCycleObservation,
  ): void {
    conn.run(
      `INSERT OR IGNORE INTO usage_conflicts (
         series_id, at_ms, remaining_percent, existing_remaining_percent, kind,
         collector_run_id, collector_session_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        sample.series.rowId,
        measuredAtMs,
        sample.remainingPercent,
        run.remaining_percent,
        kind,
        observation.collectorRunId,
        observation.collectorSessionId,
      ],
    );
  }

  /** Insert a sample in a gap and break the link into the following run. */
  function insertGapRun(
    sample: UsageCycleSample,
    measuredAtMs: number,
    observation: UsageCycleObservation,
    attemptedAtMs: number,
  ): void {
    insertRun(sample, measuredAtMs, false, { ...observation, attemptedAtMs });
    conn.run(
      `UPDATE usage_runs SET linked = 0 WHERE run_id = (
         SELECT run_id FROM usage_runs
         WHERE series_id = ? AND first_at_ms > ?
         ORDER BY first_at_ms, run_id LIMIT 1
       )`,
      [sample.series.rowId, measuredAtMs],
    );
  }

  function writeSample(
    sample: UsageCycleSample,
    observation: UsageCycleObservation,
    watermarks: Map<string, number>,
  ): void {
    if (!Number.isFinite(sample.remainingPercent) || !Number.isFinite(sample.measuredAtMs)) return;
    const measuredAtMs = Math.round(sample.measuredAtMs);
    const attemptedAtMs = observation.attemptedAtMs ?? observation.nowMs;
    upsertSeries(sample.series, measuredAtMs);

    // Fast path: an append-only sample newer than the latest run cannot be
    // covered by any run, so the covering lookup is only needed for replays
    // and out-of-order observations (D3).
    const latest = latestRun(sample.series.rowId);
    const covering =
      latest !== null && measuredAtMs <= latest.last_at_ms
        ? coveringRuns(sample.series.rowId, measuredAtMs)
        : [];
    if (covering.length > 0) {
      const sameValueRun = covering.find((run) =>
        sameValue(run, sample.remainingPercent, sample.quantity, sample.capacityKey),
      );
      if (sameValueRun !== undefined) {
        if (measuredAtMs > sameValueRun.first_at_ms && measuredAtMs < sameValueRun.last_at_ms) {
          // Same value inside a run: the sample is real evidence, but it adds no
          // endpoint. The run keeps its first/last pair.
          conn.run(
            "UPDATE usage_runs SET sample_count = sample_count + 1, attempted_at_ms = MAX(COALESCE(attempted_at_ms, 0), ?) WHERE run_id = ?",
            [attemptedAtMs, sameValueRun.run_id],
          );
        } else {
          // Exact duplicate of a run endpoint (replay of the same measurement).
          conn.run(
            "UPDATE usage_runs SET attempted_at_ms = MAX(COALESCE(attempted_at_ms, 0), ?) WHERE run_id = ?",
            [attemptedAtMs, sameValueRun.run_id],
          );
        }
        return;
      }
      // A different value at/inside stored evidence never splits or fabricates
      // an endpoint: it is conflict evidence the derivation renders as uncertain.
      const interior = covering.find(
        (run) => run.first_at_ms < measuredAtMs && run.last_at_ms > measuredAtMs,
      );
      writeConflict(
        interior ?? (covering[0] as RunRow),
        sample,
        measuredAtMs,
        interior !== undefined ? "inside-run" : "same-time",
        observation,
      );
      return;
    }
    if (latest !== null && measuredAtMs <= latest.last_at_ms) {
      insertGapRun(sample, measuredAtMs, observation, attemptedAtMs);
      return;
    }

    const linked =
      latest !== null &&
      isContinuous(latest, sample.series.cardId, measuredAtMs, observation, watermarks);
    if (
      latest !== null &&
      linked &&
      sameMeasurement(latest, sample, observation.intervalMs) &&
      measuredAtMs > latest.last_at_ms
    ) {
      conn.run(
        `UPDATE usage_runs SET
           last_at_ms = ?, sample_count = sample_count + 1,
           reset_at_ms = COALESCE(?, reset_at_ms),
           reset_precision = COALESCE(?, reset_precision),
           attempted_at_ms = ?
         WHERE run_id = ?`,
        [
          measuredAtMs,
          sample.resetAtMs ?? null,
          sample.resetPrecision ?? null,
          attemptedAtMs,
          latest.run_id,
        ],
      );
      return;
    }
    insertRun(sample, measuredAtMs, linked, { ...observation, attemptedAtMs });
  }

  function writeInterruption(
    interruption: UsageCycleInterruption,
    observation: UsageCycleObservation,
  ): void {
    if (!Number.isFinite(interruption.atMs)) return;
    const atMs = Math.round(interruption.atMs);
    const last = conn.get<{
      interruption_id: number;
      kind: string;
      last_at_ms: number;
      count: number;
      collector_session_id: string;
    }>(
      "SELECT interruption_id, kind, last_at_ms, count, collector_session_id FROM usage_interruptions WHERE card_id = ? ORDER BY last_at_ms DESC, interruption_id DESC LIMIT 1",
      [interruption.cardId],
    );
    if (
      last !== null &&
      last.kind === interruption.kind &&
      last.collector_session_id === observation.collectorSessionId &&
      atMs >= last.last_at_ms &&
      atMs - last.last_at_ms <= 2 * observation.intervalMs
    ) {
      // A successful attempt between two failures ends the span; never
      // compress across it even when the timer gap is small.
      const success = conn.get<{ present: number }>(
        `SELECT 1 AS present FROM usage_runs r
         JOIN usage_series s ON s.series_id = r.series_id
         WHERE s.card_id = ? AND COALESCE(r.attempted_at_ms, r.last_at_ms) > ?
           AND COALESCE(r.attempted_at_ms, r.last_at_ms) < ?
         LIMIT 1`,
        [interruption.cardId, last.last_at_ms, atMs],
      );
      if (success === null) {
        conn.run(
          "UPDATE usage_interruptions SET last_at_ms = ?, count = count + 1 WHERE interruption_id = ?",
          [atMs, last.interruption_id],
        );
        return;
      }
    }
    conn.run(
      `INSERT INTO usage_interruptions (card_id, provider_id, kind, first_at_ms, last_at_ms, count, collector_session_id)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [
        interruption.cardId,
        interruption.providerId,
        interruption.kind,
        atMs,
        atMs,
        observation.collectorSessionId,
      ],
    );
  }

  function recordMissingRows(
    observation: UsageCycleObservation,
    observedByCard: Map<string, { cardId: string; providerId: string; atMs: number }>,
    sampledSeries: ReadonlySet<string>,
    interruptedCards: Set<string>,
  ): void {
    // Only cards this collector previously observed in this collector session
    // may produce missing-row evidence. A card another process/credential owns
    // must never be reported missing here.
    const previouslyObserved = new Map<string, string>();
    for (const row of conn.all<{ card_id: string; provider_id: string }>(
      `SELECT DISTINCT s.card_id, s.provider_id FROM usage_series s
       WHERE EXISTS (
         SELECT 1 FROM usage_runs r
         WHERE r.series_id = s.series_id AND r.collector_session_id = ?
       ) OR EXISTS (
         SELECT 1 FROM usage_interruptions i
         WHERE i.card_id = s.card_id AND i.collector_session_id = ?
       )`,
      [observation.collectorSessionId, observation.collectorSessionId],
    )) {
      previouslyObserved.set(row.card_id, row.provider_id);
    }
    const attemptAtMs = observation.attemptedAtMs ?? observation.nowMs;
    const missing = new Map<string, { providerId: string; atMs: number }>();
    const seriesForCards = () => {
      const cardIds = [...observedByCard.keys()];
      if (cardIds.length === 0) return [];
      return conn.all<{ series_id: string; card_id: string; provider_id: string }>(
        `SELECT series_id, card_id, provider_id FROM usage_series WHERE card_id IN (${placeholders(cardIds.length)})`,
        cardIds,
      );
    };
    for (const series of seriesForCards()) {
      const card = observedByCard.get(series.card_id);
      if (card === undefined || sampledSeries.has(series.series_id)) continue;
      if (!previouslyObserved.has(series.card_id)) continue;
      missing.set(series.card_id, { providerId: series.provider_id, atMs: attemptAtMs });
    }

    const providerIds = [...new Set(observation.providerIds)];
    if (providerIds.length > 0) {
      const dropped = conn.all<{ card_id: string; provider_id: string }>(
        `SELECT DISTINCT card_id, provider_id FROM usage_series WHERE provider_id IN (${placeholders(providerIds.length)})`,
        providerIds,
      );
      for (const series of dropped) {
        if (observedByCard.has(series.card_id) || interruptedCards.has(series.card_id)) continue;
        if (!previouslyObserved.has(series.card_id)) continue;
        missing.set(series.card_id, { providerId: series.provider_id, atMs: attemptAtMs });
      }
    }

    for (const [cardId, entry] of missing) {
      if (interruptedCards.has(cardId)) continue;
      interruptedCards.add(cardId);
      writeInterruption(
        { cardId, providerId: entry.providerId, kind: "missing-row", atMs: entry.atMs },
        observation,
      );
    }
  }

  function recordCycle(observation: UsageCycleObservation): void {
    if (recentCycles.has(observation.collectorRunId)) return;
    const observedByCard = new Map(
      observation.observedCards.map((card) => [card.cardId, card] as const),
    );
    const sampledSeries = new Set(observation.samples.map((sample) => sample.series.rowId));
    const interruptedCards = new Set(observation.interruptions.map((item) => item.cardId));
    const watermarks = new Map<string, number>();
    conn.exec("BEGIN IMMEDIATE");
    try {
      for (const sample of observation.samples) writeSample(sample, observation, watermarks);
      for (const interruption of observation.interruptions) {
        writeInterruption(interruption, observation);
      }
      recordMissingRows(observation, observedByCard, sampledSeries, interruptedCards);
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // the original failure is the one worth reporting
      }
      throw error;
    }
    rememberCycle(observation.collectorRunId);
  }

  function recordImportedInvocations(
    harness: UsageImportHarness,
    invocations: readonly UsageImportedInvocation[],
  ): void {
    if (invocations.length === 0) return;
    conn.exec("BEGIN IMMEDIATE");
    try {
      for (const invocation of invocations) {
        if (!Number.isFinite(invocation.atMs)) continue;
        const tokens = invocation.tokens;
        const atMs = Math.round(invocation.atMs);
        conn.run(
          `INSERT INTO usage_import_invocations (
             harness, dedupe_key, at_ms, model, effort,
             input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
             session_key, thread_key, account_hint
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(harness, dedupe_key) DO UPDATE SET
             at_ms = MIN(usage_import_invocations.at_ms, excluded.at_ms),
             model = CASE
               WHEN usage_import_invocations.model = 'unknown' AND excluded.model <> 'unknown'
                 THEN excluded.model
               ELSE usage_import_invocations.model
             END,
             effort = COALESCE(usage_import_invocations.effort, excluded.effort),
             input_tokens = MAX(usage_import_invocations.input_tokens, excluded.input_tokens),
             cache_read_tokens = MAX(usage_import_invocations.cache_read_tokens, excluded.cache_read_tokens),
             cache_write_tokens = MAX(usage_import_invocations.cache_write_tokens, excluded.cache_write_tokens),
             output_tokens = MAX(usage_import_invocations.output_tokens, excluded.output_tokens),
             reasoning_tokens = MAX(usage_import_invocations.reasoning_tokens, excluded.reasoning_tokens),
             session_key = COALESCE(usage_import_invocations.session_key, excluded.session_key),
             thread_key = COALESCE(usage_import_invocations.thread_key, excluded.thread_key),
             account_hint = COALESCE(usage_import_invocations.account_hint, excluded.account_hint)`,
          [
            harness,
            invocation.dedupeKey,
            atMs,
            invocation.model.trim().slice(0, 200) || "unknown",
            invocation.effort === undefined ? null : invocation.effort.trim().slice(0, 64) || null,
            counter(tokens.input),
            counter(tokens.cacheRead),
            counter(tokens.cacheWrite),
            counter(tokens.output),
            counter(tokens.reasoning),
            invocation.nativeSessionKey ?? null,
            invocation.threadKey ?? null,
            invocation.accountHint ?? null,
          ],
        );
        for (const messageKey of invocation.nativeMessageKeys ?? []) {
          conn.run(
            `INSERT OR IGNORE INTO usage_import_invocation_keys (harness, dedupe_key, message_key)
             VALUES (?, ?, ?)`,
            [harness, invocation.dedupeKey, messageKey],
          );
        }
      }
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // the original failure is the one worth reporting
      }
      throw error;
    }
  }

  function recordCodexRateLimitObservations(
    observations: readonly UsageImportedCodexRateLimit[],
  ): void {
    const samples: UsageCycleSample[] = [];
    for (const observation of observations) {
      if (!Number.isFinite(observation.atMs) || !Number.isFinite(observation.usedPercent)) continue;
      const atMs = Math.round(observation.atMs);
      const cardId = `codex-import:${observation.accountHint ?? "unknown"}`;
      const identity = codexWindowIdentity(observation);
      const planKey =
        observation.planType !== undefined && observation.planType.trim().length > 0
          ? `plan:${hashQuotaCardIdentity(CODEX_IMPORT_PROVIDER, observation.planType)}`
          : undefined;
      samples.push({
        series: {
          rowId: `${cardId}#${identity.rowKey}`,
          cardId,
          rowKey: identity.rowKey,
          providerId: CODEX_IMPORT_PROVIDER,
          providerLabel: CODEX_IMPORT_PROVIDER_LABEL,
          // Plan display labels are never persisted; the hashed identity below
          // still detects a plan change as an identity boundary.
          label: identity.label,
          metricJson: JSON.stringify(identity.metric),
          measurement: "provider-observed",
          source: "codex-import",
        },
        remainingPercent: Math.max(0, Math.min(100, 100 - observation.usedPercent)),
        ...(observation.resetsAtMs !== undefined && Number.isFinite(observation.resetsAtMs)
          ? { resetAtMs: Math.round(observation.resetsAtMs) }
          : {}),
        ...(observation.resetPrecision !== undefined
          ? { resetPrecision: observation.resetPrecision }
          : {}),
        ...(planKey !== undefined ? { capacityKey: planKey } : {}),
        measuredAtMs: atMs,
      });
    }
    if (samples.length === 0) return;
    samples.sort((left, right) => left.measuredAtMs - right.measuredAtMs);
    const lastSample = samples.at(-1);
    if (lastSample === undefined) return;
    codexImportSequence += 1;
    recordCycle({
      // Each import batch is one synthetic cycle. Re-reading the same points is
      // deduplicated by (series, time, value), never by this batch id.
      collectorRunId: `codex-import:${lastSample.measuredAtMs}:${codexImportSequence}`,
      collectorSessionId: "codex-import",
      intervalMs: 0,
      observedCards: [],
      providerIds: [],
      samples,
      interruptions: [],
      nowMs: lastSample.measuredAtMs,
    });
  }

  function addImportExclusionKeys(keys: readonly string[]): void {
    const unique = [...new Set(keys.filter((key) => key.length > 0))];
    if (unique.length === 0) return;
    conn.exec("BEGIN IMMEDIATE");
    try {
      for (const key of unique) {
        conn.run("INSERT OR IGNORE INTO usage_import_exclusions (exclusion_key) VALUES (?)", [key]);
      }
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // the original failure is the one worth reporting
      }
      throw error;
    }
  }

  function getImportState(harness: UsageImportHarness): UsageImportState | undefined {
    const row = conn.get<{ value: string }>("SELECT value FROM usage_meta WHERE key = ?", [
      `import_state:${harness}`,
    ]);
    if (row === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed as Record<string, unknown>;
    const state: UsageImportState = {};
    if (typeof value.cursor === "string") state.cursor = value.cursor;
    if (typeof value.lastImportedAtMs === "number" && Number.isFinite(value.lastImportedAtMs)) {
      state.lastImportedAtMs = value.lastImportedAtMs;
    }
    if (value.status === "ok" || value.status === "unavailable" || value.status === "error") {
      state.status = value.status;
    }
    if (typeof value.enabled === "boolean") state.enabled = value.enabled;
    return state;
  }

  function setImportState(harness: UsageImportHarness, state: UsageImportState): void {
    const value: UsageImportState = {};
    if (state.cursor !== undefined) value.cursor = state.cursor;
    if (state.lastImportedAtMs !== undefined && Number.isFinite(state.lastImportedAtMs)) {
      value.lastImportedAtMs = state.lastImportedAtMs;
    }
    if (state.status !== undefined) value.status = state.status;
    if (state.enabled !== undefined) value.enabled = state.enabled;
    conn.run(
      "INSERT INTO usage_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [`import_state:${harness}`, JSON.stringify(value)],
    );
  }

  interface ImportedActivityAccumulator {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    costUsd: number;
    pricedAny: boolean;
    unpricedTokens: number;
    unknownTokens: number;
    stepCount: number;
  }

  function emptyImportedAccumulator(): ImportedActivityAccumulator {
    return {
      input: 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: 0,
      reasoning: 0,
      costUsd: 0,
      pricedAny: false,
      unpricedTokens: 0,
      unknownTokens: 0,
      stepCount: 0,
    };
  }

  function finalizeImportedActivity(accumulator: ImportedActivityAccumulator): CostedTokens {
    return {
      input: accumulator.input,
      cacheRead: accumulator.cacheRead,
      cacheWrite: accumulator.cacheWrite,
      output: accumulator.output,
      reasoning: accumulator.reasoning,
      total:
        accumulator.input +
        accumulator.cacheRead +
        accumulator.cacheWrite +
        accumulator.output +
        accumulator.reasoning,
      apiEquivalentCostUsd: accumulator.pricedAny ? accumulator.costUsd : null,
      unpricedTokens: accumulator.unpricedTokens,
      unknownTokens: accumulator.unknownTokens,
    };
  }

  function queryImportedActivity(
    query: UsageActivityQuery,
    harnesses: readonly UsageImportHarness[],
  ): UsageActivityResult {
    const active = USAGE_IMPORT_HARNESSES.filter((harness) => harnesses.includes(harness));
    const pricingCache = new Map<string, PricingResolution>();
    return {
      intervals: query.intervals.map((interval) => {
        const groups = new Map<
          string,
          ImportedActivityAccumulator & { providerId: string; modelId: string; effort?: string }
        >();
        if (active.length > 0) {
          const rows = conn.all<{
            harness: string;
            model: string;
            effort: string | null;
            at_ms: number;
            input_tokens: number;
            cache_read_tokens: number;
            cache_write_tokens: number;
            output_tokens: number;
            reasoning_tokens: number;
          }>(
            `SELECT i.harness, i.model, i.effort, i.at_ms,
                    i.input_tokens, i.cache_read_tokens, i.cache_write_tokens,
                    i.output_tokens, i.reasoning_tokens
             FROM usage_import_invocations i
             WHERE i.at_ms > ? AND i.at_ms <= ?
               AND i.harness IN (${placeholders(active.length)})
               AND NOT EXISTS (
                 SELECT 1 FROM usage_import_exclusions e WHERE e.exclusion_key = i.session_key
               )
               AND NOT EXISTS (
                 SELECT 1 FROM usage_import_invocation_keys k
                 JOIN usage_import_exclusions e ON e.exclusion_key = k.message_key
                 WHERE k.harness = i.harness AND k.dedupe_key = i.dedupe_key
               )`,
            [interval.startMs, interval.endMs, ...active],
          );
          for (const row of rows) {
            const providerId = IMPORT_PROVIDER_BY_HARNESS[row.harness as UsageImportHarness];
            const effort = row.effort ?? undefined;
            const key = [providerId, row.model, effort ?? ""].join("\0");
            let accumulator = groups.get(key);
            if (accumulator === undefined) {
              accumulator = {
                ...emptyImportedAccumulator(),
                providerId,
                modelId: row.model,
                ...(effort === undefined ? {} : { effort }),
              };
              groups.set(key, accumulator);
            }
            const tokens: TokenBuckets = {
              input: row.input_tokens,
              cache_read: row.cache_read_tokens,
              cache_write: row.cache_write_tokens,
              output: row.output_tokens,
              reasoning: row.reasoning_tokens,
            };
            accumulator.input += tokens.input;
            accumulator.cacheRead += tokens.cache_read;
            accumulator.cacheWrite += tokens.cache_write;
            accumulator.output += tokens.output;
            accumulator.reasoning += tokens.reasoning;
            accumulator.stepCount += 1;
            const priced = priceTokenBuckets({
              providerID: providerId,
              modelID: row.model,
              tokens,
              atMs: row.at_ms,
              cache: pricingCache,
            });
            if (priced.status === "priced" || priced.status === "partial") {
              accumulator.pricedAny = true;
              accumulator.costUsd += priced.costUsd;
              if (priced.status === "partial") accumulator.unpricedTokens += priced.unpricedTokens;
            } else if (priced.status === "unpriced") {
              accumulator.unpricedTokens += totalTokenBuckets(tokens);
            } else {
              accumulator.unknownTokens += totalTokenBuckets(tokens);
            }
          }
        }
        const entries: UsageActivityEntry[] = [...groups.values()]
          .map((accumulator) => ({
            providerId: accumulator.providerId,
            modelId: accumulator.modelId,
            ...(accumulator.effort === undefined ? {} : { effort: accumulator.effort }),
            tokens: finalizeImportedActivity(accumulator),
            stepCount: accumulator.stepCount,
          }))
          .sort(
            (left, right) =>
              left.providerId.localeCompare(right.providerId) ||
              left.modelId.localeCompare(right.modelId) ||
              (left.effort ?? "").localeCompare(right.effort ?? ""),
          );
        let incomplete = false;
        let unpricedTokens = 0;
        let unknownTokens = 0;
        for (const entry of entries) {
          unpricedTokens += entry.tokens.unpricedTokens;
          unknownTokens += entry.tokens.unknownTokens;
          if (
            entry.tokens.apiEquivalentCostUsd === null ||
            entry.tokens.unpricedTokens > 0 ||
            entry.tokens.unknownTokens > 0
          ) {
            incomplete = true;
          }
        }
        return {
          startMs: interval.startMs,
          endMs: interval.endMs,
          entries,
          incomplete,
          unpricedTokens,
          unknownTokens,
        };
      }),
    };
  }

  function query(span: { startMs: number; endMs: number }): UsageHistorySlice {
    const startMs = Math.min(span.startMs, span.endMs);
    const endMs = Math.max(span.startMs, span.endMs);
    // One read transaction gives the runs/series/preceding/conflict reads a
    // single consistent snapshot while another process may be writing.
    conn.exec("BEGIN");
    try {
      const runs = conn.all<RunRow>(
        `SELECT ${RUN_COLUMNS} FROM usage_runs
         WHERE last_at_ms >= ? AND first_at_ms <= ?
         ORDER BY series_id, first_at_ms, last_at_ms, run_id`,
        [startMs, endMs],
      );
      const seriesIds = [...new Set(runs.map((run) => run.series_id))];
      const seriesById = new Map<string, UsageSeriesInfo>();
      if (seriesIds.length > 0) {
        const rows = conn.all<SeriesRow>(
          `SELECT * FROM usage_series WHERE series_id IN (${placeholders(seriesIds.length)})`,
          seriesIds,
        );
        for (const row of rows) seriesById.set(row.series_id, seriesRowToInfo(row));
      }
      const preceding: UsageStoredRun[] = [];
      for (const seriesId of seriesIds) {
        const row = conn.get<RunRow>(
          `SELECT ${RUN_COLUMNS} FROM usage_runs
           WHERE series_id = ? AND last_at_ms < ?
           ORDER BY last_at_ms DESC, run_id DESC LIMIT 1`,
          [seriesId, startMs],
        );
        if (row !== null) preceding.push(runRowToStored(row));
      }
      const interruptions = conn.all<InterruptionRow>(
        `SELECT interruption_id, card_id, provider_id, kind, first_at_ms, last_at_ms, count
         FROM usage_interruptions
         WHERE last_at_ms >= ? AND first_at_ms <= ?
         ORDER BY first_at_ms, interruption_id`,
        [startMs, endMs],
      );
      const conflicts =
        seriesIds.length === 0
          ? []
          : conn.all<{
              conflict_id: number;
              series_id: string;
              at_ms: number;
              remaining_percent: number;
              existing_remaining_percent: number;
              kind: string;
            }>(
              `SELECT conflict_id, series_id, at_ms, remaining_percent, existing_remaining_percent, kind
             FROM usage_conflicts
             WHERE series_id IN (${placeholders(seriesIds.length)})
               AND at_ms >= ? AND at_ms <= ?
             ORDER BY series_id, at_ms, conflict_id`,
              [...seriesIds, startMs, endMs],
            );
      conn.exec("COMMIT");
      return {
        series: seriesIds.flatMap((seriesId) => {
          const info = seriesById.get(seriesId);
          return info === undefined ? [] : [info];
        }),
        runs: runs.map(runRowToStored),
        preceding,
        interruptions: interruptions.map((row) => ({
          interruptionId: row.interruption_id,
          cardId: row.card_id,
          providerId: row.provider_id,
          kind: row.kind as UsageInterruptionKind,
          firstAtMs: row.first_at_ms,
          lastAtMs: row.last_at_ms,
          count: row.count,
        })),
        conflicts: conflicts.map((row) => ({
          conflictId: row.conflict_id,
          seriesId: row.series_id,
          atMs: row.at_ms,
          remainingPercent: row.remaining_percent,
          existingRemainingPercent: row.existing_remaining_percent,
          kind: row.kind === "inside-run" ? "inside-run" : "same-time",
        })),
      };
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch {
        // the original failure is the one worth reporting
      }
      throw error;
    }
  }

  return {
    path,
    recordCycle,
    query,
    recordImportedInvocations,
    recordCodexRateLimitObservations,
    addImportExclusionKeys,
    getImportState,
    setImportState,
    queryImportedActivity,
    close() {
      conn.close();
    },
  };
}

export async function openUsageStore(
  dbPath: string,
  options: { busyTimeoutMs?: number } = {},
): Promise<UsageStore> {
  const conn = await openOpenCodeSqliteWritable(dbPath, options);
  try {
    migrate(conn);
  } catch (error) {
    conn.close();
    throw error;
  }
  return createStore(conn, dbPath);
}
