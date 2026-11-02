/**
 * Per-window native quota notification subscription.
 *
 * `Plugin.setup` runs once in every app window, so this subscription is started
 * there rather than from the panel: notifications keep arriving while the panel,
 * slot or settings page is closed. Each window owns its own event stream and
 * cleanup; the server sends one event identity to all of them, and each window
 * decides between a toast and a system notification from its own focus state.
 *
 * RPC events are live-only. A dropped host connection aborts the stream, and the
 * host's builtin-server `connected` signal reopens it when it returns. There is
 * deliberately no timer, heartbeat, retry loop, held request or delivery
 * acknowledgement: if the host dies, that event is lost.
 */
import type { DashboardRpcCaller } from "./dashboard-client.js";
import {
  presentQuotaNotification,
  type QuotaNotificationHost,
} from "./quota-notification-presenter.js";

/** Bound on local duplicate-event memory; older ids are forgotten. */
const MAX_REMEMBERED_EVENT_IDS = 128;

export interface QuotaNotificationSubscriptionOptions {
  readonly events: DashboardRpcCaller["events"];
  readonly host: QuotaNotificationHost;
  /** Evaluated for each event, not captured once: focus can change between polls. */
  readonly focused: () => boolean;
  /** Window lifetime signal; aborting it stops this subscription. */
  readonly signal?: AbortSignal;
}

/** One window's notification lifecycle, driven by host connectivity. */
export interface QuotaNotificationSubscription {
  /**
   * Reports the host's current connectivity. `false` aborts the live stream;
   * `true` opens exactly one stream when none is running.
   */
  setConnected(connected: boolean): void;
  /** Idempotent window cleanup; never unsubscribes another window. */
  stop(): void;
}

/** The native window's focus predicate; false where no document is available. */
export function windowHasFocus(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof document.hasFocus === "function" &&
    document.hasFocus()
  );
}

/**
 * Starts one long-lived notification subscription. The caller reports host
 * connectivity reactively; the returned cleanup ends only this window's stream
 * and never tears down the server observation.
 */
export function startQuotaNotificationSubscription(
  options: QuotaNotificationSubscriptionOptions,
): QuotaNotificationSubscription {
  let stopped = false;
  let connected = false;
  let attempt: AbortController | undefined;
  const deliveredIds = new Set<string>();

  function remember(id: string): boolean {
    if (deliveredIds.has(id)) return false;
    deliveredIds.add(id);
    if (deliveredIds.size > MAX_REMEMBERED_EVENT_IDS) {
      const oldest = deliveredIds.values().next().value;
      if (oldest !== undefined) deliveredIds.delete(oldest);
    }
    return true;
  }

  function stopAttempt(): void {
    const current = attempt;
    attempt = undefined;
    current?.abort();
  }

  function deliver(payload: Parameters<typeof presentQuotaNotification>[0]): void {
    // An aborted stream may still yield a queued event; the attempt identity is
    // the barrier that keeps it from being presented.
    if (stopped || attempt === undefined || attempt.signal.aborted) return;
    if (!remember(payload.id)) return;
    try {
      presentQuotaNotification(payload, options.host, options.focused);
    } catch {
      // One host presentation failure never ends the window's subscription.
    }
  }

  function startAttempt(): void {
    if (stopped || !connected || attempt !== undefined) return;

    const controller = new AbortController();
    attempt = controller;
    void (async () => {
      try {
        for await (const event of options.events.subscribe("quotaNotification", {
          signal: controller.signal,
        })) {
          if (stopped || attempt !== controller || controller.signal.aborted) return;
          deliver(event.data);
        }
      } catch {
        // A stream end is a connectivity state, not a permanent stop. Recovery
        // is the host's `connected` signal; this module never schedules a retry.
      } finally {
        if (attempt === controller) attempt = undefined;
      }
    })();
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    connected = false;
    options.signal?.removeEventListener("abort", stop);
    stopAttempt();
  };

  if (options.signal?.aborted) {
    stop();
  } else {
    options.signal?.addEventListener("abort", stop, { once: true });
  }

  return {
    setConnected(next) {
      if (stopped) return;
      if (!next) {
        connected = false;
        stopAttempt();
        return;
      }
      if (connected && attempt !== undefined) return;
      connected = true;
      startAttempt();
    },
    stop,
  };
}
