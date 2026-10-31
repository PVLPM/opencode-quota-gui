import type {
  TemporalEffect,
  TemporalHolidayInterval,
  TemporalModelInterval,
  TemporalModelPhase,
  TemporalModelStatus,
  TemporalPhase,
  TemporalProviderStatus,
  TemporalWeekday,
  TemporalWeeklySchedule,
} from "../contracts/temporal";

/**
 * Pure formatting and live-state helpers for the temporal status DTO.
 *
 * The server evaluates policy; this module only reads its emitted windows. That
 * keeps the browser-only formatters testable without the tooltip portal.
 *
 * Locale and time zone are explicit seams for tests. Production passes neither,
 * so the browser's zone is resolved once. Clock convention follows that zone,
 * not the locale: Istanbul stays 24-hour even in an en-US browser, while US
 * zones keep 12-hour time. A server-proven weekly descriptor is rendered in the
 * browser's zone; without it, the exact dated windows are shown instead.
 */

export interface TemporalFormatOptions {
  locale?: string;
  timeZone?: string;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MINUTES = 7 * 1440;
const LOCAL_OFFSET_PROBE_MS = 8 * DAY_MS;
const LOCAL_OFFSET_PROBE_STEP_MS = 6 * HOUR_MS;
const WEEKDAY_ORDER: readonly TemporalWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function canonicalWeekdays(days: readonly TemporalWeekday[]): TemporalWeekday[] {
  const present = new Set(days);
  return WEEKDAY_ORDER.filter((day) => present.has(day));
}

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
  // Quota-point policies are scalar by contract and omit `scalar`. Check the
  // unit first so malformed data can never be described as an API-price change.
  if (effect.unit === "quota_points") {
    return `Quota points: ${formatFactor(effect.factor)}`;
  }
  // A partial bucket change has no single global multiplier; the factor is
  // only a representative value and must not be presented as one scalar.
  if (effect.scalar === false) return "API price varies by token type";
  if (effect.scalar === true) return `API price: ${formatFactor(effect.factor)}`;
  // Older payloads and multiplier-only policies omit the cross-rate indicator.
  // Report the direction without promoting a representative factor to a scalar.
  if (effect.direction === "peak") return "API price: higher";
  if (effect.direction === "offpeak") return "API price: lower";
  return "API price: unchanged";
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

/**
 * A provider aggregate is deliberately conservative: one unresolved model
 * makes the whole provider "Unknown" instead of letting the resolved models
 * claim a peak or off-peak state for it.
 */
export function combineTemporalPhases(
  models: readonly TemporalModelStatus[],
  nowMs: number,
): TemporalPhase {
  let peak = false;
  let offpeak = false;
  let unknown = false;
  for (const model of models) {
    const state = temporalModelStateAt(model, nowMs).state;
    if (state === "unknown") unknown = true;
    if (state === "peak") peak = true;
    if (state === "offpeak") offpeak = true;
  }
  if (unknown) return "unknown";
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

export interface TemporalNextChange {
  atMs: number;
  /**
   * Destination phase only when the source states it. Absent when the payload
   * stops at the three-day projection; never inferred from a later window or
   * from the model's current state.
   */
  phase?: TemporalModelPhase;
  effect?: TemporalEffect;
  reason?: string;
}

/**
 * A projected window boundary always carries a phase — possibly `unknown` —
 * because the interval itself is never phase-less. That is different from the
 * server's optional destination, which stays absent when unstated.
 */
interface ProjectedNextChange extends TemporalNextChange {
  phase: TemporalModelPhase;
}

/** The first transition proved by the exact projected windows. */
function projectedNextChange(
  model: TemporalModelStatus,
  nowMs: number,
): ProjectedNextChange | undefined {
  const currentIndex = model.intervals.findIndex(
    (interval) => nowMs >= interval.startMs && nowMs < interval.endMs,
  );
  const next = currentIndex >= 0 ? model.intervals[currentIndex + 1] : undefined;
  const upcoming = next ?? model.intervals.find((interval) => interval.startMs > nowMs);
  if (!upcoming) return undefined;
  return {
    atMs: upcoming.startMs,
    phase: upcoming.phase,
    ...(upcoming.effect ? { effect: upcoming.effect } : {}),
    ...(upcoming.reason ? { reason: upcoming.reason } : {}),
  };
}

/**
 * Reconcile the exact projected window with the server's independently
 * computed destination. A known projected phase wins unless the server
 * explicitly names a different one; disagreement is not resolved by guessing.
 */
function agreedDestination(
  projected: TemporalModelPhase,
  server: TemporalModelPhase | undefined,
): TemporalModelPhase | undefined {
  if (server === undefined) return projected;
  if (projected === "unknown") return server === "unknown" ? undefined : server;
  if (server === "unknown") return undefined;
  return projected === server ? projected : undefined;
}

/**
 * The next observable transition and its destination. The server can name a
 * transition beyond the exact-window horizon; its `nextState` is used only at
 * that time and only when supplied. A later projected window never supplies a
 * phase for an earlier server transition, and an unresolved or absent
 * destination stays absent.
 */
export function temporalModelNextChange(
  model: TemporalModelStatus,
  nowMs: number,
): TemporalNextChange | undefined {
  const projected = projectedNextChange(model, nowMs);
  const serverAt =
    model.nextChangeAtMs !== undefined && model.nextChangeAtMs > nowMs
      ? model.nextChangeAtMs
      : undefined;

  if (serverAt !== undefined && (projected === undefined || serverAt < projected.atMs)) {
    return {
      atMs: serverAt,
      ...(model.nextState !== undefined ? { phase: model.nextState } : {}),
    };
  }
  if (projected === undefined) return undefined;
  if (serverAt === projected.atMs) {
    const phase = agreedDestination(projected.phase, model.nextState);
    return {
      atMs: projected.atMs,
      ...(phase !== undefined ? { phase } : {}),
      ...(projected.effect ? { effect: projected.effect } : {}),
      ...(projected.reason ? { reason: projected.reason } : {}),
    };
  }
  return projected;
}

export function upcomingTemporalIntervals(
  model: TemporalModelStatus,
  nowMs: number,
  limit = 4,
): TemporalModelInterval[] {
  return model.intervals.filter((interval) => interval.endMs > nowMs).slice(0, limit);
}

export interface TemporalModelGroup {
  /** Identity of the policy, never a display label. */
  key: string;
  models: TemporalModelStatus[];
}

/**
 * Identity of the policy a route currently exposes: its live classification,
 * reason, every exact window, and the server's independent next transition.
 * The DTO carries no stable policy id, so any difference in this snapshot -
 * including a future window or the next destination - keeps routes apart.
 * `modelId` is deliberately excluded: that is the only field routes may share.
 */
function temporalPolicyKey(model: TemporalModelStatus): string {
  return JSON.stringify({
    state: model.state,
    effect: model.effect ?? null,
    nextChangeAtMs: model.nextChangeAtMs ?? null,
    nextState: model.nextState ?? null,
    reason: model.reason ?? null,
    intervals: model.intervals.map((interval) => ({
      startMs: interval.startMs,
      endMs: interval.endMs,
      phase: interval.phase,
      effect: interval.effect ?? null,
      reason: interval.reason ?? null,
    })),
    weekly: weeklyPolicyKey(model.weekly),
  });
}

/** Canonical weekly identity: field order, window order and days never matter. */
function weeklyPolicyKey(weekly: TemporalWeeklySchedule | undefined): unknown {
  if (!weekly) return null;
  const effectFields = (effect: TemporalEffect | undefined) =>
    effect ? [effect.factor, effect.direction, effect.unit, effect.scalar ?? null] : null;
  return {
    timeZone: weekly.timeZone,
    utcOffsetMinutes: weekly.utcOffsetMinutes,
    basePhase: weekly.basePhase,
    baseEffect: effectFields(weekly.baseEffect),
    windows: weekly.windows
      .map((window) => ({
        days: canonicalWeekdays(window.days),
        startMinute: window.startMinute,
        endMinute: window.endMinute,
        phase: window.phase,
        effect: effectFields(window.effect),
      }))
      .sort(
        (left, right) =>
          left.startMinute - right.startMinute ||
          left.endMinute - right.endMinute ||
          left.phase.localeCompare(right.phase) ||
          left.days.join(",").localeCompare(right.days.join(",")) ||
          (left.effect?.join("|") ?? "").localeCompare(right.effect?.join("|") ?? ""),
      ),
    exceptHolidays: [...(weekly.exceptHolidays ?? [])].sort(),
  };
}

/**
 * Models that expose the same effective policy snapshot are one group. The
 * popover shows the schedule once and lists the compact model ids.
 */
export function groupTemporalModels(models: readonly TemporalModelStatus[]): TemporalModelGroup[] {
  const groups = new Map<string, TemporalModelGroup>();
  for (const model of models) {
    const key = temporalPolicyKey(model);
    const existing = groups.get(key);
    if (existing) {
      existing.models.push(model);
      continue;
    }
    groups.set(key, { key, models: [model] });
  }
  return [...groups.values()];
}

function effectKey(effect: TemporalEffect | undefined): string {
  return JSON.stringify(effect ?? null);
}

/** True when upcoming buckets do not share one scalar effect. */
export function temporalEffectVaries(model: TemporalModelStatus, nowMs = 0): boolean {
  const keys = new Set<string>();
  for (const interval of model.intervals) {
    if (interval.endMs <= nowMs) continue;
    keys.add(effectKey(interval.effect));
  }
  return keys.size > 1;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

type FormatterKind = "parts" | "date" | "time" | "dateTime" | "clock";

/**
 * Clock convention belongs to the zone whose wall clock is shown, not to the
 * browser locale. Without this, an en-US browser renders Istanbul's 14:00 as
 * "2:00 PM". US zones keep a 12-hour clock; every other zone uses 24-hour time,
 * so a locale can never force a 12-hour clock onto Istanbul.
 */
const TWELVE_HOUR_ZONES: ReadonlySet<string> = new Set([
  "America/New_York",
  "America/Detroit",
  "America/Chicago",
  "America/Denver",
  "America/Boise",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Juneau",
  "America/Sitka",
  "America/Metlakatla",
  "America/Yakutat",
  "America/Nome",
  "America/Adak",
  "America/Atka",
  "America/Aleutian",
  "America/Indianapolis",
  "America/Fort_Wayne",
  "America/Louisville",
  "America/Puerto_Rico",
  "America/St_Thomas",
  "America/Charlotte_Amalie",
  "America/Virgin",
  "Pacific/Honolulu",
  "Pacific/Johnston",
  "Pacific/Midway",
  "Pacific/Wake",
  "Pacific/Guam",
  "Pacific/Saipan",
  "Pacific/Pago_Pago",
  "Pacific/Samoa",
]);

const TWELVE_HOUR_ZONE_PREFIXES = [
  "America/Indiana/",
  "America/Kentucky/",
  "America/North_Dakota/",
] as const;

function resolvedTimeZone(timeZone: string | undefined): string | undefined {
  if (timeZone !== undefined && timeZone.length > 0) return timeZone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function isTwelveHourZone(zone: string): boolean {
  if (TWELVE_HOUR_ZONES.has(zone)) return true;
  return TWELVE_HOUR_ZONE_PREFIXES.some((prefix) => zone.startsWith(prefix));
}

function hourCycleFor(timeZone: string | undefined): "h12" | "h23" {
  const requested = resolvedTimeZone(timeZone);
  if (requested === undefined) return "h23";
  if (isTwelveHourZone(requested)) return "h12";
  // `Intl` canonicalizes aliases (US/Eastern -> America/New_York), so check the
  // normalized name too; otherwise a valid US alias would fall back to 24-hour.
  try {
    const canonical = new Intl.DateTimeFormat("en-US", {
      timeZone: requested,
    }).resolvedOptions().timeZone;
    if (canonical !== undefined && isTwelveHourZone(canonical)) return "h12";
  } catch {
    // An invalid zone is handled by the formatter constructor below.
  }
  return "h23";
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(
  kind: FormatterKind,
  locale: string | undefined,
  timeZone: string | undefined,
): Intl.DateTimeFormat {
  const key = `${kind}|${locale ?? ""}|${timeZone ?? ""}`;
  const cached = formatterCache.get(key);
  if (cached) return cached;
  const hourCycle = hourCycleFor(timeZone);
  const options: Intl.DateTimeFormatOptions =
    kind === "parts"
      ? {
          timeZone,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        }
      : kind === "date"
        ? { timeZone, month: "numeric", day: "numeric" }
        : kind === "time"
          ? { timeZone, hour: "numeric", minute: "2-digit", hourCycle }
          : kind === "clock"
            ? { timeZone: "UTC", hour: "numeric", minute: "2-digit", hourCycle }
            : {
                timeZone,
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                hourCycle,
              };
  const formatter = new Intl.DateTimeFormat(locale, options);
  if (formatterCache.size >= 64) {
    const oldest = formatterCache.keys().next().value;
    if (oldest !== undefined) formatterCache.delete(oldest);
  }
  formatterCache.set(key, formatter);
  return formatter;
}

function partNumber(parts: Intl.DateTimeFormatPart[], type: string): number {
  return Number(parts.find((part) => part.type === type)?.value ?? "0");
}

function zonedParts(ms: number, options: TemporalFormatOptions): ZonedParts {
  const parts = cachedFormatter("parts", options.locale, options.timeZone).formatToParts(ms);
  return {
    year: partNumber(parts, "year"),
    month: partNumber(parts, "month"),
    day: partNumber(parts, "day"),
    hour: partNumber(parts, "hour"),
    minute: partNumber(parts, "minute"),
    second: partNumber(parts, "second"),
  };
}

function sameLocalDate(left: ZonedParts, right: ZonedParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function formatLocalDate(ms: number, options: TemporalFormatOptions): string {
  return cachedFormatter("date", options.locale, options.timeZone).format(ms);
}

function formatLocalTime(ms: number, options: TemporalFormatOptions): string {
  return cachedFormatter("time", options.locale, options.timeZone).format(ms);
}

function formatLocalDateTime(ms: number, options: TemporalFormatOptions): string {
  return cachedFormatter("dateTime", options.locale, options.timeZone).format(ms);
}

/** Local UTC offset in minutes at one instant. */
function zoneOffsetMinutes(ms: number, options: TemporalFormatOptions): number {
  const parts = zonedParts(ms, options);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE_MS);
}

/**
 * A local weekly description is only stable while the browser zone keeps one
 * offset. Probe one full week plus a day every six hours; a DST transition
 * anywhere in that window makes the weekly claim false, so the caller falls
 * back to the exact dated windows.
 */
const offsetStabilityCache = new Map<string, boolean>();

function localOffsetChanges(nowMs: number, options: TemporalFormatOptions): boolean {
  const cacheKey = `${options.timeZone ?? "local"}|${Math.floor(nowMs / HOUR_MS)}`;
  const cached = offsetStabilityCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const initial = zoneOffsetMinutes(nowMs, options);
  let changes = false;
  for (
    let offset = LOCAL_OFFSET_PROBE_STEP_MS;
    offset <= LOCAL_OFFSET_PROBE_MS;
    offset += LOCAL_OFFSET_PROBE_STEP_MS
  ) {
    if (zoneOffsetMinutes(nowMs + offset, options) !== initial) {
      changes = true;
      break;
    }
  }
  if (offsetStabilityCache.size >= 32) {
    const oldest = offsetStabilityCache.keys().next().value;
    if (oldest !== undefined) offsetStabilityCache.delete(oldest);
  }
  offsetStabilityCache.set(cacheKey, changes);
  return changes;
}

function formatClockMinute(minute: number, options: TemporalFormatOptions): string {
  if (minute === 1440) {
    return hourCycleFor(options.timeZone) === "h23" ? "24:00" : formatClockMinute(0, options);
  }
  const normalized = ((minute % 1440) + 1440) % 1440;
  return cachedFormatter("clock", options.locale, options.timeZone).format(
    Date.UTC(2026, 0, 1, 0, normalized),
  );
}

/** Local minute-of-day range; `1440` is the end of that local day. */
export function formatClockRange(
  startMinute: number,
  endMinute: number,
  options: TemporalFormatOptions = {},
): string {
  if (startMinute === 0 && endMinute === 1440) return "all day";
  return `${formatClockMinute(startMinute, options)}–${formatClockMinute(endMinute, options)}`;
}

function isLocalMidnight(ms: number, options: TemporalFormatOptions): boolean {
  const parts = zonedParts(ms, options);
  return parts.hour === 0 && parts.minute === 0 && parts.second === 0;
}

export function formatLocalInterval(
  startMs: number,
  endMs: number,
  options: TemporalFormatOptions = {},
): string {
  const start = zonedParts(startMs, options);
  const end = zonedParts(endMs, options);
  if (sameLocalDate(start, end)) {
    return `${formatLocalDateTime(startMs, options)}–${formatLocalTime(endMs, options)}`;
  }
  return `${formatLocalDateTime(startMs, options)} → ${formatLocalDateTime(endMs, options)}`;
}

/**
 * The nearest upcoming or ongoing holiday, by its actual instant. Dates are
 * rendered in the browser's zone: a holiday that starts or ends mid-day shows
 * times, while a full local day shows dates only.
 */
export function nearestTemporalHoliday(
  holidays: readonly TemporalHolidayInterval[],
  nowMs: number,
): TemporalHolidayInterval | undefined {
  return holidays
    .filter((holiday) => holiday.endMs > nowMs)
    .sort((left, right) => left.startMs - right.startMs)[0];
}

/** A holiday already in progress, as opposed to the next upcoming one. */
export function isCurrentTemporalHoliday(holiday: TemporalHolidayInterval, nowMs: number): boolean {
  return holiday.startMs <= nowMs && nowMs < holiday.endMs;
}

export function formatTemporalHoliday(
  holiday: TemporalHolidayInterval,
  options: TemporalFormatOptions = {},
): string {
  if (isLocalMidnight(holiday.startMs, options) && isLocalMidnight(holiday.endMs, options)) {
    const start = formatLocalDate(holiday.startMs, options);
    const end = formatLocalDate(holiday.endMs - 1, options);
    return start === end ? start : `${start}–${end}`;
  }
  return formatLocalInterval(holiday.startMs, holiday.endMs, options);
}

export interface TemporalLocalWeeklyWindow {
  /** Local weekdays on which this same window repeats, Monday-first. */
  days: TemporalWeekday[];
  /** Inclusive local minute of day. */
  startMinute: number;
  /** Exclusive local minute of day; `1440` ends that local day. */
  endMinute: number;
  phase: TemporalModelPhase;
  effect?: TemporalEffect;
}

export interface TemporalWeeklyScheduleDescription {
  kind: "weekly";
  basePhase: TemporalModelPhase;
  windows: TemporalLocalWeeklyWindow[];
  /** Base and window effects are not all the same. */
  effectVaries: boolean;
}

export interface TemporalDatedSchedule {
  kind: "dates";
  intervals: TemporalModelInterval[];
  /** The browser zone changes offset soon, so a weekly local claim is unsafe. */
  localClockChanges?: boolean;
}

export type TemporalScheduleDescription = TemporalWeeklyScheduleDescription | TemporalDatedSchedule;

interface LocalDaySegment {
  day: TemporalWeekday;
  startMinute: number;
  endMinute: number;
  phase: TemporalModelPhase;
  effect?: TemporalEffect;
}

function weeklyWindowKey(window: {
  startMinute: number;
  endMinute: number;
  phase: TemporalModelPhase;
  effect?: TemporalEffect;
}): string {
  return JSON.stringify([
    window.startMinute,
    window.endMinute,
    window.phase,
    window.effect ?? null,
  ]);
}

function firstWeeklyDay(days: readonly TemporalWeekday[]): number {
  const indices = days.map((day) => WEEKDAY_ORDER.indexOf(day)).filter((index) => index >= 0);
  return indices.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...indices);
}

/**
 * Map source-zone weekly windows onto local wall-clock days. A window can cross
 * local midnight after the offset shift, so it is split at each local day
 * boundary; a source weekday near midnight can also land on the previous or
 * next local weekday. The caller only reaches this when the local offset is
 * stable for the probe period.
 */
function localWeeklySegments(
  weekly: TemporalWeeklySchedule,
  shiftMinutes: number,
): LocalDaySegment[] {
  const segments: LocalDaySegment[] = [];
  for (const window of weekly.windows) {
    const duration = window.endMinute - window.startMinute;
    if (duration <= 0) continue;
    for (const day of canonicalWeekdays(window.days)) {
      const sourceDay = WEEKDAY_ORDER.indexOf(day);
      if (sourceDay < 0) continue;
      let cursor =
        (((sourceDay * 1440 + window.startMinute + shiftMinutes) % WEEK_MINUTES) + WEEK_MINUTES) %
        WEEK_MINUTES;
      let remaining = duration;
      while (remaining > 0) {
        const dayIndex = Math.floor(cursor / 1440);
        const startMinute = cursor % 1440;
        const take = Math.min(remaining, 1440 - startMinute);
        const localDay = WEEKDAY_ORDER[dayIndex];
        if (localDay !== undefined) {
          segments.push({
            day: localDay,
            startMinute,
            endMinute: startMinute + take,
            phase: window.phase,
            ...(window.effect ? { effect: window.effect } : {}),
          });
        }
        remaining -= take;
        cursor = (cursor + take) % WEEK_MINUTES;
      }
    }
  }
  return segments;
}

/** Merge identical local windows across their matching local weekdays. */
function groupLocalWeeklySegments(
  segments: readonly LocalDaySegment[],
): TemporalLocalWeeklyWindow[] {
  const grouped = new Map<
    string,
    {
      startMinute: number;
      endMinute: number;
      phase: TemporalModelPhase;
      effect?: TemporalEffect;
      days: Set<TemporalWeekday>;
    }
  >();
  for (const segment of segments) {
    const key = weeklyWindowKey(segment);
    const existing = grouped.get(key);
    if (existing) {
      existing.days.add(segment.day);
      continue;
    }
    grouped.set(key, {
      startMinute: segment.startMinute,
      endMinute: segment.endMinute,
      phase: segment.phase,
      ...(segment.effect ? { effect: segment.effect } : {}),
      days: new Set([segment.day]),
    });
  }
  return [...grouped.values()]
    .map((window) => ({
      days: canonicalWeekdays([...window.days]),
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      phase: window.phase,
      ...(window.effect ? { effect: window.effect } : {}),
    }))
    .sort(
      (left, right) =>
        firstWeeklyDay(left.days) - firstWeeklyDay(right.days) ||
        left.startMinute - right.startMinute ||
        left.endMinute - right.endMinute ||
        left.phase.localeCompare(right.phase),
    );
}

/**
 * The server's weekly descriptor is authoritative. It is rendered in the
 * browser's zone only while that zone keeps one UTC offset over the upcoming
 * week; a clock change would make the local weekday/time claim false, so the
 * exact dated windows remain the fallback. Without a descriptor, sampling
 * observed windows never invents a recurrence.
 */
export function describeTemporalSchedule(
  model: TemporalModelStatus,
  nowMs: number,
  options: TemporalFormatOptions = {},
): TemporalScheduleDescription {
  const weekly = model.weekly;
  if (!weekly) {
    return { kind: "dates", intervals: upcomingTemporalIntervals(model, nowMs, 4) };
  }
  // A base-only week has no local clock times to shift; an offset change cannot
  // make "off-peak all week" false, so it needs no dated fallback.
  if (weekly.windows.length > 0 && localOffsetChanges(nowMs, options)) {
    return {
      kind: "dates",
      intervals: upcomingTemporalIntervals(model, nowMs, 4),
      localClockChanges: true,
    };
  }
  const shiftMinutes = zoneOffsetMinutes(nowMs, options) - weekly.utcOffsetMinutes;
  const windows = groupLocalWeeklySegments(localWeeklySegments(weekly, shiftMinutes));
  const effects = new Set<string>([effectKey(weekly.baseEffect)]);
  for (const window of weekly.windows) effects.add(effectKey(window.effect));
  return {
    kind: "weekly",
    basePhase: weekly.basePhase,
    windows,
    effectVaries: effects.size > 1,
  };
}
