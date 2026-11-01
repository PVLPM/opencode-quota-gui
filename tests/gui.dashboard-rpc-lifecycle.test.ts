import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyticsGroupSnapshot,
  CostedTokens,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import {
  type DashboardLease,
  type StartDashboardOptions,
  startDashboard,
} from "../src/gui/lifecycle.js";
import { createGuiLogger } from "../src/gui/log.js";
import { type DashboardRpcRegister, registerDashboardRpc } from "../src/gui/rpc.js";
import type { DashboardServerHandle, DashboardServerOptions } from "../src/gui/server.js";
import { createDashboardServer } from "../src/gui/server.js";
import {
  createSnapshotService,
  type SnapshotService,
  type SnapshotServiceOptions,
  type SnapshotSource,
  type SnapshotViewScope,
} from "../src/gui/snapshot-service.js";
import { DashboardRpc } from "../src/rpc.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

type RpcMethodName = keyof typeof DashboardRpc.methods;
type Handler = (
  input: unknown,
  context: {
    signal: AbortSignal;
    error: (type: string, message: string, data?: unknown) => unknown;
  },
) => Promise<unknown>;

const silent = createGuiLogger({ sink: () => {} });

const dashboardClient = {
  config: {
    get: async () => ({ data: {} }),
    providers: async () => ({ data: { providers: [] } }),
  },
};

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

function buildSource() {
  const calls = { home: 0, project: 0, session: 0, quota: 0, groups: 0 };
  const state = { closes: 0 };
  const source: SnapshotSource = {
    home: async ({ range }) => {
      calls.home += 1;
      return {
        generatedAtMs: 1,
        range,
        stale: false,
        providers: { cards: [], enabledProviders: "auto", polledAtMs: 1 },
        usage: {
          range,
          window: { untilMs: 1 },
          bucketUnit: "day",
          timeZone: "UTC",
          buckets: [],
          totals: costed(0),
          stepCount: 0,
          sessionCount: 0,
          stale: false,
        },
        projects: [],
      } as HomeSnapshot;
    },
    project: async ({ projectId, range }) => {
      calls.project += 1;
      return {
        projectId,
        name: "Project",
        range,
        window: { untilMs: 1 },
        roots: [],
        totals: { ...costed(0), sessionCount: 0 },
        usage: {
          range,
          window: { untilMs: 1 },
          bucketUnit: "day",
          timeZone: "UTC",
          buckets: [],
          totals: costed(0),
          stepCount: 0,
          sessionCount: 0,
          stale: false,
        },
        stale: false,
      } as ProjectSnapshot;
    },
    session: async ({ sessionId }) => {
      calls.session += 1;
      return {
        focusSessionId: sessionId,
        timeZone: "UTC",
        projectId: "p1",
        projectName: "Project",
        breadcrumbs: [],
        nodes: [],
        steps: [],
        compactionMarkers: [],
        ownSummary: { ...costed(0), stepCount: 0 },
        treeTotals: costed(0),
        stepSemantics: "step",
      } as SessionSnapshot;
    },
    quota: async () => {
      calls.quota += 1;
      return {
        generatedAtMs: 1,
        stale: false,
        timeZone: "UTC",
        providers: { cards: [], enabledProviders: "auto", polledAtMs: 1 },
      } as QuotaSnapshot;
    },
    groups: async (query) => {
      calls.groups += 1;
      return {
        dimension: query.dimension,
        range: query.range,
        window: { untilMs: 1 },
        bucketUnit: "day",
        timeZone: "UTC",
        buckets: [],
        totals: costed(0),
        sessionCount: 0,
        stepCount: 0,
        rows: [],
        series: [],
        stale: false,
      } as AnalyticsGroupSnapshot;
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

interface SnapshotCapture {
  createSnapshots: (options: SnapshotServiceOptions) => SnapshotService;
  readonly created: SnapshotService[];
  readonly closes: number;
  readonly viewers: number;
  readonly scopedViewers: number;
}

function captureSnapshots(): SnapshotCapture {
  const created: SnapshotService[] = [];
  let closes = 0;
  let viewers = 0;
  let scopedViewers = 0;
  return {
    created,
    get closes() {
      return closes;
    },
    get viewers() {
      return viewers;
    },
    get scopedViewers() {
      return scopedViewers;
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
      const addScoped = service.addScopedViewer.bind(service);
      service.addScopedViewer = (scope: SnapshotViewScope) => {
        scopedViewers += 1;
        const viewer = addScoped(scope);
        let released = false;
        return {
          release: () => {
            if (released) return;
            released = true;
            scopedViewers -= 1;
            viewer.release();
          },
        };
      };
      created.push(service);
      return service;
    },
  };
}

interface FakeRegistration {
  handlers: Record<RpcMethodName, Handler>;
  emit: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  disposed: boolean;
  delivered: number;
}

function createFakeRegistrar() {
  const registrations: FakeRegistration[] = [];
  const register = vi.fn(async (_definition, supplied) => {
    const captured: FakeRegistration = {
      handlers: supplied as Record<RpcMethodName, Handler>,
      disposed: false,
      delivered: 0,
      // The SDK's emit closure publishes on the event bus even after the
      // registration's scope disposes it; the fake mirrors that so tests never
      // rely on a disposed emit rejecting.
      emit: vi.fn(async () => {
        captured.delivered += 1;
      }),
      dispose: vi.fn(async () => {
        captured.disposed = true;
      }),
    };
    registrations.push(captured);
    return { events: { emit: captured.emit }, dispose: captured.dispose };
  });
  const current = () => {
    const captured = registrations[registrations.length - 1];
    if (!captured) throw new Error("RPC was not registered");
    return captured;
  };
  return {
    registrar: { register } as unknown as DashboardRpcRegister,
    register,
    registrations,
    call: async (name: RpcMethodName, input: unknown, signal?: AbortSignal) => {
      const captured = current();
      const result = await captured.handlers[name](input, {
        signal: signal ?? new AbortController().signal,
        error: (type, message, data) => ({ type, message, data }),
      });
      // The real host validates the definition's output schema. The fake does
      // the same so a guard mismatch cannot hide behind a permissive fake.
      const schema = DashboardRpc.methods[name].output as unknown as {
        "~standard": {
          validate(value: unknown): Promise<{
            value?: unknown;
            issues?: ReadonlyArray<{ message: string }>;
          }>;
        };
      };
      const validated = await schema["~standard"].validate(result);
      if (validated.issues) {
        throw new Error(`output rejected: ${validated.issues[0]?.message ?? "invalid"}`);
      }
      return validated.value;
    },
  };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function openBlocker(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createNetServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const leases: DashboardLease[] = [];
const workspaces: GuiConfigWorkspace[] = [];

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("gui-rpc-lifecycle-");
  workspaces.push(workspace);
  return workspace;
}

async function open(options: StartDashboardOptions): Promise<DashboardLease> {
  const lease = await startDashboard(options);
  leases.push(lease);
  return lease;
}

function optionsFor(workspace: GuiConfigWorkspace, source: SnapshotSource): StartDashboardOptions {
  return {
    client: dashboardClient,
    workspaceRoot: workspace.workspaceRoot,
    configDir: workspace.configDir,
    createSource: () => source,
    logger: silent,
  };
}

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) {
    await lease.dispose();
  }
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});

describe("dashboard RPC lifecycle", () => {
  it("attaches RPC to the shared runtime with web disabled (native-only)", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const fixture = buildSource();
    const snapshots = captureSnapshots();
    const lease = await open({
      ...optionsFor(workspace, fixture.source),
      createSnapshots: snapshots.createSnapshots,
    });
    const rpc = createFakeRegistrar();
    if (!lease.runtime) throw new Error("expected the shared runtime");
    const registration = await registerDashboardRpc(rpc.registrar, lease.runtime);

    expect(lease.state).toBe("running");
    expect(lease.url).toBeUndefined();
    expect(snapshots.created).toHaveLength(1);
    expect(snapshots.viewers).toBe(0);
    expect(lease.runtime.snapshots).toBe(snapshots.created[0]);

    await expect(rpc.call("quota", {})).resolves.toMatchObject({ stale: false });
    await expect(rpc.call("quota", {})).resolves.toMatchObject({ stale: false });
    expect(fixture.calls.quota).toBe(1);

    const controller = new AbortController();
    const watching = rpc.call("watch", { scope: "quota" }, controller.signal);
    expect(snapshots.scopedViewers).toBe(1);
    controller.abort();
    await expect(watching).resolves.toEqual({ active: false });
    expect(snapshots.scopedViewers).toBe(0);

    await registration.dispose();
    await lease.dispose();
    expect(snapshots.closes).toBe(1);
    expect(fixture.closes).toBe(1);
  });

  it("keeps the same runtime and RPC available after a web bind failure", async () => {
    const workspace = makeWorkspace();
    const blocker = await openBlocker();
    try {
      writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port: blocker.port } });
      const fixture = buildSource();
      const snapshots = captureSnapshots();
      const lease = await open({
        ...optionsFor(workspace, fixture.source),
        createSnapshots: snapshots.createSnapshots,
      });
      expect(lease.state).toBe("unavailable");
      expect(lease.reason).toBe("port-unavailable");
      if (!lease.runtime) throw new Error("expected the shared runtime after a bind failure");

      const rpc = createFakeRegistrar();
      const registration = await registerDashboardRpc(rpc.registrar, lease.runtime);
      await expect(rpc.call("home", { range: "7d" })).resolves.toMatchObject({ range: "7d" });
      expect(fixture.calls.home).toBe(1);
      expect(snapshots.created).toHaveLength(1);

      await registration.dispose();
      await lease.dispose();
      expect(snapshots.closes).toBe(1);
    } finally {
      await blocker.close();
    }
  });

  it("shares one snapshot service and cache between web and RPC (both)", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const fixture = buildSource();
    const snapshots = captureSnapshots();
    let serverOptions: DashboardServerOptions | undefined;
    const lease = await open({
      ...optionsFor(workspace, fixture.source),
      createSnapshots: snapshots.createSnapshots,
      createServer: async (options): Promise<DashboardServerHandle> => {
        serverOptions = options;
        return createDashboardServer(options);
      },
    });
    if (!lease.runtime || !lease.url) throw new Error("expected web and shared runtime");
    expect(serverOptions?.snapshots).toBe(lease.runtime.snapshots);
    expect(serverOptions?.settings).toBe(lease.runtime.settings);

    const rpc = createFakeRegistrar();
    const registration = await registerDashboardRpc(rpc.registrar, lease.runtime);
    await expect(rpc.call("quota", {})).resolves.toMatchObject({ stale: false });

    const response = await fetch(`${lease.url}/api/v1/quota`);
    expect(response.status).toBe(200);
    // The HTTP transport reads the same cached quota entry the RPC call filled.
    expect(fixture.calls.quota).toBe(1);
    expect(snapshots.created).toHaveLength(1);

    await registration.dispose();
    await lease.dispose();
  });

  it("registers RPC without starting a viewer, worker or poller when unused (neither)", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const fixture = buildSource();
    const snapshots = captureSnapshots();
    const lease = await open({
      ...optionsFor(workspace, fixture.source),
      createSnapshots: snapshots.createSnapshots,
    });
    if (!lease.runtime) throw new Error("expected the shared runtime");
    const rpc = createFakeRegistrar();
    const registration = await registerDashboardRpc(rpc.registrar, lease.runtime);

    expect(snapshots.created).toHaveLength(1);
    expect(snapshots.viewers).toBe(0);
    expect(snapshots.scopedViewers).toBe(0);
    expect(fixture.calls).toEqual({ home: 0, project: 0, session: 0, quota: 0, groups: 0 });

    await registration.dispose();
    await lease.dispose();
    expect(snapshots.closes).toBe(1);
  });

  it("keeps web behavior when RPC is registered but no native viewer is attached (web-only)", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const fixture = buildSource();
    const snapshots = captureSnapshots();
    const lease = await open({
      ...optionsFor(workspace, fixture.source),
      createSnapshots: snapshots.createSnapshots,
    });
    if (!lease.runtime || !lease.url) throw new Error("expected web and shared runtime");
    const rpc = createFakeRegistrar();
    const registration = await registerDashboardRpc(rpc.registrar, lease.runtime);

    const response = await fetch(`${lease.url}/api/v1/home?range=7d`);
    expect(response.status).toBe(200);
    expect(fixture.calls.home).toBe(1);
    expect(snapshots.viewers).toBe(0);
    expect(snapshots.scopedViewers).toBe(0);

    await registration.dispose();
    await lease.dispose();
  });

  it("returns the same sanitized settings DTO over RPC as the HTTP boundary", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { enabled: true, port } });
    const fixture = buildSource();
    const lease = await open(optionsFor(workspace, fixture.source));
    if (!lease.runtime || !lease.url) throw new Error("expected web and shared runtime");
    const rpc = createFakeRegistrar();
    const registration = await registerDashboardRpc(rpc.registrar, lease.runtime);

    // RPC must not invent a broader settings payload than the existing HTTP
    // DTO: the same store, the same symbolic source labels and the one
    // documented absolute `pathLabel` display exception.
    const rpcSettings = await rpc.call("settings", {});
    const response = await fetch(`${lease.url}/api/v1/settings`);
    expect(response.status).toBe(200);
    expect(rpcSettings).toEqual(await response.json());

    await registration.dispose();
    await lease.dispose();
  });

  it("keeps one snapshot subscription and hands invalidations to the surviving setup", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const fixture = buildSource();
    const snapshots = captureSnapshots();
    const options = {
      ...optionsFor(workspace, fixture.source),
      createSnapshots: snapshots.createSnapshots,
    };
    const leaseA = await open(options);
    const leaseB = await open(options);
    if (!leaseA.runtime || !leaseB.runtime) throw new Error("expected the shared runtime");

    // Each lease has its own runtime wrapper around the same host objects.
    expect(leaseA.runtime).not.toBe(leaseB.runtime);
    expect(leaseA.runtime.snapshots).toBe(leaseB.runtime.snapshots);

    const rpc = createFakeRegistrar();
    const registrationA = await registerDashboardRpc(rpc.registrar, leaseA.runtime, {
      location: { directory: "/workspace" },
    });
    const registrationB = await registerDashboardRpc(rpc.registrar, leaseB.runtime, {
      location: { directory: "/workspace" },
    });
    // Per-setup SDK ownership; only the snapshot subscription is shared.
    expect(rpc.register).toHaveBeenCalledTimes(2);
    expect(snapshots.created).toHaveLength(1);

    leaseA.runtime.snapshots.notifySettingsChanged();
    expect(rpc.registrations.map((entry) => entry.delivered)).toEqual([1, 0]);

    await registrationA.dispose();
    // The first setup's SDK scope finalizer disposes the same registration
    // again; the surviving setup must still receive and publish invalidations.
    await rpc.registrations[0]?.dispose();
    leaseA.runtime.snapshots.notifySettingsChanged();
    expect(rpc.registrations.map((entry) => entry.delivered)).toEqual([1, 1]);
    expect(rpc.registrations[1]?.dispose).not.toHaveBeenCalled();

    await registrationB.dispose();
    expect(rpc.registrations[1]?.dispose).toHaveBeenCalledOnce();
  });
});
