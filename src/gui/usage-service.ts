/**
 * Host-side Usage snapshot builder (v1.4.0 workstream E/F).
 *
 * Reads the recorder's quota-history database, derives one `UsageWindowSeries`
 * per stored series (`usage-intervals.ts`), and joins recorded activity once per
 * account provider over the union of that provider's window intervals
 * (`usage-attribution.ts` D7/D8). It never polls a provider or refreshes
 * analytics: the caller supplies the already-existing activity seam and the
 * most recent quota cards (display labels only).
 *
 * Activity unavailability: a missing callback, a rejected read or a result that
 * does not align 1:1 with the queried intervals leaves every burn interval
 * unattributed with no fabricated reason (the `activityUnavailable` flag is the
 * explanation) and no breakdown rows. Quota history itself is still returned.
 *
 * Account/plan labels are identity-bearing and therefore come only from the
 * current live cards. A stored account without a live card gets a neutral label
 * derived from its opaque card hash; stored account/plan labels are never shown.
 */
import { existsSync } from "node:fs";

import type {
  AccountingMetric,
  CostedTokens,
  ProviderCard,
  QuotaCardRow,
} from "../contracts/dashboard.js";
import type { CardId, RowId } from "../contracts/identity.js";
import type {
  UsageAccount,
  UsageActivity,
  UsageInterval,
  UsageModelKey,
  UsageQuery,
  UsageRangeKey,
  UsageSnapshot,
  UsageSource,
  UsageWindowSeries,
} from "../contracts/usage.js";
import type {
  UsageActivityEntry,
  UsageActivityInterval,
  UsageActivityQuery,
  UsageActivityResult,
} from "../contracts/usage-activity.js";
import { getGuiPrivateStatePath } from "../lib/private-state-paths.js";
import {
  openUsageStoreReadOnly,
  type UsageHistorySlice,
  type UsageReadStore,
  type UsageSeriesInfo,
  type UsageStoredRun,
} from "../lib/usage-store.js";
import { resolveHostTimeZone } from "./time-zone.js";
import {
  attributeUsageWindow,
  attributionScopeForRow,
  type UsageAttributionEntry,
  type UsageAttributionIntervalInput,
  type UsageAttributionResult,
  type UsageAttributionScope,
} from "./usage-attribution.js";
import {
  buildUsageWindowSeries,
  type UsageAxisInput,
  usagePointsFromRuns,
} from "./usage-intervals.js";
import { USAGE_HISTORY_FILE } from "./usage-recorder.js";

const FINITE_RANGE_MS: Readonly<Record<"24h" | "7d" | "30d", number>> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const EMPTY_SLICE: UsageHistorySlice = {
  series: [],
  runs: [],
  preceding: [],
  interruptions: [],
};

export interface UsageSnapshotBuilderOptions {
  /** Test/embedding seam: an already-open read store; the builder never closes it. */
  store?: UsageReadStore;
  /** Private usage-history database path; defaults to the recorder's path. */
  path?: string;
  /** Existing analytics activity read; absent means activity is unavailable. */
  activity?: (query: UsageActivityQuery) => Promise<UsageActivityResult>;
  now?: () => number;
  timeZone?: string;
  /** Current quota cards, for display labels only. Must never start a poll. */
  latestQuotaCards?: () => ProviderCard[] | undefined;
}

export interface UsageSnapshotBuilder {
  usage(query: UsageQuery): Promise<UsageSnapshot>;
}

interface WindowPlan {
  series: UsageSeriesInfo;
  metric?: AccountingMetric;
  cardRow?: QuotaCardRow;
}

interface SeriesGroup {
  cardId: string;
  providerId: string;
  providerLabel: string;
  source: UsageSource;
  plans: WindowPlan[];
  runsBySeries: ReadonlyMap<string, UsageStoredRun[]>;
}

interface WorkingWindow {
  window: UsageWindowSeries;
  /** Per-row billing scope; `known: false` never attributes. */
  scope: UsageAttributionScope;
}

interface WorkingAccount {
  cardId: string;
  providerId: string;
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;
  source: UsageSource;
  windows: WorkingWindow[];
  /** Other accounts' runs of the same provider, sorted for D8 overlap checks. */
  rivalFirstAtMs: number[];
  /** Prefix maximum of `lastAtMs`; a long earlier run still covers an interval. */
  rivalMaxLastAtMs: number[];
}

interface ProviderActivity {
  /** Union of this provider's known per-row attribution runtime ids. */
  providerIds: Set<string>;
  /** Union of every window interval boundary for this provider. */
  boundaries: Set<number>;
  segments: { startMs: number; endMs: number }[];
  result?: UsageActivityResult;
}

interface AttributedWindow {
  account: WorkingAccount;
  window: WorkingWindow;
  result: UsageAttributionResult;
}

function finiteDuration(range: UsageRangeKey): number | undefined {
  return range === "24h" || range === "7d" || range === "30d" ? FINITE_RANGE_MS[range] : undefined;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Provider, model, then effort with unknown effort last. */
function compareModelIdentity(
  left: { providerId: string; modelId: string; effort?: string },
  right: { providerId: string; modelId: string; effort?: string },
): number {
  if (left.providerId !== right.providerId) return compareIds(left.providerId, right.providerId);
  if (left.modelId !== right.modelId) return compareIds(left.modelId, right.modelId);
  if (left.effort === right.effort) return 0;
  if (left.effort === undefined) return 1;
  if (right.effort === undefined) return -1;
  return compareIds(left.effort, right.effort);
}

function metricRank(metric: AccountingMetric | undefined): number {
  if (metric?.kind === "named") return 5;
  if (metric?.kind !== "window") return 6;
  const order: Partial<Record<string, number>> = {
    five_hour: 0,
    day: 1,
    week: 2,
    month: 3,
  };
  return order[metric.window] ?? 4;
}

/** Parse the stored last-seen metric; a malformed value is ignored, never trusted. */
function storedMetric(series: UsageSeriesInfo): AccountingMetric | undefined {
  if (series.metricJson === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(series.metricJson);
    if (typeof value !== "object" || value === null) return undefined;
    const kind = (value as { kind?: unknown }).kind;
    if (kind === "aggregate" || kind === "window" || kind === "component" || kind === "named") {
      return value as AccountingMetric;
    }
  } catch {
    // fall through to card metadata
  }
  return undefined;
}

function neutralAccountLabel(providerLabel: string, cardId: string): string {
  const separator = cardId.indexOf(":");
  const hash = separator >= 0 ? cardId.slice(separator + 1) : cardId;
  return `${providerLabel} account ${hash.slice(0, 6)}`;
}

function orderPlans(plans: readonly WindowPlan[], card: ProviderCard | undefined): WindowPlan[] {
  const position = new Map<string, number>(
    card?.rows.map((row, index) => [row.rowId, index]) ?? [],
  );
  return [...plans].sort((left, right) => {
    const leftPosition = position.get(left.series.rowId);
    const rightPosition = position.get(right.series.rowId);
    if (leftPosition !== undefined || rightPosition !== undefined) {
      if (leftPosition === undefined) return 1;
      if (rightPosition === undefined) return -1;
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    }
    const byMetric = metricRank(left.metric) - metricRank(right.metric);
    return byMetric !== 0 ? byMetric : compareIds(left.series.rowId, right.series.rowId);
  });
}

function groupSeries(
  slice: UsageHistorySlice,
  cards: readonly ProviderCard[],
): { groups: SeriesGroup[]; cardById: Map<string, ProviderCard> } {
  const cardById = new Map<string, ProviderCard>(cards.map((card) => [card.cardId, card] as const));
  const runsBySeries = new Map<string, UsageStoredRun[]>();
  for (const run of slice.runs) {
    const runs = runsBySeries.get(run.seriesId);
    if (runs === undefined) runsBySeries.set(run.seriesId, [run]);
    else runs.push(run);
  }
  const groups = new Map<string, SeriesGroup>();
  for (const series of slice.series) {
    let group = groups.get(series.cardId);
    if (group === undefined) {
      group = {
        cardId: series.cardId,
        providerId: series.providerId,
        providerLabel: series.providerLabel,
        source: series.source,
        plans: [],
        runsBySeries,
      };
      groups.set(series.cardId, group);
    }
    const cardRow = cardById.get(series.cardId)?.rows.find((row) => row.rowId === series.rowId);
    const metric = storedMetric(series) ?? cardRow?.metric;
    group.plans.push({
      series,
      ...(metric !== undefined ? { metric } : {}),
      ...(cardRow ? { cardRow } : {}),
    });
  }
  return { groups: [...groups.values()], cardById };
}

function segmentsFromBoundaries(
  boundaries: ReadonlySet<number>,
): { startMs: number; endMs: number }[] {
  const points = [...boundaries].sort((left, right) => left - right);
  const segments: { startMs: number; endMs: number }[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const startMs = points[index] as number;
    const endMs = points[index + 1] as number;
    if (endMs > startMs) segments.push({ startMs, endMs });
  }
  return segments;
}

/** A window interval that cannot carry queried activity (zero length or no result). */
function emptyActivity(interval: { startMs: number; endMs: number }): UsageActivityInterval {
  return {
    startMs: interval.startMs,
    endMs: interval.endMs,
    entries: [],
    incomplete: false,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function optionalSum(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

const COSTED_TOKEN_KEYS = [
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "total",
  "unpricedTokens",
  "unknownTokens",
] as const;

function combinedTokens(left: CostedTokens, right: CostedTokens): CostedTokens {
  const total = { ...left };
  for (const key of COSTED_TOKEN_KEYS) total[key] = left[key] + right[key];
  total.apiEquivalentCostUsd =
    left.apiEquivalentCostUsd === null || right.apiEquivalentCostUsd === null
      ? null
      : left.apiEquivalentCostUsd + right.apiEquivalentCostUsd;
  const recordedCostUsd = optionalSum(left.recordedCostUsd, right.recordedCostUsd);
  if (recordedCostUsd !== undefined) total.recordedCostUsd = recordedCostUsd;
  const recordedCostTokens = optionalSum(left.recordedCostTokens, right.recordedCostTokens);
  if (recordedCostTokens !== undefined) total.recordedCostTokens = recordedCostTokens;
  return total;
}

function entryKey(entry: { providerId: string; modelId: string; effort?: string }): string {
  return `${entry.providerId}\u0000${entry.modelId}\u0000${entry.effort ?? ""}`;
}

/** Sum the elementary activity segments that cover one window interval. */
function combineActivity(
  interval: { startMs: number; endMs: number },
  parts: readonly UsageActivityInterval[],
): UsageActivityInterval {
  const entries = new Map<string, UsageActivityEntry>();
  let incomplete = false;
  let unpricedTokens = 0;
  let unknownTokens = 0;
  let unidentifiedTokens = 0;
  let unidentifiedSteps = 0;
  let unmatchedTokens = 0;
  let unmatchedSteps = 0;
  for (const part of parts) {
    incomplete ||= part.incomplete;
    unpricedTokens += part.unpricedTokens;
    unknownTokens += part.unknownTokens;
    unidentifiedTokens += part.unidentifiedTokens ?? 0;
    unidentifiedSteps += part.unidentifiedSteps ?? 0;
    unmatchedTokens += part.unmatchedTokens ?? 0;
    unmatchedSteps += part.unmatchedSteps ?? 0;
    for (const entry of part.entries) {
      const key = entryKey(entry);
      const existing = entries.get(key);
      if (existing === undefined) {
        entries.set(key, { ...entry, tokens: { ...entry.tokens } });
      } else {
        existing.tokens = combinedTokens(existing.tokens, entry.tokens);
        existing.stepCount += entry.stepCount;
      }
    }
  }
  return {
    startMs: interval.startMs,
    endMs: interval.endMs,
    entries: [...entries.values()].sort(compareModelIdentity),
    incomplete,
    unpricedTokens,
    unknownTokens,
    ...(unidentifiedTokens > 0 ? { unidentifiedTokens } : {}),
    ...(unidentifiedSteps > 0 ? { unidentifiedSteps } : {}),
    ...(unmatchedTokens > 0 ? { unmatchedTokens } : {}),
    ...(unmatchedSteps > 0 ? { unmatchedSteps } : {}),
  };
}

function firstSegmentAtOrAfter(segments: readonly { startMs: number }[], timeMs: number): number {
  let low = 0;
  let high = segments.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((segments[middle]?.startMs ?? 0) < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function activityForInterval(
  activity: ProviderActivity | undefined,
  interval: { startMs: number; endMs: number },
): UsageActivityInterval {
  if (interval.endMs <= interval.startMs || activity?.result === undefined) {
    return emptyActivity(interval);
  }
  const segments = activity.segments;
  const parts: UsageActivityInterval[] = [];
  for (
    let index = firstSegmentAtOrAfter(segments, interval.startMs);
    index < segments.length;
    index += 1
  ) {
    const segment = segments[index];
    const part = activity.result.intervals[index];
    if (segment === undefined || part === undefined || segment.startMs >= interval.endMs) break;
    if (part.endMs > interval.endMs) break;
    parts.push(part);
  }
  if (parts.length === 0) return emptyActivity(interval);
  if (parts.length === 1) return parts[0] as UsageActivityInterval;
  return combineActivity(interval, parts);
}

function rivalCoverage(runs: readonly UsageStoredRun[]): {
  rivalFirstAtMs: number[];
  rivalMaxLastAtMs: number[];
} {
  const sorted = [...runs].sort((left, right) => left.firstAtMs - right.firstAtMs);
  const rivalFirstAtMs = new Array<number>(sorted.length);
  const rivalMaxLastAtMs = new Array<number>(sorted.length);
  let maximum = Number.NEGATIVE_INFINITY;
  sorted.forEach((run, index) => {
    rivalFirstAtMs[index] = run.firstAtMs;
    maximum = Math.max(maximum, run.lastAtMs);
    rivalMaxLastAtMs[index] = maximum;
  });
  return { rivalFirstAtMs, rivalMaxLastAtMs };
}

/** Last index whose `firstAtMs` is <= `timeMs`, or -1. */
function lastStartingAtOrBefore(times: readonly number[], timeMs: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((times[middle] ?? Number.POSITIVE_INFINITY) <= timeMs) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

function soleObservedAccount(
  account: WorkingAccount,
  interval: { startMs: number; endMs: number },
): boolean {
  const index = lastStartingAtOrBefore(account.rivalFirstAtMs, interval.endMs);
  return index < 0 || (account.rivalMaxLastAtMs[index] ?? 0) < interval.startMs;
}

function totalsFrom(intervals: readonly UsageInterval[]): UsageWindowSeries["totals"] {
  let observedBurnPercentPoints = 0;
  let attributedBurnPercentPoints = 0;
  let unattributedBurnPercentPoints = 0;
  for (const interval of intervals) {
    observedBurnPercentPoints += interval.burnPercentPoints ?? 0;
    attributedBurnPercentPoints += interval.attributedBurnPercentPoints;
    unattributedBurnPercentPoints += interval.unattributedBurnPercentPoints;
  }
  return {
    observedBurnPercentPoints,
    attributedBurnPercentPoints,
    unattributedBurnPercentPoints,
  };
}

function modelKeyOf(entry: { providerId: string; modelId: string; effort?: string }): string {
  return entryKey(entry);
}

function modelKey(entry: { providerId: string; modelId: string; effort?: string }): UsageModelKey {
  return {
    providerId: entry.providerId,
    modelId: entry.modelId,
    ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
  };
}

function toUsageActivity(
  entry: UsageAttributionEntry,
  source: UsageSource,
  modelIndex: ReadonlyMap<string, number>,
): UsageActivity {
  const activity: UsageActivity = {
    model: modelIndex.get(modelKeyOf(entry)) ?? 0,
    tokens: entry.tokens,
    stepCount: entry.stepCount,
    source,
  };
  if (entry.estimatedBurnPercentPoints !== undefined) {
    activity.estimatedBurnPercentPoints = entry.estimatedBurnPercentPoints;
  }
  return activity;
}

export function createUsageSnapshotBuilder(
  options: UsageSnapshotBuilderOptions = {},
): UsageSnapshotBuilder {
  const now = options.now ?? Date.now;
  const timeZone = options.timeZone ?? resolveHostTimeZone();
  const path = options.path ?? getGuiPrivateStatePath(USAGE_HISTORY_FILE);

  async function readSlice(range: UsageRangeKey, nowMs: number): Promise<UsageHistorySlice> {
    const duration = finiteDuration(range);
    const span =
      duration === undefined
        ? { startMs: 0, endMs: Number.MAX_SAFE_INTEGER }
        : { startMs: nowMs - duration, endMs: nowMs };
    const store = options.store;
    if (store !== undefined) {
      return range === "current" ? store.queryLatestEpochs() : store.query(span);
    }
    // A missing file is a fresh install, not an error. Any unreadable store is
    // treated the same way: the Usage view shows no history instead of failing.
    if (!existsSync(path)) return EMPTY_SLICE;
    try {
      const opened = await openUsageStoreReadOnly(path);
      try {
        return range === "current" ? opened.queryLatestEpochs() : opened.query(span);
      } finally {
        opened.close();
      }
    } catch {
      return EMPTY_SLICE;
    }
  }

  function latestCards(): readonly ProviderCard[] {
    try {
      return options.latestQuotaCards?.() ?? [];
    } catch {
      return [];
    }
  }

  function buildAccounts(
    slice: UsageHistorySlice,
    range: UsageRangeKey,
    nowMs: number,
    span: { startMs: number; endMs: number } | undefined,
  ): { accounts: WorkingAccount[]; activityByProvider: Map<string, ProviderActivity> } {
    const cards = latestCards();
    const { groups, cardById } = groupSeries(slice, cards);
    const cardRank = new Map<string, number>(
      cards.map((card, index) => [card.cardId, index] as const),
    );
    const groupsByProvider = new Map<string, SeriesGroup[]>();
    for (const group of groups) {
      const list = groupsByProvider.get(group.providerId);
      if (list === undefined) groupsByProvider.set(group.providerId, [group]);
      else list.push(group);
    }

    groups.sort((left, right) => {
      const leftRank = cardRank.get(left.cardId) ?? Number.POSITIVE_INFINITY;
      const rightRank = cardRank.get(right.cardId) ?? Number.POSITIVE_INFINITY;
      if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
      return compareIds(left.providerId, right.providerId) || compareIds(left.cardId, right.cardId);
    });

    const axis: UsageAxisInput = {
      range,
      nowMs,
      ...(span !== undefined ? { span } : {}),
    };

    const accounts: WorkingAccount[] = [];
    const activityByProvider = new Map<string, ProviderActivity>();
    for (const group of groups) {
      const card = cardById.get(group.cardId);
      const providerLabel = card?.providerLabel ?? group.providerLabel;
      const rivals = rivalCoverage(
        (groupsByProvider.get(group.providerId) ?? [])
          .filter((other) => other.cardId !== group.cardId)
          .flatMap((other) => [...other.runsBySeries.values()].flat()),
      );
      const account: WorkingAccount = {
        cardId: group.cardId,
        providerId: group.providerId,
        providerLabel,
        // Live cards are the only source of identity-bearing labels. Stored
        // account/plan labels are never displayed (they may contain emails).
        ...(card?.accountLabel !== undefined
          ? { accountLabel: card.accountLabel }
          : card === undefined
            ? { accountLabel: neutralAccountLabel(providerLabel, group.cardId) }
            : {}),
        ...(card?.planLabel !== undefined ? { planLabel: card.planLabel } : {}),
        source: group.source,
        windows: [],
        ...rivals,
      };

      for (const plan of orderPlans(group.plans, card)) {
        const window = buildUsageWindowSeries(
          {
            rowId: plan.series.rowId as RowId,
            label: plan.cardRow?.label ?? plan.series.label,
            ...(plan.metric !== undefined ? { metric: plan.metric } : {}),
            measurement: plan.series.measurement,
            points: usagePointsFromRuns(group.runsBySeries.get(plan.series.rowId) ?? []),
          },
          axis,
        );
        const scope = attributionScopeForRow(group.providerId, plan.series.rowKey);
        account.windows.push({ window, scope });

        let activity = activityByProvider.get(group.providerId);
        if (activity === undefined) {
          activity = {
            providerIds: new Set<string>(),
            boundaries: new Set<number>(),
            segments: [],
          };
          activityByProvider.set(group.providerId, activity);
        }
        if (scope.known)
          for (const providerId of scope.providerIds) activity.providerIds.add(providerId);
        for (const interval of window.intervals) {
          if (interval.endMs <= interval.startMs) continue;
          activity.boundaries.add(interval.startMs);
          activity.boundaries.add(interval.endMs);
        }
      }
      accounts.push(account);
    }

    for (const activity of activityByProvider.values()) {
      activity.segments = segmentsFromBoundaries(activity.boundaries);
    }
    return { accounts, activityByProvider };
  }

  async function attribute(
    accounts: readonly WorkingAccount[],
    activityByProvider: Map<string, ProviderActivity>,
  ): Promise<{ attributed: AttributedWindow[]; unavailable: boolean }> {
    const needing = [...activityByProvider.entries()].filter(
      ([, activity]) => activity.segments.length > 0 && activity.providerIds.size > 0,
    );
    let unavailable = false;
    if (needing.length > 0) {
      const read = options.activity;
      if (read === undefined) {
        unavailable = true;
      } else {
        const settled = await Promise.allSettled(
          needing.map(([, activity]) =>
            read({
              intervals: activity.segments,
              providerIds: [...activity.providerIds],
            }),
          ),
        );
        settled.forEach((outcome, index) => {
          const activity = needing[index]?.[1];
          if (activity === undefined) return;
          if (outcome.status !== "fulfilled") {
            unavailable = true;
            return;
          }
          const result = outcome.value;
          const aligned =
            result.intervals.length === activity.segments.length &&
            result.intervals.every(
              (interval, position) =>
                interval.startMs === activity.segments[position]?.startMs &&
                interval.endMs === activity.segments[position]?.endMs,
            );
          if (!aligned) unavailable = true;
          else activity.result = result;
        });
      }
    }
    // One failed provider read makes the whole snapshot's activity incomplete;
    // keep quota history honest instead of showing a partial attribution.
    if (unavailable) {
      for (const activity of activityByProvider.values()) activity.result = undefined;
      return { attributed: [], unavailable: true };
    }

    const attributed: AttributedWindow[] = [];
    for (const account of accounts) {
      const activity = activityByProvider.get(account.providerId);
      for (const window of account.windows) {
        const providerIds = window.scope.known ? window.scope.providerIds : [];
        const isEligibleModel = window.scope.isEligibleModel;
        const intervals: UsageAttributionIntervalInput[] = window.window.intervals.map(
          (interval) => ({
            startMs: interval.startMs,
            endMs: interval.endMs,
            burnPercentPoints: interval.burnPercentPoints,
            link: interval.link,
            soleObservedAccount: soleObservedAccount(account, interval),
          }),
        );
        const result = attributeUsageWindow({
          intervals,
          activity: window.window.intervals.map((interval) =>
            activityForInterval(activity, interval),
          ),
          providerIds,
          ...(isEligibleModel !== undefined ? { isEligibleModel } : {}),
        });
        attributed.push({ account, window, result });
      }
    }
    return { attributed, unavailable: false };
  }

  function finalize(attributed: readonly AttributedWindow[]): UsageModelKey[] {
    const keys = new Map<string, UsageModelKey>();
    for (const { result } of attributed) {
      for (const interval of result.intervals) {
        for (const entry of interval.activity) {
          const key = modelKeyOf(entry);
          if (!keys.has(key)) keys.set(key, modelKey(entry));
        }
      }
    }
    const models = [...keys.values()].sort(compareModelIdentity);
    const index = new Map(models.map((entry, position) => [modelKeyOf(entry), position] as const));
    for (const { account, window, result } of attributed) {
      window.window.intervals = result.intervals.map((interval, position) => {
        const original = window.window.intervals[position];
        const reason = interval.unattributedReason ?? original?.unattributedReason;
        return {
          fromPoint: original?.fromPoint ?? position,
          toPoint: original?.toPoint ?? position,
          startMs: interval.startMs,
          endMs: interval.endMs,
          previousRemainingPercent: original?.previousRemainingPercent ?? 0,
          currentRemainingPercent: original?.currentRemainingPercent ?? 0,
          link: original?.link ?? "observed",
          burnPercentPoints: interval.burnPercentPoints,
          attributedBurnPercentPoints: interval.attributedBurnPercentPoints,
          unattributedBurnPercentPoints: interval.unattributedBurnPercentPoints,
          ...(reason !== undefined ? { unattributedReason: reason } : {}),
          activity: interval.activity.map((entry) => toUsageActivity(entry, account.source, index)),
        };
      });
      window.window.totals = totalsFrom(window.window.intervals);
      window.window.breakdown = result.breakdown;
    }
    return models;
  }

  return {
    async usage(query): Promise<UsageSnapshot> {
      const nowMs = now();
      const duration = finiteDuration(query.range);
      const span = duration === undefined ? undefined : { startMs: nowMs - duration, endMs: nowMs };
      const slice = await readSlice(query.range, nowMs);
      const { accounts, activityByProvider } = buildAccounts(slice, query.range, nowMs, span);
      const { attributed, unavailable } = await attribute(accounts, activityByProvider);
      const models = finalize(attributed);

      return {
        generatedAtMs: nowMs,
        range: query.range,
        timeZone,
        ...(span !== undefined ? { span } : {}),
        accounts: accounts.map((account) => {
          const output: UsageAccount = {
            accountKey: account.cardId as CardId,
            providerId: account.providerId,
            providerLabel: account.providerLabel,
            ...(account.planLabel !== undefined ? { planLabel: account.planLabel } : {}),
            ...(account.accountLabel !== undefined ? { accountLabel: account.accountLabel } : {}),
            source: account.source,
            windows: account.windows.map((entry) => entry.window),
          };
          return output;
        }),
        models,
        imports: [
          { harness: "claude-code", enabled: false, status: "disabled" },
          { harness: "codex", enabled: false, status: "disabled" },
        ],
        ...(unavailable ? { activityUnavailable: true as const } : {}),
      };
    },
  };
}
