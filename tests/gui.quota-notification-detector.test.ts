/**
 * Pure quota notification transition detector, pinned to the owner policy:
 * - exactly four event kinds: low, exhausted, reset, provider-error;
 * - one low threshold and one cooldown, both caller/settings supplied;
 * - low is previous > threshold -> current <= threshold, except exhaustion;
 * - exhausted is previous > 0 -> current <= 0;
 * - reset mirrors the proven transition semantics in
 *   `src/lib/quota-reset-notifications.ts`;
 * - provider-error is a proven healthy -> error transition from structured
 *   provenance only, never display text;
 * - cooldown always applies to the same exact fingerprint and is never bypassed;
 * - first startup and newly visible cards/rows silently baseline.
 */
import { describe, expect, it } from "vitest";

import { isCardHidden as sharedIsCardHidden } from "../src/contracts/card-visibility.js";
import type { ProviderCard } from "../src/contracts/dashboard.js";
import type { ProviderFailureCategory } from "../src/contracts/provider-failure.js";
import {
  type DetectQuotaNotificationsInput,
  type DetectQuotaNotificationsResult,
  detectQuotaNotifications,
  isNotifiableProviderError,
  QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION,
  QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
  type QuotaNotificationCardObservation,
  type QuotaNotificationDetectorState,
  type QuotaNotificationProviderErrorObservation,
  type QuotaNotificationRowObservation,
  quotaNotificationFingerprint,
  RESET_TRANSITION_MAX_AGE_MS,
} from "../src/gui/quota-notification-detector.js";
import {
  type ResetObservation,
  updateObservation as updateLegacyObservation,
} from "../src/lib/quota-reset-notifications.js";
import type { NativeQuotaNotificationPolicy } from "../src/lib/types.js";

const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);
const OLD_RESET_AT = "2026-11-02T13:00:00.000Z";
const RESET_AT = "2026-11-02T17:00:00.000Z";
const NEXT_RESET_AT = "2026-11-02T21:00:00.000Z";
const LOW_THRESHOLD = 10;
const COOLDOWN_MS = 30 * 60 * 1000;
const CARD_ID = `openai:${"a".repeat(64)}`;
const SECOND_CARD_ID = `openai:${"b".repeat(64)}`;

function percentRow(
  rowId: string,
  percentRemaining: number,
  options: {
    resetAtIso?: string | null;
    resultType?: QuotaNotificationRowObservation["resultType"];
    kind?: QuotaNotificationRowObservation["kind"];
    label?: string;
    metric?: QuotaNotificationRowObservation["metric"];
  } = {},
): QuotaNotificationRowObservation {
  const row: QuotaNotificationRowObservation = {
    rowId,
    label: options.label ?? rowId,
    kind: options.kind ?? "percent",
    resultType: options.resultType ?? "quota",
    percentRemaining,
    metric: options.metric ?? { kind: "window", window: "five_hour" },
  };
  const resetAtIso = options.resetAtIso === undefined ? RESET_AT : options.resetAtIso;
  if (resetAtIso !== null) row.resetAtIso = resetAtIso;
  return row;
}

function card(
  params: {
    rows?: readonly QuotaNotificationRowObservation[];
    cardId?: string;
    providerId?: string;
    providerLabel?: string;
    accountLabel?: string;
    providerScopeHash?: string;
    errors?: readonly QuotaNotificationProviderErrorObservation[];
  } = {},
): QuotaNotificationCardObservation {
  const observation: QuotaNotificationCardObservation = {
    cardId: params.cardId ?? CARD_ID,
    providerId: params.providerId ?? "openai",
    providerLabel: params.providerLabel ?? "OpenAI",
    rows: params.rows ?? [],
  };
  if (params.accountLabel !== undefined) observation.accountLabel = params.accountLabel;
  if (params.providerScopeHash !== undefined) {
    observation.providerScopeHash = params.providerScopeHash;
  }
  if (params.errors !== undefined) observation.errors = params.errors;
  return observation;
}

interface DetectOverrides {
  state?: QuotaNotificationDetectorState;
  cooldowns?: Readonly<Record<string, number>>;
  hiddenCards?: readonly string[];
  hiddenRows?: readonly string[];
  nowMs?: number;
  lowThresholdPercent?: number;
  cooldownMs?: number;
  policy?: TestPolicyOverride;
}

type TestNotificationPolicy = NativeQuotaNotificationPolicy;

interface TestPolicyOverride {
  enabled?: boolean;
  modelChangeToastEnabled?: boolean;
  low?: Partial<TestNotificationPolicy["low"]>;
  exhausted?: Partial<TestNotificationPolicy["exhausted"]>;
  reset?: Partial<TestNotificationPolicy["reset"]>;
  providerError?: Partial<TestNotificationPolicy["providerError"]>;
  duplicateCooldownMinutes?: number;
}

const DEFAULT_POLICY: TestNotificationPolicy = {
  enabled: true,
  modelChangeToastEnabled: true,
  low: { enabled: true, thresholdRemainingPercent: LOW_THRESHOLD },
  exhausted: { enabled: true },
  reset: {
    enabled: true,
    windows: ["fiveHour", "hourly", "daily", "weekly", "monthly", "yearly"],
  },
  providerError: { enabled: true },
  duplicateCooldownMinutes: COOLDOWN_MS / 60_000,
};

function detect(
  cards: readonly QuotaNotificationCardObservation[],
  overrides: DetectOverrides = {},
): DetectQuotaNotificationsResult {
  const policy: TestNotificationPolicy = {
    ...DEFAULT_POLICY,
    ...overrides.policy,
    low: {
      ...DEFAULT_POLICY.low,
      ...overrides.policy?.low,
      ...(overrides.lowThresholdPercent === undefined
        ? {}
        : { thresholdRemainingPercent: overrides.lowThresholdPercent }),
    },
    exhausted: { ...DEFAULT_POLICY.exhausted, ...overrides.policy?.exhausted },
    reset: { ...DEFAULT_POLICY.reset, ...overrides.policy?.reset },
    providerError: { ...DEFAULT_POLICY.providerError, ...overrides.policy?.providerError },
    duplicateCooldownMinutes:
      overrides.cooldownMs === undefined
        ? (overrides.policy?.duplicateCooldownMinutes ?? DEFAULT_POLICY.duplicateCooldownMinutes)
        : overrides.cooldownMs / 60_000,
  };
  const input: DetectQuotaNotificationsInput = {
    cards,
    nowMs: overrides.nowMs ?? NOW,
    policy,
  };
  if (overrides.state !== undefined) input.state = overrides.state;
  if (overrides.cooldowns !== undefined) input.cooldowns = overrides.cooldowns;
  if (overrides.hiddenCards !== undefined) input.hiddenCards = overrides.hiddenCards;
  if (overrides.hiddenRows !== undefined) input.hiddenRows = overrides.hiddenRows;
  return detectQuotaNotifications(input);
}

function next(
  previous: DetectQuotaNotificationsResult,
  cards: readonly QuotaNotificationCardObservation[],
  overrides: DetectOverrides = {},
): DetectQuotaNotificationsResult {
  return detect(cards, {
    ...overrides,
    state: previous.state,
    cooldowns: previous.cooldowns,
  });
}

function rowCard(
  percentRemaining: number,
  resetAtIso = RESET_AT,
): QuotaNotificationCardObservation {
  return card({ rows: [percentRow("row-1", percentRemaining, { resetAtIso })] });
}

describe("quota notification detector", () => {
  it("silently baselines first startup, including low, exhausted, reset, and provider error", () => {
    const result = detect([
      card({
        rows: [percentRow("low", 5), percentRow("exhausted", 0)],
        errors: [{ failureCategory: "provider_api" }],
      }),
    ]);

    expect(result.notifications).toEqual([]);
    expect(Object.keys(result.state.rows)).toHaveLength(2);
    expect(result.state.providers[CARD_ID]?.status).toBe("error");
    expect(result.cooldowns).toEqual({});
  });

  it("ignores a state from an incompatible detector version and baselines silently", () => {
    const staleState = {
      version: QUOTA_NOTIFICATION_DETECTOR_STATE_VERSION + 1,
      rows: {},
      providers: {},
    } as unknown as QuotaNotificationDetectorState;
    const result = detect([rowCard(5)], { state: staleState });

    expect(result.notifications).toEqual([]);
    expect(Object.values(result.state.rows)[0]?.percentRemaining).toBe(5);
  });

  it("emits low only on previous > threshold to current <= threshold", () => {
    const baseline = detect([rowCard(25)]);
    const crossing = next(baseline, [rowCard(9)]);

    expect(crossing.notifications).toEqual([
      expect.objectContaining({
        kind: "low",
        thresholdPercent: LOW_THRESHOLD,
        percentRemaining: 9,
        resetAtIso: RESET_AT,
      }),
    ]);

    const alreadyAtThreshold = detect([rowCard(10)]);
    const belowThreshold = next(alreadyAtThreshold, [rowCard(9)]);
    expect(belowThreshold.notifications).toEqual([]);
  });

  it("treats exactly the configured threshold as a low crossing", () => {
    const result = next(detect([rowCard(25)]), [rowCard(10)]);

    expect(result.notifications).toEqual([
      expect.objectContaining({ kind: "low", percentRemaining: 10, thresholdPercent: 10 }),
    ]);
  });

  it("uses the caller-supplied threshold and never invents a default", () => {
    const baseline = detect([rowCard(25)], { lowThresholdPercent: 5 });
    const noCrossing = next(baseline, [rowCard(9)], { lowThresholdPercent: 5 });

    // With the owner default 10 this would fire; the caller's 5 must win.
    expect(noCrossing.notifications).toEqual([]);

    const crossing = next(noCrossing, [rowCard(5)], { lowThresholdPercent: 5 });
    expect(crossing.notifications).toEqual([
      expect.objectContaining({ kind: "low", thresholdPercent: 5, percentRemaining: 5 }),
    ]);
  });

  it("emits exhausted instead of low on direct zero exhaustion", () => {
    const result = next(detect([rowCard(25)]), [rowCard(0)]);

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toEqual(
      expect.objectContaining({ kind: "exhausted", percentRemaining: 0 }),
    );
    expect(result.notifications.some((notification) => notification.kind === "low")).toBe(false);
  });

  it("emits exhausted only when previous remaining was above zero", () => {
    const first = next(detect([rowCard(5)]), [rowCard(0)]);
    const negative = next(first, [rowCard(-12)]);
    const alreadyExhausted = next(negative, [rowCard(-20)]);

    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]?.kind).toBe("exhausted");
    expect(negative.notifications).toEqual([]);
    expect(alreadyExhausted.notifications).toEqual([]);
  });

  it("detects low and exhausted when reset time is unavailable", () => {
    const baseline = detect([
      card({
        rows: [
          percentRow("low", 25, { resetAtIso: null }),
          percentRow("exhausted", 5, { resetAtIso: null }),
        ],
      }),
    ]);
    const result = next(baseline, [
      card({
        rows: [
          percentRow("low", 9, { resetAtIso: null }),
          percentRow("exhausted", 0, { resetAtIso: null }),
        ],
      }),
    ]);

    expect(result.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "low", rowId: "low" }),
        expect.objectContaining({ kind: "exhausted", rowId: "exhausted" }),
      ]),
    );
    expect(
      result.notifications.every((notification) => notification.resetAtIso === undefined),
    ).toBe(true);
    expect(Object.values(result.state.rows).every((row) => row.reset === undefined)).toBe(true);
  });

  it("observes only semantic percent quota/rate_limit rows", () => {
    const rows: QuotaNotificationRowObservation[] = [
      percentRow("quota", 25),
      percentRow("rate-limit", 25, { resultType: "rate_limit" }),
      percentRow("usage", 25, { resultType: "usage" }),
      percentRow("spend", 25, { resultType: "spend" }),
      percentRow("budget", 25, { resultType: "budget" }),
      percentRow("balance", 25, { resultType: "balance" }),
      percentRow("status", 25, { resultType: "status" }),
      percentRow("value", 25, { kind: "value" }),
      percentRow("quantity", 25, { kind: "quantity" }),
      percentRow("boolean", 25, { kind: "boolean" }),
      { ...percentRow("missing", 0), percentRemaining: undefined },
      { ...percentRow("infinity", 0), percentRemaining: Number.POSITIVE_INFINITY },
    ];
    const baseline = detect([card({ rows })]);
    const result = next(baseline, [
      card({
        rows: rows.map((row) =>
          row.rowId === "missing" || row.rowId === "infinity"
            ? row
            : { ...row, percentRemaining: 0 },
        ),
      }),
    ]);

    expect(Object.keys(result.state.rows)).toHaveLength(2);
    expect(result.notifications.map((notification) => notification.kind)).toEqual([
      "exhausted",
      "exhausted",
    ]);
    expect(result.notifications.map((notification) => notification.rowId).sort()).toEqual([
      "quota",
      "rate-limit",
    ]);
  });

  it("suppresses hidden cards and rows, then silently re-baselines when visible", () => {
    const visible = card({ rows: [percentRow("row-1", 25)] });
    const baseline = detect([visible]);
    const hiddenByCardId = next(baseline, [card({ rows: [percentRow("row-1", 5)] })], {
      hiddenCards: [CARD_ID],
    });
    const hiddenByProviderId = next(baseline, [card({ rows: [percentRow("row-1", 5)] })], {
      hiddenCards: ["openai"],
    });
    const scopeHash = "f".repeat(64);
    const hiddenByScopeHash = next(
      baseline,
      [card({ rows: [percentRow("row-1", 5)], providerScopeHash: scopeHash })],
      { hiddenCards: [scopeHash] },
    );

    for (const hidden of [hiddenByCardId, hiddenByProviderId, hiddenByScopeHash]) {
      expect(hidden.notifications).toEqual([]);
      expect(hidden.state.rows).toEqual({});
      expect(hidden.state.providers).toEqual({});
    }

    const shown = next(hiddenByCardId, [card({ rows: [percentRow("row-1", 5)] })]);
    expect(shown.notifications).toEqual([]);
    expect(Object.values(shown.state.rows)[0]?.percentRemaining).toBe(5);
  });

  it("matches the authoritative shared card visibility helper", () => {
    const scopeHash = "f".repeat(64);
    const base = card({ rows: [percentRow("row-1", 25)] });
    const scoped = card({
      rows: [percentRow("row-1", 25)],
      providerScopeHash: scopeHash,
    });
    const cases = [
      { observation: base, hiddenId: base.cardId },
      { observation: base, hiddenId: "openai" },
      { observation: scoped, hiddenId: scopeHash },
      { observation: scoped, hiddenId: scoped.cardId },
      { observation: base, hiddenId: "not-a-card-or-provider" },
    ];

    for (const testCase of cases) {
      const result = detect([testCase.observation], { hiddenCards: [testCase.hiddenId] });
      const sharedHidden = sharedIsCardHidden(testCase.observation, new Set([testCase.hiddenId]));
      expect(Object.keys(result.state.rows).length === 0).toBe(sharedHidden);
      expect(Object.keys(result.state.providers).length === 0).toBe(sharedHidden);
    }
  });

  it("drops a hidden row's state while still observing card health", () => {
    const baseline = detect([card({ rows: [percentRow("row-1", 25), percentRow("row-2", 25)] })]);
    const hiddenRow = next(
      baseline,
      [card({ rows: [percentRow("row-1", 5), percentRow("row-2", 5)] })],
      { hiddenRows: ["row-1"] },
    );

    expect(hiddenRow.notifications).toEqual([
      expect.objectContaining({ kind: "low", rowId: "row-2" }),
    ]);
    expect(Object.keys(hiddenRow.state.rows)).toHaveLength(1);

    const healthyBaseline = detect([card({ rows: [percentRow("row-1", 25)] })]);
    const providerError = next(
      healthyBaseline,
      [
        card({
          rows: [percentRow("row-1", 5)],
          errors: [{ failureCategory: "provider_api" }],
        }),
      ],
      { hiddenRows: ["row-1"], cooldownMs: 0 },
    );

    expect(providerError.notifications).toEqual([
      expect.objectContaining({ kind: "provider-error" }),
    ]);
    expect(providerError.state.rows).toEqual({});
  });

  it("keeps per-card identity for the same row id", () => {
    const firstCard = card({
      cardId: `openai:${"1".repeat(64)}`,
      accountLabel: "first account",
      rows: [percentRow("same-row", 25)],
    });
    const secondCard = card({
      cardId: `openai:${"2".repeat(64)}`,
      accountLabel: "second account",
      rows: [percentRow("same-row", 25)],
    });
    const baseline = detect([firstCard, secondCard]);
    const result = next(baseline, [
      {
        ...firstCard,
        rows: [percentRow("same-row", 5)],
      },
      {
        ...secondCard,
        rows: [percentRow("same-row", 5)],
      },
    ]);

    expect(result.notifications).toHaveLength(2);
    expect(result.notifications[0]?.fingerprint).not.toBe(result.notifications[1]?.fingerprint);
    expect(Object.keys(result.state.rows)).toHaveLength(2);
  });

  it("silently baselines a newly visible row", () => {
    const baseline = detect([card({ rows: [percentRow("existing", 25)] })]);
    const withNewRow = next(baseline, [
      card({ rows: [percentRow("existing", 25), percentRow("new", 5)] }),
    ]);

    expect(withNewRow.notifications).toEqual([]);
    expect(Object.keys(withNewRow.state.rows)).toHaveLength(2);

    const exhausted = next(withNewRow, [
      card({ rows: [percentRow("existing", 25), percentRow("new", 0)] }),
    ]);
    expect(exhausted.notifications).toEqual([
      expect.objectContaining({ kind: "exhausted", rowId: "new" }),
    ]);
  });

  it("emits reset using the proven existing transition semantics", () => {
    const baseline = detect([rowCard(40, OLD_RESET_AT)]);
    const result = next(baseline, [rowCard(80, RESET_AT)], { nowMs: NOW + 2 * 60 * 60 * 1000 });

    expect(result.notifications).toEqual([
      expect.objectContaining({
        kind: "reset",
        percentRemaining: 80,
        resetAtIso: RESET_AT,
        previousResetAtIso: OLD_RESET_AT,
      }),
    ]);
    expect(Object.values(result.state.rows)[0]?.reset).toEqual({
      resetAtMs: Date.parse(RESET_AT),
      percentRemaining: 80,
      observedAtMs: NOW + 2 * 60 * 60 * 1000,
      notifiedResetAtMs: Date.parse(OLD_RESET_AT),
    });
  });

  it("matches the exported legacy reset transition machinery", () => {
    const secondObservedAt = NOW + 2 * 60 * 60 * 1000;
    const first: ResetObservation = {
      resetAtMs: Date.parse(OLD_RESET_AT),
      percentRemaining: 40,
      observedAtMs: NOW,
    };
    const second: ResetObservation = {
      resetAtMs: Date.parse(RESET_AT),
      percentRemaining: 80,
      observedAtMs: secondObservedAt,
    };
    const firstUpdate = updateLegacyObservation(undefined, first, NOW);
    const secondUpdate = updateLegacyObservation(firstUpdate.observation, second, secondObservedAt);

    const baseline = detect([rowCard(40, OLD_RESET_AT)]);
    const result = next(baseline, [rowCard(80, RESET_AT)], { nowMs: secondObservedAt });

    expect(firstUpdate.notify).toBe(false);
    expect(secondUpdate.notify).toBe(true);
    expect(result.notifications[0]?.kind).toBe("reset");
    expect(Object.values(result.state.rows)[0]?.reset).toEqual(secondUpdate.observation);
  });

  it("does not repeat reset for the same boundary", () => {
    const reset = next(detect([rowCard(40, OLD_RESET_AT)]), [rowCard(80, RESET_AT)], {
      nowMs: NOW + 2 * 60 * 60 * 1000,
    });
    const repeated = next(reset, [rowCard(79, RESET_AT)], {
      nowMs: NOW + 2 * 60 * 60 * 1000 + 60_000,
    });

    expect(reset.notifications).toHaveLength(1);
    expect(repeated.notifications).toEqual([]);
  });

  it("does not emit reset for a boundary change without a proven transition", () => {
    // First observation happened after the old boundary, so no reset is provable.
    const lateBaseline = detect([rowCard(40, OLD_RESET_AT)], {
      nowMs: NOW + 2 * 60 * 60 * 1000,
    });
    const late = next(lateBaseline, [rowCard(80, RESET_AT)], {
      nowMs: NOW + 3 * 60 * 60 * 1000,
    });

    // A reset requires remaining to increase.
    const decreasing = next(detect([rowCard(40, OLD_RESET_AT)]), [rowCard(30, RESET_AT)], {
      nowMs: NOW + 2 * 60 * 60 * 1000,
    });

    // A full window (100%) is not a reset transition.
    const full = next(detect([rowCard(100, OLD_RESET_AT)]), [rowCard(80, RESET_AT)], {
      nowMs: NOW + 2 * 60 * 60 * 1000,
    });

    // An unchanged boundary is not a reset transition.
    const unchanged = next(detect([rowCard(40, OLD_RESET_AT)]), [rowCard(80, OLD_RESET_AT)], {
      nowMs: NOW + 2 * 60 * 60 * 1000,
    });

    for (const result of [late, decreasing, full, unchanged]) {
      expect(result.notifications).toEqual([]);
    }
  });

  it("enforces the proven 24-hour reset transition age", () => {
    const oldResetMs = Date.parse(OLD_RESET_AT);
    const futureResetAt = new Date(oldResetMs + 25 * 60 * 60 * 1000).toISOString();
    const atLimit = next(detect([rowCard(40, OLD_RESET_AT)]), [rowCard(80, futureResetAt)], {
      nowMs: oldResetMs + RESET_TRANSITION_MAX_AGE_MS,
    });
    const beyondLimit = next(detect([rowCard(40, OLD_RESET_AT)]), [rowCard(80, futureResetAt)], {
      nowMs: oldResetMs + RESET_TRANSITION_MAX_AGE_MS + 1,
    });

    expect(atLimit.notifications).toHaveLength(1);
    expect(atLimit.notifications[0]?.kind).toBe("reset");
    expect(beyondLimit.notifications).toEqual([]);
  });

  it("still applies low and exhausted rules when a boundary change is not a proven reset", () => {
    const baseline = detect([
      card({
        rows: [
          percentRow("low", 50, { resetAtIso: OLD_RESET_AT }),
          percentRow("exhausted", 5, { resetAtIso: OLD_RESET_AT }),
        ],
      }),
    ]);
    const result = next(
      baseline,
      [
        card({
          rows: [
            percentRow("low", 5, { resetAtIso: RESET_AT }),
            percentRow("exhausted", 0, { resetAtIso: RESET_AT }),
          ],
        }),
      ],
      { nowMs: NOW + 2 * 60 * 60 * 1000 },
    );

    expect(result.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "low", rowId: "low" }),
        expect.objectContaining({ kind: "exhausted", rowId: "exhausted" }),
      ]),
    );
    expect(result.notifications.some((notification) => notification.kind === "reset")).toBe(false);
  });

  it("retains the old reset observation across a premature boundary advance", () => {
    const firstObservedAt = Date.UTC(2026, 10, 2, 15, 0, 0);
    const secondObservedAt = Date.UTC(2026, 10, 2, 16, 0, 0);
    const resetObservedAt = Date.UTC(2026, 10, 2, 18, 0, 0);
    const baseline = detect([rowCard(5, RESET_AT)], { nowMs: firstObservedAt });
    const premature = next(baseline, [rowCard(5, NEXT_RESET_AT)], { nowMs: secondObservedAt });

    expect(premature.notifications).toEqual([]);
    expect(Object.values(premature.state.rows)[0]?.reset?.resetAtMs).toBe(Date.parse(RESET_AT));

    const result = next(premature, [rowCard(100, NEXT_RESET_AT)], { nowMs: resetObservedAt });

    expect(result.notifications).toEqual([
      expect.objectContaining({
        kind: "reset",
        resetAtIso: NEXT_RESET_AT,
        previousResetAtIso: RESET_AT,
      }),
    ]);
  });

  it("applies cooldown to the same low fingerprint and never bypasses it", () => {
    const baseline = detect([rowCard(25)]);
    const low = next(baseline, [rowCard(9)]);
    const recovered = next(low, [rowCard(30)], { nowMs: NOW + 60_000 });
    const suppressed = next(recovered, [rowCard(9)], { nowMs: NOW + 2 * 60_000 });
    const recoveredAgain = next(suppressed, [rowCard(30)], { nowMs: NOW + 30 * 60_000 });
    const allowed = next(recoveredAgain, [rowCard(9)], { nowMs: NOW + 31 * 60_000 });

    expect(low.notifications).toHaveLength(1);
    expect(suppressed.notifications).toEqual([]);
    expect(allowed.notifications).toHaveLength(1);
    expect(allowed.notifications[0]?.fingerprint).toBe(low.notifications[0]?.fingerprint);
  });

  it("keeps exhausted on a distinct fingerprint from low", () => {
    const baseline = detect([rowCard(25)]);
    const low = next(baseline, [rowCard(9)]);
    const recovered = next(low, [rowCard(25)], { nowMs: NOW + 1_000 });
    const exhausted = next(recovered, [rowCard(0)], { nowMs: NOW + 2_000 });

    expect(low.notifications).toHaveLength(1);
    expect(exhausted.notifications).toHaveLength(1);
    expect(exhausted.notifications[0]?.kind).toBe("exhausted");
    expect(exhausted.notifications[0]?.fingerprint).not.toBe(low.notifications[0]?.fingerprint);
  });

  it("shares the low cooldown across reset boundaries because boundary is not in its fingerprint", () => {
    const oldReset = "2026-11-02T12:05:00.000Z";
    const baseline = detect([rowCard(25, oldReset)]);
    const low = next(baseline, [rowCard(9, oldReset)]);
    const reset = next(low, [rowCard(30, RESET_AT)], { nowMs: NOW + 10 * 60_000 });
    const suppressed = next(reset, [rowCard(9, RESET_AT)], { nowMs: NOW + 11 * 60_000 });
    const recovered = next(suppressed, [rowCard(30, RESET_AT)], { nowMs: NOW + 31 * 60_000 });
    const allowed = next(recovered, [rowCard(9, RESET_AT)], { nowMs: NOW + 32 * 60_000 });

    expect(low.notifications).toHaveLength(1);
    expect(reset.notifications[0]?.kind).toBe("reset");
    expect(suppressed.notifications).toEqual([]);
    expect(allowed.notifications).toHaveLength(1);
    expect(allowed.notifications[0]?.fingerprint).toBe(low.notifications[0]?.fingerprint);
  });

  it("puts the reset boundary in the reset fingerprint while low/exhausted omit it", () => {
    const firstReset = next(detect([rowCard(40, OLD_RESET_AT)]), [rowCard(80, RESET_AT)], {
      nowMs: Date.parse(OLD_RESET_AT) + 60_000,
    });
    const secondResetAt = new Date(Date.parse(RESET_AT) + 10 * 60 * 1000).toISOString();
    const secondReset = next(firstReset, [rowCard(100, secondResetAt)], {
      nowMs: Date.parse(RESET_AT) + 6 * 60 * 1000,
    });

    expect(firstReset.notifications[0]?.kind).toBe("reset");
    expect(secondReset.notifications[0]?.kind).toBe("reset");
    expect(secondReset.notifications[0]?.fingerprint).not.toBe(
      firstReset.notifications[0]?.fingerprint,
    );
  });

  it.each([
    {
      name: "master",
      policy: { enabled: false },
      suppressedKinds: ["low", "exhausted", "reset", "provider-error"],
    },
    { name: "low", policy: { low: { enabled: false } }, suppressedKinds: ["low"] },
    {
      name: "exhausted",
      policy: { exhausted: { enabled: false } },
      suppressedKinds: ["exhausted"],
    },
    { name: "reset", policy: { reset: { enabled: false } }, suppressedKinds: ["reset"] },
    {
      name: "provider-error",
      policy: { providerError: { enabled: false } },
      suppressedKinds: ["provider-error"],
    },
  ])("suppresses the $name category while continuing to track transitions", ({
    policy,
    suppressedKinds,
  }) => {
    const baseline = detect([
      card({
        rows: [
          percentRow("low-row", 30),
          percentRow("exhausted-row", 30),
          percentRow("reset-row", 20, { resetAtIso: OLD_RESET_AT }),
        ],
      }),
    ]);
    const resetObservedAt = Date.parse(OLD_RESET_AT) + 60_000;
    const observed = next(
      baseline,
      [
        card({
          rows: [
            percentRow("low-row", 5),
            percentRow("exhausted-row", 0),
            percentRow("reset-row", 80, { resetAtIso: RESET_AT }),
          ],
          errors: [{ failureCategory: "provider_api" }],
        }),
      ],
      { nowMs: resetObservedAt, policy },
    );

    expect(observed.notifications.some(({ kind }) => suppressedKinds.includes(kind))).toBe(false);
    if (policy.enabled === false) expect(observed.notifications).toEqual([]);
    expect(observed.state.rows[`${CARD_ID}\u001flow-row`]?.percentRemaining).toBe(5);
    expect(observed.state.rows[`${CARD_ID}\u001fexhausted-row`]?.percentRemaining).toBe(0);
    expect(observed.state.rows[`${CARD_ID}\u001freset-row`]?.reset?.resetAtMs).toBe(
      Date.parse(RESET_AT),
    );
    expect(observed.state.providers[CARD_ID]?.status).toBe("error");

    const reenabled = next(
      observed,
      [
        card({
          rows: [
            percentRow("low-row", 5),
            percentRow("exhausted-row", 0),
            percentRow("reset-row", 80, { resetAtIso: RESET_AT }),
          ],
          errors: [{ failureCategory: "provider_api" }],
        }),
      ],
      { nowMs: resetObservedAt + 1 },
    );
    expect(reenabled.notifications).toEqual([]);
  });

  it("applies reset-window selection without stopping reset baseline tracking", () => {
    const selectedPolicy = {
      low: { enabled: false },
      exhausted: { enabled: false },
      providerError: { enabled: false },
      reset: { enabled: true, windows: ["fiveHour"] },
    };
    const baseline = detect(
      [
        card({
          rows: [
            percentRow("five-hour", 20, {
              resetAtIso: OLD_RESET_AT,
              metric: { kind: "window", window: "five_hour" },
            }),
            percentRow("weekly", 20, {
              resetAtIso: OLD_RESET_AT,
              metric: { kind: "window", window: "week" },
            }),
          ],
        }),
      ],
      { policy: selectedPolicy },
    );
    const resetAt = Date.parse(OLD_RESET_AT) + 60_000;
    const observed = next(
      baseline,
      [
        card({
          rows: [
            percentRow("five-hour", 80, {
              resetAtIso: RESET_AT,
              metric: { kind: "window", window: "five_hour" },
            }),
            percentRow("weekly", 80, {
              resetAtIso: RESET_AT,
              metric: { kind: "window", window: "week" },
            }),
          ],
        }),
      ],
      { nowMs: resetAt, policy: selectedPolicy },
    );

    expect(observed.notifications.map(({ rowId }) => rowId)).toEqual(["five-hour"]);
    expect(observed.state.rows[`${CARD_ID}\u001fweekly`]?.reset?.resetAtMs).toBe(
      Date.parse(RESET_AT),
    );
    const reenabled = next(
      observed,
      [
        card({
          rows: [
            percentRow("five-hour", 80, {
              resetAtIso: RESET_AT,
              metric: { kind: "window", window: "five_hour" },
            }),
            percentRow("weekly", 80, {
              resetAtIso: RESET_AT,
              metric: { kind: "window", window: "week" },
            }),
          ],
        }),
      ],
      {
        nowMs: resetAt + 1,
        policy: {
          ...selectedPolicy,
          reset: { enabled: true, windows: ["fiveHour", "weekly"] },
        },
      },
    );
    expect(reenabled.notifications).toEqual([]);
  });

  it("emits provider-error only for a healthy -> error transition with structured provenance", () => {
    const healthy = card({ rows: [] });
    const errored = card({ rows: [], errors: [{ failureCategory: "provider_api" }] });
    const baseline = detect([healthy]);
    const transition = next(baseline, [errored], { cooldownMs: 0 });
    const stillErrored = next(transition, [errored], { cooldownMs: 0 });
    const recovered = next(stillErrored, [healthy], { cooldownMs: 0 });
    const repeated = next(recovered, [errored], { cooldownMs: 0 });

    expect(transition.notifications).toEqual([
      expect.objectContaining({
        kind: "provider-error",
        category: QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
        providerId: "openai",
        providerLabel: "OpenAI",
      }),
    ]);
    expect(transition.notifications[0]).not.toHaveProperty("rowId");
    expect(transition.notifications[0]).not.toHaveProperty("resetAtIso");
    expect(stillErrored.notifications).toEqual([]);
    expect(recovered.notifications).toEqual([]);
    expect(repeated.notifications).toHaveLength(1);
    expect(repeated.notifications[0]?.kind).toBe("provider-error");
  });

  it("consumes a ProviderCard's structured failureCategory directly", () => {
    const healthy: ProviderCard = {
      cardId: CARD_ID as ProviderCard["cardId"],
      providerId: "openai",
      providerLabel: "OpenAI",
      labelSource: "provider",
      rows: [],
      errors: [],
    };
    const errored: ProviderCard = {
      ...healthy,
      errors: [
        {
          label: "Provider",
          message: "Upstream request failed",
          failureCategory: "provider_api",
        },
      ],
    };

    const result = next(detect([healthy]), [errored], { cooldownMs: 0 });

    expect(result.notifications).toEqual([
      expect.objectContaining({
        kind: "provider-error",
        category: QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
      }),
    ]);
  });

  it("fails closed for missing or unknown provider failure provenance without text parsing", () => {
    const baseline = detect([card({ rows: [] })]);
    const credentialsCategory = card({
      rows: [],
      errors: [{ failureCategory: "credentials" }],
    });
    const unknownCategory = card({
      rows: [],
      errors: [{ failureCategory: "unexpected" as ProviderFailureCategory }],
    });
    const displayTextErrors: ProviderCard["errors"] = [
      { label: "Provider", message: "Quota request failed (HTTP 503)" },
    ];
    const displayTextOnly = card({ rows: [], errors: displayTextErrors });

    expect(isNotifiableProviderError({ failureCategory: "provider_api" })).toBe(true);
    expect(isNotifiableProviderError({ failureCategory: "credentials" })).toBe(false);
    expect(isNotifiableProviderError({ failureCategory: "discovery" })).toBe(false);
    expect(isNotifiableProviderError({ failureCategory: "local" })).toBe(false);
    expect(isNotifiableProviderError({})).toBe(false);

    for (const observation of [credentialsCategory, unknownCategory, displayTextOnly]) {
      const result = next(baseline, [observation], { cooldownMs: 0 });
      expect(result.notifications).toEqual([]);
      expect(result.state.providers[CARD_ID]?.status).toBe("healthy");
    }
  });

  it("cooldowns provider-error by card and safe category", () => {
    const healthy = card({ rows: [] });
    const healthySecond = card({ cardId: SECOND_CARD_ID, rows: [] });
    const firstError = card({
      rows: [],
      errors: [{ failureCategory: "provider_api" }],
      providerLabel: "First label",
    });
    const firstErrorRelabeled = card({
      rows: [],
      errors: [{ failureCategory: "provider_api" }],
      providerLabel: "Renamed provider",
    });
    const secondCardError = card({
      cardId: SECOND_CARD_ID,
      rows: [],
      errors: [{ failureCategory: "provider_api" }],
    });

    const baseline = detect([healthy, healthySecond]);
    const first = next(baseline, [firstError, healthySecond], { nowMs: NOW + 60_000 });
    const recovered = next(first, [healthy, healthySecond], { nowMs: NOW + 2 * 60_000 });
    const suppressed = next(recovered, [firstErrorRelabeled, healthySecond], {
      nowMs: NOW + 3 * 60_000,
    });
    const otherCard = next(suppressed, [healthy, secondCardError], {
      nowMs: NOW + 3 * 60_000,
    });

    expect(first.notifications).toHaveLength(1);
    expect(suppressed.notifications).toEqual([]);
    expect(otherCard.notifications).toHaveLength(1);
    expect(otherCard.notifications[0]?.cardId).toBe(SECOND_CARD_ID);
    expect(otherCard.notifications[0]?.fingerprint).not.toBe(first.notifications[0]?.fingerprint);

    const recoveredAgain = next(otherCard, [healthy, healthySecond], {
      nowMs: NOW + 30 * 60_000,
    });
    const allowed = next(recoveredAgain, [firstErrorRelabeled, healthySecond], {
      nowMs: NOW + 31 * 60_000,
    });
    expect(allowed.notifications).toHaveLength(1);
    expect(allowed.notifications[0]?.fingerprint).toBe(first.notifications[0]?.fingerprint);
  });

  it("builds fingerprints from the required identity parts", () => {
    const low = quotaNotificationFingerprint({ kind: "low", cardId: "openai:test", rowId: "row" });
    const exhausted = quotaNotificationFingerprint({
      kind: "exhausted",
      cardId: "openai:test",
      rowId: "row",
    });
    const reset = quotaNotificationFingerprint({
      kind: "reset",
      cardId: "openai:test",
      rowId: "row",
      resetAtIso: RESET_AT,
    });
    const sameInstantReset = quotaNotificationFingerprint({
      kind: "reset",
      cardId: "openai:test",
      rowId: "row",
      resetAtIso: "2026-11-02T18:00:00.000+01:00",
    });
    const laterReset = quotaNotificationFingerprint({
      kind: "reset",
      cardId: "openai:test",
      rowId: "row",
      resetAtIso: NEXT_RESET_AT,
    });
    const providerError = quotaNotificationFingerprint({
      kind: "provider-error",
      cardId: "openai:test",
      category: QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
    });
    const otherProviderError = quotaNotificationFingerprint({
      kind: "provider-error",
      cardId: "openai:other",
      category: QUOTA_NOTIFICATION_PROVIDER_ERROR_CATEGORY,
    });

    expect(low).toMatch(/^[0-9a-f]{64}$/u);
    expect(low).not.toBe(exhausted);
    expect(sameInstantReset).toBe(reset);
    expect(laterReset).not.toBe(reset);
    expect(providerError).not.toBe(otherProviderError);
  });

  it("does not mutate caller state or cooldowns and ignores clock rollback", () => {
    const baseline = detect([rowCard(25)]);
    const stateSnapshot = JSON.stringify(baseline.state);
    const cooldownSnapshot = JSON.stringify(baseline.cooldowns);
    const result = next(baseline, [rowCard(9)]);

    expect(result.notifications).toHaveLength(1);
    expect(JSON.stringify(baseline.state)).toBe(stateSnapshot);
    expect(JSON.stringify(baseline.cooldowns)).toBe(cooldownSnapshot);
    expect(result.state).not.toBe(baseline.state);
    expect(result.state.rows).not.toBe(baseline.state.rows);
    expect(result.state.providers).not.toBe(baseline.state.providers);
    expect(result.cooldowns).not.toBe(baseline.cooldowns);

    const rollback = next(baseline, [rowCard(5)], { nowMs: NOW - 1_000 });
    expect(rollback.notifications).toEqual([]);
    expect(Object.values(rollback.state.rows)[0]?.percentRemaining).toBe(25);
  });
});
