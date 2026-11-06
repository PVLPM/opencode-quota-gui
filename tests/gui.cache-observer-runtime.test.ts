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

  it("ingests Started DTOs through the Native entry point, normalizes default, and resets route epochs", () => {
    let receiveEvent: ((event: never) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      now: () => 2_000,
    });
    const release = runtime.subscribe("ses_route", vi.fn());

    const started = (messageId: string, variant?: string) =>
      receiveEvent?.({
        type: "session.step.started",
        created: 1_000,
        data: {
          sessionID: "ses_route",
          assistantMessageID: messageId,
          model: {
            providerID: "anthropic",
            id: "claude-test",
            ...(variant === undefined ? {} : { variant }),
          },
          started: 900,
        },
      } as never);
    const ended = (messageId: string, created: number) =>
      receiveEvent?.({
        type: "session.step.ended",
        created,
        data: {
          sessionID: "ses_route",
          assistantMessageID: messageId,
          tokens: { input: 100, cache: { read: 20, write: 10 } },
        },
      } as never);

    started("msg_default", "default");
    ended("msg_default", 1_100);
    expect(runtime.query("ses_route")).toMatchObject({
      color: "yellow",
      reason: "ttl-unverified",
      primaryCacheReadRatio: { value: 0.15384615384615385, messageId: "msg_default" },
    });
    expect(runtime.query("ses_route")).not.toHaveProperty("configuredTtlDeadlineAtMs");

    started("msg_implicit_default");
    expect(runtime.query("ses_route")).toMatchObject({ reason: "ttl-unverified" });
    ended("msg_implicit_default", 1_200);
    expect(runtime.query("ses_route")).toMatchObject({
      reason: "ttl-unverified",
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_implicit_default",
      },
    });

    started("msg_variant_change", "fast");
    expect(runtime.query("ses_route")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    ended("msg_variant_change", 1_300);
    expect(runtime.query("ses_route")).toMatchObject({
      color: "yellow",
      reason: "ttl-unverified",
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_variant_change",
      },
    });
    expect(runtime.query("ses_route")).not.toHaveProperty("configuredTtlDeadlineAtMs");

    release();
    runtime.dispose();
  });

  it("reports host cache-read ratios for non-Anthropic parent and child sessions independently", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    const parentSessionId = "ses_ratio_parent";
    const childSessionId = "ses_ratio_child";
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async (sessionId) =>
        sessionId === parentSessionId
          ? [{ id: childSessionId, parentID: parentSessionId, title: "child" }]
          : [],
      now: () => 2_000,
    });
    const childSnapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const releaseChildren = runtime.subscribeChildren(parentSessionId, (snapshot) => {
      childSnapshots.push(snapshot);
    });
    await vi.waitFor(() =>
      expect(childSnapshots.at(-1)).toMatchObject({
        status: "ready",
        children: [{ sessionId: childSessionId }],
      }),
    );
    const releaseParent = runtime.subscribe(parentSessionId, vi.fn());

    const started = (sessionId: string, messageId: string, created: number) =>
      receiveEvent?.({
        type: "session.step.started",
        created,
        data: {
          sessionID: sessionId,
          assistantMessageID: messageId,
          model: { providerID: "openai", id: "gpt-test" },
          started: created - 10,
        },
      } as never);
    const ended = (
      sessionId: string,
      messageId: string,
      created: number,
      tokens: { input: number; cache: { read: number; write: number } },
    ) =>
      receiveEvent?.({
        type: "session.step.ended",
        created,
        data: { sessionID: sessionId, assistantMessageID: messageId, tokens },
      } as never);

    started(parentSessionId, "msg_parent", 1_000);
    ended(parentSessionId, "msg_parent", 1_100, {
      input: 100,
      cache: { read: 20, write: 10 },
    });
    started(childSessionId, "msg_child", 1_200);
    ended(childSessionId, "msg_child", 1_300, {
      input: 70,
      cache: { read: 30, write: 10 },
    });

    expect(runtime.query(parentSessionId)).toMatchObject({
      color: "yellow",
      reason: "ttl-unverified",
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_parent",
        observedAtMs: 1_100,
        numerator: "cache-read",
        denominator: "fresh+read+write",
      },
    });
    expect(runtime.query(childSessionId)).toMatchObject({
      color: "yellow",
      reason: "ttl-unverified",
      primaryCacheReadRatio: {
        value: 0.2727272727272727,
        messageId: "msg_child",
        observedAtMs: 1_300,
      },
    });

    started(parentSessionId, "msg_parent_zero", 1_400);
    ended(parentSessionId, "msg_parent_zero", 1_500, {
      input: 0,
      cache: { read: 0, write: 0 },
    });
    expect(runtime.query(parentSessionId)).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
    });
    expect(runtime.query(parentSessionId)).not.toHaveProperty("primaryCacheReadRatio");
    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadRatio: { messageId: "msg_child", value: 0.2727272727272727 },
    });

    releaseParent();
    releaseChildren();
    runtime.dispose();
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
