import type { Context } from "@opencode/plugin/gui";
import type { JSX } from "solid-js";
import { createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { BUILD_IDENTITY } from "../contracts/build-identity.js";
import { BuildAbout } from "../ui/components/build-info";
import { ErrorCard } from "../ui/components/states";
import { createToaster, ToastRegion } from "../ui/components/toast";
import { SettingsRoute } from "../ui/routes";
import { createNativeDashboardClient } from "./dashboard-client.js";
import { createGuiRpcCaller } from "./rpc.js";
import {
  copySettingsDiagnostics,
  settingsDiagnosticsFromSnapshots,
} from "./settings-copy-action.js";
import { createSettingsPageState } from "./settings-page-state.js";
import { NativeUiProvider } from "./ui.js";

/** Stable host page id; `Layout.settings` and the Panel both open this page. */
export const SETTINGS_PAGE_ID = "opencode-quota-gui";

/** What the main area can show without presenting an empty catalog as current. */
type SettingsContent = "settings" | "quota-error" | "waiting";

/**
 * The official Desktop Settings page (Stage 5).
 *
 * It reuses the browser's `SettingsRoute`/`SettingsView` against the same typed
 * RPC settings backend, so display, visibility/order, temporal pricing, quota
 * alerts, the Web dashboard toggle, validation and conflict handling are the
 * shared feature code rather than a second renderer. Only the surrounding host
 * page frame and the native read lifecycle are new.
 */
export function NativeSettingsPage(props: {
  ctx: Pick<Context, "app" | "client" | "servers" | "ui">;
}): JSX.Element {
  const client = createNativeDashboardClient({
    rpc: createGuiRpcCaller(props.ctx),
    scope: "quota",
  });
  // Same host-supported recovery signal as the panel: the plugin's own server
  // ref follows restarts and dropped event streams.
  const hostConnected = () =>
    props.ctx.servers
      .list()
      .map((id) => props.ctx.servers.get(id))
      .find((server) => server?.builtin)?.connected ?? true;
  const state = createSettingsPageState(client, { hostConnected });
  const toaster = createToaster();
  const [copied, setCopied] = createSignal(false);
  onCleanup(() => client.dispose());

  /**
   * Decide what owns the main area without ever mounting the editor on an
   * empty catalog. A quota failure with no payload gets a retryable error; a
   * pending quota read hides the ready editor until its catalog lands.
   */
  const settingsFailed = () =>
    state.query.error() !== undefined && state.query.data() === undefined;
  const contentMode = (): SettingsContent => {
    if (settingsFailed()) return "settings";
    if (state.quota() === undefined) {
      if (state.quotaStale()) return "quota-error";
      return state.query.data() === undefined ? "settings" : "waiting";
    }
    return "settings";
  };

  const statusLabel = () => {
    if (state.connection() === "connecting") return "Connecting…";
    if (state.connection() === "reconnecting") return "Reconnecting…";
    // A settled settings failure is actionable even while quota still loads.
    if (state.query.error() !== undefined) {
      return state.query.data() === undefined
        ? "Display settings unavailable"
        : "Display settings may be stale";
    }
    if (state.quotaStale()) {
      return state.quota() === undefined
        ? "Quota data could not be loaded — visibility and temporal settings are unavailable."
        : "Quota data may be stale — visibility and temporal status may be out of date.";
    }
    if (state.loading()) return "Loading settings and quota data…";
    return "Data may be stale";
  };
  const showStatus = () => state.loading() || state.stale();
  const diagnosticsAction = () => (
    <button
      type="button"
      class="qg-button qg-button--ghost-muted qg-button--small"
      aria-label="Copy diagnostics"
      title="Copy diagnostics"
      onClick={() => {
        setCopied(false);
        const clipboard = globalThis.navigator?.clipboard;
        const appVersion =
          BUILD_IDENTITY.version === "unknown" ? undefined : BUILD_IDENTITY.version;
        void copySettingsDiagnostics(
          () =>
            settingsDiagnosticsFromSnapshots(state.quota(), state.query.data(), state.stale(), {
              appVersion,
              hostVersion: props.ctx.app.version,
              quotaUnavailable: state.quota() === undefined && state.quotaStale(),
              settingsUnavailable:
                state.query.data() === undefined && state.query.error() !== undefined,
            }),
          clipboard?.writeText?.bind(clipboard),
          (tone, message) => {
            setCopied(tone === "success");
            toaster.push(tone, message);
          },
        );
      }}
    >
      <props.ctx.ui.Icon name={copied() ? "check" : "copy"} size="small" />
      <span>Copy diagnostics</span>
    </button>
  );

  return (
    <NativeUiProvider ui={props.ctx.ui}>
      <div class="qg-native qg-settings-page">
        <Show when={showStatus()}>
          <div class="qg-settings-page__status">
            <span class="qg-stale" aria-live="polite">
              {statusLabel()}
            </span>
            <Show when={state.retryable()}>
              <button
                type="button"
                class="qg-stale__retry"
                aria-label="Retry settings and quota data"
                onClick={() => state.retry()}
              >
                Retry
              </button>
            </Show>
          </div>
        </Show>
        <Switch>
          <Match when={contentMode() === "settings"}>
            <div class="qg-main" data-settings="true">
              <SettingsRoute
                client={client}
                query={state.query}
                catalog={state.catalog()}
                temporal={state.temporal()}
                toaster={toaster}
                stale={state.stale()}
                webDashboardToggle
                nativeQuotaAlerts
                aboutAction={diagnosticsAction()}
                onRetry={state.retry}
              />
            </div>
          </Match>
          <Match when={contentMode() === "quota-error"}>
            <div class="qg-main" data-settings="true">
              <ErrorCard
                message="Quota data could not be loaded. Visibility and temporal settings are unavailable until the quota read succeeds."
                retryable
                onRetry={() => state.retry()}
              />
              <BuildAbout>{diagnosticsAction()}</BuildAbout>
            </div>
          </Match>
          <Match when={contentMode() === "waiting"}>
            <div class="qg-main" data-settings="true">
              <BuildAbout>{diagnosticsAction()}</BuildAbout>
            </div>
          </Match>
        </Switch>
        <ToastRegion toaster={toaster} />
      </div>
    </NativeUiProvider>
  );
}
