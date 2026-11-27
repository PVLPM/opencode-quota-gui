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
import { sanitizeSingleLineDisplayText } from "../lib/display-sanitize.js";
import { getGuiPrivateStatePath } from "../lib/private-state-paths.js";
import {
  openUsageStore,
  type UsageCycleInterruption,
  type UsageCycleObservation,
  type UsageCycleSample,
  type UsageSeriesMetadata,
  type UsageStore,
} from "../lib/usage-store.js";
import { createGuiLogger, type GuiLogger } from "./log.js";
import { isLiveQuotaObservation, quotaObservationCycle } from "./quota-observation.js";

export const USAGE_HISTORY_FILE = "usage-history.sqlite";
const DEFAULT_INTERVAL_MS = 60_000;

export interface UsageRecorderOptions {
  /** Test seam: an already-open store; the recorder closes it with itself. */
  store?: UsageStore;
  /** Private state database path; defaults to the GUI state namespace. */
  path?: string;
  now?: () => number;
  logger?: GuiLogger;
}

export interface UsageRecorder {
  /** Queue one observation of a completed quota source cycle. Never rejects. */
  observe(snapshot: QuotaSnapshot, epoch?: number): void;
  /** Current source generation, captured before an asynchronous source read. */
  epoch(): number;
  /** The host's active source changed; queued observations are discarded. */
  sourceChanged(): void;
  /** Resolves after every queued observation finished. */
  flush(): Promise<void>;
  /** Stop accepting observations, wait for the chain, then close the store. */
  close(): Promise<void>;
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

  function store(): Promise<UsageStore> {
    if (storePromise === undefined) {
      storePromise =
        options.store !== undefined ? Promise.resolve(options.store) : openUsageStore(path);
    }
    return storePromise;
  }

  async function capture(snapshot: QuotaSnapshot, epoch: number): Promise<void> {
    if (closed || epoch !== sourceEpoch) return;
    if (!isLiveQuotaObservation(snapshot)) return;

    let target: UsageStore;
    try {
      target = await store();
    } catch {
      if (!openWarned) {
        openWarned = true;
        logger.warn("usage history unavailable", "store-unavailable");
      }
      return;
    }
    if (closed || epoch !== sourceEpoch) return;

    try {
      target.recordCycle(buildCycle(snapshot, now()));
    } catch {
      if (!writeWarned) {
        writeWarned = true;
        logger.warn("usage history write failed", "write-failed");
      }
    }
  }

  return {
    observe(snapshot, capturedEpoch) {
      if (closed) return;
      const epoch = capturedEpoch ?? sourceEpoch;
      chain = chain
        .then(() => capture(snapshot, epoch))
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

    flush() {
      return chain;
    },

    async close() {
      if (closed) return;
      closed = true;
      sourceEpoch += 1;
      await chain;
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
