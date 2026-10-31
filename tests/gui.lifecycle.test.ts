import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { encodeAnalyticsEntityToken } from "../src/contracts/analytics-entity.js";
import type {
  AnalyticsGroupQuery,
  AnalyticsGroupSnapshot,
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
import {
  createSnapshotService,
  type SnapshotService,
  type SnapshotServiceOptions,
  type SnapshotSource,
} from "../src/gui/snapshot-service.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
  writeQuotaSidecarConfig,
} from "./helpers/config-loader-test-harness.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");

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

function groupSnapshot(query: AnalyticsGroupQuery, marker: number): AnalyticsGroupSnapshot {
  return {
    dimension: query.dimension,
    range: query.range,
    window: rangeWindow(query.range, NOW),
    bucketUnit: rangeBucketUnit(query.range),
    timeZone: "UTC",
    ...(query.filter ? { filter: query.filter } : {}),
    buckets: planRangeBuckets(query.range, NOW).map(({ startMs, endMs }) => ({ startMs, endMs })),
    totals: costed(marker),
    sessionCount: 0,
    stepCount: 0,
    rows: [],
    series: [],
    stale: false,
  };
}

interface SourceFixture {
  source: SnapshotSource;
  calls: { home: number; project: number; session: number; groups: number };
}

function buildSource(): SourceFixture {
  const calls = { home: 0, project: 0, session: 0, groups: 0 };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      calls.home += 1;
      return homeSnapshot(range);
    },
    project: async ({ projectId, range }) => {
      calls.project += 1;
      return projectSnapshot(projectId, range);
    },
    session: async ({ sessionId }) => {
      calls.session += 1;
      return sessionSnapshot(sessionId);
    },
    groups: async (query) => {
      calls.groups += 1;
      return groupSnapshot(query, 0);
    },
  };
  return { source, calls };
}

interface OwnerSourceFixture {
  source: SnapshotSource;
  calls: { home: number; project: number; session: number; quota: number; groups: number };
  readonly closes: number;
  readonly groupQueries: AnalyticsGroupQuery[];
  /** When set, every read throws; simulates a delegate whose client died. */
  fails: boolean;
}

function quotaSnapshot(marker: number): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    providers: { cards: [], enabledProviders: [], polledAtMs: marker },
  };
}

/**
 * An owner-lifetime source: its marker identifies the owner, `close()` stops
 * every later read (a disposed plugin's client is gone), and `fails` simulates
 * a live delegate whose reads fail.
 */
function buildOwnerSource(marker: number): OwnerSourceFixture {
  const calls = { home: 0, project: 0, session: 0, quota: 0, groups: 0 };
  const groupQueries: AnalyticsGroupQuery[] = [];
  const state = { closes: 0, fails: false };
  const guard = () => {
    if (state.fails || state.closes > 0) throw new Error(`owner source ${marker} unavailable`);
  };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      calls.home += 1;
      guard();
      return { ...homeSnapshot(range), usage: usageFor(range, marker) };
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
      return quotaSnapshot(marker);
    },
    groups: async (query) => {
      calls.groups += 1;
      groupQueries.push(query);
      guard();
      return groupSnapshot(query, marker);
    },
    close: async () => {
      state.closes += 1;
    },
  };
  return {
    source,
    calls,
    groupQueries,
    get closes() {
      return state.closes;
    },
    get fails() {
      return state.fails;
    },
    set fails(value: boolean) {
      state.fails = value;
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
        res.resume();
        resolve({
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

const leases: DashboardLease[] = [];
const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("gui-p4b-lifecycle-");
  workspaces.push(workspace);
  return workspace;
}

async function open(options: StartDashboardOptions): Promise<DashboardLease> {
  const lease = await startDashboard(options);
  leases.push(lease);
  return lease;
}

function fakeHandle(port: number): DashboardServerHandle {
  return { port, url: `http://127.0.0.1:${port}`, close: async () => {} };
}

/** Narrow a test fixture list entry without a non-null assertion. */
function fixtureAt<T>(entries: readonly T[], index: number): T {
  const entry = entries[index];
  if (entry === undefined) throw new Error(`test fixture ${index} is missing`);
  return entry;
}

interface IntervalCapture {
  createSnapshots: (options: SnapshotServiceOptions) => SnapshotService;
  read: () => number;
}

/** Wraps the real snapshot factory to capture the effective poll-interval getter. */
function captureInterval(): IntervalCapture {
  let interval: (() => number) | undefined;
  return {
    createSnapshots: (options) => {
      interval = typeof options.minIntervalMs === "function" ? options.minIntervalMs : undefined;
      return createSnapshotService(options);
    },
    read: () => {
      if (!interval) throw new Error("no interval getter was captured");
      return interval();
    },
  };
}

interface SnapshotCapture {
  createSnapshots: (options: SnapshotServiceOptions) => SnapshotService;
  readonly created: SnapshotService[];
  readonly closes: number;
  readonly viewers: number;
}

/** Wraps the real snapshot service to count host-scoped creation and cleanup. */
function captureSnapshots(): SnapshotCapture {
  const created: SnapshotService[] = [];
  let closes = 0;
  let viewers = 0;
  return {
    created,
    get closes() {
      return closes;
    },
    get viewers() {
      return viewers;
    },
    createSnapshots: (options) => {
      const service = createSnapshotService(options);
      const close = service.close.bind(service);
      let closed = false;
      service.close = () => {
        if (closed) return;
        closed = true;
        closes += 1;
        close();
      };
      const addViewer = service.addViewer.bind(service);
      service.addViewer = () => {
        viewers += 1;
        const release = addViewer();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          viewers -= 1;
          release();
        };
      };
      created.push(service);
      return service;
    },
  };
}

async function readJson(port: number, path: string): Promise<JsonValue | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(response.status).toBe(200);
  return await response.json();
}

/** Raw loopback request so tests can set a Host header fetch forbids. */
function rawStatus(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

async function writeJson(
  port: number,
  path: string,
  method: "PUT" | "POST",
  body: JsonValue,
): Promise<{ status: number; body: JsonValue | undefined }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) {
    await lease.dispose();
  }
  for (const workspace of workspaces.splice(0)) {
    workspace.cleanup();
  }
});

describe("dashboard production lifecycle", () => {
  it.each([
    ["absent (upgrade)", {}],
    ["explicitly false", { enabled: false }],
  ] as const)("keeps the shared runtime available and starts no web transport when enabled is %s", async (_label, dashboard) => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { ...dashboard, port } });
    const owner = buildOwnerSource(7);
    let refreshes = 0;
    const source = {
      ...owner.source,
      refreshAnalytics: async () => {
        refreshes += 1;
      },
    };
    const snapshots = captureSnapshots();
    let serverStarts = 0;

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createSnapshots: snapshots.createSnapshots,
      createServer: async (options) => {
        serverStarts += 1;
        return createDashboardServer(options);
      },
      logger: silent,
    });

    // The shared host runtime is running, but there is no web address.
    expect(lease.state).toBe("running");
    expect(lease.port).toBe(port);
    expect(lease.url).toBeUndefined();
    expect(serverStarts).toBe(0);
    expect(await tryBind(port)).toBe(true);

    // One host-owned snapshot service exists, with no viewer/poller and no
    // analytics refresh behind it, and it remains usable by a future transport.
    expect(snapshots.created).toHaveLength(1);
    expect(snapshots.viewers).toBe(0);
    expect(refreshes).toBe(0);
    expect(snapshots.closes).toBe(0);
    expect((await fixtureAt(snapshots.created, 0).home({ range: "7d" })).range).toBe("7d");
    expect(owner.calls.home).toBe(1);

    await lease.dispose();
    expect(snapshots.closes).toBe(1);
    expect(owner.closes).toBe(1);
  });

  it("keeps the web-less runtime and owner handoff alive while a lease remains", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    // `dashboard.enabled` absent: the upgrade/default-off path.
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const owners = [buildOwnerSource(1), buildOwnerSource(2)];
    let createdSources = 0;
    const snapshots = captureSnapshots();
    const options: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        const owner = owners[createdSources];
        createdSources += 1;
        if (!owner) throw new Error("unexpected source request");
        return owner.source;
      },
      createSnapshots: snapshots.createSnapshots,
      logger: silent,
    };

    // Start sequentially so this test observes the first owner's handoff
    // deterministically; concurrent setup order is covered elsewhere.
    const first = await open(options);
    const second = await open(options);
    expect(first.url).toBeUndefined();
    expect(second.url).toBeUndefined();
    expect(snapshots.created).toHaveLength(1);
    expect(snapshots.viewers).toBe(0);
    expect(await tryBind(port)).toBe(true);
    // Only the first active owner's source is eagerly created.
    expect(createdSources).toBe(1);

    await fixtureAt(snapshots.created, 0).home({ range: "7d" });
    expect(fixtureAt(owners, 0).calls.home).toBe(1);

    await first.dispose();
    // The surviving lease keeps the cache owner and runtime alive; the next read
    // hand off to its lazily created source after invalidation.
    expect(snapshots.closes).toBe(0);
    expect(fixtureAt(owners, 0).closes).toBe(1);
    expect(createdSources).toBe(1);
    await fixtureAt(snapshots.created, 0).home({ range: "7d" });
    expect(createdSources).toBe(2);
    expect(fixtureAt(owners, 1).calls.home).toBe(1);
    expect(await tryBind(port)).toBe(true);

    await second.dispose();
    expect(snapshots.closes).toBe(1);
    expect(fixtureAt(owners, 1).closes).toBe(1);
    expect(await tryBind(port)).toBe(true);
  });

  it("applies dashboard.enabled only when the dashboard lifecycle restarts", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    let currentSource = buildSource().source;
    const snapshots = captureSnapshots();
    let serverStarts = 0;
    const options: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => currentSource,
      createSnapshots: snapshots.createSnapshots,
      createServer: async (serverOptions) => {
        serverStarts += 1;
        return createDashboardServer(serverOptions);
      },
      logger: silent,
    };

    const disabled = await open(options);
    expect(disabled.state).toBe("running");
    expect(disabled.url).toBeUndefined();
    expect(serverStarts).toBe(0);

    // A manual canonical JSONC edit is not a live control: the current lease
    // stays web-less and binds nothing.
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    expect(serverStarts).toBe(0);
    expect(await tryBind(port)).toBe(true);
    await disabled.dispose();
    expect(snapshots.closes).toBe(1);

    // The next lifecycle reads the same canonical file and starts the fixed
    // loopback port. This is the recovery/restart boundary the docs describe.
    currentSource = buildSource().source;
    const enabled = await open(options);
    expect(enabled.state).toBe("running");
    expect(enabled.url).toBe(`http://127.0.0.1:${port}`);
    expect(serverStarts).toBe(1);
    expect((await fetch(`${enabled.url}/api/v1/health`)).status).toBe(200);
    await enabled.dispose();
    expect(snapshots.closes).toBe(2);
    expect(await tryBind(port)).toBe(true);
  });

  it("binds the configured port and computes the first snapshot only on request", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source, calls } = buildSource();

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      logger: silent,
    });

    expect(lease.state).toBe("running");
    expect(lease.port).toBe(port);
    expect(lease.url).toBe(`http://127.0.0.1:${port}`);
    // Bind only: startup reads no provider data and no snapshots.
    expect(calls).toEqual({ home: 0, project: 0, session: 0, groups: 0 });

    const health = await fetch(`${lease.url}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      app: "opencode-quota-gui",
      contractVersion: 2,
      version: expect.any(String),
      build: expect.any(String),
    });

    const home = await fetch(`${lease.url}/api/v1/home?range=7d`);
    expect(home.status).toBe(200);
    expect(calls.home).toBe(1);

    // Enabling Web keeps the existing loopback Host guard.
    expect(await rawStatus(port, "/api/v1/health", "evil.example")).toBe(403);

    await lease.dispose();
    expect(await tryBind(port)).toBe(true);
  });

  it("shares one host across concurrent setups and closes it only with the last lease", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source, calls } = buildSource();
    let serverStarts = 0;
    const createServer = async (options: DashboardServerOptions) => {
      serverStarts += 1;
      return createDashboardServer(options);
    };

    const options: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer,
      logger: silent,
    };
    const [first, second] = await Promise.all([open(options), open(options)]);

    expect(serverStarts).toBe(1);
    expect(first.state).toBe("running");
    expect(second.state).toBe("running");
    expect(first.port).toBe(port);
    expect(second.port).toBe(port);

    await first.dispose();
    // The surviving lease keeps the host bound; the non-final dispose never closes it.
    expect(await tryBind(port)).toBe(false);
    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(health.status).toBe(200);

    await second.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(calls).toEqual({ home: 0, project: 0, session: 0, groups: 0 });
  });

  it("hands off to a live owner's source when the first owner disposes without dropping the socket", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const first = buildOwnerSource(11);
    const second = buildOwnerSource(22);
    let firstCreates = 0;
    let secondCreates = 0;

    const leaseA = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        firstCreates += 1;
        return first.source;
      },
      logger: silent,
    });
    const leaseB = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        secondCreates += 1;
        return second.source;
      },
      logger: silent,
    });
    expect(leaseA.state).toBe("running");
    expect(leaseB.state).toBe("running");
    // The first owner's source is built eagerly; the attached owner's is not.
    expect(firstCreates).toBe(1);
    expect(secondCreates).toBe(0);

    // The first owner serves while it is live.
    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      usage: { totals: { total: 11 } },
    });
    expect(first.calls.home).toBe(1);

    await leaseA.dispose();
    // The socket survives, the disposed owner's source is closed, and the live
    // delegate source is still not built just because it became active.
    expect(await tryBind(port)).toBe(false);
    expect(first.closes).toBe(1);
    expect(secondCreates).toBe(0);
    expect(second.calls).toEqual({ home: 0, project: 0, session: 0, quota: 0, groups: 0 });

    // The surviving owner serves analytics and quota on the same port, lazily.
    expect(await readJson(port, "/api/v1/home?range=30d")).toMatchObject({
      usage: { totals: { total: 22 } },
    });
    expect(secondCreates).toBe(1);
    expect(second.calls.home).toBe(1);
    expect(first.calls.home).toBe(1);
    expect(await readJson(port, "/api/v1/quota")).toMatchObject({
      providers: { polledAtMs: 22 },
    });
    expect(secondCreates).toBe(1);
    expect(second.calls.quota).toBe(1);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(second.closes).toBe(1);
    // The first source was closed exactly once, at its own owner's disposal.
    expect(first.closes).toBe(1);
  });

  it("recomputes the same cached page through the surviving owner after a handoff", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const first = buildOwnerSource(11);
    const second = buildOwnerSource(22);
    let secondCreates = 0;

    const leaseA = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => first.source,
      logger: silent,
    });
    const leaseB = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        secondCreates += 1;
        return second.source;
      },
      logger: silent,
    });

    // Cache the first owner's page and quota under the shared snapshot service.
    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      stale: false,
      usage: { totals: { total: 11 } },
    });
    expect(await readJson(port, "/api/v1/quota")).toMatchObject({
      providers: { polledAtMs: 11 },
    });
    expect(secondCreates).toBe(0);

    await leaseA.dispose();
    expect(await tryBind(port)).toBe(false);

    // The same keys must not serve the previous owner's fresh cache: the
    // surviving owner is asked and its results replace the entries.
    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      stale: false,
      usage: { totals: { total: 22 } },
    });
    expect(await readJson(port, "/api/v1/quota")).toMatchObject({
      providers: { polledAtMs: 22 },
    });
    expect(secondCreates).toBe(1);
    expect(second.calls.home).toBe(1);
    expect(second.calls.quota).toBe(1);
    expect(first.calls.home).toBe(1);
    expect(first.calls.quota).toBe(1);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(first.closes).toBe(1);
    expect(second.closes).toBe(1);
  });

  it("keeps stale-markable pages but not session payloads after a handoff failure", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const first = buildOwnerSource(11);
    const second = buildOwnerSource(22);

    const leaseA = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => first.source,
      logger: silent,
    });
    const leaseB = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => second.source,
      logger: silent,
    });

    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      stale: false,
      usage: { totals: { total: 11 } },
    });
    expect(await readJson(port, "/api/v1/sessions/s1")).toMatchObject({
      focusSessionId: "s1",
    });

    await leaseA.dispose();
    second.fails = true;

    // Home can represent last-good data as stale. Session has no stale marker,
    // so the post-handoff failure must surface instead of returning A's page.
    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      stale: true,
      usage: { totals: { total: 11 } },
    });
    const session = await fetch(`http://127.0.0.1:${port}/api/v1/sessions/s1`);
    expect(session.status).toBe(500);
    expect(await session.json()).toMatchObject({ error: { code: "internal" } });
    expect(second.calls.session).toBe(1);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
  });

  it("keeps the shared snapshot runtime usable after a web bind failure", async () => {
    const workspace = makeWorkspace();
    const blocker = await blockerOnFreePort();
    try {
      writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port: blocker.port } });
      const owner = buildOwnerSource(41);
      const snapshots = captureSnapshots();
      const options: StartDashboardOptions = {
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => owner.source,
        createSnapshots: snapshots.createSnapshots,
        logger: silent,
      };

      const first = await open(options);
      expect(first.state).toBe("unavailable");
      expect(first.reason).toBe("port-unavailable");
      expect(snapshots.created).toHaveLength(1);
      // The web transport failed, not the shared runtime: no viewer or poller
      // exists, and the cache/source still answer a native-side read.
      expect(snapshots.viewers).toBe(0);
      expect(snapshots.closes).toBe(0);
      expect(owner.closes).toBe(0);
      expect((await fixtureAt(snapshots.created, 0).home({ range: "7d" })).range).toBe("7d");
      expect(owner.calls.home).toBe(1);

      // A later lease joins the failed web host instead of constructing a second
      // runtime, and the host still logs/closes only once.
      const second = await open(options);
      expect(second.state).toBe("unavailable");
      expect(second.reason).toBe("port-unavailable");
      expect(snapshots.created).toHaveLength(1);
      expect(snapshots.closes).toBe(0);

      await first.dispose();
      expect(snapshots.closes).toBe(0);
      // The disposed owner's source is released with its lease; the surviving
      // lease keeps the host runtime and its snapshot service.
      expect(owner.closes).toBe(1);
      await second.dispose();
      expect(snapshots.closes).toBe(1);
      expect(owner.closes).toBe(1);
      expect(await tryBind(blocker.port)).toBe(false);
    } finally {
      await blocker.close();
    }
  });

  it("keeps one shared snapshot runtime open until the last lease disposes", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const snapshots = captureSnapshots();
    const received: SnapshotService[] = [];

    const options: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createSnapshots: snapshots.createSnapshots,
      createServer: async (serverOptions) => {
        received.push(serverOptions.snapshots);
        return createDashboardServer(serverOptions);
      },
      logger: silent,
    };
    const [first, second] = await Promise.all([open(options), open(options)]);
    expect(snapshots.created).toHaveLength(1);
    expect(snapshots.closes).toBe(0);
    // The transport receives the host's one snapshot service; it does not make
    // its own.
    expect(received).toEqual([snapshots.created[0]]);

    await first.dispose();
    expect(await tryBind(port)).toBe(false);
    expect(snapshots.closes).toBe(0);
    expect((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status).toBe(200);

    await second.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(snapshots.closes).toBe(1);
  });

  it("ignores a legacy v2 host record that predates the shared runtime", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const legacyKey = Symbol.for("opencode-quota-gui/dashboard-lifecycle/v2");
    const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = globalState[legacyKey];
    let legacyCloses = 0;
    const legacyHost = {
      port,
      logger: silent,
      delegation: { owners: [] },
      refs: 1,
      start: Promise.resolve({
        port: 1,
        url: "http://127.0.0.1:1",
        close: async () => {
          legacyCloses += 1;
        },
      }),
    };
    globalState[legacyKey] = { hosts: new Map([[port, legacyHost]]) };

    let lease: DashboardLease | undefined;
    try {
      lease = await startDashboard({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => source,
        logger: silent,
      });
      // A record from the old registry shape lacks the host runtime and cannot
      // be safely mutated, so it must not be adopted.
      expect(lease.state).toBe("running");
      expect(lease.url).toBe(`http://127.0.0.1:${port}`);
      expect((await fetch(`${lease.url}/api/v1/health`)).status).toBe(200);
      expect(legacyCloses).toBe(0);
    } finally {
      try {
        await lease?.dispose();
      } catch {
        // A failed pre-fix lease has no runtime to dispose; the assertion above
        // remains the failure signal.
      }
      if (previous === undefined) delete globalState[legacyKey];
      else globalState[legacyKey] = previous;
    }
    expect(await tryBind(port)).toBe(true);
    expect(legacyCloses).toBe(0);
  });

  it("requires a process restart to stop a listener from a previous registry version", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const legacyKey = Symbol.for("opencode-quota-gui/dashboard-lifecycle/v3");
    const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = globalState[legacyKey];
    // An older in-process module graph still owns its listener. The v4 lifecycle
    // cannot see or close that host: only a full process restart stops it.
    const legacyListener = createNetServer((socket) => socket.end());
    await listen(legacyListener, port);
    let lease: DashboardLease | undefined;
    let legacyBoundAfterDispose = false;
    try {
      globalState[legacyKey] = { hosts: new Map([[port, { port, logger: silent }]]) };
      lease = await startDashboard({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => source,
        logger: silent,
      });
      expect(lease.state).toBe("unavailable");
      expect(lease.reason).toBe("port-unavailable");
      expect(lease.url).toBeUndefined();
      await lease.dispose();
      lease = undefined;
      // The old listener remains bound after this module lifecycle disposed.
      legacyBoundAfterDispose = !(await tryBind(port));
    } finally {
      await lease?.dispose();
      if (previous === undefined) delete globalState[legacyKey];
      else globalState[legacyKey] = previous;
      if (legacyListener.listening) await closeServer(legacyListener);
    }
    // A full OpenCode process restart is required to guarantee the old
    // version's listener is gone; this module never adopted or closed it.
    expect(legacyBoundAfterDispose).toBe(true);
    expect(await tryBind(port)).toBe(true);
  });
  it("attaches one shared viewer for multiple SSE clients and releases it after the last disconnect", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const snapshots = captureSnapshots();

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createSnapshots: snapshots.createSnapshots,
      logger: silent,
    });
    expect(lease.state).toBe("running");

    const first = await openSse(port);
    await waitFor(() => snapshots.viewers === 1, "first viewer");
    const second = await openSse(port);
    // Both transports observe the same snapshot service; the second client does
    // not duplicate the viewer (or its pollers).
    expect(snapshots.viewers).toBe(1);

    first.close();
    await waitFor(() => snapshots.viewers === 1, "second client remains attached");
    second.close();
    await waitFor(() => snapshots.viewers === 0, "last viewer release");

    await lease.dispose();
    expect(snapshots.closes).toBe(1);
  });

  it("contains a source close failure during final disposal", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const logs: string[] = [];
    let closes = 0;
    const failing: SnapshotSource = {
      ...source,
      close: async () => {
        closes += 1;
        throw new Error("source close failed");
      },
    };

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => failing,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });
    expect(lease.state).toBe("running");

    await expect(lease.dispose()).resolves.toBeUndefined();
    expect(closes).toBe(1);
    expect(logs.some((line) => line.includes("dashboard source close failed"))).toBe(true);
    expect(await tryBind(port)).toBe(true);
  });

  it("serves the models collection and filtered detail through the active owner's groups source", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const owner = buildOwnerSource(31);

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => owner.source,
      logger: silent,
    });
    expect(lease.state).toBe("running");

    expect(await readJson(port, "/api/v1/models?range=7d")).toMatchObject({
      dimension: "model",
      range: "7d",
      totals: { total: 31 },
    });

    const token = encodeAnalyticsEntityToken({ kind: "known", id: "gpt-5" });
    expect(await readJson(port, `/api/v1/models/${token}?range=24h`)).toMatchObject({
      dimension: "provider",
      range: "24h",
      filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
      totals: { total: 31 },
    });

    expect(owner.calls.groups).toBe(2);
    expect(owner.groupQueries).toEqual([
      { range: "7d", dimension: "model" },
      {
        range: "24h",
        dimension: "provider",
        filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
      },
    ]);
  });

  it("routes groups to the surviving owner and keeps one host until the last lease", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const first = buildOwnerSource(11);
    const second = buildOwnerSource(22);
    let secondCreates = 0;

    const leaseA = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => first.source,
      logger: silent,
    });
    const leaseB = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        secondCreates += 1;
        return second.source;
      },
      logger: silent,
    });
    expect(secondCreates).toBe(0);

    expect(await readJson(port, "/api/v1/models?range=7d")).toMatchObject({
      dimension: "model",
      totals: { total: 11 },
    });
    expect(first.calls.groups).toBe(1);
    expect(second.calls.groups).toBe(0);

    await leaseA.dispose();
    // The socket survives and the surviving owner is still lazy.
    expect(await tryBind(port)).toBe(false);
    expect(first.closes).toBe(1);
    expect(secondCreates).toBe(0);

    expect(await readJson(port, "/api/v1/providers?range=30d")).toMatchObject({
      dimension: "provider",
      range: "30d",
      totals: { total: 22 },
    });
    expect(secondCreates).toBe(1);
    expect(second.calls.groups).toBe(1);
    expect(first.calls.groups).toBe(1);
    expect(second.groupQueries).toEqual([{ range: "30d", dimension: "provider" }]);

    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(second.closes).toBe(1);
    expect(first.closes).toBe(1);
  });

  it("contains a failing delegate source as last-good or a controlled failure", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const first = buildOwnerSource(11);
    const second = buildOwnerSource(22);

    const leaseA = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => first.source,
      logger: silent,
    });
    const leaseB = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => second.source,
      logger: silent,
    });

    // Cache a good A snapshot before the first owner goes away.
    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      stale: false,
      usage: { totals: { total: 11 } },
    });
    await leaseA.dispose();
    second.fails = true;

    // Dirty the caches with a real settings write.
    const settingsBody = await readJson(port, "/api/v1/settings");
    expect(settingsBody).toMatchObject({ revision: expect.any(String) });
    // SAFETY: the `toMatchObject` proof above establishes a string `revision`.
    const settings = settingsBody as { revision: string };
    const saved = await writeJson(port, "/api/v1/settings", "PUT", {
      patch: { minIntervalMs: 45000 },
      expectedRevision: settings.revision,
    });
    expect(saved.status).toBe(200);

    // The cached page falls back to A's last good snapshot, marked stale.
    expect(await readJson(port, "/api/v1/home?range=7d")).toMatchObject({
      stale: true,
      usage: { totals: { total: 11 } },
    });

    // Uncached analytics and quota become controlled 500s, never exceptions.
    const failedHome = await fetch(`http://127.0.0.1:${port}/api/v1/home?range=30d`);
    expect(failedHome.status).toBe(500);
    expect(await failedHome.json()).toMatchObject({ error: { code: "internal" } });
    const failedQuota = await fetch(`http://127.0.0.1:${port}/api/v1/quota`);
    expect(failedQuota.status).toBe(500);
    expect(await failedQuota.json()).toMatchObject({ error: { code: "internal" } });

    // The failing delegate was asked, never silently replaced or re-created.
    expect(second.calls).toEqual({ home: 2, project: 0, session: 0, quota: 1, groups: 0 });
    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(second.closes).toBe(1);
  });

  it("resolves an unavailable lease for an occupied port with one controlled log line", async () => {
    const workspace = makeWorkspace();
    const blocker = await blockerOnFreePort();
    try {
      writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port: blocker.port } });
      const { source, calls } = buildSource();
      const logs: string[] = [];

      const lease = await open({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => source,
        logger: createGuiLogger({ sink: (line) => logs.push(line) }),
      });

      expect(lease.state).toBe("unavailable");
      expect(lease.reason).toBe("port-unavailable");
      expect(lease.url).toBeUndefined();
      expect(calls).toEqual({ home: 0, project: 0, session: 0, groups: 0 });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("[opencode-quota-gui] error: dashboard server unavailable");
      expect(logs[0]).toContain("EADDRINUSE");
      expect(logs[0]).not.toContain(workspace.configDir);

      // The lease is terminal: the occupying server is untouched, no fallback port is bound.
      await lease.dispose();
      expect(await tryBind(blocker.port)).toBe(false);
    } finally {
      await blocker.close();
    }
  });

  it("contains a source factory failure without binding the port", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const logs: string[] = [];

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => {
        throw new Error(`source broke at ${workspace.configDir}`);
      },
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });

    expect(lease.state).toBe("unavailable");
    expect(lease.reason).toBe("source-unavailable");
    expect(lease.url).toBeUndefined();
    expect(await tryBind(port)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("source-unavailable");
    expect(logs[0]).not.toContain(workspace.configDir);
  });

  it("contains a settings factory failure without binding the port", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const logs: string[] = [];

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createSettingsStore: () => {
        throw new Error(`settings broke at ${workspace.configDir}`);
      },
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });

    expect(lease.state).toBe("unavailable");
    expect(lease.reason).toBe("settings-unavailable");
    expect(await tryBind(port)).toBe(true);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("settings-unavailable");
  });

  it("never rejects dispose and never closes a host another lease still uses", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const { source } = buildSource();
    const logs: string[] = [];
    let closes = 0;
    const failing: DashboardServerHandle = {
      port,
      url: `http://127.0.0.1:${port}`,
      close: async () => {
        closes += 1;
        throw new Error("close failed");
      },
    };

    const options: StartDashboardOptions = {
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer: async () => failing,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    };
    const [first, second] = await Promise.all([open(options), open(options)]);

    await expect(first.dispose()).resolves.toBeUndefined();
    expect(closes).toBe(0);

    await expect(second.dispose()).resolves.toBeUndefined();
    expect(closes).toBe(1);
    expect(logs.some((line) => line.includes("dashboard stop failed"))).toBe(true);

    // A repeated dispose is a no-op.
    await expect(second.dispose()).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });

  it("keeps the spec default port while a malformed config leaves web off by default", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, '{ "dashboard": { "port": ');
    const { source } = buildSource();
    const ports: number[] = [];
    const capture = async (options: DashboardServerOptions) => {
      ports.push(options.port);
      return fakeHandle(options.port);
    };
    const start = (configDir: string) =>
      open({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir,
        createSource: () => source,
        createServer: capture,
        logger: silent,
      });

    // A malformed canonical file falls back to the safe default: web off, so no
    // server construction and no bind, while the runtime still reports the port.
    const malformed = await start(workspace.configDir);
    expect(malformed.state).toBe("running");
    expect(malformed.port).toBe(4144);
    expect(malformed.url).toBeUndefined();
    expect(ports).toEqual([]);
    await malformed.dispose();

    // Explicitly enabled with an invalid `dashboard.port: 0`: the spec default
    // port still applies to the fixed bind.
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port: 0 } });
    const zero = await start(workspace.configDir);
    expect(zero.url).toBe("http://127.0.0.1:4144");
    await zero.dispose();

    expect(ports).toEqual([4144]);
  });

  it("re-reads minIntervalMs from the canonical file instead of freezing the startup value", async () => {
    const workspace = makeWorkspace();
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 120000 });
    const { source } = buildSource();
    const interval = captureInterval();
    const start = () =>
      open({
        client: dashboardClient,
        workspaceRoot: workspace.workspaceRoot,
        configDir: workspace.configDir,
        createSource: () => source,
        createSnapshots: interval.createSnapshots,
        logger: silent,
      });

    const lease = await start();
    expect(interval.read()).toBe(120000);

    writeGuiCanonicalConfig(workspace, { minIntervalMs: 45000 });
    expect(interval.read()).toBe(45000);

    // Malformed and invalid values fall back to what startup loaded.
    writeGuiCanonicalConfig(workspace, '{ "minIntervalMs": ');
    expect(interval.read()).toBe(120000);
    writeGuiCanonicalConfig(workspace, { minIntervalMs: 0 });
    expect(interval.read()).toBe(120000);
    await lease.dispose();

    // Nothing configured: the transport default (60 000, no invented floor) applies.
    writeGuiCanonicalConfig(workspace, {});
    const bare = await start();
    expect(interval.read()).toBe(60_000);
    await bare.dispose();
  });

  it("applies a GUI settings write to the effective poll interval without restart", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, {
      dashboard: { enabled: true, port },
      minIntervalMs: 120000,
    });
    const { source } = buildSource();
    const interval = captureInterval();

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createSnapshots: interval.createSnapshots,
      logger: silent,
    });
    expect(lease.state).toBe("running");
    expect(interval.read()).toBe(120000);

    const settingsBody = await readJson(port, "/api/v1/settings");
    expect(settingsBody).toMatchObject({ revision: expect.any(String) });
    // SAFETY: the `toMatchObject` proof above establishes a string `revision`.
    const settings = settingsBody as { revision: string };
    const saved = await writeJson(port, "/api/v1/settings", "PUT", {
      patch: { minIntervalMs: 45000 },
      expectedRevision: settings.revision,
    });
    expect(saved.status).toBe(200);
    // The P2 store emits no events; the write is visible to the poller immediately.
    expect(interval.read()).toBe(45000);

    // A rejected write never changes the effective interval.
    const stale = await writeJson(port, "/api/v1/settings", "PUT", {
      patch: { minIntervalMs: 60000 },
      expectedRevision: settings.revision,
    });
    expect(stale.status).toBe(409);
    expect(interval.read()).toBe(45000);
  });

  it("applies an import to the effective poll interval without restart", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    // Actual global legacy settings are eligible; ordinary workspace overrides are not.
    writeQuotaSidecarConfig(workspace.configDir, { minIntervalMs: 90000 });
    const { source } = buildSource();
    const interval = captureInterval();

    await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createSnapshots: interval.createSnapshots,
      logger: silent,
    });
    // Runtime settings are canonical-only: legacy values stay importable but do not
    // affect the effective poll interval until the user applies the import.
    expect(interval.read()).toBe(60_000);

    // Config is read per call, so editing the legacy file changes the import source.
    writeQuotaSidecarConfig(workspace.configDir, { minIntervalMs: 30000 });
    const previewBody = await readJson(port, "/api/v1/settings/import");
    expect(previewBody).toMatchObject({
      from: "global opencode-quota/quota-toast.json",
      keys: [{ key: "minIntervalMs", value: 30000 }],
      expectedRevision: expect.any(String),
    });
    // SAFETY: the `toMatchObject` proof above establishes a string `expectedRevision`.
    const preview = previewBody as { expectedRevision: string };
    const applied = await writeJson(port, "/api/v1/settings/import", "POST", {
      expectedRevision: preview.expectedRevision,
    });
    expect(applied.status).toBe(200);
    expect(interval.read()).toBe(30000);
  });

  it("always resolves a disposable lease, with the configured port, without an injected source", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const logs: string[] = [];

    const lease = await startDashboard({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      logger: createGuiLogger({ sink: (line) => logs.push(line) }),
    });
    leases.push(lease);

    // This tree may not ship the P3 read-source module yet: setup still resolves, keeps
    // the configured port, and never leaks a raw reason.
    expect(lease.port).toBe(port);
    if (lease.state === "unavailable") {
      expect(lease.reason).toBe("source-unavailable");
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("source-unavailable");
      expect(logs[0]).not.toContain(workspace.configDir);
    }
    await expect(lease.dispose()).resolves.toBeUndefined();
    expect(await tryBind(port)).toBe(true);
  });
});
