/**
 * Pure quota-burn attribution (USAGE_IMPLEMENTATION.md D7/D8).
 *
 * Paste-level semantics, no effort multipliers and no delay buffers:
 * - Only a provider-observed interval with burn > 0 can be attributed.
 * - An account is eligible only while it is the sole observed account of its
 *   provider; the caller supplies that boolean per interval.
 * - Every eligible step must be fully priced and the summed weight must be
 *   positive; otherwise the whole interval's burn stays unattributed while its
 *   recorded tokens are still reported.
 * - A model-specific window narrows eligibility; an unknown window matches
 *   nothing instead of guessing.
 *
 * The input activity is the host-side `source.activity(...)` result, aligned
 * 1:1 with the intervals of exactly one quota window.
 */
import type { CostedTokens } from "../contracts/dashboard.js";
import type { UsageBreakdownRow, UsageLink, UsageUnattributedReason } from "../contracts/usage.js";
import type { UsageActivityInterval } from "../contracts/usage-activity.js";
import {
  getQuotaProviderRegistration,
  getQuotaProviderRuntimeIds,
} from "../lib/provider-metadata.js";
import { modelIncludesAny } from "../lib/provider-model-matching.js";

export interface UsageAttributionIntervalInput {
  startMs: number;
  endMs: number;
  /** Observed decrease in percentage points; `null` across a boundary. */
  burnPercentPoints: number | null;
  link: UsageLink["kind"];
  /** False when another account of the same provider was also observed. */
  soleObservedAccount: boolean;
}

export interface UsageAttributionRequest {
  /** Intervals of exactly one quota window. */
  intervals: readonly UsageAttributionIntervalInput[];
  /** Aligned 1:1 with `intervals`. */
  activity: readonly UsageActivityInterval[];
  /** OpenCode runtime provider ids of the card's account. */
  providerIds: readonly string[];
  /** Model-specific window narrowing; absent = every model is eligible. */
  isEligibleModel?: (modelId: string) => boolean;
}

export interface UsageAttributionEntry {
  providerId: string;
  modelId: string;
  effort?: string;
  tokens: CostedTokens;
  stepCount: number;
  /** Present only when this window's burn was fully attributed. */
  estimatedBurnPercentPoints?: number;
}

export interface UsageAttributionInterval {
  startMs: number;
  endMs: number;
  burnPercentPoints: number | null;
  attributedBurnPercentPoints: number;
  unattributedBurnPercentPoints: number;
  unattributedReason?: UsageUnattributedReason;
  /** Eligible activity; tokens stay present even when the burn is unattributed. */
  activity: UsageAttributionEntry[];
}

export interface UsageAttributionResult {
  intervals: UsageAttributionInterval[];
  /** One window's model rows, with effort children. */
  breakdown: UsageBreakdownRow[];
}

/** Quota card provider id -> OpenCode runtime provider ids. */
export function quotaProviderRuntimeIds(quotaProviderId: string): readonly string[] {
  return getQuotaProviderRuntimeIds(quotaProviderId);
}

export interface UsageNamedWindowEligibility {
  /** False when the window's model scope is unknown; never attribute then. */
  known: boolean;
  matches(modelId: string): boolean;
}

/**
 * Named windows whose quota is scoped to one model family. `Fable weekly` is
 * the only model-scoped named window the providers currently report.
 */
const MODEL_SPECIFIC_NAMED_WINDOWS: Readonly<Record<string, readonly string[]>> = {
  "fable weekly": ["fable"],
};

function normalizeNamedWindow(namedWindow: string): string {
  return namedWindow
    .trim()
    .toLowerCase()
    .replace(/^named:/u, "")
    .trim();
}

/**
 * Eligibility for a named quota window. A declared but provider-wide named
 * window matches every model; an unknown name matches nothing.
 */
export function modelEligibilityForNamedWindow(
  quotaProviderId: string,
  namedWindow: string,
): UsageNamedWindowEligibility {
  const name = normalizeNamedWindow(namedWindow);
  const fragments = MODEL_SPECIFIC_NAMED_WINDOWS[name];
  if (fragments !== undefined) {
    return { known: true, matches: (modelId) => modelIncludesAny(modelId, fragments) };
  }
  const registration = getQuotaProviderRegistration(quotaProviderId);
  const declared =
    registration?.optionalVisibilityRows?.some(
      (row) => row.rowKey.startsWith("named:") && normalizeNamedWindow(row.rowKey) === name,
    ) ?? false;
  return declared ? { known: true, matches: () => true } : { known: false, matches: () => false };
}

/** Complete pricing: every token has a finite, non-negative API-equivalent cost. */
function isFullyPriced(tokens: CostedTokens): boolean {
  return (
    tokens.apiEquivalentCostUsd !== null &&
    Number.isFinite(tokens.apiEquivalentCostUsd) &&
    tokens.apiEquivalentCostUsd >= 0 &&
    tokens.unpricedTokens === 0 &&
    tokens.unknownTokens === 0
  );
}

function attributeInterval(
  interval: UsageAttributionIntervalInput,
  activity: UsageActivityInterval,
  providerIds: ReadonlySet<string>,
  isEligibleModel: ((modelId: string) => boolean) | undefined,
): UsageAttributionInterval {
  const reported = activity.entries.filter((entry) => providerIds.has(entry.providerId));
  const eligible =
    isEligibleModel === undefined
      ? reported
      : reported.filter((entry) => isEligibleModel(entry.modelId));
  const result: UsageAttributionInterval = {
    startMs: interval.startMs,
    endMs: interval.endMs,
    burnPercentPoints: interval.burnPercentPoints,
    attributedBurnPercentPoints: 0,
    unattributedBurnPercentPoints: 0,
    activity: eligible,
  };
  const burn = interval.burnPercentPoints;
  if (interval.link === "boundary" || burn === null || !(burn > 0)) return result;

  const unattributed = (reason: UsageUnattributedReason): UsageAttributionInterval => ({
    ...result,
    unattributedBurnPercentPoints: burn,
    unattributedReason: reason,
  });
  if (interval.link === "unobserved") return unattributed("unobserved-interval");
  if (!interval.soleObservedAccount) return unattributed("ambiguous-account");
  if (reported.length === 0) return unattributed("no-activity");
  if (eligible.length === 0) return unattributed("zero-weight");
  if (!eligible.every((entry) => isFullyPriced(entry.tokens))) return unattributed("unpriced");

  let totalWeight = 0;
  for (const entry of eligible) {
    totalWeight += Math.max(0, entry.tokens.apiEquivalentCostUsd ?? 0);
  }
  if (!(totalWeight > 0)) return unattributed("zero-weight");

  return {
    ...result,
    attributedBurnPercentPoints: burn,
    activity: eligible.map((entry) => ({
      ...entry,
      estimatedBurnPercentPoints:
        (burn * Math.max(0, entry.tokens.apiEquivalentCostUsd ?? 0)) / totalWeight,
    })),
  };
}

/** Attribute every interval of one window and derive its model breakdown. */
export function attributeUsageWindow(request: UsageAttributionRequest): UsageAttributionResult {
  if (request.activity.length !== request.intervals.length) {
    throw new TypeError("activity intervals must align with series intervals");
  }
  const providerIds = new Set(request.providerIds);
  const intervals = request.intervals.map((interval, index) => {
    const activity = request.activity[index];
    if (activity === undefined) throw new TypeError("missing activity interval");
    if (activity.startMs !== interval.startMs || activity.endMs !== interval.endMs) {
      throw new TypeError("activity interval boundaries must match series intervals");
    }
    return attributeInterval(interval, activity, providerIds, request.isEligibleModel);
  });
  return { intervals, breakdown: buildUsageAttributionBreakdown(intervals) };
}

interface TokenTotal {
  tokens: CostedTokens;
  stepCount: number;
  estimatedBurnPercentPoints?: number;
  efforts: Map<string | undefined, TokenTotal>;
}

function emptyCostedTokens(): CostedTokens {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function addCostedTokens(target: CostedTokens, source: CostedTokens): void {
  target.input += source.input;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.total += source.total;
  target.unpricedTokens += source.unpricedTokens;
  target.unknownTokens += source.unknownTokens;
  if (source.apiEquivalentCostUsd !== null) {
    target.apiEquivalentCostUsd = (target.apiEquivalentCostUsd ?? 0) + source.apiEquivalentCostUsd;
  }
  if (source.recordedCostUsd !== undefined) {
    target.recordedCostUsd = (target.recordedCostUsd ?? 0) + source.recordedCostUsd;
  }
  if (source.recordedCostTokens !== undefined) {
    target.recordedCostTokens = (target.recordedCostTokens ?? 0) + source.recordedCostTokens;
  }
}

function createTokenTotal(): TokenTotal {
  return { tokens: emptyCostedTokens(), stepCount: 0, efforts: new Map() };
}

function addEntryToTotal(total: TokenTotal, entry: UsageAttributionEntry): void {
  addCostedTokens(total.tokens, entry.tokens);
  total.stepCount += entry.stepCount;
  if (entry.estimatedBurnPercentPoints !== undefined) {
    total.estimatedBurnPercentPoints =
      (total.estimatedBurnPercentPoints ?? 0) + entry.estimatedBurnPercentPoints;
  }
  let effort = total.efforts.get(entry.effort);
  if (effort === undefined) {
    effort = createTokenTotal();
    total.efforts.set(entry.effort, effort);
  }
  addCostedTokens(effort.tokens, entry.tokens);
  effort.stepCount += entry.stepCount;
  if (entry.estimatedBurnPercentPoints !== undefined) {
    effort.estimatedBurnPercentPoints =
      (effort.estimatedBurnPercentPoints ?? 0) + entry.estimatedBurnPercentPoints;
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Model rows with effort children for one window's intervals. Tokens and
 * estimated points are summed across exactly the intervals passed in; never
 * combine intervals from different quota windows.
 */
export function buildUsageAttributionBreakdown(
  intervals: readonly UsageAttributionInterval[],
): UsageBreakdownRow[] {
  const models = new Map<string, TokenTotal & { providerId: string; modelId: string }>();
  for (const interval of intervals) {
    for (const entry of interval.activity) {
      const key = `${entry.providerId}\u0000${entry.modelId}`;
      let model = models.get(key);
      if (model === undefined) {
        model = { ...createTokenTotal(), providerId: entry.providerId, modelId: entry.modelId };
        models.set(key, model);
      }
      addEntryToTotal(model, entry);
    }
  }

  const rows = [...models.values()].sort((a, b) => {
    const byTokens = b.tokens.total - a.tokens.total;
    if (byTokens !== 0) return byTokens;
    return compareIds(a.providerId, b.providerId) || compareIds(a.modelId, b.modelId);
  });
  return rows.map((model) => {
    const row: UsageBreakdownRow = {
      providerId: model.providerId,
      modelId: model.modelId,
      tokens: model.tokens,
      stepCount: model.stepCount,
      efforts: [...model.efforts]
        .sort(([aEffort, a], [bEffort, b]) => {
          const byTokens = b.tokens.total - a.tokens.total;
          if (byTokens !== 0) return byTokens;
          if (aEffort === bEffort) return 0;
          if (aEffort === undefined) return 1;
          if (bEffort === undefined) return -1;
          return compareIds(aEffort, bEffort);
        })
        .map(([effort, total]) => {
          const child: UsageBreakdownRow["efforts"][number] = {
            tokens: total.tokens,
            stepCount: total.stepCount,
          };
          if (effort !== undefined) child.effort = effort;
          if (total.estimatedBurnPercentPoints !== undefined) {
            child.estimatedBurnPercentPoints = total.estimatedBurnPercentPoints;
          }
          return child;
        }),
    };
    if (model.estimatedBurnPercentPoints !== undefined) {
      row.estimatedBurnPercentPoints = model.estimatedBurnPercentPoints;
    }
    return row;
  });
}
