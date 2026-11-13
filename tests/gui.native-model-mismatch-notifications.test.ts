import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshot } from "../src/contracts/dashboard.js";
import type { NativeCacheObserverModelMismatchTransition } from "../src/native/cache-observer-runtime.js";
import {
  createModelChangeToastSetting,
  type ModelChangeToastSettingsSource,
  type ModelMismatchNotificationSource,
  startModelMismatchNotificationSubscription,
} from "../src/native/model-mismatch-notifications.js";

type TestConnectionState = "connecting" | "live" | "reconnecting" | "closed";
type SettingsSourceWithConnection = ModelChangeToastSettingsSource & {
  connection: () => TestConnectionState;
  onConnectionChange: (listener: (state: TestConnectionState) => void) => () => void;
};

function createHost() {
  return {
    toast: { show: vi.fn() },
    attention: { notify: vi.fn(async () => ({ ok: true, notification: true, sound: false })) },
  };
}

function createSource() {
  let listener: ((transition: NativeCacheObserverModelMismatchTransition) => void) | undefined;
  const source: ModelMismatchNotificationSource = {
    subscribeModelMismatchTransitions: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    source,
    emit: (transition: NativeCacheObserverModelMismatchTransition) => listener?.(transition),
  };
}

function createSettingsSource() {
  let enabled = true;
  let settingsListener: (() => void) | undefined;
  let reconnectListener: (() => void) | undefined;
  let connectionListener: ((state: TestConnectionState) => void) | undefined;
  let connection: TestConnectionState = "connecting";
  const source: SettingsSourceWithConnection = {
    settings: vi.fn(
      async () =>
        ({
          values: { nativeQuotaNotifications: { modelChangeToastEnabled: enabled } },
        }) as unknown as SettingsSnapshot,
    ),
    subscribeSettingsChanged: (listener) => {
      settingsListener = listener;
      return () => {
        settingsListener = undefined;
      };
    },
    onReconnect: (listener) => {
      reconnectListener = listener;
      return () => {
        reconnectListener = undefined;
      };
    },
    connection: () => connection,
    onConnectionChange: (listener) => {
      connectionListener = listener;
      return () => {
        connectionListener = undefined;
      };
    },
  };
  return {
    source,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    emitSettingsChanged: () => settingsListener?.(),
    emitReconnect: () => reconnectListener?.(),
    emitConnection: (next: TestConnectionState) => {
      connection = next;
      connectionListener?.(next);
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function settingsSnapshot(modelChangeToastEnabled: boolean): SettingsSnapshot {
  return {
    values: { nativeQuotaNotifications: { modelChangeToastEnabled } },
  } as unknown as SettingsSnapshot;
}

const transition: NativeCacheObserverModelMismatchTransition = {
  id: "model-mismatch:event-one",
  sessionId: "ses_main",
  atMs: 123,
  previous: {
    status: "matched",
    selectedModel: { providerID: "anthropic", id: "claude-cache" },
    cacheRoute: { providerID: "anthropic", id: "claude-cache" },
  },
  current: {
    status: "mismatched",
    selectedModel: { providerID: "openai", id: "gpt-next" },
    cacheRoute: { providerID: "anthropic", id: "claude-cache" },
  },
};

describe("native model mismatch notifications", () => {
  it("refreshes settings when the first Native transport becomes live", async () => {
    const { source, setEnabled, emitConnection } = createSettingsSource();
    const setting = createModelChangeToastSetting(source);

    await settle();
    expect(setting.enabled()).toBe(true);
    expect(source.settings).toHaveBeenCalledOnce();

    // A save made before the first session had no active event stream to deliver
    // settings.changed; the first successful transport activation must refetch.
    setEnabled(false);
    emitConnection("live");
    await settle();

    expect(source.settings).toHaveBeenCalledTimes(2);
    expect(setting.enabled()).toBe(false);
    setting.stop();
  });

  it("suppresses focused toasts while an initial persisted false setting is pending", async () => {
    const base = createSettingsSource();
    const pending = deferred<SettingsSnapshot>();
    const source = { ...base.source, settings: vi.fn(() => pending.promise) };
    const setting = createModelChangeToastSetting(source);
    const { source: mismatchSource, emit } = createSource();
    const host = createHost();
    const stop = startModelMismatchNotificationSubscription({
      source: mismatchSource,
      currentSession: () => ({ id: "ses_main", builtin: true }),
      host,
      focused: () => true,
      modelChangeToastEnabled: setting.enabled,
    });

    emit(transition);
    expect(host.toast.show).not.toHaveBeenCalled();

    pending.resolve(settingsSnapshot(false));
    await settle();
    expect(setting.enabled()).toBe(false);
    emit({ ...transition, id: "model-mismatch:after-settings", atMs: 124 });
    expect(host.toast.show).not.toHaveBeenCalled();

    stop();
    setting.stop();
  });

  it("ignores an older settings snapshot when a reconnect read resolves first", async () => {
    const base = createSettingsSource();
    const older = deferred<SettingsSnapshot>();
    const reconnect = deferred<SettingsSnapshot>();
    const settings = vi
      .fn<() => Promise<SettingsSnapshot>>()
      .mockResolvedValueOnce(settingsSnapshot(true))
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(reconnect.promise)
      .mockRejectedValueOnce(new Error("settings unavailable after reconnect"));
    const source = { ...base.source, settings };
    const setting = createModelChangeToastSetting(source);

    await settle();
    base.emitSettingsChanged();
    base.emitReconnect();
    expect(setting.enabled()).toBe(false);

    reconnect.resolve(settingsSnapshot(false));
    await settle();
    expect(setting.enabled()).toBe(false);

    older.resolve(settingsSnapshot(true));
    await settle();
    expect(setting.enabled()).toBe(false);

    base.emitReconnect();
    expect(setting.enabled()).toBe(false);
    await settle();
    expect(setting.enabled()).toBe(false);
    setting.stop();
  });

  it("falls back to the default preference when the initial settings read fails", async () => {
    const base = createSettingsSource();
    const pending = deferred<SettingsSnapshot>();
    const source = { ...base.source, settings: vi.fn(() => pending.promise) };
    const setting = createModelChangeToastSetting(source);

    expect(setting.enabled()).toBe(false);
    pending.reject(new Error("settings unavailable"));
    await settle();
    expect(setting.enabled()).toBe(true);
    setting.stop();
  });

  it("tracks saved settings snapshots and refreshes after reconnects", async () => {
    const { source, setEnabled, emitSettingsChanged, emitReconnect } = createSettingsSource();
    const setting = createModelChangeToastSetting(source);

    expect(setting.enabled()).toBe(false);
    await settle();
    expect(setting.enabled()).toBe(true);

    setEnabled(false);
    emitSettingsChanged();
    await settle();
    expect(setting.enabled()).toBe(false);

    setEnabled(true);
    emitReconnect();
    await settle();
    expect(setting.enabled()).toBe(true);
    expect(source.settings).toHaveBeenCalledTimes(3);

    setting.stop();
    setEnabled(false);
    emitSettingsChanged();
    emitReconnect();
    await settle();
    expect(source.settings).toHaveBeenCalledTimes(3);
    expect(setting.enabled()).toBe(true);
  });

  it("shows a focused toast only for the currently selected builtin session", () => {
    const { source, emit } = createSource();
    const host = createHost();
    let current: { id: string; builtin: boolean } | undefined = {
      id: "ses_child",
      builtin: true,
    };
    const stop = startModelMismatchNotificationSubscription({
      source,
      currentSession: () => current,
      host,
      focused: () => true,
    });

    emit({ ...transition, sessionId: "ses_main" });
    expect(host.toast.show).not.toHaveBeenCalled();
    expect(host.attention.notify).not.toHaveBeenCalled();

    current = { id: "ses_main", builtin: true };
    emit(transition);
    emit(transition);
    expect(host.toast.show).toHaveBeenCalledTimes(1);
    expect(host.toast.show).toHaveBeenCalledWith({
      title: "Selected model changed",
      description:
        "The selected model differs from the route of the last cache observation. The existing estimate is preserved until new cache activity is observed.",
      variant: "default",
    });
    expect(host.attention.notify).not.toHaveBeenCalled();

    emit({
      ...transition,
      id: "model-mismatch:return",
      atMs: 124,
      previous: transition.current,
      current: {
        status: "matched",
        selectedModel: { providerID: "anthropic", id: "claude-cache" },
        cacheRoute: { providerID: "anthropic", id: "claude-cache" },
      },
    });
    expect(host.toast.show).toHaveBeenCalledTimes(1);

    current = { id: "ses_main", builtin: false };
    emit({ ...transition, id: "model-mismatch:other-server", atMs: 125 });
    expect(host.toast.show).toHaveBeenCalledTimes(1);
    stop();
  });

  it("uses permission-aware background notifications without exposing model identifiers", () => {
    const { source, emit } = createSource();
    const host = createHost();
    const stop = startModelMismatchNotificationSubscription({
      source,
      currentSession: () => ({ id: "ses_main", builtin: true }),
      host,
      focused: () => false,
    });

    emit(transition);
    expect(host.toast.show).not.toHaveBeenCalled();
    expect(host.attention.notify).toHaveBeenCalledWith({
      id: expect.any(String),
      title: "Selected model changed",
      message:
        "The selected model differs from the route of the last cache observation. The existing estimate is preserved until new cache activity is observed.",
      variant: "default",
    });
    const notification = host.attention.notify.mock.calls[0]?.[0];
    expect(JSON.stringify(notification)).not.toContain("gpt-next");
    expect(JSON.stringify(notification)).not.toContain("claude-cache");

    stop();
    emit({ ...transition, atMs: 124 });
    expect(host.attention.notify).toHaveBeenCalledTimes(1);
  });

  it("lets the focused toast toggle change without disabling transition delivery or background notifications", () => {
    const { source, emit } = createSource();
    const host = createHost();
    let modelChangeToastEnabled = false;
    const stop = startModelMismatchNotificationSubscription({
      source,
      currentSession: () => ({ id: "ses_main", builtin: true }),
      host,
      focused: () => true,
      modelChangeToastEnabled: () => modelChangeToastEnabled,
    });

    emit(transition);
    expect(host.toast.show).not.toHaveBeenCalled();
    expect(host.attention.notify).not.toHaveBeenCalled();

    modelChangeToastEnabled = true;
    emit(transition);
    expect(host.toast.show).not.toHaveBeenCalled();
    emit({ ...transition, id: "model-mismatch:event-two", atMs: 124 });
    expect(host.toast.show).toHaveBeenCalledTimes(1);

    modelChangeToastEnabled = false;
    emit({ ...transition, id: "model-mismatch:event-three", atMs: 125 });
    expect(host.toast.show).toHaveBeenCalledTimes(1);

    stop();

    const background = createHost();
    const stopBackground = startModelMismatchNotificationSubscription({
      source,
      currentSession: () => ({ id: "ses_main", builtin: true }),
      host: background,
      focused: () => false,
      modelChangeToastEnabled: () => false,
    });
    emit({ ...transition, id: "model-mismatch:event-four", atMs: 126 });
    expect(background.toast.show).not.toHaveBeenCalled();
    expect(background.attention.notify).toHaveBeenCalledTimes(1);
    stopBackground();
  });
});
