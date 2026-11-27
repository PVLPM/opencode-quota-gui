/**
 * Capture hook for local quota usage history (v1.4.0 workstream B, D1/D2/D11).
 *
 * The host runtime calls `observe` next to the quota notification observer with
 * the same captured source epoch. Only a live source cycle records: cached
 * replays and retained/error/cooldown cards produce evidence, never samples.
 * Writes are serialized on one chain and never block or reject the quota read.
 */
import type { ProviderCard, QuotaCardRow, QuotaSnapshot } from "../contracts/dashboard.js";
import type { UsageMeasurementKind } from "../contracts/usage.js";
import type { UsageActivityQuery, UsageActivityResult } from "../contracts/usage-activity.js";
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import { getGuiPrivateStatePath } from "../lib/private-state-paths.js";
import {
  openUsageStore,
  USAGE_IMPORT_HARNESSES,
  type UsageCycleInterruption,
  type UsageCycleObservation,
  type UsageCycleSample,
  type UsageImportHarness,
  type UsageSeriesMetadata,
  type UsageStore,
} from "../lib/usage-store.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import { isLiveQuotaObservation, quotaObservationCycle } from "./quota-observation.js";
import {
  createUsageImporter,
  emptyImportedActivity,
  type UsageImporter,
  type UsageImportSettings,
  type UsageImportStatus,
} from "./usage-import-service.js";

export const USAGE_HISTORY_FILE = "usage-history.sqlite";
const DEFAULT_INTERVAL_MS = 60_000;

/** Keep the host event loop responsive when another process holds the write lock. */
const USAGE_STORE_BUSY_TIMEOUT_MS = 250;
/** Bounded carry-over: a small number of cycles can wait for the lock. */
const CARRY_OVER_LIMIT = 8;

export interface UsageRecorderOptions {
  /** Test seam: an already-open store; the recorder closes it with itself. */
  store?: UsageStore;
  /** Private state database path; defaults to the GUI state namespace. */
  path?: string;
  now?: () => number;
  logger?: GuiLogger;
  /** Settings seam for opt-in harness import; absent disables import entirely. */
  loadImportSettings?: () => Promise<UsageImportSettings>;
  /** The import opportunity finished; cached Usage reads may now be stale. */
  onActivityImported?: () => void;
  /** Test seam: config root per harness; production resolves env/home. */
  importRootFor?: (harness: UsageImportHarness) => string | undefined;
}

export interface UsageRecorder {
  /** Queue one observation of a completed quota source cycle. Never rejects. */
  observe(snapshot: QuotaSnapshot, epoch?: number): void;
  /** Current source generation, captured before an asynchronous source read. */
  epoch(): number;
  /** The host's active source changed; queued observations are discarded. */
  sourceChanged(): void;
  /** Resolves after every queued observation and import run finished. */
  flush(): Promise<void>;
  /** Stop accepting observations, wait for the chain, then close the store. */
  close(): Promise<void>;
  /** Persist hashed host-native Claude Agent ids for import exclusion. */
  recordClaudeOwnership(sessionId: string, messageId: string): void;
  /** Enabled/disabled and last outcome for the Usage snapshot builder. */
  importStatus(): Promise<UsageImportStatus[]>;
  /** Priced imported Claude Code / Codex activity for the enabled harnesses. */
  queryImportedActivity(query: UsageActivityQuery): Promise<UsageActivityResult>;
}

function label(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = sanitizeSingleLineDisplayText(value).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

function measurementKind(providerId: string): UsageMeasurementKind {
  // Cursor's observation time is local compute time, not a provider reading.
  return providerId === "cursor" ? "locally-estimated" : "provider-observed";
}

function parseObservedAtMs(card: ProviderCard): number | undefined {
  if (card.observedAtIso === undefined) return undefined;
  const parsed = Date.parse(card.observedAtIso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A genuine measurement mark only. There is deliberately no clock or poll-time
 * fallback: an unmarked success is rejected instead of being recorded as if it
 * had been measured now.
 */
function cardMeasuredAt(
  card: ProviderCard,
  cycle: ReturnType<typeof quotaObservationCycle>,
): number | undefined {
  const observed = parseObservedAtMs(card);
  if (observed !== undefined) return observed;
  const fromCycle = cycle?.measuredAtByCard.get(card.cardId);
  return fromCycle !== undefined && Number.isFinite(fromCycle) ? fromCycle : undefined;
}

function isEligiblePercentRow(row: QuotaCardRow): boolean {
  return (
    row.kind === "percent" &&
    (row.resultType === "quota" || row.resultType === "rate_limit") &&
    typeof row.percentRemaining === "number" &&
    Number.isFinite(row.percentRemaining)
  );
}

function rowKeyOf(cardId: string, rowId: string): string {
  return rowId.startsWith(`${cardId}#`) ? rowId.slice(cardId.length + 1) : rowId;
}

function seriesFor(card: ProviderCard, row: QuotaCardRow): UsageSeriesMetadata {
  return {
    rowId: row.rowId,
    cardId: card.cardId,
    rowKey: rowKeyOf(card.cardId, row.rowId),
    providerId: card.providerId,
    providerLabel: label(card.providerLabel) ?? card.providerId,
    // Account and plan labels are identity-bearing; schema v4 never stores them.
    label: label(row.label) ?? row.rowId,
    ...(row.metric !== undefined ? { metricJson: JSON.stringify(row.metric) } : {}),
    measurement: measurementKind(card.providerId),
    source: "opencode-poll",
  };
}

function interruptionKind(card: ProviderCard): UsageCycleInterruption["kind"] | undefined {
  if (card.stale === true) return "retained";
  const errors = card.errors.filter((error) => error.kind !== "intentional-filter");
  if (errors.length === 0) return undefined;
  return errors.some(
    (error) => error.attemptOutcome === "cooldown" || error.attemptOutcome === "reuse",
  )
    ? "cooldown"
    : "error";
}

function buildCycle(
  snapshot: QuotaSnapshot,
  cycle: NonNullable<ReturnType<typeof quotaObservationCycle>>,
  nowMs: number,
): { observation: UsageCycleObservation; unmarkedSamples: number } {
  const samples: UsageCycleSample[] = [];
  const interruptions: UsageCycleInterruption[] = [];
  const observedCards: UsageCycleObservation["observedCards"][number][] = [];
  let unmarkedSamples = 0;

  for (const card of snapshot.providers.cards) {
    const measuredAtMs = cardMeasuredAt(card, cycle);
    const attemptAtMs = cycle.attemptedAtMs;
    observedCards.push({
      cardId: card.cardId,
      providerId: card.providerId,
      atMs: measuredAtMs ?? attemptAtMs,
    });

    const kind = interruptionKind(card);
    if (kind !== undefined) {
      interruptions.push({
        cardId: card.cardId,
        providerId: card.providerId,
        kind,
        atMs: attemptAtMs,
      });
      continue;
    }
    if (measuredAtMs === undefined) {
      unmarkedSamples += 1;
      continue;
    }
    for (const row of card.rows) {
      if (!isEligiblePercentRow(row)) continue;
      const resetPrecision = cycle.resetPrecisionByRow?.get(row.rowId);
      const capacityKey = cycle.capacityKeyByRow?.get(row.rowId);
      samples.push({
        series: seriesFor(card, row),
        remainingPercent: row.percentRemaining as number,
        ...(row.quantity !== undefined
          ? { quantity: { decimal: row.quantity.decimal, unit: { ...row.quantity.unit } } }
          : {}),
        ...(row.resetAtIso !== undefined && Number.isFinite(Date.parse(row.resetAtIso))
          ? { resetAtMs: Date.parse(row.resetAtIso) }
          : {}),
        ...(resetPrecision !== undefined ? { resetPrecision } : {}),
        ...(capacityKey !== undefined ? { capacityKey } : {}),
        measuredAtMs,
      });
    }
  }

  return {
    observation: {
      collectorRunId: cycle.collectorRunId,
      collectorSessionId: cycle.collectorSessionId,
      intervalMs:
        Number.isFinite(cycle.intervalMs) && cycle.intervalMs > 0
          ? cycle.intervalMs
          : DEFAULT_INTERVAL_MS,
      attemptedAtMs: cycle.attemptedAtMs,
      observedCards,
      providerIds: cycle.providerIds,
      samples,
      interruptions,
      nowMs,
    },
    unmarkedSamples,
  };
}

export function createUsageRecorder(options: UsageRecorderOptions = {}): UsageRecorder {
  const logger = options.logger ?? createGuiLogger();
  const now = options.now ?? Date.now;
  const path = options.path ?? getGuiPrivateStatePath(USAGE_HISTORY_FILE);
  let storePromise: Promise<UsageStore> | undefined;
  let openWarned = false;
  let writeWarned = false;
  let busyWarned = false;
  let measurementWarned = false;
  let sourceEpoch = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let chain: Promise<void> = Promise.resolve();
  let importChain: Promise<void> = Promise.resolve();
  // Every valid observation is queued before the store is opened or drained.
  // A held write lock (or a lock during open) therefore delays a cycle instead
  // of dropping it; overflow discards the oldest cycle with an explicit code.
  const pending: { observation: UsageCycleObservation; epoch: number }[] = [];

  function store(): Promise<UsageStore> {
    if (storePromise === undefined) {
      const opened =
        options.store !== undefined
          ? Promise.resolve(options.store)
          : openUsageStore(path, { busyTimeoutMs: USAGE_STORE_BUSY_TIMEOUT_MS });
      let pending: Promise<UsageStore>;
      pending = opened.catch((error: unknown) => {
        // A failed open is retried by a later observation; never memoize the
        // rejection for the recorder's whole lifetime.
        if (storePromise === pending) storePromise = undefined;
        throw error;
      });
      storePromise = pending;
    }
    return storePromise;
  }

  function isLockError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : "";
    const code = (error as { code?: unknown; errcode?: unknown } | null)?.code;
    const errcode = (error as { errcode?: unknown } | null)?.errcode;
    return (
      errcode === 5 ||
      code === "SQLITE_BUSY" ||
      /SQLITE_BUSY|database is locked|database table is locked/i.test(message)
    );
  }

  function warnBusy(): void {
    if (busyWarned) return;
    busyWarned = true;
    logger.warn("usage history write deferred", "write-busy");
  }

  function enqueuePending(cycle: UsageCycleObservation, epoch: number): void {
    if (pending.some((item) => item.observation.collectorRunId === cycle.collectorRunId)) return;
    if (pending.length >= CARRY_OVER_LIMIT) {
      pending.shift();
      logger.warn("usage history carry-over dropped", "carry-over-dropped");
    }
    pending.push({ observation: cycle, epoch });
  }

  /** A new owner inherited the source: its predecessor's cycles must never land. */
  function discardPreviousOwnerCycles(): void {
    let dropped = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      if ((pending[index] as { epoch: number }).epoch === sourceEpoch) continue;
      pending.splice(index, 1);
      dropped = true;
    }
    if (dropped) logger.warn("usage history cycles discarded after handoff", "carry-over-handoff");
  }

  function recordPending(target: UsageStore): boolean {
    while (pending.length > 0) {
      const next = pending[0] as { observation: UsageCycleObservation; epoch: number };
      if (next.epoch !== sourceEpoch) {
        pending.shift();
        logger.warn("usage history cycle discarded after handoff", "carry-over-handoff");
        continue;
      }
      try {
        target.recordCycle(next.observation);
      } catch (error) {
        if (isLockError(error)) {
          warnBusy();
          return false;
        }
        pending.shift();
        if (!writeWarned) {
          writeWarned = true;
          logger.warn("usage history write failed", "write-failed");
        }
        continue;
      }
      pending.shift();
    }
    return true;
  }

  const importer: UsageImporter | undefined =
    options.loadImportSettings === undefined
      ? undefined
      : createUsageImporter({
          store,
          loadSettings: options.loadImportSettings,
          ...(options.importRootFor !== undefined ? { rootFor: options.importRootFor } : {}),
          now,
          logger,
        });

  function scheduleImport(intervalMs: number): void {
    if (importer === undefined || closed) return;
    importChain = importChain
      .then(() => importer.maybeRun(intervalMs))
      .then(() => {
        options.onActivityImported?.();
      })
      .catch(() => {
        logger.warn("usage import failed", "import-failed");
      });
  }

  async function capture(snapshot: QuotaSnapshot, epoch: number): Promise<number | undefined> {
    if (closed || epoch !== sourceEpoch) return undefined;
    if (!isLiveQuotaObservation(snapshot)) return undefined;
    const cycle = quotaObservationCycle(snapshot);
    if (cycle === undefined) {
      if (!measurementWarned) {
        measurementWarned = true;
        logger.warn("usage measurement unmarked; sample rejected", "measurement-unmarked");
      }
      return undefined;
    }

    const { observation, unmarkedSamples } = buildCycle(snapshot, cycle, now());
    if (unmarkedSamples > 0 && !measurementWarned) {
      measurementWarned = true;
      logger.warn("usage measurement unmarked; sample rejected", "measurement-unmarked");
    }
    // Queue before opening: a lock during open delays this cycle instead of
    // losing it (the next observation or a later flush drains the FIFO).
    enqueuePending(observation, epoch);

    let target: UsageStore;
    try {
      target = await store();
    } catch {
      if (!openWarned) {
        openWarned = true;
        logger.warn("usage history unavailable", "store-unavailable");
      }
      return observation.intervalMs;
    }
    if (closed || epoch !== sourceEpoch) return observation.intervalMs;
    recordPending(target);
    return observation.intervalMs;
  }

  return {
    observe(snapshot, capturedEpoch) {
      if (closed) return;
      const epoch = capturedEpoch ?? sourceEpoch;
      chain = chain
        .then(async () => {
          const intervalMs = await capture(snapshot, epoch);
          if (intervalMs !== undefined) scheduleImport(intervalMs);
        })
        .catch(() => {
          logger.warn("usage observation failed", "capture-failed");
        });
    },

    epoch() {
      return sourceEpoch;
    },

    sourceChanged() {
      sourceEpoch += 1;
      discardPreviousOwnerCycles();
    },

    recordClaudeOwnership(sessionId, messageId) {
      if (closed || importer === undefined) return;
      importer.recordClaudeOwnership(sessionId, messageId);
    },

    importStatus() {
      if (importer === undefined) {
        return Promise.resolve(
          USAGE_IMPORT_HARNESSES.map((harness) => ({
            harness,
            enabled: false,
            status: "disabled" as const,
          })),
        );
      }
      return importer.status();
    },

    queryImportedActivity(query) {
      if (importer === undefined) {
        return Promise.resolve(emptyImportedActivity(query));
      }
      return importer.queryActivity(query, USAGE_IMPORT_HARNESSES);
    },

    async flush() {
      // `scheduleImport` extends `importChain` while `chain` settles, so wait
      // for the observation chain first, then for the import it queued.
      let pendingChain = chain;
      do {
        await pendingChain;
        pendingChain = chain;
      } while (pendingChain !== chain);
      if (pending.length > 0) {
        try {
          await store().then((target) => {
            recordPending(target);
          });
        } catch {
          // the next observation retries the open
        }
      }
      await importChain;
      await importer?.flush();
    },

    close() {
      if (closing !== undefined) return closing;
      closing = (async () => {
        closed = true;
        sourceEpoch += 1;
        await chain;
        await importChain;
        await importer?.flush();
        const pendingStore = storePromise;
        storePromise = undefined;
        if (pendingStore === undefined) return;
        let target: UsageStore | undefined;
        try {
          target = await pendingStore;
        } catch {
          return;
        }
        // Close drains queued cycles once. Anything still locked belongs to
        // another process and is discarded with an explicit code (the store
        // stays durable; only this bounded in-memory carry-over is lost).
        recordPending(target);
        if (pending.length > 0) {
          pending.length = 0;
          logger.warn("usage history carry-over discarded at close", "carry-over-discarded");
        }
        try {
          target.close();
        } catch {
          // an already-failed store has nothing useful to report
        }
      })();
      return closing;
    },
  };
}
