/**
 * Quota panel state for the native window (Stage 4).
 *
 * This is the same lifecycle the browser Quota route owns, minus the browser:
 * one quota read plus one settings read, live invalidation from RPC events,
 * a stale marker that survives until a post-reconnect refetch lands, and a
 * subscription that exists only while the panel is actually visible. The host
 * supplies the live connection of its built-in server; losing it marks cached
 * data stale, and its return reopens the transport once. No timer, heartbeat,
 * URL, history entry or `localStorage` key is involved.
 *
 * Kept free of JSX so the lifecycle is testable without a DOM and the panel
 * component stays a renderer.
 */
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type {
  DashboardEvent,
  DashboardHealth,
  QuotaSnapshot,
  SettingsSnapshot,
} from "../contracts/dashboard.js";
import { createQuery } from "../ui/query.js";
import { displayPreferencesFromValues } from "../ui/settings-model.js";
import {
  buildMismatchMessage,
  contractMismatchMessage,
  isStaleAfterReconnect,
  type LoadState,
  resolveLoadState,
} from "../ui/view-model.js";
import type { NativeDashboardConnection } from "./dashboard-client.js";

export interface QuotaPanelOptions {
  client: QuotaPanelClient;
  /** True while the host shows this panel tab; subscriptions follow it. */
  visible: Accessor<boolean>;
  /** Live connection of the host server; absent or true means not known lost. */
  hostConnected?: Accessor<boolean>;
}

/**
 * The slice of the native client this panel owns. Stated separately so the
 * lifecycle can be exercised without the full transport surface.
 */
export interface QuotaPanelClient {
  quota(): Promise<QuotaSnapshot>;
  settings(): Promise<SettingsSnapshot>;
  health(): Promise<DashboardHealth>;
  subscribe(listener: (event: DashboardEvent) => void): () => void;
  onConnectionChange(listener: (state: NativeDashboardConnection) => void): () => void;
  onReconnect(listener: () => void): () => void;
  connection(): NativeDashboardConnection;
  reconnect(): Promise<void>;
}

export interface QuotaPanelState {
  quota: Accessor<QuotaSnapshot | undefined>;
  settings: Accessor<SettingsSnapshot | undefined>;
  /** The quota read is in flight. */
  loading: Accessor<boolean>;
  /** The resolved quota section: skeleton, ready, error or reload-required. */
  state: Accessor<LoadState<QuotaSnapshot>>;
  /** Chrome marker: transport is not live, or the data is known to predate a recovery. */
  stale: Accessor<boolean>;
  connection: Accessor<NativeDashboardConnection>;
  buildWarning: Accessor<string | undefined>;
  contractMismatch: Accessor<string | undefined>;
  preferences: Accessor<ReturnType<typeof displayPreferencesFromValues>>;
  hiddenCards: Accessor<string[]>;
  hiddenRows: Accessor<string[]>;
  /** Explicit recovery after a transport failure. */
  retry: () => void;
}

export function createQuotaPanelState(options: QuotaPanelOptions): QuotaPanelState {
  const client = options.client;
  const quotaQuery = createQuery<QuotaSnapshot>(() => client.quota());
  const settingsQuery = createQuery<SettingsSnapshot>(() => client.settings());
  const [health, setHealth] = createSignal<DashboardHealth>();
  const [connection, setConnection] = createSignal<NativeDashboardConnection>(client.connection());
  const [reconnectEpoch, setReconnectEpoch] = createSignal(0);
  const [quotaFreshEpoch, setQuotaFreshEpoch] = createSignal(0);
  const [hostEpoch, setHostEpoch] = createSignal(0);
  const [quotaFreshHostEpoch, setQuotaFreshHostEpoch] = createSignal(0);

  function refreshQuota(): void {
    const reconnect = reconnectEpoch();
    const host = hostEpoch();
    void quotaQuery.run().then((applied) => {
      if (!applied) return;
      setQuotaFreshEpoch(reconnect);
      setQuotaFreshHostEpoch(host);
    });
  }

  function refreshSettings(): void {
    void settingsQuery.run();
  }

  async function refreshHealth(): Promise<void> {
    try {
      setHealth(await client.health());
    } catch {
      // Health is diagnostic; the quota read owns the visible failure.
    }
  }

  function handleEvent(event: DashboardEvent): void {
    if (event.topic === "settings.changed") {
      refreshSettings();
      return;
    }
    // `quota.changed` and session activity both move the Quota payload.
    refreshQuota();
  }

  // The host's built-in server ref follows restarts and dropped event streams.
  // A loss marks the cached payload stale at once; its return reopens the
  // transport and refetches once. No timer, heartbeat or polling is involved.
  let hostWasConnected: boolean | undefined;
  createEffect(() => {
    const connected = options.hostConnected?.() ?? true;
    if (!connected) {
      hostWasConnected = false;
      setHostEpoch((epoch) => epoch + 1);
      return;
    }
    if (hostWasConnected === false) {
      hostWasConnected = true;
      void client.reconnect();
      return;
    }
    hostWasConnected = true;
  });

  // Visible-only subscription: the transport holds a viewer and an event
  // stream only while this tab can be seen, and reacquires them on show.
  // `on` keeps the effect keyed to visibility alone: the refresh helpers read
  // `reconnectEpoch`, and tracking that here would restart the subscription
  // every time the transport recovers.
  createEffect(
    on(options.visible, (visible) => {
      if (!visible) return;
      const unsubscribe = client.subscribe(handleEvent);
      refreshHealth();
      refreshQuota();
      refreshSettings();
      onCleanup(unsubscribe);
    }),
  );

  const unsubscribeConnection = client.onConnectionChange(setConnection);
  const unsubscribeReconnect = client.onReconnect(() => {
    setReconnectEpoch((epoch) => epoch + 1);
    refreshHealth();
    refreshQuota();
    refreshSettings();
  });
  onCleanup(() => {
    unsubscribeConnection();
    unsubscribeReconnect();
  });

  const stale = createMemo(
    () =>
      quotaQuery.data()?.stale === true ||
      quotaQuery.error() !== undefined ||
      connection() !== "live" ||
      hostEpoch() > quotaFreshHostEpoch() ||
      isStaleAfterReconnect(reconnectEpoch(), quotaFreshEpoch()),
  );

  const preferences = createMemo(() =>
    displayPreferencesFromValues(settingsQuery.data()?.values ?? {}),
  );

  return {
    quota: quotaQuery.data,
    settings: settingsQuery.data,
    loading: quotaQuery.loading,
    state: () => {
      const resolved = resolveLoadState({
        data: quotaQuery.data(),
        error: quotaQuery.error(),
        loading: quotaQuery.loading(),
      });
      if (resolved.kind !== "ready" || !stale()) return resolved;
      return { ...resolved, stale: true };
    },
    stale,
    connection,
    buildWarning: () => buildMismatchMessage(health()),
    contractMismatch: () => {
      const current = health();
      return current === undefined ? undefined : contractMismatchMessage(current.contractVersion);
    },
    preferences,
    hiddenCards: () => settingsQuery.data()?.visibility.hiddenCards ?? [],
    hiddenRows: () => settingsQuery.data()?.visibility.hiddenRows ?? [],
    retry: () => {
      void client.reconnect();
    },
  };
}
