import { describe, expect, it, vi } from "vitest";

import type {
  AnalyticsGroupSnapshot,
  DashboardEvent,
  GuiSettingsStore,
  HomeSnapshot,
  ImportPreview,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
} from "../src/contracts/dashboard.js";
import { GuiSettingsError } from "../src/gui/config.js";
import {
  type DashboardRpcRegister,
  type DashboardRpcRuntime,
  registerDashboardRpc,
} from "../src/gui/rpc.js";
import type { SnapshotService } from "../src/gui/snapshot-service.js";
import type { DashboardRpc } from "../src/rpc.js";

type RpcMethodName = keyof typeof DashboardRpc.methods;
type AnyHandler = (
  input: unknown,
  context: {
    signal: AbortSignal;
    error: (type: string, message: string, data?: unknown) => unknown;
  },
) => Promise<unknown>;

type CapturedRegistration = {
  definition: typeof DashboardRpc;
  handlers: Record<RpcMethodName, AnyHandler>;
  emit: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  disposed: boolean;
  delivered: number;
};

function createRegistration(
  definition: typeof DashboardRpc,
  handlers: Record<RpcMethodName, AnyHandler>,
): CapturedRegistration {
  const captured: CapturedRegistration = {
    definition,
    handlers,
    disposed: false,
    delivered: 0,
    // The real SDK emits on the bus even after the registration is disposed
    // (`packages/core/src/rpc.ts` v2.0.16 returns the emit closure without a
    // disposal check). Keep that fidelity: emitter selection must be correct
    // from normal lifecycle bookkeeping, not from a disposed emit failing.
    emit: vi.fn(async () => {
      captured.delivered += 1;
    }),
    dispose: vi.fn(async () => {
      captured.disposed = true;
    }),
  };
  return captured;
}

function createFakeRegistrar() {
  const registrations: CapturedRegistration[] = [];
  const register = vi.fn(async (definition, handlers) => {
    const captured = createRegistration(
      definition as typeof DashboardRpc,
      handlers as Record<RpcMethodName, AnyHandler>,
    );
    registrations.push(captured);
    return { events: { emit: captured.emit }, dispose: captured.dispose };
  });
  return {
    register: register as unknown as DashboardRpcRegister["register"],
    registrations,
    read: (index = 0) => {
      const captured = registrations[index];
      if (!captured) throw new Error("RPC was not registered");
      return captured;
    },
  };
}

/**
 * A registrar whose registrations belong to a setup scope, like the SDK's
 * `Effect.acquireRelease`: ending a setup disposes every registration it made,
 * regardless of any local reference still held elsewhere.
 */
function createScopedRegistrar() {
  const setups: Array<{
    rpc: DashboardRpcRegister;
    registrations: CapturedRegistration[];
    end: () => Promise<void>;
  }> = [];

  function openSetup() {
    const registrations: CapturedRegistration[] = [];
    const setup = {
      rpc: {
        register: (async (definition, handlers) => {
          const captured = createRegistration(
            definition as typeof DashboardRpc,
            handlers as Record<RpcMethodName, AnyHandler>,
          );
          registrations.push(captured);
          return { events: { emit: captured.emit }, dispose: captured.dispose };
        }) as DashboardRpcRegister["register"],
      },
      registrations,
      end: async () => {
        // SDK finalizers run newest-first; each registration dispose is
        // idempotent, so a local release before the scope end is harmless.
        for (const captured of [...registrations].reverse()) await captured.dispose();
      },
    };
    setups.push(setup);
    return setup;
  }

  return { openSetup, setups };
}

function createFakeRuntime() {
  const listeners = new Set<(event: DashboardEvent) => void>();
  const released: string[] = [];
  const snapshots = {
    home: vi.fn(async () => ({ marker: "home" }) as unknown as HomeSnapshot),
    quota: vi.fn(async () => ({ marker: "quota" }) as unknown as QuotaSnapshot),
    project: vi.fn(async () => ({ marker: "project" }) as unknown as ProjectSnapshot),
    session: vi.fn(async () => ({ marker: "session" }) as unknown as SessionSnapshot),
    groups: vi.fn(async () => ({ marker: "groups" }) as unknown as AnalyticsGroupSnapshot),
    subscribe: vi.fn((listener: (event: DashboardEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    addScopedViewer: vi.fn((scope: string) => {
      const release = vi.fn(() => {
        released.push(scope);
      });
      return { release };
    }),
    notifySettingsChanged: vi.fn(),
  } as unknown as SnapshotService;
  const settings = {
    settings: vi.fn(async () => ({ revision: "rev-1" }) as unknown as SettingsSnapshot),
    saveSettings: vi.fn(async () => ({ revision: "rev-2" }) as unknown as SettingsWriteResult),
    saveVisibility: vi.fn(async () => ({ revision: "rev-3" }) as unknown as SettingsWriteResult),
    importPreview: vi.fn(async () => ({ from: "legacy" }) as unknown as ImportPreview),
    importApply: vi.fn(async () => ({ revision: "rev-4" }) as unknown as SettingsWriteResult),
    openSettingsFile: vi.fn(async () => undefined),
  } as unknown as GuiSettingsStore;
  const runtime: DashboardRpcRuntime = { snapshots, settings };

  return {
    runtime,
    snapshots,
    settings,
    released,
    emit(event: DashboardEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

async function call(
  captured: CapturedRegistration,
  name: RpcMethodName,
  input: unknown,
  signal = new AbortController().signal,
): Promise<unknown> {
  const handler = captured.handlers[name];
  return handler(input, {
    signal,
    error: (type, message, data) => ({ type, message, data }),
  });
}

async function setup() {
  const registrar = createFakeRegistrar();
  const fake = createFakeRuntime();
  const registration = await registerDashboardRpc({ register: registrar.register }, fake.runtime);
  return { registrar, fake, registration, captured: registrar.read() };
}

describe("dashboard RPC handlers", () => {
  it("bridges every read to the shared snapshots and settings runtime", async () => {
    const { captured, fake } = await setup();

    await expect(call(captured, "health", {})).resolves.toMatchObject({
      app: "opencode-quota-gui",
      contractVersion: 2,
    });
    await expect(call(captured, "quota", {})).resolves.toEqual({ marker: "quota" });
    await expect(call(captured, "home", { range: "7d" })).resolves.toEqual({ marker: "home" });
    await expect(call(captured, "groups", { range: "7d", dimension: "model" })).resolves.toEqual({
      marker: "groups",
    });
    await expect(call(captured, "project", { projectId: "p1", range: "7d" })).resolves.toEqual({
      marker: "project",
    });
    await expect(call(captured, "session", { sessionId: "s1" })).resolves.toEqual({
      marker: "session",
    });

    expect(fake.snapshots.home).toHaveBeenCalledWith({ range: "7d" });
    expect(fake.snapshots.groups).toHaveBeenCalledWith({ range: "7d", dimension: "model" });
    await expect(call(captured, "settings", {})).resolves.toEqual({ revision: "rev-1" });
    await expect(call(captured, "importPreview", {})).resolves.toEqual({ from: "legacy" });
    await call(captured, "openSettingsFile", {});
    expect(fake.settings.openSettingsFile).toHaveBeenCalledOnce();
  });

  it("notifies the shared snapshot owner after settings writes", async () => {
    const { captured, fake } = await setup();

    await call(captured, "saveSettings", { patch: {}, expectedRevision: "rev-1" });
    expect(fake.snapshots.notifySettingsChanged).toHaveBeenLastCalledWith();

    await call(captured, "saveVisibility", {
      hiddenCards: [],
      hiddenRows: [],
      expectedRevision: "rev-1",
    });
    expect(fake.snapshots.notifySettingsChanged).toHaveBeenLastCalledWith({
      scope: "visibility",
    });

    await call(captured, "importApply", { expectedRevision: "rev-1" });
    expect(fake.snapshots.notifySettingsChanged).toHaveBeenLastCalledWith();
    expect(fake.settings.importApply).toHaveBeenCalledWith({ expectedRevision: "rev-1" });
  });

  it("maps controlled failures to fixed typed errors without raw messages or paths", async () => {
    const { captured, fake } = await setup();
    const rawPath = "C:\\Users\\someone\\.config\\opencode\\secret.jsonc";
    fake.snapshots.project = vi.fn(async () => {
      throw Object.assign(new Error(`failed at ${rawPath}`), { code: "project-not-found" });
    });
    fake.settings.saveSettings = vi.fn(async () => {
      throw new GuiSettingsError("config-changed", `changed at ${rawPath}`, {
        key: "minIntervalMs",
      });
    });
    fake.settings.importPreview = vi.fn(async () => {
      throw new Error(`unexpected ${rawPath}`);
    });

    const missing = await call(captured, "project", { projectId: "p1", range: "7d" });
    expect(missing).toEqual({
      type: "project-not-found",
      message: "Project not found",
      data: {},
    });
    expect(JSON.stringify(missing)).not.toContain(rawPath);

    const conflict = await call(captured, "saveSettings", {
      patch: {},
      expectedRevision: "old",
    });
    expect(conflict).toEqual({
      type: "config-changed",
      message: "Config changed since the last revision",
      data: { key: "minIntervalMs" },
    });
    expect(JSON.stringify(conflict)).not.toContain(rawPath);

    const internal = await call(captured, "importPreview", {});
    expect(internal).toEqual({
      type: "internal",
      message: "Internal dashboard error",
      data: {},
    });
    expect(JSON.stringify(internal)).not.toContain(rawPath);
  });

  it("reports a typed error when the settings file opener is unavailable", async () => {
    const registrar = createFakeRegistrar();
    const fake = createFakeRuntime();
    fake.settings.openSettingsFile = undefined;
    const received = await registerDashboardRpc({ register: registrar.register }, fake.runtime);
    try {
      const captured = registrar.read();
      const result = await call(captured, "openSettingsFile", {});
      expect(result).toEqual({
        type: "config-target-error",
        message: "The dashboard config path is not writable",
        data: {},
      });
    } finally {
      await received.dispose();
    }
  });

  it("emits one validated invalidation event for every shared snapshot change", async () => {
    const { captured, fake } = await setup();

    fake.emit({ topic: "quota.changed", at: 10 });
    fake.emit({ topic: "settings.changed", at: 11, scope: "visibility" });

    expect(captured.emit).toHaveBeenNthCalledWith(1, "invalidated", {
      topic: "quota.changed",
      at: 10,
    });
    expect(captured.emit).toHaveBeenNthCalledWith(2, "invalidated", {
      topic: "settings.changed",
      at: 11,
      scope: "visibility",
    });
  });

  it("holds a scoped viewer for the call lifetime and releases it on abort", async () => {
    const { captured, fake } = await setup();
    const controller = new AbortController();

    const pending = call(captured, "watch", { scope: "quota" }, controller.signal);
    expect(fake.snapshots.addScopedViewer).toHaveBeenCalledWith("quota");
    expect(fake.released).toEqual([]);

    controller.abort();
    await expect(pending).resolves.toEqual({ active: false });
    expect(fake.released).toEqual(["quota"]);
  });

  it("releases held viewers and the event subscription when the registration disposes", async () => {
    const { captured, fake, registration } = await setup();
    const pending = call(captured, "watch", { scope: "analytics" }, new AbortController().signal);

    await registration.dispose();
    await expect(pending).resolves.toEqual({ active: false });
    expect(fake.released).toEqual(["analytics"]);
    expect(captured.dispose).toHaveBeenCalledOnce();

    const emitted = captured.emit.mock.calls.length;
    fake.emit({ topic: "quota.changed", at: 99 });
    expect(captured.emit).toHaveBeenCalledTimes(emitted);
  });

  it("shares the snapshot subscription but keeps one registration per setup", async () => {
    const registrar = createFakeRegistrar();
    const fake = createFakeRuntime();
    // Duplicate plugin setups receive distinct lease runtime wrappers around
    // the same host-owned snapshot service.
    const duplicateRuntime = {
      snapshots: fake.runtime.snapshots,
      settings: fake.runtime.settings,
    };
    const first = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location: { directory: "/workspace" },
    });
    const second = await registerDashboardRpc({ register: registrar.register }, duplicateRuntime, {
      location: { directory: "/workspace" },
    });

    // Each setup owns its own SDK-scoped registration, but one snapshot
    // subscription fans each change out exactly once.
    expect(registrar.register).toHaveBeenCalledTimes(2);
    expect(fake.snapshots.subscribe).toHaveBeenCalledOnce();

    fake.emit({ topic: "quota.changed", at: 1 });
    expect(registrar.registrations[0]?.delivered).toBe(1);
    expect(registrar.registrations[1]?.delivered).toBe(0);

    await first.dispose();
    fake.emit({ topic: "sessions.changed", at: 2 });
    expect(registrar.registrations[0]?.delivered).toBe(1);
    expect(registrar.registrations[1]?.delivered).toBe(1);

    await second.dispose();
    expect(registrar.registrations[1]?.dispose).toHaveBeenCalledOnce();
  });

  it("keeps the surviving setup's RPC after the creating setup's SDK scope disposes", async () => {
    const fake = createFakeRuntime();
    const scoped = createScopedRegistrar();
    const creating = scoped.openSetup();
    const surviving = scoped.openSetup();
    const creatingLease = await registerDashboardRpc(creating.rpc, fake.runtime, {
      location: { directory: "/workspace" },
    });
    const survivingLease = await registerDashboardRpc(
      surviving.rpc,
      { snapshots: fake.runtime.snapshots, settings: fake.runtime.settings },
      { location: { directory: "/workspace" } },
    );

    expect(creating.registrations).toHaveLength(1);
    expect(surviving.registrations).toHaveLength(1);
    expect(fake.snapshots.subscribe).toHaveBeenCalledOnce();

    // The SDK scope finalizer disposes the creator's registration regardless
    // of the other setup still holding the shared runtime.
    await creating.end();

    fake.emit({ topic: "quota.changed", at: 1 });
    // The SDK emitter still publishes after the registration is disposed, so
    // the creator's emitter delivers this change once; the point is that the
    // surviving setup's registration still serves methods and nothing doubles.
    expect(creating.registrations[0]?.delivered).toBe(1);
    expect(surviving.registrations[0]?.delivered).toBe(0);
    const delivered = scoped.setups
      .flatMap((setup) => setup.registrations)
      .reduce((total, registration) => total + registration.delivered, 0);
    expect(delivered).toBe(1);

    const survivingRegistration = surviving.registrations[0];
    if (!survivingRegistration) throw new Error("expected the surviving registration");
    await expect(call(survivingRegistration, "quota", {})).resolves.toEqual({
      marker: "quota",
    });

    await creatingLease.dispose();
    await survivingLease.dispose();
  });

  it.each([
    "creating",
    "joining",
  ] as const)("keeps exactly one invalidation stream when the %s setup releases first", async (order) => {
    const fake = createFakeRuntime();
    const scoped = createScopedRegistrar();
    const first = scoped.openSetup();
    const second = scoped.openSetup();
    const firstLease = await registerDashboardRpc(first.rpc, fake.runtime, {
      location: { directory: "/workspace" },
    });
    const secondLease = await registerDashboardRpc(
      second.rpc,
      { snapshots: fake.runtime.snapshots, settings: fake.runtime.settings },
      { location: { directory: "/workspace" } },
    );

    if (order === "creating") {
      await firstLease.dispose();
      await first.end();
    } else {
      await secondLease.dispose();
      await second.end();
    }

    fake.emit({ topic: "quota.changed", at: 1 });
    await vi.waitFor(() => {
      expect(first.registrations[0]?.delivered).toBe(order === "creating" ? 0 : 1);
      expect(second.registrations[0]?.delivered).toBe(order === "creating" ? 1 : 0);
    });
    const delivered = scoped.setups
      .flatMap((setup) => setup.registrations)
      .reduce((total, registration) => total + registration.delivered, 0);
    expect(delivered).toBe(1);

    const survivor = order === "creating" ? second.registrations[0] : first.registrations[0];
    if (!survivor) throw new Error("expected the surviving registration");
    await expect(call(survivor, "quota", {})).resolves.toEqual({ marker: "quota" });

    await firstLease.dispose();
    await secondLease.dispose();
  });

  it("keeps same-directory setups with different workspace IDs on independent subscriptions", async () => {
    const registrar = createFakeRegistrar();
    const fake = createFakeRuntime();
    const duplicateRuntime = {
      snapshots: fake.runtime.snapshots,
      settings: fake.runtime.settings,
    };
    const first = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location: { directory: "/workspace", workspaceID: "ws-a" },
    });
    const second = await registerDashboardRpc({ register: registrar.register }, duplicateRuntime, {
      location: { directory: "/workspace", workspaceID: "ws-b" },
    });

    // The event bus filters on directory AND workspaceID, so a shared key here
    // would suppress every invalidation for one of the workspaces.
    expect(fake.snapshots.subscribe).toHaveBeenCalledTimes(2);
    fake.emit({ topic: "quota.changed", at: 1 });
    expect(registrar.registrations[0]?.delivered).toBe(1);
    expect(registrar.registrations[1]?.delivered).toBe(1);

    await first.dispose();
    await second.dispose();
  });

  it("shares one subscription for the same complete location and emits once", async () => {
    const registrar = createFakeRegistrar();
    const fake = createFakeRuntime();
    const duplicateRuntime = {
      snapshots: fake.runtime.snapshots,
      settings: fake.runtime.settings,
    };
    const location = { directory: "/workspace", workspaceID: "ws-a" } as const;
    const first = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location,
    });
    const second = await registerDashboardRpc({ register: registrar.register }, duplicateRuntime, {
      location,
    });

    expect(fake.snapshots.subscribe).toHaveBeenCalledOnce();
    fake.emit({ topic: "quota.changed", at: 1 });
    expect(registrar.registrations[0]?.delivered).toBe(1);
    expect(registrar.registrations[1]?.delivered).toBe(0);

    await first.dispose();
    await second.dispose();
  });

  it("does not collide locations whose components contain separators", async () => {
    const registrar = createFakeRegistrar();
    const fake = createFakeRuntime();
    const first = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location: { directory: "/workspace", workspaceID: "a/b" },
    });
    const second = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location: { directory: "/workspace/a", workspaceID: "b" },
    });

    expect(fake.snapshots.subscribe).toHaveBeenCalledTimes(2);

    await first.dispose();
    await second.dispose();
  });

  it("keeps distinct locations on independent registrations", async () => {
    const registrar = createFakeRegistrar();
    const fake = createFakeRuntime();
    const first = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location: { directory: "/workspace-a" },
    });
    const second = await registerDashboardRpc({ register: registrar.register }, fake.runtime, {
      location: { directory: "/workspace-b" },
    });

    expect(registrar.register).toHaveBeenCalledTimes(2);
    expect(fake.snapshots.subscribe).toHaveBeenCalledTimes(2);

    await first.dispose();
    await second.dispose();
  });

  it("disposes idempotently", async () => {
    const { captured, registration } = await setup();
    await registration.dispose();
    await registration.dispose();
    expect(captured.dispose).toHaveBeenCalledOnce();
  });
});
