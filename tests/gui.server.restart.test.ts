import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  GuiSettingsStore,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import { createGuiLogger } from "../src/gui/log.js";
import {
  createDashboardServer,
  type DashboardRestartController,
  type DashboardRestartTicket,
  type DashboardServerHandle,
} from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";

const NOW = Date.parse("2026-10-26T09:00:00.000Z");
const INDEX_HTML = "<!doctype html><html><body></body></html>";

function costed(total: number): HomeSnapshot["usage"]["totals"] {
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

function usageFor(range: RangeKey): HomeSnapshot["usage"] {
  return {
    range,
    window: rangeWindow(range, NOW),
    bucketUnit: rangeBucketUnit(range),
    timeZone: "UTC",
    buckets: planRangeBuckets(range, NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
    totals: costed(1),
    stepCount: 0,
    sessionCount: 0,
    stale: false,
  };
}

function homeSnapshot(range: RangeKey): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
    usage: usageFor(range),
    projects: [],
  };
}

function quotaSnapshot(): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
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
    usage: usageFor(range),
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

function buildFixtures(): { source: SnapshotSource; store: GuiSettingsStore } {
  const source: SnapshotSource = {
    home: async ({ range }) => homeSnapshot(range),
    quota: async () => quotaSnapshot(),
    project: async ({ projectId, range }) => projectSnapshot(projectId, range),
    session: async ({ sessionId }) => sessionSnapshot(sessionId),
  };
  const settings: SettingsSnapshot = {
    revision: "rev-1",
    pathLabel: "opencode-quota-gui/config.jsonc",
    values: {},
    sources: {},
    writable: [],
    dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
    visibility: { hiddenCards: [], hiddenRows: [] },
    import: { available: false, issues: [] },
    issues: [],
  };
  const store: GuiSettingsStore = {
    settings: async () => settings,
    saveSettings: async (input) => ({ revision: "rev-2", applied: input.patch, warnings: [] }),
    saveVisibility: async (input) => ({
      revision: "rev-2",
      applied: {
        "dashboard.hiddenCards": input.hiddenCards,
        "dashboard.hiddenRows": input.hiddenRows,
      },
      warnings: [],
    }),
    importPreview: async () => ({ from: "none", keys: [], issues: [], expectedRevision: "rev-1" }),
    importApply: async () => ({ revision: "rev-2", applied: {}, warnings: [] }),
  };
  return { source, store };
}

interface ControllerSpy {
  controller: DashboardRestartController;
  runCalls: DashboardRestartTicket[];
  readonly begun: number;
}

function restartSpy(restartId = "restart-token"): ControllerSpy {
  let pending = false;
  const spy: ControllerSpy = {
    runCalls: [],
    begun: 0,
    controller: {
      begin() {
        if (pending) return { ok: false, code: "restart-in-progress" } as const;
        pending = true;
        spy.begun += 1;
        const ticket: DashboardRestartTicket = {
          restartId,
          run: async () => {
            spy.runCalls.push(ticket);
            pending = false;
          },
          cancel: () => {
            pending = false;
          },
        };
        return { ok: true, ticket } as const;
      },
    },
  };
  return spy;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let assetRoot = "";

beforeAll(async () => {
  assetRoot = await mkdtemp(join(tmpdir(), "gui-restart-routes-"));
  await writeFile(join(assetRoot, "index.html"), INDEX_HTML);
});

afterAll(async () => {
  if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
});

async function start(
  restart?: DashboardRestartController,
  restartId?: string,
): Promise<DashboardServerHandle> {
  const { source, store } = buildFixtures();
  return createDashboardServer({
    port: 0,
    source,
    settings: store,
    assetRoot,
    logger: createGuiLogger({ sink: () => {} }),
    ...(restart ? { restart } : {}),
    ...(restartId ? { restartId } : {}),
  });
}

function restartUrl(handle: DashboardServerHandle): string {
  return `${handle.url}/api/v1/dashboard/restart`;
}

async function restartFetch(
  handle: DashboardServerHandle,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(restartUrl(handle), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
    ...init,
  });
}

describe("dashboard restart route", () => {
  it("exposes POST only on /api/v1/dashboard/restart", async () => {
    const handle = await start(restartSpy().controller);
    try {
      for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
        const response = await fetch(restartUrl(handle), { method });
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
    } finally {
      await handle.close();
    }
  });

  it("returns a controlled 503 when the host is not lifecycle managed", async () => {
    const handle = await start();
    try {
      const response = await restartFetch(handle);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: {
          code: "restart-unavailable",
          message: "Dashboard restart is not available",
        },
      });
    } finally {
      await handle.close();
    }
  });

  it("acknowledges with a restart token without waiting for the replacement to stop", async () => {
    let releaseRun!: () => void;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let runStarted = false;
    const controller: DashboardRestartController = {
      begin: () => ({
        ok: true,
        ticket: {
          restartId: "generation-2",
          run: async () => {
            runStarted = true;
            await runGate;
          },
          cancel: () => {},
        },
      }),
    };
    const handle = await start(controller);
    try {
      // A generation token is only advertised by a replacement listener.
      const before = await fetch(`${handle.url}/api/v1/health`);
      expect(await before.json()).not.toHaveProperty("restartId");

      const response = await restartFetch(handle);
      expect(response.status).toBe(202);
      expect(await response.json()).toEqual({ restartId: "generation-2" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");

      // The 202 is complete while the shutdown work is still blocked.
      await waitFor(() => runStarted);
      releaseRun();
    } finally {
      releaseRun();
      await handle.close();
    }
  });

  it("advertises a replacement token in health only when one is supplied", async () => {
    const handle = await start(restartSpy().controller, "generation-2");
    try {
      const response = await fetch(`${handle.url}/api/v1/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        app: "opencode-quota-gui",
        contractVersion: 2,
        restartId: "generation-2",
      });
    } finally {
      await handle.close();
    }
  });

  it("requires an empty JSON object body", async () => {
    const spy = restartSpy();
    const handle = await start(spy.controller);
    try {
      for (const body of ["", "not json", "[]", '{"extra":true}']) {
        const response = await restartFetch(handle, { body });
        expect(response.status).toBe(400);
      }
      expect(spy.begun).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("keeps the existing Origin, Sec-Fetch-Site and JSON media-type guards", async () => {
    const spy = restartSpy();
    const handle = await start(spy.controller);
    try {
      const foreignOrigin = await restartFetch(handle, {
        headers: {
          "content-type": "application/json",
          origin: "http://evil.example",
        },
      });
      expect(foreignOrigin.status).toBe(403);
      expect(await foreignOrigin.json()).toMatchObject({ error: { code: "bad-origin" } });

      const crossSite = await restartFetch(handle, {
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        },
      });
      expect(crossSite.status).toBe(403);

      const wrongType = await restartFetch(handle, {
        headers: { "content-type": "text/plain" },
      });
      expect(wrongType.status).toBe(415);
      expect(await wrongType.json()).toMatchObject({
        error: { code: "unsupported-media-type" },
      });

      const absentType = await fetch(restartUrl(handle), { method: "POST", body: "{}" });
      expect(absentType.status).toBe(415);

      const accepted = await restartFetch(handle, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          origin: `http://localhost:${handle.port}`,
          "sec-fetch-site": "same-origin",
        },
      });
      expect(accepted.status).toBe(202);
      expect(spy.begun).toBe(1);
    } finally {
      await handle.close();
    }
  });

  it("deduplicates an in-flight restart behind a controlled 409", async () => {
    let begun = 0;
    let pending = false;
    const controller: DashboardRestartController = {
      begin() {
        if (pending) return { ok: false, code: "restart-in-progress" };
        pending = true;
        begun += 1;
        return {
          ok: true,
          ticket: {
            restartId: "generation-2",
            // The replacement work stays in flight for the duration of the test.
            run: () => new Promise<void>(() => {}),
            cancel: () => {
              pending = false;
            },
          },
        };
      },
    };
    const handle = await start(controller);
    try {
      const first = await restartFetch(handle);
      expect(first.status).toBe(202);
      const duplicate = await restartFetch(handle);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({
        error: { code: "restart-in-progress" },
      });
      expect(begun).toBe(1);
    } finally {
      await handle.close();
    }
  });
});
