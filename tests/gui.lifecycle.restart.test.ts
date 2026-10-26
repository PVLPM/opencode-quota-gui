import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CostedTokens,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import {
  type DashboardLease,
  type StartDashboardOptions,
  startDashboard,
} from "../src/gui/lifecycle.js";
import { createGuiLogger } from "../src/gui/log.js";
import {
  createDashboardServer,
  type DashboardServerHandle,
  type DashboardServerOptions,
} from "../src/gui/server.js";
import type { SnapshotSource } from "../src/gui/snapshot-service.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

const NOW = Date.parse("2026-10-26T09:00:00.000Z");

const dashboardClient = {
  config: {
    get: async () => ({ data: {} }),
    providers: async () => ({ data: { providers: [] } }),
  },
};

const silent = createGuiLogger({ sink: () => {} });

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
    timeZone: "UTC",
    buckets: planRangeBuckets(range, NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
    totals: costed(total),
    stepCount: 0,
    sessionCount: 0,
    stale: false,
  };
}

function homeSnapshot(range: RangeKey, marker: number): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range,
    stale: false,
    providers: { cards: [], enabledProviders: "auto", polledAtMs: NOW },
    usage: usageFor(range, marker),
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
  calls: { home: number; project: number; session: number; quota: number };
  readonly closes: number;
}

function buildSource(marker: number, stopOnClose = false): SourceFixture {
  const calls = { home: 0, project: 0, session: 0, quota: 0 };
  const state = { closes: 0 };
  const guard = () => {
    if (stopOnClose && state.closes > 0) throw new Error(`source ${marker} is closed`);
  };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      calls.home += 1;
      guard();
      return homeSnapshot(range, marker);
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
    quota: async () => {
      calls.quota += 1;
      guard();
      return {
        generatedAtMs: NOW,
        stale: false,
        providers: { cards: [], enabledProviders: [], polledAtMs: marker },
      } satisfies QuotaSnapshot;
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
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
  const blocker = createNetServer((socket) => socket.end());
  await listen(blocker, 0);
  const address = blocker.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  await closeServer(blocker);
  return address.port;
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

function runningUrl(lease: DashboardLease): string {
  if (lease.state !== "running" || lease.url === undefined) {
    throw new Error(`expected a running lease, got ${lease.state}`);
  }
  return lease.url;
}

async function postRestart(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${url}/api/v1/dashboard/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: response.status, body: await response.json() };
}

async function waitForHealth(
  url: string,
  restartId: string,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/v1/health`);
      if (response.ok) {
        const body: unknown = await response.json();
        if (
          typeof body === "object" &&
          body !== null &&
          (body as { restartId?: unknown }).restartId === restartId
        ) {
          return body as Record<string, unknown>;
        }
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`replacement listener did not become healthy: ${String(lastError)}`);
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Proves an attaching lease is still waiting rather than resolved unavailable. */
async function settledState(
  pending: Promise<DashboardLease>,
  timeoutMs = 500,
): Promise<"pending" | DashboardLease["state"]> {
  return Promise.race([
    pending.then((lease) => lease.state),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), timeoutMs)),
  ]);
}

function tokenOf(body: unknown): string {
  if (
    typeof body !== "object" ||
    body === null ||
    typeof (body as { restartId?: unknown }).restartId !== "string" ||
    (body as { restartId: string }).restartId.length === 0
  ) {
    throw new Error("restart acknowledgement has no token");
  }
  return (body as { restartId: string }).restartId;
}

const leases: DashboardLease[] = [];
const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("gui-restart-lifecycle-");
  workspaces.push(workspace);
  return workspace;
}

async function open(options: StartDashboardOptions): Promise<DashboardLease> {
  const lease = await startDashboard(options);
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

describe("dashboard restart lifecycle", () => {
  it("acknowledges, rebinds the same actual port, and serves a recreated source", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const first = buildSource(11);
    const second = buildSource(22);
    let creates = 0;
    let serverStarts = 0;

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        creates += 1;
        return creates === 1 ? first.source : second.source;
      },
      createServer: async (options: DashboardServerOptions) => {
        serverStarts += 1;
        return createDashboardServer(options);
      },
      logger: silent,
    });
    const url = runningUrl(lease);
    expect(new URL(url).port).toBe(String(port));
    expect(serverStarts).toBe(1);
    expect(creates).toBe(1);

    const before = (await (await fetch(`${url}/api/v1/health`)).json()) as Record<string, unknown>;
    expect(before.restartId).toBeUndefined();

    const ack = await postRestart(url);
    expect(ack.status).toBe(202);
    const restartId = tokenOf(ack.body);

    const health = await waitForHealth(url, restartId);
    expect(health).toMatchObject({
      app: "opencode-quota-gui",
      contractVersion: 2,
    });
    expect(new URL(url).port).toBe(String(port));
    expect(serverStarts).toBe(2);
    expect(first.closes).toBe(1);

    // The old listener's close released its source; the first read through the
    // replacement recreates it from the owner's factory.
    const home = await fetch(`${url}/api/v1/home?range=7d`);
    expect(home.status).toBe(200);
    expect(await home.json()).toMatchObject({ usage: { totals: { total: 22 } } });
    expect(creates).toBe(2);
    expect(second.calls.home).toBe(1);

    await lease.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(second.closes).toBe(1);
  });

  it("does not reuse a source creation invalidated by a restart during lazy handoff", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const sourceA = buildSource(11);
    const gatedSources: SourceFixture[] = [];
    let factoryCalls = 0;
    let factoryEntered = false;
    let releaseFactory!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let closeStarted = false;
    let closeStartedResolve!: () => void;
    const closeStartedPromise = new Promise<void>((resolve) => {
      closeStartedResolve = resolve;
    });

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      const handle = await createDashboardServer(options);
      return {
        ...handle,
        close: async () => {
          if (!closeStarted) {
            closeStarted = true;
            closeStartedResolve();
          }
          await handle.close();
        },
      };
    };

    const leaseA = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => sourceA.source,
      createServer,
      logger: silent,
    });
    const leaseB = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        factoryCalls += 1;
        const fixture = buildSource(20 + factoryCalls, true);
        gatedSources.push(fixture);
        if (factoryCalls === 1) {
          factoryEntered = true;
          return factoryGate.then(() => fixture.source);
        }
        return fixture.source;
      },
      createServer,
      logger: silent,
    });
    const url = runningUrl(leaseA);

    // A's dispose activates B without building its source yet.
    await leaseA.dispose();
    expect(sourceA.closes).toBe(1);

    // The first B read starts the gated factory; the listener is still serving.
    const oldRead = fetch(`${url}/api/v1/home?range=30d`).catch(() => undefined);
    await waitFor(() => factoryEntered);
    expect(gatedSources).toHaveLength(1);

    const ack = await postRestart(url);
    expect(ack.status).toBe(202);
    const restartId = tokenOf(ack.body);

    // Teardown registers the pending creation's release while the factory is
    // still unresolved.
    await closeStartedPromise;
    releaseFactory();
    await oldRead;

    await waitForHealth(url, restartId);
    const home = await fetch(`${url}/api/v1/home?range=7d`);
    expect(home.status).toBe(200);
    expect(await home.json()).toMatchObject({ usage: { totals: { total: 22 } } });

    // The invalidated creation was not published as reusable state: the
    // replacement read built a fresh source, and each source closed exactly once.
    expect(factoryCalls).toBe(2);
    expect(gatedSources).toHaveLength(2);
    expect(gatedSources[0]?.closes).toBe(1);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(gatedSources[1]?.closes).toBe(1);
    expect(sourceA.closes).toBe(1);
  });

  it("keeps an acknowledged request alive while shutdown is in flight and rejects a duplicate", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const { source } = buildSource(11);
    let serverStarts = 0;
    let closeStarted = false;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      const handle = await createDashboardServer(options);
      return {
        ...handle,
        close: async () => {
          closeStarted = true;
          await closeGate;
          await handle.close();
        },
      };
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer,
      logger: silent,
    });
    const url = runningUrl(lease);

    try {
      const ack = await postRestart(url);
      expect(ack.status).toBe(202);
      const restartId = tokenOf(ack.body);

      // Shutdown has begun but the old listener is still answering: the 202 was
      // delivered before any listener teardown.
      await waitFor(() => closeStarted);
      const oldHealth = await fetch(`${url}/api/v1/health`);
      expect(oldHealth.status).toBe(200);

      const duplicate = await postRestart(url);
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ error: { code: "restart-in-progress" } });

      releaseClose();
      await waitForHealth(url, restartId);
      expect(serverStarts).toBe(2);
    } finally {
      releaseClose();
    }
  });

  it("does not resurrect the listener when the last lease disposes during shutdown", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const { source } = buildSource(11);
    let serverStarts = 0;
    let closeStarted = false;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      const handle = await createDashboardServer(options);
      return {
        ...handle,
        close: async () => {
          closeStarted = true;
          await closeGate;
          await handle.close();
        },
      };
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer,
      logger: silent,
    });
    const url = runningUrl(lease);

    try {
      const ack = await postRestart(url);
      expect(ack.status).toBe(202);
      await waitFor(() => closeStarted);

      const disposal = lease.dispose();
      releaseClose();
      await disposal;
      expect(await tryBind(port)).toBe(true);
      expect(serverStarts).toBe(1);
    } finally {
      releaseClose();
    }
  });

  it("closes a replacement that finishes binding after the last lease disposes", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const { source } = buildSource(11);
    let serverStarts = 0;
    let releaseBind!: () => void;
    let bindEntered = false;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      if (serverStarts === 2) {
        bindEntered = true;
        await bindGate;
      }
      return createDashboardServer(options);
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer,
      logger: silent,
    });
    const url = runningUrl(lease);

    try {
      const ack = await postRestart(url);
      expect(ack.status).toBe(202);
      await waitFor(() => bindEntered);

      const disposal = lease.dispose();
      releaseBind();
      await disposal;
      expect(serverStarts).toBe(2);
      expect(await tryBind(port)).toBe(true);
    } finally {
      releaseBind();
    }
  });

  it("attaches a lease arriving during a gated restart close and uses the replacement", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const sourceA = buildSource(11);
    const sourceB = buildSource(22);
    let closeEntered = false;
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCalls = 0;

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      const handle = await createDashboardServer(options);
      return {
        ...handle,
        close: async () => {
          closeCalls += 1;
          if (closeCalls === 1) {
            closeEntered = true;
            await closeGate;
          }
          await handle.close();
        },
      };
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => sourceA.source,
      createServer,
      logger: silent,
    });
    const url = runningUrl(lease);

    try {
      const ack = await postRestart(url);
      expect(ack.status).toBe(202);
      const restartId = tokenOf(ack.body);
      await waitFor(() => closeEntered);

      const attaching = startDashboard({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => sourceB.source,
        createServer,
        logger: silent,
      });
      // The attach must wait for the replacement, not classify the transiently
      // absent handle as a permanent unavailable lease.
      expect(await settledState(attaching)).toBe("pending");

      releaseClose();
      await waitForHealth(url, restartId);
      const attached = await attaching;
      leases.push(attached);
      expect(attached.state).toBe("running");
      expect(attached.port).toBe(port);
      expect(attached.url).toBe(url);

      await lease.dispose();
      expect(await tryBind(port)).toBe(false);
      const health = await fetch(`${url}/api/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ restartId });
      const home = await fetch(`${url}/api/v1/home?range=7d`);
      expect(home.status).toBe(200);
      expect(await home.json()).toMatchObject({ usage: { totals: { total: 22 } } });

      await attached.dispose();
      expect(await tryBind(port)).toBe(true);
      expect(sourceB.closes).toBe(1);
    } finally {
      releaseClose();
    }
  });

  it("attaches a lease arriving while the replacement is still binding", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const sourceA = buildSource(11);
    const sourceB = buildSource(22);
    let bindEntered = false;
    let releaseBind!: () => void;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    let serverStarts = 0;

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      if (serverStarts === 2) {
        bindEntered = true;
        await bindGate;
      }
      return createDashboardServer(options);
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => sourceA.source,
      createServer,
      logger: silent,
    });
    const url = runningUrl(lease);

    try {
      const ack = await postRestart(url);
      expect(ack.status).toBe(202);
      const restartId = tokenOf(ack.body);
      await waitFor(() => bindEntered);

      const attaching = startDashboard({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => sourceB.source,
        createServer,
        logger: silent,
      });
      expect(await settledState(attaching)).toBe("pending");

      releaseBind();
      await waitForHealth(url, restartId);
      const attached = await attaching;
      leases.push(attached);
      expect(attached.state).toBe("running");
      expect(attached.port).toBe(port);
      expect(attached.url).toBe(url);

      await lease.dispose();
      expect(await tryBind(port)).toBe(false);
      const health = await fetch(`${url}/api/v1/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ restartId });
      const home = await fetch(`${url}/api/v1/home?range=7d`);
      expect(home.status).toBe(200);
      expect(await home.json()).toMatchObject({ usage: { totals: { total: 22 } } });

      await attached.dispose();
      expect(await tryBind(port)).toBe(true);
      expect(sourceB.closes).toBe(1);
    } finally {
      releaseBind();
    }
  });

  it("keeps original leases sharing the replacement and disposes it with the last lease", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const sourceA = buildSource(11);
    const sourceB = buildSource(22);
    let serverStarts = 0;
    const options: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => sourceA.source,
      createServer: async (serverOptions: DashboardServerOptions) => {
        serverStarts += 1;
        return createDashboardServer(serverOptions);
      },
      logger: silent,
    };

    const leaseA = await open(options);
    const leaseB = await open({ ...options, createSource: () => sourceB.source });
    const url = runningUrl(leaseA);
    expect(serverStarts).toBe(1);

    const ack = await postRestart(url);
    expect(ack.status).toBe(202);
    const restartId = tokenOf(ack.body);
    await waitForHealth(url, restartId);
    expect(serverStarts).toBe(2);

    await leaseA.dispose();
    // The surviving lease keeps the replacement listener and its generation.
    expect(await tryBind(port)).toBe(false);
    const health = await fetch(`${url}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ restartId });

    const home = await fetch(`${url}/api/v1/home?range=7d`);
    expect(home.status).toBe(200);
    expect(await home.json()).toMatchObject({ usage: { totals: { total: 22 } } });
    expect(sourceB.calls.home).toBe(1);
    expect(sourceA.closes).toBe(1);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(sourceB.closes).toBe(1);
  });

  it("allows a retry when the old listener survives a failed stop, and logs a controlled code", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const { source } = buildSource(11);
    const logs: string[] = [];
    let serverStarts = 0;
    let closeAttempts = 0;
    const privateFailure = Object.assign(new Error(`private path ${workspace.configDir}`), {
      code: "busy",
    });

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      const handle = await createDashboardServer(options);
      return {
        ...handle,
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw privateFailure;
          await handle.close();
        },
      };
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });
    const url = runningUrl(lease);

    const first = await postRestart(url);
    expect(first.status).toBe(202);
    await waitFor(() => closeAttempts === 1);
    await waitFor(() => logs.some((line) => line.includes("dashboard restart failed")));

    // The stop failed, so the old listener remains healthy and retryable.
    const oldHealth = await fetch(`${url}/api/v1/health`);
    expect(oldHealth.status).toBe(200);
    expect(await oldHealth.json()).not.toHaveProperty("restartId");

    const retry = await postRestart(url);
    expect(retry.status).toBe(202);
    const restartId = tokenOf(retry.body);
    await waitForHealth(url, restartId);
    expect(serverStarts).toBe(2);

    const failureLine = logs.find((line) => line.includes("dashboard restart failed")) ?? "";
    expect(failureLine).toContain("busy");
    expect(failureLine).not.toContain("private path");
    expect(failureLine).not.toContain(workspace.configDir);

    await lease.dispose();
    expect(await tryBind(port)).toBe(true);
  });

  it("logs a controlled failure when the replacement cannot bind and releases the host", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const { source } = buildSource(11);
    const logs: string[] = [];
    let serverStarts = 0;
    let blocker: NetServer | undefined;

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      if (serverStarts === 2) {
        blocker = createNetServer((socket) => socket.end());
        await listen(blocker, options.port);
      }
      return createDashboardServer(options);
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });
    const url = runningUrl(lease);

    try {
      const ack = await postRestart(url);
      expect(ack.status).toBe(202);
      await waitFor(() => logs.some((line) => line.includes("dashboard restart failed")));

      const failureLine = logs.find((line) => line.includes("dashboard restart failed")) ?? "";
      expect(failureLine).toContain("unavailable");
      expect(failureLine).not.toContain(workspace.configDir);
      expect(logs.some((line) => line.includes("dashboard server unavailable"))).toBe(true);
      expect(serverStarts).toBe(2);

      // The acknowledged stop completed; a genuine replacement bind failure
      // leaves no listener to retry through. The host still releases cleanly.
      expect(await tryBind(port)).toBe(false);
      await lease.dispose();
    } finally {
      if (blocker) await closeServer(blocker);
    }
    expect(await tryBind(port)).toBe(true);
  });

  it("rebinds the actual ephemeral port, not the configured startup port", async () => {
    const workspace = makeWorkspace();
    const configuredPort = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port: configuredPort } });
    const first = buildSource(11);
    const second = buildSource(22);
    let serverStarts = 0;

    const createServer = async (
      options: DashboardServerOptions,
    ): Promise<DashboardServerHandle> => {
      serverStarts += 1;
      // The first listener behaves like `port: 0`; later generations must follow
      // the actual bound port handed back by the host, never the config value.
      return createDashboardServer({
        ...options,
        port: serverStarts === 1 ? 0 : options.port,
      });
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => (serverStarts === 0 ? first.source : second.source),
      createServer,
      logger: silent,
    });
    const url = runningUrl(lease);
    const actualPort = Number(new URL(url).port);
    expect(actualPort).toBeGreaterThan(0);
    expect(actualPort).not.toBe(configuredPort);
    expect(serverStarts).toBe(1);

    const ack = await postRestart(url);
    expect(ack.status).toBe(202);
    const restartId = tokenOf(ack.body);
    await waitForHealth(url, restartId);
    expect(serverStarts).toBe(2);
    expect(Number(new URL(url).port)).toBe(actualPort);

    await lease.dispose();
    expect(await tryBind(actualPort)).toBe(true);
  });
});
