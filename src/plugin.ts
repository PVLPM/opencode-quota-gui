/**
 * OpenCode V2 server plugin for the GUI-only product: it starts the shared
 * dashboard runtime, attaches the typed dashboard RPC transport, and keeps the
 * credential and quota-reset retry lifecycle working. Inherited terminal
 * surfaces (commands, tool, the TUI quota RPC and report hooks) are retained in
 * their source modules but are not registered by this product.
 */
import { Plugin } from "@opencode/plugin";
import { type DashboardLease, startDashboard } from "./gui/lifecycle.js";
import { scrubLogReason } from "./gui/log.js";
import { registerDashboardRpc } from "./gui/rpc.js";
import { projectOpenCodeCacheObserverEvent } from "./lib/cache-observer-ingestion.js";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
  scrubCredentialErrorText,
} from "./lib/opencode-auth.js";
import { resolveQuotaResetRetryDelayMs } from "./lib/quota-retry-wait.js";
import type { QuotaSurfaceHost } from "./lib/quota-surface-data.js";

/** An error as one line that is safe to log: tokens redacted, at most 120 characters. */
function logReason(error: unknown): string {
  return scrubCredentialErrorText(error instanceof Error ? error.message : String(error));
}

const MAX_PENDING_CACHE_OBSERVER_EVENTS = 512;
type ProjectedCacheObserverEvent = NonNullable<
  ReturnType<typeof projectOpenCodeCacheObserverEvent>
>;
interface PendingCacheObserverEvent {
  at: number;
  event: ProjectedCacheObserverEvent;
}

export const QuotaToastPlugin = Plugin.define({
  id: "opencode-quota-gui",
  async setup(ctx) {
    const roots = resolveOpenCodeLocationRoots(ctx.location.directory);
    // The quota collector accepts a small V1-shaped configuration client. V2
    // does not expose a mutable global config to plugins; runtime settings are
    // read from the canonical GUI config file by the collector.
    const client = {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({
          data: {
            providers: (await ctx.provider.list()).data.map((provider) => ({ id: provider.id })),
          },
        }),
      },
    };

    // With waitForQuotaReset on, a request that hit a provider limit is retried after the
    // used-up quota window resets. Any failure keeps OpenCode's own retry decision.
    const retryHost: Pick<QuotaSurfaceHost, "client" | "roots"> = { client, roots };
    await ctx.session.hook("retry", async (event) => {
      try {
        const delay = await resolveQuotaResetRetryDelayMs(retryHost, event);
        if (delay !== undefined) event.decision = { retry: true, delay };
      } catch (error) {
        console.warn(`[opencode-quota-gui] retry hook failed: ${logReason(error)}`);
      }
    });

    // Every login read in this process goes through this location's `ctx.integration`. Bound
    // last, so a setup that fails part way leaves no binding behind. OpenCode routes the
    // retained hooks only after setup, so no read comes earlier.
    const unbindCredentialSource = bindCredentialSource(
      createIntegrationCredentialSource(ctx.integration),
    );
    let dashboardRpc: Awaited<ReturnType<typeof registerDashboardRpc>> | undefined;
    let cacheObserverEmitChain: Promise<void> = Promise.resolve();
    const pendingCacheObserverEvents: PendingCacheObserverEvent[] = [];
    let pendingCacheObserverEventsDropped = false;
    const cacheObserverRelayAbort = new AbortController();
    let cacheObserverEmitWorkerRunning = false;
    type HostEventSourceState = "unverified" | "observed" | "unavailable" | "stopped";
    let hostEventSourceState: HostEventSourceState = "unverified";
    let lastHostEventAtMs: number | undefined;
    async function emitCacheObserverEventNow(
      registration: NonNullable<typeof dashboardRpc>,
      pending: PendingCacheObserverEvent,
    ): Promise<void> {
      const { signal } = cacheObserverRelayAbort;
      if (signal.aborted) return;
      const emission = Promise.resolve()
        .then(() => {
          if (signal.aborted) return;
          return registration.events.emit("invalidated", {
            topic: "cache.observer",
            at: pending.at,
            cacheObserverEvent: pending.event,
          });
        })
        .then(
          () => undefined,
          () => undefined,
        );
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", finish);
          resolve();
        };
        signal.addEventListener("abort", finish, { once: true });
        void emission.then(finish);
      });
    }
    async function drainCacheObserverEvents(): Promise<void> {
      try {
        while (!cacheObserverRelayAbort.signal.aborted) {
          if (pendingCacheObserverEventsDropped) {
            pendingCacheObserverEventsDropped = false;
            const registration = dashboardRpc;
            if (!registration) continue;
            const gapAt = Date.now();
            await emitCacheObserverEventNow(registration, {
              at: gapAt,
              event: { type: "source.status", created: gapAt, data: { state: "unavailable" } },
            });
            continue;
          }
          const pending = pendingCacheObserverEvents.shift();
          if (!pending) break;
          const registration = dashboardRpc;
          if (registration) await emitCacheObserverEventNow(registration, pending);
        }
      } finally {
        cacheObserverEmitWorkerRunning = false;
      }
    }
    const emitCacheObserverEvent = (event: ProjectedCacheObserverEvent, at: number): void => {
      const registration = dashboardRpc;
      if (!registration || cacheObserverRelayAbort.signal.aborted) return;
      if (pendingCacheObserverEvents.length >= MAX_PENDING_CACHE_OBSERVER_EVENTS) {
        pendingCacheObserverEvents.shift();
        pendingCacheObserverEventsDropped = true;
      }
      pendingCacheObserverEvents.push({ at, event });
      if (!cacheObserverEmitWorkerRunning) {
        cacheObserverEmitWorkerRunning = true;
        cacheObserverEmitChain = drainCacheObserverEvents().catch(() => undefined);
      }
    };
    const publishHostEventSourceState = (
      state: Exclude<HostEventSourceState, "unverified">,
      at: number,
    ): void => {
      hostEventSourceState = state;
      if (state === "observed") lastHostEventAtMs = at;
      if (!dashboardRpc) return;
      emitCacheObserverEvent({ type: "source.status", created: at, data: { state } }, at);
    };
    // Reuse the existing host stream for credential invalidation and narrowly projected cache
    // evidence. No Native-side OpenCode event subscription is opened.
    const hostEvents = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: hostEvents.signal })) {
        if (hostEvents.signal.aborted) return;
        if (hostEventSourceState === "unverified") {
          publishHostEventSourceState(
            "observed",
            typeof event.created === "number" && Number.isFinite(event.created)
              ? event.created
              : Date.now(),
          );
        }
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          notifyCredentialsChanged();
        }
        // The Started event's model identity is available before invocation completion. Do not
        // enrich it from model.list here: that mutable catalog may no longer match dispatch.
        const cacheObserverEvent = projectOpenCodeCacheObserverEvent(event);
        if (
          cacheObserverEvent !== undefined &&
          typeof event.created === "number" &&
          Number.isFinite(event.created) &&
          event.created >= 0
        ) {
          if (dashboardRpc !== undefined) {
            emitCacheObserverEvent(cacheObserverEvent, event.created);
          } else {
            if (pendingCacheObserverEvents.length >= MAX_PENDING_CACHE_OBSERVER_EVENTS) {
              pendingCacheObserverEvents.shift();
              pendingCacheObserverEventsDropped = true;
            }
            pendingCacheObserverEvents.push({ at: event.created, event: cacheObserverEvent });
          }
        }
      }
      if (!hostEvents.signal.aborted) throw new Error("host event stream ended");
    })().catch((error) => {
      if (hostEvents.signal.aborted) return;
      publishHostEventSourceState("unavailable", Date.now());
      console.warn(`[opencode-quota-gui] host event subscription stopped: ${logReason(error)}`);
    });

    // The dashboard host binds last — after the retry hook and the credential binding — and it
    // never fails setup: every dashboard error stays a controlled log line and an `unavailable`
    // lease (spec §4.3). The first owner workspace supplies the config import root, and the
    // settings store reads the global canonical config. Binding is all that happens here; the
    // first snapshot is computed on the first request.
    let dashboardLease: DashboardLease | undefined;
    try {
      // Older hosts may not supply `ctx.app` at runtime; an absent or empty
      // version lets the lifecycle use its bounded `opencode --version` probe.
      const hostVersion = (ctx.app as { version?: string } | undefined)?.version;
      dashboardLease = await startDashboard({
        client,
        workspaceRoot: ctx.location.directory,
        ...(hostVersion !== undefined ? { hostVersion } : {}),
      });
    } catch (error) {
      console.warn(`[opencode-quota-gui] dashboard unavailable: ${logReason(error)}`);
    }

    // Attach the native RPC transport to the same host runtime the web
    // transport receives. It is available when web is disabled or its bind
    // failed, and it never constructs another source/snapshot/service.
    if (dashboardLease?.runtime && ctx.rpc) {
      try {
        dashboardRpc = await registerDashboardRpc(ctx.rpc, dashboardLease.runtime, {
          location: ctx.location,
        });
        const bufferedCacheObserverEvents = pendingCacheObserverEvents.splice(0);
        if (pendingCacheObserverEventsDropped) {
          const gapAt = Date.now();
          pendingCacheObserverEventsDropped = false;
          emitCacheObserverEvent(
            { type: "source.status", created: gapAt, data: { state: "unavailable" } },
            gapAt,
          );
        }
        const sourceStateAtRegistration = hostEventSourceState;
        const firstObservedAt = lastHostEventAtMs;
        // Preserve the source's initial observation before its buffered events. If the stream
        // stopped while registration was pending, replay those events before the final
        // unavailable state. Keep this flush synchronous so later live events cannot interleave.
        if (firstObservedAt !== undefined) {
          emitCacheObserverEvent(
            { type: "source.status", created: firstObservedAt, data: { state: "observed" } },
            firstObservedAt,
          );
        }
        for (const pending of bufferedCacheObserverEvents) {
          emitCacheObserverEvent(pending.event, pending.at);
        }
        if (
          sourceStateAtRegistration !== "unverified" &&
          sourceStateAtRegistration !== "observed"
        ) {
          publishHostEventSourceState(sourceStateAtRegistration, Date.now());
        }
      } catch {
        console.warn(`[opencode-quota-gui] dashboard RPC unavailable: registration-failed`);
      }
    }

    return async () => {
      hostEvents.abort();
      pendingCacheObserverEvents.length = 0;
      publishHostEventSourceState("stopped", Date.now());
      unbindCredentialSource();
      pendingCacheObserverEvents.length = 0;
      pendingCacheObserverEventsDropped = false;
      cacheObserverRelayAbort.abort();
      await cacheObserverEmitChain;
      if (dashboardRpc) {
        try {
          await dashboardRpc.dispose();
        } catch (error) {
          console.warn(
            `[opencode-quota-gui] dashboard RPC stop failed: ${scrubLogReason(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
      }
      if (dashboardLease) {
        try {
          await dashboardLease.dispose();
        } catch (error) {
          console.warn(`[opencode-quota-gui] dashboard stop failed: ${logReason(error)}`);
        }
      }
    };
  },
});

export default QuotaToastPlugin;
