import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import type {
  CostedTokens,
  GuiSettingsStore,
  HomeSnapshot,
  ImportPreview,
  JsonValue,
  ProjectSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
} from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import { createGuiLogger } from "../src/gui/log.js";
import { createDashboardServer, type DashboardServerHandle } from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";
import { DEFAULT_SSE_HEARTBEAT_MS, DEFAULT_SSE_RETRY_MS } from "../src/gui/sse.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");

function costed(total: number): CostedTokens {
  return {
    input: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function usageFor(range: RangeKey, total: number): HomeSnapshot["usage"] {
  return {
    range,
    window: rangeWindow(range, NOW),
    bucketUnit: rangeBucketUnit(range),
    buckets: planRangeBuckets(range, NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
    totals: costed(total),
    stepCount: 1,
    sessionCount: 1,
    stale: false,
  };
}

function homeSnapshot(range: RangeKey): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
    usage: usageFor(range, 10),
    projects: [],
  };
}

function projectSnapshot(projectId: string, range: RangeKey): ProjectSnapshot {
  return {
    projectId,
    name: "Project",
    range,
    window: rangeWindow(range, NOW),
    roots: [],
    totals: { ...costed(0), sessionCount: 0 },
    usage: usageFor(range, 0),
    stale: false,
  };
}

function sessionSnapshot(sessionId: string): SessionSnapshot {
  return {
    focusSessionId: sessionId,
    projectId: "project-1",
    projectName: "Project",
    breadcrumbs: [{ sessionId, title: "Root", isFocus: true }],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...costed(0), stepCount: 0 },
    treeTotals: costed(0),
    stepSemantics: "one completed assistant message row is one step",
  };
}

interface FixtureState {
  homeCalls: number;
  polledAt?: number;
}

interface Fixtures {
  state: FixtureState;
  source: SnapshotSource;
  store: GuiSettingsStore;
}

function buildFixtures(): Fixtures {
  const state: FixtureState = { homeCalls: 0 };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      state.homeCalls += 1;
      state.polledAt = Date.now();
      return homeSnapshot(range);
    },
    project: async ({ projectId, range }) => projectSnapshot(projectId, range),
    session: async ({ sessionId }) => sessionSnapshot(sessionId),
  };
  const settingsPayload: SettingsSnapshot = {
    revision: "rev-1",
    pathLabel: "opencode-quota-gui/config.jsonc",
    values: { minIntervalMs: 300000 },
    sources: { minIntervalMs: "defaults" },
    writable: ["minIntervalMs"],
    dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
    visibility: { hiddenCards: [], hiddenRows: [] },
    import: { available: false, issues: [] },
    issues: [],
  };
  const store: GuiSettingsStore = {
    settings: async () => settingsPayload,
    saveSettings: async (input): Promise<SettingsWriteResult> => ({
      revision: "rev-2",
      applied: input.patch,
      warnings: [],
    }),
    saveVisibility: async (input): Promise<SettingsWriteResult> => ({
      revision: "rev-2",
      applied: {
        "dashboard.hiddenCards": input.hiddenCards,
        "dashboard.hiddenRows": input.hiddenRows,
      },
      warnings: [],
    }),
    importPreview: async (): Promise<ImportPreview> => ({
      from: "",
      keys: [],
      issues: [],
      expectedRevision: "rev-1",
    }),
    importApply: async (): Promise<SettingsWriteResult> => ({
      revision: "rev-2",
      applied: {},
      warnings: [],
    }),
  };
  return { state, source, store };
}

interface RunningServer {
  handle: DashboardServerHandle;
  state: FixtureState;
}

async function startServer(overrides: { heartbeatMs?: number; analyticsIntervalMs?: number } = {}) {
  const { state, source, store } = buildFixtures();
  const handle = await createDashboardServer({
    port: 0,
    source,
    settings: store,
    analyticsIntervalMs: overrides.analyticsIntervalMs,
    heartbeatMs: overrides.heartbeatMs,
    logger: createGuiLogger({ sink: () => {} }),
  });
  return { handle, state } satisfies RunningServer;
}

function base(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const step = () => {
      if (check()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for ${label}`));
      } else {
        setTimeout(step, 10);
      }
    };
    step();
  });
}

interface SseClient {
  text(): string;
  ended(): boolean;
  waitFor(predicate: (text: string) => boolean, label: string): Promise<void>;
  close(): void;
}

function openSse(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/api/v1/events",
        headers: { Accept: "text/event-stream" },
      },
      (res) => {
        settled = true;
        let text = "";
        let finished = false;
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => {
          finished = true;
        });
        resolve({
          text: () => text,
          ended: () => finished,
          waitFor: (predicate, label) => waitFor(() => predicate(text), label),
          close: () => {
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
    req.end();
  });
}

async function putJson(port: number, path: string, body: JsonValue): Promise<Response> {
  return fetch(`${base(port)}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GUI SSE stream", () => {
  it("exposes the frozen defaults", () => {
    expect(DEFAULT_SSE_HEARTBEAT_MS).toBe(20_000);
    expect(DEFAULT_SSE_RETRY_MS).toBe(3_000);
  });

  it("streams retry, heartbeats and default-message event frames", async () => {
    const { handle } = await startServer({ heartbeatMs: 40 });
    try {
      const client = await openSse(handle.port);
      await client.waitFor((text) => text.includes("retry: 3000"), "retry frame");
      await client.waitFor((text) => text.includes(": heartbeat"), "heartbeat frame");

      const response = await putJson(handle.port, "/api/v1/settings", {
        patch: { minIntervalMs: 1000 },
        expectedRevision: "rev-1",
      });
      expect(response.status).toBe(200);
      await client.waitFor((text) => text.includes("settings.changed"), "settings.changed frame");
      await client.waitFor((text) => text.includes('"topic":"settings.changed"'), "topic payload");

      const text = client.text();
      expect(text).not.toMatch(/(^|\n)id:/);
      expect(text).not.toMatch(/(^|\n)event: /);
      client.close();
    } finally {
      await handle.close();
    }
  });

  it("cleans up per client, polls while viewers exist, and dirties after the last disconnect", async () => {
    const { handle, state } = await startServer({ analyticsIntervalMs: 25 });
    try {
      const first = await fetch(`${base(handle.port)}/api/v1/home`);
      expect(first.status).toBe(200);
      expect(state.homeCalls).toBe(1);

      const a = await openSse(handle.port);
      const b = await openSse(handle.port);
      await waitFor(() => state.homeCalls >= 2, "viewer-driven poll tick");

      a.close();
      const response = await putJson(handle.port, "/api/v1/visibility", {
        hiddenCards: [],
        hiddenRows: [],
        expectedRevision: "rev-1",
      });
      expect(response.status).toBe(200);
      await b.waitFor((text) => text.includes('"scope":"visibility"'), "visibility frame");

      b.close();
      await delay(150);
      const callsAfterDisconnect = state.homeCalls;
      await delay(150);
      expect(state.homeCalls).toBe(callsAfterDisconnect);

      const refetch = await fetch(`${base(handle.port)}/api/v1/home`);
      expect(refetch.status).toBe(200);
      expect(state.homeCalls).toBe(callsAfterDisconnect + 1);
    } finally {
      await handle.close();
    }
  });

  it("close() disconnects stream clients and resolves promptly", async () => {
    const { handle } = await startServer({ heartbeatMs: 1000 });
    const client = await openSse(handle.port);
    await client.waitFor((text) => text.includes("retry: 3000"), "stream open");

    const started = Date.now();
    await handle.close();
    expect(Date.now() - started).toBeLessThan(1500);
    await waitFor(() => client.ended(), "stream end");
    await expect(fetch(`${base(handle.port)}/api/v1/health`)).rejects.toThrow();
  });
});
