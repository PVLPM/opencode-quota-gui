import {
  Command,
  MenuItem,
  Panel,
  Plugin,
  SettingsPage,
  Style,
  usePanel,
  usePlugin,
} from "@opencode/plugin/gui";
import type { JSX } from "solid-js";
import { onCleanup } from "solid-js";
import productCss from "../ui/styles.css?inline";
import { createNativeDashboardClient } from "./dashboard-client.js";
import nativeCss from "./native.css?inline";
import { DashboardPanel } from "./panel.js";
import { createGuiRpcCaller } from "./rpc.js";
import { NativeSettingsPage, SETTINGS_PAGE_ID } from "./settings-page.js";

/**
 * OpenCode Desktop GUI entry (Stage 5).
 *
 * One package, one server plugin, one GUI bundle: the host's Vite preset writes
 * `dist/gui-experimental.cjs`, and this file registers only GUI concerns. It
 * imports no server module and no `@opencode/ui`; the shared product UI is
 * reached through the same feature components the browser build uses.
 *
 * The side Panel hosts the full dashboard navigation (Quota, Analytics, Models
 * and their drilldowns) through the shared route containers. Settings is an
 * official `SettingsPage` built from the shared settings view and backend.
 */

const PANEL_ID = "dashboard";
const TAB_ID = "dashboard";

/** Stable objects: the host re-renders tab labels only when a new object appears. */
const DASHBOARD_TAB = { id: TAB_ID, title: "Dashboard" } as const;

function NativeDashboardPanel(): JSX.Element {
  const ctx = usePlugin();
  const panel = usePanel();
  const client = createNativeDashboardClient({
    rpc: createGuiRpcCaller(ctx),
    scope: "quota",
  });
  onCleanup(() => client.dispose());

  // The plugin's server is the app's own (builtin) server. Its ref follows the
  // live connection across restarts, so `connected` is the host-supported
  // recovery signal; no timer or heartbeat is added.
  const hostServer = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((server) => server?.builtin);
  const hostConnected = () => hostServer()?.connected ?? true;

  return (
    <DashboardPanel
      client={client}
      visible={panel.visible}
      hostConnected={hostConnected}
      onOpenSettings={() => ctx.layout.settings(SETTINGS_PAGE_ID)}
    />
  );
}

/** Opens the Dashboard tab in the routed session's side region. */
function openDashboardPanel(ctx: ReturnType<typeof usePlugin>): void {
  const session = ctx.sessions.current() ?? ctx.sessions.list()[0];
  if (session === undefined) return;
  ctx.layout.open(`${ctx.id}:${TAB_ID}`, session);
}

export default Plugin.define({
  setup(ctx) {
    // Contribution order is cascade order: the product sheet first, then the
    // host-only additions. Both are inert outside `.qg-native`/`.qg-panel-root`
    // except for the namespaced `--qg-*` custom properties on `:root`.
    ctx.add(Style, productCss);
    ctx.add(Style, nativeCss);

    ctx.add(Panel, {
      id: PANEL_ID,
      region: "side",
      mobile: { title: "Dashboard", order: 20, kind: "menu", icon: "layout-right" },
      list: ({ open }) => (open.includes(TAB_ID) ? [DASHBOARD_TAB] : []),
      render: () => <NativeDashboardPanel />,
    });

    ctx.add(SettingsPage, {
      id: SETTINGS_PAGE_ID,
      title: "Quota & analytics",
      icon: "window-analytics",
      entries: [
        {
          id: SETTINGS_PAGE_ID,
          title: "Quota & analytics",
          description: "Shared product settings for quota cards, analytics and the web dashboard",
          keywords:
            "quota providers analytics visibility order temporal pricing web dashboard enabled port",
        },
      ],
      render: () => <NativeSettingsPage ctx={ctx} />,
    });

    ctx.add(Command, {
      id: "open-dashboard",
      title: "Open dashboard panel",
      description: "Show quota, analytics and model usage in the side region",
      keywords: "dashboard quota analytics models providers limits usage panel",
      section: "navigation",
      group: "Navigation",
      run: () => openDashboardPanel(ctx),
    });

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "open-dashboard",
      title: "Dashboard",
      icon: "layout-right",
      run: () => openDashboardPanel(ctx),
    });
  },
});
