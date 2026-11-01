import type { Accessor } from "solid-js";
import { createEffect, createMemo } from "solid-js";
import type { QuotaSnapshot } from "../contracts/dashboard.js";
import { createQuery } from "../ui/query.js";
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
 * instead of creating a second collector. This module adds only the quota read
 * that the Slot's refresh tokens request; the Slot contributes one scoped
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
  const quotaQuery = createQuery<QuotaSnapshot>(() => options.client.quota());

  createEffect(() => {
    if (!options.active()) return;
    // Read both tokens where they are used; either one asks for a fresh read.
    void panel.quotaReloadToken();
    void panel.reconnectEpoch();
    void quotaQuery.run().then((applied) => {
      if (applied) panel.markFresh();
    });
  });

  const view = createMemo<SessionHeaderView>(() => {
    const settings = panel.settings();
    const preferences = panel.preferences();
    if (settings === undefined || preferences === undefined) return EMPTY_VIEW;
    const snapshot = quotaQuery.data();
    // The Panel keeps last-known data on screen with a stale badge. The Slot
    // has no room for that badge, so it fails closed rather than painting old
    // values as fresh, healthy or zero rings.
    const stale =
      snapshot === undefined ||
      snapshot.stale === true ||
      quotaQuery.error() !== undefined ||
      panel.connection() !== "live" ||
      panel.hostStale();
    return buildSessionHeaderView({
      snapshot,
      hiddenCards: settings.visibility.hiddenCards,
      hiddenRows: settings.visibility.hiddenRows,
      preferences,
      ...(preferences.temporalProviderOverrides === undefined
        ? {}
        : { temporalOverrides: preferences.temporalProviderOverrides }),
      stale,
      nowMs: options.now?.() ?? Date.now(),
    });
  });

  return {
    view,
    preferences: panel.preferences,
    connection: panel.connection,
    settingsError: panel.settingsError,
    quotaError: quotaQuery.error,
    retry: () => {
      void quotaQuery.run();
      panel.retry();
    },
  };
}
