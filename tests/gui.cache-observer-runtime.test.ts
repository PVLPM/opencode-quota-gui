import { describe, expect, it, vi } from "vitest";

import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";

describe("native cache observer runtime", () => {
  it("shares the existing Native event listener across exact-session subscribers", () => {
    let receiveEvent: ((event: never) => void) | undefined;
    const releaseNativeListener = vi.fn();
    const subscribeEvents = vi.fn((listener: (event: never) => void) => {
      receiveEvent = listener;
      return releaseNativeListener;
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents,
      rpcConnection: () => "live",
      listChildren: async () => [],
      now: () => 1_700_000_000_001,
    });
    const parentListener = vi.fn();
    const childListener = vi.fn();

    const releaseParent = runtime.subscribe("ses_parent", parentListener);
    const releaseChild = runtime.subscribe("ses_child", childListener);

    expect(subscribeEvents).toHaveBeenCalledOnce();
    expect(releaseNativeListener).not.toHaveBeenCalled();
    receiveEvent?.({
      type: "session.step.ended",
      created: 1_700_000_000_000,
      data: {
        sessionID: "ses_child",
        assistantMessageID: "msg_child",
        tokens: { cache: { read: 8 } },
      },
    } as never);

    expect(runtime.query("ses_child")).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
    expect(runtime.query("ses_parent")).toBeUndefined();
    expect(parentListener).not.toHaveBeenCalled();
    expect(childListener).toHaveBeenCalledTimes(1);

    releaseParent();
    expect(releaseNativeListener).not.toHaveBeenCalled();
    releaseChild();
    expect(releaseNativeListener).toHaveBeenCalledOnce();
    expect(runtime.query("ses_child")).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });

    const remountedListener = vi.fn();
    const releaseRemounted = runtime.subscribe("ses_child", remountedListener);
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
    expect(runtime.query("ses_child")).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
    releaseRemounted();

    runtime.dispose();
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
    expect(releaseNativeListener).toHaveBeenCalledTimes(2);
  });

  it("does not attach to the Native event listener until an observer subscribes", () => {
    const subscribeEvents = vi.fn(() => vi.fn());
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents,
      rpcConnection: () => "live",
      listChildren: async () => [],
    });

    expect(runtime.query("ses_current")).toBeUndefined();
    expect(subscribeEvents).not.toHaveBeenCalled();

    runtime.dispose();
    expect(subscribeEvents).not.toHaveBeenCalled();
  });

  it("keeps RPC reachability separate from upstream event-source evidence", () => {
    let rpcConnection: "live" | "reconnecting" = "live";
    let receiveEvent: ((event: never) => void) | undefined;
    const subscribeEvents = vi.fn((listener: (event: never) => void) => {
      receiveEvent = listener;
      return vi.fn();
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents,
      listChildren: async () => [],
      rpcConnection: () => rpcConnection,
    });

    expect(runtime.transport()).toEqual({ rpc: "live", hostEvents: "unverified" });

    const release = runtime.subscribe("ses_current", vi.fn());
    receiveEvent?.({
      type: "source.status",
      created: 1_700_000_000_000,
      data: { state: "observed" },
    } as never);
    expect(runtime.transport()).toEqual({
      rpc: "live",
      hostEvents: "observed",
      lastHostEventAtMs: 1_700_000_000_000,
    });

    receiveEvent?.({
      type: "source.status",
      created: 1_700_000_000_010,
      data: { state: "unavailable" },
    } as never);
    expect(runtime.transport()).toEqual({
      rpc: "live",
      hostEvents: "unavailable",
      lastHostEventAtMs: 1_700_000_000_000,
    });

    rpcConnection = "reconnecting";
    expect(runtime.transport()).toMatchObject({
      rpc: "reconnecting",
      hostEvents: "unavailable",
    });
    release();
    runtime.dispose();
  });

  it("returns only direct child IDs and sanitized display labels", async () => {
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [
        { id: "ses_child", parentID: "ses_root", title: "  child\nlabel\u202Eignored  " },
        { id: "ses_child_empty", parentID: "ses_root", title: " \u0000 " },
        { id: "ses_grandchild", parentID: "ses_child", title: "Grandchild" },
        { id: "invalid id", parentID: "ses_root", title: "Invalid ID" },
      ],
    });

    await expect(runtime.children("ses_root")).resolves.toEqual([
      { sessionId: "ses_child", label: "child labelignored" },
      { sessionId: "ses_child_empty", label: "Untitled child session" },
    ]);
    expect(runtime.query("ses_child")).toBeUndefined();

    runtime.dispose();
  });

  it("publishes direct children as they are created or deleted and captures their events", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    const liveChildren = [{ id: "ses_existing", parentID: "ses_root", title: "Existing child" }];
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async (parentID) => liveChildren.filter((child) => child.parentID === parentID),
    });
    const snapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const release = runtime.subscribeChildren("ses_root", (snapshot) => snapshots.push(snapshot));
    await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe("ready"));
    expect(snapshots.at(-1)?.children).toEqual([
      { sessionId: "ses_existing", label: "Existing child" },
    ]);

    receiveEvent?.({
      type: "session.created",
      data: { sessionID: "ses_sibling", parentID: "ses_other_root" },
    } as never);
    expect(snapshots.at(-1)?.children).toEqual([
      { sessionId: "ses_existing", label: "Existing child" },
    ]);

    liveChildren.push({ id: "ses_new", parentID: "ses_root", title: "New child" });
    receiveEvent?.({
      type: "session.created",
      data: { sessionID: "ses_new", parentID: "ses_root" },
    } as never);
    await vi.waitFor(() =>
      expect(snapshots.at(-1)?.children.map((child) => child.sessionId)).toEqual([
        "ses_existing",
        "ses_new",
      ]),
    );

    receiveEvent?.({
      type: "session.step.ended",
      created: 1_700_000_000_000,
      data: {
        sessionID: "ses_new",
        assistantMessageID: "msg_new_child",
        tokens: { cache: { read: 4 } },
      },
    } as never);
    expect(runtime.query("ses_new")).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });

    receiveEvent?.({
      type: "session.deleted",
      data: { sessionID: "ses_existing" },
    } as never);
    expect(snapshots.at(-1)?.children).toEqual([{ sessionId: "ses_new", label: "New child" }]);

    release();
    runtime.dispose();
  });

  it("retains event-confirmed children while session.list catches up and enriches them on reconnect", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let childVisibleInList = false;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return vi.fn();
      },
      listChildren: async (parentID) =>
        childVisibleInList && parentID === "ses_root"
          ? [{ id: "ses_event_child", parentID, title: "Persisted child" }]
          : [],
    });
    const snapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const release = runtime.subscribeChildren("ses_root", (snapshot) => snapshots.push(snapshot));
    await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe("ready"));

    receiveEvent?.({
      type: "session.created",
      data: { sessionID: "ses_event_child", parentID: "ses_root" },
    } as never);
    await vi.waitFor(() =>
      expect(snapshots.at(-1)).toMatchObject({
        status: "ready",
        children: [{ sessionId: "ses_event_child", label: "Untitled child session" }],
      }),
    );

    childVisibleInList = true;
    onReconnect?.();
    await vi.waitFor(() =>
      expect(snapshots.at(-1)).toMatchObject({
        status: "ready",
        children: [{ sessionId: "ses_event_child", label: "Persisted child" }],
      }),
    );

    release();
    runtime.dispose();
  });

  it("rediscovers child sessions when the existing Native RPC transport reconnects", async () => {
    let onReconnect: (() => void) | undefined;
    const liveChildren = [{ id: "ses_before_restart", parentID: "ses_root", title: "Before" }];
    const listChildren = vi.fn(async (parentID: string) =>
      liveChildren.filter((child) => child.parentID === parentID),
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return vi.fn();
      },
      listChildren,
    });
    const snapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const release = runtime.subscribeChildren("ses_root", (snapshot) => snapshots.push(snapshot));
    await vi.waitFor(() => expect(snapshots.at(-1)?.status).toBe("ready"));

    liveChildren.push({ id: "ses_after_restart", parentID: "ses_root", title: "After" });
    onReconnect?.();
    await vi.waitFor(() =>
      expect(snapshots.at(-1)?.children.map((child) => child.sessionId)).toContain(
        "ses_after_restart",
      ),
    );
    expect(listChildren).toHaveBeenCalledTimes(2);

    release();
    runtime.dispose();
  });
});
