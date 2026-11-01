import type { JSX } from "solid-js";
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { BuildMismatchStatus } from "../ui/components/build-info";
import { BusyOverlay, createBusyIndicator } from "../ui/components/busy";
import { AnalyticsIcon, QuotaIcon } from "../ui/components/icons";
import { QueryState, ReloadRequired } from "../ui/components/states";
import { TemporalStatusStrip } from "../ui/components/temporal-status";
import { QuotaLoading, QuotaView } from "../ui/views/home";
import type { NativeDashboardClient } from "./dashboard-client.js";
import { createQuotaPanelState } from "./quota-panel-state.js";
import { Icon, Tooltip } from "./ui.js";

/**
 * The Quota panel as the Desktop side region renders it (Stage 4).
 *
 * Structure, classes and copy mirror the browser shell exactly: the app chrome
 * (Quota, a staged Analytics entry, Settings), the section top bar with the
 * temporal strip, and the shared `QuotaView` with the real provider cards. The
 * only differences are host mechanics: buttons instead of history links, a
 * staged Analytics item instead of a route, Settings delegates to the Desktop
 * settings window, and recovery reconnects instead of reloading a page. When
 * cached data is ready, the stale status keeps a keyboard-reachable retry
 * beside it so a dropped stream cannot leave the panel stuck.
 */
export interface DashboardPanelProps {
  client: NativeDashboardClient;
  /** Live visibility of this panel tab; drives the RPC subscription. */
  visible: () => boolean;
  /** Live connection of the host server; drives stale marking and recovery. */
  hostConnected: () => boolean;
  onOpenSettings: () => void;
}

type NavTarget = "home" | "analytics" | "settings";

export function DashboardPanel(props: DashboardPanelProps): JSX.Element {
  const panel = createQuotaPanelState({
    client: props.client,
    visible: props.visible,
    hostConnected: props.hostConnected,
  });
  const [navTooltip, setNavTooltip] = createSignal<NavTarget>();
  let mainElement: HTMLElement | undefined;

  const busy = createBusyIndicator();
  createEffect(() =>
    busy.update({
      active: panel.loading() && panel.quota() === undefined,
      hasData: panel.quota() !== undefined,
    }),
  );
  onCleanup(() => busy.dispose());

  const staleLabel = () => {
    if (panel.connection() === "connecting") return "Connecting…";
    if (panel.connection() === "reconnecting") return "Reconnecting…";
    if (panel.connection() !== "live" || panel.stale()) return "Data may be stale";
    return undefined;
  };

  function navHandlers(target: NavTarget) {
    return {
      onFocus: () => setNavTooltip(target),
      onBlur: () => setNavTooltip(undefined),
      onPointerEnter: () => setNavTooltip(target),
      onPointerLeave: () => setNavTooltip(undefined),
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Escape") setNavTooltip(undefined);
      },
    };
  }

  return (
    <div class="qg-native qg-panel-root">
      <div class="qg-app">
        <header class="qg-chrome">
          <nav class="qg-topbar__brand" aria-label="Views">
            <Tooltip value="Quota" forceOpen={navTooltip() === "home"}>
              <button
                type="button"
                class="qg-topbar__link qg-nav-icon"
                aria-label="Quota"
                aria-current="page"
                {...navHandlers("home")}
                onClick={() => {
                  setNavTooltip(undefined);
                  mainElement?.scrollTo({ top: 0 });
                }}
              >
                <QuotaIcon />
              </button>
            </Tooltip>
            <Tooltip
              value="Analytics arrives in a later stage"
              forceOpen={navTooltip() === "analytics"}
            >
              <button
                type="button"
                class="qg-topbar__link qg-nav-icon"
                aria-label="Analytics (not yet available in the Desktop panel)"
                aria-disabled="true"
                {...navHandlers("analytics")}
                onClick={() => setNavTooltip(undefined)}
              >
                <AnalyticsIcon />
              </button>
            </Tooltip>
          </nav>
          <div class="qg-topbar__actions">
            <BuildMismatchStatus message={panel.buildWarning()} />
            <Show when={staleLabel()}>
              {(label) => (
                <div class="qg-stale-group">
                  <span class="qg-stale" aria-live="polite">
                    {label()}
                  </span>
                  <Show when={panel.state().kind === "ready"}>
                    <button
                      type="button"
                      class="qg-stale__retry"
                      aria-label="Retry quota connection"
                      onClick={() => panel.retry()}
                    >
                      Retry
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <Tooltip value="Settings" forceOpen={navTooltip() === "settings"}>
              <button
                type="button"
                class="qg-topbar__link"
                aria-label="Settings"
                {...navHandlers("settings")}
                onClick={() => {
                  setNavTooltip(undefined);
                  props.onOpenSettings();
                }}
              >
                <Icon name="settings-gear" />
              </button>
            </Tooltip>
          </div>
        </header>

        <div class="qg-frame">
          <header class="qg-topbar">
            <div class="qg-topbar__left">
              <span class="qg-frame-tab">Quota</span>
            </div>
            <div class="qg-topbar__actions">
              <Show when={panel.quota()?.temporal}>
                {(temporal) => (
                  <TemporalStatusStrip
                    providers={temporal().providers}
                    overrides={panel.preferences().temporalProviderOverrides}
                  />
                )}
              </Show>
            </div>
          </header>

          <main class="qg-main" ref={mainElement}>
            <Show
              when={panel.contractMismatch() === undefined}
              fallback={<ReloadRequired message={panel.contractMismatch() ?? ""} />}
            >
              <BusyOverlay indicator={busy} label="quota" />
              <QueryState
                state={panel.state()}
                label="Loading providers"
                skeleton={<QuotaLoading />}
                onRetry={panel.retry}
                render={(snapshot, stale) => (
                  <QuotaView
                    snapshot={snapshot}
                    preferences={panel.preferences()}
                    hiddenCards={panel.hiddenCards()}
                    hiddenRows={panel.hiddenRows()}
                    stale={stale}
                  />
                )}
              />
            </Show>
          </main>
        </div>
      </div>
    </div>
  );
}
