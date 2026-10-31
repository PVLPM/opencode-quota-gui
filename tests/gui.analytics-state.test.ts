import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeSnapshot, SessionSnapshot } from "../src/contracts/dashboard.js";
import { getAnalyticsPricingFingerprint } from "../src/gui/analytics-pricing-revision.js";
import {
  ANALYTICS_PRESENTATION_SESSION_LIMIT,
  ANALYTICS_PRESENTATION_VERSION,
  ANALYTICS_SNAPSHOT_SCHEMA,
  ANALYTICS_SNAPSHOT_VERSION,
  type AnalyticsState,
  decodeAnalyticsPresentation,
  decodeAnalyticsState,
  defaultAnalyticsPresentationPath,
  encodeAnalyticsPresentation,
  encodeAnalyticsState,
  fingerprintOf,
  loadAnalyticsPresentation,
  loadAnalyticsSnapshot,
  rowKey,
  saveAnalyticsPresentation,
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
      timeZone: "UTC",
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

function zeroTokens() {
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

function sessionSnapshot(
  sessionId: string,
  overrides: Partial<SessionSnapshot> = {},
): SessionSnapshot {
  return {
    focusSessionId: sessionId,
    projectId: "p1",
    projectName: "p1",
    breadcrumbs: [{ sessionId, title: sessionId, isFocus: true }],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...zeroTokens(), stepCount: 0 },
    treeTotals: zeroTokens(),
    stepSemantics: "test",
    ...overrides,
  };
}

function sessionEntries(count: number): Array<[string, SessionSnapshot]> {
  return Array.from({ length: count }, (_, index) => {
    const id = `ses_${index}`;
    return [id, sessionSnapshot(id, { stepSemantics: "x".repeat(200) })];
  });
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

it("roundtrips optional authoritative session agents and accepts legacy seven-field sessions", () => {
  const state = baseState();
  state.sessions.ses_parent!.agent = "session-authority";
  const encoded = encodeAnalyticsState(state, NOW);
  expect(
    decodeAnalyticsState(JSON.parse(JSON.stringify(encoded)))?.sessions.ses_parent?.agent,
  ).toBe("session-authority");
  for (const session of encoded.sessions) session.splice(7);
  expect(decodeAnalyticsState(encoded)?.sessions.ses_parent?.agent).toBeUndefined();
});

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
    expect(decoded?.savedAtMs).toBe(NOW);
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
    expect(decoded?.session).toEqual([]);
    expect(decoded?.sourceIdentity).toEqual(identity());
    expect(decoded?.savedAtMs).toBe(NOW);
    expect(decoded?.frontierAtMs).toBe(NOW);
    expect(decoded?.coverage).toEqual({ sinceMs: NOW - 3_600_000, untilMs: NOW });
    // The big index deliberately does not duplicate the presentation cache.
    const index = decodeAnalyticsState(
      JSON.parse(JSON.stringify(encodeAnalyticsState(state, NOW))) as unknown,
    );
    expect(index?.presentation).toBeUndefined();

    const withoutIdentity = withRows();
    delete withoutIdentity.sourceIdentity;
    expect(encodeAnalyticsPresentation(withoutIdentity, NOW).sourceIdentity).toBeNull();
  });

  it("invalidates warm DTOs when the combined pricing fingerprint changes", () => {
    const state = withRows();
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
    };
    const encoded = encodeAnalyticsPresentation(state, NOW);
    expect(encoded.pricingRevision).toBe(getAnalyticsPricingFingerprint());
    expect(
      decodeAnalyticsPresentation(JSON.parse(JSON.stringify(encoded)) as unknown),
    ).toBeDefined();

    const stale = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    stale.pricingRevision = `${encoded.pricingRevision}-stale`;
    expect(decodeAnalyticsPresentation(stale)).toBeUndefined();

    delete stale.pricingRevision;
    expect(decodeAnalyticsPresentation(stale)).toBeUndefined();
  });

  it("caps LRU session DTOs and does not mutate the live presentation cache", () => {
    const state = withRows();
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
      session: sessionEntries(10),
    };

    const encoded = encodeAnalyticsPresentation(state, NOW);
    expect(encoded.savedAtMs).toBe(NOW);
    expect(encoded.sourceIdentity).not.toBeNull();
    expect(encoded.presentation?.session).toHaveLength(ANALYTICS_PRESENTATION_SESSION_LIMIT);
    expect(encoded.presentation?.session?.map(([sessionId]) => sessionId)).toEqual([
      "ses_2",
      "ses_3",
      "ses_4",
      "ses_5",
      "ses_6",
      "ses_7",
      "ses_8",
      "ses_9",
    ]);
    // The encoder caps a copy, never the live LRU array.
    const liveSession = state.presentation.session;
    expect(liveSession).toHaveLength(10);
    expect(liveSession?.map(([sessionId]) => sessionId)).toEqual(
      Array.from({ length: 10 }, (_, index) => `ses_${index}`),
    );

    const decoded = decodeAnalyticsPresentation(JSON.parse(JSON.stringify(encoded)) as unknown);
    expect(decoded?.session).toHaveLength(ANALYTICS_PRESENTATION_SESSION_LIMIT);
    expect(decoded?.session?.map(([sessionId]) => sessionId)).toEqual([
      "ses_2",
      "ses_3",
      "ses_4",
      "ses_5",
      "ses_6",
      "ses_7",
      "ses_8",
      "ses_9",
    ]);
    // The compact index still never duplicates presentation DTOs.
    expect(encodeAnalyticsState(state, NOW).presentation).toBeNull();
  });

  it("treats missing sessions as empty and rejects malformed session data", () => {
    const state = withRows();
    state.presentation = { home: { "24h": homeSnapshot("24h") }, project: [] };
    const raw = JSON.parse(JSON.stringify(encodeAnalyticsPresentation(state, NOW))) as {
      presentation: { session?: unknown };
    };

    delete raw.presentation.session;
    expect(decodeAnalyticsPresentation(raw)?.session).toEqual([]);

    raw.presentation.session = "not-an-array";
    expect(decodeAnalyticsPresentation(raw)).toBeUndefined();

    raw.presentation.session = [["ses_mismatch", sessionSnapshot("ses_other")]];
    expect(decodeAnalyticsPresentation(raw)).toBeUndefined();

    raw.presentation.session = [
      ["ses_bad_arrays", sessionSnapshot("ses_bad_arrays", { nodes: {} as never })],
    ];
    expect(decodeAnalyticsPresentation(raw)).toBeUndefined();

    const duplicate = sessionSnapshot("ses_ok");
    raw.presentation.session = [
      ["ses_ok", duplicate],
      ["ses_ok", duplicate],
    ];
    expect(decodeAnalyticsPresentation(raw)).toBeUndefined();

    // A malformed ninth entry is outside the retained window but must still
    // invalidate the sidecar because all present entries are validated.
    raw.presentation.session = [
      ...sessionEntries(8),
      ["ses_bad_ninth", sessionSnapshot("ses_other")],
    ];
    expect(decodeAnalyticsPresentation(raw)).toBeUndefined();

    // A duplicate spanning the eviction boundary must also be rejected even
    // though only the newest eight entries are retained.
    const acrossBoundary = sessionEntries(9);
    acrossBoundary[0] = ["ses_8", sessionSnapshot("ses_8")];
    raw.presentation.session = acrossBoundary;
    expect(decodeAnalyticsPresentation(raw)).toBeUndefined();

    raw.presentation.session = sessionEntries(10);
    const capped = decodeAnalyticsPresentation(raw);
    expect(capped?.session).toHaveLength(ANALYTICS_PRESENTATION_SESSION_LIMIT);
    expect(capped?.session?.map(([sessionId]) => sessionId)).toEqual([
      "ses_2",
      "ses_3",
      "ses_4",
      "ses_5",
      "ses_6",
      "ses_7",
      "ses_8",
      "ses_9",
    ]);
  });

  it("rejects legacy warm DTO sidecars written before zero-token semantics", () => {
    const state = withRows();
    state.presentation = { home: { "24h": homeSnapshot("24h") }, project: [] };
    const encoded = encodeAnalyticsPresentation(state, NOW);
    expect(encoded.presentationVersion).toBe(ANALYTICS_PRESENTATION_VERSION);

    const legacy = JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
    delete legacy.presentationVersion;
    expect(decodeAnalyticsPresentation(legacy)).toBeUndefined();
    expect(
      decodeAnalyticsPresentation({
        ...legacy,
        presentationVersion: ANALYTICS_PRESENTATION_VERSION - 1,
      }),
    ).toBeUndefined();
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

  it("persists no compaction markers or assistant agents in the compact occurrence index", () => {
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

describe("analytics presentation store", () => {
  it("atomically replaces the sidecar and cleans temp files on failure", async () => {
    const root = await tempRoot();
    const compactPath = join(root, "analytics-v3.json");
    const sidecarPath = defaultAnalyticsPresentationPath(compactPath);
    await writeFile(compactPath, "x".repeat(100_000));
    const first = withRows();
    first.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
      session: sessionEntries(2),
    };
    expect(await saveAnalyticsPresentation(sidecarPath, first, NOW)).toBe(true);
    const firstText = await readFile(sidecarPath, "utf8");

    const second = withRows();
    second.presentation = {
      home: { "7d": homeSnapshot("7d") },
      project: [],
      session: sessionEntries(2),
    };
    const failed = await saveAnalyticsPresentation(sidecarPath, second, NOW + 1_000, {
      beforeRename: () => {
        throw new Error("simulated crash before rename");
      },
    });
    expect(failed).toBe(false);
    expect(await readFile(sidecarPath, "utf8")).toBe(firstText);
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("captures the presentation generation before async IO starts", async () => {
    const root = await tempRoot();
    const compactPath = join(root, "analytics-v3.json");
    const sidecarPath = defaultAnalyticsPresentationPath(compactPath);
    await writeFile(compactPath, "x".repeat(100_000));
    const state = withRows();
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
      session: sessionEntries(1),
    };

    const writing = saveAnalyticsPresentation(sidecarPath, state, NOW);
    state.presentation = {
      home: { "7d": homeSnapshot("7d") },
      project: [],
      session: sessionEntries(2),
    };
    expect(await writing).toBe(true);
    const loaded = await loadAnalyticsPresentation(sidecarPath);
    expect(Object.keys(loaded?.home ?? {})).toEqual(["24h"]);
    expect(loaded?.home["24h"]?.range).toBe("24h");
    expect(loaded?.session?.map(([sessionId]) => sessionId)).toEqual(["ses_0"]);
  });

  it("evicts LRU-oldest session DTOs to fit the compact snapshot budget", async () => {
    const root = await tempRoot();
    const compactPath = join(root, "analytics-v3.json");
    const sidecarPath = defaultAnalyticsPresentationPath(compactPath);
    const state = withRows();
    const ordered = sessionEntries(8);
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
      session: ordered,
    };
    const fullPayload = JSON.stringify(encodeAnalyticsPresentation(state, NOW));
    const budget = Buffer.byteLength(fullPayload, "utf8") - 1;
    await writeFile(compactPath, "x".repeat(budget));

    expect(await saveAnalyticsPresentation(sidecarPath, state, NOW)).toBe(true);
    const text = await readFile(sidecarPath, "utf8");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(budget);

    const loaded = await loadAnalyticsPresentation(sidecarPath);
    expect(loaded?.home["24h"]?.range).toBe("24h");
    expect(loaded?.sourceIdentity).toEqual(identity());
    const kept = loaded?.session ?? [];
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(ordered.length);
    expect(kept.map(([sessionId]) => sessionId)).toEqual(
      ordered.slice(ordered.length - kept.length).map(([sessionId]) => sessionId),
    );
  });

  it("preserves home/project while omitting sessions when base DTOs exceed the budget", async () => {
    const root = await tempRoot();
    const compactPath = join(root, "tiny.json");
    const sidecarPath = defaultAnalyticsPresentationPath(compactPath);
    await writeFile(compactPath, "x");
    const state = withRows();
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
      session: sessionEntries(8),
    };

    expect(await saveAnalyticsPresentation(sidecarPath, state, NOW)).toBe(true);
    const loaded = await loadAnalyticsPresentation(sidecarPath);
    expect(loaded?.home["24h"]?.range).toBe("24h");
    expect(loaded?.session).toEqual([]);
  });

  it("omits sessions when the compact snapshot is absent or the sidecar path is nonstandard", async () => {
    const root = await tempRoot();
    const state = withRows();
    state.presentation = {
      home: { "24h": homeSnapshot("24h") },
      project: [],
      session: sessionEntries(3),
    };

    const absentPath = join(root, "missing.presentation.json");
    expect(await saveAnalyticsPresentation(absentPath, state, NOW)).toBe(true);
    const absent = await loadAnalyticsPresentation(absentPath);
    expect(absent?.home["24h"]?.range).toBe("24h");
    expect(absent?.session).toEqual([]);

    const nonstandardPath = join(root, "sidecar.json");
    expect(await saveAnalyticsPresentation(nonstandardPath, state, NOW)).toBe(true);
    const nonstandard = await loadAnalyticsPresentation(nonstandardPath);
    expect(nonstandard?.home["24h"]?.range).toBe("24h");
    expect(nonstandard?.session).toEqual([]);
  });
});
