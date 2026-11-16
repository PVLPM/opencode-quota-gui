import { createRoot } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokens: {
    Command: Symbol("Command"),
    ComposerPill: Symbol("ComposerPill"),
    MenuItem: Symbol("MenuItem"),
    Panel: Symbol("Panel"),
    SettingsPage: Symbol("SettingsPage"),
    Slot: Symbol("Slot"),
    Style: Symbol("Style"),
  },
  createCacheComposerPill: vi.fn((..._args: unknown[]) => ({})),
  dashboardPanel: vi.fn((_props: unknown) => null),
  usePlugin: vi.fn(),
  usePanel: vi.fn(),
  createGuiRpcCaller: vi.fn(() => ({ events: { subscribe: vi.fn() }, health: vi.fn() })),
  createNativeDashboardRuntime: vi.fn(() => {
    let location = { route: { name: "home" }, range: "30d" };
    const connectionListeners = new Set<
      (state: "connecting" | "live" | "reconnecting" | "closed") => void
    >();
    const settingsChangedListeners = new Set<() => void>();
    const reconnectListeners = new Set<() => void>();
    return {
      client: {
        settings: vi.fn(async () => ({
          values: { nativeQuotaNotifications: { modelChangeToastEnabled: true } },
        })),
        connection: vi.fn(() => "connecting"),
        onConnectionChange: vi.fn(
          (listener: (state: "connecting" | "live" | "reconnecting" | "closed") => void) => {
            connectionListeners.add(listener);
            return () => connectionListeners.delete(listener);
          },
        ),
        subscribeSettingsChanged: vi.fn((listener: () => void) => {
          settingsChangedListeners.add(listener);
          return () => settingsChangedListeners.delete(listener);
        }),
        onReconnect: vi.fn((listener: () => void) => {
          reconnectListeners.add(listener);
          return () => reconnectListeners.delete(listener);
        }),
      },
      cacheObserver: { subscribeModelMismatchTransitions: vi.fn(() => () => {}) },
      retain: vi.fn(),
      location: () => location,
      setLocation: vi.fn((next) => {
        location = next;
      }),
    };
  }),
  startQuotaNotificationSubscription: vi.fn(() => ({ setConnected: vi.fn(), stop: vi.fn() })),
  windowHasFocus: vi.fn(),
}));

vi.mock("@opencode/plugin/gui", () => ({
  ...mocks.tokens,
  Plugin: { define: (plugin: unknown) => plugin },
  usePanel: mocks.usePanel,
  usePlugin: mocks.usePlugin,
}));
vi.mock("../src/native/cache-composer-pill.js", () => ({
  createCacheComposerPill: mocks.createCacheComposerPill,
}));
vi.mock("../src/native/panel.js", () => ({ DashboardPanel: mocks.dashboardPanel }));
vi.mock("../src/native/panel-open.js", async (importOriginal) => importOriginal());
vi.mock("../src/native/quota-notifications.js", () => ({
  startQuotaNotificationSubscription: mocks.startQuotaNotificationSubscription,
  windowHasFocus: mocks.windowHasFocus,
}));
vi.mock("../src/native/rpc.js", () => ({ createGuiRpcCaller: mocks.createGuiRpcCaller }));
vi.mock("../src/native/runtime.js", () => ({
  createNativeDashboardRuntime: mocks.createNativeDashboardRuntime,
}));
vi.mock("../src/native/session-header.js", () => ({ NativeSessionHeader: () => null }));
vi.mock("../src/native/settings-page.js", () => ({
  NativeSettingsPage: () => null,
  SETTINGS_PAGE_ID: "quota-settings",
}));
vi.mock("../src/native/ui.js", () => ({
  NativeUiProvider: (props: { children: unknown }) => props.children,
}));

import nativeGui from "../src/native/gui.tsx";

afterEach(() => {
  vi.clearAllMocks();
});

describe("Native GUI setup version compatibility", () => {
  it.each([
    ["2.2.0", false],
    ["2.2.1", true],
    ["2.2.5", true],
    [undefined, false],
    ["", false],
    ["garbage", false],
  ] as const)("registers contributions for host version %j: %s", (version, supported) => {
    const add = vi.fn();
    const ctx = {
      add,
      client: {},
      servers: { list: () => [], get: () => undefined },
      sessions: { current: () => undefined, list: () => [] },
      signal: new AbortController().signal,
      ...(version === undefined ? {} : { app: { version } }),
    };

    const dispose = createRoot((end) => {
      nativeGui.setup(ctx as never);
      return end;
    });
    dispose();

    expect(add).toHaveBeenCalledTimes(supported ? 9 : 0);
    expect(mocks.createNativeDashboardRuntime).toHaveBeenCalledTimes(supported ? 1 : 0);
  });

  it.each([
    "closed",
    "open",
    "visible",
  ] as const)("routes the dashboard and reveals a %s panel without switching native sessions", (state) => {
    const session = { id: "main", key: "server\nmain" };
    const layout = { state: vi.fn(() => state), open: vi.fn() };
    const ctx = {
      id: "quota",
      add: vi.fn((..._args: unknown[]) => {}),
      app: { version: "2.2.1" },
      client: {},
      layout,
      servers: { list: () => [], get: () => undefined },
      sessions: { current: () => session, list: () => [], open: vi.fn() },
      signal: new AbortController().signal,
    };
    const dispose = createRoot((end) => {
      nativeGui.setup(ctx as never);
      return end;
    });
    const callback = mocks.createCacheComposerPill.mock.calls.at(-1)?.[3] as unknown as (
      session: unknown,
      id: string,
    ) => void;
    const runtime = mocks.createNativeDashboardRuntime.mock.results.at(-1)!.value;
    mocks.usePlugin.mockReturnValue(ctx);
    mocks.usePanel.mockReturnValue({ visible: () => true });
    const panel = ctx.add.mock.calls.find(([token]) => token === mocks.tokens.Panel)?.[1] as {
      render: () => unknown;
    };
    const container = document.createElement("div");
    const unmount = render(() => panel.render() as never, container);
    const props = mocks.dashboardPanel.mock.calls.at(-1)?.[0] as {
      externalLocation: () => unknown;
      onLocationChange: (next: unknown) => void;
    };
    callback(session, "child / id");
    expect(runtime.location()).toEqual({
      route: { name: "session", sessionId: "child / id" },
      range: "30d",
    });
    expect(props.externalLocation()).toEqual(runtime.location());
    expect(layout.open).toHaveBeenCalledTimes(state === "visible" ? 0 : 1);
    if (state !== "visible") expect(layout.open).toHaveBeenCalledWith("quota:dashboard", session);
    expect(ctx.sessions.open).not.toHaveBeenCalled();
    unmount();
    dispose();
  });
});
