import { describe, expect, it } from "vitest";

import { type AnalyticsWorkerMemory, createAnalyticsEngine } from "../src/gui/analytics-engine.js";
import type { AnalyticsReader } from "../src/gui/analytics-reader.js";
import type {
  OpenCodeMessageRevision,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
  OpenCodeSourceIdentity,
  OpenCodeStorageSnapshot,
  OpenCodeStorageSnapshotResult,
} from "../src/lib/opencode-storage.js";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const INTERVAL = 600_000;

const PHASES = [
  "presentationLoad",
  "indexLoad",
  "metadataRead",
  "revisionDiscovery",
  "historicalPayloadRead",
  "changedPayloadRead",
  "modelUpdate",
  "dtoAggregation",
  "persistenceWrite",
] as const;

interface FakeDb {
  sessions: Record<string, OpenCodeSessionInfo>;
  projects: Record<string, OpenCodeProjectInfo>;
  rows: OpenCodeRawAssistantRow[];
  updatedAt: Map<string, number | null>;
  identity: OpenCodeSourceIdentity;
}

function session(id: string, projectID: string): OpenCodeSessionInfo {
  return {
    id,
    projectID,
    title: id,
    time: { created: NOW - 3_600_000, updated: NOW - 1_800_000 },
  };
}

function row(sessionID: string, messageID: string, atMs: number): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs: atMs,
    completedAtMs: atMs,
    tokens: {
      input: 100,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    providerID: "openai",
    modelID: "gpt-5",
    cost: 1,
  };
}

function baseDb(): FakeDb {
  return {
    sessions: { ses_metrics: session("ses_metrics", "p_metrics") },
    projects: { p_metrics: { id: "p_metrics", name: "Metrics", directories: [], worktrees: [] } },
    rows: [row("ses_metrics", "msg_metrics_a", NOW - 3_600_000)],
    updatedAt: new Map(),
    identity: {
      dbPath: "/metrics-db",
      exists: true,
      status: "ok",
      realPath: "/metrics-db",
      device: "1",
      inode: "1",
      birthtimeMs: 1,
      schemaToken: "session_v2(a)|session_message(a)",
      sizeBytes: 1,
      mtimeMs: 1,
    },
  };
}

function fakeReader(db: FakeDb): AnalyticsReader {
  const revisionsFor = (): OpenCodeMessageRevision[] =>
    db.rows.map((entry) => ({
      messageID: entry.messageID,
      sessionID: entry.sessionID,
      type: "assistant",
      createdAtMs: entry.createdAtMs,
      updatedAtMs: db.updatedAt.get(entry.messageID) ?? null,
      completedAtMs: entry.completedAtMs,
    }));

  return {
    async withSnapshot<T>(
      read: (snapshot: OpenCodeStorageSnapshot) => T | Promise<T>,
    ): Promise<OpenCodeStorageSnapshotResult<T>> {
      const snapshot: OpenCodeStorageSnapshot = {
        dbPath: db.identity.dbPath,
        identity: structuredClone(db.identity),
        readAllSessionsIndex: () => structuredClone(db.sessions),
        readProjectsIndex: () => structuredClone(db.projects),
        readCompletedAssistantRows: (params = {}) => {
          let rows = [...db.rows];
          if (params.messageIDs) {
            const ids = new Set(params.messageIDs);
            rows = rows.filter((entry) => ids.has(entry.messageID));
          }
          if (params.sessionIDs) {
            const ids = new Set(params.sessionIDs);
            rows = rows.filter((entry) => ids.has(entry.sessionID));
          }
          if (params.completedSinceMs !== undefined) {
            const sinceMs = params.completedSinceMs;
            rows = rows.filter((entry) => entry.completedAtMs >= sinceMs);
          }
          if (params.completedUntilMs !== undefined) {
            const untilMs = params.completedUntilMs;
            rows = rows.filter((entry) => entry.completedAtMs <= untilMs);
          }
          return rows;
        },
        readCompactionMarkers: () => [],
        readMessageRevisions: () => ({
          available: true,
          updatedAtAvailable: true,
          completedAtAvailable: true,
          revisions: revisionsFor(),
        }),
      };
      return { status: "ok", value: await read(snapshot) };
    },
  };
}

function createEngine(db: FakeDb): ReturnType<typeof createAnalyticsEngine> {
  return createAnalyticsEngine({
    reader: fakeReader(db),
    now: () => NOW,
    refreshIntervalMs: INTERVAL,
    snapshotPath: "metrics.json",
    loadSnapshot: async () => undefined,
    loadPresentation: async () => undefined,
    saveSnapshot: async () => true,
    savePresentation: async () => true,
  });
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function phase(stats: AnalyticsWorkerMemory, label: string) {
  const timing = stats.phases?.[label];
  if (!timing) throw new Error(`missing phase ${label}`);
  return timing;
}

describe("analytics engine: worker phase metrics", () => {
  it("reports every fixed label and counts a cold home's instrumented work", async () => {
    const engine = createEngine(baseDb());
    try {
      const initial = await engine.stats();
      expect(Object.keys(initial.phases ?? {}).sort()).toEqual([...PHASES].sort());
      for (const label of PHASES) {
        expect(phase(initial, label)).toEqual({ count: 0, totalMs: 0 });
      }

      await engine.home("24h");
      await flushAsync();
      const stats = await engine.stats();

      for (const label of [
        "presentationLoad",
        "indexLoad",
        "metadataRead",
        "revisionDiscovery",
        "historicalPayloadRead",
        "modelUpdate",
        "dtoAggregation",
        "persistenceWrite",
      ]) {
        expect(phase(stats, label).count).toBeGreaterThan(0);
        expect(phase(stats, label).totalMs).toBeGreaterThanOrEqual(0);
      }
      // A cold global read resolves every row in bulk; no changed-ID fetch.
      expect(phase(stats, "changedPayloadRead").count).toBe(0);

      expect(Object.keys(stats.phases ?? {}).sort()).toEqual([...PHASES].sort());
      for (const timing of Object.values(stats.phases ?? {})) {
        expect(Object.keys(timing).sort()).toEqual(["count", "totalMs"]);
        expect(Number.isInteger(timing.count)).toBe(true);
        expect(timing.count).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(timing.totalMs)).toBe(true);
        expect(timing.totalMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await engine.close();
    }
  });

  it("counts changed-ID payload and model update phases on an incremental refresh", async () => {
    const db = baseDb();
    const engine = createEngine(db);
    try {
      await engine.home("24h");
      await flushAsync();
      const before = await engine.stats();

      const target = db.rows[0];
      if (!target) throw new Error("expected a row");
      target.tokens.input = 250;
      db.updatedAt.set(target.messageID, NOW);
      await engine.refresh();
      await flushAsync();
      const after = await engine.stats();

      expect(phase(after, "changedPayloadRead").count).toBeGreaterThan(
        phase(before, "changedPayloadRead").count,
      );
      expect(phase(after, "modelUpdate").count).toBeGreaterThan(phase(before, "modelUpdate").count);
      // Metrics carry fixed labels and timings only, never source identities.
      const serialized = JSON.stringify(after.phases);
      expect(serialized).not.toContain("ses_");
      expect(serialized).not.toContain("msg_");
      expect(serialized).not.toContain("p_metrics");
      expect(serialized).not.toContain("metrics-db");
    } finally {
      await engine.close();
      await flushAsync();
    }
  });
});
