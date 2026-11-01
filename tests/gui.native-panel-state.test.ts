import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  DashboardEvent,
  DashboardHealth,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard.js";
import type { NativeDashboardConnection } from "../src/native/dashboard-client.js";
import type { DashboardPanelClient, DashboardPanelState } from "../src/native/panel-state.js";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Native dashboard panel lifecycle (Stage 5).
 *
 * The shell owns only cross-route concerns: the settings read (display
 * preferences and visibility), diagnostics, refresh tokens and host recovery.
 * Quota and analytics reads stay in the shared route containers and are tested
 * there. These tests drive the controller against a recording client; no DOM,
 * no timers and no polling.
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
let createDashboardPanelState: (options: {
  client: DashboardPanelClient;
  visible: () => boolean;
  hostConnected?: () => boolean;
}) => DashboardPanelState;

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
    path.join(repoRoot, "src/native/panel-state.ts"),
  )) as { createDashboardPanelState: typeof createDashboardPanelState };
  createDashboardPanelState = stateModule.createDashboardPanelState;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface RecordingClient {
  client: DashboardPanelClient;
  counts: {
    settings: number;
    health: number;
    subscribes: number;
    unsubscribes: number;
    reconnects: number;
    scopes: string[];
  };
  emit: (event: DashboardEvent) => void;
  setConnection: (state: NativeDashboardConnection) => void;
  fireReconnect: () => void;
  setReconnectSucceeds: (succeeds: boolean) => void;
  setSettings: (settings: () => Promise<SettingsSnapshot>) => void;
}

function recordingClient(
  options: {
    settings?: () => Promise<SettingsSnapshot>;
    health?: () => Promise<DashboardHealth>;
  } = {},
): RecordingClient {
  const counts = {
    settings: 0,
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
  let reconnectSucceeds = true;
  let settingsImpl = options.settings ?? (async () => settingsSnapshot());
  const healthImpl =
    options.health ??
    (async (): Promise<DashboardHealth> => ({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION,
      version: "1.2.0",
      build: "native-test",
    }));

  function setConnectionState(state: NativeDashboardConnection): void {
    connection = state;
    for (const listener of connectionListeners) listener(state);
  }

  function fireReconnect(): void {
    for (const listener of reconnectListeners) listener();
  }

  const client: DashboardPanelClient = {
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
      if (!reconnectSucceeds) {
        setConnectionState("reconnecting");
        return;
      }
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
    setReconnectSucceeds: (succeeds) => {
      reconnectSucceeds = succeeds;
    },
    setSettings: (settings) => {
      settingsImpl = settings;
    },
  };
}

const mounted: Array<() => void> = [];

async function mountPanel(options: {
  client: DashboardPanelClient;
  visible: () => boolean;
  hostConnected?: () => boolean;
}): Promise<DashboardPanelState> {
  let state!: DashboardPanelState;
  await new Promise<void>((resolve) => {
    createRoot((dispose) => {
      mounted.push(dispose);
      state = createDashboardPanelState(options);
      resolve();
    });
  });
  await flush();
  return state;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

describe("native dashboard panel state", () => {
  it("does not read or subscribe while the tab is hidden", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(false);
    const state = await mountPanel({ client: fake.client, visible });

    expect(fake.counts.subscribes).toBe(0);
    expect(fake.counts.settings).toBe(0);
    expect(fake.counts.health).toBe(0);
    expect(state.reloadToken()).toBe(0);
    expect(state.quotaReloadToken()).toBe(0);
  });

  it("subscribes and loads settings and diagnostics when the tab becomes visible", async () => {
    const fake = recordingClient();
    const [visible, setVisible] = createSignal(false);
    const state = await mountPanel({ client: fake.client, visible });

    setVisible(true);
    await flush();

    expect(fake.counts.subscribes).toBe(1);
    expect(fake.counts.settings).toBe(1);
    expect(fake.counts.health).toBe(1);
    expect(state.settings()?.revision).toBe(settingsSnapshot().revision);
    expect(state.connection()).toBe("live");
    expect(state.hostStale()).toBe(false);
  });

  it("drops the subscription when hidden and refetches the shell on return", async () => {
    const fake = recordingClient();
    const [visible, setVisible] = createSignal(true);
    await mountPanel({ client: fake.client, visible });

    setVisible(false);
    await flush();
    expect(fake.counts.unsubscribes).toBe(1);

    fake.emit({ topic: "settings.changed", at: 1 });
    await flush();
    expect(fake.counts.settings).toBe(1);

    setVisible(true);
    await flush();
    expect(fake.counts.subscribes).toBe(2);
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.health).toBe(2);
  });

  it("bumps distinct refresh tokens for settings, quota and analytics invalidations", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    fake.emit({ topic: "settings.changed", at: 1 });
    await flush();
    expect(fake.counts.settings).toBe(2);
    expect(state.reloadToken()).toBe(0);
    expect(state.quotaReloadToken()).toBe(0);

    fake.emit({ topic: "quota.changed", at: 2 });
    await flush();
    expect(state.quotaReloadToken()).toBe(1);
    expect(state.reloadToken()).toBe(0);

    fake.emit({ topic: "sessions.changed", at: 3 });
    await flush();
    expect(state.reloadToken()).toBe(1);
    expect(state.quotaReloadToken()).toBe(1);
  });

  it("refreshes settings and advances the reconnect epoch on transport recovery", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    fake.setConnection("reconnecting");
    await flush();
    expect(state.connection()).toBe("reconnecting");

    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.reconnectEpoch()).toBe(1);
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.health).toBe(2);
    expect(state.connection()).toBe("live");
  });

  it("marks cached data stale on host loss and clears it only after recovery and a read land", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible, hostConnected });

    setHostConnected(false);
    await flush();
    expect(state.hostStale()).toBe(true);
    expect(fake.counts.reconnects).toBe(0);

    // A read that was already in flight cannot anchor the dropped host.
    state.markFresh();
    await flush();
    expect(state.hostStale()).toBe(true);

    setHostConnected(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    // The transport is back, but no routed payload has landed yet.
    expect(state.hostStale()).toBe(true);

    state.markFresh();
    await flush();
    expect(state.hostStale()).toBe(false);
  });

  it("keeps host stale when the reconnect fails and clears it on the next successful read", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible, hostConnected });

    fake.setReconnectSucceeds(false);
    setHostConnected(false);
    await flush();
    setHostConnected(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.connection()).toBe("reconnecting");

    state.markFresh();
    await flush();
    expect(state.hostStale()).toBe(true);

    fake.setReconnectSucceeds(true);
    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(2);
    expect(state.reconnectEpoch()).toBe(1);

    state.markFresh();
    await flush();
    expect(state.hostStale()).toBe(false);
  });

  it("completes a host recovery that happened while the tab was hidden", async () => {
    const fake = recordingClient();
    const [visible, setVisible] = createSignal(false);
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible, hostConnected });

    setHostConnected(false);
    await flush();
    setHostConnected(true);
    await flush();
    // No viewer is held while hidden, so the recovery is deferred, not lost.
    expect(fake.counts.reconnects).toBe(0);
    expect(state.hostStale()).toBe(true);

    setVisible(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.reconnectEpoch()).toBe(1);

    state.markFresh();
    await flush();
    expect(state.hostStale()).toBe(false);
  });

  it("retries an explicit connection loss", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    fake.setConnection("reconnecting");
    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.connection()).toBe("live");
  });

  it("keeps the last settings payload and reports stale when a refresh fails", async () => {
    const fake = recordingClient({
      settings: async () =>
        settingsSnapshot({
          visibility: { hiddenCards: ["card-1"], hiddenRows: ["row-1"] },
        }),
    });
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });
    const loaded = state.settings();
    expect(loaded?.revision).toBe(settingsSnapshot().revision);
    expect(loaded?.visibility.hiddenCards).toEqual(["card-1"]);
    expect(state.settingsStale()).toBe(false);

    fake.setSettings(async () => {
      throw new Error("offline");
    });
    fake.emit({ topic: "settings.changed", at: 4 });
    await flush();

    expect(state.settings()).toBe(loaded);
    expect(state.settings()?.visibility.hiddenCards).toEqual(["card-1"]);
    expect(state.settingsError()).toBeDefined();
    expect(state.settingsStale()).toBe(true);
    expect(fake.counts.reconnects).toBe(0);
  });

  it("does not turn an initial settings failure into authoritative defaults", async () => {
    const fake = recordingClient({
      settings: async () => {
        throw new Error("settings offline");
      },
    });
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    expect(state.settings()).toBeUndefined();
    expect(state.settingsError()).toBeDefined();
    expect(state.settingsStale()).toBe(true);
    // No synthesized preference payload: the panel shows a retry, not defaults.
    expect(state.preferences()).toBeUndefined();
  });

  it("retries a failed settings read without reopening a live transport", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    fake.setSettings(async () => {
      throw new Error("offline");
    });
    fake.emit({ topic: "settings.changed", at: 5 });
    await flush();
    expect(state.settingsStale()).toBe(true);

    fake.setSettings(async () => settingsSnapshot({ revision: "revision-2" }));
    state.retry();
    await flush();

    expect(fake.counts.reconnects).toBe(0);
    expect(fake.counts.settings).toBe(3);
    expect(state.settings()?.revision).toBe("revision-2");
    expect(state.settingsStale()).toBe(false);
  });

  it("exposes the settings payload that drives display preferences and visibility", async () => {
    const fake = recordingClient({
      settings: async () =>
        settingsSnapshot({
          values: { percentDisplayMode: "used", accountingDetail: "detailed" },
          visibility: { hiddenCards: ["card-1"], hiddenRows: ["row-1"] },
        }),
    });
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    expect(state.settings()?.visibility.hiddenCards).toEqual(["card-1"]);
    expect(state.settings()?.visibility.hiddenRows).toEqual(["row-1"]);
    expect(state.preferences()?.percentMode).toBe("used");
    expect(state.preferences()?.detailed).toBe(true);
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
    expect(state.hostStale()).toBe(false);
  });

  it("reasserts the viewer scope the current section needs", async () => {
    const fake = recordingClient();
    const [visible] = createSignal(true);
    const state = await mountPanel({ client: fake.client, visible });

    state.setScope("analytics");
    state.setScope("quota");
    await flush();
    expect(fake.counts.scopes).toEqual(["analytics", "quota"]);
  });
});
