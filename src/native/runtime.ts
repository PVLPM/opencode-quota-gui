import type { Context } from "@opencode/plugin/gui";
import { createEffect, onCleanup } from "solid-js";
import type { DashboardRpcViewScope } from "../rpc.js";
import { viewScopeForRoute } from "../ui/navigation-model.js";
import type { Location, Route } from "../ui/routing.js";
import { createNativeDashboardClient, type NativeDashboardClient } from "./dashboard-client.js";
import { initialNativeLocation } from "./navigation.js";
import { createGuiRpcCaller } from "./rpc.js";

/**
 * Window-lived Native dashboard runtime.
 *
 * OpenCode routes Settings as its own page (`/settings`), so a normal Settings
 * round-trip removes the session route subtree — including the side Panel —
 * while `Plugin.setup` stays alive. Creating the transport inside the Panel
 * therefore turned that navigation into a fresh client, health probe and watch
 * acquisition, which surfaced as a false `Connecting…`.
 *
 * This runtime owns one transport for the window and one in-memory location
 * per session. A mounted surface retains the transport; the Panel releases
 * analytics interest when it is hidden or unmounted, leaving only the cheap
 * quota scope. A genuine host loss still suspends the client and recovers
 * through the accepted reconnect path.
 */

export interface NativeDashboardRuntime {
  client: NativeDashboardClient;
  /** Starts the window transport on the first surface that needs it. */
  retain(): void;
  location(sessionKey: string): Location;
  setLocation(sessionKey: string, next: Location): void;
  /** Follows the visible surface; hidden surfaces never hold analytics interest. */
  setScope(scope: DashboardRpcViewScope): void;
  dispose(): void;
}

/** The scope a Panel contributes at a given visibility and route. */
export function panelScope(visible: boolean, route: Route): DashboardRpcViewScope {
  return visible ? viewScopeForRoute(route) : "quota";
}

export function createNativeDashboardRuntime(
  ctx: Pick<Context, "client" | "servers">,
): NativeDashboardRuntime {
  const client = createNativeDashboardClient({
    rpc: createGuiRpcCaller(ctx),
    scope: "quota",
  });
  const locations = new Map<string, Location>();
  let release: (() => void) | undefined;
  let retained = false;
  let scope: DashboardRpcViewScope = "quota";

  const hostConnected = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((server) => server?.builtin)?.connected ?? true;

  // Window-level interest: once a Panel has opened, a later remount must not
  // look like a reconnect. The window-level subscription keeps the transport
  // eligible; route-specific interest is applied through `setScope`.
  function retain(): void {
    if (retained) return;
    retained = true;
    if (!hostConnected()) client.suspend();
    release = client.subscribe(() => {});
  }

  let wasConnected: boolean | undefined;
  createEffect(() => {
    const connected = hostConnected();
    if (!retained) {
      wasConnected = connected;
      return;
    }
    if (!connected) {
      wasConnected = false;
      client.suspend();
      return;
    }
    if (wasConnected === false) {
      wasConnected = true;
      void client.resume();
      return;
    }
    wasConnected = true;
  });

  function dispose(): void {
    client.dispose();
    release?.();
    release = undefined;
  }
  onCleanup(dispose);

  return {
    client,
    retain,
    location: (sessionKey) => locations.get(sessionKey) ?? initialNativeLocation(),
    setLocation: (sessionKey, next) => {
      locations.set(sessionKey, next);
    },
    setScope: (next) => {
      if (next === scope) return;
      scope = next;
      void client.setActiveView(next).catch(() => undefined);
    },
    dispose,
  };
}
