import type {
  CostedTokens,
  ProjectActivityRow,
  ProjectRootRow,
  ProjectSnapshot,
  SessionNode,
  SessionSnapshot,
  StepPoint,
  TokenStack,
  Usage,
} from "../contracts/dashboard.js";
import { sumTokenStack } from "../contracts/guards.js";
import {
  planRangeBuckets,
  type RangeBucketBoundary,
  type RangeKey,
  type RangeWindow,
  rangeBucketUnit,
  rangeWindow,
} from "../contracts/ranges.js";
import {
  type OpenCodeCompactionMarker,
  type OpenCodeProjectInfo,
  type OpenCodeRawAssistantRow,
  type OpenCodeSessionInfo,
  rawAssistantRowFingerprint,
} from "../lib/opencode-storage.js";
import { type PricingResolution, priceTokenBuckets } from "../lib/quota-stats.js";
import type { TokenBuckets } from "../lib/token-buckets.js";
import { type ForkOwnerCandidate, selectForkOwnerCandidates } from "../lib/usage-ownership.js";

/**
 * Pure, in-memory GUI analytics over the raw P1 reads (design spec §6,
 * R22–R26, R29–R31, R48, R50). No database, network, config, or credential
 * access happens here; a later P3 source factory loads the readers and calls
 * this one factory.
 *
 * Owner set (R50): every user-facing home/project/session number derives from
 * one globally deterministic, multiplicity-preserving owned set built from the
 * raw completed-assistant rows (fork copies included). Session detail reuses
 * that same owned set, so a fork copy is counted once on every surface.
 *
 * Rows whose `sessionID` is absent from the sessions index are ignored: the
 * dataset is expected to be the complete, consistent raw read.
 */

/** Display id for sessions whose schema carries no `project_id` (R46 drift). */
export const UNKNOWN_PROJECT_ID = "unknown";

/** Title used when a session row has no title text. */
export const UNTITLED_SESSION_TITLE = "Untitled session";

/** One sentence carried into the UI with every session snapshot (spec §6). */
export const STEP_SEMANTICS =
  "A step is one completed assistant message counted at its completion time; " +
  "fork copies are counted once. " +
  "contextTokens = input + cacheRead + cacheWrite; " +
  "totalTokens = input + cacheRead + cacheWrite + output + reasoning. " +
  "Tool calls and stream chunks are not steps; compaction markers are separate.";

/** Controlled, path-free lookup failure for the HTTP layer to map to 404. */
export class AnalyticsNotFoundError extends Error {
  constructor(
    public readonly resource: "project" | "session",
    public readonly resourceId: string,
  ) {
    super(resource === "project" ? "Project not found" : "Session not found");
    this.name = "AnalyticsNotFoundError";
  }
}

/** The raw dataset one P3 source read hands to the factory. */
export interface UsageAnalyticsDataset {
  sessions: Record<string, OpenCodeSessionInfo>;
  projects: Record<string, OpenCodeProjectInfo>;
  messages: OpenCodeRawAssistantRow[];
  compactions: OpenCodeCompactionMarker[];
}

export interface HomeAnalytics {
  usage: Usage;
  projects: ProjectActivityRow[];
}

export interface UsageAnalytics {
  home(range: RangeKey, nowMs: number): HomeAnalytics;
  project(projectId: string, range: RangeKey, nowMs: number): ProjectSnapshot;
  session(sessionId: string): SessionSnapshot;
}

/** Calendar zone for bucket boundaries and DTO formatting (host zone in production). */
export interface UsageAnalyticsOptions {
  timeZone?: string;
}

// ---------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------

function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
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

/** Last path segment of a stored directory; the only path data that leaves here. */
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

function projectIdOf(session: OpenCodeSessionInfo): string {
  const projectId = session.projectID?.trim();
  return projectId ? projectId : UNKNOWN_PROJECT_ID;
}

function stepTimeOf(row: OpenCodeRawAssistantRow): number {
  return row.completedAtMs;
}

function inWindow(timestampMs: number, window: RangeWindow): boolean {
  if (!Number.isFinite(timestampMs)) return false;
  if (timestampMs >= window.untilMs) return false;
  return window.sinceMs === undefined || timestampMs >= window.sinceMs;
}

function tokenBucketsFromRaw(raw: OpenCodeRawAssistantRow["tokens"]): TokenBuckets {
  return {
    input: raw.input,
    output: raw.output,
    reasoning: raw.reasoning,
    cache_read: raw.cacheRead,
    cache_write: raw.cacheWrite,
  };
}

function totalBucketTokens(tokens: TokenBuckets): number {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache_read + tokens.cache_write;
}

// ---------------------------------------------------------------------------
// Costed token accumulation (reuses the existing pricing path unchanged)
// ---------------------------------------------------------------------------

interface CostedAccumulator {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd: number;
  pricedAny: boolean;
  unpricedTokens: number;
  unknownTokens: number;
}

function createAccumulator(): CostedAccumulator {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    costUsd: 0,
    pricedAny: false,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function cloneAccumulator(accumulator: CostedAccumulator): CostedAccumulator {
  return { ...accumulator };
}

function mergeAccumulator(target: CostedAccumulator, source: CostedAccumulator): void {
  target.input += source.input;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.output += source.output;
  target.reasoning += source.reasoning;
  target.costUsd += source.costUsd;
  target.pricedAny = target.pricedAny || source.pricedAny;
  target.unpricedTokens += source.unpricedTokens;
  target.unknownTokens += source.unknownTokens;
}

function finalizeAccumulator(accumulator: CostedAccumulator): CostedTokens {
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
    apiEquivalentCostUsd: accumulator.pricedAny ? accumulator.costUsd : null,
    unpricedTokens: accumulator.unpricedTokens,
    unknownTokens: accumulator.unknownTokens,
  };
}

/**
 * Add one physical row to an accumulator using the existing pricing resolver,
 * per-message cost calculation, and unpriced/unknown classification. Tokens
 * are always counted; a missing estimate is reported as a count, never
 * silently dropped, and is never provider-reported money.
 */
function addRawStep(
  accumulator: CostedAccumulator,
  row: OpenCodeRawAssistantRow,
  pricingCache: Map<string, PricingResolution>,
): void {
  const tokens = tokenBucketsFromRaw(row.tokens);
  accumulator.input += tokens.input;
  accumulator.cacheRead += tokens.cache_read;
  accumulator.cacheWrite += tokens.cache_write;
  accumulator.output += tokens.output;
  accumulator.reasoning += tokens.reasoning;

  const outcome = priceTokenBuckets({
    providerID: row.providerID,
    modelID: row.modelID,
    tokens,
    cache: pricingCache,
  });

  if (outcome.status === "priced") {
    accumulator.pricedAny = true;
    accumulator.costUsd += outcome.costUsd;
    return;
  }

  const total = totalBucketTokens(tokens);
  if (outcome.status === "unpriced") {
    accumulator.unpricedTokens += total;
  } else {
    accumulator.unknownTokens += total;
  }
}

// ---------------------------------------------------------------------------
// Dataset model: owned set, indexes, project trees
// ---------------------------------------------------------------------------

interface OwnedStep {
  row: OpenCodeRawAssistantRow;
  sessionId: string;
  projectId: string;
  createdAtMs: number;
  timeMs: number;
}

interface ProjectTree {
  rootId: string;
  memberIds: string[];
}

interface AnalyticsModel {
  dataset: UsageAnalyticsDataset;
  ownedSteps: OwnedStep[];
  ownedBySession: Map<string, OwnedStep[]>;
  ownedByProject: Map<string, OwnedStep[]>;
  sessionsByProject: Map<string, string[]>;
  projectIds: string[];
  projectIdSet: Set<string>;
  treesByProject: Map<string, ProjectTree[]>;
  childrenByParent: Map<string, OpenCodeSessionInfo[]>;
}

function compareOccurrence(a: OwnedStep, b: OwnedStep): number {
  if (a.createdAtMs !== b.createdAtMs) return a.createdAtMs - b.createdAtMs;
  const byMessage = compareIds(a.row.messageID, b.row.messageID);
  if (byMessage !== 0) return byMessage;
  return compareIds(a.sessionId, b.sessionId);
}

/**
 * R50 owned set: raw rows are grouped by the shared upstream fingerprint and
 * selected through the shared deterministic ownership primitive
 * (`selectForkOwnerCandidates`): per session occurrences sort by `time.created`
 * then messageId, and occurrence index `0..maxCount-1` selects the earliest
 * candidate across sessions. The winner's project owns that occurrence, so a
 * fingerprint repeated k times in one session contributes k rows and the
 * result never depends on read order.
 */
function buildOwnedSteps(usable: OwnedStep[]): OwnedStep[] {
  const candidates: Array<ForkOwnerCandidate<OwnedStep>> = usable.map((step) => ({
    item: step,
    sessionID: step.sessionId,
    fingerprint: rawAssistantRowFingerprint(step.row),
    createdAtMs: step.createdAtMs,
    messageID: step.row.messageID,
  }));

  return selectForkOwnerCandidates(candidates)
    .map((candidate) => candidate.item)
    .sort(compareOccurrence);
}

/**
 * Attribute every project session to exactly one root by walking `parent_id`
 * upward within the project. Orphans (missing or out-of-project parents) are
 * their own root; a parent cycle resolves to its smallest stable id, so
 * membership never depends on insertion order. Roots are memoized (path
 * compression) so arbitrary-depth chains stay linear.
 */
function computeProjectTrees(
  sessionIds: readonly string[],
  sessions: Record<string, OpenCodeSessionInfo>,
): ProjectTree[] {
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
          const member = path[i]!;
          if (compareIds(member, smallest) < 0) smallest = member;
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
    const root = rootOf.get(id)!;
    let members = membersByRoot.get(root);
    if (!members) {
      members = [];
      membersByRoot.set(root, members);
    }
    members.push(id);
  }

  const trees: ProjectTree[] = [];
  for (const [rootId, memberIds] of membersByRoot) {
    memberIds.sort((a, b) => compareSessions(sessions[a]!, sessions[b]!));
    trees.push({ rootId, memberIds });
  }
  trees.sort((a, b) => compareIds(a.rootId, b.rootId));
  return trees;
}

function buildAnalyticsModel(dataset: UsageAnalyticsDataset): AnalyticsModel {
  const sessions = dataset.sessions;

  const usable: OwnedStep[] = [];
  for (const row of dataset.messages) {
    const session = sessions[row.sessionID];
    if (!session) continue;
    if (!(row.completedAtMs > 0) || !Number.isFinite(row.completedAtMs)) continue;
    usable.push({
      row,
      sessionId: row.sessionID,
      projectId: projectIdOf(session),
      createdAtMs: row.createdAtMs,
      timeMs: stepTimeOf(row),
    });
  }

  const ownedSteps = buildOwnedSteps(usable);
  const ownedBySession = new Map<string, OwnedStep[]>();
  const ownedByProject = new Map<string, OwnedStep[]>();
  for (const step of ownedSteps) {
    let bySession = ownedBySession.get(step.sessionId);
    if (!bySession) {
      bySession = [];
      ownedBySession.set(step.sessionId, bySession);
    }
    bySession.push(step);
    let byProject = ownedByProject.get(step.projectId);
    if (!byProject) {
      byProject = [];
      ownedByProject.set(step.projectId, byProject);
    }
    byProject.push(step);
  }

  const sessionsByProject = new Map<string, string[]>();
  for (const session of Object.values(sessions)) {
    const projectId = projectIdOf(session);
    let list = sessionsByProject.get(projectId);
    if (!list) {
      list = [];
      sessionsByProject.set(projectId, list);
    }
    list.push(session.id);
  }
  for (const list of sessionsByProject.values()) {
    list.sort((a, b) => compareSessions(sessions[a]!, sessions[b]!));
  }

  const projectIdSet = new Set<string>(Object.keys(dataset.projects));
  for (const projectId of sessionsByProject.keys()) projectIdSet.add(projectId);
  const projectIds = [...projectIdSet].sort(compareIds);

  const treesByProject = new Map<string, ProjectTree[]>();
  for (const [projectId, sessionIds] of sessionsByProject) {
    treesByProject.set(projectId, computeProjectTrees(sessionIds, sessions));
  }

  const childrenByParent = new Map<string, OpenCodeSessionInfo[]>();
  for (const session of Object.values(sessions)) {
    if (!session.parentID) continue;
    let children = childrenByParent.get(session.parentID);
    if (!children) {
      children = [];
      childrenByParent.set(session.parentID, children);
    }
    children.push(session);
  }
  for (const children of childrenByParent.values()) children.sort(compareSessions);

  return {
    dataset,
    ownedSteps,
    ownedBySession,
    ownedByProject,
    sessionsByProject,
    projectIds,
    projectIdSet,
    treesByProject,
    childrenByParent,
  };
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function considerActivity(
  current: number | undefined,
  value: number | undefined,
  window: RangeWindow,
): number | undefined {
  if (value === undefined || !Number.isFinite(value) || !inWindow(value, window)) return current;
  if (current === undefined || value > current) return value;
  return current;
}

/**
 * Latest in-window activity of a subtree: descendant session
 * `created`/`updated` and step times — a timestamp, never a token quantity.
 */
function treeLatestActivityMs(
  model: AnalyticsModel,
  tree: ProjectTree,
  window: RangeWindow,
): number | undefined {
  let latest: number | undefined;
  for (const memberId of tree.memberIds) {
    const session = model.dataset.sessions[memberId];
    latest = considerActivity(latest, session?.time?.created, window);
    latest = considerActivity(latest, session?.time?.updated, window);
    for (const step of model.ownedBySession.get(memberId) ?? []) {
      latest = considerActivity(latest, step.timeMs, window);
    }
  }
  return latest;
}

function projectLatestActivityMs(
  model: AnalyticsModel,
  projectId: string,
  window: RangeWindow,
): number | undefined {
  let latest: number | undefined;
  for (const sessionId of model.sessionsByProject.get(projectId) ?? []) {
    const session = model.dataset.sessions[sessionId];
    latest = considerActivity(latest, session?.time?.created, window);
    latest = considerActivity(latest, session?.time?.updated, window);
  }
  for (const step of model.ownedByProject.get(projectId) ?? []) {
    latest = considerActivity(latest, step.timeMs, window);
  }
  return latest;
}

/**
 * Earliest activity timestamp below `nowMs` across the given sessions and
 * steps; `lifetime` starts its daily buckets there. `undefined` means "no
 * activity" and yields the explicit one-current-day-bucket empty state.
 */
function earliestActivityMs(
  model: AnalyticsModel,
  sessionIds: Iterable<string>,
  steps: readonly OwnedStep[],
  nowMs: number,
): number | undefined {
  let earliest: number | undefined;
  const consider = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value) || value >= nowMs) return;
    if (earliest === undefined || value < earliest) earliest = value;
  };
  for (const sessionId of sessionIds) {
    const session = model.dataset.sessions[sessionId];
    consider(session?.time?.created);
    consider(session?.time?.updated);
  }
  for (const step of steps) consider(step.timeMs);
  return earliest;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function bucketIndexFor(buckets: readonly RangeBucketBoundary[], timestampMs: number): number {
  let low = 0;
  let high = buckets.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const bucket = buckets[middle]!;
    if (timestampMs < bucket.startMs) {
      high = middle - 1;
    } else if (timestampMs >= bucket.endMs) {
      low = middle + 1;
    } else {
      return middle;
    }
  }
  return -1;
}

function buildUsage(
  range: RangeKey,
  nowMs: number,
  steps: readonly OwnedStep[],
  earliestMs: number | undefined,
  timeZone: string,
): Usage {
  const window = rangeWindow(range, nowMs);
  const boundaries = planRangeBuckets(range, nowMs, earliestMs, { timeZone });
  const bucketAccumulators = boundaries.map(() => createAccumulator());
  const totals = createAccumulator();
  const pricingCache = new Map<string, PricingResolution>();
  const sessionIds = new Set<string>();

  for (const step of steps) {
    addRawStep(totals, step.row, pricingCache);
    sessionIds.add(step.sessionId);
    const index = bucketIndexFor(boundaries, step.timeMs);
    if (index >= 0) addRawStep(bucketAccumulators[index]!, step.row, pricingCache);
  }

  return {
    range,
    window,
    bucketUnit: rangeBucketUnit(range),
    timeZone,
    buckets: boundaries.map((boundary, index) => ({
      startMs: boundary.startMs,
      endMs: boundary.endMs,
      tokens: finalizeAccumulator(bucketAccumulators[index]!),
    })),
    totals: finalizeAccumulator(totals),
    stepCount: steps.length,
    sessionCount: sessionIds.size,
    stale: false,
  };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

function projectName(model: AnalyticsModel, projectId: string): string {
  const info = Object.hasOwn(model.dataset.projects, projectId)
    ? model.dataset.projects[projectId]
    : undefined;
  const name = info?.name?.trim();
  if (name) return name;
  const directory = info?.directories[0] ?? info?.worktrees[0];
  return basenameOf(directory) ?? "Project";
}

function compareProjectRows(a: ProjectActivityRow, b: ProjectActivityRow): number {
  if (a.latestActivityAtMs !== b.latestActivityAtMs) {
    return b.latestActivityAtMs - a.latestActivityAtMs;
  }
  return compareIds(a.projectId, b.projectId);
}

function buildHome(
  model: AnalyticsModel,
  range: RangeKey,
  nowMs: number,
  timeZone: string,
): HomeAnalytics {
  const window = rangeWindow(range, nowMs);
  const scopedSteps = model.ownedSteps.filter((step) => inWindow(step.timeMs, window));
  const earliestMs = earliestActivityMs(
    model,
    Object.keys(model.dataset.sessions),
    model.ownedSteps,
    nowMs,
  );
  const usage = buildUsage(range, nowMs, scopedSteps, earliestMs, timeZone);

  const projects: ProjectActivityRow[] = [];
  for (const projectId of model.projectIds) {
    const steps = (model.ownedByProject.get(projectId) ?? []).filter((step) =>
      inWindow(step.timeMs, window),
    );
    const latest = projectLatestActivityMs(model, projectId, window);
    if (range !== "lifetime" && latest === undefined) continue;

    const accumulator = createAccumulator();
    const pricingCache = new Map<string, PricingResolution>();
    for (const step of steps) addRawStep(accumulator, step.row, pricingCache);

    const trees = model.treesByProject.get(projectId) ?? [];
    const rootSessionCount =
      range === "lifetime"
        ? trees.length
        : trees.filter((tree) => treeLatestActivityMs(model, tree, window) !== undefined).length;

    projects.push({
      projectId,
      name: projectName(model, projectId),
      tokens: finalizeAccumulator(accumulator),
      rootSessionCount,
      latestActivityAtMs: latest ?? 0,
    });
  }
  projects.sort(compareProjectRows);

  return { usage, projects };
}

// ---------------------------------------------------------------------------
// Project snapshot
// ---------------------------------------------------------------------------

function compareRootRows(a: ProjectRootRow, b: ProjectRootRow): number {
  if (a.latestActivityAtMs !== b.latestActivityAtMs) {
    return b.latestActivityAtMs - a.latestActivityAtMs;
  }
  return compareIds(a.sessionId, b.sessionId);
}

function buildProject(
  model: AnalyticsModel,
  projectId: string,
  range: RangeKey,
  nowMs: number,
  timeZone: string,
): ProjectSnapshot {
  if (!model.projectIdSet.has(projectId)) {
    throw new AnalyticsNotFoundError("project", projectId);
  }

  const window = rangeWindow(range, nowMs);
  const projectSteps = model.ownedByProject.get(projectId) ?? [];
  const scopedSteps = projectSteps.filter((step) => inWindow(step.timeMs, window));
  const earliestMs = earliestActivityMs(
    model,
    model.sessionsByProject.get(projectId) ?? [],
    projectSteps,
    nowMs,
  );
  const usage = buildUsage(range, nowMs, scopedSteps, earliestMs, timeZone);

  const pricingCache = new Map<string, PricingResolution>();
  const roots: ProjectRootRow[] = [];
  for (const tree of model.treesByProject.get(projectId) ?? []) {
    const latest = treeLatestActivityMs(model, tree, window);
    if (range !== "lifetime" && latest === undefined) continue;

    const memberIds = new Set(tree.memberIds);
    const accumulator = createAccumulator();
    for (const step of scopedSteps) {
      if (memberIds.has(step.sessionId)) addRawStep(accumulator, step.row, pricingCache);
    }

    const rootSession = model.dataset.sessions[tree.rootId];
    if (!rootSession) continue;
    const worktreeLabel = basenameOf(rootSession.directory);
    const row: ProjectRootRow = {
      sessionId: tree.rootId,
      title: sessionTitle(rootSession),
      tokens: finalizeAccumulator(accumulator),
      latestActivityAtMs: latest ?? 0,
    };
    if (worktreeLabel) row.worktreeLabel = worktreeLabel;
    roots.push(row);
  }
  roots.sort(compareRootRows);

  const totalsAccumulator = createAccumulator();
  const contributingSessions = new Set<string>();
  for (const step of scopedSteps) {
    addRawStep(totalsAccumulator, step.row, pricingCache);
    contributingSessions.add(step.sessionId);
  }

  return {
    projectId,
    name: projectName(model, projectId),
    range,
    window,
    roots,
    totals: { ...finalizeAccumulator(totalsAccumulator), sessionCount: contributingSessions.size },
    usage,
    stale: false,
  };
}

// ---------------------------------------------------------------------------
// Session detail (the selected tree's owned steps — R25/R26/R50)
// ---------------------------------------------------------------------------

function sessionOwnLatestMs(model: AnalyticsModel, sessionId: string): number {
  let latest = 0;
  const consider = (value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value) && value > latest) latest = value;
  };
  const session = model.dataset.sessions[sessionId];
  consider(session?.time?.created);
  consider(session?.time?.updated);
  for (const step of model.ownedBySession.get(sessionId) ?? []) consider(step.timeMs);
  return latest;
}

function buildSessionSnapshot(
  model: AnalyticsModel,
  sessionId: string,
  timeZone: string,
): SessionSnapshot {
  const focus = model.dataset.sessions[sessionId];
  if (!focus) throw new AnalyticsNotFoundError("session", sessionId);
  const focusProjectId = projectIdOf(focus);
  const focusProjectName = projectName(model, focusProjectId);

  // Iterative DFS pre-order: arbitrary depth, no node cap, visited-set cycle guard.
  const order: Array<{ id: string; depth: number }> = [];
  const nodeIndex = new Map<string, number>();
  const visitedFrom = new Map<string, string | undefined>();
  const pending: Array<{ id: string; depth: number; from?: string }> = [
    { id: sessionId, depth: 0 },
  ];
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (nodeIndex.has(entry.id)) continue;
    nodeIndex.set(entry.id, order.length);
    visitedFrom.set(entry.id, entry.from);
    order.push({ id: entry.id, depth: entry.depth });
    const children = model.childrenByParent.get(entry.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (!nodeIndex.has(child.id)) {
        pending.push({ id: child.id, depth: entry.depth + 1, from: entry.id });
      }
    }
  }

  const pricingCache = new Map<string, PricingResolution>();
  const ownAccumulators = new Map<string, CostedAccumulator>();
  for (const node of order) {
    const accumulator = createAccumulator();
    for (const step of model.ownedBySession.get(node.id) ?? []) {
      addRawStep(accumulator, step.row, pricingCache);
    }
    ownAccumulators.set(node.id, accumulator);
  }

  const subtreeAccumulators = new Map<string, CostedAccumulator>();
  const subtreeNodeCounts = new Map<string, number>();
  const subtreeLatest = new Map<string, number>();
  for (const node of order) {
    subtreeAccumulators.set(node.id, cloneAccumulator(ownAccumulators.get(node.id)!));
    subtreeNodeCounts.set(node.id, 1);
    subtreeLatest.set(node.id, sessionOwnLatestMs(model, node.id));
  }
  // Reverse pre-order folds each subtree into its rendered parent. A back edge
  // to an already-visited ancestor (cycle) is not a rendered child link and
  // never folds, so nothing is double counted.
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]?.id;
    const parentId = visitedFrom.get(id);
    if (parentId === undefined) continue;
    const parentIndex = nodeIndex.get(parentId);
    if (parentIndex === undefined || parentIndex > index) continue;
    mergeAccumulator(subtreeAccumulators.get(parentId)!, subtreeAccumulators.get(id)!);
    subtreeNodeCounts.set(parentId, subtreeNodeCounts.get(parentId)! + subtreeNodeCounts.get(id)!);
    subtreeLatest.set(parentId, Math.max(subtreeLatest.get(parentId)!, subtreeLatest.get(id)!));
  }

  const nodes: SessionNode[] = order.map(({ id, depth }) => {
    const session = model.dataset.sessions[id]!;
    const ownSteps = model.ownedBySession.get(id) ?? [];
    const childIds = (model.childrenByParent.get(id) ?? [])
      .filter((child) => visitedFrom.get(child.id) === id)
      .map((child) => child.id);
    const worktreeLabel = basenameOf(session.directory);
    const node: SessionNode = {
      sessionId: id,
      title: sessionTitle(session),
      depth,
      childIds,
      ownTokens: finalizeAccumulator(ownAccumulators.get(id)!),
      subtreeTokens: finalizeAccumulator(subtreeAccumulators.get(id)!),
      stepCount: ownSteps.length,
      subtreeNodeCount: subtreeNodeCounts.get(id)!,
      latestActivityAtMs: subtreeLatest.get(id)!,
    };
    if (session.parentID !== undefined) node.parentId = session.parentID;
    if (worktreeLabel) node.worktreeLabel = worktreeLabel;
    return node;
  });

  const steps: StepPoint[] = [];
  for (const { id } of order) {
    const branch = nodeIndex.get(id)!;
    for (const ownedStep of model.ownedBySession.get(id) ?? []) {
      const row = ownedStep.row;
      const stack: TokenStack = {
        input: row.tokens.input,
        cacheRead: row.tokens.cacheRead,
        cacheWrite: row.tokens.cacheWrite,
        output: row.tokens.output,
        reasoning: row.tokens.reasoning,
      };
      const step: StepPoint = {
        sessionId: id,
        messageId: row.messageID,
        atMs: ownedStep.timeMs,
        branch,
        stack,
        contextTokens: stack.input + stack.cacheRead + stack.cacheWrite,
        totalTokens: sumTokenStack(stack),
      };
      if (row.providerID && row.modelID) {
        step.model = { providerId: row.providerID, modelId: row.modelID };
      }
      if (row.agent) step.agent = row.agent;
      steps.push(step);
    }
  }
  steps.sort((a, b) => {
    if (a.atMs !== b.atMs) return a.atMs - b.atMs;
    const byMessage = compareIds(a.messageId, b.messageId);
    if (byMessage !== 0) return byMessage;
    return compareIds(a.sessionId, b.sessionId);
  });

  const treeTotals = createAccumulator();
  for (const node of order) mergeAccumulator(treeTotals, ownAccumulators.get(node.id)!);

  // Markers explain drops in the blue focus-context series, so only the focus
  // session's own compactions belong here. A descendant compaction is not a
  // context drop on this page and must never be drawn as one.
  const compactionMarkers = model.dataset.compactions
    .filter((marker) => marker.sessionId === sessionId)
    .sort((a, b) => a.atMs - b.atMs || compareIds(a.messageId, b.messageId))
    .map((marker) => ({
      sessionId: marker.sessionId,
      atMs: marker.atMs,
      messageId: marker.messageId,
    }));

  const breadcrumbs: SessionSnapshot["breadcrumbs"] = [];
  const seenAncestors = new Set<string>([sessionId]);
  let ancestorId: string | undefined = focus.parentID;
  while (ancestorId !== undefined && !seenAncestors.has(ancestorId)) {
    const ancestor: OpenCodeSessionInfo | undefined = model.dataset.sessions[ancestorId];
    if (!ancestor) break;
    seenAncestors.add(ancestorId);
    breadcrumbs.push({
      sessionId: ancestor.id,
      title: sessionTitle(ancestor),
      isFocus: false,
    });
    ancestorId = ancestor.parentID;
  }
  breadcrumbs.reverse();
  breadcrumbs.push({ sessionId, title: sessionTitle(focus), isFocus: true });

  const focusSteps = model.ownedBySession.get(sessionId) ?? [];

  return {
    focusSessionId: sessionId,
    timeZone,
    projectId: focusProjectId,
    projectName: focusProjectName,
    breadcrumbs,
    nodes,
    steps,
    compactionMarkers,
    ownSummary: {
      ...finalizeAccumulator(ownAccumulators.get(sessionId)!),
      stepCount: focusSteps.length,
    },
    treeTotals: finalizeAccumulator(treeTotals),
    stepSemantics: STEP_SEMANTICS,
  };
}

/**
 * The one P3 analytics factory: pure Node/in-memory over a raw dataset.
 * Reading the database, config, or user state is the caller's job.
 */
export function createUsageAnalytics(
  dataset: UsageAnalyticsDataset,
  options: UsageAnalyticsOptions = {},
): UsageAnalytics {
  const timeZone = options.timeZone ?? "UTC";
  const model = buildAnalyticsModel(dataset);
  return {
    home: (range, nowMs) => buildHome(model, range, nowMs, timeZone),
    project: (projectId, range, nowMs) => buildProject(model, projectId, range, nowMs, timeZone),
    session: (sessionId) => buildSessionSnapshot(model, sessionId, timeZone),
  };
}
