import type {
  TemporalEffect,
  TemporalHolidayInterval,
  TemporalModelInterval,
  TemporalModelStatus,
  TemporalPhase,
  TemporalProviderStatus,
} from "../contracts/temporal";

/**
 * Pure formatting and live-state helpers for the temporal status DTO.
 *
 * The server evaluates policy; this module only reads its emitted windows. That
 * keeps the browser-only formatters testable without the tooltip portal.
 */

export function temporalPhaseLabel(phase: TemporalPhase): string {
  switch (phase) {
    case "peak":
      return "Peak";
    case "offpeak":
      return "Off-peak";
    case "mixed":
      return "Mixed";
    default:
      return "Unknown";
  }
}

export function temporalModelPhaseLabel(phase: TemporalModelStatus["state"]): string {
  return phase === "peak" ? "Peak" : phase === "offpeak" ? "Off-peak" : "Unknown";
}

function formatFactor(factor: number): string {
  if (!Number.isFinite(factor)) return "—";
  const rounded = Math.round(factor * 1000) / 1000;
  return `${rounded}×`;
}

/** Z.ai effects are quota points; no provider effect is ever labelled USD. */
export function temporalEffectLabel(effect: TemporalEffect | undefined): string | undefined {
  if (!effect) return undefined;
  const unit = effect.unit === "quota_points" ? "quota points" : "API price";
  if (effect.direction === "unchanged" || Math.abs(effect.factor - 1) < 1e-9) {
    return `No change to ${unit}`;
  }
  return `${formatFactor(effect.factor)} ${unit}`;
}

export function formatTemporalCountdown(nowMs: number, targetMs: number | undefined): string {
  if (targetMs === undefined || !Number.isFinite(targetMs)) return "—";
  const remaining = targetMs - nowMs;
  if (remaining <= 0) return "now";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const hourRest = hours % 24;
  return hourRest === 0 ? `${days}d` : `${days}d ${hourRest}h`;
}

function intervalAt(model: TemporalModelStatus, nowMs: number): TemporalModelInterval | undefined {
  return model.intervals.find((interval) => nowMs >= interval.startMs && nowMs < interval.endMs);
}

/** Live per-model state, advanced locally between quota polls. */
export function temporalModelStateAt(
  model: TemporalModelStatus,
  nowMs: number,
): { state: TemporalModelStatus["state"]; effect?: TemporalEffect; reason?: string } {
  const interval = intervalAt(model, nowMs);
  if (interval?.phase === "unknown") {
    return {
      state: "unknown",
      ...(interval.effect ? { effect: interval.effect } : {}),
      ...(interval.reason ? { reason: interval.reason } : {}),
    };
  }
  if (interval) {
    return {
      state: interval.phase,
      ...(interval.effect ? { effect: interval.effect } : {}),
      ...(interval.reason ? { reason: interval.reason } : {}),
    };
  }
  return {
    state: model.state,
    ...(model.effect ? { effect: model.effect } : {}),
    ...(model.reason ? { reason: model.reason } : {}),
  };
}

export function combineTemporalPhases(
  models: readonly TemporalModelStatus[],
  nowMs: number,
): TemporalPhase {
  let peak = false;
  let offpeak = false;
  for (const model of models) {
    const state = temporalModelStateAt(model, nowMs).state;
    if (state === "peak") peak = true;
    if (state === "offpeak") offpeak = true;
  }
  if (peak && offpeak) return "mixed";
  if (peak) return "peak";
  if (offpeak) return "offpeak";
  return "unknown";
}

export function temporalProviderPhaseAt(
  provider: TemporalProviderStatus,
  nowMs: number,
): TemporalPhase {
  return combineTemporalPhases(provider.models, nowMs);
}

export function temporalModelNextChangeAt(
  model: TemporalModelStatus,
  nowMs: number,
): number | undefined {
  // The last projected interval ends at the schedule horizon, not at a known
  // transition. Only boundaries followed by another interval are real.
  const scheduled = model.intervals
    .slice(0, -1)
    .map((interval) => interval.endMs)
    .filter((endMs) => endMs > nowMs);
  const next = model.nextChangeAtMs;
  if (scheduled.length === 0) return next !== undefined && next > nowMs ? next : undefined;
  const boundary = Math.min(...scheduled);
  if (next === undefined || next <= nowMs) return boundary;
  return Math.min(next, boundary);
}

export function temporalProviderNextChangeAt(
  provider: TemporalProviderStatus,
  nowMs: number,
): number | undefined {
  const candidates = provider.models
    .map((model) => temporalModelNextChangeAt(model, nowMs))
    .filter((value): value is number => value !== undefined);
  return candidates.length === 0 ? undefined : Math.min(...candidates);
}

export function upcomingTemporalIntervals(
  model: TemporalModelStatus,
  nowMs: number,
  limit = 3,
): TemporalModelInterval[] {
  return model.intervals.filter((interval) => interval.endMs > nowMs).slice(0, limit);
}

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

function sameLocalDay(startMs: number, endMs: number): boolean {
  const start = new Date(startMs);
  const end = new Date(endMs);
  return (
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate()
  );
}

export function formatLocalInterval(startMs: number, endMs: number): string {
  if (sameLocalDay(startMs, endMs)) {
    return `${dateTimeFormat.format(startMs)}–${timeFormat.format(endMs)}`;
  }
  return `${dateTimeFormat.format(startMs)} → ${dateTimeFormat.format(endMs)}`;
}

function civilDate(value: string): string {
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function formatHolidayInterval(holiday: TemporalHolidayInterval): string {
  const endExclusive = Date.parse(`${holiday.localEnd}T00:00:00.000Z`);
  const inclusiveEnd = Number.isFinite(endExclusive)
    ? new Date(endExclusive - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : holiday.localEnd;
  return `${civilDate(holiday.localStart)}–${civilDate(inclusiveEnd)}`;
}

export function localZoneLabel(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "local";
  } catch {
    return "local";
  }
}
