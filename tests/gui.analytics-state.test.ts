import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeSnapshot } from "../src/contracts/dashboard.js";
import {
  ANALYTICS_SNAPSHOT_SCHEMA,
  ANALYTICS_SNAPSHOT_VERSION,
  type AnalyticsState,
  decodeAnalyticsPresentation,
  decodeAnalyticsState,
  encodeAnalyticsPresentation,
  encodeAnalyticsState,
  fingerprintOf,
  loadAnalyticsSnapshot,
  rowKey,
  saveAnalyticsSnapshot,
} from "../src/gui/analytics-state.js";
import type {
  OpenCodeRawAssistantRow,
  OpenCodeSourceIdentity,
} from "../src/lib/opencode-storage.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");

function row(
  sessionID: string,
  messageID: string,
  overrides: Partial<OpenCodeRawAssistantRow> = {},
): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs: NOW - 60_000,
    completedAtMs: NOW - 30_000,
    tokens: { input: 10, output: 5, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
    providerID: "openai",
    modelID: "gpt-5",
    cost: 0.25,
    ...overrides,
  };
}

function identity(): OpenCodeSourceIdentity {
  return {
    dbPath: "/db",
    exists: true,
    status: "ok",
    realPath: "/db",
    device: "1",
    inode: "2",
    birthtimeMs: 3,
    schemaToken: "session_v2(a)",
  };
}

function homeSnapshot(range: "24h" | "7d" | "30d" | "lifetime"): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: [], polledAtMs: NOW },
    usage: {
      range,
      window: { untilMs: NOW },
      bucketUnit: "hour",
      buckets: [],
      totals: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        apiEquivalentCostUsd: null,
        unpricedTokens: 0,
        unknownTokens: 0,
      },
      stepCount: 0,
      sessionCount: 0,
      stale: false,
    },
    projects: [],
  };
}

function baseState(): AnalyticsState {
  return {
    sessions: {
      ses_parent: { id: "ses_parent", projectID: "p1", time: { created: NOW - 3_600_000 } },
      ses_fork: { id: "ses_fork", projectID: "p1", time: { created: NOW - 3_600_000 } },
    },
    projects: { p1: { id: "p1", name: "p1", directories: [], worktrees: [] } },
    fingerprints: [],
    fingerprintIndex: new Map(),
    occurrences: new Map(),
    extent: { sinceMs: NOW - 3_600_000, untilMs: NOW },
    sourceIdentity: identity(),
    frontierAtMs: NOW,
    sourceCursorAtMs: NOW - 60_000,
    lastFullRepairAtMs: NOW,
  };
}

function withRows(): AnalyticsState {
  const state = baseState();
  const entries = [row("ses_parent", "msg_a"), row("ses_fork", "msg_a_copy", { agent: "build" })];
  for (const entry of entries) {
    const fingerprint = fingerprintOf(entry);
    let index = state.fingerprintIndex.get(fingerprint);
    if (index === undefined) {
      index = state.fingerprints.length;
      state.fingerprints.push([
        entry.createdAtMs,
        entry.completedAtMs,
        entry.providerID ?? null,
        entry.modelID ?? null,
        entry.tokens.input,
        entry.tokens.output,
        entry.tokens.reasoning,
        entry.tokens.cacheRead,
        entry.tokens.cacheWrite,
        entry.cost ?? null,
      ]);
      state.fingerprintIndex.set(fingerprint, index);
    }
    state.occurrences.set(rowKey(entry.sessionID, entry.messageID), {
      fingerprintIndex: index,
      sessionID: entry.sessionID,
      messageID: entry.messageID,
      updatedAtMs: 1_700_000_000_000,
      ...(entry.agent === undefined ? {} : { agent: entry.agent }),
    });
  }
  return state;
}

let roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ocq-analytics-state-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots = [];
});

describe("analytics snapshot codec v3", () => {
  it("round-trips compact state and deduplicates identical fingerprint occurrences", () => {
    const state = withRows();
    const persisted = encodeAnalyticsState(state, NOW);

    expect(persisted.version).toBe(ANALYTICS_SNAPSHOT_VERSION);
    expect(persisted.schema).toBe(ANALYTICS_SNAPSHOT_SCHEMA);
    expect(persisted.fingerprints).toHaveLength(1);
    expect(persisted.occurrences).toHaveLength(2);
    // Agents, raw message bodies, and size/mtime are never persisted.
    expect(JSON.stringify(persisted)).not.toContain("build");
    expect(JSON.stringify(persisted)).not.toContain("sizeBytes");

    const decoded = decodeAnalyticsState(JSON.parse(JSON.stringify(persisted)) as unknown);
    expect(decoded).toBeDefined();
    expect(decoded?.occurrences.size).toBe(2);
    expect(decoded?.occurrences.get("msg_a_copy")?.agent).toBeUndefined();
    expect(decoded?.occurrences.get("msg_a_copy")?.sessionID).toBe("ses_fork");
    expect(decoded?.extent).toEqual({ sinceMs: NOW - 3_600_000, untilMs: NOW });
    expect(decoded?.sourceIdentity?.inode).toBe("2");
    expect(decoded?.frontierAtMs).toBe(NOW);
    expect(decoded?.sourceCursorAtMs).toBe(NOW - 60_000);
    expect(decoded?.lastFullRepairAtMs).toBe(NOW);
    expect(decoded?.fingerprintIndex.size).toBe(1);
  });

  it("never infers a source cursor from wall freshness or cached occurrence times", () => {
    const state = baseState();
    delete state.sourceCursorAtMs;
    delete state.lastFullRepairAtMs;
    // Keep the occurrence at a much older timestamp than `frontierAtMs`.
    const older = withRows();
    delete older.sourceCursorAtMs;
    delete older.lastFullRepairAtMs;
    older.frontierAtMs = NOW;
    older.occurrences.forEach((occurrence) => {
      occurrence.updatedAtMs = NOW - 30 * 24 * 3_600_000;
    });

    for (const candidate of [state, older]) {
      const persisted = encodeAnalyticsState(candidate, NOW);
      expect(persisted.sourceCursorAtMs).toBeNull();
      expect(persisted.lastFullRepairAtMs).toBeNull();
      const decoded = decodeAnalyticsState(JSON.parse(JSON.stringify(persisted)) as unknown);
      expect(decoded?.frontierAtMs).toBe(NOW);
      expect(decoded?.sourceCursorAtMs).toBeUndefined();
      expect(decoded?.lastFullRepairAtMs).toBeUndefined();
    }
  });

  it("round-trips a bounded warm presentation sidecar", () => {
    const state = withRows();
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
    };
    const encoded = encodeAnalyticsPresentation(state, NOW);
    const decoded = decodeAnalyticsPresentation(JSON.parse(JSON.stringify(encoded)) as unknown);
    expect(decoded?.home["24h"]?.range).toBe("24h");
    expect(decoded?.project).toEqual([]);
    expect(decoded?.sourceIdentity).toEqual(identity());
    // The big index deliberately does not duplicate the presentation cache.
    const index = decodeAnalyticsState(
      JSON.parse(JSON.stringify(encodeAnalyticsState(state, NOW))) as unknown,
    );
    expect(index?.presentation).toBeUndefined();

    const withoutIdentity = withRows();
    delete withoutIdentity.sourceIdentity;
    expect(encodeAnalyticsPresentation(withoutIdentity, NOW).sourceIdentity).toBeNull();
  });

  it("reads legacy tokenless presentations but rejects invalid identity tokens", () => {
    const state = withRows();
    state.presentation = { home: { "24h": homeSnapshot("24h") }, project: [] };
    const raw = JSON.parse(JSON.stringify(encodeAnalyticsPresentation(state, NOW))) as Record<
      string,
      unknown
    >;

    delete raw.sourceIdentity;
    const legacy = decodeAnalyticsPresentation(raw);
    expect(legacy?.home["24h"]?.range).toBe("24h");
    expect(legacy?.sourceIdentity).toBeUndefined();

    expect(decodeAnalyticsPresentation({ ...raw, sourceIdentity: null })).toBeDefined();
    expect(decodeAnalyticsPresentation({ ...raw, sourceIdentity: [1, 2] })).toBeUndefined();
    expect(
      decodeAnalyticsPresentation({
        ...raw,
        sourceIdentity: ["/db", true, "ok", null, null, null, null, null, "extra"],
      }),
    ).toBeUndefined();
  });

  it("rejects unknown versions, schemas, malformed tuples, and duplicate identities", () => {
    const persisted = encodeAnalyticsState(withRows(), NOW);
    expect(decodeAnalyticsState({ ...persisted, version: 2 })).toBeUndefined();
    expect(decodeAnalyticsState({ ...persisted, schema: "other" })).toBeUndefined();
    expect(decodeAnalyticsState({ ...persisted, frontierAtMs: "soon" })).toBeUndefined();
    expect(decodeAnalyticsState({ ...persisted, sourceIdentity: [1, 2] })).toBeUndefined();
    expect(decodeAnalyticsState({ ...persisted, sourceCursorAtMs: "later" })).toBeUndefined();
    expect(decodeAnalyticsState({ ...persisted, lastFullRepairAtMs: Number.NaN })).toBeUndefined();
    expect(
      decodeAnalyticsState({ ...persisted, occurrences: [[99, "ses", "msg", null]] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsState({ ...persisted, fingerprints: [[1, 2, null, null, 1]] }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsState({ ...persisted, extent: { sinceMs: NOW, untilMs: NOW - 1 } }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsState({
        ...persisted,
        occurrences: [persisted.occurrences[0], persisted.occurrences[0]],
      }),
    ).toBeUndefined();
    expect(
      decodeAnalyticsState({
        ...persisted,
        presentation: { home: { "24h": { projects: [] } }, project: [] },
      }),
    ).toBeUndefined();
  });

  it("persists no compaction markers or agents (schema has no such fields)", () => {
    const persisted = encodeAnalyticsState(withRows(), NOW);
    expect(Object.keys(persisted)).not.toContain("compactions");
    expect(Object.keys(persisted)).not.toContain("agent");
  });
});

describe("analytics snapshot store", () => {
  it("returns undefined for a missing or corrupt file", async () => {
    const root = await tempRoot();
    const path = join(root, "snapshot.json");
    expect(await loadAnalyticsSnapshot(path)).toBeUndefined();

    await saveAnalyticsSnapshot(path, withRows(), NOW);
    const loaded = await loadAnalyticsSnapshot(path);
    expect(loaded?.occurrences.size).toBe(2);
  });

  it("captures the payload before async IO starts", async () => {
    const root = await tempRoot();
    const path = join(root, "snapshot.json");
    const state = withRows();
    const writing = saveAnalyticsSnapshot(path, state, NOW);
    state.frontierAtMs = NOW + 99_000;
    expect(await writing).toBe(true);
    const loaded = await loadAnalyticsSnapshot(path);
    expect(loaded?.frontierAtMs).toBe(NOW);
  });

  it("atomically replaces the snapshot and cleans temp files on failure", async () => {
    const root = await tempRoot();
    const path = join(root, "snapshot.json");
    expect(await saveAnalyticsSnapshot(path, withRows(), NOW)).toBe(true);
    const firstText = await readFile(path, "utf8");

    const second = withRows();
    second.frontierAtMs = NOW + 5_000;
    const failed = await saveAnalyticsSnapshot(path, second, NOW + 5_000, {
      beforeRename: () => {
        throw new Error("simulated crash before rename");
      },
    });
    expect(failed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(firstText);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);

    expect(await saveAnalyticsSnapshot(path, second, NOW + 5_000)).toBe(true);
    const reloaded = await loadAnalyticsSnapshot(path);
    expect(reloaded?.frontierAtMs).toBe(NOW + 5_000);
  });
});
