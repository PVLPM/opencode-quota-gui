import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import type {
  AnalyticsDimension,
  AnalyticsEntityIdentity,
  QuotaSnapshot,
} from "../contracts/dashboard";
import { isRangeKey, RANGE_KEYS } from "../contracts/ranges";
import { AnalyticsTabs } from "../ui/components/analytics-tabs";
import { BuildMismatchStatus } from "../ui/components/build-info";
import { AnalyticsIcon, QuotaIcon } from "../ui/components/icons";
import { ErrorCard, ReloadRequired } from "../ui/components/states";
import { TemporalStatusStrip } from "../ui/components/temporal-status";
import { RANGE_LABELS } from "../ui/format";
import {
  analyticsTabForRoute,
  isInternalDashboardHref,
  viewScopeForRoute,
} from "../ui/navigation-model";
import {
  AnalyticsRoute,
  GroupDetailRoute,
  ModelsRoute,
  ProjectRoute,
  QuotaRoute,
  SessionRoute,
} from "../ui/routes";
import { formatPath, modelsGroupForRoute, routeShowsRangeSelector } from "../ui/routing";
import { displayPreferencesFromValues } from "../ui/settings-model";
import { QuotaLoading } from "../ui/views/home";
import type { NativeDashboardClient } from "./dashboard-client.js";
import {
  initialNativeLocation,
  navigateNative,
  replaceModelsDimension,
  setNativeRange,
} from "./navigation.js";
import { createDashboardPanelState } from "./panel-state.js";
import { Icon, SegmentedControl, SegmentedControlItem, Tooltip } from "./ui.js";

/**
 * The full dashboard panel as the Desktop side region renders it (Stage 5).
 *
 * Navigation is window-local: the same shared feature views and route
 * containers as the browser, driven by an internal location instead of
 * `history`/`localStorage`. Quota keeps its temporal strip; Analytics, Models,
 * Model/Provider details and Project/Session drilldowns use the existing
 * components, range selector and hierarchy unchanged. Settings opens the
 * official SettingsPage registered in `gui.tsx`.
 */
export interface DashboardPanelProps {
  client: NativeDashboardClient;
  /** Live visibility of this panel tab; drives subscriptions and reads. */
  visible: () => boolean;
  /** Live connection of the host server; drives stale marking and recovery. */
  hostConnected: () => boolean;
  onOpenSettings: () => void;
}

type NavTarget = "home" | "analytics" | "settings";

export function DashboardPanel(props: DashboardPanelProps): JSX.Element {
  const panel = createDashboardPanelState({
    client: props.client,
    visible: props.visible,
    hostConnected: props.hostConnected,
  });
  const [location, setLocation] = createSignal(initialNativeLocation());
  const [navTooltip, setNavTooltip] = createSignal<NavTarget>();
  const [homeSnapshot, setHomeSnapshot] = createSignal<QuotaSnapshot>();
  const [routeStale, setRouteStale] = createSignal(false);
  const [rememberedModelsDimension, setRememberedModelsDimension] =
    createSignal<AnalyticsDimension>("provider");
  let mainElement: HTMLElement | undefined;

  const route = () => location().route;
  const range = () => location().range;
  const analyticsTab = () => analyticsTabForRoute(route());
  const modelsDimension = () => modelsGroupForRoute(route());
  const routeKey = createMemo(() => JSON.stringify(route()));

  createEffect(() => {
    const dimension = modelsDimension();
    if (dimension !== undefined) setRememberedModelsDimension(dimension);
  });

  // One window-local viewer scope follows the current section. No transport
  // call is made for a hidden tab; the subscription itself is visibility-gated.
  createEffect(() => {
    panel.setScope(viewScopeForRoute(route()));
  });

  // A new route starts without the previous route's stale badge and at the top
  // of its own scroll. Grouping changes count as a new view; range changes do
  // not, because the old payload stays on screen while it refreshes.
  createEffect(
    on(routeKey, () => {
      setRouteStale(false);
      mainElement?.scrollTo({ top: 0 });
    }),
  );

  function applyLocation(next: ReturnType<typeof navigateNative>): void {
    if (next !== undefined) setLocation(next);
  }

  function navigate(path: string): void {
    applyLocation(navigateNative(location(), path));
  }

  function internalAnchor(event: MouseEvent): HTMLAnchorElement | undefined {
    const target = event.target;
    if (!(target instanceof Element)) return undefined;
    const anchor = target.closest("a");
    if (!(anchor instanceof HTMLAnchorElement)) return undefined;
    return isInternalDashboardHref(anchor.getAttribute("href")) ? anchor : undefined;
  }

  // The Desktop window has no browser address to fall back to, so every
  // internal link — including modified and middle clicks — is handled here.
  function onInternalClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    const anchor = internalAnchor(event);
    if (anchor === undefined) return;
    // The Desktop window has no browser destination for an app path, including
    // a malformed one: swallow it rather than letting the host navigate away.
    event.preventDefault();
    navigate(anchor.getAttribute("href") ?? "");
  }

  function onInternalAuxClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 1) return;
    const anchor = internalAnchor(event);
    if (anchor === undefined) return;
    event.preventDefault();
    navigate(anchor.getAttribute("href") ?? "");
  }

  // Delegated listeners on the panel root, not the host document: keyboard
  // activation still dispatches a click on the link, while a pointer event that
  // starts outside the panel is never captured.
  let rootElement: HTMLDivElement | undefined;
  onMount(() => {
    const element = rootElement;
    if (element === undefined) return;
    const handleClick = (event: MouseEvent): void => onInternalClick(event);
    const handleAuxClick = (event: MouseEvent): void => onInternalAuxClick(event);
    element.addEventListener("click", handleClick);
    element.addEventListener("auxclick", handleAuxClick);
    onCleanup(() => {
      element.removeEventListener("click", handleClick);
      element.removeEventListener("auxclick", handleAuxClick);
    });
  });

  function updateRange(next: (typeof RANGE_KEYS)[number]): void {
    setLocation(setNativeRange(location(), next));
  }

  const staleLabel = () => {
    if (panel.connection() === "connecting") return "Connecting…";
    if (panel.connection() === "reconnecting") return "Reconnecting…";
    if (panel.settingsStale()) {
      return panel.settings() === undefined
        ? "Display settings unavailable"
        : "Display settings may be stale";
    }
    if (panel.connection() !== "live" || panel.hostStale() || routeStale()) {
      return "Data may be stale";
    }
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
    <div ref={rootElement} class="qg-native qg-panel-root">
      <div class="qg-app">
        <header class="qg-chrome">
          <nav class="qg-topbar__brand" aria-label="Views">
            <Tooltip value="Quota" forceOpen={navTooltip() === "home"}>
              <button
                type="button"
                class="qg-topbar__link qg-nav-icon"
                aria-label="Quota"
                aria-current={route().name === "home" ? "page" : undefined}
                {...navHandlers("home")}
                onClick={() => {
                  setNavTooltip(undefined);
                  navigate(formatPath({ name: "home" }, range()));
                }}
              >
                <QuotaIcon />
              </button>
            </Tooltip>
            <Tooltip value="Analytics" forceOpen={navTooltip() === "analytics"}>
              <button
                type="button"
                class="qg-topbar__link qg-nav-icon"
                aria-label="Analytics"
                data-section-active={analyticsTab() === undefined ? undefined : "true"}
                {...navHandlers("analytics")}
                onClick={() => {
                  setNavTooltip(undefined);
                  navigate(formatPath({ name: "analytics" }, range()));
                }}
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
                  <Show when={panel.connection() !== "connecting"}>
                    <button
                      type="button"
                      class="qg-stale__retry"
                      aria-label="Retry dashboard data"
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
              <Show
                when={analyticsTab()}
                fallback={
                  <span class="qg-frame-tab">
                    {route().name === "home" ? "Quota" : "Dashboard"}
                  </span>
                }
              >
                {(tab) => (
                  <AnalyticsTabs
                    active={tab()}
                    range={range()}
                    modelsDimension={modelsDimension() ?? rememberedModelsDimension()}
                  />
                )}
              </Show>
            </div>
            <div class="qg-topbar__actions">
              <Show when={route().name === "home" ? homeSnapshot()?.temporal : undefined}>
                {(temporal) => (
                  <TemporalStatusStrip
                    providers={temporal().providers}
                    overrides={panel.preferences()?.temporalProviderOverrides ?? {}}
                  />
                )}
              </Show>
              <Show when={routeShowsRangeSelector(route())}>
                <SegmentedControl
                  class="qg-range"
                  aria-label="Time range"
                  value={range()}
                  onChange={(value) => {
                    if (isRangeKey(value)) updateRange(value);
                  }}
                >
                  <For each={RANGE_KEYS}>
                    {(key) => (
                      <SegmentedControlItem value={key}>
                        {RANGE_LABELS[key] ?? key}
                      </SegmentedControlItem>
                    )}
                  </For>
                </SegmentedControl>
              </Show>
            </div>
          </header>

          <main class="qg-main" ref={mainElement}>
            <Show
              when={panel.contractMismatch() === undefined}
              fallback={<ReloadRequired message={panel.contractMismatch() ?? ""} />}
            >
              <Switch>
                <Match when={route().name === "home"}>
                  {/*
                    Hidden cards and display preferences exist only once the
                    settings read succeeds. Until then the Quota route does not
                    mount, so defaults can never become authoritative and a
                    hidden card cannot reappear; a failed first read shows the
                    retry instead. A later failure keeps the last-known snapshot.
                  */}
                  <Show
                    when={panel.settings()}
                    fallback={
                      <Show when={panel.settingsError() !== undefined} fallback={<QuotaLoading />}>
                        <ErrorCard
                          message="Display settings could not be loaded. Quota cards are unavailable until the settings read succeeds."
                          retryable
                          onRetry={() => panel.retry()}
                        />
                      </Show>
                    }
                  >
                    {(settings) => (
                      <QuotaRoute
                        client={props.client}
                        reloadToken={panel.quotaReloadToken()}
                        reconnectEpoch={panel.reconnectEpoch()}
                        enabled={props.visible}
                        onFresh={panel.markFresh}
                        preferences={displayPreferencesFromValues(settings().values)}
                        hiddenCards={settings().visibility.hiddenCards}
                        hiddenRows={settings().visibility.hiddenRows}
                        onSnapshot={setHomeSnapshot}
                        onStale={setRouteStale}
                      />
                    )}
                  </Show>
                </Match>

                <Match when={route().name === "analytics"}>
                  <AnalyticsRoute
                    client={props.client}
                    range={range()}
                    reloadToken={panel.reloadToken()}
                    reconnectEpoch={panel.reconnectEpoch()}
                    connection={panel.connection()}
                    enabled={props.visible}
                    onFresh={panel.markFresh}
                    onStale={setRouteStale}
                  />
                </Match>

                <Match when={route().name === "models"}>
                  <ModelsRoute
                    client={props.client}
                    dimension={(route() as { dimension: AnalyticsDimension }).dimension}
                    onDimensionChange={(dimension) =>
                      setLocation(replaceModelsDimension(location(), dimension))
                    }
                    range={range()}
                    reloadToken={panel.reloadToken()}
                    reconnectEpoch={panel.reconnectEpoch()}
                    connection={panel.connection()}
                    enabled={props.visible}
                    onFresh={panel.markFresh}
                    onStale={setRouteStale}
                  />
                </Match>

                <Match when={route().name === "model"}>
                  <GroupDetailRoute
                    client={props.client}
                    entity="model"
                    identity={(route() as { identity: AnalyticsEntityIdentity }).identity}
                    modelsGroup={(route() as { modelsGroup?: AnalyticsDimension }).modelsGroup}
                    range={range()}
                    reloadToken={panel.reloadToken()}
                    reconnectEpoch={panel.reconnectEpoch()}
                    connection={panel.connection()}
                    enabled={props.visible}
                    onFresh={panel.markFresh}
                    onStale={setRouteStale}
                  />
                </Match>

                <Match when={route().name === "provider"}>
                  <GroupDetailRoute
                    client={props.client}
                    entity="provider"
                    identity={(route() as { identity: AnalyticsEntityIdentity }).identity}
                    modelsGroup={(route() as { modelsGroup?: AnalyticsDimension }).modelsGroup}
                    range={range()}
                    reloadToken={panel.reloadToken()}
                    reconnectEpoch={panel.reconnectEpoch()}
                    connection={panel.connection()}
                    enabled={props.visible}
                    onFresh={panel.markFresh}
                    onStale={setRouteStale}
                  />
                </Match>

                <Match when={route().name === "project"}>
                  <ProjectRoute
                    client={props.client}
                    range={range()}
                    projectId={(route() as { projectId: string }).projectId}
                    reloadToken={panel.reloadToken()}
                    reconnectEpoch={panel.reconnectEpoch()}
                    connection={panel.connection()}
                    enabled={props.visible}
                    onFresh={panel.markFresh}
                    onStale={setRouteStale}
                  />
                </Match>

                <Match when={route().name === "session"}>
                  <SessionRoute
                    client={props.client}
                    range={range()}
                    sessionId={(route() as { sessionId: string }).sessionId}
                    reloadToken={panel.reloadToken()}
                    reconnectEpoch={panel.reconnectEpoch()}
                    connection={panel.connection()}
                    enabled={props.visible}
                    onFresh={panel.markFresh}
                    onStale={setRouteStale}
                  />
                </Match>
              </Switch>
            </Show>
          </main>
        </div>
      </div>
    </div>
  );
}
