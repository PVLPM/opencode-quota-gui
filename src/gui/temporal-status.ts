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
} from "../contracts/temporal.js";
import { lookupCost } from "../lib/modelsdev-pricing.js";
import {
  getTemporalInstantState,
  getTemporalPolicy,
  getTemporalSnapshotMeta,
  listTemporalIntervals,
  type TemporalCondition,
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
  const { phase, effect } = classifyState(policy, state.activeRuleIds, base);
  const intervals = projectIntervals(providerId, modelId, nowMs, baseRates);
  // The last interval always ends at the projection horizon, not necessarily at
  // a real transition. Only an interval followed by another proves a boundary.
  const next = intervals.length > 1 ? intervals[0]?.endMs : undefined;
  const status: TemporalModelStatus = {
    modelId,
    state: state.status === "resolved" ? phase : "unknown",
    intervals,
  };
  if (effect && state.status === "resolved") status.effect = effect;
  if (next !== undefined && next > nowMs) status.nextChangeAtMs = next;
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
