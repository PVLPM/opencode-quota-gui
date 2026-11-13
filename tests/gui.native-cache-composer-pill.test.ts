// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComposerPillMenuProps, ComposerPillProps, Sessions } from "@opencode/plugin/gui";
import { createEffect, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, expect, it, vi } from "vitest";
import type { CacheObserverClassification } from "../src/lib/cache-observer.js";
import {
  classifyCacheObserverState,
  createCacheObserverState,
  observeCacheInvocation,
} from "../src/lib/cache-observer.js";
import { projectOpenCodeCacheObserverEvent } from "../src/lib/cache-observer-ingestion.js";
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

it("provides an accessible cache legend and uses a native cache icon", () => {
  const current = session("legend");
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((dispose) => ({
    dispose,
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(mockCacheObserver()),
      {
        Icon: ({ name }) => {
          const icon = document.createElement("span");
          icon.dataset.nativeIcon = name;
          return icon;
        },
      },
    ),
  }));
  const close = renderMenu(pill, () => current, container);
  expect(pill.show({ session: current } as ComposerPillProps)?.icon).toBe("server");
  const info = container.querySelector<HTMLButtonElement>(
    'button[aria-label="About cache observations"]',
  )!;
  expect(info.textContent).not.toContain("About cache observations");
  expect(container.querySelector(".qg-cache-heading")?.textContent).not.toBe("Cache observation");
  expect(info.querySelector('[data-native-icon="info"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Cache status legend"]')).toBeNull();
  info.focus();
  expect(container.querySelector('[aria-label="Cache status legend"]')).toBeNull();
  info.parentElement!.dispatchEvent(new Event("pointerenter"));
  expect(container.querySelector('[aria-label="Cache status legend"]')).toBeNull();
  info.click();
  const legend = container.querySelector('[aria-label="Cache status legend"]');
  // Concise: four short lines for the lifetime basis, the observed share, the
  // invalidation risk, and what the colors mean. Lifetimes are provider-configured
  // or empirical, and the legend never claims a lifetime is not empirical.
  // The popup shows the numbers only (3m 45s • 99.3%); this legend names them.
  // Caveats that used to sit in the status bubble live here, once.
  expect(legend?.children).toHaveLength(5);
  expect(legend?.textContent).toMatch(
    /TTL: estimated from current settings, documentation, or observed reuse\./,
  );
  expect(legend?.textContent).not.toMatch(/not (an? )?empirical/i);
  expect(legend?.textContent).toMatch(/Expiry counts from the last qualifying call/);
  expect(legend?.textContent).toMatch(
    /Cache: observed token share of the last completed primary call\./,
  );
  expect(legend?.textContent).toMatch(
    /Current settings may differ from the call's route or settings\. Prefix changes, eviction, or hidden warming can cause a miss\./,
  );
  expect(legend?.textContent).toMatch(
    /Colors: green within lifetime, yellow uncertain or near expiry/,
  );
  expect(legend?.textContent).toMatch(/Estimates, not guarantees\./);
  expect(info.getAttribute("aria-describedby")).toBe(legend?.id);
  info.click();
  expect(container.querySelector('[aria-label="Cache status legend"]')).toBeNull();
  info.click();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(container.querySelector('[aria-label="Cache status legend"]')).toBeNull();
  close();
  dispose();
  container.remove();
});

it("scrolls to the newest child once on open, not on subsequent updates", async () => {
  const current = session("scroll");
  let update!: (snapshot: NativeCacheObserverChildrenSnapshot) => void;
  const observer = mockCacheObserver({
    subscribeChildren: (_id: string, listener: typeof update) => {
      update = listener;
      return () => {};
    },
  });
  const container = document.createElement("div");
  const { pill, dispose } = createRoot((dispose) => ({
    dispose,
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(observer),
    ),
  }));
  const close = renderMenu(pill, () => current, container);
  const list = container.querySelector<HTMLElement>(".qg-cache-children")!;
  Object.defineProperty(list, "scrollHeight", { value: 500 });
  update({ status: "ready", children: [{ sessionId: "child", label: "Child" }] });
  await flush();
  expect(list.scrollTop).toBe(500);
  list.scrollTop = 25;
  update({ status: "ready", children: [{ sessionId: "child", label: "Renamed" }] });
  await flush();
  expect(list.scrollTop).toBe(25);
  close();
  dispose();
});

it("opens the chosen dashboard session without navigating from status or info controls", () => {
  const current = session("main");
  const open = vi.fn();
  const close = vi.fn();
  const observer = mockCacheObserver({
    query: () => ({ color: "red", reason: "known-invalidation" }),
    subscribeChildren: (
      _id: string,
      listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
    ) => {
      listener({ status: "ready", children: [{ sessionId: "child", label: "Child" }] });
      return () => {};
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((dispose) => ({
    dispose,
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(observer),
      undefined,
      open,
    ),
  }));
  const disposeMenu = render(
    () => pill.menu!({ session: current, close } as ComposerPillMenuProps),
    container,
  );
  const child = container.querySelector<HTMLButtonElement>(
    '.qg-cache-child button[aria-label="Open Child in dashboard"]',
  )!;
  const main = container.querySelector<HTMLButtonElement>(
    '.qg-cache-row:not(.qg-cache-child) button[aria-label="Open Loading session… in dashboard"]',
  )!;
  expect(child).not.toBeNull();
  child.focus();
  child.click(); // Native buttons synthesize click for Enter and Space.
  expect(open).toHaveBeenCalledWith(current, "child");
  expect(close).toHaveBeenCalledTimes(1);
  main.focus();
  main.click();
  expect(open).toHaveBeenLastCalledWith(current, "main");
  container.querySelector<HTMLButtonElement>(".qg-cache-child .qg-cache-indicator")!.click();
  container.querySelector<HTMLButtonElement>(".qg-cache-info")!.click();
  expect(open).toHaveBeenCalledTimes(2);
  disposeMenu();
  dispose();
  container.remove();
});

function session(id: string) {
  return { id, key: `server\n${id}`, server: { builtin: true, connected: true } };
}

function mockCacheObserver(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transport: () => ({ rpc: "live", hostEvents: "observed" }),
    subscribeTransport: () => () => {},
    subscribeGaps: () => () => {},
    subscribeModelMismatchTransitions: () => () => {},
    modelMismatch: () => ({ status: "unknown" }),
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
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("TTL — • Cache · Loading…");
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
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("TTL — • Cache 82%");
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
  const info = container.querySelector<HTMLButtonElement>(
    '[aria-label="About cache observations"]',
  )!;
  info.click();
  expect(container.querySelector('[aria-label="Cache status legend"]')).not.toBeNull();
  expect(tooltipNode()?.textContent).toBe("Invalidation observed");
  info.click();
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
  expect(tooltipNode()?.textContent).toMatch(/Cache 82% · last completed call \d{2}:\d{2}$/);
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
      query: () => ({
        color: "green",
        reason: "estimated-reuse-within-ttl",
        primaryCacheReadRatio: { value: 0.8, observedAtMs: 1000 },
        ttlEstimate: { deadlineAtMs: 2000 },
      }),
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
  expect(titles).toContain("Worker name");
  expect(titles).toContain("Plain worker");
  expect(titles).toContain("Main session");
  const rowButton = container.querySelector<HTMLButtonElement>(
    '.qg-cache-child button[aria-label="Open Worker name in dashboard"]',
  )!;
  const description = (rowButton.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .join(" ");
  expect(description).toContain("general");
  expect(description).toContain("anthropic / claude-test#high");
  expect(description).toContain("Cache 80%.");
  expect(description).toContain("TTL Expired.");
  expect(
    [...container.querySelectorAll(".qg-cache-agent")].map((node) => node.textContent),
  ).toEqual(["general", "build"]);
  expect(
    [...container.querySelectorAll(".qg-cache-model")].map((node) => node.textContent),
  ).toEqual(["anthropic / claude-test#high", "zai / glm-test#max"]);
  expect(container.textContent).not.toContain("\u202e");
  dispose();
  container.remove();
});

it("shows running text only from confirmed host status, without a loading spinner", async () => {
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
    pill: createCacheComposerPill({ current: () => main } as unknown as Sessions, runtime, {
      Icon: () => document.createElement("span"),
    }),
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
  expect(busySlot()?.querySelector("[data-native-loader]")).toBeNull();
  // A relayed host status event confirms busy.
  eventListener?.({
    type: "session.status",
    created: Date.now(),
    data: { sessionID: "ses_child", state: "busy" },
  });
  expect(observer.status("ses_child")).toBe("busy");
  expect(busySlot()?.getAttribute("data-busy")).toBe("true");
  expect(busySlot()?.querySelector("[data-native-loader]")).toBeNull();
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
  await vi.waitFor(() => expect(titles()).toEqual(["Newer worker", "Promoted worker"]));
  expect(container.querySelector(".qg-cache-child:last-child .qg-cache-model")?.textContent).toBe(
    "anthropic / claude-test#high",
  );
  dispose();
  observer.dispose();
  container.remove();
});

it("running status clears when event coverage is lost, not only in runtime state", async () => {
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
  const state = observeCacheInvocation(createCacheObserverState({ sessionId: a.id, route }), {
    sessionId: a.id,
    route,
    order: { completedAtMs: Date.now(), messageId: "msg" },
    dispatchAtMs: Date.now(),
    basis: { source: "test", reference: "call" },
    counts: { fresh: 20, read: 80, write: 0 },
  });
  const observed = classifyCacheObserverState(state, Date.now(), { configuredTtlMs: 300_000 });
  expect(observed.color).toBe("green");
  expect(observed.ttlEstimate?.source).toBe("Current host settings snapshot");
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
  // Important lines first (state, expiry), then the basis and cache share.
  const lines = [...(tooltip?.children ?? [])].map((node) => node.textContent);
  expect(lines).toEqual([
    "Estimated within retention",
    expect.stringMatching(/^Estimated expiry \d{2}:\d{2}$/),
    "Basis · Current host settings snapshot",
    expect.stringMatching(/^Cache 80% · last completed call \d{2}:\d{2}$/),
  ]);
  expect(tooltip?.children[0]?.className).toBe("qg-cache-tooltip-primary");
  expect(tooltip?.children[1]?.className).toBe("qg-cache-tooltip-primary");
  expect(tooltip?.children[2]?.className).toBe("qg-cache-tooltip-note");
  // The assumption and last-call provenance are caveats: they live under (i).
  expect(tooltip?.textContent).not.toContain("physical provider expiry");
  expect(tooltip?.textContent).not.toContain("Last qualifying call");
  // The pill renders the estimate as its own tone without asserting physical cache.
  expect(pill.show({ session: a } as ComposerPillProps)).toMatchObject({
    label: "TTL 5m 0s • Cache 80%",
    tone: "success",
    icon: "server",
    title: "Cache observation",
  });
  dispose();
  container.remove();
});

it("renders the generic fallback for Qwen from the runtime", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const main = session("ses_qwen");
  let emit: ((event: unknown) => void) | undefined;
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: (listener) => {
      emit = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [],
    now: () => Date.now(),
  });
  const runtime = mockRuntime(observer);
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => main } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  await flush();
  renderMenu(pill, () => main, container);

  const startedAt = Date.now() - 100;
  emit?.({
    type: "session.step.started",
    id: "evt_qwen_started",
    created: startedAt + 25,
    data: {
      sessionID: main.id,
      assistantMessageID: "msg_qwen",
      model: { providerID: "alibaba", id: "qwen-test" },
      started: startedAt,
    },
  });
  emit?.({
    type: "session.step.ended",
    id: "evt_qwen_ended",
    created: startedAt + 50,
    data: {
      sessionID: main.id,
      assistantMessageID: "msg_qwen",
      finish: "stop",
      tokens: { input: 20, cache: { read: 80, write: 0 } },
    },
  });

  expect(observer.query(main.id)).toMatchObject({
    color: "green",
    ttlEstimate: {
      kind: "fallback",
      source: "Generic 5-minute fallback for unknown, gateway, or OpenAI-family routes",
    },
  });
  expect(pill.show({ session: main } as ComposerPillProps)?.tone).toBe("success");

  const dot = container.querySelector<HTMLButtonElement>("button.qg-cache-success");
  dot?.dispatchEvent(new Event("pointerenter"));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Estimated within retention");
  expect(tooltip?.textContent).toContain(
    "Basis · Generic 5-minute fallback for unknown, gateway, or OpenAI-family routes",
  );
  // The assumption text is a caveat; the legend carries the general version.
  expect(tooltip?.textContent).not.toContain("Assumes 5-minute explicit/session caching");

  dispose();
  observer.dispose();
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
    label: "TTL Expired • Cache 80%",
    tone: "danger",
  });
  const dot = container.querySelector<HTMLButtonElement>("button.qg-cache-danger");
  dot?.dispatchEvent(new Event("pointerenter"));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Estimated retention elapsed");
  // The deadline is from 1970, so it is another day and carries its date.
  expect(tooltip?.textContent).toMatch(/Estimated expiry \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}/);
  expect(tooltip?.textContent).not.toContain("Last qualifying call");
  expect(tooltip?.textContent).toContain("Basis · configured ttl source");
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
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("TTL — • Cache · Loading…");
  notifyTransport({ rpc: "reconnecting", hostEvents: "observed" });
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(pill.show({ session: a } as ComposerPillProps)?.label).toBe("TTL — • Cache —");
  setCurrent(b);
  expect(pill.show({ session: b } as ComposerPillProps)?.label).toBe("TTL — • Cache —");
  notifyTransport({ rpc: "live", hostEvents: "observed" });
  await flush();
  expect(requests.at(-1)?.ids).toEqual(["b"]);
  expect(pill.show({ session: b } as ComposerPillProps)?.label).toBe("TTL — • Cache · Loading…");
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
      label: "TTL — • Cache —",
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

it("shows a useful estimate when a successful call has zero cache reads and writes", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T13:00:00Z"));
  const main = session("zero-cache");
  const route = {
    providerId: "anthropic",
    modelId: "test",
    protocolId: "anthropic-messages",
    basis: { source: "test", reference: "route" },
  };
  const state = observeCacheInvocation(createCacheObserverState({ sessionId: main.id, route }), {
    sessionId: main.id,
    route,
    order: { completedAtMs: Date.now(), messageId: "zero" },
    dispatchAtMs: Date.now(),
    basis: { source: "test", reference: "call" },
    counts: { fresh: 100, read: 0, write: 0 },
  });
  const observed = classifyCacheObserverState(state, Date.now(), { configuredTtlMs: 300_000 });
  expect(observed).toMatchObject({
    color: "green",
    reason: "estimated-within-ttl",
    primaryCacheReadRatio: { value: 0 },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => main } as unknown as Sessions,
      mockRuntime(mockCacheObserver({ query: () => observed })),
    ),
    dispose: cleanup,
  }));
  expect(pill.show({ session: main } as ComposerPillProps)).toMatchObject({
    label: "TTL 5m 0s • Cache 0%",
    tone: "success",
  });
  const close = renderMenu(pill, () => main, container);
  container
    .querySelector<HTMLButtonElement>("button.qg-cache-indicator")
    ?.dispatchEvent(new Event("pointerenter"));
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain(
    "Estimated within retention",
  );
  expect(container.querySelector('[role="tooltip"]')?.textContent).toContain("Cache 0%");
  close();
  dispose();
  container.remove();
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
  const state = observeCacheInvocation(
    createCacheObserverState({ sessionId: sessionRef.id, route }),
    {
      sessionId: sessionRef.id,
      route,
      order: { completedAtMs: Date.now(), messageId: "msg" },
      dispatchAtMs: Date.now(),
      basis: { source: "test", reference: "call" },
      counts: { fresh: 20, read: 80, write: 0 },
    },
  );
  const observed = classifyCacheObserverState(state, Date.now(), { configuredTtlMs: 300_000 });
  expect(observed.color).toBe("green");
  expect(observed).not.toHaveProperty("verifiedExpiresAtMs");
  const runtime = mockRuntime(mockCacheObserver({ query: () => observed }));
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => sessionRef } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  expect(pill.show({ session: sessionRef } as ComposerPillProps)).toMatchObject({
    label: "TTL 5m 0s • Cache 80%",
    tone: "success",
  });
  // The only timer is the shared countdown tick; it is not an expiry verdict and
  // it stops with the pill.
  expect(vi.getTimerCount()).toBe(1);
  dispose();
  expect(vi.getTimerCount()).toBe(0);
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
        finish: "stop",
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
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe(
      "TTL Expired • Cache 80%",
    ),
  );
  expect(listMessages).toHaveBeenCalledTimes(1);
  retire();
  await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe(
      "TTL Expired • Cache 80%",
    ),
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
            finish: "stop",
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
      expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe(
        "TTL — • Cache —",
      ),
    );
  retire();
  if (scenario === "in-flight") expect(firstSignal?.aborted).toBe(true);
  await vi.waitFor(() =>
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe(
      "TTL — • Cache 80%",
    ),
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
        finish: "stop",
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
    expect(pill.show({ session: sessionRef } as ComposerPillProps)?.label).toBe(
      "TTL Expired • Cache 82%",
    ),
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
  ).toBeGreaterThan(80);
  expect(container.textContent).not.toContain("PRIVATE CONTENT");
  expect(listMessages.mock.calls.map(([input]) => input.sessionID)).toEqual(["main", "child"]);
  close();
  dispose();
  observer.dispose();
  container.remove();
});

it("reacts to real model selection events without changing the cache estimate", async () => {
  const a = session("main");
  const b = session("other");
  let emit: ((event: unknown) => void) | undefined;
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: (listener) => {
      emit = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [],
    getSessionMetadata: async () => ({
      model: { providerID: "anthropic", id: "cached" },
      timeUpdatedMs: 10,
    }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, current, setCurrent, dispose } = createRoot((cleanup) => {
    const [current, setCurrent] = createSignal(a);
    return {
      pill: createCacheComposerPill(
        { current } as unknown as Sessions,
        mockRuntime({ ...observer }),
      ),
      current,
      setCurrent,
      dispose: cleanup,
    };
  });
  await vi.waitFor(() => expect(observer.metadata("main")?.model?.id).toBe("cached"));
  emit?.({
    type: "session.step.started",
    created: 20,
    data: {
      sessionID: "main",
      assistantMessageID: "msg",
      model: { providerID: "anthropic", id: "cached" },
      started: 15,
    },
  });
  emit?.({
    type: "session.step.ended",
    created: 30,
    data: {
      sessionID: "main",
      assistantMessageID: "msg",
      finish: "stop",
      tokens: { input: 100, cache: { read: 40, write: 10 } },
    },
  });
  const show = () => {
    const view = pill.show({ session: current() } as ComposerPillProps);
    if (!view) throw new Error("Expected a pill");
    return view;
  };
  const mounted = document.createElement("div");
  const unmountPill = render(() => {
    const node = document.createElement("span");
    createEffect(() => {
      const view = show();
      node.dataset.tone = view.tone ?? "neutral";
      node.title = view.title ?? "";
    });
    return node;
  }, mounted);
  const before = show();
  const unmount = renderMenu(pill, current, container);
  const select = (created: number, id: string) =>
    emit?.(
      projectOpenCodeCacheObserverEvent({
        type: "session.model.selected",
        created,
        data: { sessionID: "main", model: { providerID: "anthropic", id } },
      }),
    );
  vi.useFakeTimers();
  select(40, "other");
  expect(show()).toMatchObject({ tone: "danger", title: expect.stringContaining("differs") });
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe("danger");
  expect(
    container.querySelector(".qg-cache-row:not(.qg-cache-child) .qg-cache-danger"),
  ).not.toBeNull();
  vi.advanceTimersByTime(100);
  expect(show().tone).toBe("warning");
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe("warning");
  select(41, "other");
  vi.advanceTimersByTime(180);
  expect(show().tone).toBe("danger");
  select(50, "cached");
  expect(show()).toMatchObject({
    tone: before.tone,
    title: "Cache observation",
    label: before.label,
  });
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe(before.tone ?? "neutral");
  const media = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  select(60, "other");
  vi.advanceTimersByTime(300);
  expect(show().tone).toBe("danger");
  media.mockRestore();
  setCurrent(b);
  vi.advanceTimersByTime(500);
  expect(show().title).toBe("Cache observation");
  unmount();
  unmountPill();
  dispose();
  observer.dispose();
  container.remove();
});

/** A green estimate: a 5-minute configured window dispatched 30 seconds before `nowMs`. */
function greenCountdown(nowMs: number, ratio: number): CacheObserverClassification {
  return {
    color: "green",
    reason: "estimated-reuse-within-ttl",
    confidence: "best-effort",
    ttlSemantics: "configured-minimum",
    primaryCacheReadTelemetry: "available",
    primaryCacheReadRatio: {
      value: ratio,
      messageId: "message-1",
      observedAtMs: nowMs,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { source: "host usage", reference: "message-1" },
    },
    ttlEstimate: {
      kind: "configured",
      ttlMs: 300_000,
      source: "configured retention",
      reference: "policy",
      assumption: "configured minimum",
      dispatchAtMs: nowMs - 30_000,
      deadlineAtMs: nowMs + 270_000,
    },
  } as CacheObserverClassification;
}

it("shows the collapsed TTL countdown and cache share in one label, with only the icon toned", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const sessionRef = session("collapsed");
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => sessionRef } as unknown as Sessions,
      mockRuntime(mockCacheObserver({ query: () => greenCountdown(Date.now(), 0.987) })),
    ),
    dispose: cleanup,
  }));
  expect(pill.show({ session: sessionRef } as ComposerPillProps)).toEqual({
    label: "TTL 4m 30s • Cache 98.7%",
    icon: "server",
    tone: "success",
    title: "Cache observation",
  });
  dispose();
});

it("keeps the cache share and TTL independent, with a valid 0% share and dashes for unknown parts", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const sessionRef = session("independent");
  let observed: CacheObserverClassification | undefined;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => sessionRef } as unknown as Sessions,
      mockRuntime(mockCacheObserver({ query: () => observed })),
    ),
    dispose: cleanup,
  }));
  // The initial history bootstrap settles before the unknown state is judged.
  await flush();
  const label = () => pill.show({ session: sessionRef } as ComposerPillProps)?.label;
  observed = greenCountdown(Date.now(), 0);
  expect(label()).toBe("TTL 4m 30s • Cache 0%");
  observed = {
    ...greenCountdown(Date.now(), 0.82),
    color: "yellow",
    reason: "ttl-unverified",
    ttlEstimate: undefined,
  } as CacheObserverClassification;
  expect(label()).toBe("TTL — • Cache 82%");
  observed = undefined;
  expect(label()).toBe("TTL — • Cache —");
  dispose();
});

it("counts the TTL down each second through the reactive label and shows expiry without another show() call", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const now = Date.now();
  const sessionRef = session("countdown");
  const subscribeTransport = vi.fn(() => () => {});
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => sessionRef } as unknown as Sessions,
      mockRuntime(
        mockCacheObserver({ subscribeTransport, query: () => greenCountdown(now, 0.987) }),
      ),
    ),
    dispose: cleanup,
  }));
  const shown: string[] = [];
  const unmount = render(() => {
    const node = document.createElement("span");
    createEffect(() => {
      const view = pill.show({ session: sessionRef } as ComposerPillProps);
      shown.push(`${view?.label}|${view?.tone}`);
    });
    return node;
  }, document.createElement("div"));
  expect(shown.at(-1)).toBe("TTL 4m 30s • Cache 98.7%|success");
  vi.advanceTimersByTime(1_000);
  expect(shown.at(-1)).toBe("TTL 4m 29s • Cache 98.7%|success");
  vi.advanceTimersByTime(209_000);
  expect(shown.at(-1)).toBe("TTL 1m 0s • Cache 98.7%|success");
  vi.advanceTimersByTime(59_999);
  expect(shown.at(-1)).toBe("TTL 1s • Cache 98.7%|success");
  vi.advanceTimersByTime(1);
  // The backend still reports green until its own recheck; the pill shows
  // expiry as soon as the estimated deadline passes.
  expect(shown.at(-1)).toBe("TTL Expired • Cache 98.7%|danger");
  // One shared tick, stopped at expiry: no loop, no transport work.
  expect(vi.getTimerCount()).toBe(0);
  expect(subscribeTransport).toHaveBeenCalledTimes(1);
  unmount();
  dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("counts child rows down in the same format and names missing parts as unavailable", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const now = Date.now();
  const main = session("ttl-main");
  const runtime = mockRuntime(
    mockCacheObserver({
      query: (id: string) => (id === "ttl-child" ? greenCountdown(now, 0.987) : undefined),
      subscribeChildren: (
        _id: string,
        listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
      ) => {
        listener({ status: "ready", children: [{ sessionId: "ttl-child", label: "Worker" }] });
        return () => {};
      },
    }),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill({ current: () => main } as unknown as Sessions, runtime),
    dispose: cleanup,
  }));
  const close = renderMenu(pill, () => main, container);
  const childMetrics = () =>
    container.querySelector(".qg-cache-child .qg-cache-metrics")?.textContent;
  // Popup rows show values only; the accessible description keeps the words.
  expect(childMetrics()).toBe("4m 30s • 98.7%");
  expect(
    container.querySelector(".qg-cache-row:not(.qg-cache-child) .qg-cache-metrics")?.textContent,
  ).toBe("unknown • unknown");
  const childButton = container.querySelector<HTMLButtonElement>(
    ".qg-cache-child .qg-cache-identity",
  )!;
  const described =
    document.getElementById(childButton.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
  expect(described).toContain("TTL 4m 30s. Cache 98.7%.");
  vi.advanceTimersByTime(1_000);
  expect(childMetrics()).toBe("4m 29s • 98.7%");
  close();
  dispose();
  expect(vi.getTimerCount()).toBe(0);
  container.remove();
});

it("keeps a valid green TTL estimate and its countdown when host-event coverage is unverified", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const now = Date.now();
  const sessionRef = session("unverified-ttl");
  type Transport = { rpc: "live"; hostEvents: "observed" | "unavailable" };
  let notifyTransport: (value: Transport) => void = () => {};
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => sessionRef } as unknown as Sessions,
      mockRuntime(
        mockCacheObserver({
          subscribeTransport: (listener: (value: Transport) => void) => {
            notifyTransport = listener;
            return () => {};
          },
          // One fixed observation: its deadline must not move with the clock.
          query: () => greenCountdown(now, 0.987),
        }),
      ),
    ),
    dispose: cleanup,
  }));
  const show = () => pill.show({ session: sessionRef } as ComposerPillProps)!;
  // Owner spec: the observer's last observed estimate is shown; coverage loss
  // neither downgrades the color nor withholds the countdown.
  notifyTransport({ rpc: "live", hostEvents: "unavailable" });
  expect(show()).toMatchObject({ label: "TTL 4m 30s • Cache 98.7%", tone: "success" });
  vi.advanceTimersByTime(1_000);
  expect(show().label).toBe("TTL 4m 29s • Cache 98.7%");
  notifyTransport({ rpc: "live", hostEvents: "observed" });
  expect(show()).toMatchObject({ label: "TTL 4m 29s • Cache 98.7%", tone: "success" });
  dispose();
});

it.each([
  {
    name: "an estimate and a share",
    ttl: 225_000,
    ratio: 0.993,
    values: "3m 45s • 99.3%",
    spoken: "TTL 3m 45s. Cache 99.3%.",
  },
  {
    name: "an expired estimate",
    ttl: -1_000,
    ratio: 0.993,
    values: "Expired • 99.3%",
    spoken: "TTL Expired. Cache 99.3%.",
  },
  {
    name: "an estimate without a share",
    ttl: 225_000,
    ratio: undefined,
    values: "3m 45s • unknown",
    spoken: "TTL 3m 45s. Cache unavailable.",
  },
  {
    name: "a share without an estimate",
    ttl: undefined,
    ratio: 0.993,
    values: "unknown • 99.3%",
    spoken: "TTL unavailable. Cache 99.3%.",
  },
])("keeps popup rows to values for $name and says the words for assistive technology", ({
  ttl,
  ratio,
  values,
  spoken,
}) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const now = Date.now();
  const main = session("row-values");
  const share = greenCountdown(now, 0.993).primaryCacheReadRatio;
  const observed = {
    color: ttl === undefined ? "yellow" : ttl < 0 ? "red" : "green",
    reason:
      ttl === undefined
        ? "ttl-unverified"
        : ttl < 0
          ? "estimated-ttl-expired"
          : "estimated-reuse-within-ttl",
    ...(ratio === undefined ? {} : { primaryCacheReadRatio: { ...share, value: ratio } }),
    ...(ttl === undefined
      ? {}
      : {
          ttlEstimate: {
            kind: "configured",
            ttlMs: 300_000,
            source: "configured retention",
            reference: "policy",
            assumption: "configured minimum",
            dispatchAtMs: now - 30_000,
            deadlineAtMs: now + ttl,
          },
        }),
  } as CacheObserverClassification;
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => main } as unknown as Sessions,
      mockRuntime(mockCacheObserver({ query: () => observed })),
    ),
    dispose: cleanup,
  }));
  const close = renderMenu(pill, () => main, container);
  const row = container.querySelector(".qg-cache-row:not(.qg-cache-child)")!;
  expect(row.querySelector(".qg-cache-metrics")?.textContent).toBe(values);
  const described = document.getElementById(
    row.querySelector(".qg-cache-identity")?.getAttribute("aria-describedby") ?? "",
  );
  expect(described?.textContent).toContain(spoken);
  close();
  dispose();
  container.remove();
});

it.each([
  { name: "the same day", remainingMs: 300_000, pattern: /^Estimated expiry \d{2}:\d{2}$/ },
  {
    name: "another day",
    remainingMs: 2 * 86_400_000,
    pattern: /^Estimated expiry \d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/,
  },
])("writes status bubble times in 24-hour form for $name", ({ remainingMs, pattern }) => {
  vi.useFakeTimers();
  // 13:00 UTC: a 12-hour clock would read "PM"; the bubble must not.
  vi.setSystemTime(new Date("2026-01-01T13:00:00Z"));
  const now = Date.now();
  const main = session("clock-24h");
  const base = greenCountdown(now, 0.8);
  const observed = {
    ...base,
    ttlEstimate: { ...base.ttlEstimate!, deadlineAtMs: now + remainingMs },
  } as CacheObserverClassification;
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => main } as unknown as Sessions,
      mockRuntime(mockCacheObserver({ query: () => observed })),
    ),
    dispose: cleanup,
  }));
  const close = renderMenu(pill, () => main, container);
  container
    .querySelector<HTMLButtonElement>("button.qg-cache-indicator")
    ?.dispatchEvent(new Event("pointerenter"));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
  // State and expiry lead in bold; basis and cache share follow.
  expect([...(tooltip?.children ?? [])].map((node) => node.className)).toEqual([
    "qg-cache-tooltip-primary",
    "qg-cache-tooltip-primary",
    "qg-cache-tooltip-note",
    "qg-cache-tooltip-note",
  ]);
  expect(tooltip?.children[1]?.textContent).toMatch(pattern);
  expect(tooltip?.children[3]?.textContent).toMatch(/· last completed call \d{2}:\d{2}$/);
  expect(tooltip?.textContent).not.toMatch(/\b(AM|PM)\b/);
  close();
  dispose();
  container.remove();
});

it("keeps the popup's important values bold on the strong text token, off the weak one", () => {
  const css = readFileSync(join(process.cwd(), "src/native/native.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const cacheRules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, selector]) => selector?.includes(".qg-cache-"))
    .map(([, selector, body]) => ({ selector: selector?.trim(), body: body ?? "" }));
  const ruleFor = (selector: string) => cacheRules.find((rule) => rule.selector === selector);
  expect(ruleFor(".qg-cache-metrics")?.body).toMatch(/color:\s*var\(--text-strong/);
  expect(ruleFor(".qg-cache-metrics")?.body).toMatch(/font-weight:\s*600/);
  expect(ruleFor(".qg-cache-tooltip-primary")?.body).toMatch(/font-weight:\s*600/);
  expect(cacheRules.filter((rule) => rule.body.includes("--text-weak"))).toEqual([]);
});

it("keeps baseline and child mismatches isolated and cancels pending attention on disposal", async () => {
  const main = session("main");
  let emit: ((event: unknown) => void) | undefined;
  let reconnect: (() => void) | undefined;
  let reads = 0;
  const observer = createNativeCacheObserverRuntime({
    subscribeEvents: (listener) => {
      emit = listener;
      return () => {};
    },
    subscribeReconnect: (listener) => {
      reconnect = listener;
      return () => {};
    },
    rpcConnection: () => "live",
    listChildren: async () => [
      {
        id: "child",
        parentID: "main",
        title: "Child",
        model: { providerID: "openai", id: "selected" },
      },
    ],
    getSessionMetadata: async () => {
      reads++;
      return {
        model: { providerID: "openai", id: reads > 1 ? "reconnect" : "selected" },
        timeUpdatedMs: reads > 1 ? 100 : 10,
      };
    },
  });
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => main } as unknown as Sessions,
      mockRuntime({ ...observer }),
    ),
    dispose: cleanup,
  }));
  const mounted = document.createElement("div");
  const tones: string[] = [];
  const unmountPill = render(() => {
    const node = document.createElement("span");
    createEffect(() => {
      const tone = pill.show({ session: main } as ComposerPillProps)?.tone ?? "neutral";
      tones.push(tone);
      node.dataset.tone = tone;
    });
    return node;
  }, mounted);
  const menu = document.createElement("div");
  const unmountMenu = renderMenu(pill, () => main, menu);
  await vi.waitFor(() => expect(observer.metadata("main")?.model?.id).toBe("selected"));
  await vi.waitFor(() => expect(observer.metadata("child")?.model?.id).toBe("selected"));
  const observe = (id: string) => {
    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: id,
        assistantMessageID: `msg-${id}`,
        model: { providerID: "anthropic", id: "cached" },
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: id,
        assistantMessageID: `msg-${id}`,
        finish: "stop",
        tokens: { input: 100, cache: { read: 40, write: 10 } },
      },
    });
  };
  observe("main");
  observe("child");
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe("danger");
  const childTone = observer.query("child")?.color;
  const childButton = menu.querySelector(".qg-cache-child .qg-cache-indicator");
  expect(
    childButton?.classList.contains(
      `qg-cache-${childTone === "green" ? "success" : childTone === "red" ? "danger" : "warning"}`,
    ),
  ).toBe(true);
  tones.length = 0;
  vi.useFakeTimers();
  vi.advanceTimersByTime(500);
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe("danger");
  expect(tones).not.toContain("warning");
  reconnect?.();
  await flush(12);
  expect(observer.metadata("main")?.model?.id).toBe("reconnect");
  vi.advanceTimersByTime(500);
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe("danger");
  expect(tones).not.toContain("warning");
  emit?.({
    type: "session.metadata",
    created: 105,
    data: { sessionID: "main", model: { providerID: "anthropic", id: "cached" } },
  });
  const mainTone = mounted.firstElementChild?.getAttribute("data-tone");
  emit?.({
    type: "session.metadata",
    created: 106,
    data: { sessionID: "child", model: { providerID: "openai", id: "different" } },
  });
  vi.advanceTimersByTime(500);
  expect(mounted.firstElementChild?.getAttribute("data-tone")).toBe(mainTone);
  expect(
    childButton?.classList.contains(
      `qg-cache-${childTone === "green" ? "success" : childTone === "red" ? "danger" : "warning"}`,
    ),
  ).toBe(true);
  // A real selected-model change schedules a flash; disposal cancels it.
  emit?.({
    type: "session.metadata",
    created: 110,
    data: { sessionID: "main", model: { providerID: "openai", id: "another" } },
  });
  const beforeDispose = tones.length;
  const timersBeforeDispose = vi.getTimerCount();
  dispose();
  expect(vi.getTimerCount()).toBeLessThan(timersBeforeDispose);
  vi.advanceTimersByTime(500);
  expect(tones).toHaveLength(beforeDispose);
  unmountMenu();
  unmountPill();
  observer.dispose();
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
  expect(show()).toMatchObject({ icon: "server", title: "Cache observation" });
  expect(show().tone).toBeUndefined();
  expect(show().label).not.toContain("?");
  observed = {
    color: "yellow",
    reason: "ttl-unverified",
    primaryCacheReadRatio: { value: 0.82, observedAtMs: Date.now() },
  } as CacheObserverClassification;
  update();
  expect(show()).toMatchObject({ label: "TTL — • Cache 82%", tone: "warning" });
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
  expect(show().label).toBe("TTL — • Cache 82%");
  updateTransport({ rpc: "live", hostEvents: "unavailable" });
  // Owner spec: host-event coverage does not suppress a valid green estimate.
  expect(show().tone).toBe("success");
  expect(show().label).toBe("TTL — • Cache 82%");
  observed = { color: "red", reason: "known-invalidation" } as CacheObserverClassification;
  update();
  expect(show().tone).toBe("danger");
  dispose();
});

it("marks active positive reads with unknown retention as uncertain without a TTL claim", () => {
  const current = session("reuse-uncertain");
  const observed = {
    color: "gray",
    reason: "route-unverified",
    primaryCacheReadTelemetry: "available",
    primaryCacheReadRatio: {
      value: 0.99,
      messageId: "message-1",
      observedAtMs: 1_700_000_000_000,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { source: "host usage", reference: "message-1" },
    },
  } as CacheObserverClassification;
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(
        mockCacheObserver({
          query: () => observed,
          status: () => "busy",
        }),
      ),
    ),
    dispose: cleanup,
  }));

  expect(pill.show({ session: current } as ComposerPillProps)).toMatchObject({
    label: "TTL — • Cache 99%",
    tone: "warning",
  });

  const close = renderMenu(pill, () => current, container);
  const indicator = container.querySelector<HTMLButtonElement>(
    ".qg-cache-row:not(.qg-cache-child) button.qg-cache-indicator",
  );
  indicator?.dispatchEvent(new Event("pointerenter"));
  const tooltip = container.querySelector<HTMLElement>('[role="tooltip"]');
  expect(tooltip?.textContent).toContain("Prior cache reads; reuse uncertain");
  expect(tooltip?.textContent).not.toMatch(/ttl|expiry|next hit/i);
  close();
  dispose();
  container.remove();
});

it.each([
  ["idle", 0.99, "available", "route-unverified", "gray", undefined],
  ["unknown", 0.99, "available", "route-unverified", "gray", undefined],
  ["busy", 0, "available", "route-unverified", "gray", undefined],
  ["busy", undefined, "available", "route-unverified", "gray", undefined],
  ["busy", 0.99, "unavailable", "route-unverified", "gray", undefined],
  ["busy", 0.99, "available", "observation-gap", "gray", undefined],
  ["busy", 0.99, "available", "ambiguous-invocation", "yellow", "warning"],
] as const)("does not infer uncertain reuse from %s status, %s reads, %s telemetry, or %s evidence", (status, ratio, telemetry, reason, color, expectedTone) => {
  const current = session("reuse-uncertain-case");
  const observed = {
    color,
    reason,
    primaryCacheReadTelemetry: telemetry,
    ...(ratio === undefined
      ? {}
      : {
          primaryCacheReadRatio: {
            value: ratio,
            messageId: "message-1",
            observedAtMs: 1_700_000_000_000,
            numerator: "cache-read",
            denominator: "fresh+read+write",
            basis: { source: "host usage", reference: "message-1" },
          },
        }),
  } as CacheObserverClassification;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(
        mockCacheObserver({
          query: () => observed,
          status: () => status,
        }),
      ),
    ),
    dispose: cleanup,
  }));

  expect(pill.show({ session: current } as ComposerPillProps).tone).toBe(expectedTone);
  dispose();
});

it("does not mark prior reads uncertain while transport coverage is unverified", () => {
  const current = session("reuse-transport");
  const observed = {
    color: "gray",
    reason: "route-unverified",
    primaryCacheReadTelemetry: "available",
    primaryCacheReadRatio: {
      value: 0.99,
      messageId: "message-1",
      observedAtMs: 1_700_000_000_000,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { source: "host usage", reference: "message-1" },
    },
  } as CacheObserverClassification;
  type Transport = { rpc: "live" | "reconnecting"; hostEvents: "observed" | "unverified" };
  let transport: Transport = { rpc: "live", hostEvents: "unverified" };
  let notifyTransport: (value: Transport) => void = () => {};
  const observer = mockCacheObserver({
    transport: () => transport,
    subscribeTransport: (listener: (value: Transport) => void) => {
      notifyTransport = listener;
      listener(transport);
      return () => {};
    },
    query: () => observed,
    status: () => "busy",
  });
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(observer),
    ),
    dispose: cleanup,
  }));
  const show = () => pill.show({ session: current } as ComposerPillProps);

  expect(show().tone).toBeUndefined();
  transport = { rpc: "live", hostEvents: "observed" };
  notifyTransport(transport);
  expect(show().tone).toBe("warning");
  dispose();
});

it.each([
  ["known invalidation", "red", "known-invalidation", "danger"],
  ["expired estimate", "red", "estimated-ttl-expired", "danger"],
  ["verified estimate", "green", "estimated-reuse-within-ttl", "success"],
] as const)("preserves %s precedence over active reuse uncertainty", (_name, color, reason, tone) => {
  const current = session("reuse-precedence");
  const observed = {
    color,
    reason,
    primaryCacheReadTelemetry: "available",
    primaryCacheReadRatio: {
      value: 0.99,
      messageId: "message-1",
      observedAtMs: 1_700_000_000_000,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { source: "host usage", reference: "message-1" },
    },
    ...(color === "green"
      ? {
          ttlEstimate: {
            kind: "configured",
            ttlMs: 300_000,
            source: "configured retention",
            reference: "policy",
            assumption: "configured minimum",
            dispatchAtMs: Date.now(),
            deadlineAtMs: Date.now() + 300_000,
          },
        }
      : {}),
  } as CacheObserverClassification;
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => current } as unknown as Sessions,
      mockRuntime(
        mockCacheObserver({
          query: () => observed,
          status: () => "busy",
        }),
      ),
    ),
    dispose: cleanup,
  }));

  expect(pill.show({ session: current } as ComposerPillProps).tone).toBe(tone);
  dispose();
});

it("classifies a child session's uncertain reuse from its own active status", async () => {
  const main = session("reuse-parent");
  const statuses = new Map([
    [main.id, "busy" as const],
    ["reuse-child", "idle" as const],
  ]);
  const classification = {
    color: "gray",
    reason: "route-unverified",
    primaryCacheReadTelemetry: "available",
    primaryCacheReadRatio: {
      value: 0.99,
      messageId: "message-1",
      observedAtMs: 1_700_000_000_000,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { source: "host usage", reference: "message-1" },
    },
  } as CacheObserverClassification;
  const container = document.createElement("div");
  document.body.append(container);
  const { pill, dispose } = createRoot((cleanup) => ({
    pill: createCacheComposerPill(
      { current: () => main } as unknown as Sessions,
      mockRuntime(
        mockCacheObserver({
          query: () => classification,
          status: (id: string) => statuses.get(id) ?? "unknown",
          subscribeChildren: (
            _id: string,
            listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void,
          ) => {
            listener({
              status: "ready",
              children: [{ sessionId: "reuse-child", label: "Worker" }],
            });
            return () => {};
          },
        }),
      ),
    ),
    dispose: cleanup,
  }));

  const close = renderMenu(pill, () => main, container);
  await flush();
  expect(pill.show({ session: main } as ComposerPillProps).tone).toBe("warning");
  expect(
    container.querySelector<HTMLButtonElement>(".qg-cache-child .qg-cache-indicator")?.className,
  ).toBe("qg-cache-indicator qg-cache-neutral");
  close();
  dispose();
  container.remove();
});
