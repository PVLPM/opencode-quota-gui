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
import type { AccountingUnit } from "../contracts/dashboard.js";
import type { UsageMeasurementKind, UsageSource } from "../contracts/usage.js";
import { openOpenCodeSqliteWritable, type WritableSqliteConn } from "./opencode-sqlite.js";

export const USAGE_HISTORY_SCHEMA_VERSION = 1;

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
  accountLabel?: string;
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

export interface UsageCycleSample {
  series: UsageSeriesMetadata;
  remainingPercent: number;
  quantity?: { decimal: string; unit: AccountingUnit };
  resetAtMs?: number;
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
}

export interface UsageStore {
  readonly path: string;
  /** One full collector cycle; synchronous and single-transaction. */
  recordCycle(observation: UsageCycleObservation): void;
  query(span: { startMs: number; endMs: number }): UsageHistorySlice;
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
  "run_id, series_id, first_at_ms, last_at_ms, sample_count, remaining_percent, quantity_decimal, quantity_unit_json, reset_at_ms, linked, collector_run_id, collector_session_id, collector_interval_ms";

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
    ...(row.account_label !== null ? { accountLabel: row.account_label } : {}),
    ...(row.plan_label !== null ? { planLabel: row.plan_label } : {}),
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
    linked: row.linked === 1,
  };
}

function quantityParts(
  quantity: { decimal: string; unit: AccountingUnit } | undefined,
): [string | null, string | null] {
  return quantity === undefined ? [null, null] : [quantity.decimal, JSON.stringify(quantity.unit)];
}

function sameMeasurement(
  run: RunRow,
  remainingPercent: number,
  quantity: { decimal: string; unit: AccountingUnit } | undefined,
  resetAtMs: number | undefined,
): boolean {
  const [decimal, unitJson] = quantityParts(quantity);
  return (
    run.remaining_percent === remainingPercent &&
    run.quantity_decimal === decimal &&
    run.quantity_unit_json === unitJson &&
    run.reset_at_ms === (resetAtMs ?? null)
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
    conn.run(
      `INSERT INTO usage_series (
         series_id, card_id, row_key, provider_id, provider_label, account_label, plan_label,
         label, metric_json, measurement, source, first_at_ms, last_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(series_id) DO UPDATE SET
         provider_label = excluded.provider_label,
         account_label = excluded.account_label,
         plan_label = excluded.plan_label,
         label = excluded.label,
         metric_json = excluded.metric_json,
         measurement = excluded.measurement,
         source = excluded.source,
         first_at_ms = MIN(usage_series.first_at_ms, excluded.first_at_ms),
         last_at_ms = MAX(usage_series.last_at_ms, excluded.last_at_ms)`,
      [
        series.rowId,
        series.cardId,
        series.rowKey,
        series.providerId,
        series.providerLabel,
        series.accountLabel ?? null,
        series.planLabel ?? null,
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
    },
  ): void {
    const [decimal, unitJson] = quantityParts(sample.quantity);
    conn.run(
      `INSERT INTO usage_runs (
         series_id, first_at_ms, last_at_ms, sample_count, remaining_percent,
         quantity_decimal, quantity_unit_json, reset_at_ms, linked,
         collector_run_id, collector_session_id, collector_interval_ms
       ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sample.series.rowId,
        measuredAtMs,
        measuredAtMs,
        sample.remainingPercent,
        decimal,
        unitJson,
        sample.resetAtMs ?? null,
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
    sample: UsageCycleSample,
    measuredAtMs: number,
    observation: UsageCycleObservation,
    watermarks: Map<string, number>,
  ): boolean {
    // The previous run stores the poll interval that governed the gap after it.
    return (
      latest.collector_session_id === observation.collectorSessionId &&
      measuredAtMs > latest.last_at_ms &&
      measuredAtMs - latest.last_at_ms <= 2 * latest.collector_interval_ms &&
      interruptionWatermark(sample.series.cardId, watermarks) <= latest.last_at_ms
    );
  }

  /**
   * An out-of-order sample inside an identical-value run cannot be merged and
   * must not be dropped. The covering run is split at the new sample's time;
   * the original sample count is preserved as `1 + (count - 1)` because the
   * store only knows the run's endpoints, and the new sample becomes its own
   * point. Endpoint collisions are kept as a same-time point instead.
   */
  function splitCoveringRun(
    covering: RunRow,
    sample: UsageCycleSample,
    measuredAtMs: number,
    observation: UsageCycleObservation,
  ): void {
    if (measuredAtMs <= covering.first_at_ms || measuredAtMs >= covering.last_at_ms) {
      insertRun(sample, measuredAtMs, false, observation);
      return;
    }
    const rightCount = Math.max(1, covering.sample_count - 1);
    conn.run("UPDATE usage_runs SET last_at_ms = ?, sample_count = 1 WHERE run_id = ?", [
      measuredAtMs,
      covering.run_id,
    ]);
    conn.run(
      `INSERT INTO usage_runs (
         series_id, first_at_ms, last_at_ms, sample_count, remaining_percent,
         quantity_decimal, quantity_unit_json, reset_at_ms, linked,
         collector_run_id, collector_session_id, collector_interval_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        covering.series_id,
        measuredAtMs,
        covering.last_at_ms,
        rightCount,
        covering.remaining_percent,
        covering.quantity_decimal,
        covering.quantity_unit_json,
        covering.reset_at_ms,
        covering.collector_run_id,
        covering.collector_session_id,
        covering.collector_interval_ms,
      ],
    );
    insertRun(sample, measuredAtMs, false, observation);
  }

  function writeSample(
    sample: UsageCycleSample,
    observation: UsageCycleObservation,
    watermarks: Map<string, number>,
  ): void {
    if (!Number.isFinite(sample.remainingPercent) || !Number.isFinite(sample.measuredAtMs)) return;
    const measuredAtMs = Math.round(sample.measuredAtMs);
    upsertSeries(sample.series, measuredAtMs);

    // Fast path: an append-only sample newer than the latest run cannot be
    // covered by any run, so the covering lookup is only needed for replays
    // and out-of-order observations (D3).
    const latest = latestRun(sample.series.rowId);
    const covering =
      latest !== null && measuredAtMs <= latest.last_at_ms
        ? coveringRuns(sample.series.rowId, measuredAtMs)
        : [];
    if (
      covering.some((run) =>
        sameMeasurement(run, sample.remainingPercent, sample.quantity, sample.resetAtMs),
      )
    ) {
      return;
    }
    const interior = covering.find(
      (run) => run.first_at_ms < measuredAtMs && run.last_at_ms > measuredAtMs,
    );
    if (interior !== undefined) {
      splitCoveringRun(interior, sample, measuredAtMs, observation);
      return;
    }
    if (covering.length > 0) {
      insertRun(sample, measuredAtMs, false, observation);
      return;
    }

    const linked =
      latest !== null && isContinuous(latest, sample, measuredAtMs, observation, watermarks);
    if (
      latest !== null &&
      linked &&
      sameMeasurement(latest, sample.remainingPercent, sample.quantity, sample.resetAtMs) &&
      measuredAtMs > latest.last_at_ms
    ) {
      conn.run(
        "UPDATE usage_runs SET last_at_ms = ?, sample_count = sample_count + 1 WHERE run_id = ?",
        [measuredAtMs, latest.run_id],
      );
      return;
    }
    insertRun(sample, measuredAtMs, linked, observation);
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
      conn.run(
        "UPDATE usage_interruptions SET last_at_ms = ?, count = count + 1 WHERE interruption_id = ?",
        [atMs, last.interruption_id],
      );
      return;
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
      missing.set(series.card_id, { providerId: series.provider_id, atMs: card.atMs });
    }

    const providerIds = [...new Set(observation.providerIds)];
    if (providerIds.length > 0) {
      const dropped = conn.all<{ card_id: string; provider_id: string }>(
        `SELECT DISTINCT card_id, provider_id FROM usage_series WHERE provider_id IN (${placeholders(providerIds.length)})`,
        providerIds,
      );
      for (const series of dropped) {
        if (observedByCard.has(series.card_id) || interruptedCards.has(series.card_id)) continue;
        missing.set(series.card_id, { providerId: series.provider_id, atMs: observation.nowMs });
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
  }

  function query(span: { startMs: number; endMs: number }): UsageHistorySlice {
    const startMs = Math.min(span.startMs, span.endMs);
    const endMs = Math.max(span.startMs, span.endMs);
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
    };
  }

  return {
    path,
    recordCycle,
    query,
    close() {
      conn.close();
    },
  };
}

export async function openUsageStore(dbPath: string): Promise<UsageStore> {
  const conn = await openOpenCodeSqliteWritable(dbPath);
  try {
    migrate(conn);
  } catch (error) {
    conn.close();
    throw error;
  }
  return createStore(conn, dbPath);
}
