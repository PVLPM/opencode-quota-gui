import type { Context } from "@opencode/plugin/gui";
import { createEffect, onCleanup } from "solid-js";
import type { DashboardRpcViewScope } from "../rpc.js";
import { viewScopeForRoute } from "../ui/navigation-model.js";
import type { Location, Route } from "../ui/routing.js";
import {
  createNativeCacheObserverRuntime,
  type NativeCacheObserver,
  type NativeCacheObserverRuntime,
} from "./cache-observer-runtime.js";
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
 * shared by every routed session. OpenCode keeps `Panel.render` mounted while
 * `input.session` changes, so the Panel's own signal carries that location for
 * the window lifetime; a Settings remount re-seeds it from this single value.
 * A mounted surface retains the transport; the Panel releases analytics
 * interest when it is hidden or unmounted, leaving only the cheap quota scope.
 * A genuine host loss still suspends the client and recovers through the
 * accepted reconnect path.
 */

export interface NativeDashboardRuntime {
  client: NativeDashboardClient;
  /** Best-effort cache observations from Native's existing dashboard event stream. */
  cacheObserver: NativeCacheObserver;
  /** Starts the window transport on the first surface that needs it. */
  retain(): void;
  /** The window's current dashboard location, shared by every routed session. */
  location(): Location;
  setLocation(next: Location): void;
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
  const cacheObserver = createNativeCacheObserverRuntime({
    subscribeEvents: (listener) => client.subscribeCacheObserverEvent(listener),
    rpcConnection: () => client.connection(),
    subscribeRpcConnection: (listener) => client.onConnectionChange(listener),
    subscribeReconnect: (listener) => client.onReconnect(listener),
    subscribeEventStreamRetire: (listener) => client.onEventStreamRetire(listener),
    listChildren: async (parentSessionId) => {
      const children: Array<{ id: string; parentID?: string; title?: string }> = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;

      while (true) {
        const page = await ctx.client.session.list({
          parentID: parentSessionId,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const session of page.data) {
          children.push({
            id: session.id,
            ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
            ...(session.title === undefined ? {} : { title: session.title }),
          });
        }

        const nextCursor = page.cursor.next;
        if (
          typeof nextCursor !== "string" ||
          nextCursor.length === 0 ||
          seenCursors.has(nextCursor)
        ) {
          break;
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }

      return children;
    },
    // Lazy cache-history demand is the only Native path that calls message.list.
    // Forward its cancellation signal directly to the installed public client.
    listMessages: (input, requestOptions) => ctx.client.message.list(input, requestOptions),
  });
  let location: Location = initialNativeLocation();
  let release: (() => void) | undefined;
  let retained = false;
  let scope: DashboardRpcViewScope = "quota";

  const hostConnected = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((server) => server?.builtin)?.connected ?? true;

  // Window-level interest: once a Panel or cache-pill surface needs transport,
  // later remounts reuse it. Route-specific interest is applied through `setScope`.
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
    cacheObserver.dispose();
    client.dispose();
    release?.();
    release = undefined;
  }
  onCleanup(dispose);

  return {
    client,
    cacheObserver,
    retain,
    location: () => location,
    setLocation: (next) => {
      location = next;
    },
    setScope: (next) => {
      if (next === scope) return;
      scope = next;
      // A scope change keeps the visible live state but replaces the attempt:
      // the new scope runs its own health probe, invalidation stream and watch.
      void client.setActiveView(next).catch(() => undefined);
    },
    dispose,
  };
}
