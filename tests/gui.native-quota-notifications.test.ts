/**
 * Per-window native quota notification delivery.
 *
 * `Plugin.setup` runs once per window, so the subscription is started there and
 * keeps working while the panel and settings page are closed. A window presents
 * only the final safe event: a focused window gets a toast, an unfocused one a
 * system notification, and both receive the same deterministic id. There is no
 * held RPC, timer, heartbeat or retry loop; a healthy stream failure gets a
 * bounded recovery, while failed health waits for the host connectivity signal.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardHealth } from "../src/contracts/dashboard.js";
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
  fail(error: unknown): void;
  signal?: AbortSignal;
}

function createWindowEventSource(options: { ignoreAbort?: boolean } = {}) {
  const ignoreAbort = options.ignoreAbort === true;
  const streams = new Set<ManualStream<DashboardRpcQuotaNotificationData>>();
  let subscriptions = 0;
  let maxActiveStreams = 0;
  const events: DashboardRpcCaller["events"] = {
    subscribe(name, options) {
      if (name !== "quotaNotification") throw new Error(`unexpected event ${name}`);
      subscriptions += 1;
      const signal = options?.signal;
      const queue: DashboardRpcQuotaNotificationData[] = [];
      let wake: (() => void) | undefined;
      let ended = false;
      let failure: unknown;
      let failed = false;
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
        fail(error) {
          failed = true;
          failure = error;
          wake?.();
          wake = undefined;
        },
      };
      streams.add(stream);
      maxActiveStreams = Math.max(maxActiveStreams, streams.size);
      if (!ignoreAbort) {
        signal?.addEventListener(
          "abort",
          () => {
            streams.delete(stream);
            stream.end();
          },
          { once: true },
        );
      }

      return {
        async *[Symbol.asyncIterator]() {
          while (true) {
            if (failed) throw failure;
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
    failAll(error: unknown) {
      for (const stream of [...streams]) {
        streams.delete(stream);
        stream.fail(error);
      }
    },
    get subscriptions() {
      return subscriptions;
    },
    get activeStreams() {
      return streams.size;
    },
    get maxActiveStreams() {
      return maxActiveStreams;
    },
  };
}

function createHost() {
  let resolveToast: () => void = () => {};
  let resolveNotification: () => void = () => {};
  const toastShown = new Promise<void>((resolve) => {
    resolveToast = resolve;
  });
  const notificationShown = new Promise<void>((resolve) => {
    resolveNotification = resolve;
  });
  const toast = {
    show: vi.fn(() => {
      resolveToast();
      return { dismiss: () => undefined };
    }),
  };
  const attention = {
    notify: vi.fn(async () => {
      resolveNotification();
      return { notification: true, sound: false };
    }),
  };
  return { host: { toast, attention }, toast, attention, toastShown, notificationShown };
}

const HEALTH: DashboardHealth = { app: "opencode-quota-gui", contractVersion: 2 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function startWindow(options: {
  events: DashboardRpcCaller["events"];
  host: ReturnType<typeof createHost>["host"];
  focused: () => boolean;
  health?: DashboardRpcCaller["health"];
  signal?: AbortSignal;
}): QuotaNotificationSubscription {
  const health: DashboardRpcCaller["health"] = options.health ?? (async () => HEALTH);
  return startQuotaNotificationSubscription({ ...options, health });
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

  it.each([
    "end",
    "throw",
  ] as const)("probes health and replaces a connected stream after it %s", async (failureMode) => {
    const source = createWindowEventSource();
    const host = createHost();
    const health = vi.fn<DashboardRpcCaller["health"]>(async () => HEALTH);
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
      health,
    });
    window.setConnected(true);
    expect(source.subscriptions).toBe(1);

    if (failureMode === "end") source.endAll();
    else source.failAll(new Error("notification stream failed"));

    await flushMicrotasks();
    expect(health).toHaveBeenCalledOnce();
    await flushMicrotasks();
    expect(source.subscriptions).toBe(2);
    expect(source.activeStreams).toBe(1);

    source.emit(event);
    await host.toastShown;
    expect(host.toast.show).toHaveBeenCalledOnce();
    window.stop();
  });

  it("waits for a false-to-true connectivity transition after a failed health probe", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const health = vi.fn<DashboardRpcCaller["health"]>(async () => {
      throw new Error("host is still unavailable");
    });
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
      health,
    });
    window.setConnected(true);
    expect(source.subscriptions).toBe(1);

    source.endAll();
    await flushMicrotasks();
    expect(health).toHaveBeenCalledOnce();
    expect(source.subscriptions).toBe(1);
    expect(source.activeStreams).toBe(0);

    // Repeating the same connected signal is not another retry opportunity.
    window.setConnected(true);
    await flushMicrotasks();
    expect(source.subscriptions).toBe(1);

    window.setConnected(false);
    window.setConnected(true);
    await flushMicrotasks();
    expect(source.subscriptions).toBe(2);
    expect(source.activeStreams).toBe(1);
    window.stop();
  });

  it("bounds immediate recovery and resets the budget only after delivery or reconnect", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const health = vi.fn<DashboardRpcCaller["health"]>(async () => HEALTH);
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
      health,
    });
    window.setConnected(true);
    expect(source.subscriptions).toBe(1);

    source.endAll();
    await flushMicrotasks();
    expect(source.subscriptions).toBe(2);
    source.emit(event);
    await host.toastShown;
    source.endAll();
    await flushMicrotasks();
    expect(source.subscriptions).toBe(3);

    // This replacement has not delivered anything. Its failure exhausts the
    // recovery budget rather than creating an immediate retry loop.
    source.endAll();
    await flushMicrotasks();
    expect(health).toHaveBeenCalledTimes(2);
    expect(source.subscriptions).toBe(3);
    expect(source.activeStreams).toBe(0);

    window.setConnected(false);
    window.setConnected(true);
    expect(source.subscriptions).toBe(4);
    expect(source.subscriptions).toBe(4);
    expect(source.activeStreams).toBe(1);
    window.stop();
  });

  it("does not resubscribe when disposed while a health probe is pending", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const probe = deferred<DashboardHealth>();
    const probeStarted = deferred<AbortSignal | undefined>();
    const health = vi.fn<DashboardRpcCaller["health"]>((_input, options) => {
      probeStarted.resolve(options?.signal);
      return probe.promise;
    });
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
      health,
    });
    window.setConnected(true);
    expect(source.subscriptions).toBe(1);
    source.endAll();
    await flushMicrotasks();
    expect(health).toHaveBeenCalledOnce();
    const probeSignal = await probeStarted.promise;

    window.stop();
    expect(probeSignal?.aborted).toBe(true);
    probe.resolve(HEALTH);
    await flushMicrotasks();

    expect(source.subscriptions).toBe(1);
    expect(source.activeStreams).toBe(0);
    expect(host.toast.show).not.toHaveBeenCalled();
  });

  it("fences a pending probe across disconnect and reconnect", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const probe = deferred<DashboardHealth>();
    const probeStarted = deferred<AbortSignal | undefined>();
    const health = vi.fn<DashboardRpcCaller["health"]>((_input, options) => {
      probeStarted.resolve(options?.signal);
      return probe.promise;
    });
    const window = startWindow({
      events: source.events,
      host: host.host,
      focused: () => true,
      health,
    });
    window.setConnected(true);
    expect(source.subscriptions).toBe(1);
    source.endAll();
    await flushMicrotasks();
    expect(health).toHaveBeenCalledOnce();
    const probeSignal = await probeStarted.promise;

    window.setConnected(false);
    expect(probeSignal?.aborted).toBe(true);
    window.setConnected(true);
    expect(source.subscriptions).toBe(2);
    probe.resolve(HEALTH);
    await flushMicrotasks();

    expect(source.subscriptions).toBe(2);
    expect(source.activeStreams).toBe(1);
    source.emit(event);
    await host.toastShown;
    expect(host.toast.show).toHaveBeenCalledOnce();
    window.stop();
  });

  it("drops a queued yield from a disconnected stream after reconnecting", async () => {
    const source = createWindowEventSource();
    const host = createHost();
    const window = startWindow({ events: source.events, host: host.host, focused: () => true });
    window.setConnected(true);
    expect(source.subscriptions).toBe(1);

    source.emit(event);
    window.setConnected(false);
    window.setConnected(true);
    await flushMicrotasks();
    expect(source.subscriptions).toBe(2);
    expect(host.toast.show).not.toHaveBeenCalled();

    source.emit(event);
    await host.toastShown;
    expect(host.toast.show).toHaveBeenCalledOnce();
    window.stop();
  });

  it("waits for an abort-ignoring iterator to unwind before opening a replacement", async () => {
    const source = createWindowEventSource({ ignoreAbort: true });
    const host = createHost();
    const window = startWindow({ events: source.events, host: host.host, focused: () => true });
    window.setConnected(true);
    expect(source.activeStreams).toBe(1);

    window.setConnected(false);
    expect(source.activeStreams).toBe(1);
    window.setConnected(true);

    // Reconnect must not overlap the old iterator, even though it ignored abort.
    expect(source.subscriptions).toBe(1);
    expect(source.activeStreams).toBe(1);
    expect(source.maxActiveStreams).toBe(1);

    source.endAll();
    await flushMicrotasks();
    expect(source.subscriptions).toBe(2);
    expect(source.activeStreams).toBe(1);
    expect(source.maxActiveStreams).toBe(1);

    window.stop();
    source.endAll();
    await flushMicrotasks();
    expect(source.activeStreams).toBe(0);
  });

  it("recovers one window without replacing another window's stream", async () => {
    const firstSource = createWindowEventSource();
    const secondSource = createWindowEventSource();
    const firstHost = createHost();
    const secondHost = createHost();
    const firstHealth = vi.fn<DashboardRpcCaller["health"]>(async () => HEALTH);
    const secondHealth = vi.fn<DashboardRpcCaller["health"]>(async () => HEALTH);
    const firstWindow = startWindow({
      events: firstSource.events,
      host: firstHost.host,
      focused: () => true,
      health: firstHealth,
    });
    const secondWindow = startWindow({
      events: secondSource.events,
      host: secondHost.host,
      focused: () => true,
      health: secondHealth,
    });
    firstWindow.setConnected(true);
    secondWindow.setConnected(true);
    expect(firstSource.subscriptions).toBe(1);
    expect(secondSource.subscriptions).toBe(1);

    firstSource.failAll(new Error("first window stream failed"));
    await flushMicrotasks();
    expect(firstHealth).toHaveBeenCalledOnce();
    await flushMicrotasks();
    expect(firstSource.subscriptions).toBe(2);
    expect(firstSource.activeStreams).toBe(1);
    expect(secondSource.activeStreams).toBe(1);
    expect(firstHealth).toHaveBeenCalledOnce();
    expect(secondHealth).not.toHaveBeenCalled();

    firstSource.emit(event);
    await firstHost.toastShown;
    expect(firstHost.toast.show).toHaveBeenCalledOnce();
    expect(secondHost.toast.show).not.toHaveBeenCalled();

    firstWindow.stop();
    expect(secondSource.activeStreams).toBe(1);
    secondSource.emit({
      ...event,
      id: `${"c".repeat(64)}:${Date.parse("2026-11-02T12:02:00.000Z")}`,
    });
    await secondHost.toastShown;
    expect(secondHost.toast.show).toHaveBeenCalledOnce();
    secondWindow.stop();
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
    expect(source).toContain("health: rpc.health");
    expect(source).toContain("host: ctx");
    expect(source).toContain("focused: windowHasFocus");
    expect(source).toContain("setConnected(");
    expect(source).toContain("onCleanup(quotaNotifications.stop)");
    expect(source).toContain("ctx.signal");
    expect(source).not.toContain("notificationInterest");
    expect(source).not.toContain("addRecipient");
    expect(source).not.toContain("claimNotification");
  });

  it("uses the RPC health method supplied by Plugin.setup after a stream failure", async () => {
    const source = createWindowEventSource();
    const health = vi.fn<DashboardRpcCaller["health"]>(async () => HEALTH);
    const controller = new AbortController();
    const cleanups: Array<() => void> = [];
    const ctx = {
      id: "test-plugin",
      signal: controller.signal,
      client: {},
      ui: {},
      layout: { settings: vi.fn() },
      sessions: { current: () => undefined, list: () => [] },
      servers: {
        list: () => ["builtin"],
        get: () => ({ builtin: true, connected: true }),
      },
      add: vi.fn(),
    };

    vi.resetModules();
    vi.doMock("@opencode/plugin/gui", () => ({
      Plugin: { define: (definition: unknown) => definition },
      Command: Symbol("Command"),
      MenuItem: Symbol("MenuItem"),
      Panel: Symbol("Panel"),
      SettingsPage: Symbol("SettingsPage"),
      Slot: Symbol("Slot"),
      Style: Symbol("Style"),
      usePanel: vi.fn(),
      usePlugin: vi.fn(),
    }));
    vi.doMock("solid-js", () => ({
      createEffect: (effect: () => void) => effect(),
      onCleanup: (cleanup: () => void) => cleanups.push(cleanup),
    }));
    vi.doMock("../src/native/rpc.js", () => ({
      createGuiRpcCaller: vi.fn(() => ({ health, events: source.events })),
    }));
    vi.doMock("../src/native/dashboard-client.js", () => ({
      createNativeDashboardClient: vi.fn(),
    }));
    vi.doMock("../src/native/panel.js", () => ({ DashboardPanel: () => null }));
    vi.doMock("../src/native/panel-open.js", () => ({ revealDashboardPanel: vi.fn() }));
    vi.doMock("../src/native/session-header.js", () => ({ NativeSessionHeader: () => null }));
    vi.doMock("../src/native/settings-page.js", () => ({
      NativeSettingsPage: () => null,
      SETTINGS_PAGE_ID: "quota-settings",
    }));
    vi.doMock("../src/native/ui.js", () => ({ NativeUiProvider: (props: unknown) => props }));

    try {
      const module = await import("../src/native/gui.js");
      const plugin = module.default as unknown as {
        setup(context: typeof ctx): void;
      };
      plugin.setup(ctx);
      expect(source.activeStreams).toBe(1);
      source.endAll();
      await vi.waitFor(() => expect(health).toHaveBeenCalledOnce());
      for (const cleanup of cleanups.reverse()) cleanup();
      controller.abort();
      source.endAll();
    } finally {
      vi.doUnmock("@opencode/plugin/gui");
      vi.doUnmock("solid-js");
      vi.doUnmock("../src/native/rpc.js");
      vi.doUnmock("../src/native/dashboard-client.js");
      vi.doUnmock("../src/native/panel.js");
      vi.doUnmock("../src/native/panel-open.js");
      vi.doUnmock("../src/native/session-header.js");
      vi.doUnmock("../src/native/settings-page.js");
      vi.doUnmock("../src/native/ui.js");
      vi.resetModules();
    }
  });
});
