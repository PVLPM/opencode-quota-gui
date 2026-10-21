/**
 * Host-local calendar arithmetic without a Temporal dependency.
 *
 * Browser-safe: uses `Intl` only. Callers pass the zone explicitly; production
 * passes the zone resolved once on the Node host, so the browser never falls
 * back to its own default zone.
 *
 * A wall-clock label is resolved to every matching UTC instant: zero in a DST
 * gap, one normally, two in a DST overlap. Flooring then picks the occurrence
 * that contains the instant, and hour stepping emits a repeated hour instead of
 * silently swallowing it.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

export type ZonedUnit = "hour" | "day";

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface WallLabel {
  year: number;
  month: number;
  day: number;
  hour: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

function readPart(parts: Intl.DateTimeFormatPart[], type: string): number {
  const part = parts.find((entry) => entry.type === type);
  const value = part === undefined ? Number.NaN : Number(part.value);
  return Number.isFinite(value) ? value : Number.NaN;
}

function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  return {
    year: readPart(parts, "year"),
    month: readPart(parts, "month"),
    day: readPart(parts, "day"),
    hour: readPart(parts, "hour") % 24,
    minute: readPart(parts, "minute"),
    second: readPart(parts, "second"),
  };
}

/** Zone offset at an instant: `localWallClockAsUtc - instant`. */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  const parts = zonedParts(whole, timeZone);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - whole
  );
}

function labelFor(parts: ZonedParts, unit: ZonedUnit): WallLabel {
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: unit === "hour" ? parts.hour : 0,
  };
}

function naiveUtc(label: WallLabel): number {
  return Date.UTC(label.year, label.month - 1, label.day, label.hour);
}

function labelMatches(parts: ZonedParts, label: WallLabel): boolean {
  return (
    parts.year === label.year &&
    parts.month === label.month &&
    parts.day === label.day &&
    parts.hour === label.hour &&
    parts.minute === 0 &&
    parts.second === 0
  );
}

/**
 * Every UTC instant whose wall clock equals `label`, sorted ascending.
 * Probing the offsets a day either side captures both sides of an offset
 * transition (including 30- and 45-minute shifts) without assuming the offset
 * near the naive timestamp is the right one.
 */
function candidatesFor(label: WallLabel, timeZone: string): number[] {
  const naive = naiveUtc(label);
  const offsets = new Set<number>();
  for (const probe of [naive - DAY_MS, naive, naive + DAY_MS]) {
    offsets.add(offsetAt(probe, timeZone));
  }
  const candidates: number[] = [];
  for (const offset of offsets) {
    const candidate = naive - offset;
    if (!labelMatches(zonedParts(candidate, timeZone), label)) continue;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  return candidates.sort((a, b) => a - b);
}

/** First instant whose local date equals {@link label}; undefined for an entirely skipped date. */
function firstInstantOfLocalDate(label: WallLabel, timeZone: string): number | undefined {
  const naive = naiveUtc({ ...label, hour: 0 });
  const offsets = new Set<number>();
  for (const probe of [naive - DAY_MS, naive, naive + DAY_MS]) {
    offsets.add(offsetAt(probe, timeZone));
  }
  let first: number | undefined;
  for (const offset of offsets) {
    const candidate = naive - offset;
    const parts = zonedParts(candidate, timeZone);
    if (parts.year !== label.year || parts.month !== label.month || parts.day !== label.day) {
      continue;
    }
    if (first === undefined || candidate < first) first = candidate;
  }
  return first;
}

/** First instant inside a local unit whose exact unit start does not exist (DST gap). */
function firstInstantInGap(ms: number, unit: ZonedUnit, timeZone: string): number {
  const parts = zonedParts(ms, timeZone);
  const label = labelFor(parts, unit);
  if (unit === "day") {
    // A skipped local midnight: the day starts at the transition instant, which
    // can sit several UTC hours after the naive wall label (e.g. America/Santiago).
    // `ms` itself is on that local date, so a match always exists.
    return firstInstantOfLocalDate(label, timeZone) ?? ms;
  }
  const naive = naiveUtc(label);
  for (let offset = -2 * HOUR_MS; offset <= 2 * HOUR_MS; offset += MINUTE_MS) {
    const candidate = naive + offset;
    const candidateParts = zonedParts(candidate, timeZone);
    if (
      candidateParts.year === label.year &&
      candidateParts.month === label.month &&
      candidateParts.day === label.day &&
      candidateParts.hour === label.hour
    ) {
      return candidate;
    }
  }
  return naive;
}

function shiftLabel(label: WallLabel, unit: ZonedUnit): WallLabel {
  if (unit === "hour") {
    const next = new Date(Date.UTC(label.year, label.month - 1, label.day, label.hour + 1));
    return {
      year: next.getUTCFullYear(),
      month: next.getUTCMonth() + 1,
      day: next.getUTCDate(),
      hour: next.getUTCHours(),
    };
  }
  const next = new Date(Date.UTC(label.year, label.month - 1, label.day + 1));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
  };
}

/**
 * UTC instant of the host-local hour/day that contains `ms`.
 *
 * A day always returns the earliest instant of that local date, so a repeated
 * midnight cannot split one calendar day into two. An hour returns the
 * occurrence containing `ms`, so the second pass of a repeated hour floors to
 * its own start.
 */
export function startOfZonedUnit(ms: number, unit: ZonedUnit, timeZone: string): number {
  if (!Number.isFinite(ms)) {
    throw new RangeError("ms must be a finite epoch-millisecond timestamp");
  }
  const candidates = candidatesFor(labelFor(zonedParts(ms, timeZone), unit), timeZone);
  const before = candidates.filter((candidate) => candidate <= ms);
  if (before.length > 0) {
    return unit === "day" ? (before[0] as number) : (before[before.length - 1] as number);
  }
  return firstInstantInGap(ms, unit, timeZone);
}

/**
 * Start of the next host-local hour/day strictly after `startMs`.
 *
 * For hours, every matching instant of the current wall label is emitted before
 * advancing the label, which preserves both passes of a repeated hour. For days,
 * a wall date has one start (its earliest instant) and entirely skipped dates are
 * skipped.
 */
export function nextZonedUnitStart(startMs: number, unit: ZonedUnit, timeZone: string): number {
  const parts = zonedParts(startMs, timeZone);
  let label = labelFor(parts, unit);
  const limit = unit === "hour" ? 72 : 800;
  for (let step = 0; step < limit; step += 1) {
    const candidates = candidatesFor(label, timeZone);
    if (unit === "day") {
      // A date whose midnight is skipped still starts at its first real instant;
      // a date that is skipped entirely (a date-line jump) has none and is skipped.
      const next = candidates[0] ?? firstInstantOfLocalDate(label, timeZone);
      if (next !== undefined && next > startMs) return next;
    } else {
      const next = candidates.find((candidate) => candidate > startMs);
      if (next !== undefined) return next;
    }
    label = shiftLabel(label, unit);
  }
  throw new RangeError(`Could not find the next ${unit} boundary after ${startMs}`);
}
