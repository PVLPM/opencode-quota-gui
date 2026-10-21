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

interface SourceFixture {
  source: SnapshotSource;
  calls: { home: number; project: number; session: number };
}

function buildSource(): SourceFixture {
  const calls = { home: 0, project: 0, session: 0 };
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
  };
  return { source, calls };
}

interface OwnerSourceFixture {
  source: SnapshotSource;
  calls: { home: number; project: number; session: number; quota: number };
  readonly closes: number;
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
  const calls = { home: 0, project: 0, session: 0, quota: 0 };
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

interface IntervalCapture {
  createServer: (options: DashboardServerOptions) => Promise<DashboardServerHandle>;
  read: () => number;
}

/** Wraps the real server factory to capture the effective poll-interval getter. */
function captureInterval(): IntervalCapture {
  let interval: (() => number) | undefined;
  return {
    createServer: async (options) => {
      interval = typeof options.minIntervalMs === "function" ? options.minIntervalMs : undefined;
      return createDashboardServer(options);
    },
    read: () => {
      if (!interval) throw new Error("no interval getter was captured");
      return interval();
    },
  };
}

async function readJson(port: number, path: string): Promise<JsonValue | undefined> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  expect(response.status).toBe(200);
  return await response.json();
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
  it("binds the configured port and computes the first snapshot only on request", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
    expect(calls).toEqual({ home: 0, project: 0, session: 0 });

    const health = await fetch(`${lease.url}/api/v1/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ app: "opencode-quota-gui", contractVersion: 1 });

    const home = await fetch(`${lease.url}/api/v1/home?range=7d`);
    expect(home.status).toBe(200);
    expect(calls.home).toBe(1);

    await lease.dispose();
    expect(await tryBind(port)).toBe(true);
  });

  it("shares one host across concurrent setups and closes it only with the last lease", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
    expect(calls).toEqual({ home: 0, project: 0, session: 0 });
  });

  it("hands off to a live owner's source when the first owner disposes without dropping the socket", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
    expect(second.calls).toEqual({ home: 0, project: 0, session: 0, quota: 0 });

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

  it("contains a failing delegate source as last-good or a controlled failure", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
    expect(second.calls).toEqual({ home: 2, project: 0, session: 0, quota: 1 });
    await leaseB.dispose();
    expect(await tryBind(port)).toBe(true);
    expect(second.closes).toBe(1);
  });

  it("resolves an unavailable lease for an occupied port with one controlled log line", async () => {
    const workspace = makeWorkspace();
    const blocker = await blockerOnFreePort();
    try {
      writeGuiCanonicalConfig(workspace, { dashboard: { port: blocker.port } });
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
      expect(calls).toEqual({ home: 0, project: 0, session: 0 });
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
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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

  it("keeps the spec default port when the canonical config is invalid", async () => {
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

    const malformed = await start(workspace.configDir);
    expect(malformed.state).toBe("running");
    expect(malformed.port).toBe(4144);
    await malformed.dispose();

    // `dashboard.port: 0` is invalid in the canonical config; the spec default applies.
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 0 } });
    const zero = await start(workspace.configDir);
    await zero.dispose();

    expect(ports).toEqual([4144, 4144]);
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
        createServer: interval.createServer,
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
    writeGuiCanonicalConfig(workspace, { dashboard: { port }, minIntervalMs: 120000 });
    const { source } = buildSource();
    const interval = captureInterval();

    const lease = await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer: interval.createServer,
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
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    // The inherited project layer wins at startup; the canonical file has no key yet.
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 90000 });
    const { source } = buildSource();
    const interval = captureInterval();

    await open({
      client: dashboardClient,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      createSource: () => source,
      createServer: interval.createServer,
      logger: silent,
    });
    expect(interval.read()).toBe(90000);

    // Config is read per call, so editing the inherited file changes the import source.
    writeQuotaSidecarConfig(workspace.workspaceRoot, { minIntervalMs: 30000 });
    const previewBody = await readJson(port, "/api/v1/settings/import");
    expect(previewBody).toMatchObject({ expectedRevision: expect.any(String) });
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
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
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
