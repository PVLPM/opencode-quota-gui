// @vitest-environment happy-dom
import type { ComposerPillMenuProps, ComposerPillProps, Sessions } from "@opencode/plugin/gui";
import { createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import type { CacheObserverClassification } from "../src/lib/cache-observer.js";
import {
  classifyCacheObserverState,
  createCacheObserverState,
  observeCacheInvocation,
  setCacheTtlEvidence,
} from "../src/lib/cache-observer.js";
import { createCacheComposerPill } from "../src/native/cache-composer-pill.js";
import type {
  NativeCacheObserverChildrenSnapshot,
  NativeCacheObserverSessionMeta,
} from "../src/native/cache-observer-runtime.js";
import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";
import type { NativeDashboardRuntime } from "../src/native/runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

function session(id: string) {
  return { id, key: `server\n${id}`, server: { builtin: true, connected: true } };
}

function mockCacheObserver(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: () => ({ rpc: "live", hostEvents: "observed" }),
    subscribeTransport: () => () => {},
    subscribeGaps: () => () => {},
    query: () => undefined,
    subscribe: () => () => {},
    status: () => "unknown" as const,
    metadata: () => undefined,
    subscribeChildren: () => () => {},
    bootstrapHistory: () => Promise.resolve(),
    ...overrides,
  };
}

function mockRuntime(cacheObserver: Record<string, unknown>): NativeDashboardRuntime {
  return { retain: vi.fn(), cacheObserver } as unknown as NativeDashboardRuntime;
}

function renderMenu(
  pill: ReturnType<typeof createCacheComposerPill>,
  sessionRef: () => { id: string; key: string },
  container: HTMLElement,
) {
  return render(
    () =>
      pill.menu!({
        get session() {
          return sessionRef();
        },
        close() {},
      } as ComposerPillMenuProps),
    container,
  );
}

async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

it("keeps discovery and history with the selection, renders live, and cancels on session changes", async () => {
  const addListener = vi.spyOn(document, "addEventListener");
  const removeListener = vi.spyOn(document, "removeEventListener");
  const a = session("a");
  const b = session("b");
  const observations = new Map<string, CacheObserverClassification>();
  const listeners = new Map<string, () => void>();
  let childrenListener: ((snapshot: NativeCacheObserverChildrenSnapshot) => void) | undefined;
  const requests: Array<{ ids: readonly string[]; signal: AbortSignal }> = [];
  const bootstrapHistory = vi.fn((ids: readonly string[], signal: AbortSignal) => {
    requests.push({ ids, signal });
    return new Promise<void>(() => {});
  });
  const subscribeChildren = vi.fn((_id: string, listener: typeof childrenListener) => {
    childrenListener = listener;
    return () => {};
  });
  const runtime = mockRuntime(
    mockCacheObserver({
      subscribeTransport: () => () => {},
      query: (id: string) => observations.get(id),
      subscribe: (id: string, listener: () => void) => {
        listeners.set(id, listener);
        return () => listeners.delete(id);
      },
      metadata: (id: string) =>
        id === "a"
          ? { title: "Main\u202e title" }
          : id === "child"
            ? { title: "Worker" }
            : id === "b"
              ? { title: "Second" }
              : undefined,
      subscribeChildren,
      bootstrapHistory,
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  let setCurrent!: (value: typeof a) => void;
  const { dispose, pill, current } = createRoot((cleanup) => {
    const [current, set] = createSignal(a);
    setCurrent = set;
    const pill = createCacheComposerPill({ current } as unknown as Sessions, runtime);
    return { dispose: cleanup, pill, current };
  });
  // Discovery follows the selection, not the popover: one subscription per
  // selection, started while the popover is still closed.
  expect(subscribeChildren).toHaveBeenCalledTimes(1);
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache · Loading…");
  await flush();
  expect(requests[0]?.ids).toEqual(["a"]);
  const disposeMenu = renderMenu(pill, () => current(), container);
  childrenListener?.({ status: "error", children: [] });
  expect(container.textContent).toContain("Could not load child sessions.");
  childrenListener?.({ status: "ready", children: [{ sessionId: "child", label: "Worker" }] });
  expect(container.querySelector('.qg-cache-child [role="img"]')?.getAttribute("aria-label")).toBe(
    "Cache observation unknown",
  );
  expect(container.textContent).not.toContain("Could not load child sessions.");
  expect(requests[0]?.signal.aborted).toBe(true);
  await flush();
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

  // Exactly one popup-wide detail overlay; focus alone never opens it.
  const childButton = container.querySelector<HTMLButtonElement>(
    ".qg-cache-child button.qg-cache-danger",
  );
  const mainButton = container.querySelector<HTMLButtonElement>(
    ".qg-cache-row:not(.qg-cache-child) button.qg-cache-warning",
  );
  const tooltipNode = () => container.querySelector<HTMLElement>('[role="tooltip"]');
  expect(childButton?.getAttribute("aria-label")).toBe("Cache details for Worker");
  expect(container.querySelectorAll('[role="tooltip"]').length).toBe(0);
  childButton?.focus();
  expect(document.activeElement).toBe(childButton);
  expect(tooltipNode()).toBeNull();
  // Hover opens the single overlay.
  childButton?.dispatchEvent(new Event("pointerenter"));
  expect(tooltipNode()?.hidden).toBe(false);
  expect(childButton?.getAttribute("aria-describedby")).toBe(tooltipNode()?.id);
  expect(tooltipNode()?.textContent).toBe("Invalidation observed");
  // Hovering the other dot moves the one overlay; no second bubble appears.
  mainButton?.dispatchEvent(new Event("pointerenter"));
  expect(container.querySelectorAll('[role="tooltip"]').length).toBe(1);
  expect(tooltipNode()?.textContent).toContain("Reuse not verified");
  // Escape closes; blur and hover-out close too.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(tooltipNode()).toBeNull();
  expect(childButton?.getAttribute("aria-describedby")).toBeNull();
  const escapeListener = addListener.mock.calls.filter(([type]) => type === "keydown").at(-1)?.[1];
  childButton?.dispatchEvent(new Event("pointerenter"));
  expect(tooltipNode()?.hidden).toBe(false);
  childButton?.dispatchEvent(new Event("pointerleave"));
  expect(tooltipNode()?.hidden).toBe(false); // the scheduled close has not elapsed
  await flush();
  mainButton?.focus();
  expect(tooltipNode()).toBeNull();
  mainButton?.dispatchEvent(new Event("pointerenter"));
  expect(tooltipNode()?.hidden).toBe(false);
  expect(tooltipNode()?.textContent).toContain(
    "Last completed primary call · host-reported cache read",
  );
  mainButton?.blur();
  expect(tooltipNode()).toBeNull();
  // A deliberate press (click, Enter, Space on the button) pins the overlay.
  childButton?.dispatchEvent(new Event("pointerenter"));
  childButton?.click();
  expect(tooltipNode()?.hidden).toBe(false);
  childButton?.dispatchEvent(new Event("pointerleave"));
  await flush();
  expect(tooltipNode()?.hidden).toBe(false); // pinned survives hover-out
  childButton?.click();
  expect(tooltipNode()).toBeNull();
  expect(removeListener).toHaveBeenCalledWith("keydown", escapeListener);

  const callsAfterLiveUpdate = bootstrapHistory.mock.calls.length;
  listeners.get("a")?.();
  expect(bootstrapHistory).toHaveBeenCalledTimes(callsAfterLiveUpdate);
  expect(container.textContent).toContain("Worker");
  expect(container.querySelector("hr")).not.toBeNull();
  expect(container.textContent).toContain("Main title");
  expect(container.textContent).not.toContain("\u202e");
  childrenListener?.({
    status: "ready",
    children: [{ sessionId: "child2", label: "Second worker" }],
  });
  expect(container.textContent).not.toContain("Worker");
  expect(container.textContent).toContain("Second worker");
  // The listener registered for session a must be inert after the switch.
  const oldChildrenListener = childrenListener;
  setCurrent(b);
  expect(requests.at(-2)?.signal.aborted).toBe(true);
  await flush();
  oldChildrenListener?.({
    status: "ready",
    children: [{ sessionId: "stale", label: "Stale child" }],
  });
  expect(container.textContent).not.toContain("Stale child");
  expect(requests.at(-1)?.ids).toEqual(["b"]);
  await vi.waitFor(() => expect(container.textContent).toContain("Second"));
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

it("reopening the popover neither rediscovers children nor refetches session metadata", async () => {
  const a = session("a");
  const listChildren = vi.fn(async () => [{ id: "child", parentID: "a", title: "Worker" }]);
  const runtime = mockRuntime(
    mockCacheObserver({
      subscribeChildren: (
        _id: string,
        listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
      ) => {
        listener({ status: "ready", children: [{ sessionId: "child", label: "Worker" }] });
        return () => {};
      },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  const first = renderMenu(pill, () => a, container);
  await flush();
  expect(container.textContent).toContain("Worker");
  expect(container.textContent).not.toContain("Loading child sessions…");
  const callsAfterFirstOpen = listChildren.mock.calls.length;
  first();
  const second = renderMenu(pill, () => a, container);
  await flush();
  // Same selection: the cached list and metadata render immediately, with no
  // loading note and no second discovery.
  expect(container.textContent).toContain("Worker");
  expect(container.textContent).not.toContain("Loading child sessions…");
  expect(listChildren.mock.calls.length).toBe(callsAfterFirstOpen);
  second();
  dispose();
  container.remove();
});

it("does not restart an unchanged history batch when observations update", async () => {
  const a = session("a");
  const bootstrapHistory = vi.fn(() => Promise.resolve());
  const runtime = mockRuntime(mockCacheObserver({ bootstrapHistory }));
  const { dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  expect(bootstrapHistory).toHaveBeenCalledTimes(1);
  expect(bootstrapHistory.mock.calls[0]?.[0]).toEqual(["a"]);
  await flush();
  dispose();
  expect(bootstrapHistory).toHaveBeenCalledTimes(1);
});

it("sorts child rows least recent to most recent, ending directly above the divider", async () => {
  const a = session("a");
  const metas: Record<string, NativeCacheObserverSessionMeta> = {
    c_new: { updatedAtMs: 300 },
    c_old: { createdAtMs: 90, updatedAtMs: 100 },
    c_mid: { createdAtMs: 200 },
  };
  const runtime = mockRuntime(
    mockCacheObserver({
      metadata: (id: string) => metas[id],
      subscribeChildren: (
        _id: string,
        listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
      ) => {
        listener({
          status: "ready",
          children: [
            { sessionId: "c_new", label: "Newest" },
            { sessionId: "c_none", label: "No stamp" },
            { sessionId: "c_old", label: "Oldest" },
            { sessionId: "c_mid", label: "Middle" },
          ],
        });
        return () => {};
      },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => a, container);
  const titles = [...container.querySelectorAll(".qg-cache-child .qg-cache-title")].map(
    (node) => node.textContent,
  );
  // Unknown recency sorts first; the most recent child sits against the divider.
  expect(titles).toEqual(["No stamp", "Oldest", "Middle", "Newest"]);
  const childrenSection = container.querySelector(".qg-cache-children");
  const divider = container.querySelector("hr");
  expect(divider?.previousElementSibling).toBe(childrenSection);
  dispose();
  container.remove();
});

it("labels rows with agent, provider, model and effort when authoritative metadata exists", async () => {
  const a = session("a");
  const metas: Record<string, NativeCacheObserverSessionMeta> = {
    a: {
      title: "Main\u202e session",
      agent: "build",
      model: { providerID: "zai", id: "glm-test", variant: "max" },
    },
    c_full: {
      title: "Worker\u202e name",
      agent: "general",
      model: { providerID: "anthropic", id: "claude-test", variant: "high" },
    },
    c_plain: { title: "Plain worker" },
  };
  const runtime = mockRuntime(
    mockCacheObserver({
      metadata: (id: string) => metas[id],
      subscribeChildren: (
        _id: string,
        listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
      ) => {
        listener({
          status: "ready",
          children: [
            { sessionId: "c_full", label: "Worker\u202e name" },
            { sessionId: "c_plain", label: "Plain worker" },
          ],
        });
        return () => {};
      },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => a, container);
  const titles = [...container.querySelectorAll(".qg-cache-title")].map((node) => node.textContent);
  expect(titles).toContain("[general] anthropic / claude-test#high Worker name");
  expect(titles).toContain("Plain worker");
  expect(titles).toContain("[build] zai / glm-test#max Main session");
  expect(container.textContent).not.toContain("\u202e");
  dispose();
  container.remove();
});

it("shows the confirmed-busy spinner only from host status evidence, left of the dot", async () => {
  const main = session("ses_main");
  let eventListener: ((event: unknown) => void) | undefined;
  let reconnect = () => {};
  let activeSessions: readonly string[] = [];
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: (listener) => {
      eventListener = listener;
      return () => {};
    },
    subscribeReconnect: (listener) => {
      reconnect = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [{ id: "ses_child", parentID: "ses_main", title: "Worker" }],
    listMessages: async () => ({ data: [], cursor: { next: null } }),
    listActiveSessions: async () => activeSessions,
  });
  const runtime = mockRuntime({ ...observer });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => main } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  // Before the first authoritative snapshot nothing is known.
  expect(observer.status("ses_child")).toBe("unknown");
  await flush();
  renderMenu(pill, () => main, container);
  await vi.waitFor(() => expect(container.textContent).toContain("Worker"));
  const busySlot = () => container.querySelector<HTMLElement>(".qg-cache-child .qg-cache-busy");
  // The empty public session.active snapshot confirms idle: no spinner.
  expect(observer.status("ses_child")).toBe("idle");
  expect(busySlot()?.getAttribute("data-busy")).toBe("false");
  // A relayed host status event confirms busy: the spinner draws.
  eventListener?.({
    type: "session.status",
    created: Date.now(),
    data: { sessionID: "ses_child", state: "busy" },
  });
  expect(observer.status("ses_child")).toBe("busy");
  expect(busySlot()?.getAttribute("data-busy")).toBe("true");
  expect(busySlot()?.textContent).toContain("Running");
  // Another relayed event clears it without any polling.
  eventListener?.({
    type: "session.status",
    created: Date.now(),
    data: { sessionID: "ses_child", state: "idle" },
  });
  expect(observer.status("ses_child")).toBe("idle");
  expect(busySlot()?.getAttribute("data-busy")).toBe("false");
  expect(busySlot()?.textContent).not.toContain("Running");
  // A reconnect reconciles from the public session.active snapshot.
  activeSessions = ["ses_child"];
  reconnect();
  await vi.waitFor(() => expect(observer.status("ses_child")).toBe("busy"));
  expect(busySlot()?.getAttribute("data-busy")).toBe("true");
  // A deleted session leaves no status residue.
  eventListener?.({ type: "session.deleted", data: { sessionID: "ses_child" } });
  await vi.waitFor(() => expect(container.textContent).not.toContain("Worker"));
  dispose();
  observer.dispose();
  container.remove();
});

it("reorders and relabels a child row when a metadata update event lands", async () => {
  const main = session("ses_order_main");
  let emit: ((event: unknown) => void) | undefined;
  const records: Array<Record<string, unknown>> = [
    { id: "ses_order_a", parentID: "ses_order_main", title: "Older worker", timeUpdatedMs: 100 },
    { id: "ses_order_b", parentID: "ses_order_main", title: "Newer worker", timeUpdatedMs: 200 },
  ];
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: (listener) => {
      emit = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => records as never,
    listMessages: async () => ({ data: [], cursor: { next: null } }),
  });
  const runtime = mockRuntime({ ...observer });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => main } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => main, container);
  const titles = () =>
    [...container.querySelectorAll(".qg-cache-child .qg-cache-title")].map(
      (node) => node.textContent,
    );
  await vi.waitFor(() => expect(titles()).toEqual(["Older worker", "Newer worker"]));

  // A live rename plus model selection dates the session's activity: the row
  // relabels and moves to the most recent position, against the divider.
  emit?.({
    type: "session.metadata",
    created: 300,
    data: {
      sessionID: "ses_order_a",
      title: "Promoted worker",
      model: { providerID: "anthropic", id: "claude-test", variant: "high" },
    },
  });
  await vi.waitFor(() =>
    expect(titles()).toEqual(["Newer worker", "anthropic / claude-test#high Promoted worker"]),
  );
  dispose();
  observer.dispose();
  container.remove();
});

it("a mounted spinner clears when event coverage is lost, not only in runtime state", async () => {
  const main = session("ses_cover_main");
  let reconnect = () => {};
  let notifyConnection: (state: "live" | "reconnecting") => void = () => {};
  let activeSessions: readonly string[] = [];
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: () => () => {},
    subscribeRpcConnection: (listener) => {
      notifyConnection = listener;
      return () => {};
    },
    subscribeReconnect: (listener) => {
      reconnect = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [
      { id: "ses_cover_child", parentID: "ses_cover_main", title: "Worker" },
    ],
    listMessages: async () => ({ data: [], cursor: { next: null } }),
    listActiveSessions: async () => activeSessions,
  });
  const runtime = mockRuntime({ ...observer });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => main } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => main, container);
  const busySlot = () => container.querySelector<HTMLElement>(".qg-cache-child .qg-cache-busy");
  activeSessions = ["ses_cover_child"];
  reconnect();
  await vi.waitFor(() => expect(busySlot()?.getAttribute("data-busy")).toBe("true"));

  // A real disconnect marks the observation gap over the RPC connection: the
  // transport-aware history path takes its disconnect branch (no revision
  // bump), so only the cleared-status notification can re-render the row —
  // synchronously, leaving no stale busy frame.
  notifyConnection("reconnecting");
  expect(observer.status("ses_cover_child")).toBe("unknown");
  expect(busySlot()?.getAttribute("data-busy")).toBe("false");
  dispose();
  observer.dispose();
  container.remove();
});

it("keeps the detail overlay open while the pointer moves from the dot into the bubble", async () => {
  vi.useFakeTimers();
  const a = session("a");
  const observations = new Map<string, CacheObserverClassification>();
  const listeners = new Map<string, () => void>();
  const runtime = mockRuntime(
    mockCacheObserver({
      subscribe: (id: string, listener: () => void) => {
        listeners.set(id, listener);
        return () => listeners.delete(id);
      },
      query: (id: string) => observations.get(id),
    }),
  );
  observations.set("a", {
    color: "red",
    reason: "known-invalidation",
  } as CacheObserverClassification);
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => a, container);
  const dot = container.querySelector<HTMLButtonElement>("button.qg-cache-indicator");
  const tooltip = () => container.querySelector<HTMLElement>('[role="tooltip"]');
  dot?.dispatchEvent(new Event("pointerenter"));
  expect(tooltip()?.hidden).toBe(false);
  dot?.dispatchEvent(new Event("pointerleave"));
  expect(tooltip()?.hidden).toBe(false);
  // Entering the bubble cancels the scheduled close.
  tooltip()?.dispatchEvent(new Event("pointerenter"));
  vi.advanceTimersByTime(300);
  expect(tooltip()?.hidden).toBe(false);
  // Leaving the bubble closes it after the grace delay.
  tooltip()?.dispatchEvent(new Event("pointerleave"));
  expect(tooltip()?.hidden).toBe(false);
  vi.advanceTimersByTime(139);
  expect(tooltip()?.hidden).toBe(false);
  vi.advanceTimersByTime(1);
  // The single overlay unmounts entirely once closed.
  expect(container.querySelector('[role="tooltip"]')).toBeNull();
  dispose();
  container.remove();
});

it("carries the estimate's source, time and assumption in the detail bubble", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const a = session("a");
  const route = {
    providerId: "anthropic",
    modelId: "test",
    protocolId: "anthropic-messages",
    basis: { source: "test", reference: "route" },
  };
  const state = setCacheTtlEvidence(
    observeCacheInvocation(createCacheObserverState({ sessionId: a.id, route }), {
      sessionId: a.id,
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
      basis: { source: "configured ttl source", reference: "ttl-ref" },
    },
  );
  const observed = classifyCacheObserverState(state, Date.now());
  expect(observed.color).toBe("green");
  expect(observed.ttlEstimate?.source).toBe("configured ttl source");
  const runtime = mockRuntime(mockCacheObserver({ query: () => observed }));
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => a, container);
  const dot = container.querySelector<HTMLButtonElement>("button.qg-cache-indicator");
  dot?.dispatchEvent(new Event("pointerenter"));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Estimated within retention");
  expect(tooltip?.textContent).toContain("Estimated expiry ·");
  expect(tooltip?.textContent).toContain("Retention basis · configured ttl source");
  expect(tooltip?.textContent).toContain("physical provider expiry is not observable");
  // The pill renders the estimate as its own tone without asserting physical cache.
  expect(pill.show({ session: a } as ComposerPillProps)).toMatchObject({
    label: "Cache 80%",
    tone: "success",
    icon: "outline-cookie",
    title: "Cache observation",
  });
  dispose();
  container.remove();
});

it("renders the estimated-expiry red state with its historical provenance", async () => {
  vi.useFakeTimers();
  const a = session("a");
  const observed = {
    color: "red",
    reason: "estimated-ttl-expired",
    confidence: "best-effort",
    ttlEstimate: {
      kind: "configured",
      ttlMs: 300_000,
      source: "configured ttl source",
      reference: "ttl-ref",
      assumption: "physical provider expiry is not observable",
      dispatchAtMs: 1_000,
      deadlineAtMs: 301_000,
    },
    primaryCacheReadRatio: { value: 0.8, observedAtMs: 1_100 },
  } as CacheObserverClassification;
  const runtime = mockRuntime(mockCacheObserver({ query: () => observed }));
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => a } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => a, container);
  expect(pill.show({ session: a } as ComposerPillProps)).toMatchObject({
    label: "Cache 80%",
    tone: "danger",
  });
  const dot = container.querySelector<HTMLButtonElement>("button.qg-cache-danger");
  dot?.dispatchEvent(new Event("pointerenter"));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Estimated retention elapsed");
  expect(tooltip?.textContent).toContain("Estimated expiry elapsed ·");
  expect(tooltip?.textContent).toContain("Last qualifying call started ·");
  expect(tooltip?.textContent).toContain("Retention basis · configured ttl source");
  dispose();
  container.remove();
});

it("clears pending loading on RPC loss and starts only the selected session on recovery", async () => {
  const a = session("a");
  const b = session("b");
  type Transport = { rpc: "live" | "reconnecting"; hostEvents: "observed" };
  let notifyTransport: (value: Transport) => void = () => {};
  const requests: Array<{ ids: readonly string[]; signal: AbortSignal }> = [];
  const runtime = mockRuntime(
    mockCacheObserver({
      subscribeTransport: (listener: (value: Transport) => void) => {
        notifyTransport = listener;
        return () => {};
      },
      bootstrapHistory: (ids: readonly string[], signal: AbortSignal) => {
        requests.push({ ids, signal });
        return new Promise<void>(() => {});
      },
    }),
  );
  let setCurrent!: (value: typeof a) => void;
  const { pill, dispose } = createRoot((cleanup) => {
    const [current, set] = createSignal(a);
    setCurrent = set;
    return {
      pill: createCacheComposerPill({ current } as unknown as Sessions, runtime),
      dispose: cleanup,
    };
  });
  await flush();
  expect(requests[0]?.ids).toEqual(["a"]);
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache · Loading…");
  notifyTransport({ rpc: "reconnecting", hostEvents: "observed" });
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("Cache");
  setCurrent(b);
  expect(pill.show({ session: b } as ComposerPillProps)?.label).toBe("Cache");
  notifyTransport({ rpc: "live", hostEvents: "observed" });
  await flush();
  expect(requests.at(-1)?.ids).toEqual(["b"]);
  expect(pill.show({ session: b } as ComposerPillProps)?.label).toBe("Cache · Loading…");
  dispose();
  expect(requests.at(-1)?.signal.aborted).toBe(true);
});

it("marks a collapsed history error without exposing technical details", async () => {
  const sessionRef = session("error");
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: () => () => {},
    rpcConnection: () => "live",
    listChildren: async () => [],
    listMessages: async () => {
      throw new Error("private server error");
    },
  });
  const runtime = mockRuntime({ ...observer });
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)).toMatchObject({
      label: "Cache",
      icon: "warning",
      tone: "warning",
      title: "Cache observation",
    }),
  );
  const container = document.createElement("div");
  const close = renderMenu(pill, () => sessionRef, container);
  expect(container.textContent).toContain("Could not load cache history.");
  expect(container.textContent).not.toContain("private server error");
  close();
  dispose();
  observer.dispose();
});

it("does not interpret a real configured-minimum classification as verified expiry", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const sessionRef = session("timer");
  const route = {
    providerId: "anthropic",
    modelId: "test",
    protocolId: "anthropic-messages",
    basis: { source: "test", reference: "route" },
  };
  const state = setCacheTtlEvidence(
    observeCacheInvocation(createCacheObserverState({ sessionId: sessionRef.id, route }), {
      sessionId: sessionRef.id,
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
  const runtime = mockRuntime(mockCacheObserver({ query: () => observed }));
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  expect(pill.show({ session: sessionRef } as ComposerPillProps)).toMatchObject({
    label: "Cache 80%",
    tone: "success",
  });
  expect(vi.getTimerCount()).toBe(0);
  dispose();
});

it("reboots history after a shared stream gap without an RPC disconnect", async () => {
  const sessionRef = session("gap");
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
  const runtime = mockRuntime({ ...observer });
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe("Cache 80%"),
  );
  expect(listMessages).toHaveBeenCalledTimes(1);
  retire();
  await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe("Cache 80%"),
  );
  dispose();
  observer.dispose();
});

it.each([
  "empty",
  "in-flight",
] as const)("retries %s history after a stream gap", async (scenario) => {
  const sessionRef = session("gap-empty");
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
  const runtime = mockRuntime({ ...observer });
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await vi.waitFor(() => expect(calls).toBe(1));
  if (scenario === "empty")
    await vi.waitFor(() =>
      expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe("Cache"),
    );
  retire();
  if (scenario === "in-flight") expect(firstSignal?.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe("Cache 80%"),
  );
  expect(calls).toBe(2);
  dispose();
  observer.dispose();
});

it("renders real history bootstrap results independently without exposing message content", async () => {
  const sessionRef = session("main");
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
    getSessionMetadata: async () => ({ title: "Main\u202e title" }),
    listMessages,
  });
  const runtime = mockRuntime({ ...observer });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe("Cache 82%"),
  );
  // Child history now loads with the selection, so both reads happen up front.
  expect(listMessages.mock.calls.map(([input]) => input.sessionID)).toEqual(["main", "child"]);
  const close = renderMenu(pill, () => sessionRef, container);
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

it("uses neutral, estimated and danger tones with the catalog cache icon", () => {
  const sessionRef = session("tone");
  let observed: CacheObserverClassification | undefined;
  let update = () => {};
  let updateTransport: (value: { rpc: "live"; hostEvents: "observed" | "unavailable" }) => void =
    () => {};
  const runtime = mockRuntime(
    mockCacheObserver({
      subscribeTransport: (listener: typeof updateTransport) => {
        updateTransport = listener;
        return () => {};
      },
      subscribe: (_id: string, listener: () => void) => {
        update = listener;
        return () => {};
      },
      query: () => observed,
    }),
  );
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  const show = () => pill.show({ session: sessionRef } as ComposerPillProps)!;
  expect(show()).toMatchObject({ icon: "outline-cookie", title: "Cache observation" });
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
  // Green is an estimate bound to a configured window; it renders as success,
  // never as a physical-cache claim.
  expect(show().tone).toBe("success");
  expect(show().label).toBe("Cache 82%");
  updateTransport({ rpc: "live", hostEvents: "unavailable" });
  // Without host-event coverage a past green result is downgraded to yellow.
  expect(show().tone).toBe("warning");
  expect(show().label).not.toContain("m");
  observed = { color: "red", reason: "known-invalidation" } as CacheObserverClassification;
  update();
  expect(show().tone).toBe("danger");
  dispose();
});
