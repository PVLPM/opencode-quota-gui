import type { Accessor } from "solid-js";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { QuotaSnapshot } from "../contracts/dashboard.js";
import type { DisplayPreferences } from "../ui/quota-semantics.js";
import type { NativeDashboardConnection } from "./dashboard-client.js";
import { createDashboardPanelState, type DashboardPanelClient } from "./panel-state.js";
import type { SessionHeaderView } from "./session-header-model.js";
import { buildSessionHeaderView } from "./session-header-model.js";

/**
 * The `session.header` Slot's data source (Stage 6).
 *
 * `createDashboardPanelState` already owns the visibility-gated subscription,
 * the fail-closed settings read and host recovery, so the Slot reuses it
 * instead of creating a second collector. The Slot reads the panel's quota
 * query when its refresh tokens change; the Slot contributes one scoped
 * viewer to the shared runtime, which still owns the single quota poller.
 */

export type SessionHeaderClient = DashboardPanelClient & {
  quota: () => Promise<QuotaSnapshot>;
};

export interface SessionHeaderSource {
  view: Accessor<SessionHeaderView>;
  preferences: Accessor<DisplayPreferences | undefined>;
  connection: Accessor<NativeDashboardConnection>;
  settingsError: Accessor<unknown>;
  quotaError: Accessor<unknown>;
  retry: () => void;
}

const EMPTY_VIEW: SessionHeaderView = { cards: [], nowMs: 0 };

export function createSessionHeaderSource(options: {
  client: SessionHeaderClient;
  active: Accessor<boolean>;
  hostConnected?: Accessor<boolean>;
  now?: () => number;
}): SessionHeaderSource {
  const panel = createDashboardPanelState({
    client: options.client,
    visible: options.active,
    ...(options.hostConnected === undefined ? {} : { hostConnected: options.hostConnected }),
  });
  const quotaQuery = panel.quotaQuery;
  const now = options.now ?? Date.now;
  const [localNowMs, setLocalNowMs] = createSignal(now());
  const [freshReconnectEpoch, setFreshReconnectEpoch] = createSignal(0);

  function refreshQuota(changed = false): void {
    const reconnectEpoch = panel.reconnectEpoch();
    void quotaQuery.read({ changed }).then((applied) => {
      if (!applied) return;
      setFreshReconnectEpoch(reconnectEpoch);
      panel.markFresh();
    });
  }

  let lastQuotaToken = 0;
  createEffect(() => {
    if (!options.active()) return;
    // Read both tokens where they are used; either one asks for a fresh read.
    const token = panel.quotaReloadToken();
    void panel.reconnectEpoch();
    const changed = token !== lastQuotaToken;
    lastQuotaToken = token;
    refreshQuota(changed);
  });

  // Keep the view clock in sync with reactive data without making the clock
  // itself a dependency of this effect. In particular, a wall-clock rollback
  // must be allowed to move the displayed time backwards.
  createEffect(() => {
    if (!options.active()) return;
    panel.settings();
    panel.preferences();
    quotaQuery.data();
    quotaQuery.error();
    panel.connection();
    panel.hostStale();
    setLocalNowMs(now());
  });

  const refreshLocalTime = () => {
    if (!options.active()) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    setLocalNowMs(now());
  };
  const onVisibilityChange = () => {
    if (typeof document === "undefined" || document.visibilityState === "hidden") return;
    refreshLocalTime();
  };

  if (typeof window !== "undefined") {
    window.addEventListener("focus", refreshLocalTime);
    onCleanup(() => window.removeEventListener("focus", refreshLocalTime));
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibilityChange));
  }

  const view = createMemo<SessionHeaderView>(() => {
    const settings = panel.settings();
    const preferences = panel.preferences();
    if (settings === undefined || preferences === undefined) return EMPTY_VIEW;
    const snapshot = quotaQuery.data();
    // A read error alone does not invalidate an otherwise fresh snapshot.
    const stale =
      snapshot === undefined ||
      snapshot.stale === true ||
      panel.connection() !== "live" ||
      panel.hostStale() ||
      panel.settingsStale() ||
      freshReconnectEpoch() < panel.reconnectEpoch();
    return buildSessionHeaderView({
      snapshot,
      hiddenCards: settings.visibility.hiddenCards,
      hiddenRows: settings.visibility.hiddenRows,
      preferences,
      ...(preferences.temporalProviderOverrides === undefined
        ? {}
        : { temporalOverrides: preferences.temporalProviderOverrides }),
      stale,
      nowMs: localNowMs(),
    });
  });

  createEffect(() => {
    if (!options.active()) return;
    const nextAtMs = view().nextPeakUpdateAtMs;
    if (nextAtMs === undefined) return;

    // The host timeout is one-shot. Large exact-date transitions are chunked
    // to the platform's signed 32-bit timer limit and then scheduled again.
    const MAX_TIMEOUT_MS = 2_147_483_647;
    const delayMs = Math.min(Math.max(0, nextAtMs - now()), MAX_TIMEOUT_MS);
    const timer = setTimeout(refreshLocalTime, delayMs);
    onCleanup(() => clearTimeout(timer));
  });

  return {
    view,
    preferences: panel.preferences,
    connection: panel.connection,
    settingsError: panel.settingsError,
    quotaError: quotaQuery.error,
    retry: () => {
      panel.retry();
      if (options.hostConnected?.() !== false) refreshQuota();
    },
  };
}
