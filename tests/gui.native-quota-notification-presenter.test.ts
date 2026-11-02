import { describe, expect, it, vi } from "vitest";
import {
  presentQuotaNotification,
  type QuotaNotificationHost,
  type QuotaNotificationPayload,
} from "../src/native/quota-notification-presenter";

/**
 * Native quota notification presentation.
 *
 * The presenter chooses one host surface per event: a toast while the window
 * has focus, a system notification while it does not, and never a toast as a
 * fallback for a suppressed notification. These tests drive it with recording
 * host APIs, so the assertions pin the exact payload sent to each surface.
 */

const basePayload: QuotaNotificationPayload = {
  id: "quota-low:openai:2026-11-02T10:00:00.000Z",
  kind: "low",
  title: "OpenAI quota is low",
  description: "12% of the 5-hour window remains.",
};

function createHost(notification = true) {
  const toast = { show: vi.fn(() => ({ dismiss: () => undefined })) };
  const attention = {
    notify: vi.fn(async () => ({ notification, sound: false })),
  };
  const host: QuotaNotificationHost = { toast, attention };
  return { host, toast, attention };
}

describe("native quota notification presenter", () => {
  describe("focused window", () => {
    const focused = () => true;

    it.each([
      ["reset", "success"],
      ["low", "default"],
      ["exhausted", "error"],
      ["provider-error", "error"],
    ] as const)("shows a %s event as a %s toast", (kind, variant) => {
      const { host, toast, attention } = createHost();

      const delivery = presentQuotaNotification({ ...basePayload, kind }, host, focused);

      expect(delivery).toBe("toast");
      expect(toast.show).toHaveBeenCalledExactlyOnceWith({
        title: basePayload.title,
        description: basePayload.description,
        variant,
      });
      expect(attention.notify).not.toHaveBeenCalled();
    });

    it("leaves duration, persistence, actions and icons to the host default", () => {
      const { host, toast } = createHost();

      presentQuotaNotification(basePayload, host, focused);

      const options = toast.show.mock.calls[0]?.[0];
      expect(options).toEqual({
        title: basePayload.title,
        description: basePayload.description,
        variant: "default",
      });
    });

    it("passes an absent description through as undefined", () => {
      const { host, toast } = createHost();

      presentQuotaNotification(
        { id: "quota-reset:zai", kind: "reset", title: "Z.ai quota reset" },
        host,
        focused,
      );

      expect(toast.show).toHaveBeenCalledExactlyOnceWith({
        title: "Z.ai quota reset",
        description: undefined,
        variant: "success",
      });
    });
  });

  describe("unfocused window", () => {
    const unfocused = () => false;

    it.each([
      ["low", "default"],
      ["exhausted", "default"],
      ["reset", "default"],
      ["provider-error", "error"],
    ] as const)("sends a %s event with the %s notification variant", (kind, variant) => {
      const { host, toast, attention } = createHost();

      const delivery = presentQuotaNotification({ ...basePayload, kind }, host, unfocused);

      expect(delivery).toBe("notification");
      expect(attention.notify).toHaveBeenCalledExactlyOnceWith({
        id: basePayload.id,
        title: basePayload.title,
        message: basePayload.description,
        variant,
      });
      expect(toast.show).not.toHaveBeenCalled();
    });

    it("preserves the provided id unchanged across repeated presentations", () => {
      const event = { ...basePayload, id: "quota-exhausted:zai:2026-11-02T11:00:00.000Z" };
      const first = createHost();
      const second = createHost();

      presentQuotaNotification(event, first.host, unfocused);
      presentQuotaNotification({ ...event }, second.host, unfocused);

      const firstId = first.attention.notify.mock.calls[0]?.[0]?.id;
      const secondId = second.attention.notify.mock.calls[0]?.[0]?.id;
      expect(firstId).toBe(event.id);
      expect(secondId).toBe(event.id);
      expect(firstId).toBe(secondId);
    });

    it("leaves sound and session unset so the host follows native settings", () => {
      const { host, attention } = createHost();

      presentQuotaNotification(basePayload, host, unfocused);

      const options = attention.notify.mock.calls[0]?.[0];
      expect(options).not.toHaveProperty("sound");
      expect(options).not.toHaveProperty("session");
    });

    it("does not fall back to a toast when native notifications are off", async () => {
      const { host, toast, attention } = createHost(false);

      presentQuotaNotification({ ...basePayload, kind: "provider-error" }, host, unfocused);

      expect(attention.notify).toHaveBeenCalledOnce();
      await expect(attention.notify.mock.results[0]?.value).resolves.toEqual({
        notification: false,
        sound: false,
      });
      expect(toast.show).not.toHaveBeenCalled();
    });
  });

  it("evaluates the focus predicate per presentation, not once at import", () => {
    const { host, toast, attention } = createHost();
    const focus = vi.fn(() => true);

    presentQuotaNotification(basePayload, host, focus);
    focus.mockReturnValue(false);
    presentQuotaNotification(basePayload, host, focus);

    expect(focus).toHaveBeenCalledTimes(2);
    expect(toast.show).toHaveBeenCalledOnce();
    expect(attention.notify).toHaveBeenCalledOnce();
  });
});
