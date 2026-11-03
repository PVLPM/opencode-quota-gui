import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  DashboardEvent,
  QuotaSnapshot,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import type { NativeDashboardConnection } from "../src/native/dashboard-client.js";
import type {
  SettingsPageClient,
  SettingsPageOptions,
  SettingsPageState,
} from "../src/native/settings-page-state.js";
import { NOW, percentRow, providerCard, settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Native SettingsPage lifecycle (Stage 5).
 *
 * The page reuses the shared settings view, so these tests cover only its host
 * lifecycle: the settings read, the optional quota snapshot behind visibility
 * and temporal rows, live invalidation, reconnect freshness, and in-memory
 * catalog retention. Drafting, validation, conflicts and writes remain the
 * shared view/model's tests.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type CreateRoot = (callback: (dispose: () => void) => void) => () => void;
type CreateSignal = <T>(value: T) => [() => T, (next: T) => T];

let server: ViteDevServer | undefined;
let createRoot: CreateRoot;
let createSignal: CreateSignal;
let createSettingsPageState: (
  client: SettingsPageClient,
  options?: SettingsPageOptions,
) => SettingsPageState;

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
    path.join(repoRoot, "src/native/settings-page-state.ts"),
  )) as { createSettingsPageState: typeof createSettingsPageState };
  createSettingsPageState = stateModule.createSettingsPageState;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const PROVIDER_ID = "synthetic-provider";
const CARD_ID = `${PROVIDER_ID}:${"a".repeat(64)}` as CardId;
const CATALOG_CARD = providerCard({
  cardId: CARD_ID,
  rows: [percentRow({ rowId: `${CARD_ID}#window:five_hour` as RowId })],
});

function quotaSnapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: {
      cards: [CATALOG_CARD],
      enabledProviders: "auto",
      polledAtMs: NOW - 60_000,
    },
    ...overrides,
  };
}

function emptyQuota(): QuotaSnapshot {
  return quotaSnapshot({
    providers: {
      cards: [],
      enabledProviders: "auto",
      polledAtMs: NOW - 60_000,
    },
  });
}

interface RecordingClient {
  client: SettingsPageClient;
  counts: {
    settings: number;
    quota: number;
    subscribes: number;
    unsubscribes: number;
    reconnects: number;
  };
  emit: (event: DashboardEvent) => void;
  setConnection: (state: NativeDashboardConnection) => void;
  fireReconnect: () => void;
  setReconnectSucceeds: (succeeds: boolean) => void;
  setSettings: (settings: () => Promise<SettingsSnapshot>) => void;
  setQuota: (quota: () => Promise<QuotaSnapshot>) => void;
}

function recordingClient(
  options: {
    settings?: () => Promise<SettingsSnapshot>;
    quota?: () => Promise<QuotaSnapshot>;
  } = {},
): RecordingClient {
  const counts = {
    settings: 0,
    quota: 0,
    subscribes: 0,
    unsubscribes: 0,
    reconnects: 0,
  };
  const listeners = new Set<(event: DashboardEvent) => void>();
  const connectionListeners = new Set<(state: NativeDashboardConnection) => void>();
  const reconnectListeners = new Set<() => void>();
  let connection: NativeDashboardConnection = "live";
  let reconnectSucceeds = true;
  let settingsImpl = options.settings ?? (async () => settingsSnapshot());
  let quotaImpl = options.quota ?? (async () => quotaSnapshot());

  function setConnectionState(state: NativeDashboardConnection): void {
    connection = state;
    for (const listener of connectionListeners) listener(state);
  }

  function fireReconnect(): void {
    for (const listener of reconnectListeners) listener();
  }

  const client: SettingsPageClient = {
    async settings() {
      counts.settings += 1;
      return settingsImpl();
    },
    async quota() {
      counts.quota += 1;
      return quotaImpl();
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
    setQuota: (quota) => {
      quotaImpl = quota;
    },
  };
}

const mounted: Array<() => void> = [];

async function mountState(
  client: SettingsPageClient,
  options?: SettingsPageOptions,
): Promise<SettingsPageState> {
  let state!: SettingsPageState;
  await new Promise<void>((resolve) => {
    createRoot((dispose) => {
      mounted.push(dispose);
      state = createSettingsPageState(client, options);
      resolve();
    });
  });
  await flush();
  return state;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

describe("native SettingsPage state", () => {
  it("reads settings and the quota catalog on mount and subscribes once", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    expect(fake.counts.settings).toBe(1);
    expect(fake.counts.quota).toBe(1);
    expect(fake.counts.subscribes).toBe(1);
    expect(state.query.data()?.revision).toBe(settingsSnapshot().revision);
    expect(state.catalog().cards.length).toBe(1);
    expect(state.connection()).toBe("live");
    expect(state.loading()).toBe(false);
    expect(state.stale()).toBe(false);
  });

  it("refreshes only settings on settings.changed and only quota on quota.changed", async () => {
    const fake = recordingClient();
    await mountState(fake.client);

    fake.emit({ topic: "settings.changed", at: 1 });
    await flush();
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.quota).toBe(1);

    fake.emit({ topic: "quota.changed", at: 2 });
    await flush();
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.quota).toBe(2);
  });

  it("keeps catalog identities in memory when a later quota read omits them", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);
    expect(state.catalog().cards.length).toBeGreaterThan(0);

    fake.setQuota(async () => emptyQuota());
    fake.emit({ topic: "quota.changed", at: 3 });
    await flush();

    expect(state.catalog().cards.length).toBeGreaterThan(0);
    expect(state.catalog().cards[0]?.cardId).toBe(CATALOG_CARD.cardId);
  });

  it("reports initial loading until the first settings and quota reads both settle", async () => {
    let resolveQuota!: (snapshot: QuotaSnapshot) => void;
    const fake = recordingClient({
      quota: () =>
        new Promise<QuotaSnapshot>((resolve) => {
          resolveQuota = resolve;
        }),
    });
    const state = await mountState(fake.client);

    // Settings landed first; the catalog and temporal rows still come from quota.
    expect(state.query.data()).toBeDefined();
    expect(state.quota()).toBeUndefined();
    expect(state.loading()).toBe(true);
    expect(state.retryable()).toBe(false);
    expect(state.stale()).toBe(false);

    resolveQuota(emptyQuota());
    await flush();

    // A successful empty snapshot is legitimate: it settles loading, not stale.
    expect(state.loading()).toBe(false);
    expect(state.retryable()).toBe(false);
    expect(state.stale()).toBe(false);
    expect(state.catalog().cards).toEqual([]);
  });

  it("offers retry when settings fails while the quota first read is still pending", async () => {
    let resolveQuota!: (snapshot: QuotaSnapshot) => void;
    const fake = recordingClient({
      settings: async () => {
        throw new Error("settings offline");
      },
      quota: () =>
        new Promise<QuotaSnapshot>((resolve) => {
          resolveQuota = resolve;
        }),
    });
    const state = await mountState(fake.client);

    expect(state.query.error()).toBeDefined();
    expect(state.quota()).toBeUndefined();
    // The settled failure is actionable, not an endless first load.
    expect(state.loading()).toBe(false);
    expect(state.stale()).toBe(true);
    expect(state.retryable()).toBe(true);

    // The still-pending quota landing must not clear the settings failure.
    resolveQuota(quotaSnapshot());
    await flush();
    expect(state.loading()).toBe(false);
    expect(state.stale()).toBe(true);
    expect(state.retryable()).toBe(true);
    expect(state.query.error()).toBeDefined();
  });

  it("offers retry when quota fails while the settings first read is still pending", async () => {
    let resolveSettings!: (snapshot: SettingsSnapshot) => void;
    const fake = recordingClient({
      settings: () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveSettings = resolve;
        }),
      quota: async () => {
        throw new Error("quota offline");
      },
    });
    const state = await mountState(fake.client);

    expect(state.query.data()).toBeUndefined();
    expect(state.quota()).toBeUndefined();
    expect(state.quotaStale()).toBe(true);
    expect(state.loading()).toBe(false);
    expect(state.retryable()).toBe(true);

    resolveSettings(settingsSnapshot());
    await flush();
    // Settings arrived, but quota still has no payload: the empty catalog must
    // not be presented as current.
    expect(state.query.data()).toBeDefined();
    expect(state.quota()).toBeUndefined();
    expect(state.loading()).toBe(false);
    expect(state.retryable()).toBe(true);
  });

  it("retries a settled failure without applying the superseded pending response", async () => {
    let resolveFirstQuota!: (snapshot: QuotaSnapshot) => void;
    const fake = recordingClient({
      settings: async () => {
        throw new Error("settings offline");
      },
      quota: () =>
        new Promise<QuotaSnapshot>((resolve) => {
          resolveFirstQuota = resolve;
        }),
    });
    const state = await mountState(fake.client);
    expect(state.retryable()).toBe(true);

    fake.setSettings(async () => settingsSnapshot({ revision: "revision-2" }));
    let resolveSecondQuota!: (snapshot: QuotaSnapshot) => void;
    fake.setQuota(
      () =>
        new Promise<QuotaSnapshot>((resolve) => {
          resolveSecondQuota = resolve;
        }),
    );
    state.retry();
    await flush();

    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.quota).toBe(2);
    expect(state.query.data()?.revision).toBe("revision-2");
    // The settings failure is gone; the second quota read is still a clean load.
    expect(state.loading()).toBe(true);
    expect(state.retryable()).toBe(false);
    expect(state.stale()).toBe(false);

    // A late response from the superseded request must be ignored.
    resolveFirstQuota(emptyQuota());
    await flush();
    expect(state.quota()).toBeUndefined();
    expect(state.loading()).toBe(true);

    resolveSecondQuota(quotaSnapshot());
    await flush();
    expect(state.quota()).not.toBeUndefined();
    expect(state.loading()).toBe(false);
    expect(state.stale()).toBe(false);
    expect(state.retryable()).toBe(false);
  });

  it("stays stale after reconnect until BOTH settings and quota refetches land", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    let resolveSettings!: (snapshot: SettingsSnapshot) => void;
    let resolveQuota!: (snapshot: QuotaSnapshot) => void;
    fake.setSettings(
      () =>
        new Promise<SettingsSnapshot>((resolve) => {
          resolveSettings = resolve;
        }),
    );
    fake.setQuota(
      () =>
        new Promise<QuotaSnapshot>((resolve) => {
          resolveQuota = resolve;
        }),
    );
    fake.fireReconnect();
    await flush();
    expect(state.stale()).toBe(true);

    // Settings landing is not enough: visibility and temporal rows come from quota.
    resolveSettings(settingsSnapshot());
    await flush();
    expect(state.stale()).toBe(true);

    resolveQuota(quotaSnapshot());
    await flush();
    expect(state.stale()).toBe(false);
  });

  it("anchors the conflict reload like any other settings read", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    let resolveQuota!: (snapshot: QuotaSnapshot) => void;
    fake.setSettings(async () => {
      throw new Error("settings offline");
    });
    fake.setQuota(
      () =>
        new Promise<QuotaSnapshot>((resolve) => {
          resolveQuota = resolve;
        }),
    );
    fake.fireReconnect();
    await flush();
    expect(state.stale()).toBe(true);

    // `SettingsRoute` reloads through the exposed query after a save conflict.
    fake.setSettings(async () => settingsSnapshot({ revision: "revision-2" }));
    await expect(state.query.run()).resolves.toBe(true);
    expect(state.query.data()?.revision).toBe("revision-2");
    // Settings is fresh for this epoch, but the quota refetch has not landed.
    expect(state.stale()).toBe(true);

    resolveQuota(quotaSnapshot());
    await flush();
    expect(state.stale()).toBe(false);
  });

  it("refreshes both reads after an explicit reconnect", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    fake.setConnection("reconnecting");
    expect(state.connection()).toBe("reconnecting");
    state.retry();
    await flush();

    expect(fake.counts.reconnects).toBe(1);
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.quota).toBe(2);
    expect(state.connection()).toBe("live");
    expect(state.stale()).toBe(false);
  });

  it("retries reads locally while the transport is still live", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(0);
    expect(fake.counts.settings).toBe(2);
    expect(fake.counts.quota).toBe(2);
  });

  it("keeps the reconnect marker when the quota refetch fails after settings succeeds", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    fake.setQuota(async () => {
      throw new Error("quota offline");
    });
    fake.fireReconnect();
    await flush();

    // Settings landed for the new epoch, but quota did not; visibility and the
    // temporal rows would be old or empty, so the page is still stale.
    expect(state.query.data()?.revision).toBe(settingsSnapshot().revision);
    expect(state.quotaStale()).toBe(true);
    expect(state.stale()).toBe(true);

    fake.setQuota(async () => quotaSnapshot());
    state.retry();
    await flush();
    expect(state.quotaStale()).toBe(false);
    expect(state.stale()).toBe(false);
  });

  it("marks settings stale while a live read fails", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    fake.setSettings(async () => {
      throw new Error("offline");
    });
    fake.emit({ topic: "settings.changed", at: 4 });
    await flush();
    expect(state.stale()).toBe(true);
    expect(state.query.data()?.revision).toBe(settingsSnapshot().revision);
  });

  it("marks settings stale on host loss and clears it only after a successful read", async () => {
    const fake = recordingClient();
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountState(fake.client, { hostConnected });

    setHostConnected(false);
    await flush();
    expect(state.hostStale()).toBe(true);
    expect(state.stale()).toBe(true);
    expect(fake.counts.reconnects).toBe(0);

    // A read that lands while the host is still down cannot anchor it.
    fake.emit({ topic: "settings.changed", at: 5 });
    await flush();
    expect(fake.counts.settings).toBe(2);
    expect(state.hostStale()).toBe(true);

    setHostConnected(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(fake.counts.settings).toBe(3);
    expect(state.hostStale()).toBe(false);
    expect(state.stale()).toBe(false);
  });

  it("keeps the host marker when the recovery reconnect fails", async () => {
    const fake = recordingClient();
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountState(fake.client, { hostConnected });

    fake.setReconnectSucceeds(false);
    setHostConnected(false);
    await flush();
    setHostConnected(true);
    await flush();
    expect(fake.counts.reconnects).toBe(1);
    expect(state.connection()).toBe("reconnecting");
    expect(state.hostStale()).toBe(true);
    expect(state.stale()).toBe(true);

    fake.setReconnectSucceeds(true);
    state.retry();
    await flush();
    expect(fake.counts.reconnects).toBe(2);
    expect(fake.client.connection()).toBe("live");
    expect(state.hostStale()).toBe(false);
  });

  it("retries the transport, not a local read, while the host is down", async () => {
    const fake = recordingClient();
    const [hostConnected, setHostConnected] = createSignal(true);
    const state = await mountState(fake.client, { hostConnected });

    fake.setReconnectSucceeds(false);
    setHostConnected(false);
    await flush();
    state.retry();
    await flush();

    expect(fake.counts.reconnects).toBe(1);
    expect(fake.counts.settings).toBe(1);
    expect(fake.counts.quota).toBe(1);
    expect(state.stale()).toBe(true);
  });

  it("marks the page stale when the quota read fails and keeps the prior catalog", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);
    expect(state.stale()).toBe(false);
    expect(state.catalog().cards[0]?.cardId).toBe(CATALOG_CARD.cardId);

    fake.setQuota(async () => {
      throw new Error("quota offline");
    });
    fake.emit({ topic: "quota.changed", at: 6 });
    await flush();

    expect(state.quotaStale()).toBe(true);
    expect(state.stale()).toBe(true);
    expect(state.query.error()).toBeUndefined();
    // The quota payload feeds the catalog; a failed read must not erase it.
    expect(state.catalog().cards[0]?.cardId).toBe(CATALOG_CARD.cardId);

    fake.setQuota(async () => quotaSnapshot());
    state.retry();
    await flush();

    expect(fake.counts.quota).toBe(3);
    expect(state.quotaStale()).toBe(false);
    expect(state.stale()).toBe(false);
    expect(state.catalog().cards[0]?.cardId).toBe(CATALOG_CARD.cardId);
  });

  it("reports a stale quota snapshot even when the read succeeds", async () => {
    const fake = recordingClient();
    const state = await mountState(fake.client);

    fake.setQuota(async () => quotaSnapshot({ stale: true }));
    fake.emit({ topic: "quota.changed", at: 7 });
    await flush();
    expect(state.quotaStale()).toBe(true);
    expect(state.stale()).toBe(true);

    fake.setQuota(async () => quotaSnapshot({ stale: false }));
    state.retry();
    await flush();
    expect(state.quotaStale()).toBe(false);
    expect(state.stale()).toBe(false);
  });

  it("unsubscribes when the page unmounts", async () => {
    const fake = recordingClient();
    await mountState(fake.client);

    mounted.pop()?.();
    await flush();
    expect(fake.counts.unsubscribes).toBe(1);
  });
});
