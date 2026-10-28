/**
 * Worker-only rollup model.
 *
 * Owns deterministic fork ownership over compact fingerprint groups plus
 * per-hour rollups (global / project / session) and derives grouped
 * model/provider views from the same owned steps. Full hours use
 * pre-aggregated buckets; only the partial edge hours of a request touch the
 * owned step list, so bucket boundaries stay exact without rebuilding a raw
 * model per view.
 */

import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  AnalyticsGroupFilter,
  AnalyticsGroupQuery,
  AnalyticsGroupRow,
  AnalyticsGroupSnapshot,
  AnalyticsSeries,
  AnalyticsSeriesChildBucket,
  CostedTokens,
  ProjectActivityRow,
  ProjectRootRow,
  ProjectSnapshot,
  TokenStack,
  Usage,
} from "../contracts/dashboard.js";
import { sumTokenStack } from "../contracts/guards.js";
import {
  planRangeBuckets,
  type RangeKey,
  type RangeWindow,
  rangeBucketUnit,
  rangeWindow,
} from "../contracts/ranges.js";
import {
  type OpenCodeProjectInfo,
  type OpenCodeRawAssistantRow,
  type OpenCodeSessionInfo,
  rawAssistantRowFingerprint,
  rawAssistantRowHasTokenUsage,
} from "../lib/opencode-storage.js";
import { type PricingResolution, priceTokenBuckets } from "../lib/quota-stats.js";
import { type ForkOwnerCandidate, selectForkOwners } from "../lib/usage-ownership.js";
import { UNKNOWN_PROJECT_ID, UNTITLED_SESSION_TITLE } from "./aggregation.js";

const HOUR_MS = 3_600_000;

export interface OwnedStep {
  sessionID: string;
  messageID: string;
  projectID: string;
  createdAtMs: number;
  completedAtMs: number;
  tokens: TokenStack;
  providerID?: string;
  modelID?: string;
  agent?: string;
  costUsd: number;
  pricedAny: boolean;
  unpricedTokens: number;
  unknownTokens: number;
}

interface Accumulator {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  /** Count of priced contributions; keeps price status exact on removal. */
  pricedCount: number;
  unpricedTokens: number;
  unknownTokens: number;
}

/**
 * Per-hour rollup: only an aggregate plus the owned steps. Scoped sums
 * (project/session) iterate the hour's steps, which keeps one map entry per
 * owned row instead of one accumulator object per row per dimension.
 */
interface HourBucket {
  startMs: number;
  totals: Accumulator;
  steps: Map<string, OwnedStep>;
}

interface ProjectTree {
  rootId: string;
  memberIds: string[];
}

interface GroupOccurrence {
  sessionID: string;
  messageID: string;
  createdAtMs: number;
  completedAtMs: number;
  /** Flat token fields: no nested object per physical row. */
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  providerID?: string;
  modelID?: string;
  agent?: string;
  costUsd: number;
  pricedAny: boolean;
  unpricedTokens: number;
  unknownTokens: number;
}

export interface HomeAnalyticsRollup {
  usage: Usage;
  projects: ProjectActivityRow[];
}

interface RangeSum {
  totals: Accumulator;
  stepCount: number;
  sessions: Set<string>;
}

/**
 * One grouped node: flat totals, a distinct-session set, and its opposite
 * dimension children. Buckets are deliberately absent: only the selected chart
 * series accumulate them, so long lifetimes stay output-bounded.
 */
interface GroupNode {
  totals: Accumulator;
  sessions: Set<string>;
  stepCount: number;
  children: Map<string | undefined, GroupNode>;
}

interface GroupEntry {
  raw: string | undefined;
  node: GroupNode;
}

function createAccumulator(): Accumulator {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    pricedCount: 0,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function addStepToAccumulator(accumulator: Accumulator, step: OwnedStep): void {
  accumulator.input += step.tokens.input;
  accumulator.cacheRead += step.tokens.cacheRead;
  accumulator.cacheWrite += step.tokens.cacheWrite;
  accumulator.output += step.tokens.output;
  accumulator.reasoning += step.tokens.reasoning;
  accumulator.costUsd += step.costUsd;
  if (step.pricedAny) accumulator.pricedCount += 1;
  accumulator.unpricedTokens += step.unpricedTokens;
  accumulator.unknownTokens += step.unknownTokens;
}

function subtractStepFromAccumulator(accumulator: Accumulator, step: OwnedStep): void {
  accumulator.input -= step.tokens.input;
  accumulator.cacheRead -= step.tokens.cacheRead;
  accumulator.cacheWrite -= step.tokens.cacheWrite;
  accumulator.output -= step.tokens.output;
  accumulator.reasoning -= step.tokens.reasoning;
  accumulator.costUsd -= step.costUsd;
  if (step.pricedAny) accumulator.pricedCount -= 1;
  accumulator.unpricedTokens -= step.unpricedTokens;
  accumulator.unknownTokens -= step.unknownTokens;
}

function mergeAccumulator(target: Accumulator, source: Accumulator): void {
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.costUsd += source.costUsd;
  target.pricedCount += source.pricedCount;
  target.unpricedTokens += source.unpricedTokens;
  target.unknownTokens += source.unknownTokens;
}

function finalize(accumulator: Accumulator): CostedTokens {
  const stack: TokenStack = {
    input: accumulator.input,
    cacheRead: accumulator.cacheRead,
    cacheWrite: accumulator.cacheWrite,
    output: accumulator.output,
    reasoning: accumulator.reasoning,
  };
  return {
    ...stack,
    total: sumTokenStack(stack),
    apiEquivalentCostUsd: accumulator.pricedCount > 0 ? accumulator.costUsd : null,
    unpricedTokens: accumulator.unpricedTokens,
    unknownTokens: accumulator.unknownTokens,
  };
}

function createGroupNode(): GroupNode {
  return {
    totals: createAccumulator(),
    sessions: new Set(),
    stepCount: 0,
    children: new Map(),
  };
}

function identityOf(raw: string | undefined): AnalyticsEntityIdentity {
  return raw === undefined ? { kind: "unknown" } : { kind: "known", id: raw };
}

function identityTotal(identity: AnalyticsEntityIdentity): string | undefined {
  return identity.kind === "known" ? identity.id : undefined;
}

/** Known raw ids sort before the explicit unknown identity, then by raw id. */
function compareIdentities(a: AnalyticsEntityIdentity, b: AnalyticsEntityIdentity): number {
  if (a.kind !== b.kind) return a.kind === "known" ? -1 : 1;
  if (a.kind === "known" && b.kind === "known") return compareIds(a.id, b.id);
  return 0;
}

function accumulatorTotal(accumulator: Accumulator): number {
  return (
    accumulator.input +
    accumulator.cacheRead +
    accumulator.cacheWrite +
    accumulator.output +
    accumulator.reasoning
  );
}

/**
 * Deterministic token rank for the selected range: token volume descending,
 * then raw identity ascending with the unknown identity last. The rank never
 * depends on key insertion order or on cost.
 */
function compareGroupEntries(a: GroupEntry, b: GroupEntry): number {
  const byTokens = accumulatorTotal(b.node.totals) - accumulatorTotal(a.node.totals);
  if (byTokens !== 0) return byTokens;
  return compareIdentities(identityOf(a.raw), identityOf(b.raw));
}

function sortedChildEntries(node: GroupNode): GroupEntry[] {
  return [...node.children].map(([raw, child]) => ({ raw, node: child })).sort(compareGroupEntries);
}

function materializeBuckets(
  bucketTotals: ReadonlyMap<number, Accumulator>,
  bucketCount: number,
): CostedTokens[] {
  const buckets: CostedTokens[] = new Array(bucketCount);
  for (let index = 0; index < bucketCount; index += 1) {
    const accumulator = bucketTotals.get(index);
    buckets[index] = finalize(accumulator ?? createAccumulator());
  }
  return buckets;
}

function addStepToGroupNode(node: GroupNode, step: OwnedStep): void {
  addStepToAccumulator(node.totals, step);
  node.sessions.add(step.sessionID);
  node.stepCount += 1;
}

function materializeGroupRow(raw: string | undefined, node: GroupNode): AnalyticsGroupRow {
  return {
    identity: identityOf(raw),
    tokens: finalize(node.totals),
    sessionCount: node.sessions.size,
    stepCount: node.stepCount,
    children: sortedChildEntries(node).map((entry) => materializeGroupRow(entry.raw, entry.node)),
  };
}

function addStepToBucket(
  bucketTotals: Map<number, Accumulator>,
  step: OwnedStep,
  bucketIndex: number,
): void {
  if (bucketIndex < 0) return;
  let bucket = bucketTotals.get(bucketIndex);
  if (!bucket) {
    bucket = createAccumulator();
    bucketTotals.set(bucketIndex, bucket);
  }
  addStepToAccumulator(bucket, step);
}

/** Per-entity bucket accumulators for one chart series (exact raw key). */
type SeriesEntityBuckets = Map<string | undefined, Map<number, Accumulator>>;

function addStepToEntityBucket(
  entityBuckets: SeriesEntityBuckets,
  raw: string | undefined,
  step: OwnedStep,
  bucketIndex: number,
): void {
  if (bucketIndex < 0) return;
  let bucketTotals = entityBuckets.get(raw);
  if (!bucketTotals) {
    bucketTotals = new Map();
    entityBuckets.set(raw, bucketTotals);
  }
  addStepToBucket(bucketTotals, step, bucketIndex);
}

/**
 * Sparse per-bucket entity breakdown aligned with the snapshot boundaries.
 * Entities are ranked by their own bucket tokens, then exact identity with the
 * unknown identity last, so output order never depends on map insertion.
 */
function materializeEntityBuckets(
  entityBuckets: SeriesEntityBuckets,
  bucketCount: number,
): AnalyticsSeriesChildBucket[][] {
  const buckets: AnalyticsSeriesChildBucket[][] = [];
  for (let index = 0; index < bucketCount; index += 1) buckets.push([]);
  for (const [raw, bucketTotals] of entityBuckets) {
    for (const [bucketIndex, accumulator] of bucketTotals) {
      const bucket = buckets[bucketIndex];
      if (bucket === undefined) continue;
      bucket.push({ identity: identityOf(raw), tokens: finalize(accumulator) });
    }
  }
  for (const entries of buckets) {
    entries.sort((a, b) => {
      const byTokens = b.tokens.total - a.tokens.total;
      if (byTokens !== 0) return byTokens;
      return compareIdentities(a.identity, b.identity);
    });
  }
  return buckets;
}

interface SeriesSource {
  raw: string | undefined;
  totals: Accumulator;
  bucketTotals: Map<number, Accumulator>;
  childBuckets: SeriesEntityBuckets;
  /** Only Other: hidden same-dimension parents aggregated by this series. */
  parentBuckets?: SeriesEntityBuckets;
}

/**
 * Top five entities by selected-range token rank plus one chart-only Other
 * series. Only these sources carry per-bucket accumulators, so the returned
 * bucket arrays are bounded by series × buckets and their breakdowns by the
 * visible entity cardinality, never by a parent × child cross-product.
 */
function buildSeries(
  top: readonly SeriesSource[],
  other: SeriesSource | undefined,
  bucketCount: number,
): AnalyticsSeries[] {
  const series: AnalyticsSeries[] = top.map((source) => ({
    kind: "entity",
    identity: identityOf(source.raw),
    tokens: finalize(source.totals),
    buckets: materializeBuckets(source.bucketTotals, bucketCount),
    childBuckets: materializeEntityBuckets(source.childBuckets, bucketCount),
  }));
  if (other !== undefined) {
    series.push({
      kind: "other",
      tokens: finalize(other.totals),
      buckets: materializeBuckets(other.bucketTotals, bucketCount),
      childBuckets: materializeEntityBuckets(other.childBuckets, bucketCount),
      ...(other.parentBuckets === undefined
        ? {}
        : { parentBuckets: materializeEntityBuckets(other.parentBuckets, bucketCount) }),
    });
  }
  return series;
}

function rawIdForDimension(step: OwnedStep, dimension: AnalyticsDimension): string | undefined {
  return dimension === "model" ? step.modelID : step.providerID;
}

function oppositeDimension(dimension: AnalyticsDimension): AnalyticsDimension {
  return dimension === "model" ? "provider" : "model";
}

/** Filter matches the entity's own dimension, independent of grouping. */
function matchesFilter(step: OwnedStep, filter: AnalyticsGroupFilter | undefined): boolean {
  if (filter === undefined) return true;
  return rawIdForDimension(step, filter.dimension) === identityTotal(filter.identity);
}

/** Last bucket whose start is at or before `timeMs`; boundaries are contiguous. */
function bucketIndexAt(bucketStarts: readonly number[], timeMs: number): number {
  let low = 0;
  let high = bucketStarts.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const start = bucketStarts[middle];
    if (start === undefined) return found;
    if (start <= timeMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sessionCreatedMs(session: OpenCodeSessionInfo | undefined): number {
  const created = session?.time?.created;
  return created !== undefined && Number.isFinite(created) ? created : Number.MAX_SAFE_INTEGER;
}

function compareSessions(a: OpenCodeSessionInfo, b: OpenCodeSessionInfo): number {
  const byCreated = sessionCreatedMs(a) - sessionCreatedMs(b);
  if (byCreated !== 0) return byCreated;
  return compareIds(a.id, b.id);
}

function basenameOf(directory: string | undefined): string | undefined {
  if (directory === undefined) return undefined;
  const trimmed = directory.replace(/[\\/]+$/, "");
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[\\/]+/);
  const base = parts[parts.length - 1];
  return base ? base : undefined;
}

function sessionTitle(session: OpenCodeSessionInfo): string {
  const title = session.title?.trim();
  return title ? title : UNTITLED_SESSION_TITLE;
}

function projectIdOfSession(session: OpenCodeSessionInfo): string {
  const projectId = session.projectID?.trim();
  return projectId ? projectId : UNKNOWN_PROJECT_ID;
}

function inWindow(timestampMs: number | undefined, window: RangeWindow): boolean {
  if (timestampMs === undefined || !Number.isFinite(timestampMs)) return false;
  if (timestampMs >= window.untilMs) return false;
  return window.sinceMs === undefined || timestampMs >= window.sinceMs;
}

export interface AnalyticsModel {
  setMetadata(
    sessions: Record<string, OpenCodeSessionInfo>,
    projects: Record<string, OpenCodeProjectInfo>,
  ): void;
  clear(): void;
  apply(
    upserts: Iterable<OpenCodeRawAssistantRow>,
    removals: Iterable<OpenCodeRawAssistantRow>,
  ): void;
  hasSession(sessionId: string): boolean;
  hasProject(projectId: string): boolean;
  home(range: RangeKey, nowMs: number): HomeAnalyticsRollup;
  project(projectId: string, range: RangeKey, nowMs: number): ProjectSnapshot;
  groups(query: AnalyticsGroupQuery, nowMs: number): AnalyticsGroupSnapshot;
  earliestActivityMs(): number | undefined;
  ownedStepCount(): number;
}

/** Host calendar zone used for every bucket boundary in this model. */
export interface AnalyticsModelOptions {
  timeZone?: string;
}

export function createAnalyticsModel(options: AnalyticsModelOptions = {}): AnalyticsModel {
  const timeZone = options.timeZone ?? "UTC";
  const pricingCache = new Map<string, PricingResolution>();
  const groups = new Map<string, GroupOccurrence[]>();
  const ownedByFp = new Map<string, Map<string, OwnedStep>>();
  const ownedBySession = new Map<string, Map<string, OwnedStep>>();
  const hours = new Map<number, HourBucket>();
  const latestStepBySession = new Map<string, number>();
  const earliestStepBySession = new Map<string, number>();
  let earliestHourMs: number | undefined;

  let sessions: Record<string, OpenCodeSessionInfo> = {};
  let projects: Record<string, OpenCodeProjectInfo> = {};
  let projectBySession = new Map<string, string>();
  let sessionsByProject = new Map<string, string[]>();
  let childrenByParent = new Map<string, OpenCodeSessionInfo[]>();
  let treesByProject = new Map<string, ProjectTree[]>();
  let earliestStepGlobal: number | undefined;
  let earliestDirty = false;

  function priceRow(
    row: OpenCodeRawAssistantRow,
  ): Pick<GroupOccurrence, "costUsd" | "pricedAny" | "unpricedTokens" | "unknownTokens"> {
    const total =
      row.tokens.input +
      row.tokens.output +
      row.tokens.reasoning +
      row.tokens.cacheRead +
      row.tokens.cacheWrite;
    const outcome = priceTokenBuckets({
      providerID: row.providerID,
      modelID: row.modelID,
      tokens: {
        input: row.tokens.input,
        output: row.tokens.output,
        reasoning: row.tokens.reasoning,
        cache_read: row.tokens.cacheRead,
        cache_write: row.tokens.cacheWrite,
      },
      cache: pricingCache,
    });
    if (outcome.status === "partial") {
      return {
        costUsd: outcome.costUsd,
        pricedAny: true,
        unpricedTokens: outcome.unpricedTokens,
        unknownTokens: 0,
      };
    }
    if (outcome.status === "priced") {
      return { costUsd: outcome.costUsd, pricedAny: true, unpricedTokens: 0, unknownTokens: 0 };
    }
    if (outcome.status === "unpriced") {
      return { costUsd: 0, pricedAny: false, unpricedTokens: total, unknownTokens: 0 };
    }
    return { costUsd: 0, pricedAny: false, unpricedTokens: 0, unknownTokens: total };
  }

  function bucketFor(startMs: number): HourBucket {
    let bucket = hours.get(startMs);
    if (!bucket) {
      bucket = {
        startMs,
        totals: createAccumulator(),
        steps: new Map(),
      };
      hours.set(startMs, bucket);
    }
    return bucket;
  }

  function addStep(step: OwnedStep): void {
    const startMs = Math.floor(step.completedAtMs / HOUR_MS) * HOUR_MS;
    if (earliestHourMs === undefined || startMs < earliestHourMs) earliestHourMs = startMs;
    const bucket = bucketFor(startMs);
    addStepToAccumulator(bucket.totals, step);
    bucket.steps.set(`${step.sessionID}\u0000${step.messageID}`, step);

    let sessionSteps = ownedBySession.get(step.sessionID);
    if (!sessionSteps) {
      sessionSteps = new Map();
      ownedBySession.set(step.sessionID, sessionSteps);
    }
    sessionSteps.set(step.messageID, step);

    const completed = step.completedAtMs;
    const latest = latestStepBySession.get(step.sessionID);
    if (latest === undefined || completed > latest) {
      latestStepBySession.set(step.sessionID, completed);
    }
    const earliest = earliestStepBySession.get(step.sessionID);
    if (earliest === undefined || completed < earliest) {
      earliestStepBySession.set(step.sessionID, completed);
      earliestDirty = true;
    }
  }

  function removeStep(step: OwnedStep): void {
    const startMs = Math.floor(step.completedAtMs / HOUR_MS) * HOUR_MS;
    const bucket = hours.get(startMs);
    if (bucket) {
      subtractStepFromAccumulator(bucket.totals, step);
      bucket.steps.delete(`${step.sessionID}\u0000${step.messageID}`);
      if (bucket.steps.size <= 0) {
        hours.delete(startMs);
        if (startMs === earliestHourMs) {
          earliestHourMs = undefined;
          for (const key of hours.keys()) {
            if (earliestHourMs === undefined || key < earliestHourMs) earliestHourMs = key;
          }
        }
      }
    }

    const sessionSteps = ownedBySession.get(step.sessionID);
    if (sessionSteps) {
      sessionSteps.delete(step.messageID);
      if (sessionSteps.size === 0) ownedBySession.delete(step.sessionID);
      const values = [...sessionSteps.values()];
      if (values.length === 0) {
        latestStepBySession.delete(step.sessionID);
        earliestStepBySession.delete(step.sessionID);
      } else {
        let latest = values[0]?.completedAtMs ?? 0;
        let earliest = latest;
        for (const value of values) {
          if (value.completedAtMs > latest) latest = value.completedAtMs;
          if (value.completedAtMs < earliest) earliest = value.completedAtMs;
        }
        latestStepBySession.set(step.sessionID, latest);
        earliestStepBySession.set(step.sessionID, earliest);
      }
      earliestDirty = true;
    }
  }

  function stepKey(value: { sessionID: string; messageID: string }): string {
    return `${value.sessionID}\u0000${value.messageID}`;
  }

  function toOwnedStep(occurrence: GroupOccurrence): OwnedStep {
    const step: OwnedStep = {
      sessionID: occurrence.sessionID,
      messageID: occurrence.messageID,
      projectID: projectBySession.get(occurrence.sessionID) ?? UNKNOWN_PROJECT_ID,
      createdAtMs: occurrence.createdAtMs,
      completedAtMs: occurrence.completedAtMs,
      tokens: {
        input: occurrence.input,
        output: occurrence.output,
        reasoning: occurrence.reasoning,
        cacheRead: occurrence.cacheRead,
        cacheWrite: occurrence.cacheWrite,
      },
      costUsd: occurrence.costUsd,
      pricedAny: occurrence.pricedAny,
      unpricedTokens: occurrence.unpricedTokens,
      unknownTokens: occurrence.unknownTokens,
    };
    if (occurrence.providerID !== undefined) step.providerID = occurrence.providerID;
    if (occurrence.modelID !== undefined) step.modelID = occurrence.modelID;
    if (occurrence.agent !== undefined) step.agent = occurrence.agent;
    return step;
  }

  function sameOwnedStep(step: OwnedStep, occurrence: GroupOccurrence): boolean {
    return (
      step.tokens.input === occurrence.input &&
      step.tokens.cacheRead === occurrence.cacheRead &&
      step.tokens.cacheWrite === occurrence.cacheWrite &&
      step.tokens.output === occurrence.output &&
      step.tokens.reasoning === occurrence.reasoning &&
      step.agent === occurrence.agent &&
      step.completedAtMs === occurrence.completedAtMs &&
      step.costUsd === occurrence.costUsd &&
      step.pricedAny === occurrence.pricedAny &&
      step.unpricedTokens === occurrence.unpricedTokens &&
      step.unknownTokens === occurrence.unknownTokens
    );
  }

  /**
   * Reuse the canonical step object for an unchanged winner. The same object is
   * held by `ownedByFp`, the hour bucket, and the session map; replacing it on
   * every re-upsert would retain a detached copy and let a metadata project move
   * update one copy but not the others.
   */
  function ownedStepFor(
    occurrence: GroupOccurrence,
    previous: Map<string, OwnedStep> | undefined,
  ): OwnedStep {
    const before = previous?.get(stepKey(occurrence));
    if (before === undefined || !sameOwnedStep(before, occurrence)) {
      return toOwnedStep(occurrence);
    }
    const projectID = projectBySession.get(occurrence.sessionID) ?? UNKNOWN_PROJECT_ID;
    if (before.projectID !== projectID) {
      // Defensive: normally setMetadata moved this canonical object already.
      removeStep(before);
      before.projectID = projectID;
      addStep(before);
    }
    return before;
  }

  function recomputeFingerprint(fingerprint: string): void {
    const previous = ownedByFp.get(fingerprint);
    const occurrences = groups.get(fingerprint);
    const next = new Map<string, OwnedStep>();
    if (occurrences !== undefined && occurrences.length > 0) {
      if (occurrences.length === 1) {
        // Singleton fast path: one occurrence is always its own owner.
        const occurrence = occurrences[0];
        if (occurrence !== undefined) {
          next.set(stepKey(occurrence), ownedStepFor(occurrence, previous));
        }
      } else {
        // Choose owners over the compact occurrences first; allocate an
        // OwnedStep only for the winners.
        const candidates: ForkOwnerCandidate<GroupOccurrence>[] = occurrences.map((occurrence) => ({
          item: occurrence,
          sessionID: occurrence.sessionID,
          fingerprint,
          createdAtMs: occurrence.createdAtMs,
          messageID: occurrence.messageID,
        }));
        for (const occurrence of selectForkOwners(candidates)) {
          next.set(stepKey(occurrence), ownedStepFor(occurrence, previous));
        }
      }
    }
    if (previous !== undefined) {
      for (const [key, step] of previous) {
        if (!next.has(key)) removeStep(step);
      }
    }
    for (const [key, step] of next) {
      const before = previous?.get(key);
      if (before === undefined) {
        addStep(step);
        continue;
      }
      if (before !== step) {
        removeStep(before);
        addStep(step);
      }
    }
    // Fingerprints with no owned rows must not leave an empty map behind:
    // churn and full removal otherwise retain one map per removed fingerprint.
    if (next.size === 0) ownedByFp.delete(fingerprint);
    else ownedByFp.set(fingerprint, next);
  }

  function removeOccurrenceAt(fingerprint: string, messageID: string): boolean {
    const occurrences = groups.get(fingerprint);
    if (!occurrences) return false;
    const index = occurrences.findIndex((entry) => entry.messageID === messageID);
    if (index < 0) return false;
    occurrences.splice(index, 1);
    if (occurrences.length === 0) groups.delete(fingerprint);
    return true;
  }

  /**
   * Removes one message across fingerprints. Only used for a positive→zero
   * upsert (rare) or a removal row whose payload no longer matches its owned
   * fingerprint, never for the steady positive insert path.
   */
  function removeOccurrenceByMessage(messageID: string): string | undefined {
    for (const fingerprint of groups.keys()) {
      if (!removeOccurrenceAt(fingerprint, messageID)) continue;
      return fingerprint;
    }
    return undefined;
  }

  /**
   * Add or replace one physical contribution. Zero-token rows never enter the
   * ownership groups: they carry metadata/activity but no usage, so they are
   * excluded from fork ownership, pricing, groups, and activity extents. An
   * update from positive to zero therefore removes the previously owned copy.
   */
  function upsertOccurrence(row: OpenCodeRawAssistantRow): {
    fingerprint: string;
    previous?: string;
  } {
    const fingerprint = rawAssistantRowFingerprint(row);
    if (!rawAssistantRowHasTokenUsage(row)) {
      const previous = removeOccurrenceByMessage(row.messageID);
      return { fingerprint, ...(previous === undefined ? {} : { previous }) };
    }
    let occurrences = groups.get(fingerprint);
    if (!occurrences) {
      occurrences = [];
      groups.set(fingerprint, occurrences);
    }
    const priced = priceRow(row);
    const occurrence: GroupOccurrence = {
      sessionID: row.sessionID,
      messageID: row.messageID,
      createdAtMs: row.createdAtMs,
      completedAtMs: row.completedAtMs,
      input: row.tokens.input,
      output: row.tokens.output,
      reasoning: row.tokens.reasoning,
      cacheRead: row.tokens.cacheRead,
      cacheWrite: row.tokens.cacheWrite,
      ...priced,
    };
    if (row.providerID !== undefined) occurrence.providerID = row.providerID;
    if (row.modelID !== undefined) occurrence.modelID = row.modelID;
    if (row.agent !== undefined) occurrence.agent = row.agent;
    const index = occurrences.findIndex((entry) => entry.messageID === row.messageID);
    if (index >= 0) occurrences[index] = occurrence;
    else occurrences.push(occurrence);
    return { fingerprint };
  }

  function removeOccurrence(row: OpenCodeRawAssistantRow): void {
    const fingerprint = rawAssistantRowFingerprint(row);
    if (!removeOccurrenceAt(fingerprint, row.messageID)) {
      removeOccurrenceByMessage(row.messageID);
    }
  }

  function setMetadata(
    nextSessions: Record<string, OpenCodeSessionInfo>,
    nextProjects: Record<string, OpenCodeProjectInfo>,
  ): void {
    const previousProjectBySession = projectBySession;
    sessions = nextSessions;
    projects = nextProjects;
    projectBySession = new Map();
    sessionsByProject = new Map();
    childrenByParent = new Map();
    treesByProject = new Map();
    for (const session of Object.values(sessions)) {
      const projectId = projectIdOfSession(session);
      projectBySession.set(session.id, projectId);
      let ids = sessionsByProject.get(projectId);
      if (!ids) {
        ids = [];
        sessionsByProject.set(projectId, ids);
      }
      ids.push(session.id);
      if (session.parentID) {
        let children = childrenByParent.get(session.parentID);
        if (!children) {
          children = [];
          childrenByParent.set(session.parentID, children);
        }
        children.push(session);
      }
    }
    for (const [projectId, ids] of sessionsByProject) {
      ids.sort((a, b) => {
        const left = sessions[a];
        const right = sessions[b];
        if (!left || !right) return compareIds(a, b);
        return compareSessions(left, right);
      });
      sessionsByProject.set(projectId, ids);
    }
    for (const children of childrenByParent.values()) children.sort(compareSessions);

    // A session can move between projects (drift/reset): move its owned steps'
    // rollups without rebuilding groups or re-reading payload.
    for (const [sessionId, previous] of previousProjectBySession) {
      const next = projectBySession.get(sessionId) ?? UNKNOWN_PROJECT_ID;
      if (previous === next) continue;
      for (const step of [...(ownedBySession.get(sessionId)?.values() ?? [])]) {
        removeStep(step);
        step.projectID = next;
        addStep(step);
      }
    }
  }

  function treesFor(projectId: string): ProjectTree[] {
    const cached = treesByProject.get(projectId);
    if (cached) return cached;
    const sessionIds = sessionsByProject.get(projectId) ?? [];
    const idSet = new Set(sessionIds);
    const rootOf = new Map<string, string>();
    const resolveRoot = (startId: string): string => {
      const path: string[] = [];
      const position = new Map<string, number>();
      let current = startId;
      let root: string;
      for (;;) {
        const known = rootOf.get(current);
        if (known !== undefined) {
          root = known;
          break;
        }
        const index = position.get(current);
        if (index !== undefined) {
          let smallest = current;
          for (let i = index; i < path.length; i += 1) {
            const member = path[i];
            if (member !== undefined && compareIds(member, smallest) < 0) smallest = member;
          }
          root = smallest;
          break;
        }
        position.set(current, path.length);
        path.push(current);
        const parent = sessions[current]?.parentID;
        if (!parent || !idSet.has(parent)) {
          root = current;
          break;
        }
        current = parent;
      }
      for (const id of path) rootOf.set(id, root);
      return root;
    };
    for (const id of sessionIds) resolveRoot(id);
    const membersByRoot = new Map<string, string[]>();
    for (const id of sessionIds) {
      const root = rootOf.get(id);
      if (root === undefined) continue;
      let members = membersByRoot.get(root);
      if (!members) {
        members = [];
        membersByRoot.set(root, members);
      }
      members.push(id);
    }
    const trees: ProjectTree[] = [];
    for (const [rootId, memberIds] of membersByRoot) {
      memberIds.sort((a, b) => {
        const left = sessions[a];
        const right = sessions[b];
        if (!left || !right) return compareIds(a, b);
        return compareSessions(left, right);
      });
      trees.push({ rootId, memberIds });
    }
    trees.sort((a, b) => compareIds(a.rootId, b.rootId));
    treesByProject.set(projectId, trees);
    return trees;
  }

  function earliestActivity(): number | undefined {
    let earliest: number | undefined;
    const consider = (value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value)) return;
      if (earliest === undefined || value < earliest) earliest = value;
    };
    for (const session of Object.values(sessions)) {
      consider(session.time?.created);
      consider(session.time?.updated);
    }
    if (earliestDirty || earliestStepGlobal === undefined) {
      earliestStepGlobal = undefined;
      for (const value of earliestStepBySession.values()) {
        if (earliestStepGlobal === undefined || value < earliestStepGlobal) {
          earliestStepGlobal = value;
        }
      }
      earliestDirty = false;
    }
    consider(earliestStepGlobal);
    return earliest;
  }

  interface SumOptions {
    projectId?: string;
    sessionIds?: ReadonlySet<string>;
    /** Distinct session ids are only needed for usage/sessionCount views. */
    collectSessions?: boolean;
  }

  function accumulateRange(
    sinceMs: number | undefined,
    untilMs: number,
    options: SumOptions = {},
  ): RangeSum {
    const totals = createAccumulator();
    const sessionsSet = new Set<string>();
    const collectSessions = options.collectSessions !== false;
    let stepCount = 0;
    if (untilMs <= (sinceMs ?? Number.NEGATIVE_INFINITY)) {
      return { totals, stepCount, sessions: sessionsSet };
    }
    const requestedFirstHour = Math.floor((sinceMs ?? 0) / HOUR_MS) * HOUR_MS;
    const firstHour =
      earliestHourMs === undefined
        ? requestedFirstHour
        : Math.max(requestedFirstHour, earliestHourMs);
    const lastHour = Math.floor((untilMs - 1) / HOUR_MS) * HOUR_MS;
    if (firstHour > lastHour) return { totals, stepCount, sessions: sessionsSet };
    const unfiltered =
      options.projectId === undefined && options.sessionIds === undefined && !collectSessions;
    for (let startMs = firstHour; startMs <= lastHour; startMs += HOUR_MS) {
      const bucket = hours.get(startMs);
      if (!bucket) continue;
      const hourEnd = startMs + HOUR_MS;
      const fullyInside = hourEnd <= untilMs && (sinceMs === undefined || startMs >= sinceMs);
      if (fullyInside && unfiltered) {
        mergeAccumulator(totals, bucket.totals);
        stepCount += bucket.steps.size;
        continue;
      }
      for (const step of bucket.steps.values()) {
        if (step.completedAtMs < startMs || step.completedAtMs >= hourEnd) continue;
        if (sinceMs !== undefined && step.completedAtMs < sinceMs) continue;
        if (step.completedAtMs >= untilMs) continue;
        if (options.sessionIds && !options.sessionIds.has(step.sessionID)) continue;
        if (options.projectId !== undefined && step.projectID !== options.projectId) continue;
        addStepToAccumulator(totals, step);
        stepCount += 1;
        if (collectSessions) sessionsSet.add(step.sessionID);
      }
    }
    return { totals, stepCount, sessions: sessionsSet };
  }

  /** Populated hour starts intersecting the window, chronologically ordered. */
  function populatedHourStarts(window: RangeWindow): number[] {
    const starts: number[] = [];
    for (const startMs of hours.keys()) {
      if (startMs + HOUR_MS <= (window.sinceMs ?? Number.NEGATIVE_INFINITY)) continue;
      if (startMs >= window.untilMs) continue;
      starts.push(startMs);
    }
    starts.sort((a, b) => a - b);
    return starts;
  }

  /**
   * Two passes over owned steps already retained by the hour buckets.
   *
   * Pass 1 accumulates flat totals, distinct sessions, pair children, and the
   * earliest positive owned step matching the query filter. Groups are keyed
   * by nested maps of the exact raw id (`undefined` is its own key), so a pair
   * cannot collide across a delimiter and missing ids stay distinct from empty
   * ones. Pass 2 ranks the visible groups, then fills per-bucket accumulators
   * for just the top five series and Other, their opposite-dimension child
   * breakdown, and Other's hidden same-dimension parents. One visit per owned
   * step feeds every level, so inspection adds no raw scan and no price lookup.
   * Bucket arrays never scale with parent/child cardinality, and no parent ×
   * child cross-product or duplicate raw contribution is emitted.
   */
  function groupedSnapshot(query: AnalyticsGroupQuery, nowMs: number): AnalyticsGroupSnapshot {
    const { range, dimension } = query;
    const filter = query.filter;
    const window = rangeWindow(range, nowMs);
    const hourStarts = populatedHourStarts(window);

    function eachOwnedStep(visit: (step: OwnedStep) => void): void {
      for (const startMs of hourStarts) {
        const hour = hours.get(startMs);
        if (!hour) continue;
        const hourEnd = startMs + HOUR_MS;
        for (const step of hour.steps.values()) {
          if (step.completedAtMs < startMs || step.completedAtMs >= hourEnd) continue;
          if (window.sinceMs !== undefined && step.completedAtMs < window.sinceMs) continue;
          if (step.completedAtMs >= window.untilMs) continue;
          visit(step);
        }
      }
    }

    const totals = createAccumulator();
    const sessions = new Set<string>();
    const parentGroups = new Map<string | undefined, GroupNode>();
    const childDimension = oppositeDimension(dimension);
    const lifetime = range === "lifetime";
    let stepCount = 0;
    let earliestMatchedMs: number | undefined;

    eachOwnedStep((step) => {
      if (!matchesFilter(step, filter)) return;
      if (lifetime && (earliestMatchedMs === undefined || step.completedAtMs < earliestMatchedMs)) {
        earliestMatchedMs = step.completedAtMs;
      }
      const parentRaw = rawIdForDimension(step, dimension);
      const childRaw = rawIdForDimension(step, childDimension);
      addStepToAccumulator(totals, step);
      sessions.add(step.sessionID);
      stepCount += 1;

      let parent = parentGroups.get(parentRaw);
      if (!parent) {
        parent = createGroupNode();
        parentGroups.set(parentRaw, parent);
      }
      addStepToGroupNode(parent, step);
      let child = parent.children.get(childRaw);
      if (!child) {
        child = createGroupNode();
        parent.children.set(childRaw, child);
      }
      addStepToGroupNode(child, step);
    });

    // Lifetime buckets start at the exact first positive owned step for this
    // query filter — never session metadata, and never an older unrelated
    // model/provider. Finite ranges anchor on their rolling window and ignore
    // this value. An empty lifetime still renders its fallback current bucket.
    const boundaries = planRangeBuckets(range, nowMs, lifetime ? earliestMatchedMs : undefined, {
      timeZone,
    });
    const bucketStarts = boundaries.map((boundary) => boundary.startMs);

    const ranked: GroupEntry[] = [...parentGroups]
      .map(([raw, node]) => ({ raw, node }))
      .sort(compareGroupEntries);
    const rows = ranked.map((entry) => materializeGroupRow(entry.raw, entry.node));

    const topEntries = ranked.slice(0, 5);
    const otherEntries = ranked.slice(5);
    const topBucketTotals = topEntries.map(() => new Map<number, Accumulator>());
    const topChildBuckets: SeriesEntityBuckets[] = topEntries.map(() => new Map());
    const otherBucketTotals = otherEntries.length > 0 ? new Map<number, Accumulator>() : undefined;
    const otherChildBuckets: SeriesEntityBuckets | undefined =
      otherEntries.length > 0 ? new Map() : undefined;
    const otherParentBuckets: SeriesEntityBuckets | undefined =
      otherEntries.length > 0 ? new Map() : undefined;
    const seriesIndexByParent = new Map<string | undefined, number>();
    topEntries.forEach((entry, index) => {
      seriesIndexByParent.set(entry.raw, index);
    });

    if (ranked.length > 0) {
      eachOwnedStep((step) => {
        if (!matchesFilter(step, filter)) return;
        const bucketIndex = bucketIndexAt(bucketStarts, step.completedAtMs);
        if (bucketIndex < 0) return;
        const parentRaw = rawIdForDimension(step, dimension);
        const childRaw = rawIdForDimension(step, childDimension);
        const seriesIndex = seriesIndexByParent.get(parentRaw);
        if (seriesIndex !== undefined) {
          const bucketTotals = topBucketTotals[seriesIndex];
          if (bucketTotals) addStepToBucket(bucketTotals, step, bucketIndex);
          const childBuckets = topChildBuckets[seriesIndex];
          if (childBuckets) {
            addStepToEntityBucket(childBuckets, childRaw, step, bucketIndex);
          }
          return;
        }
        if (otherBucketTotals) addStepToBucket(otherBucketTotals, step, bucketIndex);
        if (otherChildBuckets) {
          addStepToEntityBucket(otherChildBuckets, childRaw, step, bucketIndex);
        }
        if (otherParentBuckets) {
          addStepToEntityBucket(otherParentBuckets, parentRaw, step, bucketIndex);
        }
      });
    }

    const topSources: SeriesSource[] = topEntries.map((entry, index) => ({
      raw: entry.raw,
      totals: entry.node.totals,
      bucketTotals: topBucketTotals[index] ?? new Map(),
      childBuckets: topChildBuckets[index] ?? new Map(),
    }));
    let otherSource: SeriesSource | undefined;
    if (otherEntries.length > 0) {
      const otherTotals = createAccumulator();
      for (const entry of otherEntries) mergeAccumulator(otherTotals, entry.node.totals);
      otherSource = {
        raw: undefined,
        totals: otherTotals,
        bucketTotals: otherBucketTotals ?? new Map(),
        childBuckets: otherChildBuckets ?? new Map(),
        parentBuckets: otherParentBuckets ?? new Map(),
      };
    }

    const snapshot: AnalyticsGroupSnapshot = {
      dimension,
      range,
      window,
      bucketUnit: rangeBucketUnit(range),
      timeZone,
      buckets: boundaries.map((boundary) => ({
        startMs: boundary.startMs,
        endMs: boundary.endMs,
      })),
      totals: finalize(totals),
      sessionCount: sessions.size,
      stepCount,
      rows,
      series: buildSeries(topSources, otherSource, boundaries.length),
      stale: false,
    };
    if (filter !== undefined) snapshot.filter = filter;
    return snapshot;
  }

  function buildUsage(
    range: RangeKey,
    nowMs: number,
    options: SumOptions = {},
    earliestMs: number | undefined = earliestActivity(),
  ): Usage {
    const window = rangeWindow(range, nowMs);
    const boundaries = planRangeBuckets(range, nowMs, earliestMs, { timeZone });
    const buckets = boundaries.map((boundary) => {
      const sum = accumulateRange(boundary.startMs, boundary.endMs, {
        ...options,
        collectSessions: false,
      });
      return {
        startMs: boundary.startMs,
        endMs: boundary.endMs,
        tokens: finalize(sum.totals),
      };
    });
    const totals = accumulateRange(window.sinceMs, window.untilMs, options);
    return {
      range,
      window,
      bucketUnit: rangeBucketUnit(range),
      timeZone,
      buckets,
      totals: finalize(totals.totals),
      stepCount: totals.stepCount,
      sessionCount: totals.sessions.size,
      stale: false,
    };
  }

  function latestInWindow(values: readonly number[], window: RangeWindow): number | undefined {
    let latest: number | undefined;
    for (const value of values) {
      if (!inWindow(value, window)) continue;
      if (latest === undefined || value > latest) latest = value;
    }
    return latest;
  }

  function sessionActivityValues(sessionId: string): number[] {
    const session = sessions[sessionId];
    const values: number[] = [];
    if (session?.time?.created !== undefined) values.push(session.time.created);
    if (session?.time?.updated !== undefined) values.push(session.time.updated);
    const stepLatest = latestStepBySession.get(sessionId);
    if (stepLatest !== undefined) values.push(stepLatest);
    return values;
  }

  function projectLatestInWindow(projectId: string, window: RangeWindow): number | undefined {
    let latest: number | undefined;
    for (const sessionId of sessionsByProject.get(projectId) ?? []) {
      const candidate = latestInWindow(sessionActivityValues(sessionId), window);
      if (candidate !== undefined && (latest === undefined || candidate > latest))
        latest = candidate;
    }
    return latest;
  }

  function treeLatestInWindow(tree: ProjectTree, window: RangeWindow): number | undefined {
    let latest: number | undefined;
    for (const sessionId of tree.memberIds) {
      const candidate = latestInWindow(sessionActivityValues(sessionId), window);
      if (candidate !== undefined && (latest === undefined || candidate > latest))
        latest = candidate;
    }
    return latest;
  }

  /**
   * Earliest activity belonging to one project, below `nowMs`. A project
   * lifetime graph starts here — never at the first global activity, which may
   * predate the project by months.
   */
  function projectEarliestActivity(projectId: string, nowMs: number): number | undefined {
    let earliest: number | undefined;
    const consider = (value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value) || value >= nowMs) return;
      if (earliest === undefined || value < earliest) earliest = value;
    };
    for (const sessionId of sessionsByProject.get(projectId) ?? []) {
      const session = sessions[sessionId];
      consider(session?.time?.created);
      consider(session?.time?.updated);
      consider(earliestStepBySession.get(sessionId));
    }
    return earliest;
  }

  function projectName(projectId: string): string {
    const info = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined;
    const name = info?.name?.trim();
    if (name) return name;
    const directory = info?.directories[0] ?? info?.worktrees[0];
    return basenameOf(directory) ?? "Project";
  }

  function projectIds(): string[] {
    const ids = new Set<string>(Object.keys(projects));
    for (const projectId of sessionsByProject.keys()) ids.add(projectId);
    return [...ids].sort(compareIds);
  }

  function home(range: RangeKey, nowMs: number): HomeAnalyticsRollup {
    const window = rangeWindow(range, nowMs);
    const usage = buildUsage(range, nowMs);
    const rows: ProjectActivityRow[] = [];
    for (const projectId of projectIds()) {
      const latest = projectLatestInWindow(projectId, window);
      if (range !== "lifetime" && latest === undefined) continue;
      const sum = accumulateRange(window.sinceMs, window.untilMs, {
        projectId,
        collectSessions: false,
      });
      const trees = treesFor(projectId);
      const rootSessionCount =
        range === "lifetime"
          ? trees.length
          : trees.filter((tree) => treeLatestInWindow(tree, window) !== undefined).length;
      rows.push({
        projectId,
        name: projectName(projectId),
        tokens: finalize(sum.totals),
        rootSessionCount,
        latestActivityAtMs: latest ?? 0,
      });
    }
    rows.sort((a, b) => {
      if (a.latestActivityAtMs !== b.latestActivityAtMs) {
        return b.latestActivityAtMs - a.latestActivityAtMs;
      }
      return compareIds(a.projectId, b.projectId);
    });
    return { usage, projects: rows };
  }

  function project(projectId: string, range: RangeKey, nowMs: number): ProjectSnapshot {
    const window = rangeWindow(range, nowMs);
    const usage = buildUsage(
      range,
      nowMs,
      { projectId },
      projectEarliestActivity(projectId, nowMs),
    );
    const roots: ProjectRootRow[] = [];
    for (const tree of treesFor(projectId)) {
      const latest = treeLatestInWindow(tree, window);
      if (range !== "lifetime" && latest === undefined) continue;
      const sum = accumulateRange(window.sinceMs, window.untilMs, {
        sessionIds: new Set(tree.memberIds),
        collectSessions: false,
      });
      const rootSession = sessions[tree.rootId];
      if (!rootSession) continue;
      const row: ProjectRootRow = {
        sessionId: tree.rootId,
        title: sessionTitle(rootSession),
        tokens: finalize(sum.totals),
        latestActivityAtMs: latest ?? 0,
      };
      const worktreeLabel = basenameOf(rootSession.directory);
      if (worktreeLabel) row.worktreeLabel = worktreeLabel;
      roots.push(row);
    }
    roots.sort((a, b) => {
      if (a.latestActivityAtMs !== b.latestActivityAtMs) {
        return b.latestActivityAtMs - a.latestActivityAtMs;
      }
      return compareIds(a.sessionId, b.sessionId);
    });

    const totals = accumulateRange(window.sinceMs, window.untilMs, { projectId });
    return {
      projectId,
      name: projectName(projectId),
      range,
      window,
      roots,
      totals: { ...finalize(totals.totals), sessionCount: totals.sessions.size },
      usage,
      stale: false,
    };
  }

  return {
    setMetadata,
    clear() {
      groups.clear();
      ownedByFp.clear();
      ownedBySession.clear();
      hours.clear();
      latestStepBySession.clear();
      earliestStepBySession.clear();
      earliestHourMs = undefined;
      earliestStepGlobal = undefined;
      earliestDirty = true;
    },
    apply(upserts, removals) {
      const affected = new Set<string>();
      const applyUpsert = (row: OpenCodeRawAssistantRow): void => {
        const result = upsertOccurrence(row);
        affected.add(result.fingerprint);
        if (result.previous !== undefined) affected.add(result.previous);
      };
      for (const row of removals) {
        affected.add(rawAssistantRowFingerprint(row));
        removeOccurrence(row);
      }
      // `upserts` may be a one-shot generator (the engine hydrates the model
      // this way), so materialize references before the zero-row scan. The
      // rows themselves are already retained by the caller.
      const rows = Array.isArray(upserts) ? upserts : [...upserts];
      let hasZeroRows = false;
      for (const row of rows) {
        if (!rawAssistantRowHasTokenUsage(row)) {
          hasZeroRows = true;
          break;
        }
      }
      if (!hasZeroRows) {
        for (const row of rows) applyUpsert(row);
      } else {
        // A batch that contains zero-token rows is reconciled in two phases:
        // last occurrence per message id wins, then zero rows remove prior
        // ownership before positive rows are inserted. This keeps bulk
        // hydration linear instead of scanning all groups per zero row.
        const lastByMessage = new Map<string, OpenCodeRawAssistantRow>();
        for (const row of rows) lastByMessage.set(row.messageID, row);
        // With no owned groups there is nothing a zero row can remove. This is
        // the cold-hydration shape; skipping fingerprint work keeps it linear.
        if (groups.size > 0) {
          for (const row of lastByMessage.values()) {
            if (!rawAssistantRowHasTokenUsage(row)) applyUpsert(row);
          }
        }
        for (const row of lastByMessage.values()) {
          if (rawAssistantRowHasTokenUsage(row)) applyUpsert(row);
        }
      }
      for (const fingerprint of affected) recomputeFingerprint(fingerprint);
    },
    hasSession: (sessionId) => Object.hasOwn(sessions, sessionId),
    hasProject: (projectId) =>
      Object.hasOwn(projects, projectId) || sessionsByProject.has(projectId),
    home,
    project,
    groups: groupedSnapshot,
    earliestActivityMs: earliestActivity,
    ownedStepCount() {
      let count = 0;
      for (const steps of ownedBySession.values()) count += steps.size;
      return count;
    },
  };
}
