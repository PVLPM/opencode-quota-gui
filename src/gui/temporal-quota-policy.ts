import type {
  TemporalEffect,
  TemporalModelInterval,
  TemporalModelPhase,
  TemporalModelStatus,
} from "../contracts/temporal.js";

/**
 * Provider-maintained quota pricing policies that do not live in the models.dev
 * monetary snapshot. Effects are normalized multipliers on the provider's own
 * quota unit, never API price changes.
 */

export type TemporalQuotaDay = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface TemporalQuotaPolicyModel {
  peakFactor: number;
  offpeakFactor: number;
}

export interface TemporalQuotaPolicy {
  providerId: string;
  providerLabel: string;
  /** Alternate provider ids that mean this same policy. */
  aliases: readonly string[];
  source: string;
  sourceAccessedAt: string;
  sourceLabel: string;
  /** IANA zone used by the published schedule. */
  timeZone: string;
  /** Fixed offset for the schedule zone; the published policy has no DST. */
  utcOffsetMinutes: number;
  peak: {
    days: readonly TemporalQuotaDay[];
    /** Local `HH:MM`, inclusive. */
    start: string;
    /** Local `HH:MM`, exclusive. */
    end: string;
  };
  /** Exact provider model ids and their normalized quota effects. */
  models: Readonly<Record<string, TemporalQuotaPolicyModel>>;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const MAX_INTERVALS = 24;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function clockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function localDayIndex(policy: TemporalQuotaPolicy, atMs: number): number {
  return Math.floor((atMs + policy.utcOffsetMinutes * MINUTE_MS) / DAY_MS);
}

function localDayName(dayIndex: number): TemporalQuotaDay {
  return DAY_NAMES[new Date(dayIndex * DAY_MS).getUTCDay()] ?? "mon";
}

function localMinuteOfDay(policy: TemporalQuotaPolicy, atMs: number): number {
  const local = atMs + policy.utcOffsetMinutes * MINUTE_MS;
  return Math.floor((local % DAY_MS) / MINUTE_MS);
}

/** Published peak window at an instant, in the policy's own time zone. */
export function quotaPolicyPhase(policy: TemporalQuotaPolicy, atMs: number): TemporalModelPhase {
  const day = localDayName(localDayIndex(policy, atMs));
  if (!policy.peak.days.includes(day)) return "offpeak";
  const minute = localMinuteOfDay(policy, atMs);
  return minute >= clockMinutes(policy.peak.start) && minute < clockMinutes(policy.peak.end)
    ? "peak"
    : "offpeak";
}

function effectFor(model: TemporalQuotaPolicyModel, phase: TemporalModelPhase): TemporalEffect {
  return {
    factor: phase === "peak" ? model.peakFactor : model.offpeakFactor,
    direction: phase === "peak" ? "peak" : "offpeak",
    unit: "quota_points",
  };
}

interface QuotaWindow {
  startMs: number;
  endMs: number;
}

function peakWindows(policy: TemporalQuotaPolicy, fromMs: number, toMs: number): QuotaWindow[] {
  const offsetMs = policy.utcOffsetMinutes * MINUTE_MS;
  const firstDay = Math.floor((fromMs + offsetMs) / DAY_MS) - 1;
  const lastDay = Math.floor((toMs + offsetMs) / DAY_MS) + 1;
  const startMinute = clockMinutes(policy.peak.start);
  const endMinute = clockMinutes(policy.peak.end);
  const windows: QuotaWindow[] = [];
  for (let day = firstDay; day <= lastDay; day += 1) {
    if (!policy.peak.days.includes(localDayName(day))) continue;
    const startMs = day * DAY_MS + startMinute * MINUTE_MS - offsetMs;
    const endMs = day * DAY_MS + endMinute * MINUTE_MS - offsetMs;
    const clippedStart = Math.max(startMs, fromMs);
    const clippedEnd = Math.min(endMs, toMs);
    if (clippedEnd > clippedStart) {
      windows.push({ startMs: clippedStart, endMs: clippedEnd });
    }
  }
  return windows.sort((left, right) => left.startMs - right.startMs);
}

function pushInterval(intervals: TemporalModelInterval[], next: TemporalModelInterval): void {
  const previous = intervals[intervals.length - 1];
  if (
    previous &&
    previous.phase === next.phase &&
    JSON.stringify(previous.effect) === JSON.stringify(next.effect)
  ) {
    previous.endMs = next.endMs;
    return;
  }
  intervals.push(next);
}

function buildIntervals(
  policy: TemporalQuotaPolicy,
  model: TemporalQuotaPolicyModel,
  fromMs: number,
  toMs: number,
): TemporalModelInterval[] {
  const intervals: TemporalModelInterval[] = [];
  let cursor = fromMs;
  for (const window of peakWindows(policy, fromMs, toMs)) {
    if (window.startMs > cursor) {
      pushInterval(intervals, {
        startMs: cursor,
        endMs: window.startMs,
        phase: "offpeak",
        effect: effectFor(model, "offpeak"),
      });
    }
    if (window.endMs > window.startMs) {
      pushInterval(intervals, {
        startMs: window.startMs,
        endMs: window.endMs,
        phase: "peak",
        effect: effectFor(model, "peak"),
      });
    }
    cursor = window.endMs;
  }
  if (cursor < toMs) {
    pushInterval(intervals, {
      startMs: cursor,
      endMs: toMs,
      phase: "offpeak",
      effect: effectFor(model, "offpeak"),
    });
  }
  return intervals.slice(0, MAX_INTERVALS);
}

/** Browser-safe status for every exact model in one quota policy. */
export function buildQuotaPolicyModels(
  policy: TemporalQuotaPolicy,
  nowMs: number,
  horizonMs: number,
): TemporalModelStatus[] {
  return Object.keys(policy.models)
    .sort((left, right) => left.localeCompare(right))
    .map((modelId) => {
      const model = policy.models[modelId];
      if (!model) throw new Error(`missing policy model ${modelId}`);
      const state = quotaPolicyPhase(policy, nowMs);
      const intervals = buildIntervals(policy, model, nowMs, nowMs + horizonMs);
      // The final interval ends at the horizon; it is not a published boundary.
      const next = intervals.length > 1 ? intervals[0]?.endMs : undefined;
      const status: TemporalModelStatus = {
        modelId,
        state,
        effect: effectFor(model, state),
        intervals,
      };
      if (next !== undefined && next > nowMs) status.nextChangeAtMs = next;
      return status;
    });
}
