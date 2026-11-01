import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DashboardEvent,
  DashboardHealth,
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import type {
  DashboardRpcCaller,
  NativeDashboardConnection,
} from "../src/native/dashboard-client.js";
import type {
  SessionHeaderClient,
  SessionHeaderSource,
} from "../src/native/session-header-source.js";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Stage 6 Slot data lifecycle.
 *
 * The Slot must reuse the shared runtime: no read or subscription while the
 * timeline is inactive, one settings read and one quota read on activation,
 * fail-closed settings/visibility, no rings from a stale or failed quota read,
 * and a refetch after reconnect or re-entry. No DOM, timer or polling is
 * involved.
 *
 * Solid's Node export is the inert server build, so the controller is loaded
 * through a Vite server aliased to the client runtime; otherwise its effects
 * never run and the assertions would be meaningless.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type CreateRoot = (callback: (dispose: () => void) => void) => () => void;
type CreateSignal = <T>(value: T) => [() => T, (next: T) => T];

let server: ViteDevServer | undefined;
let createRoot: CreateRoot;
let createSignal: CreateSignal;
let createNativeDashboardClient: typeof import("../src/native/dashboard-client.js").createNativeDashboardClient;
let createSessionHeaderSource: (options: {
  client: SessionHeaderClient;
  active: () => boolean;
  hostConnected?: () => boolean;
  now?: () => number;
}) => SessionHeaderSource;
let SdkTransportError: new (
  reason: "Transport",
  options?: { cause?: Error; detail?: string | null },
) => Error & { readonly reason: "Transport" };

beforeAll(async () => {
  const created = await createIsolatedViteServer({
    configFile: false,
    root: repoRoot,
    resolve: {
      alias: [
        {
          find: /^solid-js$/,
          replacement: path.join(repoRoot, "node_modules/solid-js/dist/solid.js"),
        },
      ],
    },
    ssr: { noExternal: ["solid-js"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const core = (await created.ssrLoadModule("solid-js")) as {
    createRoot: CreateRoot;
    createSignal: CreateSignal;
  };
  createRoot = core.createRoot;
  createSignal = core.createSignal;
  const sourceModule = (await created.ssrLoadModule(
    path.join(repoRoot, "src/native/session-header-source.ts"),
  )) as { createSessionHeaderSource: typeof createSessionHeaderSource };
  createSessionHeaderSource = sourceModule.createSessionHeaderSource;
  const dashboardClientModule = (await created.ssrLoadModule(
    path.join(repoRoot, "src/native/dashboard-client.ts"),
  )) as { createNativeDashboardClient: typeof createNativeDashboardClient };
  createNativeDashboardClient = dashboardClientModule.createNativeDashboardClient;

  const pluginRoot = realpathSync(path.join(repoRoot, "node_modules/@opencode/plugin"));
  const clientErrorModule = (await import(
    pathToFileURL(path.resolve(pluginRoot, "../client/dist/promise/generated/client-error.js")).href
  )) as { ClientError: typeof SdkTransportError };
  SdkTransportError = clientErrorModule.ClientError;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check(), label).toBe(true);
    },
    { timeout: 1000, interval: 5 },
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sdkWatchTimeout(): Error & { readonly reason: "Transport" } {
  return new SdkTransportError("Transport", {
    cause: new DOMException("The operation timed out", "TimeoutError"),
  });
}

interface RecoveryWatch {
  scope: string;
  signal: AbortSignal;
  resolve(value: { active: boolean }): void;
  reject(reason: unknown): void;
}

function emptyEventStream(signal: AbortSignal): AsyncIterable<{ data: never }> {
  let ended = signal.aborted;
  let wake: (() => void) | undefined;
  signal.addEventListener(
    "abort",
    () => {
      ended = true;
      wake?.();
    },
    { once: true },
  );
  return {
    async *[Symbol.asyncIterator]() {
      while (!ended) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function recoveryRpc() {
  const counts = { health: 0, quota: 0, settings: 0 };
  const watches: RecoveryWatch[] = [];
  const eventSignals: AbortSignal[] = [];
  const healthSignals: Array<AbortSignal | undefined> = [];
  const healthReads: Array<() => Promise<DashboardHealth>> = [];
  const quotaReads: Array<() => Promise<QuotaSnapshot>> = [];
  const settingsReads: Array<() => Promise<SettingsSnapshot>> = [];
  const caller = {
    health: (_input?: Record<string, never>, options?: { signal?: AbortSignal }) => {
      counts.health += 1;
      healthSignals.push(options?.signal);
      return (
        healthReads.shift()?.() ??
        Promise.resolve({
          app: "opencode-quota-gui",
          contractVersion: DASHBOARD_CONTRACT_VERSION,
          version: "1.2.0",
          build: "native-test",
        })
      );
    },
    settings: () => {
      counts.settings += 1;
      return settingsReads.shift()?.() ?? Promise.resolve(settingsSnapshot());
    },
    quota: () => {
      counts.quota += 1;
      return quotaReads.shift()?.() ?? Promise.resolve(quotaSnapshot());
    },
    watch: (input: { scope: string }, options?: { signal?: AbortSignal }) =>
      new Promise<{ active: boolean }>((resolve, reject) => {
        const signal = options?.signal ?? new AbortController().signal;
        watches.push({ scope: input.scope, signal, resolve, reject });
        signal.addEventListener("abort", () => resolve({ active: false }), { once: true });
      }),
    events: {
      subscribe: (_name: "invalidated", options?: { signal?: AbortSignal }) => {
        const signal = options?.signal ?? new AbortController().signal;
        eventSignals.push(signal);
        return emptyEventStream(signal);
      },
    },
  };

  return {
    caller: caller as unknown as DashboardRpcCaller,
    counts,
    watches,
    eventSignals,
    healthSignals,
    nextHealth: (read: () => Promise<DashboardHealth>) => healthReads.push(read),
    nextQuota: (read: () => Promise<QuotaSnapshot>) => quotaReads.push(read),
    nextSettings: (read: () => Promise<SettingsSnapshot>) => settingsReads.push(read),
  };
}

/* ---------------------------------------------------------------- fixtures */

function row(cardId: string, key: string, label: string): QuotaCardRow {
  return {
    rowId: `${cardId}#${key}` as RowId,
    label,
    kind: "percent",
    resultType: "quota",
    percentUsed: 38,
    percentRemaining: 62,
  };
}

function quotaSnapshot(overrides: { stale?: boolean } = {}): QuotaSnapshot {
  const primary = row("card-1", "five", "5h");
  const weekly = row("card-1", "weekly", "Weekly");
  const card: ProviderCard = {
    cardId: "card-1" as CardId,
    providerId: "synthetic",
    providerLabel: "Synthetic",
    rows: [primary, weekly],
    primaryQuotaWindows: [
      { rowId: primary.rowId, slot: 0 },
      { rowId: weekly.rowId, slot: 1 },
    ],
    errors: [],
  };
  return {
    generatedAtMs: Date.now(),
    stale: overrides.stale ?? false,
    timeZone: "UTC",
    providers: { cards: [card], enabledProviders: "auto", polledAtMs: Date.now() },
  };
}

interface RecordingClient {
  client: SessionHeaderClient;
  counts: {
    settings: number;
    quota: number;
    health: number;
    subscribes: number;
    unsubscribes: number;
    reconnects: number;
    scopes: string[];
  };
  emit: (event: DashboardEvent) => void;
  setConnection: (state: NativeDashboardConnection) => void;
  fireReconnect: () => void;
  setSettings: (settings: () => Promise<SettingsSnapshot>) => void;
  setQuota: (quota: () => Promise<QuotaSnapshot>) => void;
}

function recordingClient(): RecordingClient {
  const counts = {
    settings: 0,
    quota: 0,
    health: 0,
    subscribes: 0,
    unsubscribes: 0,
    reconnects: 0,
    scopes: [] as string[],
  };
  const listeners = new Set<(event: DashboardEvent) => void>();
  const connectionListeners = new Set<(state: NativeDashboardConnection) => void>();
  const reconnectListeners = new Set<() => void>();
  let connection: NativeDashboardConnection = "live";
  let settingsImpl: () => Promise<SettingsSnapshot> = async () => settingsSnapshot();
  let quotaImpl: () => Promise<QuotaSnapshot> = async () => quotaSnapshot();

  function setConnectionState(state: NativeDashboardConnection): void {
    connection = state;
    for (const listener of connectionListeners) listener(state);
  }

  function fireReconnect(): void {
    for (const listener of reconnectListeners) listener();
  }

  const client: SessionHeaderClient = {
    async settings() {
      counts.settings += 1;
      return settingsImpl();
    },
    async quota() {
      counts.quota += 1;
      return quotaImpl();
    },
    async health(): Promise<DashboardHealth> {
      counts.health += 1;
      return {
        app: "opencode-quota-gui",
        contractVersion: DASHBOARD_CONTRACT_VERSION,
        version: "1.2.0",
        build: "native-test",
      };
    },
    subscribe(listener) {
      counts.subscribes += 1;
      listeners.add(listener);
      return () => {
        counts.unsubscribes += 1;
        listeners.delete(listener);
      };
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      return () => connectionListeners.delete(listener);
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    connection: () => connection,
    async reconnect() {
      counts.reconnects += 1;
      setConnectionState("live");
      fireReconnect();
    },
    async setActiveView(scope) {
      counts.scopes.push(scope);
    },
  };

  return {
    client,
    counts,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    setConnection: setConnectionState,
    fireReconnect,
    setSettings: (settings) => {
      settingsImpl = settings;
    },
    setQuota: (quota) => {
      quotaImpl = quota;
    },
  };
}

const mounted: Array<() => void> = [];

async function mount(options: {
  client: SessionHeaderClient;
  active: () => boolean;
  hostConnected?: () => boolean;
}): Promise<SessionHeaderSource> {
  let source!: SessionHeaderSource;
  await new Promise<void>((resolve) => {
    createRoot((dispose) => {
      mounted.push(dispose);
      source = createSessionHeaderSource(options);
      resolve();
    });
  });
  await flush();
  return source;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

/* ------------------------------------------------------------------- tests */

describe("native session header source", () => {
  it("reads nothing while the timeline is inactive", async () => {
    const fake = recordingClient();
    const [active] = createSignal(false);
    const source = await mount({ client: fake.client, active });

    expect(fake.counts.subscribes).toBe(0);
    expect(fake.counts.settings).toBe(0);
    expect(fake.counts.quota).toBe(0);
    expect(fake.counts.health).toBe(0);
    expect(source.view().cards).toEqual([]);
  });

  it("shares the scoped viewer, settings and one quota read only when active", async () => {
    const fake = recordingClient();
    const [active, setActive] = createSignal(false);
    const source = await mount({ client: fake.client, active, now: () => Date.now() });

    setActive(true);
    await flush();

    expect(fake.counts.subscribes).toBe(1);
    expect(fake.counts.settings).toBe(1);
    expect(fake.counts.quota).toBe(1);
    expect(fake.counts.health).toBe(1);
    expect(source.view().cards).toHaveLength(1);
    expect(source.view().cards[0]?.rings.map((ring) => ring.label)).toEqual(["5h", "Weekly"]);
    // The Slot never selects an analytics view scope.
    expect(fake.counts.scopes).toEqual([]);
  });

  it("fails closed when the first settings read fails, then recovers on retry", async () => {
    const fake = recordingClient();
    const failure = new Error("settings unavailable");
    fake.setSettings(async () => {
      throw failure;
    });
    const [active] = createSignal(true);
    const source = await mount({ client: fake.client, active });

    expect(source.settingsError()).toBe(failure);
    expect(source.view().cards).toEqual([]);

    fake.setSettings(async () => settingsSnapshot());
    source.retry();
    await flush();
    expect(source.settingsError()).toBeUndefined();
    expect(source.view().cards).toHaveLength(1);
  });

  it("never paints stale quota as fresh rings", async () => {
    const fake = recordingClient();
    const [active] = createSignal(true);
    const source = await mount({ client: fake.client, active });

    expect(source.view().cards).toHaveLength(1);
    fake.setQuota(async () => quotaSnapshot({ stale: true }));
    fake.emit({ topic: "quota.changed", at: Date.now() });
    await flush();
    expect(source.view().cards).toEqual([]);

    fake.setQuota(async () => quotaSnapshot());
    fake.emit({ topic: "quota.changed", at: Date.now() });
    await flush();
    expect(source.view().cards).toHaveLength(1);
  });

  it("drops rings while the transport is reconnecting and refetches after reconnect", async () => {
    const fake = recordingClient();
    const [active] = createSignal(true);
    const source = await mount({ client: fake.client, active });
    const quotaBefore = fake.counts.quota;
    const settingsBefore = fake.counts.settings;

    fake.setConnection("reconnecting");
    expect(source.view().cards).toEqual([]);

    await fake.client.reconnect();
    await flush();
    expect(fake.counts.quota).toBe(quotaBefore + 1);
    expect(fake.counts.settings).toBe(settingsBefore + 1);
    expect(source.view().cards).toHaveLength(1);
  });

  it("reopens the viewer when the host server returns", async () => {
    const fake = recordingClient();
    const [active] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    await mount({ client: fake.client, active, hostConnected });

    setHostConnected(false);
    await flush();
    setHostConnected(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
  });

  it("recovers on hide/show after host-return health failed", async () => {
    const rpc = recoveryRpc();
    const client = createNativeDashboardClient({ rpc: rpc.caller, scope: "quota" });
    const [active, setActive] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const source = await mount({ client, active, hostConnected });
    await waitFor(
      () => rpc.watches.length === 1 && source.view().cards.length === 1,
      "initial data and viewer",
    );

    const healthBeforeReturn = rpc.counts.health;
    rpc.nextHealth(() => Promise.reject(new Error("host is not ready")));
    setHostConnected(false);
    await flush();
    setHostConnected(true);
    await waitFor(
      () => rpc.counts.health === healthBeforeReturn + 1,
      "failed host-return health check",
    );
    await flush();
    expect(client.connection()).toBe("reconnecting");
    expect(source.view().cards).toEqual([]);
    expect(rpc.watches).toHaveLength(1);

    setActive(false);
    await flush();
    setActive(true);
    await waitFor(
      () =>
        rpc.counts.health >= healthBeforeReturn + 2 &&
        rpc.watches.length === 2 &&
        client.connection() === "live" &&
        source.view().cards.length === 1,
      "recovery on visibility reentry",
    );
    expect(rpc.watches[1]?.scope).toBe("quota");
    expect(rpc.watches.filter((watch) => !watch.signal.aborted)).toHaveLength(1);

    client.dispose();
  });

  it("releases the viewer while inactive and refetches on re-entry", async () => {
    const fake = recordingClient();
    const [active, setActive] = createSignal(true);
    await mount({ client: fake.client, active });
    const quotaBefore = fake.counts.quota;

    setActive(false);
    await flush();
    expect(fake.counts.unsubscribes).toBe(1);

    fake.emit({ topic: "quota.changed", at: Date.now() });
    await flush();
    expect(fake.counts.quota).toBe(quotaBefore);

    setActive(true);
    await flush();
    expect(fake.counts.quota).toBeGreaterThan(quotaBefore);
    expect(fake.counts.subscribes).toBe(2);
  });

  it("refreshes settings and quota from their own invalidation topics", async () => {
    const fake = recordingClient();
    const [active] = createSignal(true);
    await mount({ client: fake.client, active });
    const quotaBefore = fake.counts.quota;
    const settingsBefore = fake.counts.settings;

    fake.emit({ topic: "settings.changed", at: Date.now() });
    await flush();
    expect(fake.counts.settings).toBe(settingsBefore + 1);
    expect(fake.counts.quota).toBe(quotaBefore);

    fake.emit({ topic: "quota.changed", at: Date.now() });
    await flush();
    expect(fake.counts.quota).toBe(quotaBefore + 1);
  });

  it("keeps Slot data fail-closed while a scope change replaces a pending full recovery", async () => {
    const rpc = recoveryRpc();
    const client = createNativeDashboardClient({ rpc: rpc.caller, scope: "quota" });
    const [active] = createSignal(true);
    const source = await mount({ client, active });
    await waitFor(
      () => rpc.watches.length === 1 && source.view().cards.length === 1,
      "initial Slot data and viewer",
    );

    const sdkTimeout = sdkWatchTimeout();
    expect(sdkTimeout.name).toBe("ClientError");
    expect(sdkTimeout.reason).toBe("Transport");
    expect((sdkTimeout.cause as DOMException).name).toBe("TimeoutError");

    const healthBefore = rpc.counts.health;
    const settingsBefore = rpc.counts.settings;
    const quotaBefore = rpc.counts.quota;
    const healthCheck = deferred<DashboardHealth>();
    const freshSettings = deferred<SettingsSnapshot>();
    const freshQuota = deferred<QuotaSnapshot>();
    rpc.nextHealth(() => healthCheck.promise);
    rpc.nextSettings(() => freshSettings.promise);
    rpc.nextQuota(() => freshQuota.promise);
    rpc.watches[0]?.reject(sdkTimeout);
    await waitFor(
      () => rpc.counts.health === healthBefore + 1,
      "pending recovery attempt health check",
    );
    const staleRecoverySignal = rpc.healthSignals[rpc.healthSignals.length - 1];

    await client.setActiveView("analytics");
    expect(staleRecoverySignal?.aborted).toBe(true);
    await waitFor(
      () =>
        client.connection() === "live" &&
        rpc.counts.health >= healthBefore + 2 &&
        rpc.watches.length === 2 &&
        rpc.counts.settings === settingsBefore + 1 &&
        rpc.counts.quota === quotaBefore + 1,
      "latest-scope full recovery and fresh reads",
    );
    expect(source.view().cards).toEqual([]);
    expect(rpc.watches[1]?.scope).toBe("analytics");
    expect(source.view().cards).toEqual([]);
    expect(rpc.eventSignals).toHaveLength(2);
    expect(rpc.eventSignals[0]?.aborted).toBe(true);
    expect(rpc.eventSignals[1]?.aborted).toBe(false);
    expect(rpc.watches.filter((watch) => !watch.signal.aborted)).toHaveLength(1);

    // Resolving the superseded health call later cannot install a stale viewer.
    healthCheck.resolve({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION,
      version: "1.2.0",
      build: "native-test",
    });
    await flush();
    expect(rpc.watches).toHaveLength(2);

    freshQuota.resolve(quotaSnapshot());
    await flush();
    expect(source.view().cards).toEqual([]);
    freshSettings.resolve(settingsSnapshot());
    await waitFor(() => source.view().cards.length === 1, "fresh settings and quota applied");

    const recoveredSettings = rpc.counts.settings;
    const recoveredQuota = rpc.counts.quota;
    rpc.watches[1]?.reject(new Error("renewed viewer ended"));
    await waitFor(() => client.connection() === "reconnecting", "lost renewed viewer");
    expect(source.view().cards).toEqual([]);
    expect(rpc.watches).toHaveLength(2);
    expect(rpc.counts.settings).toBe(recoveredSettings);
    expect(rpc.counts.quota).toBe(recoveredQuota);
    expect(rpc.watches.filter((watch) => !watch.signal.aborted)).toHaveLength(0);
    client.dispose();
  });

  it("does not check while the host is down and resumes on host return", async () => {
    const rpc = recoveryRpc();
    const client = createNativeDashboardClient({ rpc: rpc.caller, scope: "quota" });
    const [active] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const source = await mount({ client, active, hostConnected });
    await waitFor(
      () => rpc.watches.length === 1 && source.view().cards.length === 1,
      "initial data",
    );

    setHostConnected(false);
    await flush();
    expect(source.view().cards).toEqual([]);
    const healthBefore = rpc.counts.health;
    const settingsBefore = rpc.counts.settings;
    const quotaBefore = rpc.counts.quota;
    rpc.watches[0]?.reject(sdkWatchTimeout());
    await waitFor(
      () => client.connection() === "reconnecting" && rpc.watches[0]?.signal.aborted === true,
      "single failed recovery while host is down",
    );
    await flush();

    expect(rpc.counts.health).toBe(healthBefore);
    expect(rpc.watches).toHaveLength(1);
    expect(rpc.counts.settings).toBe(settingsBefore);
    expect(rpc.counts.quota).toBe(quotaBefore);

    setHostConnected(true);
    await waitFor(
      () =>
        client.connection() === "live" &&
        rpc.watches.length === 2 &&
        rpc.counts.settings === settingsBefore + 1 &&
        rpc.counts.quota === quotaBefore + 1 &&
        source.view().cards.length === 1,
      "host-return reconnect and fresh reads",
    );
    expect(rpc.watches.filter((watch) => !watch.signal.aborted)).toHaveLength(1);
    client.dispose();
  });

  it("cancels pending timeout recovery while the host is down and resumes once on return", async () => {
    const rpc = recoveryRpc();
    const client = createNativeDashboardClient({ rpc: rpc.caller, scope: "quota" });
    const [active] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const source = await mount({ client, active, hostConnected });
    await waitFor(
      () => rpc.watches.length === 1 && source.view().cards.length === 1,
      "initial data and viewer",
    );

    const healthBefore = rpc.counts.health;
    const pendingHealth = deferred<DashboardHealth>();
    rpc.nextHealth(() => pendingHealth.promise);
    rpc.watches[0]?.reject(sdkWatchTimeout());
    await waitFor(() => rpc.counts.health === healthBefore + 1, "pending timeout health check");
    const recoverySignal = rpc.healthSignals[rpc.healthSignals.length - 1];

    setHostConnected(false);
    await waitFor(
      () =>
        recoverySignal?.aborted === true &&
        rpc.watches[0]?.signal.aborted === true &&
        rpc.eventSignals[0]?.aborted === true,
      "host loss cancels recovery and releases transport resources",
    );
    expect(client.connection()).toBe("reconnecting");
    expect(source.view().cards).toEqual([]);

    pendingHealth.resolve({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION,
      version: "1.2.0",
      build: "native-test",
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(rpc.watches).toHaveLength(1);
    expect(client.connection()).toBe("reconnecting");
    source.retry();
    await flush();
    expect(rpc.watches).toHaveLength(1);

    setHostConnected(true);
    await waitFor(
      () =>
        client.connection() === "live" &&
        rpc.watches.length === 2 &&
        source.view().cards.length === 1,
      "single host-return recovery and fresh reads",
    );
    expect(rpc.watches[1]?.scope).toBe("quota");
    expect(rpc.watches.filter((watch) => !watch.signal.aborted)).toHaveLength(1);
    expect(rpc.eventSignals.filter((signal) => !signal.aborted)).toHaveLength(1);

    client.dispose();
    expect(rpc.watches.every((watch) => watch.signal.aborted)).toBe(true);
    expect(rpc.eventSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("restores cards when retry succeeds after recovery settings and quota reads fail", async () => {
    const fake = recordingClient();
    const [active] = createSignal(true);
    const source = await mount({ client: fake.client, active });
    expect(source.view().cards).toHaveLength(1);

    fake.setSettings(async () => {
      throw new Error("settings temporarily unavailable");
    });
    fake.setQuota(async () => {
      throw new Error("quota temporarily unavailable");
    });
    await fake.client.reconnect();
    await flush();
    expect(source.settingsError()).toBeDefined();
    expect(source.quotaError()).toBeDefined();
    expect(source.view().cards).toEqual([]);

    fake.setSettings(async () => settingsSnapshot({ revision: "recovered-settings" }));
    fake.setQuota(async () => quotaSnapshot());
    source.retry();
    await flush();

    expect(source.settingsError()).toBeUndefined();
    expect(source.quotaError()).toBeUndefined();
    expect(source.view().cards).toHaveLength(1);
  });
});
