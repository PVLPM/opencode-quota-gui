/**
 * Server-side temporal status projection for the dashboard.
 *
 * `src/lib/modelsdev-temporal.ts` is the only models.dev policy evaluator, and
 * it reads its bundled snapshot with `node:fs`, so this module is server-only.
 * It evaluates exact snapshot routes plus provider-maintained quota policies,
 * and emits a browser-safe DTO. Display labels never become model ids: a route
 * is included only when its exact provider/model key exists in a policy.
 */

import { readFileSync } from "node:fs";

import type {
  TemporalEffect,
  TemporalHoliday,
  TemporalHolidayInterval,
  TemporalModelInterval,
  TemporalModelPhase,
  TemporalModelStatus,
  TemporalPhase,
  TemporalPolicySource,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
  TemporalWeekday,
  TemporalWeeklySchedule,
} from "../contracts/temporal.js";
import { lookupCost } from "../lib/modelsdev-pricing.js";
import {
  getNextTemporalTransition,
  getTemporalInstantState,
  getTemporalPolicy,
  getTemporalSnapshotMeta,
  listTemporalIntervals,
  TEMPORAL_DAYS,
  TEMPORAL_HOLIDAYS,
  type TemporalCondition,
  type TemporalInstantState,
  type TemporalPolicyEntry,
  type TemporalRates,
} from "../lib/modelsdev-temporal.js";
import {
  getQuotaProviderDisplayLabel,
  normalizeQuotaProviderId,
} from "../lib/provider-metadata.js";
import { buildQuotaPolicyModels, type TemporalQuotaPolicy } from "./temporal-quota-policy.js";
import { TEMPORAL_QUOTA_POLICIES } from "./temporal-quota-policy-data.js";

/** How far ahead exact schedule windows are projected for the popover. */
export const TEMPORAL_SCHEDULE_HORIZON_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_INTERVALS_PER_MODEL = 24;
const MAX_HOLIDAYS_PER_PROVIDER = 8;
/**
 * Mirrors core's private `MAX_TRANSITION_HORIZON_MS` (five 366-day years). The
 * GUI searches the same supported horizon instead of inventing a step cutoff.
 */
const TRANSITION_SEARCH_HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;
/** Chunk the horizon so long no-op runs exit before allocating years of windows. */
const TRANSITION_SEARCH_CHUNK_MS = 31 * 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const RATE_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"] as const;

export interface TemporalProviderSource {
  providerId: string;
  providerLabel: string;
  /** True when the current quota cycle discovered an account/card. */
  discovered: boolean;
}

export interface TemporalBundledCatalog {
  /** Exact models.dev provider → model routes. */
  routes: Record<string, string[]>;
  holidays: TemporalHolidayInterval[];
}

export interface BuildTemporalStatusInput {
  providers: readonly TemporalProviderSource[];
  nowMs: number;
  /** Exact routes; integration passes the bundled catalog. */
  routes: Readonly<Record<string, readonly string[]>>;
  /** Holiday calendars referenced by the bundled snapshot. */
  holidays?: readonly TemporalHolidayInterval[];
  /**
   * Test/embedding seam only. Production reads the active pricing snapshot so
   * an override can be compared with the same base it replaces.
   */
  baseRates?: (providerId: string, modelId: string) => TemporalRates | null;
  /** Provider-maintained quota policies; defaults to the bundled data module. */
  quotaPolicies?: readonly TemporalQuotaPolicy[];
}

let bundledCatalog: TemporalBundledCatalog | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the one bundled snapshot as exact route keys plus holiday calendars. */
export function readBundledTemporalCatalog(): TemporalBundledCatalog {
  if (bundledCatalog) return bundledCatalog;
  const raw: unknown = JSON.parse(
    readFileSync(new URL("../data/modelsdev-temporal.min.json", import.meta.url), "utf8"),
  );
  const routes: Record<string, string[]> = {};
  const root = isRecord(raw) ? raw : {};
  if (isRecord(root.providers)) {
    for (const [providerId, models] of Object.entries(root.providers)) {
      if (!isRecord(models)) continue;
      // "Capable" means at least one model with a real policy. An entry that is
      // only `unsupported` has no schedule at all, so it neither earns a
      // Settings row nor an unknown chip on Quota.
      const capable = Object.entries(models)
        .filter(([, entry]) => isRecord(entry) && entry.status !== "unsupported")
        .map(([modelId]) => modelId)
        .sort((left, right) => left.localeCompare(right));
      if (capable.length > 0) routes[providerId] = capable;
    }
  }

  const holidays: TemporalHolidayInterval[] = [];
  if (isRecord(root.jurisdictions)) {
    for (const [jurisdiction, years] of Object.entries(root.jurisdictions)) {
      if (jurisdiction !== "CN" && jurisdiction !== "US" && jurisdiction !== "CA") continue;
      if (!isRecord(years)) continue;
      for (const calendar of Object.values(years)) {
        if (!isRecord(calendar) || !Array.isArray(calendar.intervals)) continue;
        for (const interval of calendar.intervals) {
          if (!isRecord(interval)) continue;
          const { id, localStart, localEnd, startMs, endMs } = interval;
          if (
            typeof id !== "string" ||
            typeof localStart !== "string" ||
            typeof localEnd !== "string" ||
            typeof startMs !== "number" ||
            !Number.isFinite(startMs) ||
            typeof endMs !== "number" ||
            !Number.isFinite(endMs)
          ) {
            continue;
          }
          holidays.push({
            jurisdiction,
            id,
            localStart,
            localEnd,
            startMs,
            endMs,
          });
        }
      }
    }
  }
  holidays.sort((left, right) => left.startMs - right.startMs);

  bundledCatalog = { routes, holidays };
  return bundledCatalog;
}

function ratesFromCost(providerId: string, modelId: string): TemporalRates | null {
  const cost = lookupCost(providerId, modelId);
  if (!cost) return null;
  const rates: TemporalRates = {};
  for (const key of RATE_KEYS) {
    const value = cost[key];
    if (typeof value === "number" && Number.isFinite(value)) rates[key] = value;
  }
  return Object.keys(rates).length > 0 ? rates : null;
}

function mergeActiveRates(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  activeRuleIds: readonly string[],
  base: TemporalRates,
): TemporalRates {
  const active = new Set(activeRuleIds);
  const rates: TemporalRates = { ...base };
  for (const override of policy.overrides) {
    if (!active.has(override.id)) continue;
    for (const key of RATE_KEYS) {
      const value = override.rates[key];
      if (value !== undefined) rates[key] = value;
    }
  }
  for (const multiplier of policy.multipliers) {
    if (!active.has(multiplier.id)) continue;
    const factor =
      typeof multiplier.factor === "number" ? multiplier.factor : multiplier.factor.text;
    for (const key of RATE_KEYS) {
      const value = rates[key];
      if (value !== undefined) rates[key] = value * factor;
    }
  }
  return rates;
}

function factorFor(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  activeRuleIds: readonly string[],
  base: TemporalRates | null,
): number | undefined {
  const active = new Set(activeRuleIds);
  if (base) {
    const resolved = mergeActiveRates(policy, activeRuleIds, base);
    for (const key of RATE_KEYS) {
      const baseValue = base[key];
      const resolvedValue = resolved[key];
      if (
        typeof baseValue === "number" &&
        baseValue > 0 &&
        typeof resolvedValue === "number" &&
        Number.isFinite(resolvedValue)
      ) {
        return resolvedValue / baseValue;
      }
    }
  }
  let factor = 1;
  let activeMultiplier = false;
  for (const multiplier of policy.multipliers) {
    if (!active.has(multiplier.id)) continue;
    activeMultiplier = true;
    factor *= typeof multiplier.factor === "number" ? multiplier.factor : multiplier.factor.text;
  }
  // An active override without any base rate cannot be compared to anything,
  // so it stays unknown instead of being guessed as a discount.
  if (!activeMultiplier && policy.overrides.some((override) => active.has(override.id))) {
    return undefined;
  }
  return factor;
}

const TEMPORAL_FACTOR_EPSILON = 1e-9;

type TemporalMovement = "increase" | "decrease" | "equal" | "mixed" | "incomparable";
type TemporalPolicyDirection = "discount" | "surcharge" | "mixed" | "equal" | "incomparable";

/**
 * Relative movement of every comparable base rate. This mirrors the analytics
 * baseline rule: a policy that only discounts keeps its unchanged base on
 * peak, while a policy that only surcharges keeps its unchanged base on
 * off-peak. Opposite movements in one state are ambiguous and unusable.
 */
function rateMovement(base: TemporalRates, resolved: TemporalRates): TemporalMovement {
  let comparable = false;
  let sawIncrease = false;
  let sawDecrease = false;
  for (const key of RATE_KEYS) {
    const baseRate = base[key];
    const resolvedRate = resolved[key];
    if (
      typeof baseRate !== "number" ||
      baseRate <= 0 ||
      typeof resolvedRate !== "number" ||
      !Number.isFinite(resolvedRate)
    ) {
      continue;
    }
    comparable = true;
    if (resolvedRate > baseRate * (1 + TEMPORAL_FACTOR_EPSILON)) sawIncrease = true;
    else if (resolvedRate < baseRate * (1 - TEMPORAL_FACTOR_EPSILON)) sawDecrease = true;
  }
  if (!comparable) return "incomparable";
  if (sawIncrease && sawDecrease) return "mixed";
  if (sawIncrease) return "increase";
  if (sawDecrease) return "decrease";
  return "equal";
}

function multiplierMovement(factor: number | { text: number }): TemporalMovement {
  const value = typeof factor === "number" ? factor : factor.text;
  if (!Number.isFinite(value)) return "incomparable";
  if (value > 1 + TEMPORAL_FACTOR_EPSILON) return "increase";
  if (value < 1 - TEMPORAL_FACTOR_EPSILON) return "decrease";
  return "equal";
}

/**
 * Direction of every admissible rule in one policy. A discount-only policy
 * has a peak base state; a surcharge-only policy has an off-peak base state.
 * Mixed, equal-only, or unverifiable rules cannot establish which side the
 * unchanged base belongs to, so they fail closed.
 */
function policyDirection(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  base: TemporalRates | null,
): TemporalPolicyDirection {
  let discount = false;
  let surcharge = false;
  let unverifiedOverride = false;
  for (const override of policy.overrides) {
    if (!base) {
      unverifiedOverride = true;
      continue;
    }
    const movement = rateMovement(base, override.rates);
    if (movement === "mixed") return "mixed";
    if (movement === "incomparable") continue;
    if (movement === "increase") surcharge = true;
    else if (movement === "decrease") discount = true;
  }
  for (const multiplier of policy.multipliers) {
    const movement = multiplierMovement(multiplier.factor);
    if (movement === "incomparable") continue;
    if (movement === "increase") surcharge = true;
    else if (movement === "decrease") discount = true;
  }
  if (discount && surcharge) return "mixed";
  if (unverifiedOverride) return "incomparable";
  if (discount) return "discount";
  if (surcharge) return "surcharge";
  return "equal";
}

function stateMovement(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  activeRuleIds: readonly string[],
  base: TemporalRates | null,
): TemporalMovement {
  if (base) return rateMovement(base, mergeActiveRates(policy, activeRuleIds, base));
  const active = new Set(activeRuleIds);
  if (policy.overrides.some((override) => active.has(override.id))) return "incomparable";
  const factor = factorFor(policy, activeRuleIds, null);
  return factor === undefined ? "incomparable" : multiplierMovement(factor);
}

function effectFor(factor: number | undefined): TemporalEffect | undefined {
  if (factor === undefined || !Number.isFinite(factor) || factor < 0) return undefined;
  const direction =
    factor > 1 + TEMPORAL_FACTOR_EPSILON
      ? "peak"
      : factor < 1 - TEMPORAL_FACTOR_EPSILON
        ? "offpeak"
        : "unchanged";
  return {
    factor,
    direction,
    unit: "api_price",
  };
}

function classifyState(
  policy: TemporalPolicyEntry | null,
  activeRuleIds: readonly string[],
  base: TemporalRates | null,
): { phase: TemporalModelPhase; effect?: TemporalEffect } {
  if (!policy || policy.status === "unsupported") return { phase: "unknown" };
  // Without a direction, factor 1 is not evidence of off-peak (or peak).
  const direction = policyDirection(policy, base);
  if (direction === "mixed" || direction === "equal" || direction === "incomparable") {
    return { phase: "unknown" };
  }
  const movement = stateMovement(policy, activeRuleIds, base);
  if (movement === "mixed" || movement === "incomparable") return { phase: "unknown" };

  let phase: TemporalModelPhase = "unknown";
  if (direction === "discount") {
    if (movement === "decrease") phase = "offpeak";
    else if (movement === "equal") phase = "peak";
  } else {
    if (movement === "increase") phase = "peak";
    else if (movement === "equal") phase = "offpeak";
  }
  if (phase === "unknown") return { phase };
  return { phase, effect: effectFor(factorFor(policy, activeRuleIds, base)) };
}

/** Classify an instant, keeping unresolved/unsupported states unknown. */
function classifyInstant(
  policy: TemporalPolicyEntry | null,
  instant: TemporalInstantState,
  base: TemporalRates | null,
): { phase: TemporalModelPhase; effect?: TemporalEffect } {
  if (instant.status !== "resolved") return { phase: "unknown" };
  return classifyState(policy, instant.activeRuleIds, base);
}

function sameEffect(a: TemporalEffect | undefined, b: TemporalEffect | undefined): boolean {
  if (!a || !b) return a === b;
  return a.factor === b.factor && a.direction === b.direction && a.unit === b.unit;
}

function weeklyClockMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

function weeklyChoiceMatches(
  value: string,
  op: "equals" | "in",
  expected: string | string[],
): boolean {
  return op === "equals"
    ? typeof expected === "string" && value === expected
    : Array.isArray(expected) && expected.includes(value);
}

function weeklyClockMatches(
  minute: number,
  condition: Extract<TemporalCondition, { type: "utc_hours" }>,
): boolean {
  if (condition.op === "in") {
    const values = Array.isArray(condition.value) ? condition.value : [];
    return values.some((value) => minute === weeklyClockMinutes(value));
  }
  const target = weeklyClockMinutes(condition.value as string);
  switch (condition.op) {
    case "equals":
      return minute === target;
    case "gt":
      return minute > target;
    case "gte":
      return minute >= target;
    case "lt":
      return minute < target;
    case "lte":
      return minute <= target;
  }
}

/**
 * Source-AST base week. Holiday leaves evaluate false so the recurring base is
 * the non-holiday schedule; exact holiday dates remain separate intervals.
 */
function weeklyConditionMatches(
  condition: TemporalCondition,
  day: TemporalWeekday,
  minute: number,
): boolean {
  switch (condition.type) {
    case "all":
      return condition.of.every((child) => weeklyConditionMatches(child, day, minute));
    case "any":
      return condition.of.some((child) => weeklyConditionMatches(child, day, minute));
    case "not":
      return !weeklyConditionMatches(condition.of, day, minute);
    case "utc_days":
      return weeklyChoiceMatches(day, condition.op, condition.value);
    case "utc_hours":
      return weeklyClockMatches(minute, condition);
    case "holiday":
      return false;
  }
}

function collectWeeklyBoundaries(condition: TemporalCondition, minutes: Set<number>): void {
  switch (condition.type) {
    case "all":
    case "any":
      for (const child of condition.of) collectWeeklyBoundaries(child, minutes);
      return;
    case "not":
      collectWeeklyBoundaries(condition.of, minutes);
      return;
    case "utc_hours": {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      for (const value of values) {
        const target = weeklyClockMinutes(value);
        if (
          condition.op === "equals" ||
          condition.op === "in" ||
          condition.op === "gt" ||
          condition.op === "lte"
        ) {
          minutes.add(target + 1);
        }
        if (condition.op !== "gt") minutes.add(target);
      }
      return;
    }
    default:
      return;
  }
}

interface WeeklySegment {
  day: TemporalWeekday;
  startMinute: number;
  endMinute: number;
  phase: TemporalModelPhase;
  effect: TemporalEffect;
}

/** Exact base-week segments from the AST, or undefined when classification is unknown. */
function policyWeeklySegments(
  policy: Extract<TemporalPolicyEntry, { status: "supported" }>,
  base: TemporalRates | null,
): WeeklySegment[] | undefined {
  const boundaries = new Set<number>([0, 1440]);
  const rules = [...policy.overrides, ...policy.multipliers];
  for (const rule of rules) collectWeeklyBoundaries(rule.when, boundaries);
  const sorted = [...boundaries]
    .filter((minute) => minute >= 0 && minute <= 1440)
    .sort((left, right) => left - right);
  const segments: WeeklySegment[] = [];
  for (const day of TEMPORAL_DAYS) {
    let previous: WeeklySegment | undefined;
    for (let index = 0; index < sorted.length - 1; index += 1) {
      const startMinute = sorted[index];
      const endMinute = sorted[index + 1];
      if (startMinute === undefined || endMinute === undefined || endMinute <= startMinute) {
        continue;
      }
      const activeRuleIds: string[] = [];
      for (const rule of rules) {
        if (weeklyConditionMatches(rule.when, day, startMinute)) activeRuleIds.push(rule.id);
      }
      const classified = classifyState(policy, activeRuleIds, base);
      if (classified.phase === "unknown" || !classified.effect) return undefined;
      if (
        previous &&
        previous.endMinute === startMinute &&
        previous.phase === classified.phase &&
        sameEffect(previous.effect, classified.effect)
      ) {
        previous.endMinute = endMinute;
      } else {
        previous = {
          day,
          startMinute,
          endMinute,
          phase: classified.phase,
          effect: classified.effect,
        };
        segments.push(previous);
      }
    }
  }
  return segments;
}

/** Browser-safe weekly descriptor, or undefined when no exact base week is provable. */
function policyWeeklySchedule(
  policy: TemporalPolicyEntry | null,
  base: TemporalRates | null,
): TemporalWeeklySchedule | undefined {
  if (!policy || policy.status !== "supported") return undefined;
  const segments = policyWeeklySegments(policy, base);
  if (!segments || segments.length === 0) return undefined;
  const baseSegment = segments.find(
    (segment) => segment.day === "mon" && segment.startMinute === 0,
  );
  if (!baseSegment) return undefined;

  const grouped = new Map<
    string,
    {
      days: Set<TemporalWeekday>;
      startMinute: number;
      endMinute: number;
      phase: TemporalModelPhase;
      effect: TemporalEffect;
    }
  >();
  for (const day of TEMPORAL_DAYS) {
    let run: WeeklySegment | undefined;
    const flush = (endMinute: number) => {
      if (!run) return;
      const key = JSON.stringify([run.startMinute, endMinute, run.phase, run.effect]);
      const existing = grouped.get(key);
      if (existing) {
        existing.days.add(day);
      } else {
        grouped.set(key, {
          days: new Set([day]),
          startMinute: run.startMinute,
          endMinute,
          phase: run.phase,
          effect: run.effect,
        });
      }
      run = undefined;
    };
    for (const segment of segments) {
      if (segment.day !== day) continue;
      const deviates =
        segment.phase !== baseSegment.phase || !sameEffect(segment.effect, baseSegment.effect);
      if (deviates) {
        if (run) flush(segment.startMinute);
        run = segment;
      } else {
        flush(segment.startMinute);
      }
    }
    flush(1440);
  }

  const windows = [...grouped.values()]
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute)
    .map((window) => ({
      days: TEMPORAL_DAYS.filter((day) => window.days.has(day)),
      startMinute: window.startMinute,
      endMinute: window.endMinute,
      phase: window.phase,
      effect: window.effect,
    }));
  const holidays = holidayJurisdictions(policy);
  const exceptHolidays = TEMPORAL_HOLIDAYS.filter((jurisdiction) => holidays.has(jurisdiction));
  return {
    timeZone: "UTC",
    utcOffsetMinutes: 0,
    basePhase: baseSegment.phase,
    baseEffect: baseSegment.effect,
    windows,
    ...(exceptHolidays.length > 0 ? { exceptHolidays } : {}),
  };
}

interface MeaningfulTransition {
  atMs: number;
  phase: TemporalModelPhase;
}

function isMeaningfulTransition(
  after: { phase: TemporalModelPhase; effect?: TemporalEffect },
  current: { phase: TemporalModelPhase; effect?: TemporalEffect },
): boolean {
  return after.phase !== current.phase || !sameEffect(after.effect, current.effect);
}

/**
 * Core reports active-rule-id changes too, which can leave the classified
 * phase and effect untouched. Skip those so the countdown only names a
 * transition the user can observe, scanning the same five-year horizon as the
 * core within a short preview-style chunk. An unresolved `after` is unknown.
 */
function nextMeaningfulTransitionAt(
  providerId: string,
  modelId: string,
  nowMs: number,
  policy: TemporalPolicyEntry | null,
  base: TemporalRates | null,
  current: { phase: TemporalModelPhase; effect?: TemporalEffect },
): MeaningfulTransition | undefined {
  const first = getNextTemporalTransition(providerId, modelId, nowMs);
  if (!first) return undefined;
  const firstAfter = classifyInstant(policy, first.after, base);
  if (isMeaningfulTransition(firstAfter, current)) {
    return { atMs: first.atMs, phase: firstAfter.phase };
  }

  const horizonEnd = nowMs + TRANSITION_SEARCH_HORIZON_MS;
  // Without holiday references the policy is strictly weekly-periodic, so a
  // full no-op week proves the cycle repeats. Holiday policies must keep
  // scanning: repeated rule ids can still be broken by a future holiday.
  const weeklyCycle = holidayJurisdictions(policy).size === 0;
  let cursor = first.atMs;
  while (cursor <= horizonEnd) {
    const chunkEnd = Math.min(cursor + TRANSITION_SEARCH_CHUNK_MS, horizonEnd + 1);
    if (chunkEnd <= cursor) break;
    // Rates are irrelevant here; active rule ids and status prove the boundary.
    const intervals = listTemporalIntervals(providerId, modelId, cursor, chunkEnd);
    for (const interval of intervals) {
      // The first interval starts at the known no-op transition.
      if (interval.startMs <= first.atMs) continue;
      const after = classifyInstant(policy, interval, base);
      if (isMeaningfulTransition(after, current)) {
        return { atMs: interval.startMs, phase: after.phase };
      }
    }
    if (weeklyCycle && chunkEnd - first.atMs >= WEEK_MS) return undefined;
    cursor = chunkEnd;
  }
  return undefined;
}

function collectHolidays(condition: TemporalCondition, into: Set<TemporalHoliday>): void {
  switch (condition.type) {
    case "all":
    case "any":
      for (const child of condition.of) collectHolidays(child, into);
      return;
    case "not":
      collectHolidays(condition.of, into);
      return;
    case "holiday": {
      const values = Array.isArray(condition.value) ? condition.value : [condition.value];
      for (const value of values) into.add(value);
      return;
    }
    default:
      return;
  }
}

function holidayJurisdictions(policy: TemporalPolicyEntry | null): Set<TemporalHoliday> {
  const jurisdictions = new Set<TemporalHoliday>();
  if (!policy || policy.status !== "supported") return jurisdictions;
  for (const override of policy.overrides) collectHolidays(override.when, jurisdictions);
  for (const multiplier of policy.multipliers) collectHolidays(multiplier.when, jurisdictions);
  return jurisdictions;
}

function providerPhase(models: readonly TemporalModelStatus[]): TemporalPhase {
  let peak = false;
  let offpeak = false;
  for (const model of models) {
    // Known states cannot outvote an in-scope unknown model: the provider
    // aggregate is conservative and must not imply more precision than it has.
    if (model.state === "unknown") return "unknown";
    if (model.state === "peak") peak = true;
    if (model.state === "offpeak") offpeak = true;
  }
  if (peak && offpeak) return "mixed";
  if (peak) return "peak";
  if (offpeak) return "offpeak";
  return "unknown";
}

function upcomingHolidays(
  catalog: readonly TemporalHolidayInterval[],
  jurisdictions: ReadonlySet<TemporalHoliday>,
  nowMs: number,
): TemporalHolidayInterval[] {
  if (jurisdictions.size === 0) return [];
  return catalog
    .filter((holiday) => jurisdictions.has(holiday.jurisdiction) && holiday.endMs > nowMs)
    .slice(0, MAX_HOLIDAYS_PER_PROVIDER)
    .map((holiday) => ({ ...holiday }));
}

function policySource(policy: TemporalQuotaPolicy): TemporalPolicySource {
  return {
    label: policy.sourceLabel,
    url: policy.source,
    accessedAt: policy.sourceAccessedAt,
  };
}

function matchingQuotaPolicy(
  policies: readonly TemporalQuotaPolicy[],
  providerId: string,
): TemporalQuotaPolicy | undefined {
  return policies.find(
    (policy) => policy.providerId === providerId || policy.aliases.includes(providerId),
  );
}

/**
 * Every provider with a temporal policy, discovered or not. Account discovery
 * only decides the default visibility; it never removes a Settings row.
 */
export function listTemporalProviderSources(
  catalog: TemporalBundledCatalog,
  policies: readonly TemporalQuotaPolicy[],
  cards: readonly { providerId: string; providerLabel: string }[],
): TemporalProviderSource[] {
  const cardsById = new Map<string, { providerId: string; providerLabel: string }>();
  for (const card of cards) {
    if (!cardsById.has(card.providerId)) cardsById.set(card.providerId, card);
    const normalized = normalizeQuotaProviderId(card.providerId);
    if (!cardsById.has(normalized)) cardsById.set(normalized, card);
  }

  const claimed = new Set<string>();
  const sources: TemporalProviderSource[] = [];
  for (const policy of policies) {
    const ids = [policy.providerId, ...policy.aliases];
    const card = ids
      .map((id) => cardsById.get(id) ?? cardsById.get(normalizeQuotaProviderId(id)))
      .find((entry) => entry !== undefined);
    for (const id of ids) claimed.add(id);
    sources.push({
      providerId: policy.providerId,
      providerLabel: card?.providerLabel ?? policy.providerLabel,
      discovered: card !== undefined,
    });
  }

  for (const providerId of Object.keys(catalog.routes)) {
    if (claimed.has(providerId)) continue;
    const card = cardsById.get(providerId) ?? cardsById.get(normalizeQuotaProviderId(providerId));
    sources.push({
      providerId,
      providerLabel: card?.providerLabel ?? getQuotaProviderDisplayLabel(providerId),
      discovered: card !== undefined,
    });
  }

  // Account-backed providers first so the Settings list starts with what the
  // user is actually using; the rest remain available to pre-enable.
  return sources.sort(
    (left, right) =>
      Number(right.discovered) - Number(left.discovered) ||
      left.providerLabel.localeCompare(right.providerLabel),
  );
}

/** Computes the whole browser-safe temporal status for the given providers. */
export function buildTemporalStatus(input: BuildTemporalStatusInput): TemporalStatusSnapshot {
  const resolveBase = input.baseRates ?? ratesFromCost;
  const holidays = input.holidays ?? [];
  const quotaPolicies = input.quotaPolicies ?? TEMPORAL_QUOTA_POLICIES;
  const providers: TemporalProviderStatus[] = [];
  const seen = new Set<string>();

  for (const provider of input.providers) {
    const quotaPolicy = matchingQuotaPolicy(quotaPolicies, provider.providerId);
    const providerId = quotaPolicy?.providerId ?? provider.providerId;
    if (seen.has(providerId)) continue;
    seen.add(providerId);

    let models: TemporalModelStatus[];
    const jurisdictions = new Set<TemporalHoliday>();
    let source: TemporalPolicySource | undefined;
    if (quotaPolicy) {
      models = buildQuotaPolicyModels(quotaPolicy, input.nowMs, TEMPORAL_SCHEDULE_HORIZON_MS);
      source = policySource(quotaPolicy);
    } else {
      models = [];
      const routes = input.routes[provider.providerId] ?? [];
      for (const modelId of routes) {
        const policy = getTemporalPolicy(provider.providerId, modelId);
        if (!policy) continue;
        models.push(modelStatus(provider.providerId, modelId, input.nowMs, resolveBase));
        for (const jurisdiction of holidayJurisdictions(policy)) jurisdictions.add(jurisdiction);
      }
    }
    if (models.length === 0) continue;
    providers.push({
      providerId,
      providerLabel: provider.providerLabel,
      discovered: provider.discovered,
      phase: providerPhase(models),
      models,
      holidays: quotaPolicy ? [] : upcomingHolidays(holidays, jurisdictions, input.nowMs),
      ...(source ? { source } : {}),
    });
  }

  const meta = getTemporalSnapshotMeta();
  return {
    generatedAtMs: input.nowMs,
    providers,
    snapshot: {
      revision: meta.revision,
      generatedAtMs: meta.generatedAt,
    },
  };
}

function modelStatus(
  providerId: string,
  modelId: string,
  nowMs: number,
  baseRates: (providerId: string, modelId: string) => TemporalRates | null,
): TemporalModelStatus {
  const policy = getTemporalPolicy(providerId, modelId);
  const base = baseRates(providerId, modelId);
  const state = getTemporalInstantState(providerId, modelId, nowMs);
  const current = classifyInstant(policy, state, base);
  const intervals = projectIntervals(providerId, modelId, nowMs, baseRates);
  const weekly = policyWeeklySchedule(policy, base);
  // The preview is deliberately short, so its last interval ends at the horizon
  // rather than at a proved transition. Ask the core evaluator for the real
  // next transition independently so a long holiday or sparse rule does not
  // suppress a change that simply falls outside the display window.
  const next = nextMeaningfulTransitionAt(providerId, modelId, nowMs, policy, base, current);
  const status: TemporalModelStatus = {
    modelId,
    state: current.phase,
    intervals,
  };
  if (current.effect) status.effect = current.effect;
  if (weekly) status.weekly = weekly;
  if (next) {
    status.nextChangeAtMs = next.atMs;
    status.nextState = next.phase;
  }
  if (state.reason) status.reason = state.reason;
  return status;
}

function projectIntervals(
  providerId: string,
  modelId: string,
  nowMs: number,
  baseRates: (providerId: string, modelId: string) => TemporalRates | null,
): TemporalModelInterval[] {
  const policy = getTemporalPolicy(providerId, modelId);
  if (!policy || policy.status === "unsupported") return [];
  const base = baseRates(providerId, modelId);
  const rawIntervals = listTemporalIntervals(
    providerId,
    modelId,
    nowMs,
    nowMs + TEMPORAL_SCHEDULE_HORIZON_MS,
    base ?? undefined,
  );
  const projected: TemporalModelInterval[] = [];
  for (const interval of rawIntervals) {
    const classified =
      interval.status === "resolved"
        ? classifyState(policy, interval.activeRuleIds, base)
        : undefined;
    const next: TemporalModelInterval = {
      startMs: interval.startMs,
      endMs: interval.endMs,
      // An unresolved calendar or rule must stay unknown: peak/off-peak labels
      // would otherwise look like a resolved price window.
      phase: classified?.phase ?? "unknown",
      ...(classified?.effect ? { effect: classified.effect } : {}),
      ...(interval.reason ? { reason: interval.reason } : {}),
    };
    const previous = projected[projected.length - 1];
    if (
      previous &&
      previous.phase === next.phase &&
      previous.reason === next.reason &&
      JSON.stringify(previous.effect) === JSON.stringify(next.effect)
    ) {
      previous.endMs = next.endMs;
    } else {
      projected.push(next);
    }
  }
  return projected.slice(0, MAX_INTERVALS_PER_MODEL);
}
