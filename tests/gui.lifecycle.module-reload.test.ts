import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CostedTokens,
  HomeSnapshot,
  ProjectSnapshot,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import type { DashboardLease, StartDashboardOptions } from "../src/gui/lifecycle.js";
import { createGuiLogger } from "../src/gui/log.js";
import { createDashboardServer, type DashboardServerOptions } from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

const NOW = Date.parse("2026-10-19T09:00:00.000Z");

const dashboardClient = {
  config: {
    get: async () => ({ data: {} }),
    providers: async () => ({ data: { providers: [] } }),
  },
};

const silent = createGuiLogger({ sink: () => {} });

type LifecycleModule = typeof import("../src/gui/lifecycle.js");

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

interface SourceFixture {
  source: SnapshotSource;
  calls: { home: number; project: number; session: number };
  readonly closes: number;
}

/**
 * `stopOnClose` makes every later read throw, simulating a plugin owner whose
 * client dies together with its dashboard lease.
 */
function buildSource(stopOnClose = false): SourceFixture {
  const calls = { home: 0, project: 0, session: 0 };
  const state = { closes: 0 };
  const guard = () => {
    if (stopOnClose && state.closes > 0) throw new Error("owner source closed");
  };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      calls.home += 1;
      guard();
      return homeSnapshot(range);
    },
    project: async ({ projectId, range }) => {
      calls.project += 1;
      guard();
      return projectSnapshot(projectId, range);
    },
    session: async ({ sessionId }) => {
      calls.session += 1;
      guard();
      return sessionSnapshot(sessionId);
    },
    close: async () => {
      state.closes += 1;
    },
  };
  return {
    source,
    calls,
    get closes() {
      return state.closes;
    },
  };
}

function listen(server: NetServer, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

function closeServer(server: NetServer): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function blockerOnFreePort(): Promise<{ port: number; close: () => Promise<void> }> {
  const blocker = createNetServer((socket) => socket.end());
  await listen(blocker, 0);
  const address = blocker.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { port: address.port, close: () => closeServer(blocker) };
}

async function freePort(): Promise<number> {
  const blocker = await blockerOnFreePort();
  await blocker.close();
  return blocker.port;
}

async function tryBind(port: number): Promise<boolean> {
  const probe = createNetServer();
  try {
    await listen(probe, port);
    return true;
  } catch {
    return false;
  } finally {
    await closeServer(probe);
  }
}

/**
 * Loads a genuinely separate module graph: `vi.resetModules` drops the module
 * registry, so the next import re-evaluates lifecycle and every module below it.
 */
async function loadGraph(): Promise<LifecycleModule> {
  vi.resetModules();
  return import("../src/gui/lifecycle.js");
}

function runningUrl(lease: DashboardLease): string {
  if (lease.state !== "running" || lease.url === undefined) {
    throw new Error(`expected a running lease, got ${lease.state}`);
  }
  return lease.url;
}

const leases: DashboardLease[] = [];
const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("gui-lifecycle-reload-");
  workspaces.push(workspace);
  return workspace;
}

function track(lease: DashboardLease): DashboardLease {
  leases.push(lease);
  return lease;
}

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) {
    await lease.dispose();
  }
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

describe("dashboard lifecycle across separately loaded module graphs", () => {
  it("shares one refcounted host, keeps it alive for the surviving graph, and reacquires it after the last dispose", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const sourceA = buildSource(true);
    const sourceB = buildSource();
    let bCreates = 0;
    let serverStarts = 0;
    const createServer = async (options: DashboardServerOptions) => {
      serverStarts += 1;
      return createDashboardServer(options);
    };

    const graphA = await loadGraph();
    const graphB = await loadGraph();
    expect(graphA.startDashboard).not.toBe(graphB.startDashboard);

    const commonA: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => sourceA.source,
      createServer,
      logger: silent,
    };
    const commonB: StartDashboardOptions = {
      ...commonA,
      createSource: () => {
        bCreates += 1;
        return sourceB.source;
      },
    };

    const leaseA = track(await graphA.startDashboard(commonA));
    expect(leaseA.state).toBe("running");
    expect(leaseA.port).toBe(port);

    const leaseB = track(await graphB.startDashboard(commonB));
    expect(leaseB.state).toBe("running");
    expect(leaseB.port).toBe(port);
    // Graph B attached to A's host instead of racing it for the port.
    expect(serverStarts).toBe(1);
    expect(sourceB.calls).toEqual({ home: 0, project: 0, session: 0 });

    const url = runningUrl(leaseA);
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);

    // The first owner's source serves the shared host.
    expect((await fetch(`${url}/api/v1/home?range=7d`)).status).toBe(200);
    expect(sourceA.calls.home).toBe(1);

    await leaseA.dispose();
    // A non-final dispose keeps the socket, but A's stopped source is released
    // and graph B's live owner takes over lazily on the next request.
    expect(await tryBind(port)).toBe(false);
    expect((await fetch(`${url}/api/v1/health`)).status).toBe(200);
    expect(sourceA.closes).toBe(1);
    expect(sourceB.calls).toEqual({ home: 0, project: 0, session: 0 });
    expect(bCreates).toBe(0);
    // A new range bypasses the snapshot cache and proves B's source serves now.
    expect((await fetch(`${url}/api/v1/home?range=30d`)).status).toBe(200);
    expect(bCreates).toBe(1);
    expect(sourceB.calls.home).toBe(1);
    expect(sourceA.calls.home).toBe(1);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(sourceB.closes).toBe(1);

    // Reacquisition after the last dispose creates a fresh host in graph B.
    const sourceC = buildSource();
    const reacquired = track(
      await graphB.startDashboard({ ...commonB, createSource: () => sourceC.source }),
    );
    expect(reacquired.state).toBe("running");
    expect(reacquired.port).toBe(port);
    expect(serverStarts).toBe(2);
    expect((await fetch(`${runningUrl(reacquired)}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${runningUrl(reacquired)}/api/v1/home?range=7d`)).status).toBe(200);
    expect(sourceC.calls.home).toBe(1);

    await reacquired.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(sourceC.closes).toBe(1);
  });

  it("classifies a source failure created by the owning graph and logs it once", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const logs: string[] = [];
    const logger = createGuiLogger({ sink: (line) => logs.push(line) });

    const graphA = await loadGraph();
    const graphB = await loadGraph();
    const failing: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        throw new Error(`source broke in ${workspace.configDir}`);
      },
      logger,
    };

    const leaseA = track(await graphA.startDashboard(failing));
    expect(leaseA.state).toBe("unavailable");
    expect(leaseA.reason).toBe("source-unavailable");
    expect(leaseA.port).toBe(port);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("source-unavailable");
    expect(logs[0]).not.toContain(workspace.configDir);

    // Graph B attaches to A's failed host. `instanceof` would not recognize A's
    // error class here; the structural code must preserve the reason.
    const leaseB = track(await graphB.startDashboard(failing));
    expect(leaseB.state).toBe("unavailable");
    expect(leaseB.reason).toBe("source-unavailable");
    expect(leaseB.port).toBe(port);
    expect(logs).toHaveLength(1);

    await leaseA.dispose();
    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);

    // The released failed host does not poison a later setup.
    const healthy = buildSource();
    const recovered = track(
      await graphB.startDashboard({
        ...failing,
        createSource: () => healthy.source,
      }),
    );
    expect(recovered.state).toBe("running");
    expect(recovered.port).toBe(port);
    await recovered.dispose();
    expect(await tryBind(port)).toBe(true);
  });

  it("classifies an actual EADDRINUSE from another graph as a terminal port failure", async () => {
    const workspace = makeWorkspace();
    const blocker = await blockerOnFreePort();
    try {
      writeGuiCanonicalConfig(workspace, { dashboard: { port: blocker.port } });
      const sourceFixture = buildSource();
      const logs: string[] = [];
      const logger = createGuiLogger({ sink: (line) => logs.push(line) });

      const graphA = await loadGraph();
      const graphB = await loadGraph();
      // A test-graph transport factory produces a DashboardBindError whose class
      // belongs to neither lifecycle graph, so graph A's start-host classifier
      // must recognize it structurally rather than with `instanceof`.
      const foreignServer = async (options: DashboardServerOptions) =>
        createDashboardServer(options);
      const options: StartDashboardOptions = {
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => sourceFixture.source,
        createServer: foreignServer,
        logger,
      };

      const leaseA = track(await graphA.startDashboard(options));
      expect(leaseA.state).toBe("unavailable");
      expect(leaseA.reason).toBe("port-unavailable");
      expect(leaseA.port).toBe(blocker.port);
      // The terminal bind failure released the source built before the bind.
      expect(sourceFixture.closes).toBe(1);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("EADDRINUSE");
      expect(logs[0]).not.toContain(workspace.configDir);

      const leaseB = track(await graphB.startDashboard(options));
      expect(leaseB.state).toBe("unavailable");
      expect(leaseB.reason).toBe("port-unavailable");
      expect(leaseB.port).toBe(blocker.port);
      // One controlled line per failed host, and no fallback port was bound.
      expect(logs).toHaveLength(1);

      await leaseA.dispose();
      await leaseB.dispose();
      expect(await tryBind(blocker.port)).toBe(false);
    } finally {
      await blocker.close();
    }
  });
});
