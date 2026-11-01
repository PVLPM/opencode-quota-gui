import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  DashboardEvent,
  DashboardHealth,
  QuotaSnapshot,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard.js";
import type { NativeDashboardConnection } from "../src/native/dashboard-client.js";
import type { QuotaPanelClient, QuotaPanelState } from "../src/native/quota-panel-state.js";
import { homeSnapshot, NOW, settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Native Quota panel lifecycle (Stage 4).
 *
 * The panel owns the same read/invalidate/stale lifecycle as the browser route,
 * with two host rules: the RPC subscription exists only while the tab is
 * visible, and recovery follows the host's built-in server connection, with an
 * explicit retry instead of a page reload. These tests drive the real
 * controller against a recording client; no DOM, no timers and no polling.
 *
 * Solid's Node export is the inert server build, so the controller and the
 * signals around it are loaded through a Vite server aliased to the client
 * runtime; otherwise no effect would ever run and the assertions would be
 * meaningless.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type CreateRoot = (callback: (dispose: () => void) => void) => () => void;
type CreateSignal = <T>(value: T) => [() => T, (next: T) => T];

let server: ViteDevServer | undefined;
let createRoot: CreateRoot;
let createSignal: CreateSignal;
let createQuotaPanelState: (options: {
  client: QuotaPanelClient;
  visible: () => boolean;
}) => QuotaPanelState;

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
  // SAFETY: the Vite alias above resolves `solid-js` to the client build, whose
  // `CreateRoot` and `CreateSignal` shapes are the ones this file declares.
  const core = (await created.ssrLoadModule("solid-js")) as {
    createRoot: CreateRoot;
    createSignal: CreateSignal;
  };
  createRoot = core.createRoot;
  createSignal = core.createSignal;
  // SAFETY: this is the module the assertions below drive; a missing export
  // makes the cast undefined and every test fail immediately.
  const stateModule = (await created.ssrLoadModule(
    path.join(repoRoot, "src/native/quota-panel-state.ts"),
  )) as { createQuotaPanelState: typeof createQuotaPanelState };
  createQuotaPanelState = stateModule.createQuotaPanelState;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function quotaSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: homeSnapshot().providers,
    ...overrides,
  };
}

function deferredQuota(): {
  promise: Promise<QuotaSnapshot>;
  resolve: (snapshot: QuotaSnapshot) => void;
} {
  let resolve!: (snapshot: QuotaSnapshot) => void;
  const promise = new Promise<QuotaSnapshot>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

interface RecordingClient {
  client: QuotaPanelClient;
  counts: {
    quota: number;
    settings: number;
    health: number;
    subscribes: number;
    unsubscribes: number;
    reconnects: number;
  };
  emit: (event: DashboardEvent) => void;
  setConnection: (state: NativeDashboardConnection) => void;
  fireReconnect: () => void;
  failQuota: (error: Error) => void;
  succeedQuota: () => void;
  setQuota: (quota: () => Promise<QuotaSnapshot>) => void;
  listenReconnect: (listener: () => void) => () => void;
}

function recordingClient(
  options: {
    quota?: () => Promise<QuotaSnapshot>;
    settings?: () => Promise<SettingsSnapshot>;
    health?: () => Promise<DashboardHealth>;
  } = {},
): RecordingClient {
  const counts = {
    quota: 0,
    settings: 0,
    health: 0,
    subscribes: 0,
    unsubscribes: 0,
    reconnects: 0,
  };
  const listeners = new Set<(event: DashboardEvent) => void>();
  const connectionListeners = new Set<(state: NativeDashboardConnection) => void>();
  const reconnectListeners = new Set<() => void>();
  let connection: NativeDashboardConnection = "live";
  let quotaImpl = options.quota ?? (async () => quotaSnapshot());
  const settingsImpl = options.settings ?? (async () => settingsSnapshot());
  const healthImpl =
    options.health ??
    (async (): Promise<DashboardHealth> => ({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION,
      version: "1.2.0",
      build: "native-test",
    }));

  const client: QuotaPanelClient = {
    async quota() {
      counts.quota += 1;
      return quotaImpl();
    },
    async settings() {
      counts.settings += 1;
      return settingsImpl();
    },
    async health() {
      counts.health += 1;
      return healthImpl();
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
      connection = "live";
      for (const listener of connectionListeners) listener("live");
      for (const listener of reconnectListeners) listener();
    },
  };

  return {
    client,
    counts,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    setConnection: (state) => {
      connection = state;
      for (const listener of connectionListeners) listener(state);
    },
    fireReconnect: () => {
      for (const listener of reconnectListeners) listener();
    },
    failQuota: (error) => {
      quotaImpl = async () => {
        throw error;
      };
    },
    succeedQuota: () => {
      quotaImpl = async () => quotaSnapshot();
    },
    setQuota: (quota) => {
      quotaImpl = quota;
    },
    listenReconnect: (listener) => {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
  };
}

const mounted: Array<() => void> = [];

async function mountPanel(options: {
  client: QuotaPanelClient;
  visible: () => boolean;
  hostConnected?: () => boolean;
}): Promise<QuotaPanelState> {
  let state!: QuotaPanelState;
  await new Promise<void>((resolve) => {
    createRoot((dispose) => {
      mounted.push(dispose);
      state = createQuotaPanelState(options);
      resolve();
    });
  });
  await flush();
  return state;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

describe("native Quota panel state", () => {
  it("does not read or subscribe while the tab is hidden", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(false);
    await mountPanel({ client: fake.client, visible });

    expect(fake.counts.subscribes).toBe(0);
    expect(fake.counts.quota).toBe(0);
    expect(fake.counts.settings).toBe(0);
    expect(fake.counts.health).toBe(0);
  });

  it("subscribes and loads both payloads when the tab becomes visible", async () => {
    const fake = recordingClient();
    const [visible, setVisible] = createSignal(false);
    const state = await mountPanel({ client: fake.client, visible });

    setVisible(true);
    await flush();

    expect(fake.counts.subscribes).toBe(1);
    expect(fake.counts.quota).toBe(1);
    expect(fake.counts.settings).toBe(1);
    expect(fake.counts.health).toBe(1);
    expect(state.state().kind).toBe("ready");
    expect(state.stale()).toBe(false);
    expect(state.quota()?.providers.cards.length).toBe(1);
  });

  it("drops the subscription when the tab is hidden", async () => {
    const fake = recordingClient();
    const [visible, setVisible] = createSignal(true);
    await mountPanel({ client: fake.client, visible });

    setVisible(false);
    await flush();
    expect(fake.counts.unsubscribes).toBe(1);

    fake.emit({ topic: "quota.changed", at: 1 });
    await flush();
    expect(fake.counts.quota).toBe(1);
  });

  it("refetches on show and on an explicit reconnect", async () => {
    const fake = recordingClient();
    const [visible, setVisible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });
    expect(fake.counts.quota).toBe(1);

    setVisible(false);
    await flush();
    setVisible(true);
    await flush();
    expect(fake.counts.quota).toBe(2);

    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(fake.counts.quota).toBe(3);
    expect(fake.counts.settings).toBe(3);
    expect(fake.counts.health).toBe(3);
  });

  it("marks already-loaded data stale immediately when the transport leaves live", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });
    expect(state.state().kind).toBe("ready");
    const quotaBefore = fake.counts.quota;

    fake.setConnection("reconnecting");
    await flush();

    const current = state.state();
    expect(current.kind).toBe("ready");
    if (current.kind !== "ready") throw new Error("expected a retained payload");
    expect(current.stale).toBe(true);
    expect(state.stale()).toBe(true);
    expect(state.quota()?.providers.cards.length).toBe(1);
    expect(fake.counts.quota).toBe(quotaBefore);
    expect(fake.counts.reconnects).toBe(0);
  });

  it("keeps ready data stale and retryable while the host connection is down", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible, hostConnected });
    const quotaBefore = fake.counts.quota;

    setHostConnected(false);
    await flush();

    const current = state.state();
    expect(current.kind).toBe("ready");
    if (current.kind !== "ready") throw new Error("expected a retained payload");
    expect(current.stale).toBe(true);
    expect(state.stale()).toBe(true);
    expect(state.quota()?.providers.cards.length).toBe(1);
    expect(fake.counts.quota).toBe(quotaBefore);
    expect(fake.counts.reconnects).toBe(0);

    fake.failQuota(new Error("offline"));
    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.stale()).toBe(true);
  });

  it("retries a connection-only loss and clears stale after the refetch lands", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });
    const pending = deferredQuota();
    fake.setQuota(() => pending.promise);

    fake.setConnection("reconnecting");
    await flush();
    expect(state.stale()).toBe(true);

    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.stale()).toBe(true);

    pending.resolve(quotaSnapshot());
    await flush();
    expect(state.stale()).toBe(false);
  });

  it("reconnects on host recovery and clears stale only after the refetch lands", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible, hostConnected });
    const pending = deferredQuota();
    fake.setQuota(() => pending.promise);

    setHostConnected(false);
    await flush();
    expect(state.stale()).toBe(true);
    expect(fake.counts.reconnects).toBe(0);

    setHostConnected(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(fake.counts.quota).toBe(2);
    expect(state.stale()).toBe(true);

    pending.resolve(quotaSnapshot());
    await flush();
    expect(state.stale()).toBe(false);
  });

  it("refreshes settings on settings.changed without refetching quota", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    await mountPanel({ client: fake.client, visible });
    const quotaBefore = fake.counts.quota;

    fake.emit({ topic: "settings.changed", at: 2 });
    await flush();
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.quota).toBe(quotaBefore);

    fake.emit({ topic: "quota.changed", at: 3 });
    await flush();
    expect(fake.counts.quota).toBe(quotaBefore + 1);
  });

  it("keeps the last payload but marks it stale when a refetch fails", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });
    expect(state.state().kind).toBe("ready");

    fake.failQuota(new Error("offline"));
    fake.emit({ topic: "quota.changed", at: 4 });
    await flush();

    const current = state.state();
    expect(current.kind).toBe("ready");
    if (current.kind !== "ready") throw new Error("expected a retained payload");
    expect(current.stale).toBe(true);
    expect(state.stale()).toBe(true);
    expect(state.quota()?.providers.cards.length).toBe(1);
  });

  it("stays stale after a reconnect whose refetch fails, then clears on success", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    fake.failQuota(new Error("offline"));
    fake.fireReconnect();
    await flush();
    expect(state.stale()).toBe(true);

    fake.succeedQuota();
    fake.fireReconnect();
    await flush();
    expect(state.stale()).toBe(false);
  });

  it("derives display preferences and visibility from the settings payload", async () => {
    const fake = recordingClient({
      settings: async () =>
        settingsSnapshot({
          values: { percentDisplayMode: "used", accountingDetail: "detailed" },
          visibility: { hiddenCards: ["card-1"], hiddenRows: ["row-1"] },
        }),
    });
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    expect(state.preferences().percentMode).toBe("used");
    expect(state.preferences().detailed).toBe(true);
    expect(state.hiddenCards()).toEqual(["card-1"]);
    expect(state.hiddenRows()).toEqual(["row-1"]);
  });

  it("reports a contract mismatch from the health read", async () => {
    const fake = recordingClient({
      health: async () => ({
        app: "opencode-quota-gui",
        contractVersion: 1,
        version: "1.2.0",
        build: "native-test",
      }),
    });
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    expect(state.contractMismatch()).toContain("contract version");
    expect(state.stale()).toBe(false);
  });

  it("tracks the transport and keeps stale through a reconnect until it recovers", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    fake.setConnection("reconnecting");
    expect(state.connection()).toBe("reconnecting");
    expect(state.stale()).toBe(true);
    expect(state.state().kind).toBe("ready");
    if (state.state().kind === "ready") expect(state.state().stale).toBe(true);
    expect(state.quota()?.providers.cards.length).toBe(1);

    fake.setConnection("live");
    expect(state.connection()).toBe("live");
    expect(state.stale()).toBe(false);
  });
});
