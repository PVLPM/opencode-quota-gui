import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the plugin's runtime dirs synthetic: the dashboard setup reads the global
// config dir, and no test may touch the user's real config or state.
const TEST_RUNTIME_ROOT = vi.hoisted(() => "/tmp/opencode-quota-plugin-v2-tests");
const cacheEventEmit = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

// The credential lifecycle needs no real dashboard listener; gui-only tests cover startup.
vi.mock("../src/gui/lifecycle.js", () => ({
  startDashboard: vi.fn(async () => ({ dispose: async () => {} })),
}));
vi.mock("../src/gui/rpc.js", () => ({
  registerDashboardRpc: vi.fn(async () => ({
    events: { emit: cacheEventEmit },
    dispose: async () => {},
  })),
}));

import { startDashboard } from "../src/gui/lifecycle.js";
import { registerDashboardRpc } from "../src/gui/rpc.js";
import {
  clearReadAuthFileCacheForTests,
  getCredentialSourceDiagnostics,
  readAuthFile,
  readAuthFileCached,
} from "../src/lib/opencode-auth.js";
import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";
import plugin from "../src/plugin.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

function createContext() {
  return {
    location: { directory: "/tmp/opencode/quota-plugin-v2" },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
    session: {
      hook: vi.fn(async () => ({ dispose: async () => {} })),
    },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
}

function createHostEventQueue() {
  let signal: AbortSignal | undefined;
  let resolvePending: ((result: IteratorResult<unknown>) => void) | undefined;
  let pullCount = 0;
  const queued: unknown[] = [];
  const subscribe = vi.fn((input: { signal: AbortSignal }) => {
    signal = input.signal;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<unknown>> {
            if (input.signal.aborted) return Promise.resolve({ done: true, value: undefined });
            pullCount += 1;
            return new Promise((resolve) => {
              const finish = (result: IteratorResult<unknown>) => {
                if (resolvePending === finish) resolvePending = undefined;
                input.signal.removeEventListener("abort", onAbort);
                resolve(result);
              };
              const onAbort = () => finish({ done: true, value: undefined });
              input.signal.addEventListener("abort", onAbort, { once: true });
              resolvePending = finish;
              const next = queued.shift();
              if (next !== undefined) finish({ done: false, value: next });
            });
          },
        };
      },
    };
  });

  return {
    subscribe,
    push(event: unknown) {
      if (resolvePending !== undefined) resolvePending({ done: false, value: event });
      else queued.push(event);
    },
    get pulls() {
      return pullCount;
    },
    get signal() {
      return signal;
    },
  };
}

/**
 * Tracks every setup so a test that never disposes still releases the plugin's
 * dashboard lease (and its real listener) before the next test runs.
 */
const cleanups: Array<() => Promise<void> | void> = [];

async function setupPlugin(context: unknown): Promise<() => Promise<void> | void> {
  const cleanup = await plugin.setup(context as never);
  const tracked = async () => {
    await cleanup?.();
  };
  cleanups.push(tracked);
  return tracked;
}

beforeEach(() => {
  clearReadAuthFileCacheForTests();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("V2 server plugin credential lifecycle", () => {
  it("reads logins through ctx.integration from setup until cleanup", async () => {
    const ctx = createContext();
    const integration = createFakeIntegration([
      {
        integrationId: "deepseek",
        id: "cred_deepseek",
        label: "default",
        registered: true,
        method: "key",
        value: { type: "key", key: "deepseek-key" },
      },
    ]);
    const subscribe = vi.fn((_options: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {},
    }));

    const cleanup = await setupPlugin({ ...ctx, integration, event: { subscribe } });
    expect(getCredentialSourceDiagnostics()).toMatchObject({
      state: "bound",
      kind: "opencode-integration-api",
    });
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toEqual({
      deepseek: { type: "api", key: "deepseek-key" },
    });
    const signal = subscribe.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await cleanup?.();
    expect(signal?.aborted).toBe(true);
    // Only this setup's binding is gone; earlier tests' empty fakes hold no deepseek login.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toBeNull();
    warn.mockRestore();
    expect(integration.connection.active).toHaveBeenCalledOnce();
  });

  it.each([
    "credential.updated",
    "credential.switched",
  ])("drops cached logins when OpenCode reports %s", async (type) => {
    const ctx = createContext();
    const deepseek = {
      integrationId: "deepseek",
      id: "cred_deepseek",
      label: "default",
      registered: true,
      method: "key" as const,
      value: { type: "key", key: "old-key" } as Record<string, unknown>,
    };
    const integration = createFakeIntegration([deepseek]);
    let emit!: (event: { type: string; data: Record<string, unknown> }) => void;
    const nextEvent = new Promise<{ type: string; data: Record<string, unknown> }>((resolve) => {
      emit = resolve;
    });
    const subscribe = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.idle", data: {} };
        yield await nextEvent;
      },
    }));
    const cleanup = await setupPlugin({ ...ctx, integration, event: { subscribe } });
    const read = () => readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek"] });

    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });
    deepseek.value = { type: "key", key: "new-key" };
    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });

    emit({ type, data: { integrationID: "deepseek", credentialID: "cred_deepseek" } });
    await vi.waitFor(async () =>
      expect(await read()).toEqual({ deepseek: { type: "api", key: "new-key" } }),
    );
    await cleanup?.();
  });

  it("logs why the host event subscription stopped, without tokens", async () => {
    const ctx = createContext();
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const subscribe = vi.fn(() => ({
      // biome-ignore lint/correctness/useYield: the stream fails before its first event
      async *[Symbol.asyncIterator]() {
        throw new Error(`event stream closed ${token}`);
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin({ ...ctx, event: { subscribe } });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[opencode-quota-gui] host event subscription stopped: event stream closed [redacted]",
      ),
    );
    await cleanup?.();
    warn.mockRestore();
  });

  it("stops the credential event subscription silently on cleanup", async () => {
    const ctx = createContext();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw new DOMException("This operation was aborted", "AbortError");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin({ ...ctx, event: { subscribe } });
    await cleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn.mock.calls.flat().join("\n")).not.toContain("credential event subscription");
    warn.mockRestore();
  });

  it("forwards minimal assistant-step cache evidence over the existing host and RPC lifecycles", async () => {
    const ctx = createContext();
    let pushHostEvent!: (event: unknown) => void;
    let signal: AbortSignal | undefined;
    const nextEvent = () =>
      new Promise<unknown>((resolve) => {
        pushHostEvent = resolve;
      });
    const subscribe = vi.fn(({ signal: nextSignal }: { signal: AbortSignal }) => {
      signal = nextSignal;
      return {
        async *[Symbol.asyncIterator]() {
          while (!nextSignal.aborted) yield await nextEvent();
        },
      };
    });
    const created = 1_700_000_000_000;
    const hostEvent = {
      type: "session.step.ended",
      id: "evt_step_1",
      created,
      data: {
        sessionID: "ses_opaque",
        assistantMessageID: "msg_opaque",
        finish: "stop",
        cost: 1.25,
        tokens: { input: 10, output: 99, reasoning: 8, cache: { read: 0, write: 4 } },
        model: { providerID: "must-not-cross", modelID: "must-not-cross" },
      },
      metadata: { prompt: "must-not-cross" },
    };
    vi.mocked(startDashboard).mockResolvedValueOnce({
      runtime: {} as never,
      dispose: async () => {},
    } as never);
    vi.mocked(registerDashboardRpc).mockClear();
    cacheEventEmit.mockClear();

    const cleanup = await setupPlugin({
      ...ctx,
      rpc: {} as never,
      event: { subscribe },
    });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(registerDashboardRpc).toHaveBeenCalledOnce();

    pushHostEvent(hostEvent);
    await vi.waitFor(() => expect(cacheEventEmit).toHaveBeenCalledTimes(2));
    expect(cacheEventEmit).toHaveBeenNthCalledWith(1, "invalidated", {
      topic: "cache.observer",
      at: created,
      cacheObserverEvent: {
        type: "source.status",
        created,
        data: { state: "observed" },
      },
    });
    expect(cacheEventEmit).toHaveBeenNthCalledWith(2, "invalidated", {
      topic: "cache.observer",
      at: created,
      cacheObserverEvent: {
        type: "session.step.ended",
        created,
        data: {
          sessionID: "ses_opaque",
          assistantMessageID: "msg_opaque",
          tokens: { input: 10, cache: { read: 0, write: 4 } },
        },
      },
    });

    await cleanup?.();
    expect(signal?.aborted).toBe(true);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("relays projected cache events received before RPC registration without retaining content", async () => {
    const ctx = createContext();
    let pushHostEvent!: (event: unknown) => void;
    let waitingForHostEvent = false;
    const nextEvent = () =>
      new Promise<unknown>((resolve) => {
        waitingForHostEvent = true;
        pushHostEvent = (event) => {
          waitingForHostEvent = false;
          resolve(event);
        };
      });
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const event = await nextEvent();
          yield event;
        }
      },
    }));
    const created = 1_700_000_000_100;
    const startedEvent = {
      type: "session.step.started",
      created,
      data: {
        sessionID: "ses_pre_registration",
        assistantMessageID: "msg_pre_registration",
        model: { providerID: "openai", id: "gpt-test" },
        started: created - 10,
      },
    };
    const hostEvent = {
      type: "session.step.ended",
      created,
      data: {
        sessionID: "ses_pre_registration",
        assistantMessageID: "msg_pre_registration",
        tokens: { input: 20, cache: { read: 10, write: 0 } },
        content: "private event content must not cross RPC",
      },
    };
    let receiveNativeEvent: ((event: never) => void) | undefined;
    const nativeObserver = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveNativeEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
    });
    const releaseNativeObserver = nativeObserver.subscribe("ses_pre_registration", vi.fn());
    let resolveRegistration!: (registration: {
      events: { emit: typeof cacheEventEmit };
      dispose: () => Promise<void>;
    }) => void;
    const registration = new Promise<{
      events: { emit: typeof cacheEventEmit };
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRegistration = resolve;
    });
    vi.mocked(startDashboard).mockResolvedValueOnce({
      runtime: {} as never,
      dispose: async () => {},
    } as never);
    vi.mocked(registerDashboardRpc).mockClear();
    vi.mocked(registerDashboardRpc).mockImplementationOnce(async () => registration as never);
    cacheEventEmit.mockClear();
    cacheEventEmit.mockImplementation(async (_name, eventData) => {
      if (eventData.topic === "cache.observer") {
        receiveNativeEvent?.(eventData.cacheObserverEvent as never);
      }
    });

    const setup = setupPlugin({ ...ctx, rpc: {} as never, event: { subscribe } });
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(waitingForHostEvent).toBe(true));
    pushHostEvent(startedEvent);
    await vi.waitFor(() => expect(waitingForHostEvent).toBe(true));
    pushHostEvent(hostEvent);
    await Promise.resolve();
    await Promise.resolve();
    expect(cacheEventEmit).not.toHaveBeenCalled();

    resolveRegistration({ events: { emit: cacheEventEmit }, dispose: async () => {} });
    const cleanup = await setup;
    await vi.waitFor(() => expect(cacheEventEmit).toHaveBeenCalledTimes(3));
    expect(cacheEventEmit).toHaveBeenNthCalledWith(1, "invalidated", {
      topic: "cache.observer",
      at: created,
      cacheObserverEvent: {
        type: "source.status",
        created,
        data: { state: "observed" },
      },
    });
    expect(cacheEventEmit).toHaveBeenNthCalledWith(2, "invalidated", {
      topic: "cache.observer",
      at: created,
      cacheObserverEvent: {
        type: "session.step.started",
        created,
        data: {
          sessionID: "ses_pre_registration",
          assistantMessageID: "msg_pre_registration",
          model: { providerID: "openai", id: "gpt-test" },
          started: created - 10,
        },
      },
    });
    expect(cacheEventEmit).toHaveBeenNthCalledWith(3, "invalidated", {
      topic: "cache.observer",
      at: created,
      cacheObserverEvent: {
        type: "session.step.ended",
        created,
        data: {
          sessionID: "ses_pre_registration",
          assistantMessageID: "msg_pre_registration",
          tokens: { input: 20, cache: { read: 10, write: 0 } },
        },
      },
    });
    expect(JSON.stringify(cacheEventEmit.mock.calls)).not.toContain("private event content");
    expect(nativeObserver.query("ses_pre_registration")).toMatchObject({
      primaryCacheReadRatio: { value: 1 / 3, messageId: "msg_pre_registration" },
    });

    await cleanup?.();
    releaseNativeObserver();
    nativeObserver.dispose();
  });

  it("keeps credential events responsive and disposes while a cache emitter remains unresolved", async () => {
    const ctx = createContext();
    const host = createHostEventQueue();
    const deepseek = {
      integrationId: "deepseek",
      id: "cred_deepseek",
      label: "default",
      registered: true,
      method: "key" as const,
      value: { type: "key", key: "old-key" } as Record<string, unknown>,
    };
    const integration = createFakeIntegration([deepseek]);
    let finishStartedEmission!: () => void;
    const startedEmission = new Promise<void>((resolve) => {
      finishStartedEmission = resolve;
    });
    const emit = vi.fn(
      async (
        _name: string,
        data: {
          cacheObserverEvent?: {
            type: string;
            data?: { assistantMessageID?: string; state?: string };
          };
        },
      ) => {
        if (data.cacheObserverEvent?.type === "session.step.started") await startedEmission;
      },
    );
    const rpcDispose = vi.fn(async () => {});
    vi.mocked(startDashboard).mockResolvedValueOnce({
      runtime: {} as never,
      dispose: async () => {},
    } as never);
    vi.mocked(registerDashboardRpc).mockClear();
    vi.mocked(registerDashboardRpc).mockImplementationOnce(
      async () =>
        ({
          events: { emit },
          dispose: rpcDispose,
        }) as never,
    );

    const cleanup = await setupPlugin({
      ...ctx,
      integration,
      rpc: {} as never,
      event: { subscribe: host.subscribe },
    });
    let stopping: Promise<void> | undefined;
    try {
      const read = () => readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek"] });
      await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });
      host.push({
        type: "session.step.started",
        created: 10_000,
        data: {
          sessionID: "ses_slow_emitter",
          assistantMessageID: "msg_slow_first",
          model: { providerID: "openai", id: "gpt-test" },
          started: 9_900,
        },
      });
      await vi.waitFor(() =>
        expect(
          emit.mock.calls.some(
            ([, data]) => data.cacheObserverEvent?.type === "session.step.started",
          ),
        ).toBe(true),
      );

      deepseek.value = { type: "key", key: "new-key" };
      host.push({
        type: "credential.updated",
        data: { integrationID: "deepseek", credentialID: "cred_deepseek" },
      });
      await vi.waitFor(async () =>
        expect(await read()).toEqual({ deepseek: { type: "api", key: "new-key" } }),
      );

      stopping = Promise.resolve(cleanup?.());
      const disposedBeforeEmitterSettled = await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(disposedBeforeEmitterSettled).toBe(true);
      expect(host.signal?.aborted).toBe(true);
      expect(rpcDispose).toHaveBeenCalledOnce();
    } finally {
      finishStartedEmission();
      if (stopping !== undefined) await stopping;
      else await cleanup?.();
    }

    expect(
      emit.mock.calls.filter(
        ([, data]) => data.cacheObserverEvent?.type === "session.step.started",
      ),
    ).toHaveLength(1);
  });

  it("bounds the registered cache relay and reports a gap after a stalled emitter recovers", async () => {
    const ctx = createContext();
    const host = createHostEventQueue();
    let finishFirstEmission!: () => void;
    const firstEmission = new Promise<void>((resolve) => {
      finishFirstEmission = resolve;
    });
    const emit = vi.fn(
      async (
        _name: string,
        data: {
          cacheObserverEvent?: {
            type: string;
            data?: { assistantMessageID?: string; state?: string };
          };
        },
      ) => {
        if (
          data.cacheObserverEvent?.type === "session.step.started" &&
          data.cacheObserverEvent.data?.assistantMessageID === "msg_stalled_first"
        ) {
          await firstEmission;
        }
      },
    );
    vi.mocked(startDashboard).mockResolvedValueOnce({
      runtime: {} as never,
      dispose: async () => {},
    } as never);
    vi.mocked(registerDashboardRpc).mockClear();
    vi.mocked(registerDashboardRpc).mockImplementationOnce(
      async () =>
        ({
          events: { emit },
          dispose: vi.fn(async () => {}),
        }) as never,
    );

    const cleanup = await setupPlugin({
      ...ctx,
      rpc: {} as never,
      event: { subscribe: host.subscribe },
    });
    host.push({
      type: "session.step.started",
      created: 30_000,
      data: {
        sessionID: "ses_stalled_relay",
        assistantMessageID: "msg_stalled_first",
        model: { providerID: "openai", id: "gpt-test" },
        started: 29_900,
      },
    });
    await vi.waitFor(() =>
      expect(
        emit.mock.calls.some(
          ([, data]) =>
            data.cacheObserverEvent?.type === "session.step.started" &&
            data.cacheObserverEvent.data?.assistantMessageID === "msg_stalled_first",
        ),
      ).toBe(true),
    );
    await vi.waitFor(() => expect(host.pulls).toBe(2));

    for (let index = 0; index < 513; index += 1) {
      host.push({
        type: "session.step.started",
        created: 30_100 + index,
        data: {
          sessionID: "ses_stalled_relay",
          assistantMessageID: `msg_stalled_${index}`,
          model: { providerID: "openai", id: "gpt-test" },
          started: 30_000 + index,
        },
      });
    }
    await vi.waitFor(() => expect(host.pulls).toBe(515));
    finishFirstEmission();

    await vi.waitFor(() =>
      expect(
        emit.mock.calls.filter(
          ([, data]) => data.cacheObserverEvent?.type === "session.step.started",
        ),
      ).toHaveLength(513),
    );
    const relayedMessageIds = emit.mock.calls
      .map(([, data]) => data.cacheObserverEvent)
      .filter((event) => event?.type === "session.step.started")
      .map((event) => event?.data?.assistantMessageID);
    expect(relayedMessageIds[0]).toBe("msg_stalled_first");
    expect(relayedMessageIds[1]).toBe("msg_stalled_1");
    expect(relayedMessageIds.at(-1)).toBe("msg_stalled_512");
    expect(
      emit.mock.calls.some(
        ([, data]) =>
          data.cacheObserverEvent?.type === "source.status" &&
          data.cacheObserverEvent.data?.state === "unavailable",
      ),
    ).toBe(true);
    await cleanup?.();
  });

  it("bounds cache events buffered before RPC registration and reports a dropped-event gap", async () => {
    const ctx = createContext();
    const host = createHostEventQueue();
    let resolveRegistration!: (registration: {
      events: { emit: typeof cacheEventEmit };
      dispose: () => Promise<void>;
    }) => void;
    const registration = new Promise<{
      events: { emit: typeof cacheEventEmit };
      dispose: () => Promise<void>;
    }>((resolve) => {
      resolveRegistration = resolve;
    });
    const emit = vi.fn(async () => {});
    vi.mocked(startDashboard).mockResolvedValueOnce({
      runtime: {} as never,
      dispose: async () => {},
    } as never);
    vi.mocked(registerDashboardRpc).mockClear();
    vi.mocked(registerDashboardRpc).mockImplementationOnce(async () => registration as never);

    const setup = setupPlugin({
      ...ctx,
      rpc: {} as never,
      event: { subscribe: host.subscribe },
    });
    await vi.waitFor(() => expect(registerDashboardRpc).toHaveBeenCalledOnce());
    for (let index = 0; index < 513; index += 1) {
      host.push({
        type: "session.step.started",
        created: 20_000 + index,
        data: {
          sessionID: "ses_bounded_relay",
          assistantMessageID: `msg_${index}`,
          model: { providerID: "openai", id: "gpt-test" },
          started: 19_000 + index,
        },
      });
    }
    await vi.waitFor(() => expect(host.pulls).toBe(514));
    resolveRegistration({ events: { emit }, dispose: async () => {} });
    const cleanup = await setup;
    await vi.waitFor(() =>
      expect(
        emit.mock.calls.filter(
          ([, data]) => data.cacheObserverEvent?.type === "session.step.started",
        ),
      ).toHaveLength(512),
    );

    const startedEvents = emit.mock.calls
      .map(([, data]) => data.cacheObserverEvent)
      .filter((event) => event?.type === "session.step.started");
    expect(startedEvents[0]?.data).toMatchObject({ assistantMessageID: "msg_1" });
    expect(startedEvents.at(-1)?.data).toMatchObject({ assistantMessageID: "msg_512" });
    expect(
      emit.mock.calls.some(
        ([, data]) =>
          data.cacheObserverEvent?.type === "source.status" &&
          data.cacheObserverEvent.data?.state === "unavailable",
      ),
    ).toBe(true);
    await cleanup?.();
  });

  it("does not treat model.list settings at Started-event arrival as dispatch-bound TTL evidence", async () => {
    const ctx = createContext();
    let pushHostEvent!: (event: unknown) => void;
    const nextEvent = () =>
      new Promise<unknown>((resolve) => {
        pushHostEvent = resolve;
      });
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) yield await nextEvent();
      },
    }));
    const modelList = vi.fn().mockResolvedValue({
      data: [
        {
          id: "claude-test",
          providerID: "anthropic",
          package: "@opencode/ai/providers/anthropic",
          settings: { cache: { ttl: "1h" } },
        },
      ],
    });
    const created = 1_700_000_000_000;
    vi.mocked(startDashboard).mockResolvedValueOnce({
      runtime: {} as never,
      dispose: async () => {},
    } as never);
    vi.mocked(registerDashboardRpc).mockClear();
    cacheEventEmit.mockClear();

    const cleanup = await setupPlugin({
      ...ctx,
      model: { list: modelList },
      rpc: {} as never,
      event: { subscribe },
    });
    pushHostEvent({
      type: "session.step.started",
      id: "evt_started",
      created,
      data: {
        sessionID: "ses_started",
        assistantMessageID: "msg_started",
        agent: "build",
        model: { providerID: "anthropic", id: "claude-test", variant: "default" },
        started: created - 100,
      },
    });

    await vi.waitFor(() => expect(cacheEventEmit).toHaveBeenCalledTimes(2));
    expect(modelList).not.toHaveBeenCalled();
    expect(cacheEventEmit).toHaveBeenNthCalledWith(2, "invalidated", {
      topic: "cache.observer",
      at: created,
      cacheObserverEvent: {
        type: "session.step.started",
        created,
        data: {
          sessionID: "ses_started",
          assistantMessageID: "msg_started",
          model: { providerID: "anthropic", id: "claude-test" },
          started: created - 100,
        },
      },
    });

    await cleanup?.();
  });
});
