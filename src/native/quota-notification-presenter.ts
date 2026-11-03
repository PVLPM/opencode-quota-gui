/**
 * Native quota notification presentation.
 *
 * One event, one surface: a focused window gets a toast, an unfocused one gets
 * a system notification. The presenter never falls back to a toast when the
 * host suppresses the notification, so a user who turned notifications off is
 * not notified through another channel, and it passes no duration, sound,
 * persistent flag, actions or session: those stay with the host's settings and
 * the app's own defaults.
 *
 * The caller owns the payload's wording and its stable event id. That id is
 * forwarded unchanged to `Attention.notify`, which uses it to show one
 * notification at most once across the app's windows.
 */

import type { Attention, Toasts } from "@opencode/plugin/gui";

export type QuotaNotificationKind = "low" | "exhausted" | "reset" | "provider-error";

/** The event the quota layer hands to the presenter. */
export interface QuotaNotificationPayload {
  /** Stable event id; forwarded unchanged to the host notification. */
  readonly id: string;
  readonly kind: QuotaNotificationKind;
  readonly title: string;
  readonly description?: string;
}

/**
 * The only two host methods this presenter needs. Passing `ctx.toast` and
 * `ctx.attention` satisfies it without exposing the rest of the GUI context.
 */
export interface QuotaNotificationHost {
  readonly toast: Pick<Toasts, "show">;
  readonly attention: Pick<Attention, "notify">;
}

/** Which surface received the event. */
export type QuotaNotificationDelivery = "toast" | "notification";

function toastVariant(kind: QuotaNotificationKind): "default" | "success" | "error" {
  switch (kind) {
    case "reset":
      return "success";
    case "low":
      return "default";
    case "exhausted":
    case "provider-error":
      return "error";
  }
}

function notificationVariant(kind: QuotaNotificationKind): "default" | "error" {
  return kind === "provider-error" ? "error" : "default";
}

/**
 * Presents one quota notification on the surface that fits the focus state.
 *
 * `host.attention.notify` is intentionally not awaited: it waits for the app
 * interface before it can send, and its contract is to never reject. A
 * suppressed notification (`notification: false`) is not replaced by a toast.
 */
export function presentQuotaNotification(
  payload: QuotaNotificationPayload,
  host: QuotaNotificationHost,
  focused: () => boolean,
): QuotaNotificationDelivery {
  if (focused()) {
    host.toast.show({
      title: payload.title,
      description: payload.description,
      variant: toastVariant(payload.kind),
    });
    return "toast";
  }

  void host.attention.notify({
    id: payload.id,
    title: payload.title,
    message: payload.description,
    variant: notificationVariant(payload.kind),
  });
  return "notification";
}
