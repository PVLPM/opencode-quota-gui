/**
 * The official RPC client, adapted to the transport-neutral Stage 3 seam.
 *
 * `ctx.client` is read on every call, not captured: the host swaps it when the
 * plugin's server restarts, and a cached client would keep rejecting. The
 * adapter exposes only the typed dashboard methods; there is no generic
 * dispatch and no HTTP or localhost fallback.
 */
import type { Context } from "@opencode/plugin/gui";
import { isDashboardEvent } from "../contracts/guards.js";
import type { DashboardRpcQuotaNotificationData } from "../rpc.js";
import {
  DashboardRpc,
  isDashboardRpcCacheObserverEventData,
  isDashboardRpcQuotaNotificationData,
} from "../rpc.js";
import type { DashboardRpcCaller } from "./dashboard-client.js";

export function createGuiRpcCaller(ctx: Pick<Context, "client">): DashboardRpcCaller {
  const rpc = () => ctx.client.rpc(DashboardRpc);

  return {
    health: (input, options) => rpc().health(input, options),
    quota: (input, options) => rpc().quota(input, options),
    home: (input, options) => rpc().home(input, options),
    groups: (input, options) => rpc().groups(input, options),
    project: (input, options) => rpc().project(input, options),
    session: (input, options) => rpc().session(input, options),
    settings: (input, options) => rpc().settings(input, options),
    saveSettings: (input, options) => rpc().saveSettings(input, options),
    saveVisibility: (input, options) => rpc().saveVisibility(input, options),
    importPreview: (input, options) => rpc().importPreview(input, options),
    importApply: (input, options) => rpc().importApply(input, options),
    openSettingsFile: (input, options) => rpc().openSettingsFile(input, options),
    watch: (input, options) => rpc().watch(input, options),
    events: {
      /**
       * The transport validates the event schema; the guards repeat the shape
       * check at the seam so an unexpected payload is dropped here rather than
       * reaching the feature layer. Notifications use their own channel, so an
       * invalidation subscriber never has to interpret one.
       */
      subscribe: ((name: "invalidated" | "quotaNotification", options?: { signal?: AbortSignal }) =>
        (async function* () {
          for await (const event of rpc().events.subscribe(name, options)) {
            if (name === "invalidated") {
              if (
                !isDashboardEvent(event.data) &&
                !isDashboardRpcCacheObserverEventData(event.data)
              ) {
                continue;
              }
              yield { data: event.data };
            } else {
              if (!isDashboardRpcQuotaNotificationData(event.data)) continue;
              yield { data: event.data as DashboardRpcQuotaNotificationData };
            }
          }
        })()) as DashboardRpcCaller["events"]["subscribe"],
    },
  };
}
