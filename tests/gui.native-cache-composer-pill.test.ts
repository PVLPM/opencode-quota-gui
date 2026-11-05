import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComposerPill, ComposerPillProps, Sessions } from "@opencode/plugin/gui";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { CacheObserverClassification } from "../src/lib/cache-observer.js";
import type { NativeCacheObserverChildrenSnapshot } from "../src/native/cache-observer-runtime.js";
import type { NativeDashboardRuntime } from "../src/native/runtime.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let server: ViteDevServer;
let solid: typeof import("solid-js");
let createPill: typeof import("../src/native/cache-composer-pill.js").createCacheComposerPill;
beforeAll(async () => {
  server = await createIsolatedViteServer({
    configFile: false,
    root,
    resolve: {
      alias: [
        { find: /^solid-js$/, replacement: path.join(root, "node_modules/solid-js/dist/solid.js") },
      ],
    },
    ssr: { noExternal: ["solid-js"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  solid = await server.ssrLoadModule("solid-js");
  ({ createCacheComposerPill: createPill } = await server.ssrLoadModule(
    path.join(root, "src/native/cache-composer-pill.ts"),
  ));
});
afterAll(async () => server?.close());

function setup(initialQuery?: (id: string) => CacheObserverClassification | undefined) {
  const a = { key: "server\na", id: "a", server: { builtin: true, connected: true } };
  const b = { key: "server\nb", id: "b", server: { builtin: true, connected: true } };
  const listeners = new Map<string, (snapshot: NativeCacheObserverChildrenSnapshot) => void>();
  const releasedChildren: string[] = [];
  const subscribeChildren = vi.fn(
    (id: string, listener: (snapshot: NativeCacheObserverChildrenSnapshot) => void) => {
      listeners.set(id, listener);
      return () => {
        releasedChildren.push(id);
      };
    },
  );
  const releases: string[] = [];
  const subscribe = vi.fn((id: string) => () => releases.push(id));
  const query = vi.fn((id: string): CacheObserverClassification | undefined =>
    initialQuery
      ? initialQuery(id)
      : id === "child"
        ? { color: "red", reason: "known-invalidation" }
        : undefined,
  );
  let notifyTransport: (value: { rpc: string; hostEvents: string }) => void = () => {};
  const transport = { rpc: "live", hostEvents: "observed" };
  const runtime = {
    cacheObserver: {
      subscribeChildren,
      subscribe,
      query,
      transport: () => transport,
      subscribeTransport: (listener: typeof notifyTransport) => {
        notifyTransport = listener;
        return () => {};
      },
    },
  } as unknown as NativeDashboardRuntime;
  let pill!: ComposerPill;
  let setCurrent!: (session: typeof a) => unknown;
  const dispose = solid.createRoot((end) => {
    const [current, set] = solid.createSignal(a);
    setCurrent = set;
    pill = createPill({ current, list: () => [a, b] } as unknown as Sessions, runtime);
    return end;
  });
  const show = (session: typeof a) => pill.show({ session } as ComposerPillProps);
  return {
    a,
    b,
    listeners,
    subscribeChildren,
    releasedChildren,
    releases,
    subscribe,
    query,
    show,
    setCurrent,
    dispose,
    notifyTransport: (value: typeof transport) => notifyTransport(value),
  };
}

it("tracks child creation, deletion and reconnect independently", () => {
  const t = setup();
  expect(t.subscribeChildren).toHaveBeenCalledTimes(1);
  t.listeners.get("a")?.({ status: "ready", children: [{ sessionId: "child", label: "Worker" }] });
  expect(t.show(t.a)?.rows?.map((row) => row.label)).toEqual(["Worker", "Main"]);
  expect(t.show(t.a)?.rows?.[0]?.tone).toBe("danger");
  expect(t.subscribe.mock.calls.map(([id]) => id)).toEqual(["a", "child"]);
  t.listeners.get("a")?.({
    status: "ready",
    children: [
      { sessionId: "child", label: "Worker" },
      { sessionId: "child2", label: "Second" },
    ],
  });
  expect(t.subscribe.mock.calls.map(([id]) => id)).toEqual(["a", "child", "child2"]);
  expect(t.releases).not.toContain("child");
  t.listeners.get("a")?.({ status: "ready", children: [{ sessionId: "child2", label: "Second" }] });
  expect(t.releases).toContain("child");
  expect(t.show(t.a)?.rows?.map((row) => row.label)).toEqual(["Second", "Main"]);
  t.notifyTransport({ rpc: "reconnecting", hostEvents: "unavailable" });
  expect(t.releases).toContain("child2");
  t.notifyTransport({ rpc: "live", hostEvents: "observed" });
  t.listeners.get("a")?.({ status: "ready", children: [{ sessionId: "child2", label: "Second" }] });
  expect(t.subscribeChildren).toHaveBeenCalledTimes(1);
  expect(t.subscribe.mock.calls.map(([id]) => id)).toEqual(["a", "child", "child2", "a", "child2"]);
  expect(t.query.mock.calls.map(([id]) => id)).not.toContain("b");
  t.notifyTransport({ rpc: "live", hostEvents: "unavailable" });
  expect(t.show(t.a)?.rows?.[0]?.tone).toBeUndefined();
  expect(t.show(t.a)?.rows?.[0]?.detail).toContain("Host event status unverified");
  expect(t.subscribe.mock.calls.map(([id]) => id)).toEqual(["a", "child", "child2", "a", "child2"]);
  t.dispose();
  expect(t.releases).toContain("child");
});

it("never presents a green TTL classification as current after clock expiry", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1);
    const t = setup(() =>
      Date.now() < 100
        ? {
            color: "green",
            reason: "observed-reuse-with-active-ttl",
            verifiedExpiresAtMs: 150,
            recheckAtMs: 100,
          }
        : { color: "yellow", reason: "ttl-expired" },
    );
    const retained = t.show(t.a);
    expect(retained?.tone).toBe("success");
    expect(retained?.rows?.at(-1)?.detail).toContain("remaining at");
    const before = t.query.mock.calls.length;
    vi.advanceTimersByTime(99);
    expect(t.query.mock.calls.length).toBeGreaterThan(before);
    expect(t.show(t.a)?.rows?.at(-1)?.detail).toContain("Verified cache lifetime expired");
    expect(t.show(t.a)?.tone).toBe("warning");
    t.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it("labels a supplied primary ratio as historical and makes missing values explicit", () => {
  const t = setup();
  t.query.mockImplementation(() => ({
    color: "yellow",
    reason: "ttl-unverified",
    primaryCacheReadRatio: {
      value: 0.625,
      messageId: "message",
      observedAtMs: 1_000,
      numerator: "cache-read",
      denominator: "fresh+read+write",
      basis: { source: "test", reference: "message" },
    },
  }));
  const supplied = t.show(t.a)?.rows?.at(-1)?.detail;
  expect(supplied).toContain("Last primary read: 62.5%");
  expect(supplied).toContain("1970-01-01T00:00:01.000Z");
  expect(supplied).toContain("Expiry time unavailable");
  expect(supplied).toContain("Live status unknown");
  t.query.mockImplementation(() => ({ color: "gray", reason: "insufficient-evidence" }));
  const missing = t.show(t.a)?.rows?.at(-1)?.detail;
  expect(missing).toContain("Primary read unavailable");
  expect(missing).toContain("Expiry time unavailable");
  expect(missing).not.toContain("%");
  t.dispose();
});

it("cancels an old session's deadline on route change and unmount", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1);
    const t = setup((id) =>
      id === "a"
        ? {
            color: "green",
            reason: "observed-reuse-with-active-ttl",
            verifiedExpiresAtMs: 100,
            recheckAtMs: 50,
          }
        : undefined,
    );
    t.setCurrent(t.b);
    t.query.mockClear();
    vi.advanceTimersByTime(50);
    expect(t.query.mock.calls.map(([id]) => id)).not.toContain("a");
    t.setCurrent(t.a);
    t.dispose();
    t.query.mockClear();
    vi.advanceTimersByTime(100);
    expect(t.query).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("does not invent an expiry or green state when deadlines are absent", () => {
  const t = setup(() => ({ color: "green", reason: "observed-reuse-with-active-ttl" }));
  expect(t.show(t.a)?.tone).toBe("warning");
  expect(t.show(t.a)?.rows?.at(-1)?.detail).toContain("Expiry time unavailable");
  t.dispose();
});

it("reports discovery failure and does not present it as an empty child list", () => {
  const t = setup();
  t.listeners.get("a")?.({ status: "error", children: [] });
  expect(t.show(t.a)?.rows?.[0]?.label).toBe("Child sessions unavailable");
  expect(t.show(t.a)?.rows?.[1]?.label).toBe("Main");
  t.dispose();
});

it("ignores old notifications after switching sessions or disposal", () => {
  const t = setup();
  const old = t.listeners.get("a");
  t.setCurrent(t.b);
  expect(t.releasedChildren).toContain("a");
  old?.({ status: "ready", children: [{ sessionId: "old-child", label: "Old" }] });
  expect(t.show(t.b)?.rows?.map((row) => row.label)).not.toContain("Old");
  expect(t.subscribe.mock.calls.map(([id]) => id)).not.toContain("old-child");
  t.listeners.get("b")?.({ status: "ready", children: [] });
  expect(t.show(t.b)?.rows?.map((row) => row.label)).toEqual(["Main"]);
  t.setCurrent(t.a);
  const late = t.listeners.get("a");
  t.dispose();
  late?.({ status: "ready", children: [{ sessionId: "late", label: "Late" }] });
  expect(t.subscribe.mock.calls.map(([id]) => id)).not.toContain("late");
});
