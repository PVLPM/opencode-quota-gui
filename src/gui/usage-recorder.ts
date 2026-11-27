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
  type UsageImporter,
  type UsageImportSettings,
  type UsageImportStatus,
} from "./usage-import-service.js";

const USAGE_HISTORY_FILE = "usage-history.sqlite";
const DEFAULT_INTERVAL_MS = 60_000;

export interface UsageRecorderOptions {
  /** Test seam: an already-open store; the recorder closes it with itself. */
  store?: UsageStore;
  /** Private state database path; defaults to the GUI state namespace. */
  path?: string;
  now?: () => number;
  logger?: GuiLogger;
  /** Settings seam for opt-in harness import; absent disables import entirely. */
  loadImportSettings?: () => Promise<UsageImportSettings>;
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

function cardMeasuredAt(
  card: ProviderCard,
  snapshot: QuotaSnapshot,
  measuredAtByCard: ReadonlyMap<string, number> | undefined,
): number {
  const observed = parseObservedAtMs(card);
  if (observed !== undefined) return observed;
  const fromCycle = measuredAtByCard?.get(card.cardId);
  if (fromCycle !== undefined && Number.isFinite(fromCycle)) return fromCycle;
  return snapshot.providers.polledAtMs;
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
  const accountLabel = label(card.accountLabel);
  const planLabel = label(card.planLabel);
  return {
    rowId: row.rowId,
    cardId: card.cardId,
    rowKey: rowKeyOf(card.cardId, row.rowId),
    providerId: card.providerId,
    providerLabel: label(card.providerLabel) ?? card.providerId,
    ...(accountLabel !== undefined ? { accountLabel } : {}),
    ...(planLabel !== undefined ? { planLabel } : {}),
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

function buildCycle(snapshot: QuotaSnapshot, nowMs: number): UsageCycleObservation {
  const cycle = quotaObservationCycle(snapshot);
  const samples: UsageCycleSample[] = [];
  const interruptions: UsageCycleInterruption[] = [];
  const observedCards: UsageCycleObservation["observedCards"][number][] = [];

  for (const card of snapshot.providers.cards) {
    const measuredAtMs = cardMeasuredAt(card, snapshot, cycle?.measuredAtByCard);
    observedCards.push({ cardId: card.cardId, providerId: card.providerId, atMs: measuredAtMs });

    const kind = interruptionKind(card);
    if (kind !== undefined) {
      interruptions.push({
        cardId: card.cardId,
        providerId: card.providerId,
        kind,
        atMs: measuredAtMs,
      });
      continue;
    }
    for (const row of card.rows) {
      if (!isEligiblePercentRow(row)) continue;
      samples.push({
        series: seriesFor(card, row),
        remainingPercent: row.percentRemaining as number,
        ...(row.quantity !== undefined
          ? { quantity: { decimal: row.quantity.decimal, unit: { ...row.quantity.unit } } }
          : {}),
        ...(row.resetAtIso !== undefined && Number.isFinite(Date.parse(row.resetAtIso))
          ? { resetAtMs: Date.parse(row.resetAtIso) }
          : {}),
        measuredAtMs,
      });
    }
  }

  const collectorRunId = cycle?.collectorRunId ?? `unmarked:${nowMs}:${Math.random()}`;
  return {
    collectorRunId,
    collectorSessionId: cycle?.collectorSessionId ?? collectorRunId,
    intervalMs:
      cycle !== undefined && Number.isFinite(cycle.intervalMs) && cycle.intervalMs > 0
        ? cycle.intervalMs
        : DEFAULT_INTERVAL_MS,
    observedCards,
    providerIds: cycle?.providerIds ?? [],
    samples,
    interruptions,
    nowMs,
  };
}

export function createUsageRecorder(options: UsageRecorderOptions = {}): UsageRecorder {
  const logger = options.logger ?? createGuiLogger();
  const now = options.now ?? Date.now;
  const path = options.path ?? getGuiPrivateStatePath(USAGE_HISTORY_FILE);
  let storePromise: Promise<UsageStore> | undefined;
  let openWarned = false;
  let writeWarned = false;
  let sourceEpoch = 0;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  let importChain: Promise<void> = Promise.resolve();

  function store(): Promise<UsageStore> {
    if (storePromise === undefined) {
      storePromise =
        options.store !== undefined ? Promise.resolve(options.store) : openUsageStore(path);
    }
    return storePromise;
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
      .catch(() => {
        logger.warn("usage import failed", "import-failed");
      });
  }

  async function capture(snapshot: QuotaSnapshot, epoch: number): Promise<number | undefined> {
    if (closed || epoch !== sourceEpoch) return undefined;
    if (!isLiveQuotaObservation(snapshot)) return undefined;

    let target: UsageStore;
    try {
      target = await store();
    } catch {
      if (!openWarned) {
        openWarned = true;
        logger.warn("usage history unavailable", "store-unavailable");
      }
      return undefined;
    }
    if (closed || epoch !== sourceEpoch) return undefined;

    const cycle = buildCycle(snapshot, now());
    try {
      target.recordCycle(cycle);
    } catch {
      if (!writeWarned) {
        writeWarned = true;
        logger.warn("usage history write failed", "write-failed");
      }
    }
    return cycle.intervalMs;
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
        return Promise.resolve({
          intervals: query.intervals.map((interval) => ({
            startMs: interval.startMs,
            endMs: interval.endMs,
            entries: [],
            incomplete: false,
            unpricedTokens: 0,
            unknownTokens: 0,
          })),
        });
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
      await importChain;
      await importer?.flush();
    },

    async close() {
      if (closed) return;
      closed = true;
      sourceEpoch += 1;
      await chain;
      await importChain;
      await importer?.flush();
      const pending = storePromise;
      storePromise = undefined;
      if (pending === undefined) return;
      try {
        (await pending).close();
      } catch {
        // an already-failed store has nothing useful to report
      }
    },
  };
}
