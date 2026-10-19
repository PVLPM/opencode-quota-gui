import { describe, expect, it, vi } from "vitest";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import { createAnalyticsEngine } from "../src/gui/analytics-engine.js";
import type { AnalyticsReader } from "../src/gui/analytics-reader.js";
import {
  type AnalyticsState,
  decodeAnalyticsState,
  encodeAnalyticsState,
  type PersistedAnalyticsState,
  rowKey,
  type WarmAnalyticsPresentation,
} from "../src/gui/analytics-state.js";
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
    rows: [
      row("ses_root", "msg_a", NOW - HOUR, { input: 100 }),
      row("ses_child", "msg_a_fork", NOW - HOUR, { input: 100 }),
      row("ses_root", "msg_b", NOW - HOUR, { input: 200 }),
      row("ses_other", "msg_o", NOW - HOUR, { input: 400 }),
      row("ses_other", "msg_old", NOW - 2 * DAY, { input: 800 }),
    ],
    updatedAt: new Map(),
    revisionOverrides: new Map(),
    extraRevisions: [],
    compactions: [{ sessionId: "ses_root", atMs: NOW - HOUR, messageId: "msg_c" }],
    identity: identity(),
    status: "ok",
    updatedAtAvailable: true,
  };
}

function createFakeReader(db: FakeDb, calls: ReaderCall[]): AnalyticsReader {
  const revisionsFor = (sessionIds?: readonly string[]): OpenCodeMessageRevision[] => {
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
    if (sessionIds === undefined) return revisions;
    const set = new Set(sessionIds);
    return revisions.filter((revision) => set.has(revision.sessionID));
  };

  function completedRows(params: {
    completedSinceMs?: number;
    completedUntilMs?: number;
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
    return rows;
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
            },
          });
          return {
            available: true,
            updatedAtAvailable: db.updatedAtAvailable,
            completedAtAvailable: true,
            revisions: revisionsFor(params.sessionIDs),
          };
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
    loadSnapshot?: () => Promise<AnalyticsState | undefined>;
    saveSnapshot?: (path: string, state: AnalyticsState, savedAtMs: number) => Promise<boolean>;
    loadPresentation?: () => Promise<WarmAnalyticsPresentation | undefined>;
    savePresentation?: (path: string, state: AnalyticsState, savedAtMs: number) => Promise<boolean>;
  } = {},
): Harness {
  const calls: ReaderCall[] = [];
  const reader = createFakeReader(db, calls);
  let nowMs = overrides.now ?? NOW;
  const savedStates: AnalyticsState[] = [];
  const savedPresentations: WarmAnalyticsPresentation[] = [];
  const generations: number[] = [];
  const engine = createAnalyticsEngine({
    reader,
    now: () => nowMs,
    refreshIntervalMs: INTERVAL,
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
      (async (_path, state) => {
        if (state.presentation) {
          savedPresentations.push(structuredClone(state.presentation));
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

function fullReads(calls: ReaderCall[], afterIndex = 0): ReaderCall[] {
  return calls
    .slice(afterIndex)
    .filter(
      (call) =>
        call.method === "loadCompletedRows" &&
        call.params?.messageIDs === undefined &&
        call.params?.sessionIDs === undefined,
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
    const expectedHome = createUsageAnalytics(datasetOf(db)).home("7d", NOW);
    const home = await engine.home("7d");
    expect(home.usage.totals).toEqual(expectedHome.usage.totals);
    expect(home.usage.buckets.map((bucket) => bucket.tokens)).toEqual(
      expectedHome.usage.buckets.map((bucket) => bucket.tokens),
    );
    expect(home.projects).toEqual(expectedHome.projects);

    const expectedProject = createUsageAnalytics(datasetOf(db)).project("p1", "7d", NOW);
    const project = await engine.project("p1", "7d");
    expect(project.totals).toEqual(expectedProject.totals);
    expect(project.roots).toEqual(expectedProject.roots);
    expect(project.usage.totals).toEqual(expectedProject.usage.totals);

    const expectedSession = createUsageAnalytics(datasetOf(db)).session("ses_root");
    const sessionSnapshot = await engine.session("ses_root");
    expect(sessionSnapshot).toEqual(expectedSession);
  });
});

describe("analytics engine: revision reconciliation", () => {
  it("detects edits, insertions, and deletions without session metadata changes", async () => {
    const db = baseDb();
    const { engine } = harness(db);
    await engine.home("24h");

    const edited = db.rows.find((entry) => entry.messageID === "msg_b");
    if (!edited) throw new Error("msg_b missing");
    edited.tokens.input = 500;
    db.updatedAt.set(rowKey("ses_root", "msg_b"), NOW);
    db.rows.push(row("ses_root", "msg_new", NOW - 30 * 60_000, { input: 50 }));
    await engine.refresh();
    const afterEdit = await engine.home("24h");
    expect(afterEdit.usage.totals.input).toBe(1_050);

    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_b");
    await engine.refresh();
    const afterDelete = await engine.home("24h");
    expect(afterDelete.usage.stepCount).toBe(3);
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
    const { engine } = harness(db);
    const before = await engine.home("24h");
    expect(before.usage.totals.input).toBe(700);

    db.rows = db.rows.filter((entry) => entry.messageID !== "msg_a");
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.usage.totals.input).toBe(700);
    expect(after.usage.stepCount).toBe(3);
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
    const { engine } = harness(db);
    const first = await engine.home("24h");
    expect(first.usage.totals.apiEquivalentCostUsd).not.toBeNull();

    db.rows = db.rows.filter((entry) => entry.messageID !== "priced_2");
    await engine.refresh();
    const after = await engine.home("24h");
    expect(after.usage.totals.unpricedTokens + after.usage.totals.unknownTokens).toBeGreaterThan(0);
    expect(after.usage.totals.apiEquivalentCostUsd).not.toBeNull();

    db.rows = db.rows.filter((entry) => entry.messageID !== "priced");
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
    const { engine } = harness(db);
    const before = await engine.home("24h");
    expect(before.usage.buckets.some((bucket) => bucket.tokens.input > 0)).toBe(true);
    db.rows = [];
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
        (call) => call.params?.sessionIDs !== undefined || call.params?.messageIDs !== undefined,
      ),
    ).toBe(true);
    const ownerFetch = reads.find((call) => call.params?.messageIDs !== undefined);
    expect(ownerFetch?.params?.messageIDs).toContain("msg!a");
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
          call.params?.messageIDs === undefined,
      ),
    ).toBe(false);
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

  it("refreshes every remembered periodic scope beyond one batch", async () => {
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
    const scopedIds = new Set<string>();
    for (const call of calls.slice(baseline)) {
      if (call.method !== "loadCompletedRows") continue;
      const values = call.params?.sessionIDs;
      if (Array.isArray(values)) for (const value of values) scopedIds.add(String(value));
    }
    for (let index = 0; index < 10; index += 1) {
      expect(scopedIds.has(`ses_interest_${index}`)).toBe(true);
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
    const reader: AnalyticsReader = {
      async withSnapshot(read) {
        calls.push({ method: "withSnapshot" });
        await gate;
        const result = await createFakeReader(backgroundDb, calls).withSnapshot(read);
        backgroundCompleted = true;
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

  it("reattaches a warm presentation after index load when the identity matches", async () => {
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
    // The matching sidecar DTO wins over the newer persisted index (705).
    expect(home.usage.totals.input).toBe(700);
    expect(home.stale).toBe(false);
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
    const { engine, savedStates } = harness(db);
    await engine.home("lifetime");
    await flushAsync();
    db.rows = db.rows.filter((entry) => !/^msg_prune_(?:[0-5]?\d)$/.test(entry.messageID));
    await engine.refresh();
    await flushAsync();
    const last = savedStates[savedStates.length - 1];
    if (!last) throw new Error("expected saved state");
    expect(last.fingerprints.length).toBeLessThanOrEqual(last.occurrences.size + 32);
    await engine.close();
  });
});
