import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
import type { NativeDashboardConnection } from "../src/native/dashboard-client.js";
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
let createSessionHeaderSource: (options: {
  client: SessionHeaderClient;
  active: () => boolean;
  hostConnected?: () => boolean;
  now?: () => number;
}) => SessionHeaderSource;

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
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
});
