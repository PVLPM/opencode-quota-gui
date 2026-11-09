// @vitest-environment happy-dom
import type { ComposerPillMenuProps, ComposerPillProps, Sessions } from "@opencode/plugin/gui";
import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import type { CacheObserverClassification } from "../src/lib/cache-observer.js";
import {
  classifyCacheObserverState,
  createCacheObserverState,
  observeCacheInvocation,
  setCacheTtlEvidence,
} from "../src/lib/cache-observer.js";
import { createCacheComposerPill } from "../src/native/cache-composer-pill.js";
import type { NativeCacheObserverChildrenSnapshot } from "../src/native/cache-observer-runtime.js";
import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";
import type { NativeDashboardRuntime } from "../src/native/runtime.js";

it("mounts the public menu lazily, updates live, and cancels on session changes", async () => {
  const addListener = vi.spyOn(document, "addEventListener");
  const removeListener = vi.spyOn(document, "removeEventListener");
  const a = { id: "a", key: "server\na", server: { builtin: true, connected: true } };
  const b = { id: "b", key: "server\nb", server: { builtin: true, connected: true } };
  const observations = new Map<string, CacheObserverClassification>();
  const listeners = new Map<string, () => void>();
  let childrenListener: ((snapshot: NativeCacheObserverChildrenSnapshot) => void) | undefined;
  const requests: Array<{ ids: readonly string[]; signal: AbortSignal }> = [];
  const bootstrapHistory = vi.fn((ids: readonly string[], signal: AbortSignal) => {
    requests.push({ ids, signal });
    return new Promise<void>(() => {});
  });
  const runtime = {
    retain: vi.fn(),
    cacheObserver: {
      transport: () => ({ rpc: "live", hostEvents: "observed" }),
      subscribeTransport: () => () => {},
      subscribeGaps: () => () => {},
      query: (id: string) => observations.get(id),
      subscribe: (id: string, listener: () => void) => {
        listeners.set(id, listener);
        return () => listeners.delete(id);
      },
      subscribeChildren: vi.fn((_id: string, listener: typeof childrenListener) => {
        childrenListener = listener;
        return () => {};
      }),
      bootstrapHistory,
    },
  } as unknown as NativeDashboardRuntime;
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) => ({
    title: sessionID === "a" ? "Main\u202e title" : "Second",
  }));
  const container = document.createElement("div");
  document.body.append(container);
  let setCurrent!: (value: typeof a) => void;
  let disposeMenu = () => {};
  const { dispose, pill, current } = createRoot((cleanup) => {
    const [current, set] = createSignal(a);
    setCurrent = set;
    const pill = createCacheComposerPill({ current } as unknown as Sessions, runtime, {
      get,
    } as never);
    return { dispose: cleanup, pill, current };
  });
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache · Loading…");
  expect(runtime.cacheObserver.subscribeChildren).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(requests[0]?.ids).toEqual(["a"]);
  disposeMenu = render(
    () =>
      pill.menu!({
        get session() {
          return current();
        },
        close() {},
      } as ComposerPillMenuProps),
    container,
  );
  childrenListener?.({ status: "error", children: [] });
  expect(container.textContent).toContain("Could not load child sessions.");
  childrenListener?.({ status: "ready", children: [{ sessionId: "child", label: "Worker" }] });
  expect(container.querySelector('.qg-cache-child [role="img"]')?.getAttribute("aria-label")).toBe(
    "Cache observation unknown",
  );
  expect(container.textContent).not.toContain("Could not load child sessions.");
  expect(requests[0]?.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(requests.at(-1)?.ids).toEqual(["a", "child"]);
  observations.set("a", {
    color: "yellow",
    reason: "ttl-unverified",
    primaryCacheReadRatio: { value: 0.82, observedAtMs: Date.now() },
  } as CacheObserverClassification);
  listeners.get("a")?.();
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache 82%");
  observations.set("child", { color: "red", reason: "known-invalidation" });
  listeners.get("child")?.();
  const childButton = container.querySelector<HTMLButtonElement>(
    ".qg-cache-child button.qg-cache-danger",
  );
  const mainButton = container.querySelector<HTMLButtonElement>(
    ".qg-cache-row:not(.qg-cache-child) button.qg-cache-warning",
  );
  expect(childButton?.getAttribute("aria-label")).toBe("Cache details for Worker");
  const childTooltip = container.querySelector<HTMLElement>(
    `#${childButton?.getAttribute("aria-describedby")}`,
  );
  const mainTooltip = container.querySelector<HTMLElement>(
    `#${mainButton?.getAttribute("aria-describedby")}`,
  );
  expect(childTooltip?.hidden).toBe(true);
  expect(mainTooltip?.hidden).toBe(true);
  const wrapper = childButton?.parentElement;
  wrapper?.dispatchEvent(new MouseEvent("mouseenter"));
  expect(childTooltip?.hidden).toBe(false);
  const escapeListener = addListener.mock.calls.filter(([type]) => type === "keydown").at(-1)?.[1];
  expect(escapeListener).toBeDefined();
  childButton?.dispatchEvent(new MouseEvent("mouseleave", { relatedTarget: childTooltip }));
  childTooltip?.dispatchEvent(new MouseEvent("mouseenter", { relatedTarget: childButton }));
  expect(childTooltip?.hidden).toBe(false);
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  elsewhere.focus();
  expect(document.activeElement).toBe(elsewhere);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(childTooltip?.hidden).toBe(true);
  expect(removeListener).toHaveBeenCalledWith("keydown", escapeListener);
  elsewhere.remove();
  wrapper?.dispatchEvent(new MouseEvent("mouseleave"));
  expect(childTooltip?.hidden).toBe(true);
  childButton?.focus();
  expect(document.activeElement).toBe(childButton);
  expect(childTooltip?.hidden).toBe(false);
  expect(childTooltip?.textContent).toBe("Invalidation observed");
  childButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(childTooltip?.hidden).toBe(true);
  mainButton?.focus();
  expect(mainTooltip?.hidden).toBe(false);
  expect(mainTooltip?.textContent).toContain("Reuse not verified");
  expect(mainTooltip?.textContent).toContain(
    "Last completed primary call · host-reported cache read",
  );
  mainButton?.blur();
  expect(mainTooltip?.hidden).toBe(true);
  const callsAfterLiveUpdate = bootstrapHistory.mock.calls.length;
  listeners.get("a")?.();
  expect(bootstrapHistory).toHaveBeenCalledTimes(callsAfterLiveUpdate);
  expect(container.textContent).toContain("Worker");
  expect(container.querySelector("hr")).not.toBeNull();
  expect(container.textContent).toContain("Main title");
  expect(container.textContent).not.toContain("\u202e");
  const oldChildrenListener = childrenListener;
  childrenListener?.({
    status: "ready",
    children: [{ sessionId: "child2", label: "Second worker" }],
  });
  expect(container.textContent).not.toContain("Worker");
  expect(container.textContent).toContain("Second worker");
  setCurrent(b);
  expect(requests.at(-2)?.signal.aborted).toBe(true);
  await Promise.resolve();
  oldChildrenListener?.({
    status: "ready",
    children: [{ sessionId: "stale", label: "Stale child" }],
  });
  expect(container.textContent).not.toContain("Stale child");
  expect(requests.at(-1)?.ids).toEqual(["b"]);
  await Promise.resolve();
  expect(container.textContent).toContain("Second");
  expect(container.textContent).not.toContain("Main");
  observations.set("b", { color: "yellow", reason: "ttl-unverified" });
  listeners.get("b")?.();
  container.querySelector<HTMLButtonElement>("button.qg-cache-warning")?.focus();
  const unmountListener = addListener.mock.calls.filter(([type]) => type === "keydown").at(-1)?.[1];
  expect(unmountListener).toBeDefined();
  disposeMenu();
  expect(removeListener).toHaveBeenCalledWith("keydown", unmountListener);
  dispose();
  expect(requests.at(-1)?.signal.aborted).toBe(true);
  container.remove();
  addListener.mockRestore();
  removeListener.mockRestore();
});

it("clears pending loading on RPC loss and starts only the selected session on recovery", async () => {
  const a = { id: "a", key: "server\na", server: { builtin: true, connected: true } };
  const b = { id: "b", key: "server\nb", server: { builtin: true, connected: true } };
  type Transport = { rpc: "live" | "reconnecting"; hostEvents: "observed" };
  let notifyTransport: (value: Transport) => void = () => {};
  const requests: Array<{ ids: readonly string[]; signal: AbortSignal }> = [];
  const runtime = {
    retain() {},
    cacheObserver: {
      transport: (): Transport => ({ rpc: "live", hostEvents: "observed" }),
      subscribeTransport: (listener: (value: Transport) => void) => {
        notifyTransport = listener;
        return () => {};
      },
      subscribeGaps: () => () => {},
      subscribe: () => () => {},
      query: () => undefined,
      bootstrapHistory: (ids: readonly string[], signal: AbortSignal) => {
        requests.push({ ids, signal });
        return new Promise<void>(() => {});
      },
    },
  } as unknown as NativeDashboardRuntime;
  let setCurrent!: (value: typeof a) => void;
  const { pill, dispose } = createRoot((cleanup) => {
    const [current, set] = createSignal(a);
    setCurrent = set;
    return {
      pill: createCacheComposerPill({ current } as unknown as Sessions, runtime, {} as never),
      dispose: cleanup,
    };
  });
  await Promise.resolve();
  expect(requests[0]?.ids).toEqual(["a"]);
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache · Loading…");
  notifyTransport({ rpc: "reconnecting", hostEvents: "observed" });
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache");
  setCurrent(b);
  expect(pill.show({ session: b } as ComposerPillProps)?.label).toBe("Cache");
  notifyTransport({ rpc: "live", hostEvents: "observed" });
  await Promise.resolve();
  expect(requests.at(-1)?.ids).toEqual(["b"]);
  expect(pill.show({ session: b } as ComposerPillProps)?.label).toBe("Cache · Loading…");
  dispose();
  expect(requests.at(-1)?.signal.aborted).toBe(true);
});

it("marks a collapsed history error without exposing technical details", async () => {
  const session = { id: "error", key: "server\nerror", server: { builtin: true, connected: true } };
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: () => () => {},
    rpcConnection: () => "live",
    listChildren: async () => [],
    listMessages: async () => {
      throw new Error("private server error");
    },
  });
  const runtime = { retain() {}, cacheObserver: observer } as unknown as NativeDashboardRuntime;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => session } as unknown as Sessions, runtime, {
      get: async () => ({ title: "Session" }),
    } as never),
    dispose: cleanup,
  }));
  await vi.waitFor(() =>
    expect(pill.show({ session } as ComposerPillProps)).toMatchObject({
      label: "Cache",
      icon: "warning",
      tone: "warning",
      title: "Cache observation",
    }),
  );
  const container = document.createElement("div");
  const close = render(
    () => pill.menu!({ session, close() {} } as ComposerPillMenuProps),
    container,
  );
  expect(container.textContent).toContain("Could not load cache history.");
  expect(container.textContent).not.toContain("private server error");
  close();
  dispose();
  observer.dispose();
});

it("does not interpret a real configured-minimum classification as verified expiry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const session = { id: "timer", key: "server\ntimer", server: { builtin: true, connected: true } };
  const route = {
    providerId: "anthropic",
    modelId: "test",
    protocolId: "anthropic-messages",
    basis: { source: "test", reference: "route" },
  };
  const state = setCacheTtlEvidence(
    observeCacheInvocation(createCacheObserverState({ sessionId: session.id, route }), {
      sessionId: session.id,
      route,
      order: { completedAtMs: Date.now(), messageId: "msg" },
      dispatchAtMs: Date.now(),
      primaryClassification: { kind: "primary", basis: { source: "test", reference: "call" } },
      counts: { fresh: 20, read: 80, write: 0 },
    }),
    {
      kind: "configured",
      protocolId: "anthropic-messages",
      route,
      configuredTtlMs: 300_000,
      basis: { source: "test", reference: "ttl" },
    },
  );
  const observed = classifyCacheObserverState(state, Date.now());
  expect(observed.color).toBe("green");
  expect(observed).not.toHaveProperty("verifiedExpiresAtMs");
  const query = vi.fn(() => observed);
  const runtime = {
    retain() {},
    cacheObserver: {
      transport: () => ({ rpc: "live", hostEvents: "observed" }),
      subscribeTransport: () => () => {},
      subscribeGaps: () => () => {},
      subscribe: () => () => {},
      query,
      bootstrapHistory: () => Promise.resolve(),
    },
  } as unknown as NativeDashboardRuntime;
  const { pill, dispose } = createRoot((cleanup) => {
    const pill = createCacheComposerPill(
      { current: () => session } as unknown as Sessions,
      runtime,
      {} as never,
    );
    return { pill, dispose: cleanup };
  });
  expect(pill.show({ session } as ComposerPillProps)).toMatchObject({
    label: "Cache 80%",
    tone: "warning",
  });
  expect(vi.getTimerCount()).toBe(0);
  dispose();
  vi.useRealTimers();
});

it("reboots history after a shared stream gap without an RPC disconnect", async () => {
  const session = { id: "gap", key: "server\ngap", server: { builtin: true, connected: true } };
  let retire = () => {};
  const cacheRead = 80;
  const listMessages = vi.fn(async () => ({
    data: [
      {
        id: "msg_gap",
        type: "assistant",
        model: { providerID: "openai", id: "test" },
        time: { created: 1000, completed: 1100 },
        tokens: { input: 100 - cacheRead, cache: { read: cacheRead, write: 0 } },
      },
    ],
    cursor: { next: null },
  }));
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: () => () => {},
    subscribeEventStreamRetire: (listener) => {
      retire = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [],
    listMessages,
  });
  const runtime = { retain() {}, cacheObserver: observer } as unknown as NativeDashboardRuntime;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => session } as unknown as Sessions,
      runtime,
      {} as never,
    ),
    dispose: cleanup,
  }));
  await vi.waitFor(() =>
    expect(pill.show({ session } as ComposerPillProps)?.label).toBe("Cache 80%"),
  );
  expect(listMessages).toHaveBeenCalledTimes(1);
  retire();
  await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(pill.show({ session } as ComposerPillProps)?.label).toBe("Cache 80%"),
  );
  dispose();
  observer.dispose();
});

it.each([
  "empty",
  "in-flight",
] as const)("retries %s history after a stream gap", async (scenario) => {
  const session = {
    id: "gap-empty",
    key: "server\ngap-empty",
    server: { builtin: true, connected: true },
  };
  let retire = () => {};
  let firstSignal: AbortSignal | undefined;
  let calls = 0;
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: () => () => {},
    subscribeEventStreamRetire: (listener) => {
      retire = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [],
    listMessages: async (_input, options) => {
      calls++;
      if (calls === 1) {
        firstSignal = options.signal;
        if (scenario === "in-flight") return new Promise(() => {});
        return { data: [], cursor: { next: null } };
      }
      return {
        data: [
          {
            id: "new",
            type: "assistant",
            model: { providerID: "openai", id: "test" },
            time: { completed: 1100 },
            tokens: { input: 20, cache: { read: 80, write: 0 } },
          },
        ],
        cursor: { next: null },
      };
    },
  });
  const runtime = { retain() {}, cacheObserver: observer } as unknown as NativeDashboardRuntime;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => session } as unknown as Sessions,
      runtime,
      {} as never,
    ),
    dispose: cleanup,
  }));
  await vi.waitFor(() => expect(calls).toBe(1));
  if (scenario === "empty")
    await vi.waitFor(() =>
      expect(pill.show({ session } as ComposerPillProps)?.label).toBe("Cache"),
    );
  retire();
  if (scenario === "in-flight") expect(firstSignal?.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(pill.show({ session } as ComposerPillProps)?.label).toBe("Cache 80%"),
  );
  expect(calls).toBe(2);
  dispose();
  observer.dispose();
});

it("renders real history bootstrap results independently without exposing message content", async () => {
  const session = { id: "main", key: "server\nmain", server: { builtin: true, connected: true } };
  const listMessages = vi.fn(async ({ sessionID }: { sessionID: string }) => ({
    data: [
      {
        id: `msg_${sessionID}`,
        type: "assistant",
        model: { providerID: "openai", id: "test" },
        time: { created: 1000, completed: 1100 },
        tokens: {
          input: sessionID === "main" ? 18 : 60,
          cache: { read: sessionID === "main" ? 82 : 40, write: 0 },
        },
        content: [{ text: "PRIVATE CONTENT" }],
      },
    ],
    cursor: { next: null },
  }));
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: () => () => {},
    rpcConnection: () => "live",
    listChildren: async () => [
      { id: "child", parentID: "main", title: `Worker\u202e${"x".repeat(100)}` },
    ],
    listMessages,
  });
  const runtime = { retain() {}, cacheObserver: observer } as unknown as NativeDashboardRuntime;
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => session } as unknown as Sessions, runtime, {
      get: async () => ({ title: "Main\u202e title" }),
    } as never),
    dispose: cleanup,
  }));
  await vi.waitFor(() =>
    expect(pill.show({ session } as ComposerPillProps)?.label).toBe("Cache 82%"),
  );
  expect(listMessages.mock.calls.map(([input]) => input.sessionID)).toEqual(["main"]);
  const close = render(
    () => pill.menu!({ session, close() {} } as ComposerPillMenuProps),
    container,
  );
  await vi.waitFor(() => expect(container.textContent).toContain("40%"));
  expect(container.textContent).toContain("Worker");
  expect(container.textContent).toContain("Main title");
  expect(container.textContent).not.toContain("\u202e");
  expect(
    container.querySelector(".qg-cache-child .qg-cache-title")?.textContent?.length,
  ).toBeLessThanOrEqual(80);
  expect(container.textContent).not.toContain("PRIVATE CONTENT");
  expect(listMessages.mock.calls.map(([input]) => input.sessionID)).toEqual(["main", "child"]);
  close();
  dispose();
  observer.dispose();
  container.remove();
});

it("uses neutral, warning and verified tones without guessing a lifetime", () => {
  const session = { id: "tone", key: "server\ntone", server: { builtin: true, connected: true } };
  let observed: CacheObserverClassification | undefined;
  let update = () => {};
  let updateTransport: (value: { rpc: "live"; hostEvents: "observed" | "unavailable" }) => void =
    () => {};
  const runtime = {
    retain() {},
    cacheObserver: {
      transport: () => ({ rpc: "live", hostEvents: "observed" }),
      subscribeTransport: (listener: typeof updateTransport) => {
        updateTransport = listener;
        return () => {};
      },
      subscribeGaps: () => () => {},
      subscribe: (_id: string, listener: () => void) => {
        update = listener;
        return () => {};
      },
      query: () => observed,
      bootstrapHistory: () => new Promise<void>(() => {}),
    },
  } as unknown as NativeDashboardRuntime;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => session } as unknown as Sessions,
      runtime,
      {} as never,
    ),
    dispose: cleanup,
  }));
  const show = () => pill.show({ session } as ComposerPillProps)!;
  expect(show()).toMatchObject({ icon: "archive", title: "Cache observation" });
  expect(show().tone).toBeUndefined();
  expect(show().label).not.toContain("?");
  observed = {
    color: "yellow",
    reason: "ttl-unverified",
    primaryCacheReadRatio: { value: 0.82, observedAtMs: Date.now() },
  } as CacheObserverClassification;
  update();
  expect(show()).toMatchObject({ label: "Cache 82%", tone: "warning" });
  observed = {
    ...observed,
    color: "green",
    reason: "estimated-reuse-within-ttl",
    configuredTtlDeadlineAtMs: Date.now() + 120_000,
    recheckAtMs: Date.now() + 60_000,
  };
  update();
  expect(show().tone).toBe("warning");
  expect(show().label).toBe("Cache 82%");
  updateTransport({ rpc: "live", hostEvents: "unavailable" });
  expect(show().tone).toBe("warning");
  expect(show().label).not.toContain("m");
  observed = { color: "red", reason: "known-invalidation" } as CacheObserverClassification;
  update();
  expect(show().tone).toBe("danger");
  dispose();
});
