/**
 * The native panel's shell state (Stage 5).
 *
 * The panel now hosts the full dashboard, so this controller owns only what the
 * shell needs across routes: the settings read that supplies display preferences
 * and visibility, diagnostics, the host recovery anchor, and the per-topic
 * refresh tokens route containers listen to. Quota, analytics and drilldown
 * payloads belong to the shared route containers; this module never duplicates
 * their fetch logic.
 *
 * Visibility fails closed: the panel renders quota cards only from a real
 * settings payload. A later failure keeps the last-known payload and reports it
 * stale with a local retry; an initial failure shows the retry instead of
 * synthesized defaults.
 *
 * The Subscription exists only while the host shows the tab; host loss marks
 * cached data stale and its return reopens the transport once. No timer,
 * heartbeat, URL, history entry or `localStorage` key is involved.
 */
import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { DashboardEvent, DashboardHealth, SettingsSnapshot } from "../contracts/dashboard.js";
import type { DashboardRpcViewScope } from "../rpc.js";
import { createQuery } from "../ui/query.js";
import { displayPreferencesFromValues } from "../ui/settings-model.js";
import { buildMismatchMessage, contractMismatchMessage } from "../ui/view-model.js";
import type { NativeDashboardConnection } from "./dashboard-client.js";

export interface DashboardPanelOptions {
  client: DashboardPanelClient;
  /** True while the host shows this panel tab; subscriptions follow it. */
  visible: Accessor<boolean>;
  /** Live connection of the host server; absent or true means not known lost. */
  hostConnected?: Accessor<boolean>;
}

/**
 * The slice of the native client the panel shell owns. Route-specific reads are
 * deliberately absent: the shared route containers perform them.
 */
export interface DashboardPanelClient {
  settings(): Promise<SettingsSnapshot>;
  health(): Promise<DashboardHealth>;
  subscribe(listener: (event: DashboardEvent) => void): () => void;
  onConnectionChange(listener: (state: NativeDashboardConnection) => void): () => void;
  onReconnect(listener: () => void): () => void;
  connection(): NativeDashboardConnection;
  reconnect(): Promise<void>;
  /** Live viewer interest; optional so the lifecycle stays testable in isolation. */
  setActiveView?(scope: DashboardRpcViewScope): Promise<void>;
}

export interface DashboardPanelState {
  settings: Accessor<SettingsSnapshot | undefined>;
  /** The last settings read failure; a present `settings` is the last known payload. */
  settingsError: Accessor<unknown>;
  /** True when the settings read failed: visibility is last known or unavailable. */
  settingsStale: Accessor<boolean>;
  connection: Accessor<NativeDashboardConnection>;
  buildWarning: Accessor<string | undefined>;
  contractMismatch: Accessor<string | undefined>;
  /** Display preferences only once a settings payload exists — never defaults. */
  preferences: Accessor<ReturnType<typeof displayPreferencesFromValues> | undefined>;
  /** Bumped after a transport reconnect; route containers refetch on it. */
  reconnectEpoch: Accessor<number>;
  /** Bumped for analytics/drilldown invalidations. */
  reloadToken: Accessor<number>;
  /** Bumped for quota invalidations and for the Quota route. */
  quotaReloadToken: Accessor<number>;
  /** True when the host server dropped and no routed read has landed since. */
  hostStale: Accessor<boolean>;
  /** Anchors the current routed payload as fresh for the current host epoch. */
  markFresh: () => void;
  /** Explicit recovery after a transport or host failure. */
  retry: () => void;
  /** Reasserts the scope this window needs from the shared runtime. */
  setScope: (scope: DashboardRpcViewScope) => void;
}

export function createDashboardPanelState(options: DashboardPanelOptions): DashboardPanelState {
  const client = options.client;
  const settingsQuery = createQuery<SettingsSnapshot>(() => client.settings());
  const [health, setHealth] = createSignal<DashboardHealth>();
  const [connection, setConnection] = createSignal<NativeDashboardConnection>(client.connection());
  const [reconnectEpoch, setReconnectEpoch] = createSignal(0);
  const [reloadToken, setReloadToken] = createSignal(0);
  const [quotaReloadToken, setQuotaReloadToken] = createSignal(0);
  const [hostEpoch, setHostEpoch] = createSignal(0);
  const [freshHostEpoch, setFreshHostEpoch] = createSignal(0);
  /** The host epoch a successful transport reconnect has restored. */
  const [recoveredHostEpoch, setRecoveredHostEpoch] = createSignal(0);

  function refreshSettings(): void {
    void settingsQuery.run();
  }

  async function refreshHealth(): Promise<void> {
    try {
      setHealth(await client.health());
    } catch {
      // Health is diagnostic; the routed reads own the visible failure.
    }
  }

  function handleEvent(event: DashboardEvent): void {
    if (event.topic === "settings.changed") {
      refreshSettings();
      return;
    }
    if (event.topic === "quota.changed") {
      setQuotaReloadToken((token) => token + 1);
      return;
    }
    // Session activity invalidates analytics and drilldown payloads.
    setReloadToken((token) => token + 1);
  }

  // The host's built-in server ref follows restarts and dropped event streams.
  // A loss marks the routed payload stale at once; its return reopens the
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
      // While hidden there is no held viewer to reopen; the show path reconnects
      // if this host epoch is still unanchored.
      if (options.visible()) void client.reconnect();
      return;
    }
    hostWasConnected = true;
  });

  // Visible-only subscription: the transport holds a viewer and an event
  // stream only while this tab can be seen. Returning to the tab refetches the
  // current route because events during the hidden period were live-only.
  let previousVisible: boolean | undefined;
  createEffect(
    on(options.visible, (visible) => {
      if (!visible) {
        previousVisible = false;
        return;
      }
      const reentered = previousVisible === false;
      previousVisible = true;
      const unsubscribe = client.subscribe(handleEvent);
      refreshHealth();
      refreshSettings();
      if (reentered) {
        setReloadToken((token) => token + 1);
        setQuotaReloadToken((token) => token + 1);
        // If the host dropped while this tab was hidden, no viewer existed to
        // reopen; the show path is where that recovery is completed.
        if (hostEpoch() > recoveredHostEpoch()) void client.reconnect();
      }
      onCleanup(unsubscribe);
    }),
  );

  const unsubscribeConnection = client.onConnectionChange(setConnection);
  const unsubscribeReconnect = client.onReconnect(() => {
    setRecoveredHostEpoch(hostEpoch());
    setReconnectEpoch((epoch) => epoch + 1);
    refreshHealth();
    refreshSettings();
  });
  onCleanup(() => {
    unsubscribeConnection();
    unsubscribeReconnect();
  });

  // Derived only from a real payload: on the first read's failure there is no
  // authoritative preference set, and the Quota route must not render defaults.
  const preferences = createMemo(() => {
    const snapshot = settingsQuery.data();
    return snapshot === undefined ? undefined : displayPreferencesFromValues(snapshot.values);
  });

  return {
    settings: settingsQuery.data,
    settingsError: settingsQuery.error,
    settingsStale: () => settingsQuery.error() !== undefined,
    connection,
    buildWarning: () => buildMismatchMessage(health()),
    contractMismatch: () => {
      const current = health();
      return current === undefined ? undefined : contractMismatchMessage(current.contractVersion);
    },
    preferences,
    reconnectEpoch,
    reloadToken,
    quotaReloadToken,
    hostStale: () => hostEpoch() > freshHostEpoch(),
    markFresh: () => {
      // A response can only anchor freshness after the host has returned and a
      // transport reconnect has succeeded for this host epoch. A read that was
      // already in flight when the host dropped cannot clear the marker.
      if (options.hostConnected?.() === false) return;
      if (hostEpoch() > recoveredHostEpoch()) return;
      setFreshHostEpoch(hostEpoch());
    },
    retry: () => {
      // A failed shell read on a healthy transport is retried locally; only a
      // dropped host or transport needs the connection reopened.
      if (
        settingsQuery.error() !== undefined &&
        options.hostConnected?.() !== false &&
        connection() === "live"
      ) {
        refreshSettings();
        refreshHealth();
        return;
      }
      void client.reconnect();
    },
    setScope: (scope) => {
      const result = client.setActiveView?.(scope);
      void result?.catch(() => undefined);
    },
  };
}
