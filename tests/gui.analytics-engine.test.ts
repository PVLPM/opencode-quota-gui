import { describe, expect, it, vi } from "vitest";
import type {
  AnalyticsGroupQuery,
  CostedTokens,
  HomeSnapshot,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import {
  ANALYTICS_FULL_REPAIR_INTERVAL_MS,
  ANALYTICS_SOURCE_CURSOR_OVERLAP_MS,
  ANALYTICS_THIRTY_DAY_EXTENSION_DELAY_MS,
  createAnalyticsEngine,
} from "../src/gui/analytics-engine.js";
import type { AnalyticsReader } from "../src/gui/analytics-reader.js";
import {
  ANALYTICS_PRESENTATION_SESSION_LIMIT,
  type AnalyticsState,
  decodeAnalyticsPresentation,
  decodeAnalyticsState,
  encodeAnalyticsPresentation,
  encodeAnalyticsState,
  type PersistedAnalyticsState,
  rowKey,
  type WarmAnalyticsPresentation,
} from "../src/gui/analytics-state.js";
import { resolveHostTimeZone } from "../src/gui/time-zone.js";
import type {
  OpenCodeCompactionMarker,
  OpenCodeMessageRevision,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
  OpenCodeSourceIdentity,
  OpenCodeStorageSnapshot,
  OpenCodeStorageSnapshotResult,
} from "../src/lib/opencode-storage.js";

const capturedDatasets = vi.hoisted((): UsageAnalyticsDataset[] => []);

/**
 * Production analytics always runs in the host calendar zone, so every fixture
 * that must be accepted by the engine's cache has to carry that same zone.
 */
const HOST_ZONE = resolveHostTimeZone();
const analytics = (dataset: UsageAnalyticsDataset) =>
  createUsageAnalytics(dataset, { timeZone: HOST_ZONE });

vi.mock("../src/gui/aggregation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/gui/aggregation.js")>();
  return {
    ...actual,
    createUsageAnalytics: (dataset: UsageAnalyticsDataset, options?: { timeZone?: string }) => {
      capturedDatasets.push(dataset);
      return actual.createUsageAnalytics(dataset, options);
    },
  };
});

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const INTERVAL = 600_000;

interface ReaderCall {
  method:
    | "withSnapshot"
    | "loadSessions"
    | "loadProjects"
    | "loadRevisions"
    | "loadRevisionFrontier"
    | "loadCompletedRows"
    | "loadCompactions";
  params?: Record<string, unknown>;
}

interface FakeDb {
  sessions: Record<string, OpenCodeSessionInfo>;
  projects: Record<string, OpenCodeProjectInfo>;
  rows: OpenCodeRawAssistantRow[];
  updatedAt: Map<string, number | null>;
  revisionOverrides: Map<string, Partial<OpenCodeMessageRevision>>;
  extraRevisions: OpenCodeMessageRevision[];
  compactions: OpenCodeCompactionMarker[];
  identity: OpenCodeSourceIdentity;
  status: "ok" | "missing" | "unreadable";
  updatedAtAvailable: boolean;
}

function session(
  id: string,
  projectID: string,
  extra: Partial<OpenCodeSessionInfo> = {},
): OpenCodeSessionInfo {
  return {
    id,
    projectID,
    title: id,
    time: { created: NOW - 2 * HOUR, updated: NOW - HOUR },
    ...extra,
  };
}

function row(
  sessionID: string,
  messageID: string,
  atMs: number,
  tokens: { input?: number; output?: number; cacheRead?: number } = {},
  extra: Partial<OpenCodeRawAssistantRow> = {},
): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs: atMs,
    completedAtMs: atMs,
    tokens: {
      input: tokens.input ?? 100,
      output: tokens.output ?? 10,
      reasoning: 0,
      cacheRead: tokens.cacheRead ?? 0,
      cacheWrite: 0,
    },
    providerID: "openai",
    modelID: "gpt-5",
    cost: 1,
    ...extra,
  };
}

function identity(overrides: Partial<OpenCodeSourceIdentity> = {}): OpenCodeSourceIdentity {
  return {
    dbPath: "/db",
    exists: true,
    status: "ok",
    realPath: "/db",
    device: "1",
    inode: "10",
    birthtimeMs: 200,
    schemaToken: "session_v2(a)|session_message(a)",
    sizeBytes: 100,
    mtimeMs: 100,
    ...overrides,
  };
}

function baseDb(): FakeDb {
  const rows = [
    row("ses_root", "msg_a", NOW - HOUR, { input: 100 }),
    row("ses_child", "msg_a_fork", NOW - HOUR, { input: 100 }),
    row("ses_root", "msg_b", NOW - HOUR, { input: 200 }),
    row("ses_other", "msg_o", NOW - HOUR, { input: 400 }),
    row("ses_other", "msg_old", NOW - 2 * DAY, { input: 800 }),
  ];
  const updatedAt = new Map<string, number | null>();
  for (const entry of rows)
    updatedAt.set(rowKey(entry.sessionID, entry.messageID), entry.completedAtMs);
  return {
    sessions: {
      ses_root: session("ses_root", "p1"),
      ses_child: session("ses_child", "p1", { parentID: "ses_root" }),
      ses_other: session("ses_other", "p2"),
    },
    projects: {
      p1: { id: "p1", name: "Project One", directories: [], worktrees: [] },
      p2: { id: "p2", name: "Project Two", directories: [], worktrees: [] },
    },
    rows,
    updatedAt,
    revisionOverrides: new Map(),
    extraRevisions: [],
    compactions: [{ sessionId: "ses_root", atMs: NOW - HOUR, messageId: "msg_c" }],
    identity: identity(),
    status: "ok",
    updatedAtAvailable: true,
  };
}

function createFakeReader(db: FakeDb, calls: ReaderCall[]): AnalyticsReader {
  const revisionsFor = (
    sessionIds?: readonly string[],
    messageIds?: readonly string[],
  ): OpenCodeMessageRevision[] => {
    const revisions: OpenCodeMessageRevision[] = [];
    for (const entry of db.rows) {
      const key = rowKey(entry.sessionID, entry.messageID);
      revisions.push({
        messageID: entry.messageID,
        sessionID: entry.sessionID,
        type: "assistant",
        createdAtMs: entry.createdAtMs,
        updatedAtMs: db.updatedAt.get(key) ?? null,
        completedAtMs: entry.completedAtMs,
        ...db.revisionOverrides.get(entry.messageID),
      });
    }
    revisions.push(...db.extraRevisions);
    let filtered = revisions;
    if (sessionIds !== undefined) {
      const set = new Set(sessionIds);
      filtered = filtered.filter((revision) => set.has(revision.sessionID));
    }
    if (messageIds !== undefined) {
      const set = new Set(messageIds);
      filtered = filtered.filter((revision) => set.has(revision.messageID));
    }
    return filtered;
  };

  function completedRows(params: {
    completedSinceMs?: number;
    completedUntilMs?: number;
    completedAtTimes?: readonly number[];
    sessionIDs?: readonly string[];
    messageIDs?: readonly string[];
  }): OpenCodeRawAssistantRow[] {
    let rows = [...db.rows];
    if (params.messageIDs) {
      const ids = new Set(params.messageIDs);
      rows = rows.filter((entry) => ids.has(entry.messageID));
    }
    if (params.sessionIDs) {
      const ids = new Set(params.sessionIDs);
      rows = rows.filter((entry) => ids.has(entry.sessionID));
    }
    const atTimes = params.completedAtTimes;
    if (atTimes) {
      const times = new Set(atTimes);
      rows = rows.filter((entry) => times.has(entry.completedAtMs));
    }
    const sinceMs = params.completedSinceMs;
    if (sinceMs !== undefined) {
      rows = rows.filter((entry) => entry.completedAtMs >= sinceMs);
    }
    const untilMs = params.completedUntilMs;
    if (untilMs !== undefined) {
      rows = rows.filter((entry) => entry.completedAtMs <= untilMs);
    }
    rows.sort(
      (a, b) => a.completedAtMs - b.completedAtMs || a.messageID.localeCompare(b.messageID),
    );
    return rows.map((entry) => ({
      ...entry,
      ...(db.updatedAtAvailable
        ? { updatedAtMs: db.updatedAt.get(rowKey(entry.sessionID, entry.messageID)) ?? null }
        : {}),
    }));
  }

  return {
    async withSnapshot<T>(
      read: (snapshot: OpenCodeStorageSnapshot) => T | Promise<T>,
    ): Promise<OpenCodeStorageSnapshotResult<T>> {
      calls.push({ method: "withSnapshot" });
      if (db.status !== "ok") return { status: db.status };
      const snapshot: OpenCodeStorageSnapshot = {
        dbPath: db.identity.dbPath,
        identity: structuredClone(db.identity),
        readAllSessionsIndex: () => {
          calls.push({ method: "loadSessions" });
          return structuredClone(db.sessions);
        },
        readProjectsIndex: () => {
          calls.push({ method: "loadProjects" });
          return structuredClone(db.projects);
        },
        readCompletedAssistantRows: (params = {}) => {
          calls.push({
            method: "loadCompletedRows",
            params: {
              ...(params.messageIDs === undefined ? {} : { messageIDs: [...params.messageIDs] }),
              ...(params.sessionIDs === undefined ? {} : { sessionIDs: [...params.sessionIDs] }),
              ...(params.completedSinceMs === undefined
                ? {}
                : { sinceMs: params.completedSinceMs }),
              ...(params.completedUntilMs === undefined
                ? {}
                : { untilMs: params.completedUntilMs }),
              ...(params.completedAtTimes === undefined
                ? {}
                : { completedAtTimes: [...params.completedAtTimes] }),
            },
          });
          return completedRows(params);
        },
        readCompactionMarkers: (params = {}) => {
          calls.push({
            method: "loadCompactions",
            params: { sessionIds: [...(params.sessionIDs ?? [])] },
          });
          const ids = new Set(params.sessionIDs ?? []);
          return db.compactions.filter((marker) => ids.has(marker.sessionId));
        },
        readMessageRevisions: (params = {}) => {
          calls.push({
            method: "loadRevisions",
            params: {
              ...(params.sessionIDs === undefined ? {} : { sessionIDs: params.sessionIDs }),
              ...(params.messageIDs === undefined ? {} : { messageIDs: params.messageIDs }),
              ...(params.updatedSinceMs === undefined
                ? {}
                : { updatedSinceMs: params.updatedSinceMs }),
            },
          });
          let revisions = revisionsFor(params.sessionIDs, params.messageIDs);
          const updatedSinceMs = params.updatedSinceMs;
          if (db.updatedAtAvailable && updatedSinceMs !== undefined) {
            revisions = revisions.filter(
              (revision) => revision.updatedAtMs === null || revision.updatedAtMs >= updatedSinceMs,
            );
          }
          return {
            available: true,
            updatedAtAvailable: db.updatedAtAvailable,
            completedAtAvailable: true,
            revisions,
          };
        },
        readMessageRevisionFrontier: () => {
          calls.push({ method: "loadRevisionFrontier" });
          if (!db.updatedAtAvailable) {
            return { available: true, updatedAtAvailable: false, maxUpdatedAtMs: null };
          }
          let maxUpdatedAtMs: number | null = null;
          for (const revision of revisionsFor()) {
            if (
              revision.updatedAtMs !== null &&
              (maxUpdatedAtMs === null || revision.updatedAtMs > maxUpdatedAtMs)
            ) {
              maxUpdatedAtMs = revision.updatedAtMs;
            }
          }
          return { available: true, updatedAtAvailable: true, maxUpdatedAtMs };
        },
      };
      return { status: "ok", value: await read(snapshot) };
    },
  };
}

interface Harness {
  engine: ReturnType<typeof createAnalyticsEngine>;
  calls: ReaderCall[];
  db: FakeDb;
  setNow(value: number): void;
  savedStates: AnalyticsState[];
  savedPresentations: WarmAnalyticsPresentation[];
  generations: number[];
}

function harness(
  db: FakeDb,
  overrides: {
    now?: number;
    reader?: AnalyticsReader;
    loadSnapshot?: () => Promise<AnalyticsState | undefined>;
    saveSnapshot?: (path: string, state: AnalyticsState, savedAtMs: number) => Promise<boolean>;
    loadPresentation?: () => Promise<WarmAnalyticsPresentation | undefined>;
    savePresentation?: (path: string, state: AnalyticsState, savedAtMs: number) => Promise<boolean>;
    fullRepairIntervalMs?: number;
  } = {},
): Harness {
  const calls: ReaderCall[] = [];
  const reader = overrides.reader ?? createFakeReader(db, calls);
  let nowMs = overrides.now ?? NOW;
  const savedStates: AnalyticsState[] = [];
  const savedPresentations: WarmAnalyticsPresentation[] = [];
  const generations: number[] = [];
  const engine = createAnalyticsEngine({
    reader,
    now: () => nowMs,
    refreshIntervalMs: INTERVAL,
    ...(overrides.fullRepairIntervalMs === undefined
      ? {}
      : { fullRepairIntervalMs: overrides.fullRepairIntervalMs }),
    snapshotPath: "memory.json",
    onGeneration: (value) => generations.push(value),
    loadSnapshot: overrides.loadSnapshot ?? (async () => undefined),
    saveSnapshot:
      overrides.saveSnapshot ??
      (async (_path, state) => {
        savedStates.push(cloneState(state));
        return true;
      }),
    loadPresentation: overrides.loadPresentation ?? (async () => undefined),
    savePresentation:
      overrides.savePresentation ??
      (async (_path, state, savedAtMs) => {
        if (state.presentation) {
          savedPresentations.push({
            ...structuredClone(state.presentation),
            ...(state.sourceIdentity
              ? { sourceIdentity: structuredClone(state.sourceIdentity) }
              : {}),
            savedAtMs,
            frontierAtMs: state.frontierAtMs,
            ...(state.extent ? { coverage: { ...state.extent } } : {}),
          });
        }
        return true;
      }),
  });
  return {
    engine,
    calls,
    db,
    setNow: (value) => {
      nowMs = value;
    },
    savedStates,
    savedPresentations,
    generations,
  };
}

const sessionAgentCases = ["session-authority", undefined];
it.each(
  sessionAgentCases,
)("keeps node agents through cold, sidecar and compact reload (%s)", async (sessionAgent) => {
  const db = baseDb();
  db.sessions.ses_root!.agent = sessionAgent;
  const expectedRootAgent = sessionAgent ?? "message-fallback";
  db.rows.find((entry) => entry.messageID === "msg_b")!.agent = "message-fallback";
  db.rows.push(row("ses_child", "msg_child", NOW - 1000, { input: 7 }, { agent: "child-agent" }));
  const first = harness(db);
  const cold = await first.engine.session("ses_root");
  expect(cold.nodes.map((node) => node.agent)).toEqual([expectedRootAgent, "child-agent"]);
  expect((await first.engine.session("ses_child")).nodes[0]?.agent).toBe("child-agent");
  await first.engine.close();
  const persisted = decodeAnalyticsState(
    JSON.parse(JSON.stringify(encodeAnalyticsState(first.savedStates.at(-1)!, NOW))),
  )!;
  const warm = decodeAnalyticsPresentation(
    JSON.parse(
      JSON.stringify(
        encodeAnalyticsPresentation(
          { ...persisted, presentation: first.savedPresentations.at(-1)! },
          NOW,
        ),
      ),
    ),
  )!;
  const second = harness(db, {
    loadSnapshot: async () => structuredClone(persisted),
    loadPresentation: async () => structuredClone(warm),
  });
  const cached = await second.engine.session("ses_root");
  expect(cached.nodes.map((node) => node.agent)).toEqual([expectedRootAgent, "child-agent"]);
  expect(cached.treeTotals).toEqual(cold.treeTotals);
  await second.engine.close();
  const third = harness(db, { loadSnapshot: async () => structuredClone(persisted) });
  const rebuilt = await third.engine.session("ses_root");
  expect(rebuilt.nodes.map((node) => node.agent)).toEqual([expectedRootAgent, "child-agent"]);
  expect(rebuilt.treeTotals).toEqual(cold.treeTotals);
  // Agent-only metadata edits must invalidate DTOs even without timestamp churn.
  db.sessions.ses_root!.agent = "new-authority";
  third.setNow(NOW + INTERVAL + 1);
  await third.engine.refresh();
  expect((await third.engine.session("ses_root")).nodes[0]?.agent).toBe("new-authority");
  await third.engine.close();
});

class TrackingMap<K, V> extends Map<K, V> {
  valuesReads = 0;
  keysReads = 0;
  entriesReads = 0;
  iteratorReads = 0;

  reset(): void {
    this.valuesReads = 0;
    this.keysReads = 0;
    this.entriesReads = 0;
    this.iteratorReads = 0;
  }

  override values() {
    this.valuesReads += 1;
    return super.values();
  }

  override keys() {
    this.keysReads += 1;
    return super.keys();
  }

  override entries() {
    this.entriesReads += 1;
    return super.entries();
  }

  override [Symbol.iterator]() {
    this.iteratorReads += 1;
    return super[Symbol.iterator]();
  }
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Produces a persisted index with 705 tokens and an older warm DTO with 700,
 * both from the same synthetic source identity. Tests can then change/remove
 * the sidecar token to exercise restart reattachment.
 */
async function warmRestartFixture(): Promise<{
  db: FakeDb;
  persisted: AnalyticsState;
  warm: WarmAnalyticsPresentation;
}> {
  const db = baseDb();
  const first = harness(db);
  await first.engine.home("24h");
  await flushAsync();
  const presentation = first.savedPresentations[first.savedPresentations.length - 1];
  if (!presentation) throw new Error("expected a warm presentation");
  const warm: WarmAnalyticsPresentation = {
    ...structuredClone(presentation),
    sourceIdentity: db.identity,
  };
  db.rows.push(row("ses_root", "msg_restart", NOW - 30 * 60_000, { input: 5 }));
  // Make the persisted index newer than the sidecar.
  first.setNow(NOW + 60_000);
  await first.engine.refresh();
  await flushAsync();
  const saved = first.savedStates[first.savedStates.length - 1];
  if (!saved) throw new Error("expected a persisted state");
  const persisted = cloneState(saved);
  await first.engine.close();
  return { db, persisted, warm };
}

function cloneState(state: AnalyticsState): AnalyticsState {
  const encoded = encodeAnalyticsState(state, state.frontierAtMs);
  const decoded = decodeAnalyticsState(JSON.parse(JSON.stringify(encoded)) as unknown);
  if (!decoded) throw new Error("state clone failed");
  return decoded;
}

function datasetOf(db: FakeDb): UsageAnalyticsDataset {
  return {
    sessions: structuredClone(db.sessions),
    projects: structuredClone(db.projects),
    messages: [...db.rows],
    compactions: [...db.compactions],
  };
}

function homeFromDataset(db: FakeDb, range: "24h" | "7d" | "30d"): HomeSnapshot {
  const evaluation = analytics(datasetOf(db)).home(range, NOW);
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: [], polledAtMs: NOW },
    usage: { ...evaluation.usage, stale: false },
    projects: evaluation.projects,
  };
}

function sidecarSession(sessionId: string): SessionSnapshot {
  const tokens = {
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
  return {
    focusSessionId: sessionId,
    timeZone: HOST_ZONE,
    projectId: "p1",
    projectName: "Project One",
    breadcrumbs: [{ sessionId, title: sessionId, isFocus: true }],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...tokens, stepCount: 0 },
    treeTotals: tokens,
    stepSemantics: "test",
  };
}

function fullReads(calls: ReaderCall[], afterIndex = 0): ReaderCall[] {
  return calls
    .slice(afterIndex)
    .filter(
      (call) =>
        call.method === "loadCompletedRows" &&
        call.params?.messageIDs === undefined &&
        call.params?.sessionIDs === undefined &&
        call.params?.completedAtTimes === undefined,
    );
}

describe("analytics engine: rollup views and coverage", () => {
  it("returns an empty-provider HomeSnapshot and exact bucket sums", async () => {
    const db = baseDb();
    db.rows.push(row("ses_root", "msg_edge", NOW - DAY, { input: 1_000 }));
    db.rows.push(row("ses_root", "msg_before", NOW - DAY - 1, { input: 9_999 }));
    const { engine, calls } = harness(db);

    const home = await engine.home("24h");

    expect(home.providers).toEqual({ cards: [], enabledProviders: [], polledAtMs: NOW });
    expect(home.range).toBe("24h");
    expect(home.usage.totals.input).toBe(1_700);
    expect(home.usage.stepCount).toBe(4);
    const bucketSum = home.usage.buckets.reduce((total, bucket) => total + bucket.tokens.input, 0);
    expect(bucketSum).toBe(home.usage.totals.input);
    // One source transaction per refresh; all reads are inside it.
    expect(calls.filter((call) => call.method === "withSnapshot")).toHaveLength(1);
  });

  it("does not reset or reread everything when only size/mtime change", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;

    db.identity = identity({ sizeBytes: 999_999, mtimeMs: 999_999 });
    const target = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!target) throw new Error("msg_o missing");
    target.tokens.input = 401;
    db.updatedAt.set(rowKey("ses_other", "msg_o"), NOW);
    await engine.refresh();
    const home = await engine.home("24h");

    expect(home.usage.totals.input).toBe(701);
    expect(fullReads(calls, baseline)).toHaveLength(0);
    const idFetch = calls
      .slice(baseline)
      .find((call) => call.method === "loadCompletedRows" && call.params?.messageIDs);
    expect(idFetch?.params?.messageIDs).toEqual(["msg_o"]);
  });

  it("extends historical extent without rereading covered parts", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);

    await engine.home("24h");
    const afterFirst = calls.length;
    await engine.home("7d");

    const reads = calls
      .slice(afterFirst)
      .filter(
        (call) =>
          call.method === "loadCompletedRows" &&
          call.params?.messageIDs === undefined &&
          call.params?.sessionIDs === undefined,
      );
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params).toMatchObject({ sinceMs: NOW - 7 * DAY, untilMs: NOW - DAY });
  });

  it("does not reread covered bounded ranges after a lifetime extent", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db);

    await engine.home("lifetime");
    const baseline = calls.length;
    // Force real refreshes (not just DTO derivation) for bounded ranges while
    // the stored extent already reaches the beginning of history.
    setNow(NOW + INTERVAL + 1);
    await engine.home("24h");
    await engine.home("7d");
    await engine.home("30d");
    await engine.refresh();

    expect(
      calls.slice(baseline).filter((call) => call.method === "loadCompletedRows"),
    ).toHaveLength(0);
  });

  it("reads lifetime only when requested", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    const home = await engine.home("lifetime");
    expect(home.usage.totals.input).toBe(1_500);
    const reads = calls.filter((call) => call.method === "loadCompletedRows");
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params).not.toHaveProperty("sinceMs");
  });

  it("matches createUsageAnalytics exactly on a mixed dataset", async () => {
    const db = baseDb();
    db.rows.push(row("ses_other", "msg_tie", NOW - HOUR, { input: 7 }));
    const { engine } = harness(db);

    await engine.home("7d");
    const expectedHome = analytics(datasetOf(db)).home("7d", NOW);
    const home = await engine.home("7d");
    expect(home.usage.totals).toEqual(expectedHome.usage.totals);
    expect(home.usage.buckets.map((bucket) => bucket.tokens)).toEqual(
      expectedHome.usage.buckets.map((bucket) => bucket.tokens),
    );
    expect(home.projects).toEqual(expectedHome.projects);

    const expectedProject = analytics(datasetOf(db)).project("p1", "7d", NOW);
    const project = await engine.project("p1", "7d");
    expect(project.totals).toEqual(expectedProject.totals);
    expect(project.roots).toEqual(expectedProject.roots);
    expect(project.usage.totals).toEqual(expectedProject.usage.totals);

    const expectedSession = analytics(datasetOf(db)).session("ses_root");
    const sessionSnapshot = await engine.session("ses_root");
    expect(sessionSnapshot).toEqual(expectedSession);
  });
});

describe("analytics engine: revision reconciliation", () => {
  it("detects edits, insertions, and deletions without session metadata changes", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    await engine.home("24h");

    const edited = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!edited) throw new Error("msg_b missing");
    edited.tokens.input = 500;
    db.updatedAt.set(rowKey("ses_root", "msg_b"), NOW);
    db.rows.push(row("ses_root", "msg_new", NOW - 30 * 60_000, { input: 50 }));
    await engine.refresh();
    const afterEdit = await engine.home("24h");
    expect(afterEdit.usage.totals.input).toBe(1_050);

    // Deletions have no timestamp tombstone in the source; the approved policy
    // only removes them during the rare full reconciliation.
    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_b");
    setNow(NOW + 1);
    await engine.refresh();
    const afterDelete = await engine.home("24h");
    expect(afterDelete.usage.stepCount).toBe(3);
  });

  it("matches a fresh projection after mixed new, edited, deleted, and unchanged rows", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    await engine.home("24h");
    await engine.project("p1", "24h");
    await engine.session("ses_root");

    const edited = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!edited) throw new Error("msg_b missing");
    edited.tokens.input = 500;
    db.updatedAt.set(rowKey("ses_root", "msg_b"), NOW);
    const added = row("ses_root", "msg_new", NOW - 30 * 60_000, { input: 50 });
    db.rows.push(added);
    db.updatedAt.set(rowKey(added.sessionID, added.messageID), added.completedAtMs);
    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_o");

    setNow(NOW + 1);
    await engine.refresh();

    const expected = analytics(datasetOf(db));
    expect((await engine.home("24h")).usage.totals).toEqual(
      expected.home("24h", NOW + 1).usage.totals,
    );
    expect((await engine.project("p1", "24h")).totals).toEqual(
      expected.project("p1", "24h", NOW + 1).totals,
    );
    expect(await engine.session("ses_root")).toEqual(expected.session("ses_root"));
    await engine.close();
  });

  it("fetches only changed message ids after an ordinary write (no full payload reread)", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;

    const rowToEdit = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!rowToEdit) throw new Error("msg_o missing");
    rowToEdit.tokens.input = 401;
    db.updatedAt.set(rowKey("ses_other", "msg_o"), NOW);
    await engine.refresh();
    await engine.home("24h");

    expect(fullReads(calls, baseline)).toHaveLength(0);
    const idFetches = calls
      .slice(baseline)
      .filter((call) => call.method === "loadCompletedRows" && call.params?.messageIDs);
    expect(idFetches).toHaveLength(1);
    expect(idFetches[0]?.params?.messageIDs).toEqual(["msg_o"]);
  });

  it("does not refetch bulk rows after a range extension", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    await engine.home("7d");
    const baseline = calls.length;
    await engine.refresh();
    const newCalls = calls.slice(baseline);
    expect(fullReads(calls, baseline)).toHaveLength(0);
    expect(
      newCalls.filter(
        (call) => call.method === "loadCompletedRows" && call.params?.messageIDs !== undefined,
      ),
    ).toHaveLength(0);
    await engine.close();
  });

  it("drops contributions when completion or type reverses", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    const before = await engine.home("24h");
    expect(before.usage.totals.input).toBe(700);

    // Both physical copies of the msg_a fingerprint become assistant-unfinished.
    db.revisionOverrides.set("msg_a", { type: "assistant", completedAtMs: null });
    db.revisionOverrides.set("msg_a_fork", { type: "assistant", completedAtMs: null });
    await engine.refresh();
    const afterUnfinished = await engine.home("24h");
    expect(afterUnfinished.usage.totals.input).toBe(600);
    expect(afterUnfinished.usage.stepCount).toBe(2);

    // The remaining msg_b row changes from assistant to a non-assistant type.
    db.revisionOverrides.set("msg_b", { type: "user" });
    await engine.refresh();
    const afterTypeChange = await engine.home("24h");
    expect(afterTypeChange.usage.totals.input).toBe(400);
    expect(afterTypeChange.usage.stepCount).toBe(1);
  });

  it("removes an old contribution when a changed id yields no replacement payload", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    await engine.home("24h");

    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_b");
    // The revision still reports a changed completion time, but the completed
    // payload reader yields no row for that id.
    db.extraRevisions.push({
      messageID: "msg_b",
      sessionID: "ses_root",
      type: "assistant",
      createdAtMs: NOW - HOUR,
      updatedAtMs: null,
      completedAtMs: NOW - 2 * HOUR,
    });
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.usage.totals.input).toBe(500);
    expect(after.usage.stepCount).toBe(2);
  });

  it("promotes the remaining fork copy when the owner is deleted", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    const before = await engine.home("24h");
    expect(before.usage.totals.input).toBe(700);

    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_a");
    setNow(NOW + 1);
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.usage.totals.input).toBe(700);
    expect(after.usage.stepCount).toBe(3);
  });

  it("full repair rereads cached owners outside the global extent after restart", async () => {
    const db = baseDb();
    const oldAt = NOW - 2 * DAY;
    db.sessions.ses_old_a = session("ses_old_a", "p1");
    db.sessions.ses_old_b = session("ses_old_b", "p1");
    const owner = row("ses_old_a", "msg_old_owner", oldAt, { input: 100 });
    const fork = row("ses_old_b", "msg_old_fork", oldAt, { input: 100 });
    db.rows.push(owner, fork);
    db.updatedAt.set(rowKey("ses_old_a", "msg_old_owner"), oldAt);
    db.updatedAt.set(rowKey("ses_old_b", "msg_old_fork"), oldAt);

    const first = harness(db);
    await first.engine.home("24h");
    await first.engine.project("p1", "7d");
    await flushAsync();
    const saved = first.savedStates[first.savedStates.length - 1];
    if (!saved) throw new Error("expected a persisted index");
    expect(saved.occurrences.has("msg_old_owner")).toBe(true);
    expect(saved.occurrences.has("msg_old_fork")).toBe(true);
    const persisted = cloneState(saved);
    await first.engine.close();

    owner.tokens.input = 999;
    // Deliberately leave the source timestamp unchanged: only a payload read
    // can see this edit.
    const states: AnalyticsState[] = [];
    const repairCalls: ReaderCall[] = [];
    const second = createAnalyticsEngine({
      reader: createFakeReader(db, repairCalls),
      now: () => NOW + 1,
      refreshIntervalMs: INTERVAL,
      fullRepairIntervalMs: 1,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state) => {
        states.push(cloneState(state));
        return true;
      },
      savePresentation: async () => true,
    });

    await second.home("24h");
    await second.refresh();
    await flushAsync();
    const repaired = states[states.length - 1];
    const ownerOccurrence = repaired?.occurrences.get("msg_old_owner");
    const forkOccurrence = repaired?.occurrences.get("msg_old_fork");
    if (!repaired || !ownerOccurrence || !forkOccurrence) {
      throw new Error("expected repaired occurrences");
    }
    expect(
      repairCalls.some(
        (call) =>
          call.method === "loadCompletedRows" &&
          call.params?.messageIDs?.includes("msg_old_owner") === true,
      ),
    ).toBe(true);
    expect(repaired.fingerprints[ownerOccurrence.fingerprintIndex]?.[4]).toBe(999);
    expect(repaired.fingerprints[forkOccurrence.fingerprintIndex]?.[4]).toBe(100);
    await second.close();
  });

  it("repairs cached scope-only owners on the first global baseline", async () => {
    const db = baseDb();
    const oldAt = NOW - 10 * DAY;
    db.sessions.ses_old_a = session("ses_old_a", "p1");
    db.sessions.ses_old_b = session("ses_old_b", "p1");
    const owner = row("ses_old_a", "msg_baseline_owner", oldAt, { input: 100 });
    const fork = row("ses_old_b", "msg_baseline_fork", oldAt, { input: 100 });
    db.rows.push(owner, fork);
    db.updatedAt.set(rowKey("ses_old_a", "msg_baseline_owner"), oldAt);
    db.updatedAt.set(rowKey("ses_old_b", "msg_baseline_fork"), oldAt);

    const first = harness(db);
    await first.engine.project("p1", "lifetime");
    await flushAsync();
    const saved = first.savedStates[first.savedStates.length - 1];
    if (!saved) throw new Error("expected a scope-only compact snapshot");
    expect(saved.extent).toBeUndefined();
    expect(saved.occurrences.has("msg_baseline_owner")).toBe(true);
    const persisted = cloneState(saved);
    await first.engine.close();

    owner.tokens.input = 999;
    // The source timestamp deliberately stays unchanged; only the full cached
    // payload read can observe the edit.
    const states: AnalyticsState[] = [];
    const calls: ReaderCall[] = [];
    const second = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 1,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state) => {
        states.push(cloneState(state));
        return true;
      },
      savePresentation: async () => true,
    });

    await second.home("7d");
    await flushAsync();
    expect(
      calls.some(
        (call) =>
          call.method === "loadCompletedRows" &&
          call.params?.messageIDs?.includes("msg_baseline_owner") === true,
      ),
    ).toBe(true);
    const repaired = states[states.length - 1];
    const ownerOccurrence = repaired?.occurrences.get("msg_baseline_owner");
    const forkOccurrence = repaired?.occurrences.get("msg_baseline_fork");
    if (!repaired || !ownerOccurrence || !forkOccurrence) {
      throw new Error("expected repaired cached owners");
    }
    expect(repaired.fingerprints[ownerOccurrence.fingerprintIndex]?.[4]).toBe(999);
    expect(repaired.fingerprints[forkOccurrence.fingerprintIndex]?.[4]).toBe(100);

    const expected = analytics(datasetOf(db)).project("p1", "lifetime", NOW + 1);
    const project = await second.project("p1", "lifetime");
    expect(project.totals).toEqual(expected.totals);
    await second.close();
  });

  it("treats same-timestamp arrivals deterministically", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    await engine.home("24h");
    db.rows.push(row("ses_other", "msg_same", NOW - HOUR, { input: 11 }));
    await engine.refresh();
    const forward = await engine.home("24h");
    expect(forward.usage.totals.input).toBe(711);
  });

  it("keeps price status exact when only priced contributions are removed", async () => {
    const db = baseDb();
    db.rows = [
      row("ses_root", "priced", NOW - 2 * HOUR, { input: 10 }),
      row(
        "ses_root",
        "unpriced",
        NOW - 2 * HOUR,
        { input: 20 },
        {
          providerID: "no-such-provider",
          modelID: "no-such-model",
        },
      ),
      row("ses_root", "priced_2", NOW - HOUR, { input: 30 }),
    ];
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    const first = await engine.home("24h");
    expect(first.usage.totals.apiEquivalentCostUsd).not.toBeNull();

    db.rows = db.rows.filter((entry) => entry.messageID !== "priced_2");
    setNow(NOW + 1);
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.usage.totals.unpricedTokens + after.usage.totals.unknownTokens).toBeGreaterThan(0);
    expect(after.usage.totals.apiEquivalentCostUsd).not.toBeNull();

    db.rows = db.rows.filter((entry) => entry.messageID !== "priced");
    setNow(NOW + 2);
    await engine.refresh();
    const onlyUnpriced = await engine.home("24h");
    expect(onlyUnpriced.usage.totals.apiEquivalentCostUsd).toBeNull();
    expect(
      onlyUnpriced.usage.totals.unpricedTokens + onlyUnpriced.usage.totals.unknownTokens,
    ).toBeGreaterThan(0);
    expect(
      onlyUnpriced.usage.buckets.every((bucket) => bucket.tokens.apiEquivalentCostUsd === null),
    ).toBe(true);
  });

  it("clears empty hour buckets after all steps are deleted", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    const before = await engine.home("24h");
    expect(before.usage.buckets.some((bucket) => bucket.tokens.input > 0)).toBe(true);
    db.rows = [];
    setNow(NOW + 1);
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.usage.totals.total).toBe(0);
    expect(after.usage.stepCount).toBe(0);
    expect(after.usage.buckets.every((bucket) => bucket.tokens.total === 0)).toBe(true);
  });

  it("resets coverage only when the stable source identity changes", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");

    db.rows = [row("ses_root", "msg_replaced", NOW - HOUR, { input: 42 })];
    db.identity = identity({ inode: "999" });
    const afterReplaceStart = calls.length;
    await engine.refresh();
    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(42);
    expect(
      calls.slice(afterReplaceStart).filter((call) => call.method === "loadCompletedRows").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("retains the last good snapshot when the source is missing", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    const before = await engine.home("24h");

    db.status = "missing";
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.stale).toBe(true);
    expect(after.usage.totals).toEqual(before.usage.totals);
    // A failed refresh cannot advance the certified sync epoch.
    expect(after.usage.window).toEqual(before.usage.window);
  });

  it("retains the last good snapshot when the source is unreadable", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    const before = await engine.home("24h");

    db.status = "unreadable";
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.stale).toBe(true);
    expect(after.usage.totals).toEqual(before.usage.totals);
  });

  it("treats a stable identity as one transaction even if size/mtime move", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;
    db.identity = identity({ sizeBytes: 1, mtimeMs: 1 });
    await engine.refresh();
    expect(calls.slice(baseline).filter((call) => call.method === "withSnapshot")).toHaveLength(1);
  });

  it("establishes the first baseline cursor from the source frontier, not wall time", async () => {
    const db = baseDb();
    const { engine, calls, savedStates } = harness(db);

    await engine.home("24h");
    await flushAsync();

    expect(calls.some((call) => call.method === "loadRevisionFrontier")).toBe(true);
    // A cold empty index does not need a lifetime revision projection.
    expect(calls.some((call) => call.method === "loadRevisions")).toBe(false);
    const saved = savedStates[savedStates.length - 1];
    expect(saved?.sourceCursorAtMs).toBe(NOW - HOUR);
    expect(saved?.sourceCursorAtMs).not.toBe(NOW);
    expect(saved?.lastFullRepairAtMs).toBe(NOW);
  });

  it("uses only the inclusive cursor-overlap delta on a no-change refresh", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;

    await engine.refresh();

    const revisionReads = calls.slice(baseline).filter((call) => call.method === "loadRevisions");
    expect(revisionReads).toHaveLength(1);
    expect(revisionReads[0]?.params?.updatedSinceMs).toBe(
      NOW - HOUR - ANALYTICS_SOURCE_CURSOR_OVERLAP_MS,
    );
    expect(fullReads(calls, baseline)).toHaveLength(0);
    expect(calls.slice(baseline).some((call) => call.method === "loadRevisionFrontier")).toBe(
      false,
    );
  });

  it("does not sweep stored rows that a partial delta did not mention", async () => {
    const db = baseDb();
    const { engine, savedStates } = harness(db);
    await engine.home("lifetime");
    await flushAsync();
    const before = savedStates[savedStates.length - 1];
    if (!before) throw new Error("expected baseline state");

    await engine.refresh();
    await flushAsync();

    const after = savedStates[savedStates.length - 1];
    expect(after?.occurrences.size).toBe(before.occurrences.size);
    expect(after?.occurrences.has("msg_old")).toBe(true);
    expect(after?.sourceCursorAtMs).toBe(before.sourceCursorAtMs);
  });

  it("conservatively refetches eligible null-timestamp payloads on a delta", async () => {
    const db = baseDb();
    db.rows.push(row("ses_root", "msg_null", NOW - 30 * 60_000, { input: 10 }));
    db.updatedAt.set(rowKey("ses_root", "msg_null"), null);
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;

    const target = db.rows.find((entry) => entry.messageID === "msg_null");
    if (!target) throw new Error("msg_null missing");
    target.tokens.input = 60;
    await engine.refresh();

    const changed = calls
      .slice(baseline)
      .filter((call) => call.method === "loadCompletedRows" && call.params?.messageIDs)
      .flatMap((call) => call.params?.messageIDs as string[]);
    expect(changed).toContain("msg_null");
    expect((await engine.home("24h")).usage.totals.input).toBe(760);
  });

  it("replays new rows with the cursor timestamp and lexically earlier ids", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    await engine.home("24h");

    db.rows.push(row("ses_root", "msg_0", NOW - HOUR, { input: 33 }));
    db.updatedAt.set(rowKey("ses_root", "msg_0"), NOW - HOUR);
    await engine.refresh();

    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(733);
    expect(home.usage.stepCount).toBe(4);
  });

  it("caps the cursor at wall time for future rows and applies them when eligible", async () => {
    const db = baseDb();
    const { engine, savedStates, setNow } = harness(db);
    await engine.home("24h");

    db.rows.push(row("ses_root", "msg_future", NOW + DAY, { input: 50 }));
    db.updatedAt.set(rowKey("ses_root", "msg_future"), NOW + DAY);
    await engine.refresh();
    await flushAsync();
    let saved = savedStates[savedStates.length - 1];
    expect(saved?.sourceCursorAtMs).toBe(NOW);
    expect(saved?.sourceCursorAtMs).toBeLessThanOrEqual(NOW);
    expect((await engine.home("24h")).usage.totals.input).toBe(700);

    setNow(NOW + DAY + 1);
    await engine.refresh();
    const futureHome = await engine.home("24h");
    expect(futureHome.usage.totals.input).toBe(50);
    await flushAsync();
    saved = savedStates[savedStates.length - 1];
    expect(saved?.sourceCursorAtMs).toBe(NOW + DAY);
  });

  it("repairs deletions and unchanged-timestamp edits only on the persisted 7-day cadence", async () => {
    const db = baseDb();
    const { engine, calls, savedStates, setNow } = harness(db);
    await engine.home("lifetime");
    await flushAsync();
    const baseline = calls.length;

    // Backdate both changes to the already-seen source timestamp: the delta
    // cannot distinguish them, so only the rare payload repair can.
    const edited = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!edited) throw new Error("msg_o missing");
    edited.tokens.input = 401;
    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_b");
    await engine.refresh();
    const beforeRepair = await engine.home("lifetime");
    expect(beforeRepair.usage.totals.input).toBe(1_500);

    setNow(NOW + ANALYTICS_FULL_REPAIR_INTERVAL_MS + 1);
    await engine.refresh();
    const repaired = await engine.home("lifetime");
    expect(repaired.usage.totals.input).toBe(1_301);
    expect(repaired.usage.stepCount).toBe(3);

    const repairReads = calls.slice(baseline).filter((call) => call.method === "loadRevisions");
    expect(repairReads.some((call) => call.params?.updatedSinceMs === undefined)).toBe(true);
    await flushAsync();
    expect(savedStates[savedStates.length - 1]?.lastFullRepairAtMs).toBe(
      NOW + ANALYTICS_FULL_REPAIR_INTERVAL_MS + 1,
    );
  });

  it("keeps contributions and the cursor unchanged when the source is unavailable", async () => {
    const db = baseDb();
    const { engine, savedStates } = harness(db);
    await engine.home("24h");
    await flushAsync();
    const before = savedStates[savedStates.length - 1];
    if (!before) throw new Error("expected baseline state");
    const writesBefore = savedStates.length;

    const target = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!target) throw new Error("msg_o missing");
    target.tokens.input = 999;
    db.updatedAt.set(rowKey("ses_other", "msg_o"), NOW);
    db.status = "unreadable";
    await engine.refresh();

    expect(savedStates.length).toBe(writesBefore);
    expect(savedStates[savedStates.length - 1]?.sourceCursorAtMs).toBe(before.sourceCursorAtMs);
    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(700);
    expect(home.stale).toBe(true);
  });

  it("reconciles conservatively when the wall clock rolls back behind the cursor", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.home("lifetime");

    // msg_old already completed before the rolled-back wall clock, so it can
    // still appear in a lifetime view at that time.
    const target = db.rows.find((entry) => entry.messageID === "msg_old");
    if (!target) throw new Error("msg_old missing");
    target.tokens.input = 801;
    const rolledBack = NOW - 2 * HOUR;
    db.updatedAt.set(rowKey("ses_other", "msg_old"), rolledBack);
    setNow(rolledBack);
    await engine.refresh();

    const home = await engine.home("lifetime");
    expect(home.usage.totals.input).toBe(801);
  });

  it("does not let a scoped session read advance the global cursor or repair clock", async () => {
    const db = baseDb();
    const { engine, calls, savedStates, setNow } = harness(db);
    await engine.home("24h");
    await flushAsync();
    const before = savedStates[savedStates.length - 1];
    if (!before) throw new Error("expected baseline state");
    const baseline = calls.length;

    setNow(NOW + INTERVAL + 1);
    await engine.session("ses_root");
    await flushAsync();

    const after = savedStates[savedStates.length - 1];
    expect(after?.sourceCursorAtMs).toBe(before.sourceCursorAtMs);
    expect(after?.lastFullRepairAtMs).toBe(before.lastFullRepairAtMs);
    expect(after?.frontierAtMs).toBe(before.frontierAtMs);
    for (const call of calls.slice(baseline).filter((entry) => entry.method === "loadRevisions")) {
      expect(call.params?.sessionIDs).toBeDefined();
    }
  });

  it("exposes worker stats and a best-effort gc hook", async () => {
    const { engine } = harness(baseDb());
    const stats = await engine.stats();
    expect(stats.heapUsed).toBeGreaterThan(0);
    expect(stats.rss).toBeGreaterThan(0);
    expect(typeof (await engine.gc())).toBe("boolean");
  });
});

describe("analytics engine: scope reads", () => {
  it("scopes project-first reads to that project plus owner candidates", async () => {
    const db = baseDb();
    db.rows.push(row("ses_other", "msg!a", NOW - HOUR, { input: 100 }));
    const { engine, calls } = harness(db);

    const snapshot = await engine.project("p1", "7d");
    expect(snapshot.projectId).toBe("p1");
    expect(snapshot.totals.input).toBe(200);

    const reads = calls.filter((call) => call.method === "loadCompletedRows");
    expect(
      reads.every(
        (call) =>
          call.params?.sessionIDs !== undefined ||
          call.params?.messageIDs !== undefined ||
          call.params?.completedAtTimes !== undefined,
      ),
    ).toBe(true);
    const ownerFetch = reads.find((call) => call.params?.completedAtTimes !== undefined);
    expect(ownerFetch?.params?.completedAtTimes).toEqual([NOW - HOUR]);
  });

  it("discovers unseen multiplicity and lexically earlier external fork owners", async () => {
    const db = baseDb();
    db.rows = [
      row("ses_root", "msg_a1", NOW - HOUR, { input: 100 }),
      row("ses_root", "msg_a2", NOW - HOUR, { input: 100 }),
      row("ses_root", "msg_b", NOW - 30 * 60_000, { input: 200 }),
      row("ses_other", "msg!1", NOW - HOUR, { input: 100 }),
    ];
    for (const entry of db.rows) {
      db.updatedAt.set(rowKey(entry.sessionID, entry.messageID), NOW - HOUR);
    }

    const first = harness(db);
    const before = await first.engine.project("p1", "7d");
    // Only one external copy is known: the in-scope second copy is still owned.
    expect(before.totals.input).toBe(300);
    await flushAsync();
    const saved = first.savedStates[first.savedStates.length - 1];
    if (!saved) throw new Error("expected persisted scoped state");
    const persisted = cloneState(saved);
    await first.engine.close();

    db.rows.push(row("ses_other", "msg!2", NOW - HOUR, { input: 100 }));
    db.updatedAt.set(rowKey("ses_other", "msg!2"), NOW - HOUR);
    const calls: ReaderCall[] = [];
    const savedStates: AnalyticsState[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state) => {
        savedStates.push(cloneState(state));
        return true;
      },
      savePresentation: async () => true,
    });

    const after = await engine.project("p1", "7d");
    // The unseen second external copy must be discovered even though one
    // same-fingerprint external occurrence was already indexed.
    expect(after.totals.input).toBe(200);
    await flushAsync();
    const latest = savedStates[savedStates.length - 1];
    expect(latest?.occurrences.get("msg!2")?.updatedAtMs).toBe(NOW - HOUR);
    await engine.close();
  });

  it("scopes session detail to the tree and reads compactions only for the tree", async () => {
    const db = baseDb();
    db.compactions.push({
      sessionId: "ses_other",
      atMs: NOW - HOUR,
      messageId: "msg_other_compaction",
    });
    const { engine, calls } = harness(db);

    const snapshot = await engine.session("ses_root");
    expect(snapshot.nodes.map((node) => node.sessionId)).toEqual(["ses_root", "ses_child"]);
    expect(snapshot.compactionMarkers.map((marker) => marker.messageId)).toEqual(["msg_c"]);

    const compactionReads = calls.filter((call) => call.method === "loadCompactions");
    expect(compactionReads).toHaveLength(1);
    expect([...(compactionReads[0]?.params?.sessionIds as string[])].sort()).toEqual([
      "ses_child",
      "ses_root",
    ]);
    expect(
      calls.some(
        (call) =>
          call.method === "loadCompletedRows" &&
          call.params?.sessionIDs === undefined &&
          call.params?.messageIDs === undefined &&
          call.params?.completedAtTimes === undefined &&
          call.params?.sinceMs === undefined &&
          call.params?.untilMs === undefined,
      ),
    ).toBe(false);
    const ownerRead = calls.find(
      (call) => call.method === "loadCompletedRows" && call.params?.completedAtTimes !== undefined,
    );
    expect(ownerRead?.params?.completedAtTimes).toEqual([NOW - HOUR]);
    // Session detail reconciles only its own tree revisions, never a global one.
    for (const call of calls.filter((entry) => entry.method === "loadRevisions")) {
      expect(call.params?.sessionIDs).toBeDefined();
    }
  });

  it("invalidates cached session DTOs and notifies on compaction-only refreshes", async () => {
    const db = baseDb();
    const { engine, calls, generations } = harness(db);
    const initial = await engine.session("ses_root");
    expect(initial.compactionMarkers.map((marker) => marker.messageId)).toEqual(["msg_c"]);

    const afterInitial = generations.length;
    const baselineCalls = calls.length;
    db.compactions.push({
      sessionId: "ses_child",
      atMs: NOW - 2 * HOUR,
      messageId: "msg_compaction_new",
    });
    await engine.refresh();

    expect(generations.length).toBeGreaterThan(afterInitial);
    const globalHistoryReads = calls
      .slice(baselineCalls)
      .filter(
        (call) =>
          call.method === "loadCompletedRows" &&
          call.params?.sessionIDs === undefined &&
          call.params?.messageIDs === undefined &&
          call.params?.completedAtTimes === undefined,
      );
    expect(globalHistoryReads).toHaveLength(0);

    const updated = await engine.session("ses_root");
    // Markers annotate the focus session only; a child compaction still bumps the
    // revision but never leaks into the focus chart.
    expect(updated.compactionMarkers.map((marker) => marker.messageId).sort()).toEqual(["msg_c"]);

    const beforeRemoval = generations.length;
    db.compactions = db.compactions.filter((marker) => marker.messageId !== "msg_compaction_new");
    await engine.refresh();
    expect(generations.length).toBeGreaterThan(beforeRemoval);
    const removed = await engine.session("ses_root");
    expect(removed.compactionMarkers.map((marker) => marker.messageId)).toEqual(["msg_c"]);
    await engine.close();
  });

  it("uses the warm detail revision diff and fetches only changed tree ids", async () => {
    const db = baseDb();
    const target = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!target) throw new Error("msg_b missing");
    target.agent = "build";
    const { engine, calls, setNow } = harness(db);
    const first = await engine.session("ses_root");
    expect(first.steps.find((step) => step.messageId === "msg_b")?.agent).toBe("build");

    const baseline = calls.length;
    setNow(NOW + INTERVAL + 1);
    await engine.refresh();

    const warmRefresh = calls.slice(baseline);
    expect(
      warmRefresh.filter(
        (call) => call.method === "loadCompletedRows" && call.params?.sessionIDs !== undefined,
      ),
    ).toHaveLength(0);
    const ownerRead = warmRefresh.find(
      (call) => call.method === "loadCompletedRows" && call.params?.completedAtTimes !== undefined,
    );
    expect(ownerRead?.params?.completedAtTimes).toEqual([NOW - HOUR]);

    target.tokens.input = 222;
    db.updatedAt.set(rowKey("ses_root", "msg_b"), NOW + 1);
    const changedBaseline = calls.length;
    setNow(NOW + 2 * INTERVAL + 1);
    await engine.refresh();

    const changedRefresh = calls.slice(changedBaseline);
    const changedReads = changedRefresh.filter(
      (call) => call.method === "loadCompletedRows" && call.params?.messageIDs !== undefined,
    );
    expect(changedReads.flatMap((call) => call.params?.messageIDs as string[])).toEqual(["msg_b"]);
    expect(
      changedRefresh.filter(
        (call) => call.method === "loadCompletedRows" && call.params?.sessionIDs !== undefined,
      ),
    ).toHaveLength(0);

    const snapshot = await engine.session("ses_root");
    expect(snapshot.ownSummary.input).toBe(322);
    expect(snapshot.steps.find((step) => step.messageId === "msg_b")?.agent).toBe("build");
  });

  it("applies warm detail changes whose revision timestamp is null", async () => {
    const db = baseDb();
    db.updatedAt.set(rowKey("ses_root", "msg_b"), null);
    const { engine, setNow } = harness(db);
    await engine.session("ses_root");

    const target = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!target) throw new Error("msg_b missing");
    target.tokens.input = 222;
    setNow(NOW + INTERVAL + 1);
    await engine.refresh();

    const snapshot = await engine.session("ses_root");
    expect(snapshot.ownSummary.input).toBe(322);
    expect(snapshot.steps.find((step) => step.messageId === "msg_b")?.stack.input).toBe(222);
  });

  it("applies warm detail new rows whose revision timestamp is zero", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.session("ses_root");

    db.rows.push(row("ses_root", "msg_zero", NOW - 30 * 60_000, { input: 50 }));
    db.updatedAt.set(rowKey("ses_root", "msg_zero"), 0);
    setNow(NOW + INTERVAL + 1);
    await engine.refresh();

    const snapshot = await engine.session("ses_root");
    expect(snapshot.ownSummary.input).toBe(350);
    expect(snapshot.steps.some((step) => step.messageId === "msg_zero")).toBe(true);
  });

  it("reconciles known external fork owners on a scoped-only refresh", async () => {
    const scenarios: Array<[string, (db: FakeDb) => void]> = [
      [
        "token edit",
        (db) => {
          const external = db.rows.find((entry) => entry.messageID === "msg!a");
          if (!external) throw new Error("external missing");
          external.tokens.input = 101;
          db.updatedAt.set(rowKey("ses_other", "msg!a"), NOW);
        },
      ],
      [
        "completion move",
        (db) => {
          const external = db.rows.find((entry) => entry.messageID === "msg!a");
          if (!external) throw new Error("external missing");
          external.completedAtMs = NOW - 2 * HOUR;
          db.updatedAt.set(rowKey("ses_other", "msg!a"), NOW);
        },
      ],
      [
        "delete",
        (db) => {
          db.rows = db.rows.filter((entry) => entry.messageID !== "msg!a");
          db.updatedAt.delete(rowKey("ses_other", "msg!a"));
        },
      ],
      [
        "type change",
        (db) => {
          const external = db.rows.find((entry) => entry.messageID === "msg!a");
          if (!external) throw new Error("external missing");
          db.rows = db.rows.filter((entry) => entry.messageID !== "msg!a");
          db.updatedAt.delete(rowKey("ses_other", "msg!a"));
          db.extraRevisions.push({
            messageID: "msg!a",
            sessionID: "ses_other",
            type: "user",
            createdAtMs: external.createdAtMs,
            updatedAtMs: NOW,
            completedAtMs: null,
          });
        },
      ],
    ];

    for (const [label, mutate] of scenarios) {
      const db = baseDb();
      db.rows.push(row("ses_other", "msg!a", NOW - HOUR, { input: 100 }));
      db.updatedAt.set(rowKey("ses_other", "msg!a"), NOW - HOUR);
      const { engine, calls, setNow } = harness(db);
      const before = await engine.session("ses_root");
      expect(before.treeTotals.input, label).toBe(200);

      const baseline = calls.length;
      mutate(db);
      setNow(NOW + INTERVAL + 1);
      await engine.refresh();

      const after = await engine.session("ses_root");
      expect(after.treeTotals.input, label).toBe(300);
      const revisions = calls.slice(baseline).filter((call) => call.method === "loadRevisions");
      expect(
        revisions.every(
          (call) => call.params?.sessionIDs !== undefined || call.params?.messageIDs !== undefined,
        ),
        label,
      ).toBe(true);
      expect(
        revisions.some((call) =>
          (call.params?.messageIDs as string[] | undefined)?.includes("msg!a"),
        ),
        label,
      ).toBe(true);
      await engine.close();
    }
  });

  it("keeps repeated warm session detail off the global occurrence iterator", async () => {
    const db = baseDb();
    const first = harness(db);
    await first.engine.home("lifetime");
    await flushAsync();
    const saved = first.savedStates[first.savedStates.length - 1];
    if (!saved) throw new Error("expected a persisted state");
    const persisted = cloneState(saved);
    await first.engine.close();

    const tracked = new TrackingMap(persisted.occurrences);
    persisted.occurrences = tracked;
    const second = harness(db, {
      loadSnapshot: async () => persisted,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });
    await second.engine.session("ses_root");
    await flushAsync();
    tracked.reset();

    second.setNow(NOW + INTERVAL + 1);
    await second.engine.refresh();
    await second.engine.session("ses_root");

    expect(tracked.valuesReads).toBe(0);
    expect(tracked.keysReads).toBe(0);
    expect(tracked.entriesReads).toBe(0);
    expect(tracked.iteratorReads).toBe(0);
  });

  it("builds session DTO metadata only for the tree, fork owners, and ancestors", async () => {
    const db = baseDb();
    db.sessions.ses_unrelated = session("ses_unrelated", "p9");
    db.projects.p9 = { id: "p9", name: "Unrelated", directories: [], worktrees: [] };
    db.rows.push(row("ses_unrelated", "msg_unrelated", NOW - 3 * HOUR, { input: 999 }));
    const { engine } = harness(db);

    await engine.session("ses_root");
    const dataset = capturedDatasets.at(-1);
    expect(dataset).toBeDefined();
    expect(Object.keys(dataset?.sessions ?? {}).sort()).toEqual(["ses_child", "ses_root"]);
    expect(Object.keys(dataset?.projects ?? {})).toEqual(["p1"]);
    expect(dataset?.messages.some((entry) => entry.messageID === "msg_unrelated")).toBe(false);
  });

  it("keeps global fork multiplicity and breadcrumb ancestors in session detail", async () => {
    const db = baseDb();
    db.sessions.ses_grand = session("ses_grand", "p1", { parentID: "ses_child" });
    db.rows.push(row("ses_grand", "msg_grand", NOW - 30 * 60_000, { input: 77 }));
    db.rows.push(row("ses_other", "msg!a", NOW - HOUR, { input: 100 }));
    const { engine } = harness(db);

    const root = await engine.session("ses_root");
    expect(root).toEqual(analytics(datasetOf(db)).session("ses_root"));

    const grand = await engine.session("ses_grand");
    expect(grand.breadcrumbs.map((crumb) => crumb.sessionId)).toEqual([
      "ses_root",
      "ses_child",
      "ses_grand",
    ]);
    expect(grand).toEqual(analytics(datasetOf(db)).session("ses_grand"));
    await engine.close();
  });

  it("rebuilds indexes from a decoded persisted index before session detail", async () => {
    const { db, persisted } = await warmRestartFixture();
    const { engine } = harness(db, { loadSnapshot: async () => cloneState(persisted) });

    const snapshot = await engine.session("ses_root");

    expect(snapshot).toEqual(analytics(datasetOf(db)).session("ses_root"));
    await engine.close();
  });

  it("keeps insert, update, move, and removal exact across project and session views", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    await engine.home("24h");
    expect((await engine.project("p1", "24h")).totals.input).toBe(300);

    db.rows.push(row("ses_root", "msg_new", NOW - 30 * 60_000, { input: 50 }));
    db.updatedAt.set(rowKey("ses_root", "msg_new"), NOW - 30 * 60_000);
    await engine.refresh();
    expect((await engine.project("p1", "24h")).totals.input).toBe(350);

    const edited = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!edited) throw new Error("msg_b missing");
    edited.tokens.input = 250;
    db.updatedAt.set(rowKey("ses_root", "msg_b"), NOW);
    await engine.refresh();
    expect((await engine.project("p1", "24h")).totals.input).toBe(400);

    edited.sessionID = "ses_other";
    db.updatedAt.delete(rowKey("ses_root", "msg_b"));
    db.updatedAt.set(rowKey("ses_other", "msg_b"), NOW);
    await engine.refresh();
    expect((await engine.project("p1", "24h")).totals.input).toBe(150);

    const moved = await engine.session("ses_root");
    expect(moved).toEqual(analytics(datasetOf(db)).session("ses_root"));

    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_new");
    setNow(NOW + 1);
    await engine.refresh();
    const removed = await engine.session("ses_root");
    expect(removed).toEqual(analytics(datasetOf(db)).session("ses_root"));
    await engine.close();
  });

  it("keeps ownership exact when a global delta and scoped read share one transaction", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    await engine.home("24h");
    expect((await engine.project("p1", "24h")).totals.input).toBe(300);

    db.rows.push(row("ses_other", "msg!a", NOW - HOUR, { input: 100 }));
    db.updatedAt.set(rowKey("ses_other", "msg!a"), NOW);
    await engine.refresh();

    expect((await engine.project("p1", "24h")).totals.input).toBe(200);
    await engine.close();
  });

  it("reuses cached project/session scopes under a trusted global delta", async () => {
    const db = baseDb();
    db.rows.push(row("ses_root", "msg_root_old", NOW - 3 * DAY, { input: 25 }));
    db.updatedAt.set(rowKey("ses_root", "msg_root_old"), NOW - 3 * DAY);
    const { engine, calls } = harness(db);
    await engine.home("24h");
    expect((await engine.project("p1", "lifetime")).totals.input).toBe(325);
    await engine.session("ses_root");

    const baseline = calls.length;
    await engine.refresh();
    expect(
      calls.slice(baseline).filter((call) => call.method === "loadCompletedRows"),
    ).toHaveLength(0);

    // New row inside the cached lifetime project scope but outside the global
    // 24h extent: the global delta must stage it through the scope coverage.
    db.rows.push(row("ses_child", "msg_old_scope", NOW - 3 * DAY, { input: 55 }));
    db.updatedAt.set(rowKey("ses_child", "msg_old_scope"), NOW);
    const newRowBaseline = calls.length;
    await engine.refresh();

    const newRowReads = calls.slice(newRowBaseline);
    expect(
      newRowReads.some(
        (call) => call.method === "loadCompletedRows" && call.params?.sessionIDs !== undefined,
      ),
    ).toBe(false);
    const changedIds = newRowReads
      .filter(
        (call) => call.method === "loadCompletedRows" && call.params?.messageIDs !== undefined,
      )
      .flatMap((call) => call.params?.messageIDs as string[]);
    expect(changedIds).toContain("msg_old_scope");
    expect((await engine.project("p1", "lifetime")).totals.input).toBe(380);
    expect((await engine.session("ses_root")).treeTotals.input).toBe(380);
    await engine.close();
  });

  it("discovers external owners for cached scopes without a scoped payload read", async () => {
    const db = baseDb();
    db.rows.push(row("ses_root", "msg_root_old", NOW - 3 * DAY, { input: 25 }));
    db.updatedAt.set(rowKey("ses_root", "msg_root_old"), NOW - 3 * DAY);
    const { engine, calls } = harness(db);
    await engine.home("24h");
    expect((await engine.project("p1", "lifetime")).totals.input).toBe(325);
    await engine.session("ses_root");

    db.rows.push(row("ses_other", "msg!old", NOW - 3 * DAY, { input: 25 }));
    db.updatedAt.set(rowKey("ses_other", "msg!old"), NOW);
    const baseline = calls.length;
    await engine.refresh();

    const reads = calls.slice(baseline).filter((call) => call.method === "loadCompletedRows");
    expect(reads.some((call) => call.params?.sessionIDs !== undefined)).toBe(false);
    expect((await engine.project("p1", "lifetime")).totals.input).toBe(300);
    await engine.close();
  });

  it("forces authoritative cached scope payloads on a repair refresh", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    await engine.home("24h");
    await engine.project("p1", "lifetime");
    await engine.session("ses_root");

    setNow(NOW + 1);
    const baseline = calls.length;
    await engine.refresh();

    const repairReads = calls
      .slice(baseline)
      .filter((call) => call.method === "loadCompletedRows" && call.params?.sessionIDs);
    expect(
      repairReads.some((call) => (call.params?.sessionIDs as string[]).includes("ses_root")),
    ).toBe(true);
    await engine.close();
  });

  it("never silently drops more than eight scopes", async () => {
    const db = baseDb();
    for (let index = 0; index < 10; index += 1) {
      const id = `ses_bulk_${index}`;
      db.sessions[id] = session(id, `p_bulk_${index % 10}`);
      db.projects[`p_bulk_${index % 10}`] = {
        id: `p_bulk_${index % 10}`,
        name: `Bulk ${index}`,
        directories: [],
        worktrees: [],
      };
      db.rows.push(row(id, `msg_bulk_${index}`, NOW - HOUR, { input: index + 1 }));
    }
    const { engine, calls } = harness(db);

    const snapshots = await Promise.all(
      Array.from({ length: 10 }, (_, index) => engine.project(`p_bulk_${index}`, "24h")),
    );
    expect(snapshots.map((snapshot) => snapshot.projectId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `p_bulk_${index}`),
    );
    const sessionSnapshots = await Promise.all(
      Array.from({ length: 10 }, (_, index) => engine.session(`ses_bulk_${index}`)),
    );
    expect(sessionSnapshots.map((snapshot) => snapshot.focusSessionId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `ses_bulk_${index}`),
    );
    expect(calls.filter((call) => call.method === "withSnapshot").length).toBeGreaterThanOrEqual(2);
  });

  it("a replacement first seen by project scope clears global coverage and certificates", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    await engine.session("ses_root");
    expect(db.compactions.length).toBeGreaterThan(0);

    db.rows = [row("ses_new", "msg_new", NOW - 30 * 60_000, { input: 42 })];
    db.sessions = { ses_new: session("ses_new", "p1") };
    db.compactions = [];
    db.identity = identity({ inode: "999" });

    const project = await engine.project("p1", "30d");
    expect(project.totals.input).toBe(42);

    const freshSession = await engine.session("ses_new");
    expect(freshSession.focusSessionId).toBe("ses_new");
    expect(freshSession.ownSummary.input).toBe(42);

    // The old global extent/certificate is gone, so home must perform a full
    // foreground read for the new generation instead of serving the old cache.
    const beforeHome = calls.length;
    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(42);
    expect(fullReads(calls, beforeHome).length).toBeGreaterThan(0);

    // Old detail signatures/compactions were cleared with the replacement.
    await expect(engine.session("ses_root")).rejects.toMatchObject({ code: "session-not-found" });
    await engine.close();
  });

  it("refreshes every remembered scope on a scoped-only refresh beyond one batch", async () => {
    const db = baseDb();
    for (let index = 0; index < 10; index += 1) {
      const id = `ses_scope_${index}`;
      db.sessions[id] = session(id, `p_scope_${index}`);
      db.projects[`p_scope_${index}`] = {
        id: `p_scope_${index}`,
        name: `Scope ${index}`,
        directories: [],
        worktrees: [],
      };
      db.rows.push(row(id, `msg_scope_${index}`, NOW - HOUR, { input: index + 1 }));
    }
    const { engine, calls, setNow } = harness(db);
    for (let index = 0; index < 10; index += 1) {
      await engine.project(`p_scope_${index}`, "24h");
      await engine.session(`ses_scope_${index}`);
    }
    setNow(NOW + INTERVAL + 1);
    const baseline = calls.length;
    await engine.refresh();

    const scopedIds = new Set<string>();
    for (const call of calls.slice(baseline)) {
      if (call.method !== "loadCompletedRows") continue;
      const values = call.params?.sessionIDs;
      if (Array.isArray(values)) for (const value of values) scopedIds.add(String(value));
    }
    for (let index = 0; index < 10; index += 1) {
      expect(scopedIds.has(`ses_scope_${index}`)).toBe(true);
    }
    await engine.close();
  });

  it("does not reread remembered scopes covered by a global refresh beyond one batch", async () => {
    const db = baseDb();
    for (let index = 0; index < 10; index += 1) {
      const id = `ses_interest_${index}`;
      db.sessions[id] = session(id, `p_interest_${index}`);
      db.projects[`p_interest_${index}`] = {
        id: `p_interest_${index}`,
        name: `Interest ${index}`,
        directories: [],
        worktrees: [],
      };
      db.rows.push(row(id, `msg_interest_${index}`, NOW - HOUR, { input: index + 1 }));
    }
    const { engine, calls, setNow } = harness(db);
    await engine.home("24h");
    for (let index = 0; index < 10; index += 1) {
      await engine.project(`p_interest_${index}`, "24h");
      await engine.session(`ses_interest_${index}`);
    }
    setNow(NOW + INTERVAL + 1);
    const baseline = calls.length;
    await engine.refresh();

    expect(
      calls
        .slice(baseline)
        .filter(
          (call) => call.method === "loadCompletedRows" && call.params?.sessionIDs !== undefined,
        ),
    ).toHaveLength(0);
    for (let index = 0; index < 10; index += 1) {
      expect((await engine.project(`p_interest_${index}`, "24h")).projectId).toBe(
        `p_interest_${index}`,
      );
      expect((await engine.session(`ses_interest_${index}`)).focusSessionId).toBe(
        `ses_interest_${index}`,
      );
    }
    await engine.close();
  });

  it("does not let a scoped refresh make global data fresh", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db);
    await engine.home("24h");
    setNow(NOW + INTERVAL + 1);
    const baseline = calls.length;
    // 30d is outside the loaded 24h extent, so this performs a real scoped
    // transaction rather than serving the existing coverage.
    await engine.project("p1", "30d");
    const scopedReads = calls
      .slice(baseline)
      .filter(
        (call) =>
          call.method === "loadCompletedRows" &&
          Array.isArray(call.params?.sessionIDs) &&
          call.params.sessionIDs.length > 0,
      );
    expect(scopedReads.length).toBeGreaterThan(0);
    const home = await engine.home("24h");
    expect(home.stale).toBe(true);
    await engine.close();
  });

  it("keeps global fork ownership exact when time_updated is unavailable", async () => {
    const db = baseDb();
    db.updatedAtAvailable = false;
    const global = harness(db);
    const home = await global.engine.home("24h");
    expect(home.usage.totals.input).toBe(700);
    await global.engine.close();

    const scopedDb = baseDb();
    scopedDb.rows.push(row("ses_other", "msg!a", NOW - HOUR, { input: 100 }));
    scopedDb.updatedAtAvailable = false;
    const scoped = harness(scopedDb);
    const project = await scoped.engine.project("p1", "7d");
    // The p2 copy of the shared fingerprint owns the contribution globally.
    expect(project.totals.input).toBe(200);
    await scoped.engine.close();
  });
});

describe("analytics engine: warm presentation and scheduler behavior", () => {
  it("does no source or index work at construction", async () => {
    const { engine, calls } = harness(baseDb());
    await Promise.resolve();
    expect(calls).toEqual([]);
    await engine.close();
    expect(calls).toEqual([]);
  });

  it("serves covered warm home ranges without source or index reads", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    let snapshotLoads = 0;
    const warm: WarmAnalyticsPresentation = {
      home: {
        "24h": homeFromDataset(db, "24h"),
        "7d": homeFromDataset(db, "7d"),
        "30d": homeFromDataset(db, "30d"),
      },
      project: [],
      sourceIdentity: db.identity,
      savedAtMs: NOW,
      coverage: { sinceMs: NOW - 30 * DAY, untilMs: NOW },
    };
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => {
        snapshotLoads += 1;
        return undefined;
      },
      loadPresentation: async () => warm,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    expect((await engine.home("24h")).usage.totals.input).toBe(700);
    expect((await engine.home("7d")).usage.totals.input).toBe(1_500);
    expect((await engine.home("30d")).usage.totals.input).toBe(1_500);
    expect(snapshotLoads).toBe(0);
    expect(calls.filter((call) => call.method === "loadCompletedRows")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "loadRevisions")).toHaveLength(0);
    expect(calls.filter((call) => call.method === "withSnapshot")).toHaveLength(1);
    await engine.close();
  });

  it("advances finite Home DTOs at the certified sync epoch", async () => {
    const db = baseDb();
    const age24 = row("ses_root", "msg_age24", NOW - 23 * HOUR, { input: 11 });
    const age7 = row("ses_root", "msg_age7", NOW - 7 * DAY + HOUR, { input: 13 });
    db.rows.push(age24, age7);
    db.updatedAt.set(rowKey("ses_root", "msg_age24"), age24.completedAtMs);
    db.updatedAt.set(rowKey("ses_root", "msg_age7"), age7.completedAtMs);
    const { engine, setNow } = harness(db);

    expect((await engine.home("24h")).usage.totals.input).toBe(711);
    expect((await engine.home("7d")).usage.totals.input).toBe(1_524);

    // Wall time alone does not move a finite DTO. A successful refresh
    // establishes the new certified sync epoch.
    setNow(NOW + 2 * HOUR);
    await engine.refresh();
    for (const range of ["24h", "7d"] as const) {
      const fresh = analytics(datasetOf(db)).home(range, NOW + 2 * HOUR);
      const actual = await engine.home(range);
      expect(actual.usage.totals.input).toBe(fresh.usage.totals.input);
      expect(actual.usage.window).toEqual(fresh.usage.window);
    }
    await engine.close();
  });

  it("keeps finite Home/Project DTOs cached within the refresh interval", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.home("24h");
    await engine.project("p1", "24h");
    const home = await engine.home("24h");
    const project = await engine.project("p1", "24h");
    const homeWindow = home.usage.window;
    const projectWindow = project.usage.window;
    const baseline = (await engine.stats()).phases?.dtoAggregation?.count ?? 0;

    for (const offset of [1, 60_000, 300_000, 599_999]) {
      setNow(NOW + offset);
      const currentHome = await engine.home("24h");
      const currentProject = await engine.project("p1", "24h");
      expect(currentHome.usage.window).toEqual(homeWindow);
      expect(currentHome.usage.totals.input).toBe(700);
      expect(currentProject.usage.window).toEqual(projectWindow);
      expect(currentProject.totals.input).toBe(300);
    }

    expect((await engine.stats()).phases?.dtoAggregation?.count ?? 0).toBe(baseline);
    await engine.close();
  });

  it("re-derives finite views at the certified epoch on a no-change refresh", async () => {
    const db = baseDb();
    const age24 = row("ses_root", "msg_age24_boundary", NOW - 23 * HOUR - 55 * 60_000, {
      input: 11,
    });
    db.rows.push(age24);
    db.updatedAt.set(rowKey("ses_root", "msg_age24_boundary"), age24.completedAtMs);
    const { engine, setNow } = harness(db);

    await engine.home("24h");
    await engine.project("p1", "24h");
    setNow(NOW + INTERVAL);
    await engine.refresh();

    const expectedHome = analytics(datasetOf(db)).home("24h", NOW + INTERVAL);
    const home = await engine.home("24h");
    expect(home.usage.totals).toEqual(expectedHome.usage.totals);
    expect(home.usage.window).toEqual(expectedHome.usage.window);

    const expectedProject = analytics(datasetOf(db)).project("p1", "24h", NOW + INTERVAL);
    const project = await engine.project("p1", "24h");
    expect(project.totals).toEqual(expectedProject.totals);
    expect(project.usage.window).toEqual(expectedProject.usage.window);
    await engine.close();
  });

  it("keeps a covered project-only refresh fresh while the global frontier is stale", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.home("24h");

    setNow(NOW + INTERVAL);
    const project = await engine.project("p1", "30d");
    expect(project.stale).toBe(false);
    expect(project.usage.window.untilMs).toBe(NOW + INTERVAL);
    await engine.close();
  });

  it("does not let a narrow project refresh make a wider cached project fresh", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.home("30d");
    const wide = await engine.project("p1", "30d");
    expect(wide.stale).toBe(false);
    const wideWindow = wide.usage.window;
    await engine.project("p1", "24h");

    // The global frontier is stale. The narrow 24h scoped read occurs at the
    // current time and covers no p1 rows, so the wide cached DTO survives.
    setNow(NOW + 2 * DAY);
    await engine.project("p1", "24h");
    await flushAsync();
    await flushAsync();

    const narrow = await engine.project("p1", "24h");
    expect(narrow.stale).toBe(false);
    expect(narrow.usage.window.untilMs).toBe(NOW + 2 * DAY);

    const dtoCount = (await engine.stats()).phases?.dtoAggregation?.count ?? 0;
    const cachedWide = await engine.project("p1", "30d");
    expect(cachedWide.stale).toBe(true);
    expect(cachedWide.usage.window).toEqual(wideWindow);
    expect((await engine.stats()).phases?.dtoAggregation?.count ?? 0).toBe(dtoCount);
    await engine.close();
  });

  it("does not let a project-only scope advance certify Home or other ranges", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db);
    await engine.home("24h");
    const certifiedHomeWindow = (await engine.home("24h")).usage.window;

    setNow(NOW + 1);
    const p1Wide = await engine.project("p1", "30d");
    const p1WideWindow = p1Wide.usage.window;
    expect(p1WideWindow.untilMs).toBe(NOW + 1);

    const home = await engine.home("24h");
    expect(home.usage.window).toEqual(certifiedHomeWindow);

    const p1Narrow = await engine.project("p1", "24h");
    expect(p1Narrow.usage.window).toEqual(certifiedHomeWindow);

    const p2Narrow = await engine.project("p2", "24h");
    expect(p2Narrow.usage.window).toEqual(certifiedHomeWindow);

    // A 30d scoped certificate cannot cover a wider 7d request for the same
    // project; the engine must perform the matching scoped read instead.
    const beforeWider = calls.length;
    await engine.project("p1", "7d");
    expect(
      calls
        .slice(beforeWider)
        .some(
          (call) =>
            call.method === "loadCompletedRows" &&
            Array.isArray(call.params?.sessionIDs) &&
            call.params.sessionIDs.length > 0,
        ),
    ).toBe(true);
    await engine.close();
  });

  it("preserves Home, Project, and session DTOs across an unchanged detail view", async () => {
    const db = baseDb();
    const { engine, savedPresentations, savedStates, setNow } = harness(db);
    await engine.home("lifetime");
    await engine.project("p1", "lifetime");
    await engine.session("ses_root");
    await flushAsync();

    const modelUpdates = (await engine.stats()).phases?.modelUpdate?.count ?? 0;
    const compactWrites = savedStates.length;
    setNow(NOW + 60_001);
    await engine.session("ses_child");
    await flushAsync();

    expect((await engine.stats()).phases?.modelUpdate?.count ?? 0).toBe(modelUpdates);
    expect(savedStates.length).toBe(compactWrites);

    const latest = savedPresentations[savedPresentations.length - 1];
    expect(Object.keys(latest?.home ?? {}).sort()).toEqual(["24h", "30d", "7d", "lifetime"]);
    expect(latest?.project.some(([id, range]) => id === "p1" && range === "lifetime")).toBe(true);
    expect(latest?.session?.map(([id]) => id)).toEqual(["ses_root", "ses_child"]);
    await engine.close();
  });

  it("persists timestamp-only changes without model or DTO invalidation", async () => {
    const db = baseDb();
    const { engine, savedPresentations, savedStates, setNow } = harness(db);
    await engine.home("24h");
    await engine.project("p1", "24h");
    await engine.session("ses_root");
    await flushAsync();

    const modelUpdates = (await engine.stats()).phases?.modelUpdate?.count ?? 0;
    const compactWrites = savedStates.length;
    const changedAt = NOW + 60_001;
    setNow(changedAt);
    db.updatedAt.set(rowKey("ses_root", "msg_b"), changedAt);

    await engine.project("p1", "30d");
    await flushAsync();

    expect((await engine.stats()).phases?.modelUpdate?.count ?? 0).toBe(modelUpdates);
    expect(savedStates.length).toBeGreaterThan(compactWrites);
    expect(savedStates[savedStates.length - 1]?.occurrences.get("msg_b")?.updatedAtMs).toBe(
      changedAt,
    );
    const latest = savedPresentations[savedPresentations.length - 1];
    expect(latest?.home["24h"]).toBeDefined();
    expect(latest?.session?.some(([id]) => id === "ses_root")).toBe(true);
    await engine.close();
  });

  it("keeps agent-only changes scoped to session DTOs", async () => {
    const db = baseDb();
    const { engine, generations, savedStates, setNow } = harness(db);
    await engine.home("24h");
    await engine.project("p1", "24h");
    await engine.session("ses_root");
    await engine.session("ses_child");
    await flushAsync();

    const target = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!target) throw new Error("msg_b missing");
    const compactWrites = savedStates.length;
    const ranges = ["30d", "7d", "lifetime"] as const;
    const agents: Array<string | undefined> = ["build", "review", undefined];

    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      if (agent === undefined) delete target.agent;
      else target.agent = agent;
      const atMs = NOW + 60_001 + index;
      setNow(atMs);
      const generationsBefore = generations.length;
      await engine.project("p1", ranges[index]);
      await flushAsync();

      expect(savedStates.length).toBe(compactWrites);

      const homeDtoBefore = (await engine.stats()).phases?.dtoAggregation?.count ?? 0;
      const home = await engine.home("24h");
      expect(home.usage.totals.input).toBe(700);
      expect((await engine.stats()).phases?.dtoAggregation?.count ?? 0).toBe(homeDtoBefore);

      const projectDtoBefore = (await engine.stats()).phases?.dtoAggregation?.count ?? 0;
      const project = await engine.project("p1", "24h");
      expect(project.totals.input).toBe(300);
      expect((await engine.stats()).phases?.dtoAggregation?.count ?? 0).toBe(projectDtoBefore);

      const sessionDtoBefore = (await engine.stats()).phases?.dtoAggregation?.count ?? 0;
      const session = await engine.session("ses_root");
      expect(session.steps.find((step) => step.messageId === "msg_b")?.agent).toBe(agent);
      expect((await engine.stats()).phases?.dtoAggregation?.count ?? 0).toBeGreaterThan(
        sessionDtoBefore,
      );
      expect(generations.length).toBeGreaterThan(generationsBefore);

      if (index < agents.length - 1) await engine.session("ses_child");
    }
    await engine.close();
  });

  it("expires finite warm DTOs when a no-change refresh advances the window", async () => {
    const db = baseDb();
    const age24 = row("ses_root", "msg_age24_warm", NOW - 23 * HOUR, { input: 11 });
    db.rows.push(age24);
    db.updatedAt.set(rowKey("ses_root", "msg_age24_warm"), age24.completedAtMs);

    const first = harness(db);
    expect((await first.engine.home("24h")).usage.totals.input).toBe(711);
    await flushAsync();
    const persisted = first.savedStates[first.savedStates.length - 1];
    const sidecar = first.savedPresentations[first.savedPresentations.length - 1];
    if (!persisted || !sidecar?.home["24h"]) {
      throw new Error("expected matching compact index and warm 24h DTO");
    }
    const warm: WarmAnalyticsPresentation = {
      ...structuredClone(sidecar),
      sourceIdentity: db.identity,
    };
    await first.engine.close();

    // Match cloned compact metadata to the source so this refresh is a true
    // no-change global pass, not a metadata replacement.
    db.sessions = structuredClone(persisted.sessions);
    db.projects = structuredClone(persisted.projects);
    const writes: WarmAnalyticsPresentation[] = [];
    let secondNow = NOW;
    const second = createAnalyticsEngine({
      reader: createFakeReader(db, []),
      now: () => secondNow,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => structuredClone(warm),
      saveSnapshot: async () => true,
      savePresentation: async (_path, state, savedAtMs) => {
        if (state.presentation) {
          writes.push({
            ...structuredClone(state.presentation),
            savedAtMs,
            frontierAtMs: state.frontierAtMs,
            ...(state.extent ? { coverage: { ...state.extent } } : {}),
          });
        }
        return true;
      },
    });

    const warmHome = await second.home("24h");
    expect(warmHome.usage.totals.input).toBe(711);
    secondNow = NOW + 2 * HOUR;
    await second.refresh();
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const invalidated = writes[writes.length - 1];
    expect(invalidated?.home["24h"]).toBeUndefined();

    const fresh = analytics(datasetOf(db)).home("24h", NOW + 2 * HOUR);
    const rebuilt = await second.home("24h");
    expect(rebuilt.usage.totals.input).toBe(fresh.usage.totals.input);
    expect(rebuilt.usage.window).toEqual(fresh.usage.window);

    // The expired sidecar must not bring the old DTO back after another start.
    if (!invalidated) throw new Error("expected an invalidated sidecar");
    const third = createAnalyticsEngine({
      reader: createFakeReader(db, []),
      now: () => NOW + 2 * HOUR,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => structuredClone(invalidated),
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });
    const restarted = await third.home("24h");
    expect(restarted.usage.totals.input).toBe(fresh.usage.totals.input);
    expect(restarted.usage.window).toEqual(fresh.usage.window);

    await second.close();
    await third.close();
  });

  it("does not treat warm coverage as a substitute for missing index data", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    let snapshotLoads = 0;
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => {
        snapshotLoads += 1;
        return undefined;
      },
      loadPresentation: async () => ({
        home: {},
        project: [],
        sourceIdentity: db.identity,
        savedAtMs: NOW,
        frontierAtMs: NOW,
        coverage: { sinceMs: NOW - 30 * DAY, untilMs: NOW },
      }),
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(700);
    expect(snapshotLoads).toBe(1);
    expect(calls.filter((call) => call.method === "loadCompletedRows").length).toBeGreaterThan(0);
    await engine.close();
  });

  it("serves a warm session immediately while the scoped catchup is blocked", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    const warmSession = analytics(datasetOf(db)).session("ses_root");
    const fake = createFakeReader(db, calls);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let snapshotCount = 0;
    let catchupCompleted = false;
    const reader: AnalyticsReader = {
      async withSnapshot(read) {
        calls.push({ method: "withSnapshot" });
        snapshotCount += 1;
        if (snapshotCount > 1) await gate;
        const result = await fake.withSnapshot(read);
        if (snapshotCount > 1) catchupCompleted = true;
        return result;
      },
    };
    const engine = createAnalyticsEngine({
      reader,
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => undefined,
      loadPresentation: async () => ({
        home: {},
        project: [],
        session: [["ses_root", warmSession]],
        sourceIdentity: db.identity,
        savedAtMs: NOW,
        coverage: { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      }),
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    const cached = await engine.session("ses_root");
    expect(cached.focusSessionId).toBe("ses_root");
    expect(cached.nodes.map((node) => node.sessionId)).toEqual(["ses_root", "ses_child"]);
    expect(catchupCompleted).toBe(false);
    expect(calls.filter((call) => call.method === "loadCompletedRows")).toHaveLength(0);

    release?.();
    await engine.refresh();
    await engine.close();
  });

  it("moves warm session hits to the newest LRU slot and persists a bounded cache", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    const savedPresentations: WarmAnalyticsPresentation[] = [];
    const ordered: Array<[string, SessionSnapshot]> = Array.from(
      { length: ANALYTICS_PRESENTATION_SESSION_LIMIT },
      (_, index) => [`ses_${index}`, sidecarSession(`ses_${index}`)],
    );
    const fake = createFakeReader(db, calls);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let snapshotCount = 0;
    const reader: AnalyticsReader = {
      async withSnapshot(read) {
        calls.push({ method: "withSnapshot" });
        snapshotCount += 1;
        if (snapshotCount > 1) await gate;
        return await fake.withSnapshot(read);
      },
    };
    const engine = createAnalyticsEngine({
      reader,
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => undefined,
      loadPresentation: async () => ({
        home: {},
        project: [],
        session: ordered,
        sourceIdentity: db.identity,
        savedAtMs: NOW,
        coverage: { sinceMs: NOW - 7 * DAY, untilMs: NOW },
      }),
      saveSnapshot: async () => true,
      savePresentation: async (_path, state) => {
        if (state.presentation) {
          savedPresentations.push({ ...structuredClone(state.presentation) });
        }
        return true;
      },
    });

    await engine.session("ses_0");
    await engine.session("ses_1");
    await engine.close();
    const latest = savedPresentations[savedPresentations.length - 1];
    expect(latest?.session?.map(([sessionId]) => sessionId)).toEqual([
      "ses_2",
      "ses_3",
      "ses_4",
      "ses_5",
      "ses_6",
      "ses_7",
      "ses_0",
      "ses_1",
    ]);
    release?.();
    await flushAsync();
  });

  it("does not freshen an older sidecar timestamp while warming its LRU before index load", async () => {
    const db = baseDb();
    const oldSavedAt = NOW - 60_000;
    const calls: ReaderCall[] = [];
    const savedAts: number[] = [];
    const warmSession = analytics(datasetOf(db)).session("ses_root");
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => await new Promise<AnalyticsState | undefined>(() => {}),
      loadPresentation: async () => ({
        home: {},
        project: [],
        session: [["ses_root", warmSession]],
        sourceIdentity: db.identity,
        savedAtMs: oldSavedAt,
        frontierAtMs: oldSavedAt,
        coverage: { sinceMs: NOW - 7 * DAY, untilMs: oldSavedAt },
      }),
      saveSnapshot: async () => true,
      savePresentation: async (_path, _state, savedAtMs) => {
        savedAts.push(savedAtMs);
        return true;
      },
    });

    await engine.session("ses_root");
    await vi.waitFor(() => expect(savedAts.length).toBeGreaterThan(0));
    await engine.close();
    expect(savedAts.every((savedAtMs) => savedAtMs === oldSavedAt)).toBe(true);
  });

  it("preserves the sidecar source identity in pre-index writes", async () => {
    const db = baseDb();
    const warmSession = analytics(datasetOf(db)).session("ses_root");
    const decodedWrites: WarmAnalyticsPresentation[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, []),
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => await new Promise<AnalyticsState | undefined>(() => {}),
      loadPresentation: async () => ({
        home: {},
        project: [],
        session: [["ses_root", warmSession]],
        sourceIdentity: db.identity,
        savedAtMs: NOW,
        frontierAtMs: NOW,
      }),
      saveSnapshot: async () => true,
      savePresentation: async (_path, state, savedAtMs) => {
        const decoded = decodeAnalyticsPresentation(
          JSON.parse(JSON.stringify(encodeAnalyticsPresentation(state, savedAtMs))) as unknown,
        );
        if (decoded) decodedWrites.push(decoded);
        return true;
      },
    });

    await engine.session("ses_root");
    await vi.waitFor(() => expect(decodedWrites.length).toBeGreaterThan(0));
    await engine.close();

    expect(decodedWrites.length).toBeGreaterThan(0);
    for (const write of decodedWrites) {
      expect(write.sourceIdentity).toMatchObject({
        dbPath: db.identity.dbPath,
        realPath: db.identity.realPath,
        device: db.identity.device,
        inode: db.identity.inode,
        birthtimeMs: db.identity.birthtimeMs,
        schemaToken: db.identity.schemaToken,
      });
      expect(write.session?.map(([sessionId]) => sessionId)).toEqual(["ses_root"]);
    }
  });

  it("serves a persisted presentation DTO before any refresh completes", async () => {
    const first = harness(baseDb());
    await first.engine.home("24h");
    await flushAsync();
    const saved = first.savedStates[first.savedStates.length - 1];
    if (!saved) throw new Error("expected a persisted state");
    const persistedPresentation = first.savedPresentations[first.savedPresentations.length - 1];
    if (!persistedPresentation) throw new Error("expected a persisted presentation sidecar");
    expect(persistedPresentation.home["24h"]).toBeDefined();
    const persisted = cloneState(saved);
    await first.engine.close();

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let backgroundCompleted = false;
    const generations: number[] = [];
    const calls: ReaderCall[] = [];
    const backgroundDb = baseDb();
    backgroundDb.rows.push(row("ses_root", "msg_background", NOW + 30_000, { input: 5 }));
    let snapshotCount = 0;
    const reader: AnalyticsReader = {
      async withSnapshot(read) {
        calls.push({ method: "withSnapshot" });
        snapshotCount += 1;
        // The first transaction is the lightweight sidecar identity check.
        if (snapshotCount > 1) await gate;
        const result = await createFakeReader(backgroundDb, calls).withSnapshot(read);
        if (snapshotCount > 1) backgroundCompleted = true;
        return result;
      },
    };
    const engine = createAnalyticsEngine({
      reader,
      now: () => NOW + INTERVAL + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      onGeneration: (value) => generations.push(value),
      loadSnapshot: async () => persisted,
      saveSnapshot: async () => true,
      loadPresentation: async () => persistedPresentation,
      savePresentation: async () => true,
    });

    const warm = await engine.home("24h");
    expect(warm.stale).toBe(true);
    expect(warm.usage.totals.input).toBe(700);
    // The DTO was served from the persisted presentation cache even though the
    // background refresh transaction had not completed.
    expect(backgroundCompleted).toBe(false);

    release?.();
    await engine.refresh();
    const refreshed = await engine.home("24h");
    expect(refreshed.usage.totals.input).toBe(705);
    expect(refreshed.stale).toBe(false);
    expect(generations.length).toBeGreaterThan(0);
    await engine.close();
  });

  it("resumes a two-day-old snapshot with a delta, not a full baseline", async () => {
    const { db, persisted } = await warmRestartFixture();
    const resumeAt = NOW + 2 * DAY - 30 * 60_000;
    db.rows.push(row("ses_root", "msg_resume", resumeAt, { input: 7 }));
    db.updatedAt.set(rowKey("ses_root", "msg_resume"), resumeAt);
    const calls: ReaderCall[] = [];
    const saved: AnalyticsState[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 2 * DAY,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state) => {
        saved.push(cloneState(state));
        return true;
      },
      savePresentation: async () => true,
    });

    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(7);
    const revisionReads = calls.filter((call) => call.method === "loadRevisions");
    expect(revisionReads).toHaveLength(1);
    expect(revisionReads[0]?.params?.updatedSinceMs).toBe(
      NOW - HOUR - ANALYTICS_SOURCE_CURSOR_OVERLAP_MS,
    );
    expect(calls.some((call) => call.method === "loadRevisionFrontier")).toBe(false);
    expect(fullReads(calls)).toHaveLength(0);

    await flushAsync();
    const last = saved[saved.length - 1];
    expect(last?.lastFullRepairAtMs).toBe(NOW);
    expect(last?.sourceCursorAtMs).toBe(resumeAt);
    await engine.close();
  });

  it("baselines a cursorless legacy snapshot instead of inferring from wall freshness", async () => {
    const { db, persisted } = await warmRestartFixture();
    const legacy = cloneState(persisted);
    delete legacy.sourceCursorAtMs;
    delete legacy.lastFullRepairAtMs;
    const calls: ReaderCall[] = [];
    const saved: AnalyticsState[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + INTERVAL + 1,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => legacy,
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state) => {
        saved.push(cloneState(state));
        return true;
      },
      savePresentation: async () => true,
    });

    await engine.home("24h");
    await engine.refresh();
    const revisionReads = calls.filter((call) => call.method === "loadRevisions");
    expect(revisionReads.length).toBeGreaterThan(0);
    expect(revisionReads[0]?.params?.updatedSinceMs).toBeUndefined();
    await flushAsync();
    const last = saved[saved.length - 1];
    expect(last?.sourceCursorAtMs).toBe(NOW - HOUR);
    expect(last?.sourceCursorAtMs).not.toBe(last?.frontierAtMs);
    expect(last?.lastFullRepairAtMs).toBe(NOW + INTERVAL + 1);
    await engine.close();
  });

  it("does not let an older same-source sidecar override a newer index", async () => {
    const { db, persisted, warm } = await warmRestartFixture();
    const calls: ReaderCall[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => persisted,
      loadPresentation: async () => warm,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    await engine.project("p1", "24h");
    const home = await engine.home("24h");
    // The sidecar was saved before the newer persisted index (705).
    expect(home.usage.totals.input).toBe(705);
    expect(home.stale).toBe(false);
    await engine.close();
  });

  it("attaches a same-source sidecar that is not older than the index", async () => {
    const { db, persisted, warm } = await warmRestartFixture();
    // The fixture's compact metadata is already the source metadata; keep the
    // metadata-only refresh from looking like a data change.
    db.sessions = structuredClone(persisted.sessions);
    db.projects = structuredClone(persisted.projects);
    const newer: WarmAnalyticsPresentation = {
      ...structuredClone(warm),
      savedAtMs: (persisted.savedAtMs ?? NOW) + 1,
      frontierAtMs: NOW + 60_000,
    };
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, []),
      now: () => NOW + 5 * 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => newer,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    // The first warm response is immediate.
    const warmHome = await engine.home("24h");
    expect(warmHome.usage.totals.input).toBe(700);

    // The sidecar was attached but its finite window advanced; a refresh without
    // a hydrated model expires it, so the next request rebuilds from the index.
    await engine.refresh();
    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(705);
    expect(home.stale).toBe(false);
    await engine.close();
  });

  it("does not certify sidecar coverage when the compact snapshot write failed", async () => {
    const db = baseDb();
    const indexStates: AnalyticsState[] = [];
    let failSnapshotWrites = false;
    const first = harness(db, {
      saveSnapshot: async (_path, state) => {
        if (failSnapshotWrites) return false;
        indexStates.push(cloneState(state));
        return true;
      },
    });
    await first.engine.home("30d");
    await flushAsync();
    const oldIndex = indexStates[indexStates.length - 1];
    if (!oldIndex) throw new Error("expected the first compact snapshot");
    const persistedIndex = cloneState(oldIndex);

    db.rows.push(row("ses_root", "msg_backfill", NOW - 10 * 60_000, { input: 50 }));
    db.updatedAt.set(rowKey("ses_root", "msg_backfill"), NOW - 10 * 60_000);
    failSnapshotWrites = true;
    await first.engine.refresh();
    await flushAsync();
    expect(indexStates).toHaveLength(1);

    const newer = first.savedPresentations[first.savedPresentations.length - 1];
    const newer30 = newer?.home["30d"];
    if (!newer30) throw new Error("expected the newer 30d DTO");
    expect(newer30.usage.totals.input).toBe(1_550);
    // The failed compact write is marked as an uncertified sidecar checkpoint,
    // even when its wall-clock savedAt equals the older index.
    expect(newer?.frontierAtMs).toBe(0);
    expect(newer?.coverage).toBeUndefined();
    const fastSidecar: WarmAnalyticsPresentation = {
      ...structuredClone(newer),
      home: { "30d": structuredClone(newer30) },
    };
    await first.engine.close();

    const calls: ReaderCall[] = [];
    let snapshotLoads = 0;
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => {
        snapshotLoads += 1;
        return cloneState(persistedIndex);
      },
      loadPresentation: async () => fastSidecar,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    const cached = await engine.home("30d");
    expect(cached.usage.totals.input).toBe(1_550);
    expect(snapshotLoads).toBe(0);

    // The smaller index extent is authoritative. The missing 7d cache must
    // refresh the delta and rebackfill msg_backfill instead of deriving from
    // the older compact index.
    const missing = await engine.home("7d");
    expect(missing.usage.totals.input).toBe(1_550);
    expect(snapshotLoads).toBe(1);
    expect(calls.some((call) => call.method === "loadCompletedRows")).toBe(true);
    await engine.close();
  });

  it("does not reattach a legacy tokenless presentation after index load", async () => {
    const { db, persisted, warm } = await warmRestartFixture();
    const legacy: WarmAnalyticsPresentation = structuredClone(warm);
    delete legacy.sourceIdentity;
    const calls: ReaderCall[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => persisted,
      loadPresentation: async () => legacy,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    await engine.project("p1", "24h");
    const home = await engine.home("24h");
    // Unverified legacy DTOs are dropped; the persisted index is authoritative.
    expect(home.usage.totals.input).toBe(705);
    expect(home.stale).toBe(false);
    await engine.close();
  });

  it("does not serve a changed-identity warm DTO as fresh and full-reads when needed", async () => {
    const { db, persisted, warm } = await warmRestartFixture();
    const changed: WarmAnalyticsPresentation = {
      ...structuredClone(warm),
      sourceIdentity: identity({ inode: "999" }),
    };

    const coveredCalls: ReaderCall[] = [];
    const covered = createAnalyticsEngine({
      reader: createFakeReader(db, coveredCalls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => cloneState(persisted),
      loadPresentation: async () => changed,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });
    await covered.project("p1", "24h");
    const coveredHome = await covered.home("24h");
    expect(coveredHome.usage.totals.input).toBe(705);
    expect(coveredHome.stale).toBe(false);
    await covered.close();

    // Without persisted coverage, dropping the sidecar must lead to a real
    // global source read instead of returning the old-DB DTO.
    const uncoveredPersisted = cloneState(persisted);
    uncoveredPersisted.extent = undefined;
    const calls: ReaderCall[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => uncoveredPersisted,
      loadPresentation: async () => changed,
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });
    await engine.project("p1", "24h");
    const beforeHome = calls.length;
    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(705);
    expect(home.stale).toBe(false);
    expect(fullReads(calls, beforeHome).length).toBeGreaterThan(0);
    await engine.close();
  });

  it("does not rewrite the compact index on a no-change refresh", async () => {
    const db = baseDb();
    const { engine, savedStates, setNow } = harness(db);
    await engine.home("24h");
    await flushAsync();
    const before = savedStates.length;

    setNow(NOW + 1);
    await engine.refresh();
    await flushAsync();

    expect(savedStates).toHaveLength(before);
    const first = savedStates[0];
    expect(first?.frontierAtMs).toBe(NOW);
    await engine.close();
  });

  it("serves 7d first and extends only the missing 30d side after the idle grace", async () => {
    vi.useFakeTimers();
    try {
      const db = baseDb();
      const { engine, calls } = harness(db);
      const home = await engine.home("7d");
      expect(home.usage.totals.input).toBe(1_500);
      const initial = fullReads(calls);
      expect(initial).toHaveLength(1);
      expect(initial[0]?.params).toMatchObject({
        sinceMs: NOW - 7 * DAY,
        untilMs: NOW,
      });

      // The zero-delay behavior is gone: nothing starts during the grace.
      expect(fullReads(calls)).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(ANALYTICS_THIRTY_DAY_EXTENSION_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      const reads = fullReads(calls);
      expect(reads.length).toBeGreaterThanOrEqual(2);
      const extension = reads[reads.length - 1];
      expect(extension?.params).toMatchObject({
        sinceMs: NOW - 30 * DAY,
        untilMs: NOW - 7 * DAY,
      });
      // Lifetime was never requested by the automatic extension.
      expect(reads.every((call) => call.params?.sinceMs !== undefined)).toBe(true);

      const beforeCached = calls.length;
      const home24 = await engine.home("24h");
      const home7 = await engine.home("7d");
      const home30 = await engine.home("30d");
      expect(home24.usage.totals.input).toBe(700);
      expect(home7.usage.totals.input).toBe(1_500);
      expect(home30.usage.totals.input).toBe(1_500);
      expect(
        calls.slice(beforeCached).filter((call) => call.method === "loadCompletedRows"),
      ).toHaveLength(0);
      await engine.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers the 30d extension while a foreground refresh is in flight", async () => {
    vi.useFakeTimers();
    try {
      const db = baseDb();
      const calls: ReaderCall[] = [];
      const baseReader = createFakeReader(db, calls);
      let gate: { promise: Promise<void>; release: () => void } | undefined;
      const reader: AnalyticsReader = {
        withSnapshot: async (read) => {
          if (gate) await gate.promise;
          return baseReader.withSnapshot(read);
        },
      };
      const engine = createAnalyticsEngine({
        reader,
        now: () => NOW,
        refreshIntervalMs: INTERVAL,
        snapshotPath: "memory.json",
        loadSnapshot: async () => undefined,
        loadPresentation: async () => undefined,
        saveSnapshot: async () => true,
        savePresentation: async () => true,
      });

      await engine.home("7d");
      const readsAfterHome = fullReads(calls).length;
      expect(readsAfterHome).toBe(1);

      let release: (() => void) | undefined;
      gate = {
        promise: new Promise<void>((resolve) => {
          release = resolve;
        }),
        release: () => release?.(),
      };
      const foreground = engine.project("p1", "7d");
      await vi.advanceTimersByTimeAsync(0);

      // The first grace fires while the foreground refresh owns the queue.
      await vi.advanceTimersByTimeAsync(ANALYTICS_THIRTY_DAY_EXTENSION_DELAY_MS);
      expect(fullReads(calls)).toHaveLength(readsAfterHome);

      gate = undefined;
      release?.();
      await foreground;

      // The bounded retry starts the extension only after the queue is idle.
      await vi.advanceTimersByTimeAsync(ANALYTICS_THIRTY_DAY_EXTENSION_DELAY_MS);
      await vi.advanceTimersByTimeAsync(0);
      const reads = fullReads(calls);
      expect(reads.length).toBeGreaterThanOrEqual(2);
      expect(reads[reads.length - 1]?.params).toMatchObject({
        sinceMs: NOW - 30 * DAY,
        untilMs: NOW - 7 * DAY,
      });
      await engine.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends lifetime only on the older side after 30d coverage", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("30d");
    const baseline = calls.length;

    await engine.home("lifetime");

    const reads = fullReads(calls, baseline);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params).toHaveProperty("untilMs", NOW - 30 * DAY);
    expect(reads[0]?.params).not.toHaveProperty("sinceMs");
    await engine.close();
  });

  it("coalesces rapid range requests into the wider refresh", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await Promise.all([engine.home("24h"), engine.home("7d"), engine.home("30d")]);

    const reads = fullReads(calls);
    expect(reads).toHaveLength(1);
    expect(reads[0]?.params).toMatchObject({
      sinceMs: NOW - 30 * DAY,
      untilMs: NOW,
    });
    await engine.close();
  });

  it("cancels the low-priority extension on close and flushes a useful sidecar", async () => {
    vi.useFakeTimers();
    try {
      const db = baseDb();
      const { engine, calls, savedPresentations } = harness(db);
      await engine.home("7d");
      const beforeClose = calls.filter((call) => call.method === "withSnapshot").length;
      await engine.close();
      expect(savedPresentations.length).toBeGreaterThan(0);
      const afterClose = calls.filter((call) => call.method === "withSnapshot").length;
      vi.advanceTimersByTime(3 * INTERVAL);
      expect(calls.filter((call) => call.method === "withSnapshot")).toHaveLength(afterClose);
      expect(afterClose).toBeLessThanOrEqual(beforeClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a changed-identity warm DTO before the cached serve", async () => {
    const db = baseDb();
    const warmHome = homeFromDataset(db, "24h");
    const target = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!target) throw new Error("msg_o missing");
    target.tokens.input = 401;
    db.updatedAt.set(rowKey("ses_other", "msg_o"), NOW);
    db.identity = identity({ inode: "new" });
    const calls: ReaderCall[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => undefined,
      loadPresentation: async () => ({
        home: { "24h": warmHome },
        project: [],
        sourceIdentity: identity({ inode: "old" }),
        savedAtMs: NOW,
        coverage: { sinceMs: NOW - DAY, untilMs: NOW },
      }),
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(701);
    expect(calls.some((call) => call.method === "loadCompletedRows")).toBe(true);
    expect(home.stale).toBe(false);
    await engine.close();
  });

  it("keeps a warm DTO stale when the source identity check is unavailable", async () => {
    const db = baseDb();
    db.status = "missing";
    const warmHome = homeFromDataset(db, "24h");
    const calls: ReaderCall[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW + 60_000,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => undefined,
      loadPresentation: async () => ({
        home: { "24h": warmHome },
        project: [],
        sourceIdentity: db.identity,
        savedAtMs: NOW,
        coverage: { sinceMs: NOW - DAY, untilMs: NOW },
      }),
      saveSnapshot: async () => true,
      savePresentation: async () => true,
    });

    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(700);
    expect(home.stale).toBe(true);
    await engine.close();
  });

  it("does at most one refresh per interval across viewer ticks", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db);
    await engine.home("24h");
    const baseline = calls.filter((call) => call.method === "withSnapshot").length;

    for (const offset of [60_000, 120_000, 300_000, 600_000]) {
      setNow(NOW + offset);
      await engine.home("24h");
    }
    await engine.refresh();
    const after = calls.filter((call) => call.method === "withSnapshot").length;
    expect(after - baseline).toBeLessThanOrEqual(2);
    await engine.close();
  });

  it("performs no autonomous work without a request", async () => {
    vi.useFakeTimers();
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;
    vi.advanceTimersByTime(3 * INTERVAL);
    expect(calls.length).toBe(baseline);
    await engine.close();
    vi.useRealTimers();
  });

  it("bounds detail/project caches across repeated navigation", async () => {
    const db = baseDb();
    for (let index = 0; index < 20; index += 1) {
      const id = `ses_nav_${index}`;
      db.sessions[id] = session(id, `p_nav_${index}`);
      db.projects[`p_nav_${index}`] = {
        id: `p_nav_${index}`,
        name: `Nav ${index}`,
        directories: [],
        worktrees: [],
      };
      db.rows.push(row(id, `msg_nav_${index}`, NOW - HOUR, { input: index + 1 }));
    }
    const { engine, savedStates, setNow } = harness(db);
    for (let index = 0; index < 20; index += 1) {
      setNow(NOW + index * 61_000);
      await engine.project(`p_nav_${index}`, "24h");
      await engine.session(`ses_nav_${index}`);
    }
    await flushAsync();
    const last = savedStates[savedStates.length - 1];
    if (!last) throw new Error("expected saved state");
    expect(last.presentation?.project.length ?? 0).toBeLessThanOrEqual(12);
    await engine.close();
  });

  it("notifies the host once when a refresh produces a new generation", async () => {
    const db = baseDb();
    const { engine, generations } = harness(db);
    await engine.home("24h");
    generations.length = 0;
    db.rows.push(row("ses_root", "msg_generation", NOW - 30 * 60_000, { input: 5 }));
    await engine.refresh();
    expect(generations).toHaveLength(1);
    expect(generations[0]).toBeGreaterThan(0);
    await engine.close();
  });

  it("serializes generation-captured writes and never publishes a null sidecar", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    const writes: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let concurrent = 0;
    let maxConcurrent = 0;
    let nullPresentationWrites = 0;
    const savedSnapshots: PersistedAnalyticsState[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => undefined,
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state, savedAtMs) => {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        savedSnapshots.push(encodeAnalyticsState(state, savedAtMs));
        if (!releaseFirst) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        concurrent -= 1;
        writes.push("snapshot");
        return true;
      },
      savePresentation: async (_path, state) => {
        if (!state.presentation) nullPresentationWrites += 1;
        writes.push("presentation");
        return true;
      },
    });

    await engine.home("24h");
    await vi.waitFor(() => expect(savedSnapshots.length).toBeGreaterThan(0));
    const target = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!target) throw new Error("msg_o missing");
    target.tokens.input = 401;
    db.updatedAt.set(rowKey("ses_other", "msg_o"), NOW);
    await engine.refresh();

    expect(maxConcurrent).toBe(1);
    releaseFirst?.();
    await vi.waitFor(() => expect(savedSnapshots.length).toBeGreaterThanOrEqual(2));
    const latest = savedSnapshots[savedSnapshots.length - 1];
    expect(latest?.fingerprints.some((fingerprint) => fingerprint[4] === 401)).toBe(true);
    expect(maxConcurrent).toBe(1);
    expect(nullPresentationWrites).toBe(0);
    await engine.close();
  });

  it("retains a dirty compact revision through failed writes and retries on close", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    const states: AnalyticsState[] = [];
    let attempts = 0;
    let releaseFirst: (() => void) | undefined;
    let nowMs = NOW;
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => nowMs,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      loadSnapshot: async () => undefined,
      loadPresentation: async () => undefined,
      saveSnapshot: async (_path, state) => {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return false;
        }
        if (attempts === 2) return false;
        states.push(cloneState(state));
        return true;
      },
      savePresentation: async () => true,
    });

    await engine.home("24h");
    await vi.waitFor(() => expect(attempts).toBe(1));
    const target = db.rows.find((entry) => entry.messageID === "msg_o");
    if (!target) throw new Error("msg_o missing");
    target.tokens.input = 401;
    db.updatedAt.set(rowKey("ses_other", "msg_o"), NOW);
    await engine.refresh();
    nowMs = NOW + 1;
    await engine.refresh();

    releaseFirst?.();
    await vi.waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));
    expect(states).toHaveLength(0);
    await engine.close();
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(states).toHaveLength(1);
    const occurrence = states[0]?.occurrences.get("msg_o");
    if (!states[0] || !occurrence) throw new Error("expected retried snapshot");
    expect(states[0].fingerprints[occurrence.fingerprintIndex]?.[4]).toBe(401);
  });

  it("drains queued persistence during close within a bound", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    const engine = createAnalyticsEngine({
      reader: createFakeReader(db, calls),
      now: () => NOW,
      refreshIntervalMs: INTERVAL,
      snapshotPath: "memory.json",
      closeWriteTimeoutMs: 10,
      loadSnapshot: async () => undefined,
      loadPresentation: async () => undefined,
      saveSnapshot: async () => await new Promise<boolean>(() => {}),
      savePresentation: async () => true,
    });
    await engine.home("24h");
    const started = Date.now();
    await engine.close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("prunes orphan fingerprint tuples after removals", async () => {
    const db = baseDb();
    for (let index = 0; index < 80; index += 1) {
      db.rows.push(row("ses_root", `msg_prune_${index}`, NOW - HOUR + index, { input: index + 5 }));
    }
    const { engine, savedStates, setNow } = harness(db, { fullRepairIntervalMs: 1 });
    await engine.home("lifetime");
    await flushAsync();
    db.rows = db.rows.filter((entry) => !/^msg_prune_(?:[0-5]?\d)$/.test(entry.messageID));
    setNow(NOW + 1);
    await engine.refresh();
    await flushAsync();
    const last = savedStates[savedStates.length - 1];
    if (!last) throw new Error("expected saved state");
    expect(last.fingerprints.length).toBeLessThanOrEqual(last.occurrences.size + 32);
    expect(await engine.session("ses_root")).toEqual(analytics(datasetOf(db)).session("ses_root"));
    await engine.close();
  });
});

function sumRows(rows: readonly { tokens: CostedTokens }[]): number {
  return rows.reduce((total, entry) => total + entry.tokens.total, 0);
}

const GROUP_RANGES = ["24h", "7d", "30d", "lifetime"] as const;

describe("analytics engine: grouped model/provider transport", () => {
  it("matches Home totals and windows for every range with full lifetime coverage", async () => {
    const db = baseDb();
    const ancient = row("ses_root", "msg_ancient", NOW - 40 * DAY, { input: 9_000 });
    const missingIds = row("ses_other", "msg_missing_ids", NOW - HOUR, { input: 50 });
    missingIds.providerID = undefined;
    missingIds.modelID = undefined;
    db.rows.push(ancient, missingIds);
    db.updatedAt.set(rowKey(ancient.sessionID, ancient.messageID), ancient.completedAtMs);
    db.updatedAt.set(rowKey(missingIds.sessionID, missingIds.messageID), missingIds.completedAtMs);
    const { engine } = harness(db);

    // A prior finite view must not downgrade the later lifetime certification.
    await engine.home("30d");

    for (const range of GROUP_RANGES) {
      const home = await engine.home(range);
      const grouped = await engine.groups({ range, dimension: "model" });
      expect(grouped.range).toBe(range);
      expect(grouped.dimension).toBe("model");
      expect(grouped.window).toEqual(home.usage.window);
      expect(grouped.bucketUnit).toBe(home.usage.bucketUnit);
      expect(grouped.buckets).toHaveLength(home.usage.buckets.length);
      expect(grouped.totals).toEqual(home.usage.totals);
      expect(grouped.stepCount).toBe(home.usage.stepCount);
      expect(grouped.sessionCount).toBe(home.usage.sessionCount);
      // Every raw identity, including the missing one, stays represented.
      expect(sumRows(grouped.rows)).toBe(grouped.totals.total);
      expect(grouped.rows.some((entry) => entry.identity.kind === "unknown")).toBe(true);
    }

    const lifetime = await engine.groups({ range: "lifetime", dimension: "model" });
    const ancientRow = lifetime.rows.find(
      (entry) => entry.identity.kind === "known" && entry.identity.id === "gpt-5",
    );
    expect(ancientRow?.tokens.input).toBeGreaterThanOrEqual(9_000);
    await engine.close();
  });

  it("reuses the certified Home epoch and exact window instead of a sampled clock", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    const home = await engine.home("24h");
    const certifiedWindow = home.usage.window;
    expect(certifiedWindow.untilMs).toBe(NOW);

    setNow(NOW + 5 * 60_000);
    const grouped = await engine.groups({ range: "24h", dimension: "provider" });
    expect(grouped.window).toEqual(certifiedWindow);
    expect(grouped.stale).toBe(false);

    setNow(NOW + 2 * HOUR);
    await engine.refresh();
    const refreshedHome = await engine.home("24h");
    const refreshedGroup = await engine.groups({ range: "24h", dimension: "provider" });
    expect(refreshedGroup.window).toEqual(refreshedHome.usage.window);
    expect(refreshedGroup.totals).toEqual(refreshedHome.usage.totals);
    expect(refreshedGroup.window.untilMs).toBe(NOW + 2 * HOUR);
    await engine.close();
  });

  it("reads no raw payloads for warm grouped and detail queries", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("7d");
    const baseline = calls.length;

    const modelDetailQuery: AnalyticsGroupQuery = {
      range: "7d",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
    };
    const providerDetailQuery: AnalyticsGroupQuery = {
      range: "7d",
      dimension: "model",
      filter: { dimension: "provider", identity: { kind: "known", id: "openai" } },
    };
    const queries: AnalyticsGroupQuery[] = [
      { range: "7d", dimension: "model" },
      { range: "7d", dimension: "provider" },
      modelDetailQuery,
      providerDetailQuery,
    ];

    for (const query of queries) {
      const first = await engine.groups(query);
      expect(first.stepCount).toBeGreaterThan(0);
      const second = await engine.groups(query);
      expect(second).toEqual(first);
    }

    const modelDetail = await engine.groups(modelDetailQuery);
    expect(modelDetail.rows[0]?.identity).toEqual({ kind: "known", id: "openai" });
    expect(modelDetail.rows[0]?.children[0]?.identity).toEqual({ kind: "known", id: "gpt-5" });
    const providerDetail = await engine.groups(providerDetailQuery);
    expect(providerDetail.rows[0]?.identity).toEqual({ kind: "known", id: "gpt-5" });
    expect(providerDetail.rows[0]?.children[0]?.identity).toEqual({ kind: "known", id: "openai" });

    expect(calls).toHaveLength(baseline);
    await engine.close();
  });

  it("keeps known-empty, literal unknown ids and missing identities distinct", async () => {
    const db = baseDb();
    const missingModel = row("ses_other", "msg_missing_ids", NOW - HOUR, { input: 77, output: 0 });
    missingModel.modelID = undefined;
    const literalUnknown = row(
      "ses_root",
      "msg_literal_unknown",
      NOW - HOUR,
      { input: 33, output: 0 },
      { providerID: "openai", modelID: "unknown" },
    );
    db.rows.push(missingModel, literalUnknown);
    db.updatedAt.set(
      rowKey(missingModel.sessionID, missingModel.messageID),
      missingModel.completedAtMs,
    );
    db.updatedAt.set(
      rowKey(literalUnknown.sessionID, literalUnknown.messageID),
      literalUnknown.completedAtMs,
    );
    const { engine } = harness(db);
    await engine.home("24h");

    const unknownFilter = {
      range: "24h",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "unknown" } },
    } satisfies AnalyticsGroupQuery;
    const unknown = await engine.groups(unknownFilter);
    expect(unknown.filter).toEqual(unknownFilter.filter);
    expect(unknown.totals.total).toBe(77);

    const literal = await engine.groups({
      range: "24h",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "unknown" } },
    });
    expect(literal.totals.total).toBe(33);

    const empty = await engine.groups({
      range: "24h",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "" } },
    });
    expect(empty.filter).toEqual({
      dimension: "model",
      identity: { kind: "known", id: "" },
    });
    expect(empty.totals.total).toBe(0);
    expect(empty.stepCount).toBe(0);
    expect(empty.sessionCount).toBe(0);
    expect(empty.rows).toEqual([]);
    expect(empty.series).toEqual([]);
    expect(empty.buckets.every((bucket) => bucket.startMs < bucket.endMs)).toBe(true);
    expect(empty.stale).toBe(false);
    await engine.close();
  });

  it("invalidates grouped snapshots after a scoped contribution edit", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    await engine.home("24h");
    const before = await engine.groups({ range: "24h", dimension: "model" });
    const beforeTotal = before.totals.total;
    const beforeGpt = before.rows.find(
      (entry) => entry.identity.kind === "known" && entry.identity.id === "gpt-5",
    );
    if (!beforeGpt) throw new Error("expected a gpt-5 group");

    const edited = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!edited) throw new Error("expected msg_b");
    edited.modelID = "gpt-5-mini";
    db.updatedAt.set(rowKey(edited.sessionID, edited.messageID), NOW + 1_000);
    await engine.session("ses_root");

    const after = await engine.groups({ range: "24h", dimension: "model" });
    expect(after.totals.total).toBe(beforeTotal);
    const mini = after.rows.find(
      (entry) => entry.identity.kind === "known" && entry.identity.id === "gpt-5-mini",
    );
    expect(mini?.tokens.input).toBe(200);
    const gpt = after.rows.find(
      (entry) => entry.identity.kind === "known" && entry.identity.id === "gpt-5",
    );
    expect(gpt?.tokens.input).toBe(beforeGpt.tokens.input - 200);
    await engine.close();
  });

  it("clears grouped snapshots on source replacement and re-reads history", async () => {
    const db = baseDb();
    const { engine, calls } = harness(db);
    await engine.home("24h");
    const before = await engine.groups({ range: "24h", dimension: "model" });
    expect(before.totals.input).toBe(700);

    db.rows = [row("ses_root", "msg_replaced", NOW - HOUR, { input: 42 })];
    db.identity = identity({ inode: "999" });
    const replaceStart = calls.length;
    await engine.refresh();
    const after = await engine.groups({ range: "24h", dimension: "model" });
    expect(after.totals.input).toBe(42);
    expect(after.rows.map((entry) => entry.identity)).toEqual([{ kind: "known", id: "gpt-5" }]);
    expect(fullReads(calls, replaceStart).length).toBeGreaterThanOrEqual(1);
    await engine.close();
  });

  it("retains last-good grouped data while stale and never fabricates zero from an absent source", async () => {
    const coldDb = baseDb();
    coldDb.status = "missing";
    const cold = harness(coldDb);
    await expect(cold.engine.groups({ range: "24h", dimension: "model" })).rejects.toMatchObject({
      code: "unavailable",
    });
    await cold.engine.close();

    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.home("24h");
    const before = await engine.groups({ range: "24h", dimension: "model" });
    db.status = "missing";
    setNow(NOW + INTERVAL + 1);
    await engine.refresh();
    const after = await engine.groups({ range: "24h", dimension: "model" });
    expect(after.stale).toBe(true);
    expect(after.totals).toEqual(before.totals);
    expect(after.window).toEqual(before.window);
    await engine.close();
  });

  it("keeps the Home lifetime window across a local-day boundary", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    const home = await engine.home("lifetime");
    const certifiedWindow = home.usage.window;
    const certifiedBuckets = home.usage.buckets.map(({ startMs, endMs }) => ({ startMs, endMs }));

    // Crossing a daily bucket boundary must not move a first grouped lifetime
    // read past the window Home already certified.
    setNow(NOW + 2 * DAY);
    const grouped = await engine.groups({ range: "lifetime", dimension: "model" });
    expect(grouped.window).toEqual(certifiedWindow);
    expect(grouped.buckets).toEqual(certifiedBuckets);
    expect(grouped.totals).toEqual(home.usage.totals);
    expect(grouped.stale).toBe(true);
    await engine.close();
  });

  it("schedules a stale background refresh for a new grouped query like Home", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db);
    await engine.home("24h");
    const baseline = calls.length;

    setNow(NOW + INTERVAL + 1);
    const grouped = await engine.groups({ range: "24h", dimension: "model" });
    expect(grouped.stale).toBe(true);
    await flushAsync();

    const backgroundReads = calls.slice(baseline).filter((call) => call.method === "withSnapshot");
    expect(backgroundReads).toHaveLength(1);
    await engine.close();
  });

  it("attempts one refresh for an uncovered grouped range when the source is unavailable", async () => {
    const groupDb = baseDb();
    const grouped = harness(groupDb);
    await grouped.engine.home("24h");
    groupDb.status = "missing";
    const groupBaseline = grouped.calls.length;

    const snapshot = await grouped.engine.groups({ range: "lifetime", dimension: "model" });
    await flushAsync();

    // The failed foreground attempt already consumed this interval: no forced
    // second global refresh may bypass due/backoff.
    expect(
      grouped.calls.slice(groupBaseline).filter((call) => call.method === "withSnapshot"),
    ).toHaveLength(1);
    expect(snapshot.stale).toBe(true);

    // The same unavailable, uncovered request on Home makes one attempt too.
    const homeDb = baseDb();
    const home = harness(homeDb);
    await home.engine.home("24h");
    homeDb.status = "missing";
    const homeBaseline = home.calls.length;
    const homeSnapshot = await home.engine.home("lifetime");
    await flushAsync();
    expect(
      home.calls.slice(homeBaseline).filter((call) => call.method === "withSnapshot"),
    ).toHaveLength(1);
    expect(homeSnapshot.stale).toBe(true);

    // Last-good partial lifetime data is served truthfully stale, matching
    // Home's exact fallback window rather than fabricated complete history.
    expect(snapshot.totals).toEqual(homeSnapshot.usage.totals);
    expect(snapshot.window).toEqual(homeSnapshot.usage.window);
    await grouped.engine.close();
    await home.engine.close();
  });

  it("does not let a scoped refresh certify a global grouped window", async () => {
    const db = baseDb();
    const { engine, setNow } = harness(db);
    await engine.home("24h");
    const before = await engine.groups({ range: "24h", dimension: "model" });
    const certifiedWindow = before.window;

    setNow(NOW + INTERVAL - 1);
    await engine.project("p1", "lifetime");
    const after = await engine.groups({ range: "24h", dimension: "model" });
    expect(after.window).toEqual(certifiedWindow);
    expect(after.stale).toBe(false);
    await engine.close();
  });
});

function zeroRow(
  sessionID: string,
  messageID: string,
  atMs: number,
  extra: Partial<OpenCodeRawAssistantRow> = {},
): OpenCodeRawAssistantRow {
  return row(
    sessionID,
    messageID,
    atMs,
    { input: 0, output: 0, cacheRead: 0 },
    {
      cost: 0,
      providerID: "zero-labs",
      modelID: "zero-1",
      ...extra,
    },
  );
}

describe("analytics engine: zero-token usage exclusion", () => {
  it("excludes zero-token rows from Home, groups, and session detail", async () => {
    const db = baseDb();
    const zero = zeroRow("ses_root", "msg_zero", NOW - HOUR);
    db.rows.push(zero);
    db.updatedAt.set(rowKey(zero.sessionID, zero.messageID), zero.completedAtMs);

    const { engine } = harness(db);
    const home = await engine.home("24h");
    expect(home.usage.totals.input).toBe(700);
    expect(home.usage.stepCount).toBe(3);
    expect(home.usage.sessionCount).toBe(2);

    for (const dimension of ["model", "provider"] as const) {
      const grouped = await engine.groups({ range: "24h", dimension });
      expect(grouped.totals).toEqual(home.usage.totals);
      expect(grouped.stepCount).toBe(3);
      expect(grouped.sessionCount).toBe(2);
      expect(
        grouped.rows.some(
          (entry) => entry.identity.kind === "known" && entry.identity.id === "zero-1",
        ),
      ).toBe(false);
      expect(
        grouped.rows.some(
          (entry) => entry.identity.kind === "known" && entry.identity.id === "zero-labs",
        ),
      ).toBe(false);
      expect(
        grouped.series.some(
          (entry) =>
            entry.kind === "entity" &&
            entry.identity.kind === "known" &&
            entry.identity.id === "zero-1",
        ),
      ).toBe(false);
      expect(
        grouped.series.some(
          (entry) =>
            entry.kind === "entity" &&
            entry.identity.kind === "known" &&
            entry.identity.id === "zero-labs",
        ),
      ).toBe(false);
    }

    const session = await engine.session("ses_root");
    expect(session.steps.some((step) => step.messageId === "msg_zero")).toBe(false);
    expect(session.ownSummary.stepCount).toBe(2);
    // Metadata survives zero-token exclusion.
    expect(session.focusSessionId).toBe("ses_root");
    expect(session.nodes.some((node) => node.sessionId === "ses_root")).toBe(true);
    await engine.close();
  });

  it("rebuilds warm Home DTOs written under pre-zero-token presentation semantics", async () => {
    const db = baseDb();
    const zero = zeroRow("ses_root", "msg_zero", NOW - HOUR);
    db.rows.push(zero);
    db.updatedAt.set(rowKey(zero.sessionID, zero.messageID), zero.completedAtMs);

    // Old semantics counted the zero-token row as a step, so a legacy warm DTO
    // is observably different from a current rebuild (same tokens, extra step).
    const legacyHome = homeFromDataset(db, "24h");
    expect(legacyHome.usage.stepCount).toBe(4);
    const legacyState: AnalyticsState = {
      sessions: {},
      projects: {},
      fingerprints: [],
      fingerprintIndex: new Map(),
      occurrences: new Map(),
      extent: { sinceMs: NOW - HOUR, untilMs: NOW },
      sourceIdentity: db.identity,
      frontierAtMs: NOW,
      presentation: { home: { "24h": legacyHome }, project: [] },
    };
    const legacySidecar = JSON.parse(
      JSON.stringify(encodeAnalyticsPresentation(legacyState, NOW)),
    ) as Record<string, unknown>;
    delete legacySidecar.presentationVersion;

    const warm = harness(db, {
      loadPresentation: async () => decodeAnalyticsPresentation(legacySidecar),
    });
    const home = await warm.engine.home("24h");
    expect(home.usage.stepCount).toBe(3);
    expect(home.usage.totals.input).toBe(700);
    await warm.engine.close();
  });

  it("reconciles positive→zero and zero→positive deltas without stale usage", async () => {
    const db = baseDb();
    const switchRow = row(
      "ses_root",
      "msg_switch",
      NOW - HOUR,
      { input: 50 },
      {
        providerID: "zai",
        modelID: "glm-4.7",
      },
    );
    db.rows.push(switchRow);
    db.updatedAt.set(rowKey(switchRow.sessionID, switchRow.messageID), switchRow.completedAtMs);
    const { engine, setNow } = harness(db);

    await engine.home("24h");
    const before = await engine.groups({ range: "24h", dimension: "model" });
    expect(before.totals.input).toBe(750);
    expect(
      before.rows.some(
        (entry) => entry.identity.kind === "known" && entry.identity.id === "glm-4.7",
      ),
    ).toBe(true);

    const index = db.rows.findIndex((entry) => entry.messageID === "msg_switch");
    const toZero = zeroRow("ses_root", "msg_switch", NOW - HOUR, {
      createdAtMs: switchRow.createdAtMs,
      updatedAtMs: NOW + 1,
    });
    db.rows[index] = toZero;
    db.updatedAt.set(rowKey(toZero.sessionID, toZero.messageID), NOW + 1);
    setNow(NOW + INTERVAL + 1);
    await engine.refresh();

    const afterZero = await engine.home("24h");
    expect(afterZero.usage.totals.input).toBe(700);
    const zeroGroups = await engine.groups({ range: "24h", dimension: "model" });
    expect(
      zeroGroups.rows.some(
        (entry) => entry.identity.kind === "known" && entry.identity.id === "glm-4.7",
      ),
    ).toBe(false);
    expect(
      (await engine.session("ses_root")).steps.some((step) => step.messageId === "msg_switch"),
    ).toBe(false);

    const backPositive = row(
      "ses_root",
      "msg_switch",
      NOW - HOUR,
      { input: 70 },
      {
        providerID: "zai",
        modelID: "glm-4.7",
        updatedAtMs: NOW + 2,
      },
    );
    db.rows[index] = backPositive;
    db.updatedAt.set(rowKey(backPositive.sessionID, backPositive.messageID), NOW + 2);
    setNow(NOW + 2 * INTERVAL + 1);
    await engine.refresh();

    expect((await engine.home("24h")).usage.totals.input).toBe(770);
    const restored = await engine.groups({ range: "24h", dimension: "model" });
    const zai = restored.rows.find(
      (entry) => entry.identity.kind === "known" && entry.identity.id === "glm-4.7",
    );
    expect(zai?.tokens.input).toBe(70);
    expect(
      (await engine.session("ses_root")).steps.some((step) => step.messageId === "msg_switch"),
    ).toBe(true);
    await engine.close();
  });

  it("reconciles silent positive→zero and zero→positive edits on full repair", async () => {
    const db = baseDb();
    const switchRow = row(
      "ses_root",
      "msg_silent",
      NOW - HOUR,
      { input: 50 },
      {
        providerID: "zai",
        modelID: "glm-4.7",
      },
    );
    db.rows.push(switchRow);
    db.updatedAt.set(rowKey(switchRow.sessionID, switchRow.messageID), NOW - HOUR);
    const { engine, setNow } = harness(db, { fullRepairIntervalMs: 0 });

    await engine.home("24h");
    expect((await engine.home("24h")).usage.totals.input).toBe(750);

    const index = db.rows.findIndex((entry) => entry.messageID === "msg_silent");
    // Payload changes without a source-timestamp move: only a full repair can
    // observe this edit. The range read must remain unfiltered so the zero row
    // is projected and the previously owned positive contribution is removed.
    db.rows[index] = zeroRow("ses_root", "msg_silent", NOW - HOUR, {
      createdAtMs: switchRow.createdAtMs,
    });
    setNow(NOW + 1);
    await engine.refresh();
    expect((await engine.home("24h")).usage.totals.input).toBe(700);
    const zeroGroups = await engine.groups({ range: "24h", dimension: "model" });
    expect(
      zeroGroups.rows.some(
        (entry) => entry.identity.kind === "known" && entry.identity.id === "glm-4.7",
      ),
    ).toBe(false);

    db.rows[index] = row(
      "ses_root",
      "msg_silent",
      NOW - HOUR,
      { input: 70 },
      {
        providerID: "zai",
        modelID: "glm-4.7",
      },
    );
    setNow(NOW + 2);
    await engine.refresh();
    expect((await engine.home("24h")).usage.totals.input).toBe(770);
    const restored = await engine.groups({ range: "24h", dimension: "model" });
    expect(
      restored.rows.find(
        (entry) => entry.identity.kind === "known" && entry.identity.id === "glm-4.7",
      )?.tokens.input,
    ).toBe(70);
    await engine.close();
  });

  it("does not shortcut filtered lifetime when only zero-token rows are indexed", async () => {
    const db = baseDb();
    // The initial 24h extent owns membership but no usage.
    const zero = zeroRow("ses_root", "msg_zero_recent", NOW - HOUR);
    // Older positive history matches the filter but lies outside the extent.
    const older = row(
      "ses_root",
      "msg_old_match",
      NOW - 45 * DAY,
      { input: 900 },
      { providerID: "zai", modelID: "glm-4.7" },
    );
    db.rows = [zero, older];
    db.updatedAt.clear();
    db.updatedAt.set(rowKey(zero.sessionID, zero.messageID), zero.completedAtMs);
    db.updatedAt.set(rowKey(older.sessionID, older.messageID), older.completedAtMs);

    const { engine } = harness(db);
    await engine.home("24h");

    const result = await engine.groups({
      range: "lifetime",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "glm-4.7" } },
    });

    // The zero-only shortcut would return an empty stale snapshot before the
    // older matching positive history was read.
    expect(result.stale).toBe(false);
    expect(result.totals.input).toBe(900);
    expect(result.stepCount).toBe(1);
    expect(
      result.rows.find((entry) => entry.identity.kind === "known" && entry.identity.id === "zai")
        ?.tokens.input,
    ).toBe(900);
    await engine.close();
  });
});

describe("analytics engine: scoped provider/model lifetime", () => {
  it("serves detail lifetime from owned hours without awaiting a raw read", async () => {
    const db = baseDb();
    const calls: ReaderCall[] = [];
    const baseReader = createFakeReader(db, calls);
    let releaseRead: (() => void) | undefined;
    let gateArmed = false;
    const reader: AnalyticsReader = {
      async withSnapshot<T>(
        read: (snapshot: OpenCodeStorageSnapshot) => T | Promise<T>,
      ): Promise<OpenCodeStorageSnapshotResult<T>> {
        if (gateArmed) {
          gateArmed = false;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
          });
        }
        return baseReader.withSnapshot(read);
      },
    };
    const { engine } = harness(db, { reader });

    const home = await engine.home("24h");
    const query: AnalyticsGroupQuery = {
      range: "lifetime",
      dimension: "provider",
      filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
    };
    const baseline = calls.length;
    gateArmed = true;
    let resolved = false;
    const pending = engine.groups(query).then((snapshot) => {
      resolved = true;
      return snapshot;
    });
    await flushAsync();
    // The render completes while the background lifetime read is still gated.
    expect(resolved).toBe(true);
    const partial = await pending;
    expect(partial.stale).toBe(true);
    expect(partial.totals).toEqual(home.usage.totals);
    expect(partial.window.untilMs).toBe(NOW);

    // A repeat render is served from the same owned data/cache, not another read.
    const repeated = await engine.groups(query);
    expect(repeated.totals).toEqual(partial.totals);
    expect(repeated.stale).toBe(true);

    releaseRead?.();
    await flushAsync();
    await flushAsync();
    const backgroundReads = calls.slice(baseline).filter((call) => call.method === "withSnapshot");
    expect(backgroundReads).toHaveLength(1);

    // The completed background lifetime read extends the extent; the next
    // detail render re-derives from owned hours without touching SQLite.
    const beforeComplete = calls.length;
    const complete = await engine.groups(query);
    expect(complete.totals.input).toBe(1_500);
    expect(complete.stale).toBe(false);
    expect(calls).toHaveLength(beforeComplete);
    await engine.close();
  });

  it("back off repeated scoped lifetime fills while the source is unavailable", async () => {
    const db = baseDb();
    const { engine, calls, setNow } = harness(db);
    const home = await engine.home("24h");
    db.status = "missing";
    const baseline = calls.length;

    const query: AnalyticsGroupQuery = {
      range: "lifetime",
      dimension: "model",
      filter: { dimension: "provider", identity: { kind: "known", id: "openai" } },
    };
    const first = await engine.groups(query);
    expect(first.stale).toBe(true);
    expect(first.totals).toEqual(home.usage.totals);
    await flushAsync();
    expect(calls.slice(baseline).filter((call) => call.method === "withSnapshot")).toHaveLength(1);

    // Cached partial data must not force a new source read on every render.
    setNow(NOW + 1_000);
    const second = await engine.groups(query);
    expect(second.stale).toBe(true);
    expect(second.totals).toEqual(first.totals);
    await flushAsync();
    expect(calls.slice(baseline).filter((call) => call.method === "withSnapshot")).toHaveLength(1);
    await engine.close();
  });
});
