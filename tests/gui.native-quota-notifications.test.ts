/**
 * Per-window native quota notification delivery.
 *
 * `Plugin.setup` runs once per window, so the subscription is started there and
 * keeps working while the panel and settings page are closed. A window presents
 * only the final safe event: a focused window gets a toast, an unfocused one a
 * system notification, and both receive the same deterministic id. There is no
 * held RPC, timer, heartbeat or retry loop; a reconnect is the host's own
 * builtin-server `connected` signal going false and true again.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardRpcCaller } from "../src/native/dashboard-client.js";
import {
  type QuotaNotificationSubscription,
  startQuotaNotificationSubscription,
  windowHasFocus,
} from "../src/native/quota-notifications.js";
import type { DashboardRpcQuotaNotificationData } from "../src/rpc.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const event: DashboardRpcQuotaNotificationData = {
  id: `${"b".repeat(64)}:${Date.parse("2026-11-02T12:01:00.000Z")}`,
  kind: "exhausted",
  title: "OpenAI quota exhausted",
  description: "work: 5-hour window: 0% remaining. Resets 2026-11-02T17:00:00.000Z.",
};

interface ManualStream<T> {
  push(value: T): void;
  end(): void;
  signal?: AbortSignal;
}

function createWindowEventSource() {
  const streams = new Set<ManualStream<DashboardRpcQuotaNotificationData>>();
  let subscriptions = 0;
  const events: DashboardRpcCaller["events"] = {
    subscribe(name, options) {
      if (name !== "quotaNotification") throw new Error(`unexpected event ${name}`);
      subscriptions += 1;
      const signal = options?.signal;
      const queue: DashboardRpcQuotaNotificationData[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      const stream: ManualStream<DashboardRpcQuotaNotificationData> = {
        signal,
        push(value) {
          queue.push(value);
          wake?.();
          wake = undefined;
        },
        end() {
          ended = true;
          wake?.();
          wake = undefined;
        },
      };
      streams.add(stream);
      signal?.addEventListener(
        "abort",
        () => {
          streams.delete(stream);
          stream.end();
        },
        { once: true },
      );

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const value = queue.shift();
            if (value !== undefined) {
              yield { data: value };
              continue;
            }
            if (ended || signal?.aborted === true) return;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
      };
    },
  };
  return {
    events,
    emit(data: DashboardRpcQuotaNotificationData) {
      for (const stream of streams) stream.push(data);
    },
    endAll() {
      for (const stream of [...streams]) {
        streams.delete(stream);
        stream.end();
      }
    },
    get subscriptions() {
      return subscriptions;
    },
    get activeStreams() {
      return streams.size;
    },
  };
}

function createHost() {
  const toast = { show: vi.fn(() => ({ dismiss: () => undefined })) };
  const attention = {
    notify: vi.fn(async () => ({ notification: true, sound: false })),
  };
  return { host: { toast, attention }, toast, attention };
}

function startWindow(options: {
  events: DashboardRpcCaller["events"];
  host: ReturnType<typeof createHost>["host"];
  focused: () => boolean;
  signal?: AbortSignal;
}): QuotaNotificationSubscription {
  return startQuotaNotificationSubscription(options);
}

describe("native quota notification subscription", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes once per window and presents one event on the focus-appropriate surface", async () => {
    const source = createWindowEventSource();
    const focused = createHost();
    const unfocused = createHost();

    const focusedWindow = startWindow({
      events: source.events,
      host: focused.host,
      focused: () => true,
    });
    const unfocusedWindow = startWindow({
      events: source.events,
      host: unfocused.host,
      focused: () => false,
    });

    focusedWindow.setConnected(true);
    unfocusedWindow.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(2));
    expect(source.subscriptions).toBe(2);

    // A same-value host signal does not open a second stream.
    focusedWindow.setConnected(true);
    unfocusedWindow.setConnected(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.activeStreams).toBe(2);
    expect(source.subscriptions).toBe(2);

    source.emit(event);
    await vi.waitFor(() => {
      expect(focused.toast.show).toHaveBeenCalledOnce();
      expect(unfocused.attention.notify).toHaveBeenCalledOnce();
    });

    expect(focused.toast.show).toHaveBeenCalledWith({
      title: event.title,
      description: event.description,
      variant: "error",
    });
    expect(unfocused.attention.notify).toHaveBeenCalledWith({
      id: event.id,
      title: event.title,
      message: event.description,
      variant: "default",
    });

    focusedWindow.stop();
    unfocusedWindow.stop();
  });

  it("deduplicates a repeated event id locally in each window", async () => {
    const source = createWindowEventSource();
    const first = createHost();
    const second = createHost();
    const firstWindow = startWindow({
      events: source.events,
      host: first.host,
      focused: () => false,
    });
    const secondWindow = startWindow({
      events: source.events,
      host: second.host,
      focused: () => false,
    });
    firstWindow.setConnected(true);
    secondWindow.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(2));

    source.emit(event);
    source.emit(event);
    await vi.waitFor(() => {
      expect(first.attention.notify).toHaveBeenCalledOnce();
      expect(second.attention.notify).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.attention.notify).toHaveBeenCalledOnce();
    expect(second.attention.notify).toHaveBeenCalledOnce();

    // A different occurrence with the same wording is still presented.
    source.emit({ ...event, id: `${"c".repeat(64)}:${2}` });
    await vi.waitFor(() => {
      expect(first.attention.notify).toHaveBeenCalledTimes(2);
      expect(second.attention.notify).toHaveBeenCalledTimes(2);
    });

    firstWindow.stop();
    secondWindow.stop();
  });

  it("evaluates focus per event rather than capturing it once", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    let focused = true;
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => focused,
    });
    window.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));

    source.emit(event);
    await vi.waitFor(() => expect(host.toast.show).toHaveBeenCalledOnce());

    focused = false;
    source.emit({ ...event, id: `${"d".repeat(64)}:${3}` });
    await vi.waitFor(() => expect(host.attention.notify).toHaveBeenCalledOnce());
    expect(host.toast.show).toHaveBeenCalledOnce();
    window.stop();
  });

  it("aborts the stream on host loss and reopens only on a later connected signal", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
    });
    window.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));

    window.setConnected(false);
    await vi.waitFor(() => expect(source.activeStreams).toBe(0));
    expect(source.subscriptions).toBe(1);

    window.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));
    expect(source.subscriptions).toBe(2);

    source.emit(event);
    await vi.waitFor(() => expect(host.toast.show).toHaveBeenCalledOnce());
    window.stop();
  });

  it("does not invent its own retry when a stream ends while the host stays connected", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
    });
    window.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));

    source.endAll();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.subscriptions).toBe(1);
    expect(source.activeStreams).toBe(0);

    // The host lifecycle is the only recovery signal.
    window.setConnected(false);
    window.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));
    expect(source.subscriptions).toBe(2);
    window.stop();
  });

  it("cleans up only its own window and never delivers afterwards", async () => {
    const source = createWindowEventSource();
    const first = createHost();
    const second = createHost();
    const firstWindow = startWindow({
      events: source.events,
      host: first.host,
      focused: () => true,
    });
    const secondWindow = startWindow({
      events: source.events,
      host: second.host,
      focused: () => true,
    });
    firstWindow.setConnected(true);
    secondWindow.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(2));

    firstWindow.stop();
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));

    source.emit(event);
    await vi.waitFor(() => expect(second.toast.show).toHaveBeenCalledOnce());
    expect(first.toast.show).not.toHaveBeenCalled();

    firstWindow.setConnected(false);
    firstWindow.setConnected(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.subscriptions).toBe(2);
    secondWindow.stop();
  });

  it("stops when the window lifetime signal aborts", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const lifetime = new AbortController();
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
      signal: lifetime.signal,
    });
    window.setConnected(true);
    await vi.waitFor(() => expect(source.activeStreams).toBe(1));

    lifetime.abort();
    await vi.waitFor(() => expect(source.activeStreams).toBe(0));

    window.setConnected(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(source.activeStreams).toBe(0);
    source.emit(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.toast.show).not.toHaveBeenCalled();
  });

  it("honours the document focus fallback", () => {
    vi.stubGlobal("document", { hasFocus: () => false });
    expect(windowHasFocus()).toBe(false);
    vi.stubGlobal("document", { hasFocus: () => true });
    expect(windowHasFocus()).toBe(true);
    vi.stubGlobal("document", undefined);
    expect(windowHasFocus()).toBe(false);
  });

  it("wires the subscription from Plugin.setup, not from a panel", () => {
    const source = readFileSync(path.join(repoRoot, "src/native/gui.tsx"), "utf8");
    expect(source).toContain("startQuotaNotificationSubscription");
    expect(source).toContain("createGuiRpcCaller(ctx)");
    expect(source).toContain("events: rpc.events");
    expect(source).toContain("host: ctx");
    expect(source).toContain("focused: windowHasFocus");
    expect(source).toContain("setConnected(");
    expect(source).toContain("onCleanup(quotaNotifications.stop)");
    expect(source).toContain("ctx.signal");
    expect(source).not.toContain("notificationInterest");
    expect(source).not.toContain("addRecipient");
    expect(source).not.toContain("claimNotification");
  });
});
