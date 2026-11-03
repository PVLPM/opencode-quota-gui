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
 * no timer, heartbeat, retry loop, held request or delivery acknowledgement: an
 * unexpected connected-stream failure gets one health probe and at most one
 * replacement stream before another host transition or delivered event.
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
  /** One-shot liveness probe used only after an unexpected connected-stream end. */
  readonly health: DashboardRpcCaller["health"];
  readonly host: QuotaNotificationHost;
  /** Evaluated for each event, not captured once: focus can change between polls. */
  readonly focused: () => boolean;
  /** Window lifetime signal; aborting it stops this subscription. */
  readonly signal?: AbortSignal;
}

/** One window's notification lifecycle, driven by host connectivity. */
export interface QuotaNotificationSubscription {
  /**
   * Reports host connectivity. A transition to `false` aborts the stream and
   * any pending health probe; a later transition to `true` opens one stream.
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
  let connectionGeneration = 0;
  let attempt: AbortController | undefined;
  let recovery: AbortController | undefined;
  let recoverySpent = false;
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
    // Keep ownership until the iterator unwinds. Some transports can ignore
    // abort temporarily; opening a replacement before this settles would leave
    // two streams alive for this window.
    current?.abort();
  }

  function stopRecovery(): void {
    const current = recovery;
    recovery = undefined;
    current?.abort();
  }

  function deliver(payload: Parameters<typeof presentQuotaNotification>[0]): void {
    // An aborted stream may still yield a queued event; the attempt identity is
    // the barrier that keeps it from being presented.
    if (stopped || attempt === undefined || attempt.signal.aborted) return;
    if (!remember(payload.id)) return;
    recoverySpent = false;
    try {
      presentQuotaNotification(payload, options.host, options.focused);
    } catch {
      // One host presentation failure never ends the window's subscription.
    }
  }

  async function recoverAfterFailure(generation: number): Promise<void> {
    if (
      stopped ||
      !connected ||
      connectionGeneration !== generation ||
      recoverySpent ||
      recovery !== undefined
    ) {
      return;
    }

    recoverySpent = true;
    const controller = new AbortController();
    recovery = controller;
    let currentRecovery = false;
    try {
      await options.health({}, { signal: controller.signal });
      currentRecovery = recovery === controller;
    } catch {
      // A failed probe waits for the host's next false-to-true transition.
    } finally {
      if (recovery === controller) recovery = undefined;
    }

    if (
      !currentRecovery ||
      stopped ||
      !connected ||
      connectionGeneration !== generation ||
      controller.signal.aborted
    ) {
      return;
    }
    startAttempt();
  }

  function startAttempt(): void {
    if (stopped || !connected || attempt !== undefined) return;

    const controller = new AbortController();
    const generation = connectionGeneration;
    attempt = controller;
    void (async () => {
      let endedUnexpectedly = false;
      try {
        for await (const event of options.events.subscribe("quotaNotification", {
          signal: controller.signal,
        })) {
          if (stopped || attempt !== controller || controller.signal.aborted) return;
          deliver(event.data);
        }
        endedUnexpectedly = true;
      } catch {
        endedUnexpectedly = true;
      } finally {
        if (attempt === controller) {
          attempt = undefined;
          if (!stopped && connected) {
            if (connectionGeneration !== generation) {
              // Resume only after the old stream has been released.
              startAttempt();
            } else if (endedUnexpectedly && !controller.signal.aborted) {
              void recoverAfterFailure(generation);
            }
          }
        }
      }
    })();
  }

  const stop = () => {
    if (stopped) return;
    stopped = true;
    connected = false;
    connectionGeneration += 1;
    options.signal?.removeEventListener("abort", stop);
    stopAttempt();
    stopRecovery();
  };

  if (options.signal?.aborted) {
    stop();
  } else {
    options.signal?.addEventListener("abort", stop, { once: true });
  }

  return {
    setConnected(next) {
      if (stopped) return;
      if (connected === next) return;
      connected = next;
      connectionGeneration += 1;
      if (!next) {
        stopAttempt();
        stopRecovery();
        return;
      }
      recoverySpent = false;
      startAttempt();
    },
    stop,
  };
}
