import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { HomeSnapshot, SessionSnapshot } from "../src/contracts/dashboard.js";
import {
  type AnalyticsState,
  compactFingerprintOf,
  decodeAnalyticsState,
  encodeAnalyticsState,
  fingerprintOf,
  type Occurrence,
  rowFromFingerprint,
  saveAnalyticsPresentation,
  saveAnalyticsSnapshot,
} from "../src/gui/analytics-state.js";
import {
  analyticsStorePathFor,
  createAnalyticsPersistDelta,
  createAnalyticsStore,
} from "../src/gui/analytics-store.js";
import { openOpenCodeSqliteWritable } from "../src/lib/opencode-sqlite.js";
import type { OpenCodeRawAssistantRow } from "../src/lib/opencode-storage.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocq-analytics-store-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

function rawRow(
  sessionID: string,
  messageID: string,
  atMs: number,
  extra: Partial<OpenCodeRawAssistantRow> = {},
): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs: atMs - 500,
    completedAtMs: atMs,
    tokens: { input: 100, output: 10, reasoning: 3, cacheRead: 7, cacheWrite: 1 },
    providerID: "openai",
    modelID: "gpt-5",
    cost: 0.125,
    ...extra,
  };
}

/** Builds state the way the engine does: intern + set + mark. */
function stateBuilder() {
  const state: AnalyticsState = {
    sessions: {
      ses_b: { id: "ses_b", projectID: "p1", title: "B", parentID: "ses_a", agent: "build" },
      ses_a: {
        id: "ses_a",
        projectID: "p1",
        title: null as never,
        time: { created: 1, updated: 2 },
      },
    },
    projects: {
      p1: { id: "p1", name: "One", directories: ["/a", "/b"], worktrees: ["/a"] },
      p2: { id: "p2", directories: [], worktrees: [] },
    },
    fingerprints: [],
    fingerprintIndex: new Map(),
    occurrences: new Map(),
    extent: { sinceMs: NOW - 7 * 86_400_000, untilMs: NOW },
    sourceIdentity: {
      dbPath: "/db",
      exists: true,
      status: "ok",
      realPath: "/db",
      device: "1",
      inode: "2",
      birthtimeMs: 3,
      schemaToken: "t",
    },
    frontierAtMs: NOW,
    sourceCursorAtMs: NOW - 1_000,
    lastFullRepairAtMs: NOW - 2_000,
    sourceSignature: "sig",
    futureCompletionAtMs: NOW + 5_000,
  };
  delete (state.sessions.ses_a as { title?: unknown }).title;
  const delta = createAnalyticsPersistDelta();
  return {
    state,
    delta,
    set(row: OpenCodeRawAssistantRow, updatedAtMs: number | null) {
      const key = fingerprintOf(row);
      let index = state.fingerprintIndex.get(key);
      if (index === undefined) {
        index = state.fingerprints.length;
        state.fingerprints.push(compactFingerprintOf(row));
        state.fingerprintIndex.set(key, index);
      }
      const occurrence: Occurrence = {
        fingerprintIndex: index,
        sessionID: row.sessionID,
        messageID: row.messageID,
        updatedAtMs,
      };
      if (row.variant !== undefined) occurrence.variant = row.variant;
      state.occurrences.set(row.messageID, occurrence);
      delta.markChanged(row.messageID);
    },
    remove(messageID: string) {
      state.occurrences.delete(messageID);
      delta.markRemoved(messageID);
    },
  };
}

/** Order-preserving, index-independent view of the persisted index. */
function canonical(state: AnalyticsState) {
  return {
    rows: [...state.occurrences.values()].map((occurrence) => {
      const fingerprint = state.fingerprints[occurrence.fingerprintIndex];
      if (!fingerprint) throw new Error("dangling fingerprint");
      return {
        row: rowFromFingerprint(fingerprint, occurrence),
        updatedAtMs: occurrence.updatedAtMs,
      };
    }),
    sessions: Object.entries(state.sessions),
    projects: Object.entries(state.projects),
    extent: state.extent,
    sourceIdentity: state.sourceIdentity,
    frontierAtMs: state.frontierAtMs,
    sourceCursorAtMs: state.sourceCursorAtMs,
    lastFullRepairAtMs: state.lastFullRepairAtMs,
    sourceSignature: state.sourceSignature,
    futureCompletionAtMs: state.futureCompletionAtMs,
  };
}

/** The JSON baseline's restart view of the same state. */
function jsonRoundTrip(state: AnalyticsState, savedAtMs: number): AnalyticsState {
  const decoded = decodeAnalyticsState(
    JSON.parse(JSON.stringify(encodeAnalyticsState(state, savedAtMs))) as unknown,
  );
  if (!decoded) throw new Error("json round trip failed");
  return decoded;
}

function seed(builder: ReturnType<typeof stateBuilder>): void {
  builder.set(rawRow("ses_a", "m1", NOW - 10_000), NOW - 10_000);
  // Fork copy: identical contribution, another session; shares one fingerprint.
  builder.set(rawRow("ses_b", "m1_fork", NOW - 10_000), NOW - 9_000);
  builder.set(
    rawRow("ses_a", "m2", NOW - 5_000, {
      variant: "high",
      cacheReadMissing: true,
      cacheWriteMissing: true,
      tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    null,
  );
  builder.set(rawRow("ses_b", "m3", NOW - 1_000, { cost: undefined, providerID: undefined }), 7);
  builder.set(
    rawRow("ses_b", "m4", NOW - 500, {
      modelID: undefined,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    }),
    NOW,
  );
}

describe("analytics SQLite store", () => {
  it("round-trips the index exactly as the JSON baseline restores it", async () => {
    const root = tempRoot();
    const builder = stateBuilder();
    seed(builder);
    const store = createAnalyticsStore({ snapshotPath: join(root, "analytics-v3.json") });
    expect(await store.saveSnapshot(builder.state, NOW + 1, builder.delta)).toBe(true);
    store.close();

    const reopened = createAnalyticsStore({ snapshotPath: join(root, "analytics-v3.json") });
    const loaded = await reopened.loadSnapshot();
    reopened.close();
    expect(loaded).toBeDefined();
    const expected = jsonRoundTrip(builder.state, NOW + 1);
    expect(canonical(loaded as AnalyticsState)).toEqual(canonical(expected));
    expect((loaded as AnalyticsState).savedAtMs).toBe(NOW + 1);
    // Fork copies still share one interned contribution after the reload.
    const reloaded = loaded as AnalyticsState;
    expect(reloaded.occurrences.get("m1")?.fingerprintIndex).toBe(
      reloaded.occurrences.get("m1_fork")?.fingerprintIndex,
    );
    expect(reloaded.occurrences.get("m2")?.variant).toBe("high");
    expect(existsSync(join(root, "analytics.sqlite"))).toBe(true);
  });

  it("writes only changed occurrences and keeps the in-memory order", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    seed(builder);
    const store = createAnalyticsStore({ snapshotPath });
    await store.saveSnapshot(builder.state, NOW, builder.delta);
    expect(store.lastWrite()).toEqual({ rows: 5, full: true });

    // In-place revision (keeps position), removal, re-add (moves to the end),
    // and a new row added between the removal and the re-add.
    builder.set(
      rawRow("ses_a", "m1", NOW - 10_000, {
        tokens: { input: 999, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      }),
      NOW + 5,
    );
    builder.remove("m2");
    builder.remove("m3");
    builder.set(rawRow("ses_a", "m5", NOW + 10), NOW + 10);
    builder.set(rawRow("ses_b", "m3", NOW - 1_000, { variant: "low" }), NOW + 11);
    // Metadata churn: an added session, a removed session and a removed project.
    builder.state.sessions.ses_c = { id: "ses_c", projectID: "p2" };
    delete builder.state.sessions.ses_a;
    delete builder.state.projects.p2;
    builder.state.sourceCursorAtMs = NOW + 11;
    await store.saveSnapshot(builder.state, NOW + 20, builder.delta);
    expect(store.lastWrite()).toEqual({ rows: 4, full: false });
    store.close();

    const reopened = createAnalyticsStore({ snapshotPath });
    const loaded = await reopened.loadSnapshot();
    reopened.close();
    expect(canonical(loaded as AnalyticsState)).toEqual(
      canonical(jsonRoundTrip(builder.state, NOW + 20)),
    );
    expect([...(loaded as AnalyticsState).occurrences.keys()]).toEqual([
      "m1",
      "m1_fork",
      "m4",
      "m5",
      "m3",
    ]);
  });

  it("restores a failed delta so the next write still carries it", async () => {
    const delta = createAnalyticsPersistDelta();
    delta.markChanged("a");
    delta.markRemoved("b");
    const taken = delta.take();
    delta.markChanged("c");
    delta.markChanged("b");
    delta.restore(taken);
    const merged = delta.take();
    expect([...merged.dirty]).toEqual(["a", "c", "b"]);
    expect([...merged.removed]).toEqual(["b"]);
    delta.markReplaced();
    delta.markChanged("x");
    expect(delta.take()).toEqual({ full: true, dirty: new Set(), removed: new Set() });
  });

  it("fences a stale writer into a whole-index rewrite (last writer wins, never a mix)", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const base = stateBuilder();
    seed(base);
    const writer = createAnalyticsStore({ snapshotPath });
    await writer.saveSnapshot(base.state, NOW, base.delta);
    writer.close();

    const first = createAnalyticsStore({ snapshotPath });
    const second = createAnalyticsStore({ snapshotPath });
    const a = await first.loadSnapshot();
    const b = await second.loadSnapshot();
    if (!a || !b) throw new Error("expected loaded states");

    const deltaA = createAnalyticsPersistDelta();
    a.occurrences.delete("m4");
    deltaA.markRemoved("m4");
    a.sourceCursorAtMs = NOW + 100;
    await first.saveSnapshot(a, NOW + 100, deltaA);
    expect(first.lastWrite()?.full).toBe(false);

    // B never saw A's revision: its delta alone would leave A's removal under
    // B's older cursor. It must rewrite its own whole state instead.
    const deltaB = createAnalyticsPersistDelta();
    const occurrence = b.occurrences.get("m1");
    if (!occurrence) throw new Error("expected m1");
    occurrence.updatedAtMs = NOW + 50;
    deltaB.markChanged("m1");
    await second.saveSnapshot(b, NOW + 50, deltaB);
    expect(second.lastWrite()).toEqual({ rows: 5, full: true });
    first.close();
    second.close();

    const check = createAnalyticsStore({ snapshotPath });
    const loaded = await check.loadSnapshot();
    check.close();
    expect(canonical(loaded as AnalyticsState)).toEqual(canonical(jsonRoundTrip(b, NOW + 50)));
  });

  it("migrates a valid legacy JSON index and sidecar once, then removes them", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    seed(builder);
    builder.state.presentation = {
      home: { "7d": { projects: [], usage: { timeZone: "UTC" } } as unknown as HomeSnapshot },
      project: [],
    };
    expect(await saveAnalyticsSnapshot(snapshotPath, builder.state, NOW - 60_000)).toBe(true);
    expect(
      await saveAnalyticsPresentation(`${snapshotPath}.presentation.json`, builder.state, NOW),
    ).toBe(true);

    const store = createAnalyticsStore({ snapshotPath });
    const warm = await store.loadPresentation();
    expect(warm?.home["7d"]).toBeDefined();
    expect(warm?.savedAtMs).toBe(NOW);
    const loaded = await store.loadSnapshot();
    store.close();
    expect(canonical(loaded as AnalyticsState)).toEqual(
      canonical(jsonRoundTrip(builder.state, NOW - 60_000)),
    );
    // The original save time survives: it orders the index against the sidecar.
    expect(loaded?.savedAtMs).toBe(NOW - 60_000);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(`${snapshotPath}.presentation.json`)).toBe(false);

    const again = createAnalyticsStore({ snapshotPath });
    expect((await again.loadPresentation())?.savedAtMs).toBe(NOW);
    expect(canonical((await again.loadSnapshot()) as AnalyticsState)).toEqual(
      canonical(loaded as AnalyticsState),
    );
    again.close();
  });

  it("keeps an unsupported legacy file until a SQLite index has committed", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    writeFileSync(snapshotPath, JSON.stringify({ version: 4, schema: "ocq-analytics-state" }));
    const store = createAnalyticsStore({ snapshotPath });
    expect(await store.loadSnapshot()).toBeUndefined();
    expect(existsSync(snapshotPath)).toBe(true);
    const builder = stateBuilder();
    seed(builder);
    expect(await store.saveSnapshot(builder.state, NOW, builder.delta)).toBe(true);
    store.close();
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it("rolls an interrupted write back completely and retries it idempotently", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    seed(builder);
    const store = createAnalyticsStore({ snapshotPath });
    await store.saveSnapshot(builder.state, NOW, builder.delta);

    // A dangling fingerprint aborts the transaction after some rows were
    // written, including a never-seen dictionary string that rolls back too.
    builder.set(rawRow("ses_new", "m8", NOW + 1, { providerID: "new-provider" }), NOW + 1);
    builder.set(rawRow("ses_a", "m9", NOW + 1), NOW + 1);
    const broken = builder.state.occurrences.get("m9");
    if (!broken) throw new Error("expected m9");
    const goodIndex = broken.fingerprintIndex;
    broken.fingerprintIndex = 10_000;
    builder.state.sourceCursorAtMs = NOW + 1;
    expect(await store.saveSnapshot(builder.state, NOW + 1, builder.delta)).toBe(false);
    const peek = createAnalyticsStore({ snapshotPath });
    const before = await peek.loadSnapshot();
    peek.close();
    expect(before?.occurrences.has("m8")).toBe(false);
    expect(before?.occurrences.has("m9")).toBe(false);
    expect(before?.sourceCursorAtMs).toBe(NOW - 1_000);

    broken.fingerprintIndex = goodIndex;
    expect(await store.saveSnapshot(builder.state, NOW + 2, builder.delta)).toBe(true);
    expect(store.lastWrite()).toEqual({ rows: 2, full: false });
    store.close();
    const after = createAnalyticsStore({ snapshotPath });
    expect(canonical((await after.loadSnapshot()) as AnalyticsState)).toEqual(
      canonical(jsonRoundTrip(builder.state, NOW + 2)),
    );
    after.close();
  });

  it("rebuilds a corrupt analytics database without touching usage history", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const historyPath = join(root, "usage-history.sqlite");
    const history = await openOpenCodeSqliteWritable(historyPath);
    history.exec("CREATE TABLE observation (id INTEGER PRIMARY KEY, value TEXT)");
    history.run("INSERT INTO observation (value) VALUES (?)", ["irreplaceable"]);
    history.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    history.close();
    const historyBytes = readFileSync(historyPath);

    writeFileSync(analyticsStorePathFor(snapshotPath), "this is not a database at all".repeat(200));
    const store = createAnalyticsStore({ snapshotPath });
    expect(await store.loadSnapshot()).toBeUndefined();
    const builder = stateBuilder();
    seed(builder);
    expect(await store.saveSnapshot(builder.state, NOW, builder.delta)).toBe(true);
    store.close();
    const reopened = createAnalyticsStore({ snapshotPath });
    expect((await reopened.loadSnapshot())?.occurrences.size).toBe(5);
    reopened.close();
    expect(readFileSync(historyPath).equals(historyBytes)).toBe(true);
  });

  it("never rebuilds or writes a database owned by a newer schema", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const path = analyticsStorePathFor(snapshotPath);
    const conn = await openOpenCodeSqliteWritable(path);
    conn.exec("CREATE TABLE analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    conn.run("INSERT INTO analytics_meta (key, value) VALUES ('schema_version', '99')");
    conn.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    conn.close();
    const bytes = readFileSync(path);

    const store = createAnalyticsStore({ snapshotPath });
    expect(await store.loadSnapshot()).toBeUndefined();
    const builder = stateBuilder();
    seed(builder);
    expect(await store.saveSnapshot(builder.state, NOW, builder.delta)).toBe(false);
    expect(await store.savePresentation(builder.state, NOW)).toBe(false);
    store.close();
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });

  it("stores the warm presentation per slot and keeps its certification fields", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    const session = (id: string, size: number): SessionSnapshot =>
      ({
        focusSessionId: id,
        projectId: "p1",
        projectName: "One",
        breadcrumbs: [],
        nodes: [],
        steps: [],
        compactionMarkers: [],
        ownSummary: {},
        treeTotals: {},
        stepSemantics: "x".repeat(size),
        timeZone: "UTC",
      }) as unknown as SessionSnapshot;
    builder.state.presentation = {
      home: { "24h": { projects: [], usage: {} } as unknown as HomeSnapshot },
      project: [["p1", "7d", { roots: [], usage: {} } as never]],
      // Oldest first; together they exceed the 4 MiB budget by one entry.
      session: [session("s1", 1_500_000), session("s2", 1_500_000), session("s3", 1_500_000)].map(
        (snapshot) => [snapshot.focusSessionId, snapshot] as [string, SessionSnapshot],
      ),
    };
    const store = createAnalyticsStore({ snapshotPath });
    expect(await store.savePresentation(builder.state, NOW)).toBe(true);
    const warm = await store.loadPresentation();
    expect(warm?.home["24h"]).toBeDefined();
    expect(warm?.project.map(([id, range]) => `${id}:${range}`)).toEqual(["p1:7d"]);
    expect(warm?.session?.map(([id]) => id)).toEqual(["s2", "s3"]);
    expect(warm?.sourceIdentity).toEqual(builder.state.sourceIdentity);
    expect(warm?.coverage).toEqual(builder.state.extent);
    expect(warm?.frontierAtMs).toBe(NOW);
    expect(warm?.savedAtMs).toBe(NOW);

    // An uncertified write (the index checkpoint is behind) keeps no coverage.
    const uncertified = { ...builder.state, frontierAtMs: 0 };
    delete uncertified.extent;
    await store.savePresentation(uncertified, NOW + 1);
    const after = await store.loadPresentation();
    expect(after?.coverage).toBeUndefined();
    expect(after?.frontierAtMs).toBe(0);
    store.close();
  });

  it("never opens a database file that is a link to another file", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const victim = join(root, "usage-history.sqlite");
    writeFileSync(victim, "not an analytics database");
    linkSync(victim, join(root, "analytics.sqlite"));
    const builder = stateBuilder();
    seed(builder);
    const store = createAnalyticsStore({ snapshotPath });
    expect(await store.saveSnapshot(builder.state, NOW, builder.delta)).toBe(false);
    expect(await store.savePresentation(builder.state, NOW)).toBe(false);
    store.close();
    // Neither written through nor removed by corruption recovery.
    expect(readFileSync(victim, "utf8")).toBe("not an analytics database");
    expect(existsSync(join(root, "analytics.sqlite"))).toBe(true);
  });

  it("imports only the sidecar contract's fields from a legacy sidecar", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    builder.state.presentation = {
      home: { "7d": { projects: [], usage: { timeZone: "UTC" } } as unknown as HomeSnapshot },
      project: [],
    };
    const sidecar = `${snapshotPath}.presentation.json`;
    expect(await saveAnalyticsPresentation(sidecar, builder.state, NOW)).toBe(true);
    const legacy = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
    legacy.unexpected = "legacy-only-value";
    (legacy.presentation as Record<string, unknown>).unexpected = "legacy-only-value";
    writeFileSync(sidecar, JSON.stringify(legacy));

    const store = createAnalyticsStore({ snapshotPath });
    expect((await store.loadPresentation())?.home["7d"]).toBeDefined();
    store.close();
    const conn = await openOpenCodeSqliteWritable(join(root, "analytics.sqlite"));
    const stored = conn
      .all<{ value: string }>("SELECT value FROM analytics_meta")
      .concat(conn.all<{ value: string }>("SELECT payload AS value FROM analytics_presentation"));
    conn.close();
    expect(stored.some((row) => row.value.includes("legacy-only-value"))).toBe(false);
  });

  it("yields during a large load and serializes writes queued behind it", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    for (let index = 0; index < 40_000; index += 1) {
      builder.set(rawRow(index % 2 ? "ses_a" : "ses_b", `bulk_${index}`, NOW - index), index);
    }
    const writer = createAnalyticsStore({ snapshotPath });
    await writer.saveSnapshot(builder.state, NOW, builder.delta);
    writer.close();

    const store = createAnalyticsStore({ snapshotPath });
    let loadSettled = false;
    const load = store.loadSnapshot().finally(() => {
      loadSettled = true;
    });
    // Issued mid-load: it waits for the read transaction instead of failing.
    builder.state.presentation = {
      home: { "24h": { projects: [], usage: {} } as unknown as HomeSnapshot },
      project: [],
    };
    const save = store.savePresentation(builder.state, NOW + 1);
    // The longest event-loop stall while the load is pending, relative to its
    // whole duration: one synchronous scan would be nearly all of it.
    const startedAt = performance.now();
    let lastTurn = startedAt;
    let longestStall = 0;
    await new Promise<void>((resolve) => {
      const tick = () => {
        const at = performance.now();
        longestStall = Math.max(longestStall, at - lastTurn);
        lastTurn = at;
        if (loadSettled) return resolve();
        setImmediate(tick);
      };
      setImmediate(tick);
    });
    const loaded = await load;
    expect(longestStall).toBeLessThan((performance.now() - startedAt) / 2);
    expect(await save).toBe(true);
    expect(loaded?.occurrences.size).toBe(40_000);
    expect([...(loaded?.occurrences.keys() ?? [])].slice(0, 2)).toEqual(["bulk_0", "bulk_1"]);
    expect((await store.loadPresentation())?.home["24h"]).toBeDefined();
    store.close();
  });

  it("closes mid-load without failing and then releases the file", async () => {
    const root = tempRoot();
    const snapshotPath = join(root, "analytics-v3.json");
    const builder = stateBuilder();
    for (let index = 0; index < 20_000; index += 1) {
      builder.set(rawRow("ses_a", `bulk_${index}`, NOW - index), index);
    }
    const writer = createAnalyticsStore({ snapshotPath });
    await writer.saveSnapshot(builder.state, NOW, builder.delta);
    writer.close();

    const store = createAnalyticsStore({ snapshotPath });
    const load = store.loadSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.close();
    expect(await load).toBeUndefined();
    expect(await store.saveSnapshot(builder.state, NOW + 1, undefined)).toBe(false);
    rmSync(join(root, "analytics.sqlite"));
    expect(existsSync(join(root, "analytics.sqlite"))).toBe(false);
  });
});
