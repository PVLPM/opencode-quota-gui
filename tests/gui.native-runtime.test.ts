import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DashboardRpcCaller } from "../src/native/dashboard-client.js";
import { initialNativeLocation } from "../src/native/navigation.js";
import type { NativeDashboardRuntime } from "../src/native/runtime.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

/**
 * Window-lived Native dashboard runtime.
 *
 * Solid's Node export is the inert server build, so the runtime and the signals
 * around it are loaded through a Vite server aliased to the client runtime;
 * otherwise no effect would run. These tests drive the transport against a fake
 * RPC caller: no DOM, no timers and no polling.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type CreateRoot = (callback: (dispose: () => void) => void) => () => void;
type CreateSignal = <T>(value: T) => [() => T, (next: T) => T];

let server: ViteDevServer | undefined;
let createRoot: CreateRoot;
let createSignal: CreateSignal;
let createNativeDashboardRuntime: typeof import("../src/native/runtime.js").createNativeDashboardRuntime;
let createCacheComposerPill: typeof import("../src/native/cache-composer-pill.js").createCacheComposerPill;
let panelScope: typeof import("../src/native/runtime.js").panelScope;

beforeAll(async () => {
  const created = await createIsolatedViteServer({
    configFile: false,
    root: repoRoot,
    resolve: {
      alias: [
        {
          find: /^solid-js$/,
          replacement: path.join(repoRoot, "node_modules/solid-js/dist/solid.js"),
        },
      ],
    },
    ssr: { noExternal: ["solid-js"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const core = (await created.ssrLoadModule("solid-js")) as {
    createRoot: CreateRoot;
    createSignal: CreateSignal;
  };
  createRoot = core.createRoot;
  createSignal = core.createSignal;
  const runtimeModule = (await created.ssrLoadModule(
    path.join(repoRoot, "src/native/runtime.ts"),
  )) as typeof import("../src/native/runtime.js");
  createNativeDashboardRuntime = runtimeModule.createNativeDashboardRuntime;
  panelScope = runtimeModule.panelScope;
  const cachePillModule = (await created.ssrLoadModule(
    path.join(repoRoot, "src/native/cache-composer-pill.ts"),
  )) as typeof import("../src/native/cache-composer-pill.js");
  createCacheComposerPill = cachePillModule.createCacheComposerPill;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

type EventItem = { kind: "event"; value: { data: unknown } } | { kind: "error"; error: unknown };

function createEventStream(signal: AbortSignal) {
  const items: EventItem[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  function push(item: EventItem): void {
    if (ended) return;
    items.push(item);
    wake?.();
    wake = undefined;
  }

  function finish(): void {
    if (ended) return;
    ended = true;
    wake?.();
    wake = undefined;
  }

  signal.addEventListener("abort", finish, { once: true });

  return {
    signal,
    stream: {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (items.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const item = items.shift();
          if (!item) return;
          if (item.kind === "error") throw item.error;
          yield item.value;
        }
      },
    },
    pushEvent: (data: unknown) => push({ kind: "event", value: { data } }),
    finish,
  };
}

interface ActiveWatch {
  scope: string;
  signal: AbortSignal;
}

function createFakeCaller() {
  const activeWatches: ActiveWatch[] = [];
  const streams: Array<ReturnType<typeof createEventStream>> = [];
  let pendingWatches = 0;
  let maxPendingWatches = 0;
  const caller = {
    health: vi.fn(async () => ({ app: "opencode-quota-gui", contractVersion: 2 })),
    quota: vi.fn(async () => ({})),
    home: vi.fn(async () => ({})),
    groups: vi.fn(async () => ({})),
    project: vi.fn(async () => ({})),
    session: vi.fn(async () => ({})),
    settings: vi.fn(async () => ({})),
    saveSettings: vi.fn(async () => ({})),
    saveVisibility: vi.fn(async () => ({})),
    importPreview: vi.fn(async () => ({})),
    importApply: vi.fn(async () => ({})),
    openSettingsFile: vi.fn(async () => ({ opened: true as const })),
    watch: vi.fn(
      (input: { scope: string }, options?: { signal?: AbortSignal }) =>
        new Promise<{ active: boolean }>((resolve) => {
          const signal = options?.signal ?? new AbortController().signal;
          pendingWatches += 1;
          maxPendingWatches = Math.max(maxPendingWatches, pendingWatches);
          let settled = false;
          const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            pendingWatches -= 1;
            finish();
          };
          activeWatches.push({ scope: input.scope, signal });
          signal.addEventListener("abort", () => settle(() => resolve({ active: false })), {
            once: true,
          });
        }),
    ),
    events: {
      subscribe: vi.fn((_name: "invalidated", options?: { signal?: AbortSignal }) => {
        const stream = createEventStream(options?.signal ?? new AbortController().signal);
        streams.push(stream);
        return stream.stream;
      }),
    },
  };
  return {
    caller: caller as unknown as DashboardRpcCaller,
    raw: caller,
    activeWatches,
    streams,
    watchActivity: () => ({ active: pendingWatches, max: maxPendingWatches }),
  };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check(), label).toBe(true);
    },
    { timeout: 1000, interval: 5 },
  );
  if (!check()) throw new Error(`timed out waiting for ${label}`);
}

function pushCacheObserverEvent(
  fake: ReturnType<typeof createFakeCaller>,
  at: number,
  cacheObserverEvent: unknown,
): void {
  fake.streams.at(-1)?.pushEvent({
    topic: "cache.observer",
    at,
    cacheObserverEvent,
  });
}

function pushPrimaryInvocation(
  fake: ReturnType<typeof createFakeCaller>,
  sessionId: string,
  messageId: string,
  startedAt: number,
  endedAt: number,
  tokens: { input: number; cache: { read: number; write: number } },
): void {
  pushCacheObserverEvent(fake, startedAt, {
    type: "session.step.started",
    created: startedAt,
    data: {
      sessionID: sessionId,
      assistantMessageID: messageId,
      model: { providerID: "openai", id: "gpt-test" },
      started: startedAt - 10,
    },
  });
  pushCacheObserverEvent(fake, endedAt, {
    type: "session.step.ended",
    created: endedAt,
    data: { sessionID: sessionId, assistantMessageID: messageId, tokens },
  });
}

function mountRuntime(options: {
  fake: ReturnType<typeof createFakeCaller>;
  connected: () => boolean;
  sessionList?: (input: { parentID: string; limit?: number; cursor?: string }) => Promise<{
    data: Array<{ id: string; parentID?: string; title?: string }>;
    cursor: { next?: string | null };
  }>;
}): { runtime: NativeDashboardRuntime; dispose: () => void } {
  let runtime!: NativeDashboardRuntime;
  const dispose = createRoot((disposeRoot) => {
    runtime = createNativeDashboardRuntime({
      client: {
        rpc: () => options.fake.caller,
        session: {
          list: options.sessionList ?? (async () => ({ data: [], cursor: {} })),
        },
      } as never,
      servers: {
        list: () => ["builtin"],
        get: () => ({ builtin: true, connected: options.connected() }),
      } as never,
    });
    return disposeRoot;
  });
  return { runtime, dispose };
}

describe("native window runtime", () => {
  it("activates the existing window stream for an idle root cache pill before the dashboard opens", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    const session = {
      key: "builtin\nses_idle_root",
      id: "ses_idle_root",
      server: { builtin: true, connected: true },
    };
    const [current] = createSignal(session);
    let pill!: ReturnType<typeof createCacheComposerPill>;
    const disposePill = createRoot((disposeRoot) => {
      pill = createCacheComposerPill({ current, list: () => [session] } as never, runtime);
      return disposeRoot;
    });

    // No Panel is mounted and the test never calls runtime.retain() directly.
    await waitFor(() => runtime.client.connection() === "live", "root pill window transport");
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();
    expect(fake.raw.watch).toHaveBeenCalledOnce();

    fake.streams[0]?.pushEvent({
      topic: "cache.observer",
      at: 1_000,
      cacheObserverEvent: {
        type: "session.step.started",
        created: 1_000,
        data: {
          sessionID: session.id,
          assistantMessageID: "msg_idle_root",
          model: { providerID: "openai", id: "gpt-test" },
          started: 990,
        },
      },
    });
    fake.streams[0]?.pushEvent({
      topic: "cache.observer",
      at: 1_100,
      cacheObserverEvent: {
        type: "session.step.ended",
        created: 1_100,
        data: {
          sessionID: session.id,
          assistantMessageID: "msg_idle_root",
          tokens: { input: 100, cache: { read: 20, write: 10 } },
        },
      },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(session.id)?.primaryCacheReadRatio?.messageId ===
        "msg_idle_root",
      "root pill host cache event",
    );
    expect(pill.show({ session } as never).label).toContain("15.4%");

    disposePill();
    dispose();
  });

  it("fences a switched-away session ratio until a new primary end is observed", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    const sessionA = {
      key: "builtin\nses_switch_a",
      id: "ses_switch_a",
      server: { builtin: true, connected: true },
    };
    const sessionB = {
      key: "builtin\nses_switch_b",
      id: "ses_switch_b",
      server: { builtin: true, connected: true },
    };
    const [current, setCurrent] = createSignal(sessionA);
    let pill!: ReturnType<typeof createCacheComposerPill>;
    const disposePill = createRoot((disposeRoot) => {
      pill = createCacheComposerPill(
        { current, list: () => [sessionA, sessionB] } as never,
        runtime,
      );
      return disposeRoot;
    });
    await waitFor(() => runtime.client.connection() === "live", "session switch transport");

    pushPrimaryInvocation(fake, sessionA.id, "msg_a_initial", 1_000, 1_100, {
      input: 100,
      cache: { read: 20, write: 10 },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(sessionA.id)?.primaryCacheReadRatio?.messageId ===
        "msg_a_initial",
      "initial session A ratio",
    );
    expect(pill.show({ session: sessionA } as never).label).toContain("15.4%");

    setCurrent(sessionB);
    await waitFor(
      () => !/\d+\.\d+%/.test(pill.show({ session: sessionB } as never).label),
      "session B pill selection",
    );
    pushPrimaryInvocation(fake, sessionA.id, "msg_a_missed", 1_200, 1_300, {
      input: 100,
      cache: { read: 40, write: 10 },
    });
    pushPrimaryInvocation(fake, sessionB.id, "msg_b", 1_400, 1_500, {
      input: 100,
      cache: { read: 30, write: 10 },
    });
    await waitFor(
      () => runtime.cacheObserver.query(sessionB.id)?.primaryCacheReadRatio?.messageId === "msg_b",
      "session B event-stream barrier",
    );
    expect(runtime.cacheObserver.query(sessionA.id)).not.toHaveProperty("primaryCacheReadRatio");

    setCurrent(sessionA);
    await waitFor(
      () => !/\d+\.\d+%/.test(pill.show({ session: sessionA } as never).label),
      "session A returns without claiming a latest ratio",
    );
    pushPrimaryInvocation(fake, sessionA.id, "msg_a_new", 1_600, 1_700, {
      input: 100,
      cache: { read: 30, write: 10 },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(sessionA.id)?.primaryCacheReadRatio?.messageId === "msg_a_new",
      "new session A primary end",
    );
    expect(pill.show({ session: sessionA } as never).label).toContain("21.4%");

    disposePill();
    dispose();
  });

  it("fences a connected session ratio over a transport reconnect until a new primary end", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    const session = {
      key: "builtin\nses_reconnect",
      id: "ses_reconnect",
      server: { builtin: true, connected: true },
    };
    const [current] = createSignal(session);
    let pill!: ReturnType<typeof createCacheComposerPill>;
    const disposePill = createRoot((disposeRoot) => {
      pill = createCacheComposerPill({ current, list: () => [session] } as never, runtime);
      return disposeRoot;
    });
    await waitFor(() => runtime.client.connection() === "live", "reconnect test transport");
    pushPrimaryInvocation(fake, session.id, "msg_before_disconnect", 2_000, 2_100, {
      input: 100,
      cache: { read: 20, write: 10 },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(session.id)?.primaryCacheReadRatio?.messageId ===
        "msg_before_disconnect",
      "pre-disconnect ratio",
    );

    fake.streams[0]?.finish();
    await waitFor(() => runtime.client.connection() === "reconnecting", "transport disconnect");
    expect(runtime.cacheObserver.query(session.id)).not.toHaveProperty("primaryCacheReadRatio");

    await runtime.client.reconnect();
    await waitFor(() => runtime.client.connection() === "live", "transport reconnect");
    expect(fake.streams).toHaveLength(2);
    expect(runtime.cacheObserver.query(session.id)).not.toHaveProperty("primaryCacheReadRatio");
    expect(pill.show({ session } as never).label).not.toContain("15.4%");

    pushPrimaryInvocation(fake, session.id, "msg_after_reconnect", 2_200, 2_300, {
      input: 100,
      cache: { read: 30, write: 10 },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(session.id)?.primaryCacheReadRatio?.messageId ===
        "msg_after_reconnect",
      "post-reconnect primary end",
    );
    expect(pill.show({ session } as never).label).toContain("21.4%");

    disposePill();
    dispose();
  });

  it("discovers direct children through the installed client without analytics or another stream", async () => {
    const fake = createFakeCaller();
    const sessionList = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: "ses_child", parentID: "ses_root", title: "  child\nlabel\u202Eignored  " },
          { id: "ses_wrong_parent", parentID: "ses_other", title: "Wrong parent" },
        ],
        cursor: { next: "next-page" },
      })
      .mockResolvedValueOnce({
        data: [{ id: "ses_child_empty", parentID: "ses_root", title: " \u0000 " }],
        cursor: {},
      });
    const { runtime, dispose } = mountRuntime({
      fake,
      connected: () => true,
      sessionList,
    });

    await expect(runtime.cacheObserver.children("ses_root")).resolves.toEqual([
      { sessionId: "ses_child", label: "child labelignored" },
      { sessionId: "ses_child_empty", label: "Untitled child session" },
    ]);
    expect(sessionList).toHaveBeenNthCalledWith(1, { parentID: "ses_root", limit: 100 });
    expect(sessionList).toHaveBeenNthCalledWith(2, {
      parentID: "ses_root",
      limit: 100,
      cursor: "next-page",
    });
    expect(fake.raw.health).not.toHaveBeenCalled();
    expect(fake.raw.session).not.toHaveBeenCalled();
    expect(fake.raw.watch).not.toHaveBeenCalled();
    expect(fake.streams).toHaveLength(0);

    dispose();
  });

  it("rediscovers direct children when the existing Native transport reconnects", async () => {
    const fake = createFakeCaller();
    const liveChildren = [
      { id: "ses_before_restart", parentID: "ses_root", title: "Before restart" },
    ];
    const sessionList = vi.fn(async () => ({ data: [...liveChildren], cursor: {} }));
    const { runtime, dispose } = mountRuntime({
      fake,
      connected: () => true,
      sessionList,
    });
    runtime.retain();
    await waitFor(() => runtime.client.connection() === "live", "live transport");

    const snapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const releaseChildren = runtime.cacheObserver.subscribeChildren("ses_root", (snapshot) =>
      snapshots.push(snapshot),
    );
    await waitFor(() => snapshots.at(-1)?.status === "ready", "initial child discovery");
    expect(snapshots.at(-1)?.children.map((child) => child.sessionId)).toEqual([
      "ses_before_restart",
    ]);

    liveChildren.splice(0, liveChildren.length);
    liveChildren.push({ id: "ses_after_restart", parentID: "ses_root", title: "After restart" });
    await runtime.client.reconnect();
    await waitFor(
      () =>
        snapshots
          .at(-1)
          ?.children.map((child) => child.sessionId)
          .join(",") === "ses_after_restart",
      "child creation and deletion rediscovery after reconnect",
    );
    expect(sessionList).toHaveBeenCalledTimes(2);
    expect(fake.streams).toHaveLength(2);

    releaseChildren();
    dispose();
  });

  it("updates an open root from lifecycle events on the existing Native stream", async () => {
    const fake = createFakeCaller();
    const liveChildren = [{ id: "ses_existing", parentID: "ses_root", title: "Existing" }];
    const sessionList = vi.fn(async ({ parentID }: { parentID: string }) => ({
      data: liveChildren.filter((child) => child.parentID === parentID),
      cursor: {},
    }));
    const { runtime, dispose } = mountRuntime({
      fake,
      connected: () => true,
      sessionList,
    });
    runtime.retain();
    await waitFor(() => runtime.client.connection() === "live", "live transport");

    const snapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const releaseChildren = runtime.cacheObserver.subscribeChildren("ses_root", (snapshot) =>
      snapshots.push(snapshot),
    );
    await waitFor(() => snapshots.at(-1)?.status === "ready", "initial child discovery");
    expect(fake.streams).toHaveLength(1);

    liveChildren.push({ id: "ses_created", parentID: "ses_root", title: "Created" });
    fake.streams[0]?.pushEvent({
      topic: "cache.observer",
      at: 1,
      cacheObserverEvent: {
        type: "session.created",
        data: { sessionID: "ses_created", parentID: "ses_root" },
      },
    });
    await waitFor(() => sessionList.mock.calls.length === 2, "creation event triggers rediscovery");
    await waitFor(
      () => snapshots.at(-1)?.children.some((child) => child.sessionId === "ses_created"),
      "created child arrives through the existing stream",
    );

    liveChildren.splice(
      liveChildren.findIndex((child) => child.id === "ses_created"),
      1,
    );
    fake.streams[0]?.pushEvent({
      topic: "cache.observer",
      at: 2,
      cacheObserverEvent: {
        type: "session.deleted",
        data: { sessionID: "ses_created" },
      },
    });
    await waitFor(
      () => !snapshots.at(-1)?.children.some((child) => child.sessionId === "ses_created"),
      "deleted child is removed from the open root",
    );
    expect(fake.streams).toHaveLength(1);

    releaseChildren();
    dispose();
  });

  it("keeps the transport live across a Settings-style Panel remount", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });

    runtime.retain();
    await waitFor(() => runtime.client.connection() === "live", "initial live transport");

    const healthCalls = fake.raw.health.mock.calls.length;
    const watchCalls = fake.raw.watch.mock.calls.length;
    const streamCalls = fake.raw.events.subscribe.mock.calls.length;
    const reconnected = vi.fn();
    const states: string[] = [];
    runtime.client.onReconnect(reconnected);
    runtime.client.onConnectionChange((state) => states.push(state));

    // Panel consumer unmounts (Settings opens); the window runtime stays alive.
    const unmounted = runtime.client.subscribe(() => {});
    unmounted();
    await Promise.resolve();
    expect(runtime.client.connection()).toBe("live");

    // Panel consumer mounts again on return; no new attempt or stream.
    const remounted = runtime.client.subscribe(() => {});
    await Promise.resolve();
    expect(runtime.client.connection()).toBe("live");
    expect(fake.raw.health).toHaveBeenCalledTimes(healthCalls);
    expect(fake.raw.watch).toHaveBeenCalledTimes(watchCalls);
    expect(fake.raw.events.subscribe).toHaveBeenCalledTimes(streamCalls);
    expect(reconnected).not.toHaveBeenCalled();
    expect(states).toEqual([]);

    remounted();
    dispose();
  });

  it("changes scope without reporting a reconnect and never overlaps watches", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    runtime.retain();
    await waitFor(() => runtime.client.connection() === "live", "initial live transport");

    const reconnected = vi.fn();
    const states: string[] = [];
    runtime.client.onReconnect(reconnected);
    runtime.client.onConnectionChange((state) => states.push(state));

    runtime.setScope("analytics");
    await waitFor(
      () =>
        fake.activeWatches.some((watch) => watch.scope === "analytics" && !watch.signal.aborted),
      "analytics watch",
    );
    expect(runtime.client.connection()).toBe("live");
    expect(reconnected).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(fake.watchActivity().max).toBe(1);

    // Returning to Quota releases analytics interest through the same path.
    runtime.setScope("quota");
    await waitFor(
      () =>
        fake.activeWatches.filter((watch) => watch.scope === "quota" && !watch.signal.aborted)
          .length === 1,
      "quota watch",
    );
    expect(runtime.client.connection()).toBe("live");
    expect(fake.watchActivity().max).toBe(1);
    expect(states).toEqual([]);

    dispose();
  });

  it("fences the cache ratio during a healthy scope stream replacement without reporting reconnect", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    const session = {
      key: "builtin\nses_scope_transition",
      id: "ses_scope_transition",
      server: { builtin: true, connected: true },
    };
    const [current] = createSignal(session);
    let pill!: ReturnType<typeof createCacheComposerPill>;
    const disposePill = createRoot((disposeRoot) => {
      pill = createCacheComposerPill({ current, list: () => [session] } as never, runtime);
      return disposeRoot;
    });
    await waitFor(() => runtime.client.connection() === "live", "scope-transition transport");
    pushPrimaryInvocation(fake, session.id, "msg_before_scope_change", 3_000, 3_100, {
      input: 100,
      cache: { read: 20, write: 10 },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(session.id)?.primaryCacheReadRatio?.messageId ===
        "msg_before_scope_change",
      "ratio before scope change",
    );

    const reconnected = vi.fn();
    const states: string[] = [];
    runtime.client.onReconnect(reconnected);
    runtime.client.onConnectionChange((state) => states.push(state));
    let finishScopeHealth!: () => void;
    const scopeHealth = new Promise<{ app: string; contractVersion: number }>((resolve) => {
      finishScopeHealth = () => resolve({ app: "opencode-quota-gui", contractVersion: 2 });
    });
    fake.raw.health.mockImplementationOnce(() => scopeHealth);

    runtime.setScope("analytics");
    await waitFor(
      () => fake.streams[0]?.signal.aborted === true,
      "old event stream retirement on scope change",
    );
    expect(runtime.cacheObserver.query(session.id)).not.toHaveProperty("primaryCacheReadRatio");
    expect(pill.show({ session } as never).label).not.toContain("15.4%");

    // This primary occurs while the replacement health probe is pending. The
    // old stream is already retired, so the host event is not replayed later.
    pushPrimaryInvocation(fake, session.id, "msg_missed_during_scope_change", 3_200, 3_300, {
      input: 100,
      cache: { read: 40, write: 10 },
    });
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();
    expect(runtime.cacheObserver.query(session.id)).not.toHaveProperty("primaryCacheReadRatio");

    finishScopeHealth();
    await waitFor(() => fake.streams.length === 2, "replacement scope event stream");
    await waitFor(
      () =>
        fake.activeWatches.some((watch) => watch.scope === "analytics" && !watch.signal.aborted),
      "replacement analytics watch",
    );
    expect(fake.raw.events.subscribe).toHaveBeenCalledTimes(2);
    expect(runtime.client.connection()).toBe("live");
    expect(reconnected).not.toHaveBeenCalled();
    expect(states).toEqual([]);
    expect(runtime.cacheObserver.query(session.id)).not.toHaveProperty("primaryCacheReadRatio");

    pushPrimaryInvocation(fake, session.id, "msg_after_scope_change", 3_400, 3_500, {
      input: 100,
      cache: { read: 30, write: 10 },
    });
    await waitFor(
      () =>
        runtime.cacheObserver.query(session.id)?.primaryCacheReadRatio?.messageId ===
        "msg_after_scope_change",
      "new primary after scope replacement",
    );
    expect(pill.show({ session } as never).label).toContain("21.4%");

    disposePill();
    dispose();
  });

  it("still reports reconnecting when a scope change genuinely fails", async () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    runtime.retain();
    await waitFor(() => runtime.client.connection() === "live", "initial live transport");

    const states: string[] = [];
    runtime.client.onConnectionChange((state) => states.push(state));
    fake.raw.health.mockRejectedValueOnce(new Error("server unavailable"));

    runtime.setScope("analytics");
    await waitFor(() => runtime.client.connection() === "reconnecting", "reconnecting state");
    expect(states).toContain("reconnecting");

    await runtime.client.resume();
    await waitFor(() => runtime.client.connection() === "live", "recovered transport");
    dispose();
  });

  it("suspends and resumes for a genuine host loss", async () => {
    const [connected, setConnected] = createSignal(true);
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected });
    runtime.retain();
    await waitFor(() => runtime.client.connection() === "live", "initial live transport");

    setConnected(false);
    await waitFor(() => runtime.client.connection() === "reconnecting", "suspended transport");
    expect(fake.activeWatches.every((watch) => watch.signal.aborted)).toBe(true);

    setConnected(true);
    await waitFor(() => runtime.client.connection() === "live", "resumed transport");
    expect(fake.raw.health.mock.calls.length).toBeGreaterThan(1);
    dispose();
  });

  it("keeps one window-level location across a session switch and a Settings remount", () => {
    const fake = createFakeCaller();
    const { runtime, dispose } = mountRuntime({ fake, connected: () => true });
    const models = {
      route: { name: "models", dimension: "model" },
      range: "30d",
    } as ReturnType<typeof initialNativeLocation>;

    /** Mirrors DashboardPanel: seed once from the runtime, write through. */
    const mountPanel = () => {
      const [location, setLocation] = createSignal(runtime.location());
      return {
        location,
        navigate: (next: ReturnType<typeof initialNativeLocation>) => {
          setLocation(next);
          runtime.setLocation(next);
        },
      };
    };

    const panel = mountPanel();
    expect(panel.location()).toEqual(initialNativeLocation());
    panel.navigate(models);

    // Session A -> session B: OpenCode keeps Panel.render mounted and only
    // swaps `input.session`, so neither the Panel nor the window location moves.
    expect(panel.location()).toEqual(models);
    expect(runtime.location()).toEqual(models);

    // Settings-style unmount and return: the fresh Panel seeds from the same
    // window location, not from a per-session entry.
    const remounted = mountPanel();
    expect(remounted.location()).toEqual(models);
    dispose();
  });
});

describe("panel scope policy", () => {
  it("keeps a hidden or unmounted panel on the cheap quota scope", () => {
    expect(panelScope(true, { name: "home" })).toBe("quota");
    expect(panelScope(true, { name: "analytics" })).toBe("analytics");
    expect(panelScope(false, { name: "analytics" })).toBe("quota");
    expect(panelScope(false, { name: "models", dimension: "provider" })).toBe("quota");
  });
});
