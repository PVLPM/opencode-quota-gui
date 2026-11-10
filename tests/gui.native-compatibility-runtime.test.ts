import { createRoot } from "solid-js";
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
  createCacheComposerPill: vi.fn(() => ({})),
  createGuiRpcCaller: vi.fn(() => ({ events: { subscribe: vi.fn() }, health: vi.fn() })),
  createNativeDashboardRuntime: vi.fn(() => ({
    cacheObserver: { subscribeModelMismatchTransitions: vi.fn(() => () => {}) },
    retain: vi.fn(),
  })),
  startQuotaNotificationSubscription: vi.fn(() => ({ setConnected: vi.fn(), stop: vi.fn() })),
  windowHasFocus: vi.fn(),
}));

vi.mock("@opencode/plugin/gui", () => ({
  ...mocks.tokens,
  Plugin: { define: (plugin: unknown) => plugin },
  usePanel: vi.fn(),
  usePlugin: vi.fn(),
}));
vi.mock("../src/native/cache-composer-pill.js", () => ({
  createCacheComposerPill: mocks.createCacheComposerPill,
}));
vi.mock("../src/native/panel.js", () => ({ DashboardPanel: () => null }));
vi.mock("../src/native/panel-open.js", () => ({ revealDashboardPanel: vi.fn() }));
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
vi.mock("../src/native/ui.js", () => ({ NativeUiProvider: () => null }));

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
});
