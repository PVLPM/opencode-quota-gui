import { describe, expect, it } from "vitest";
import type { ProviderCard, QuotaCardRow, QuotaSnapshot } from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import type {
  TemporalModelStatus,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
  TemporalWeeklySchedule,
} from "../src/contracts/temporal.js";
import { buildQuotaPolicyModels } from "../src/gui/temporal-quota-policy.js";
import { TEMPORAL_QUOTA_POLICIES } from "../src/gui/temporal-quota-policy-data.js";
import { buildSessionHeaderView } from "../src/native/session-header-model.js";
import type { DisplayPreferences } from "../src/ui/quota-semantics.js";

const NOW = Date.parse("2026-11-01T11:59:00.000Z");
const MINUTE_MS = 60_000;
const preferences: DisplayPreferences = {
  percentMode: "used",
  showRunway: false,
  detailed: false,
};

function model(overrides: Partial<TemporalModelStatus> = {}): TemporalModelStatus {
  return { modelId: "synthetic/model", state: "offpeak", intervals: [], ...overrides };
}

function weeklyPeak(startMinute: number, endMinute: number): TemporalWeeklySchedule {
  return {
    timeZone: "UTC",
    utcOffsetMinutes: 0,
    basePhase: "offpeak",
    windows: [{ days: ["sun"], startMinute, endMinute, phase: "peak" }],
  };
}

function temporal(models: TemporalModelStatus[], providerId = "synthetic"): TemporalStatusSnapshot {
  const provider: TemporalProviderStatus = {
    providerId,
    providerLabel: providerId,
    discovered: true,
    phase: "offpeak",
    models,
    holidays: [],
  };
  return {
    generatedAtMs: NOW,
    providers: [provider],
    snapshot: { revision: "test", generatedAtMs: NOW },
  };
}

function viewAt(models: TemporalModelStatus[], nowMs: number, providerId = "synthetic") {
  const row: QuotaCardRow = {
    rowId: "card-1#five" as RowId,
    label: "5h",
    kind: "percent",
    resultType: "quota",
    percentUsed: 38,
    percentRemaining: 62,
  };
  const card: ProviderCard = {
    cardId: "card-1" as CardId,
    providerId,
    providerLabel: providerId,
    rows: [row],
    errors: [],
  };
  const snapshot: QuotaSnapshot = {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: { cards: [card], enabledProviders: "auto", polledAtMs: NOW },
    temporal: temporal(models, providerId),
  };
  return buildSessionHeaderView({
    snapshot,
    hiddenCards: [],
    hiddenRows: [],
    preferences,
    nowMs,
  });
}

describe("session.header Peak temporal boundaries", () => {
  it("advances at exact T-60, start and end boundaries, then uses the weekly recurrence", () => {
    const startMs = Date.parse("2026-11-01T13:00:00.000Z");
    const endMs = Date.parse("2026-11-01T14:00:00.000Z");
    const schedule = weeklyPeak(13 * 60, 14 * 60);
    const status = model({
      state: "offpeak",
      intervals: [
        { startMs: NOW - MINUTE_MS, endMs: startMs, phase: "offpeak" },
        { startMs, endMs, phase: "peak" },
      ],
      nextChangeAtMs: startMs,
      nextState: "peak",
      weekly: schedule,
    });

    const beforeThreshold = viewAt([status], startMs - 60 * MINUTE_MS - 1);
    expect(beforeThreshold.cards[0]?.peak).toBeUndefined();
    expect(beforeThreshold.nextPeakUpdateAtMs).toBe(startMs - 60 * MINUTE_MS);

    const atThreshold = viewAt([status], startMs - 60 * MINUTE_MS);
    expect(atThreshold.cards[0]?.peak).toBe("soon");
    expect(atThreshold.cards[0]?.peakAtMs).toBe(startMs);
    expect(atThreshold.nextPeakUpdateAtMs).toBe(startMs);

    const atStart = viewAt([status], startMs);
    expect(atStart.cards[0]?.peak).toBe("now");
    expect(atStart.nextPeakUpdateAtMs).toBe(endMs);

    const atEnd = viewAt([status], endMs);
    expect(atEnd.cards[0]?.peak).toBeUndefined();
    expect(atEnd.nextPeakUpdateAtMs).toBe(startMs + 7 * 24 * 60 * MINUTE_MS - 60 * MINUTE_MS);
  });

  it("uses recurring transitions from the existing quota policy data beyond clipped intervals", () => {
    const policy = TEMPORAL_QUOTA_POLICIES[0];
    if (policy === undefined) throw new Error("expected the published Z.ai temporal policy");
    const nowMs = Date.parse("2026-11-01T12:00:00.000Z");
    const startMs = Date.parse("2026-11-02T06:00:00.000Z");
    const endMs = Date.parse("2026-11-02T10:00:00.000Z");
    const models = buildQuotaPolicyModels(policy, nowMs, 1);

    expect(models[0]?.intervals.at(-1)?.endMs).toBe(nowMs + 1);
    expect(viewAt(models, startMs - 60 * MINUTE_MS, policy.providerId).cards[0]?.peak).toBe("soon");
    expect(viewAt(models, startMs, policy.providerId).cards[0]?.peak).toBe("now");

    const afterEnd = viewAt(models, endMs, policy.providerId);
    expect(afterEnd.cards[0]?.peak).toBeUndefined();
    expect(afterEnd.nextPeakUpdateAtMs).toBe(Date.parse("2026-11-03T05:00:00.000Z"));
  });

  it("keeps current Peak red over another model's upcoming yellow and schedules both transitions", () => {
    const currentPeakEnds = NOW + 5 * MINUTE_MS;
    const nextPeakStarts = NOW + 2 * MINUTE_MS;
    const nextPeakEnds = NOW + 10 * MINUTE_MS;
    const currentPeak = model({
      modelId: "synthetic/current",
      state: "peak",
      intervals: [
        { startMs: NOW - MINUTE_MS, endMs: currentPeakEnds, phase: "peak" },
        { startMs: currentPeakEnds, endMs: nextPeakEnds, phase: "offpeak" },
        { startMs: nextPeakEnds, endMs: nextPeakEnds + MINUTE_MS, phase: "offpeak" },
      ],
      nextChangeAtMs: currentPeakEnds,
      nextState: "offpeak",
    });
    const upcomingPeak = model({
      modelId: "synthetic/upcoming",
      state: "offpeak",
      intervals: [
        { startMs: NOW - MINUTE_MS, endMs: nextPeakStarts, phase: "offpeak" },
        { startMs: nextPeakStarts, endMs: nextPeakEnds, phase: "peak" },
        { startMs: nextPeakEnds, endMs: nextPeakEnds + MINUTE_MS, phase: "offpeak" },
      ],
      nextChangeAtMs: nextPeakStarts,
      nextState: "peak",
    });

    expect(viewAt([upcomingPeak, currentPeak], NOW).cards[0]?.peak).toBe("now");
    expect(viewAt([upcomingPeak, currentPeak], NOW).nextPeakUpdateAtMs).toBe(nextPeakStarts);
    expect(viewAt([upcomingPeak, currentPeak], nextPeakStarts).cards[0]?.peak).toBe("now");
    expect(viewAt([upcomingPeak, currentPeak], nextPeakStarts).nextPeakUpdateAtMs).toBe(
      currentPeakEnds,
    );
    expect(viewAt([upcomingPeak, currentPeak], currentPeakEnds).cards[0]?.peak).toBe("now");
    expect(viewAt([upcomingPeak, currentPeak], currentPeakEnds).nextPeakUpdateAtMs).toBe(
      nextPeakEnds,
    );
    expect(viewAt([upcomingPeak, currentPeak], nextPeakEnds).cards[0]?.peak).toBeUndefined();
  });
});
