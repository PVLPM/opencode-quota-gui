/**
 * Worker-only rollup model.
 *
 * Owns deterministic fork ownership over compact fingerprint groups plus
 * per-hour rollups (global / project / session / model) and derives dashboard
 * views by summing rollups. Full hours use pre-aggregated buckets; only the
 * partial edge hours of a request touch the owned step list, so bucket
 * boundaries stay exact without rebuilding a raw model per view.
 */
import type {
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

function isZeroTokens(accumulator: Accumulator): boolean {
  return (
    accumulator.input === 0 &&
    accumulator.cacheRead === 0 &&
    accumulator.cacheWrite === 0 &&
    accumulator.output === 0 &&
    accumulator.reasoning === 0
  );
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
  earliestActivityMs(): number | undefined;
  ownedStepCount(): number;
}

export function createAnalyticsModel(): AnalyticsModel {
  const pricingCache = new Map<string, PricingResolution>();
  const groups = new Map<string, GroupOccurrence[]>();
  const ownedByFp = new Map<string, Map<string, OwnedStep>>();
  const ownedBySession = new Map<string, Map<string, OwnedStep>>();
  const hours = new Map<number, HourBucket>();
  /** Lifetime model-dimension rollup (small: one entry per provider/model). */
  const modelLifetime = new Map<string, Accumulator>();
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

  function keyedAccumulator(map: Map<string, Accumulator>, key: string): Accumulator {
    let accumulator = map.get(key);
    if (!accumulator) {
      accumulator = createAccumulator();
      map.set(key, accumulator);
    }
    return accumulator;
  }

  function addStep(step: OwnedStep): void {
    const startMs = Math.floor(step.completedAtMs / HOUR_MS) * HOUR_MS;
    if (earliestHourMs === undefined || startMs < earliestHourMs) earliestHourMs = startMs;
    const bucket = bucketFor(startMs);
    addStepToAccumulator(bucket.totals, step);
    addStepToAccumulator(
      keyedAccumulator(modelLifetime, `${step.providerID ?? ""}|||${step.modelID ?? ""}`),
      step,
    );
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
      const modelKey = `${step.providerID ?? ""}|||${step.modelID ?? ""}`;
      const model = modelLifetime.get(modelKey);
      if (model) {
        subtractStepFromAccumulator(model, step);
        if (isZeroTokens(model)) modelLifetime.delete(modelKey);
      }
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

  function recomputeFingerprint(fingerprint: string): void {
    const previous = ownedByFp.get(fingerprint) ?? new Map<string, OwnedStep>();
    const occurrences = groups.get(fingerprint);
    const next = new Map<string, OwnedStep>();
    if (occurrences && occurrences.length > 0) {
      const candidates: ForkOwnerCandidate<OwnedStep>[] = [];
      for (const occurrence of occurrences) {
        candidates.push({
          item: toOwnedStep(occurrence),
          sessionID: occurrence.sessionID,
          fingerprint,
          createdAtMs: occurrence.createdAtMs,
          messageID: occurrence.messageID,
        });
      }
      for (const step of selectForkOwners(candidates)) {
        next.set(`${step.sessionID}\u0000${step.messageID}`, step);
      }
    }
    for (const [key, step] of previous) {
      if (!next.has(key)) removeStep(step);
    }
    for (const [key, step] of next) {
      const before = previous.get(key);
      if (!before) {
        addStep(step);
        continue;
      }
      if (
        before.tokens.input !== step.tokens.input ||
        before.tokens.cacheRead !== step.tokens.cacheRead ||
        before.tokens.cacheWrite !== step.tokens.cacheWrite ||
        before.tokens.output !== step.tokens.output ||
        before.tokens.reasoning !== step.tokens.reasoning ||
        before.completedAtMs !== step.completedAtMs ||
        before.costUsd !== step.costUsd ||
        before.pricedAny !== step.pricedAny ||
        before.unpricedTokens !== step.unpricedTokens ||
        before.unknownTokens !== step.unknownTokens
      ) {
        removeStep(before);
        addStep(step);
      }
    }
    ownedByFp.set(fingerprint, next);
  }

  function upsertOccurrence(row: OpenCodeRawAssistantRow): void {
    const fingerprint = rawAssistantRowFingerprint(row);
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
  }

  function removeOccurrence(row: OpenCodeRawAssistantRow): void {
    const fingerprint = rawAssistantRowFingerprint(row);
    const occurrences = groups.get(fingerprint);
    if (!occurrences) return;
    const index = occurrences.findIndex((entry) => entry.messageID === row.messageID);
    if (index >= 0) occurrences.splice(index, 1);
    if (occurrences.length === 0) groups.delete(fingerprint);
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

  function buildUsage(range: RangeKey, nowMs: number, options: SumOptions = {}): Usage {
    const window = rangeWindow(range, nowMs);
    const boundaries = planRangeBuckets(range, nowMs, earliestActivity());
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
    const usage = buildUsage(range, nowMs, { projectId });
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
      modelLifetime.clear();
      latestStepBySession.clear();
      earliestStepBySession.clear();
      earliestHourMs = undefined;
      earliestStepGlobal = undefined;
      earliestDirty = true;
    },
    apply(upserts, removals) {
      const affected = new Set<string>();
      for (const row of removals) {
        affected.add(rawAssistantRowFingerprint(row));
        removeOccurrence(row);
      }
      for (const row of upserts) {
        affected.add(rawAssistantRowFingerprint(row));
        upsertOccurrence(row);
      }
      for (const fingerprint of affected) recomputeFingerprint(fingerprint);
    },
    hasSession: (sessionId) => Object.hasOwn(sessions, sessionId),
    hasProject: (projectId) =>
      Object.hasOwn(projects, projectId) || sessionsByProject.has(projectId),
    home,
    project,
    earliestActivityMs: earliestActivity,
    ownedStepCount() {
      let count = 0;
      for (const steps of ownedBySession.values()) count += steps.size;
      return count;
    },
  };
}
