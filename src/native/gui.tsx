import { Command, MenuItem, Panel, Plugin, Style, usePanel, usePlugin } from "@opencode/plugin/gui";
import type { JSX } from "solid-js";
import { onCleanup } from "solid-js";
import productCss from "../ui/styles.css?inline";
import { createNativeDashboardClient } from "./dashboard-client.js";
import nativeCss from "./native.css?inline";
import { DashboardPanel } from "./panel.js";
import { createGuiRpcCaller } from "./rpc.js";

/**
 * OpenCode Desktop GUI entry (Stage 4).
 *
 * One package, one server plugin, one GUI bundle: the host's Vite preset writes
 * `dist/gui-experimental.cjs`, and this file registers only GUI concerns. It
 * imports no server module and no `@opencode/ui`; the shared product UI is
 * reached through the same feature components the browser build uses.
 *
 * Stage 4 ships the Quota panel. Analytics stays a visibly staged entry until
 * its own panel stage, and Settings delegates to the host's settings window.
 */

const PANEL_ID = "dashboard";
const TAB_ID = "quota";

/** Stable objects: the host re-renders tab labels only when a new object appears. */
const QUOTA_TAB = { id: TAB_ID, title: "Quota" } as const;

function NativeQuotaPanel(): JSX.Element {
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
      onOpenSettings={() => ctx.layout.settings()}
    />
  );
}

/** Opens the Quota tab in the routed session's side region. */
function openQuotaPanel(ctx: ReturnType<typeof usePlugin>): void {
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
      mobile: { title: "Quota", order: 20, kind: "menu", icon: "layout-right" },
      list: ({ open }) => (open.includes(TAB_ID) ? [QUOTA_TAB] : []),
      render: () => <NativeQuotaPanel />,
    });

    ctx.add(Command, {
      id: "open-quota",
      title: "Open quota panel",
      description: "Show provider quotas in the side region",
      keywords: "quota providers limits usage panel",
      section: "navigation",
      group: "Navigation",
      run: () => openQuotaPanel(ctx),
    });

    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "open-quota",
      title: "Quota",
      icon: "layout-right",
      run: () => openQuotaPanel(ctx),
    });
  },
});
