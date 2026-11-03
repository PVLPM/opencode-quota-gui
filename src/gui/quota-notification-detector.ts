/**
 * Pure quota notification transition detector for the native GUI host.
 *
 * The detector observes normalized, already-projected quota cards and returns
 * notifications plus the next in-memory state. It performs no I/O, starts no
 * timers, polls nothing, and never mutates its inputs. The caller owns the
 * clock, settings, hidden-id lists, persistence and delivery.
 *
 * Policy (owner-approved best effort):
 * - Exactly four event kinds: `low`, `exhausted`, `reset`, `provider-error`.
 * - Only semantic percent-remaining rows with result type `quota` or
 *   `rate_limit` are eligible. Display labels, messages and raw values are
 *   never parsed.
 * - `low`: previous remaining > threshold and current <= threshold. Direct
 *   zero exhaustion is never reported as low.
 * - `exhausted`: previous remaining > 0 and current <= 0.
 * - `reset`: reuses the exported `updateObservation` from
 *   `src/lib/quota-reset-notifications.ts`, including its proven 24-hour
 *   transition-age guard.
 * - `provider-error`: a proven healthy -> error transition, only when the
 *   caller supplies safe structured failure provenance. Error labels and
 *   messages are never inspected.
 * - Cooldown always applies to the exact fingerprint and is never bypassed.
 * - First startup and newly visible cards or rows silently baseline.
 *
 * Fingerprints:
 * - low/exhausted: kind + card + row.
 * - reset: kind + card + row + reset boundary.
 * - provider-error: kind + card + safe category.
 *
 * Integration seam (not implemented here): the host quota observer maps each
 * visible `ProviderCard` to `QuotaNotificationCardObservation`. `ProviderCard`
 * is structurally assignable because its rows and structured errors already
 * match the normalized observation; pass the card through unchanged.
 * `ProviderCard.errors` carries the optional source-assigned
 * `failureCategory`; only `failureCategory === "provider_api"` is notifiable,
 * and absent or unknown categories fail closed. Error labels and messages are
 * never inspected.
 *
 * Reset-window selection (`resetNotifications.windows`) is caller policy and is
 * not applied here: every supplied semantic percent row with a valid reset
 * boundary is reset-eligible. If configured-window filtering is required,
 * extend this seam with a caller-supplied predicate rather than hard-coding
 * settings in the detector.
 *
 * Detector rows/providers are memory-only and should not be persisted across
 * process starts; a restart then re-baselines silently. The returned
 * `cooldowns` map is the only piece the caller should persist.
 */
import { createHash } from "node:crypto";

import { isCardHidden } from "../contracts/card-visibility.js";
import type { QuotaCardRow } from "../contracts/dashboard.js";
import type { ProviderFailureCategory } from "../contracts/provider-failure.js";
import {
  MAX_TRANSITION_AGE_MS,
  type ResetObservation,
  updateObservation as updateLegacyResetObservation,
} from "../lib/quota-reset-notifications.js";

export const QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION = 1 as const;

/** Shared proven reset-transition age limit re-exported for detector consumers. */
export const RESET_TRANSITION_MAX_AGE_MS = MAX_TRANSITION_AGE_MS;

/**
 * The only provider failure category that may produce a `provider-error`
 * notification. It must come from structured provenance, never display text.
 */
export const QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY = "provider_api" as const;

export type QuotaNotificationProviderFailureCategory =
  typeof QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY;

const FINGERPRINT_DOMAIN = "ocq-quota-notification-v1";

export type QuotaNotificationKind = "low" | "exhausted" | "reset" | "provider-error";

interface QuotaNotificationBase {
  /** Deterministic event identity used for cooldown and delivery dedupe. */
  fingerprint: string;
  cardId: string;
  providerId: string;
  /** Display-only context; never part of `fingerprint`. */
  providerLabel: string;
  /** Display-only context; never part of `fingerprint`. */
  accountLabel?: string;
  observedAtMs: number;
}

export interface QuotaLowNotification extends QuotaNotificationBase {
  kind: "low";
  rowId: string;
  /** Display-only context; never part of `fingerprint`. */
  rowLabel: string;
  thresholdPercent: number;
  percentRemaining: number;
  /** Present only when the current row carried a valid reset boundary. */
  resetAtIso?: string;
}

export interface QuotaExhaustedNotification extends QuotaNotificationBase {
  kind: "exhausted";
  rowId: string;
  /** Display-only context; never part of `fingerprint`. */
  rowLabel: string;
  percentRemaining: number;
  /** Present only when the current row carried a valid reset boundary. */
  resetAtIso?: string;
}

export interface QuotaResetNotification extends QuotaNotificationBase {
  kind: "reset";
  rowId: string;
  rowLabel: string;
  percentRemaining: number;
  /** The new boundary that proved the reset. */
  resetAtIso: string;
  /** The previous boundary that had not passed when the proof was captured. */
  previousResetAtIso: string;
}

export interface QuotaProviderErrorNotification extends QuotaNotificationBase {
  kind: "provider-error";
  category: QuotaNotificationProviderFailureCategory;
}

export type QuotaNotification =
  | QuotaLowNotification
  | QuotaExhaustedNotification
  | QuotaResetNotification
  | QuotaProviderErrorNotification;

/** One normalized semantic quota row. `QuotaCardRow` is structurally assignable. */
export interface QuotaNotificationRowObservation {
  rowId: string;
  label: string;
  kind: QuotaCardRow["kind"];
  resultType: QuotaCardRow["resultType"];
  percentRemaining?: number;
  resetAtIso?: string;
}

/**
 * One normalized visible card. `ProviderCard` is structurally assignable; its
 * structured errors are passed through unchanged.
 */
export interface QuotaNotificationCardObservation {
  cardId: string;
  providerId: string;
  providerLabel: string;
  accountLabel?: string;
  /** Bare provider-scope hash used by normalized legacy hidden-card semantics. */
  providerScopeHash?: string;
  rows: readonly QuotaNotificationRowObservation[];
  errors?: readonly QuotaNotificationProviderErrorObservation[];
}

/** Only the safe structured category is read; labels and messages are ignored. */
export interface QuotaNotificationProviderErrorObservation {
  failureCategory?: ProviderFailureCategory;
}

/** Unknown or absent categories are never notifiable. */
export function isNotifiableProviderError(
  error: QuotaNotificationProviderErrorObservation,
): boolean {
  return error.failureCategory === QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY;
}

/** Exact reset observation shared with the legacy notifier. */
export type QuotaNotificationResetObservation = ResetObservation;

export interface QuotaNotificationRowState {
  /** Latest percent reading; drives low/exhausted independently of reset proof. */
  percentRemaining: number;
  /** Latest observation time for the percent reading. */
  observedAtMs: number;
  /** Present once the row has supplied a valid reset boundary. */
  reset?: QuotaNotificationResetObservation;
}

export interface QuotaNotificationProviderState {
  status: "healthy" | "error";
  observedAtMs: number;
}

/** Memory-only detector state. Do not persist rows/providers across restarts. */
export interface QuotaNotificationDetectorState {
  version: typeof QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION;
  rows: Record<string, QuotaNotificationRowState>;
  providers: Record<string, QuotaNotificationProviderState>;
}

export interface DetectQuotaNotificationsInput {
  cards: readonly QuotaNotificationCardObservation[];
  /** Effective `dashboard.hiddenCards` values. */
  hiddenCards?: readonly string[];
  /** Effective `dashboard.hiddenRows` values. */
  hiddenRows?: readonly string[];
  /** Previous in-memory result state. */
  state?: QuotaNotificationDetectorState;
  /** Caller-persisted fingerprint -> last emitted epoch milliseconds. */
  cooldowns?: Readonly<Record<string, number>>;
  /** Injectable clock supplied by the caller. */
  nowMs: number;
  /** Caller/settings-supplied low threshold. The detector owns no default. */
  lowThresholdPercent: number;
  /** Caller/settings-supplied cooldown. The detector owns no default. */
  cooldownMs: number;
}

export interface DetectQuotaNotificationsResult {
  notifications: QuotaNotification[];
  state: QuotaNotificationDetectorState;
  /** Next cooldown map for the caller to persist. */
  cooldowns: Record<string, number>;
}

type ResetCandidate = Omit<ResetObservation, "notifiedResetAtMs">;

/**
 * Deterministic notification identity. Labels, percentages, display text and
 * the observation clock are excluded.
 */
export function quotaNotificationFingerprint(
  input:
    | { kind: "low" | "exhausted"; cardId: string; rowId: string }
    | { kind: "reset"; cardId: string; rowId: string; resetAtIso: string }
    | {
        kind: "provider-error";
        cardId: string;
        category: QuotaNotificationProviderFailureCategory;
      },
): string {
  const parts = [FINGERPRINT_DOMAIN, input.kind, input.cardId];
  if (input.kind === "provider-error") {
    parts.push(input.category);
  } else if (input.kind === "reset") {
    const resetAtMs = Date.parse(input.resetAtIso);
    parts.push(input.rowId, Number.isFinite(resetAtMs) ? String(resetAtMs) : input.resetAtIso);
  } else {
    parts.push(input.rowId);
  }
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex");
}

function rowStateKey(cardId: string, rowId: string): string {
  return `${cardId}\u001f${rowId}`;
}

function parseResetAtMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const resetAtMs = Date.parse(value);
  return Number.isFinite(resetAtMs) ? resetAtMs : undefined;
}

function makeResetObservation(
  current: ResetCandidate,
  notifiedResetAtMs?: number,
): QuotaNotificationResetObservation {
  return {
    resetAtMs: current.resetAtMs,
    percentRemaining: current.percentRemaining,
    observedAtMs: current.observedAtMs,
    ...(notifiedResetAtMs !== undefined ? { notifiedResetAtMs } : {}),
  };
}

function cloneResetObservation(
  observation: QuotaNotificationResetObservation,
): QuotaNotificationResetObservation {
  return makeResetObservation(observation, observation.notifiedResetAtMs);
}

function makeRowState(
  percentRemaining: number,
  observedAtMs: number,
  reset?: QuotaNotificationResetObservation,
): QuotaNotificationRowState {
  return {
    percentRemaining,
    observedAtMs,
    ...(reset !== undefined ? { reset } : {}),
  };
}

function cloneRowState(state: QuotaNotificationRowState): QuotaNotificationRowState {
  return makeRowState(
    state.percentRemaining,
    state.observedAtMs,
    state.reset ? cloneResetObservation(state.reset) : undefined,
  );
}

function notificationBase(
  card: QuotaNotificationCardObservation,
  fingerprint: string,
  observedAtMs: number,
): QuotaNotificationBase {
  return {
    fingerprint,
    cardId: card.cardId,
    providerId: card.providerId,
    providerLabel: card.providerLabel,
    ...(card.accountLabel !== undefined ? { accountLabel: card.accountLabel } : {}),
    observedAtMs,
  };
}

function isEligiblePercentRow(
  row: QuotaNotificationRowObservation,
): row is QuotaNotificationRowObservation & {
  percentRemaining: number;
} {
  return (
    row.kind === "percent" &&
    (row.resultType === "quota" || row.resultType === "rate_limit") &&
    typeof row.percentRemaining === "number" &&
    Number.isFinite(row.percentRemaining)
  );
}

export function detectQuotaNotifications(
  input: DetectQuotaNotificationsInput,
): DetectQuotaNotificationsResult {
  const nowMs = input.nowMs;
  const hiddenCards = new Set(input.hiddenCards ?? []);
  const hiddenRows = new Set(input.hiddenRows ?? []);
  const previousState =
    input.state?.version === QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION ? input.state : undefined;
  const cooldowns: Record<string, number> = { ...(input.cooldowns ?? {}) };
  const notifications: QuotaNotification[] = [];
  const nextRows = new Map<string, QuotaNotificationRowState>();
  const nextProviders = new Map<string, QuotaNotificationProviderState>();
  const seenCards = new Set<string>();

  const emit = (fingerprint: string, notification: QuotaNotification): boolean => {
    const lastAtMs = cooldowns[fingerprint];
    if (lastAtMs !== undefined && nowMs - lastAtMs < input.cooldownMs) return false;
    notifications.push(notification);
    cooldowns[fingerprint] = nowMs;
    return true;
  };

  for (const card of input.cards) {
    if (seenCards.has(card.cardId) || isCardHidden(card, hiddenCards)) continue;
    seenCards.add(card.cardId);

    for (const row of card.rows) {
      if (hiddenRows.has(row.rowId)) continue;
      if (!isEligiblePercentRow(row)) continue;

      const key = rowStateKey(card.cardId, row.rowId);
      // A duplicate observation cannot be attributed safely; first occurrence wins.
      if (nextRows.has(key)) continue;

      const currentPercent = row.percentRemaining;
      const resetAtMs = parseResetAtMs(row.resetAtIso);
      const normalizedResetAtIso =
        resetAtMs !== undefined ? new Date(resetAtMs).toISOString() : undefined;
      const currentReset: ResetCandidate | undefined =
        resetAtMs !== undefined
          ? {
              resetAtMs,
              percentRemaining: currentPercent,
              observedAtMs: nowMs,
            }
          : undefined;

      const previousRow = previousState?.rows[key];

      if (!previousRow) {
        nextRows.set(
          key,
          makeRowState(
            currentPercent,
            nowMs,
            currentReset ? makeResetObservation(currentReset) : undefined,
          ),
        );
        continue;
      }

      if (nowMs < previousRow.observedAtMs) {
        nextRows.set(key, cloneRowState(previousRow));
        continue;
      }

      let resetObservation = previousRow.reset
        ? cloneResetObservation(previousRow.reset)
        : undefined;
      let resetEvent: { previousResetAtMs: number; resetAtMs: number } | undefined;

      if (previousRow.reset && currentReset) {
        const update = updateLegacyResetObservation(previousRow.reset, currentReset, nowMs);
        resetObservation = cloneResetObservation(update.observation);
        if (update.notify) {
          resetEvent = {
            previousResetAtMs: previousRow.reset.resetAtMs,
            resetAtMs: currentReset.resetAtMs,
          };
        }
      } else if (currentReset) {
        // First reset boundary for this row: silently baseline it.
        resetObservation = makeResetObservation(currentReset);
      }

      nextRows.set(key, makeRowState(currentPercent, nowMs, resetObservation));

      if (resetEvent) {
        const resetAtIso = new Date(resetEvent.resetAtMs).toISOString();
        const fingerprint = quotaNotificationFingerprint({
          kind: "reset",
          cardId: card.cardId,
          rowId: row.rowId,
          resetAtIso,
        });
        emit(fingerprint, {
          ...notificationBase(card, fingerprint, nowMs),
          kind: "reset",
          rowId: row.rowId,
          rowLabel: row.label,
          percentRemaining: currentPercent,
          resetAtIso,
          previousResetAtIso: new Date(resetEvent.previousResetAtMs).toISOString(),
        });
        continue;
      }

      const previousPercent = previousRow.percentRemaining;
      if (previousPercent > 0 && currentPercent <= 0) {
        const fingerprint = quotaNotificationFingerprint({
          kind: "exhausted",
          cardId: card.cardId,
          rowId: row.rowId,
        });
        emit(fingerprint, {
          ...notificationBase(card, fingerprint, nowMs),
          kind: "exhausted",
          rowId: row.rowId,
          rowLabel: row.label,
          percentRemaining: currentPercent,
          ...(normalizedResetAtIso !== undefined ? { resetAtIso: normalizedResetAtIso } : {}),
        });
        continue;
      }

      if (
        previousPercent > input.lowThresholdPercent &&
        currentPercent <= input.lowThresholdPercent
      ) {
        const fingerprint = quotaNotificationFingerprint({
          kind: "low",
          cardId: card.cardId,
          rowId: row.rowId,
        });
        emit(fingerprint, {
          ...notificationBase(card, fingerprint, nowMs),
          kind: "low",
          rowId: row.rowId,
          rowLabel: row.label,
          thresholdPercent: input.lowThresholdPercent,
          percentRemaining: currentPercent,
          ...(normalizedResetAtIso !== undefined ? { resetAtIso: normalizedResetAtIso } : {}),
        });
      }
    }

    const previousProvider = previousState?.providers[card.cardId];
    if (previousProvider && nowMs < previousProvider.observedAtMs) {
      nextProviders.set(card.cardId, { ...previousProvider });
      continue;
    }

    const status: QuotaNotificationProviderState["status"] =
      (card.errors?.some(isNotifiableProviderError) ?? false) ? "error" : "healthy";
    nextProviders.set(card.cardId, { status, observedAtMs: nowMs });

    if (!previousProvider || previousProvider.status !== "healthy" || status !== "error") {
      continue;
    }

    const fingerprint = quotaNotificationFingerprint({
      kind: "provider-error",
      cardId: card.cardId,
      category: QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
    });
    emit(fingerprint, {
      ...notificationBase(card, fingerprint, nowMs),
      kind: "provider-error",
      category: QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
    });
  }

  return {
    notifications,
    state: {
      version: QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION,
      rows: Object.fromEntries(nextRows),
      providers: Object.fromEntries(nextProviders),
    },
    cooldowns,
  };
}
