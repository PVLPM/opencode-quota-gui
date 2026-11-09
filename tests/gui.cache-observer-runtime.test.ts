import { describe, expect, it, vi } from "vitest";

import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";

describe("native cache observer runtime", () => {
  it.each([
    "changed counters",
    "compaction",
  ] as const)("does not unfence old telemetry after a gap when fresh history reports %s", async (scenario) => {
    let retire = () => {};
    let subsequent = false;
    const message = (read: number) => ({
      id: "msg_same",
      type: "assistant",
      model: { providerID: "openai", id: "test" },
      time: { created: 1000, completed: 1100 },
      tokens: { input: 20, cache: { read, write: 0 } },
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => () => {},
      subscribeEventStreamRetire: (listener) => {
        retire = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages: async () => ({
        data:
          subsequent && scenario === "compaction"
            ? [{ id: "compact", type: "compaction", status: "completed" }]
            : [message(subsequent ? 60 : 80)],
        cursor: { next: null },
      }),
    });
    const release = runtime.subscribe("ses_gap", () => {});
    await runtime.bootstrapHistory(["ses_gap"]);
    expect(runtime.query("ses_gap")?.primaryCacheReadRatio?.value).toBe(0.8);
    retire();
    subsequent = true;
    await runtime.bootstrapHistory(["ses_gap"]);
    expect(runtime.query("ses_gap")?.primaryCacheReadRatio).toBeUndefined();
    release();
    runtime.dispose();
  });

  it("treats the newest completed assistant without counters as unknown instead of falling back", async () => {
    const sessionId = "ses_history_main";
    const childSessionId = "ses_history_child";
    const listMessages = vi.fn(
      async (input: { sessionID: string; limit: number; order?: "desc"; cursor?: string }) => {
        if (input.sessionID === sessionId && input.cursor === undefined) {
          return {
            data: [
              {
                id: "msg_main_newest_incomplete",
                type: "assistant",
                model: { providerID: "openai", id: "gpt-test" },
                time: { created: 2_000, completed: 2_100 },
                content: [{ text: "PRIVATE NEWEST PROMPT MUST NOT BE RETAINED" }],
              },
            ],
            cursor: { next: "older-page-1" },
          };
        }
        const pageNumber = input.cursor?.startsWith("older-page-")
          ? Number(input.cursor.slice("older-page-".length))
          : undefined;
        if (input.sessionID === sessionId && pageNumber !== undefined && pageNumber === 1) {
          return {
            data: [
              {
                id: "msg_main_older_with_counters",
                type: "assistant",
                model: { providerID: "openai", id: "gpt-test" },
                time: { created: 2_000 - pageNumber * 100, completed: 2_100 - pageNumber * 100 },
                tokens: { input: 0, cache: { read: 80, write: 0 } },
                content: [{ text: `PRIVATE PAGE ${pageNumber} CONTENT MUST NOT BE RETAINED` }],
              },
            ],
            cursor: { next: "must-not-fetch" },
          };
        }
        return {
          data: [
            {
              id: "msg_child_newest",
              type: "assistant",
              model: { providerID: "anthropic", id: "claude-test" },
              time: { created: 3_000, completed: 3_100 },
              tokens: { input: 40, cache: { read: 60, write: 0 } },
              content: [{ text: "child private content" }],
            },
          ],
          cursor: { next: null },
        };
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });

    expect(listMessages).not.toHaveBeenCalled();
    await runtime.bootstrapHistory([sessionId, childSessionId]);

    expect(listMessages).toHaveBeenCalledTimes(2);
    expect(
      listMessages.mock.calls.map(([input]) => ({
        sessionID: input.sessionID,
        limit: input.limit,
        ...(input.order === undefined ? {} : { order: input.order }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      })),
    ).toEqual([
      { sessionID: sessionId, limit: 200, order: "desc" },
      { sessionID: childSessionId, limit: 200, order: "desc" },
    ]);
    expect(runtime.query(sessionId)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(runtime.query(sessionId)).not.toHaveProperty("primaryCacheReadRatio");
    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.6, messageId: "msg_child_newest" },
    });
    expect(JSON.stringify(runtime.query(sessionId))).not.toContain("PRIVATE");
    expect(JSON.stringify(runtime.query(childSessionId))).not.toContain("private content");

    runtime.dispose();
  });

  it("cancels an in-flight historical request when the selected session changes", async () => {
    let firstSignal: AbortSignal | undefined;
    const listMessages = vi.fn((input: { sessionID: string }, options: { signal: AbortSignal }) => {
      if (input.sessionID === "ses_history_old_selection") {
        firstSignal = options.signal;
        return new Promise<{
          data: unknown[];
          cursor: { next: string | null };
        }>((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }
      return Promise.resolve({ data: [], cursor: { next: null } });
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });

    const staleRequest = runtime.bootstrapHistory(["ses_history_old_selection"]);
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    await runtime.bootstrapHistory(["ses_history_new_selection"]);

    await expect(staleRequest).rejects.toMatchObject({ name: "AbortError" });
    expect(firstSignal?.aborted).toBe(true);
    expect(listMessages.mock.calls[1]?.[0]).toMatchObject({
      sessionID: "ses_history_new_selection",
    });

    runtime.dispose();
  });

  it("invalidates a loaded session when its last observer releases during a cancelled multi-session history batch", async () => {
    const mainSessionId = "ses_history_released_main";
    const childSessionId = "ses_history_released_child";
    const listMessages = vi.fn(
      (input: { sessionID: string }, _options: { signal: AbortSignal }) => {
        if (input.sessionID === mainSessionId && listMessages.mock.calls.length === 1) {
          return Promise.resolve({
            data: [
              {
                id: "msg_history_before_release",
                type: "assistant",
                model: { providerID: "openai", id: "gpt-test" },
                time: { created: 1_000, completed: 1_100 },
                tokens: { input: 20, cache: { read: 80, write: 0 } },
              },
            ],
            cursor: { next: null },
          });
        }
        if (input.sessionID === childSessionId) {
          return new Promise<{ data: unknown[]; cursor: { next: null } }>(() => {});
        }
        return Promise.resolve({
          data: [
            {
              id: "msg_history_after_release",
              type: "assistant",
              model: { providerID: "openai", id: "gpt-test" },
              time: { created: 2_000, completed: 2_100 },
              tokens: { input: 60, cache: { read: 40, write: 0 } },
            },
          ],
          cursor: { next: null },
        });
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });
    const releaseMain = runtime.subscribe(mainSessionId, vi.fn());
    const batch = new AbortController();

    const loading = runtime.bootstrapHistory([mainSessionId, childSessionId], batch.signal);
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(runtime.query(mainSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.8, messageId: "msg_history_before_release" },
    });

    releaseMain();
    batch.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });
    expect(runtime.query(mainSessionId)).not.toHaveProperty("primaryCacheReadRatio");
    expect(runtime.query(mainSessionId)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });

    const releaseReselectedMain = runtime.subscribe(mainSessionId, vi.fn());
    await runtime.bootstrapHistory([mainSessionId]);
    expect(
      listMessages.mock.calls.filter(([input]) => input.sessionID === mainSessionId),
    ).toHaveLength(2);
    expect(runtime.query(mainSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.4, messageId: "msg_history_after_release" },
    });

    releaseReselectedMain();
    runtime.dispose();
  });

  it.each([
    "child-first",
    "root-first",
  ] as const)("defers a child observation gap through temporary history interest when cleanup is %s", async (cleanupOrder) => {
    const rootSessionId = "ses_history_child_gap_root";
    const childSessionId = "ses_history_child_gap_child";
    const otherSessionId = "ses_history_child_gap_other";
    const childSnapshots: Array<{ children: Array<{ sessionId: string }> }> = [];
    let childHistoryRequests = 0;
    const listMessages = vi.fn((input: { sessionID: string }) => {
      if (input.sessionID === childSessionId) {
        childHistoryRequests += 1;
        return Promise.resolve({
          data: [
            {
              id: `msg_child_history_${childHistoryRequests}`,
              type: "assistant",
              model: { providerID: "openai", id: "gpt-test" },
              time: {
                created: childHistoryRequests * 1_000,
                completed: childHistoryRequests * 1_000 + 100,
              },
              tokens:
                childHistoryRequests === 1
                  ? { input: 20, cache: { read: 80, write: 0 } }
                  : { input: 60, cache: { read: 40, write: 0 } },
            },
          ],
          cursor: { next: null },
        });
      }
      return new Promise<{ data: unknown[]; cursor: { next: null } }>(() => {});
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [{ id: childSessionId, parentID: rootSessionId, title: "Child" }],
      listMessages,
    });
    const releaseRootWatcher = runtime.subscribeChildren(rootSessionId, (snapshot) => {
      childSnapshots.push({ children: snapshot.children });
    });
    await vi.waitFor(() =>
      expect(
        childSnapshots.some((snapshot) => snapshot.children[0]?.sessionId === childSessionId),
      ).toBe(true),
    );
    const releaseChildSubscription = runtime.subscribe(childSessionId, vi.fn());
    const batch = new AbortController();
    const loading = runtime.bootstrapHistory([childSessionId, otherSessionId], batch.signal);
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledTimes(2));
    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.8, messageId: "msg_child_history_1" },
    });

    if (cleanupOrder === "child-first") {
      releaseChildSubscription();
      releaseRootWatcher();
    } else {
      releaseRootWatcher();
      releaseChildSubscription();
    }
    batch.abort();
    await expect(loading).rejects.toMatchObject({ name: "AbortError" });

    expect(runtime.query(childSessionId)).not.toHaveProperty("primaryCacheReadRatio");
    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });

    const releaseReselectedChild = runtime.subscribe(childSessionId, vi.fn());
    await runtime.bootstrapHistory([childSessionId]);
    expect(childHistoryRequests).toBe(2);
    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.4, messageId: "msg_child_history_2" },
    });

    releaseReselectedChild();
    runtime.dispose();
  });

  it("checks each session epoch and skips history for completed live evidence", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    let resolveFirstPage!: (value: { data: unknown[]; cursor: { next: null } }) => void;
    const listMessages = vi.fn((input: { sessionID: string }) => {
      if (input.sessionID === "ses_history_first") {
        return new Promise<{ data: unknown[]; cursor: { next: null } }>((resolve) => {
          resolveFirstPage = resolve;
        });
      }
      return Promise.resolve({ data: [], cursor: { next: null } });
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });

    const loading = runtime.bootstrapHistory([
      "ses_history_first",
      "ses_history_started",
      "ses_history_live",
    ]);
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    receiveEvent?.({
      type: "session.step.started",
      created: 3_000,
      data: {
        sessionID: "ses_history_started",
        assistantMessageID: "msg_live_start_before_page",
        model: { providerID: "openai", id: "gpt-live" },
        started: 2_900,
      },
    } as never);
    receiveEvent?.({
      type: "session.step.started",
      created: 3_000,
      data: {
        sessionID: "ses_history_live",
        assistantMessageID: "msg_live_before_page",
        model: { providerID: "openai", id: "gpt-live" },
        started: 2_900,
      },
    } as never);
    receiveEvent?.({
      type: "session.step.ended",
      created: 3_100,
      data: {
        sessionID: "ses_history_live",
        assistantMessageID: "msg_live_before_page",
        tokens: { input: 50, cache: { read: 50, write: 0 } },
      },
    } as never);
    resolveFirstPage({ data: [], cursor: { next: null } });
    await loading;

    expect(listMessages.mock.calls.map(([input]) => input.sessionID)).toEqual([
      "ses_history_first",
    ]);
    expect(runtime.query("ses_history_live")).toMatchObject({
      primaryCacheReadRatio: { value: 0.5, messageId: "msg_live_before_page" },
    });

    await runtime.bootstrapHistory(["ses_history_live"]);
    expect(listMessages).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("cancels pre-gap history, invalidates loaded history, and permits explicit recovery after reconnect", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    let firstSignal: AbortSignal | undefined;
    const listMessages = vi.fn(
      (_input: { sessionID: string }, options: { signal: AbortSignal }) => {
        if (listMessages.mock.calls.length === 1) {
          firstSignal = options.signal;
          return new Promise<{ data: unknown[]; cursor: { next: null } }>(() => {});
        }
        return Promise.resolve({ data: [], cursor: { next: null } });
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });
    const release = runtime.subscribe("ses_history_gap", vi.fn());

    const staleLoad = runtime.bootstrapHistory(["ses_history_gap"]);
    await vi.waitFor(() => expect(listMessages).toHaveBeenCalledOnce());
    receiveEvent?.({
      type: "source.status",
      created: 4_000,
      data: { state: "unavailable" },
    } as never);
    await expect(staleLoad).rejects.toMatchObject({ name: "AbortError" });
    expect(firstSignal?.aborted).toBe(true);

    receiveEvent?.({ type: "source.status", created: 4_100, data: { state: "observed" } } as never);
    await runtime.bootstrapHistory(["ses_history_gap"]);
    expect(listMessages).toHaveBeenCalledTimes(2);
    await runtime.bootstrapHistory(["ses_history_gap"]);
    expect(listMessages).toHaveBeenCalledTimes(2);

    receiveEvent?.({
      type: "source.status",
      created: 4_200,
      data: { state: "unavailable" },
    } as never);
    receiveEvent?.({ type: "source.status", created: 4_300, data: { state: "observed" } } as never);
    await runtime.bootstrapHistory(["ses_history_gap"]);
    expect(listMessages).toHaveBeenCalledTimes(3);

    release();
    runtime.dispose();
  });

  it("recovers the historical estimate on revisit when fresh identical history re-confirms the latest invocation", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    const listMessages = vi.fn(async () => ({
      data: [
        {
          id: "msg_revisit",
          type: "assistant",
          model: { providerID: "anthropic", id: "claude-test" },
          time: { created: 1_000, completed: 1_100 },
          tokens: { input: 10, cache: { read: 20, write: 0 } },
        },
      ],
      cursor: { next: null },
    }));
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
      now: () => 2_000,
    });
    const release = runtime.subscribe("ses_revisit", vi.fn());

    receiveEvent?.({
      type: "session.step.started",
      created: 1_050,
      data: {
        sessionID: "ses_revisit",
        assistantMessageID: "msg_revisit",
        model: { providerID: "anthropic", id: "claude-test" },
        started: 1_000,
      },
    } as never);
    receiveEvent?.({
      type: "session.step.ended",
      created: 1_100,
      data: {
        sessionID: "ses_revisit",
        assistantMessageID: "msg_revisit",
        tokens: { input: 10, cache: { read: 20, write: 0 } },
      },
    } as never);
    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });

    // Switching away from the session marks an observation gap.
    release();
    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });

    // Returning to the session re-reads fresh, identical history.
    const releaseAgain = runtime.subscribe("ses_revisit", vi.fn());
    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    await runtime.bootstrapHistory(["ses_revisit"]);

    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadRatio: { messageId: "msg_revisit" },
    });
    releaseAgain();
    runtime.dispose();
  });

  it("stops newest-first pagination at the latest completed compaction boundary", async () => {
    const listMessages = vi.fn(async (input: { cursor?: string }) =>
      input.cursor === undefined
        ? {
            data: [{ id: "msg_compaction", type: "compaction", status: "completed" }],
            cursor: { next: "pre-compaction-page" },
          }
        : {
            data: [
              {
                id: "msg_pre_compaction",
                type: "assistant",
                model: { providerID: "openai", id: "gpt-test" },
                time: { created: 100, completed: 200 },
                tokens: { input: 10, cache: { read: 90, write: 0 } },
              },
            ],
            cursor: { next: null },
          },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });

    await runtime.bootstrapHistory(["ses_history_compacted"]);

    expect(listMessages).toHaveBeenCalledOnce();
    expect(runtime.query("ses_history_compacted")).toBeUndefined();
    runtime.dispose();
  });

  it("recovers a child's completed usage from history when its live end preceded child discovery", async () => {
    const parentSessionId = "ses_history_parent";
    const childSessionId = "ses_history_child_before_discovery";
    let receiveEvent: ((event: never) => void) | undefined;
    let reconnect: (() => void) | undefined;
    let rows: Array<{ id: string; parentID?: string; title?: string }> = [];
    const listChildren = vi.fn(async () => rows);
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      subscribeReconnect: (listener) => {
        reconnect = listener;
        return vi.fn();
      },
      listChildren,
      listMessages: async () => ({
        data: [
          {
            id: "msg_child_completed_before_discovery",
            type: "assistant",
            model: { providerID: "openai", id: "gpt-child" },
            time: { created: 5_000, completed: 5_100 },
            tokens: { input: 25, cache: { read: 75, write: 0 } },
          },
        ],
        cursor: { next: null },
      }),
    });
    const release = runtime.subscribeChildren(parentSessionId, vi.fn());
    await vi.waitFor(() => expect(listChildren).toHaveBeenCalledOnce());

    receiveEvent?.({
      type: "session.step.started",
      created: 4_900,
      data: {
        sessionID: childSessionId,
        assistantMessageID: "msg_child_completed_before_discovery",
        model: { providerID: "openai", id: "gpt-child" },
        started: 4_800,
      },
    } as never);
    receiveEvent?.({
      type: "session.step.ended",
      created: 5_100,
      data: {
        sessionID: childSessionId,
        assistantMessageID: "msg_child_completed_before_discovery",
        tokens: { input: 25, cache: { read: 75, write: 0 } },
      },
    } as never);
    expect(runtime.query(childSessionId)).toBeUndefined();

    rows = [{ id: childSessionId, parentID: parentSessionId, title: "Child" }];
    reconnect?.();
    await vi.waitFor(() => expect(listChildren).toHaveBeenCalledTimes(2));
    await runtime.bootstrapHistory([childSessionId]);

    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadRatio: {
        value: 0.75,
        messageId: "msg_child_completed_before_discovery",
      },
    });
    release();
    runtime.dispose();
  });

  it("keeps live observations ahead of historical results and discards a history page invalidated by compaction", async () => {
    let receiveEvent: ((event: never) => void) | undefined;
    let resolveMessages!: (value: { data: unknown[]; cursor: { next: null } }) => void;
    const listMessages = vi.fn(
      () =>
        new Promise<{ data: unknown[]; cursor: { next: null } }>((resolve) => {
          resolveMessages = resolve;
        }),
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });
    const release = runtime.subscribe("ses_history_race", vi.fn());
    const loading = runtime.bootstrapHistory(["ses_history_race"]);

    receiveEvent?.({
      type: "session.step.started",
      created: 3_000,
      data: {
        sessionID: "ses_history_race",
        assistantMessageID: "msg_live",
        model: { providerID: "openai", id: "gpt-live" },
      },
    } as never);
    receiveEvent?.({
      type: "session.step.ended",
      created: 3_100,
      data: {
        sessionID: "ses_history_race",
        assistantMessageID: "msg_live",
        tokens: { input: 50, cache: { read: 50, write: 0 } },
      },
    } as never);
    resolveMessages({
      data: [
        {
          id: "msg_history_stale",
          type: "assistant",
          model: { providerID: "anthropic", id: "claude-old" },
          time: { created: 4_000, completed: 4_100 },
          tokens: { input: 100, cache: { read: 0, write: 0 } },
          content: [{ text: "stale content" }],
        },
      ],
      cursor: { next: null },
    });
    await loading;

    expect(runtime.query("ses_history_race")).toMatchObject({
      primaryCacheReadRatio: { value: 0.5, messageId: "msg_live" },
    });

    const compactionLoading = runtime.bootstrapHistory(["ses_history_race"]);
    receiveEvent?.({
      type: "session.compaction.ended",
      data: { sessionID: "ses_history_race" },
    } as never);
    resolveMessages({
      data: [
        {
          id: "msg_pre_compaction",
          type: "assistant",
          model: { providerID: "openai", id: "gpt-live" },
          time: { created: 2_000, completed: 2_100 },
          tokens: { input: 100, cache: { read: 70, write: 0 } },
        },
      ],
      cursor: { next: null },
    });
    await compactionLoading;
    expect(runtime.query("ses_history_race")).toBeUndefined();

    release();
    runtime.dispose();
  });

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
      color: "gray",
      reason: "insufficient-evidence",
    });
    expect(runtime.query("ses_parent")).toBeUndefined();
    expect(parentListener).not.toHaveBeenCalled();
    expect(childListener).toHaveBeenCalledTimes(1);

    releaseParent();
    expect(releaseNativeListener).not.toHaveBeenCalled();
    releaseChild();
    expect(releaseNativeListener).toHaveBeenCalledOnce();
    expect(runtime.query("ses_child")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });

    const remountedListener = vi.fn();
    const releaseRemounted = runtime.subscribe("ses_child", remountedListener);
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
    expect(runtime.query("ses_child")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
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
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 900, deadlineAtMs: 300_900 },
      primaryCacheReadRatio: { value: 0.15384615384615385, messageId: "msg_default" },
    });
    expect(runtime.query("ses_route")).not.toHaveProperty("configuredTtlDeadlineAtMs");

    started("msg_implicit_default");
    expect(runtime.query("ses_route")).toMatchObject({ reason: "assumed-route-risk" });
    ended("msg_implicit_default", 1_200);
    expect(runtime.query("ses_route")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
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
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 900 },
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
      color: "gray",
      reason: "route-unverified",
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_parent",
        observedAtMs: 1_100,
        numerator: "cache-read",
        denominator: "fresh+read+write",
      },
    });
    expect(runtime.query(childSessionId)).toMatchObject({
      color: "gray",
      reason: "route-unverified",
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
    // openai has no documented TTL policy, so the parent stays gray regardless
    // of the newer zero-telemetry ambiguity; ambiguity must not outrank the
    // unevaluable route policy.
    expect(runtime.query(parentSessionId)).toMatchObject({
      color: "gray",
      reason: "route-unverified",
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

  it("keeps the final unavailable source state and gap after replayed cache evidence", () => {
    const sessionId = "ses_replayed_after_failure";
    let receiveEvent: ((event: never) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      listChildren: async () => [],
      rpcConnection: () => "live",
    });
    const release = runtime.subscribe(sessionId, vi.fn());
    const gaps: string[] = [];
    const releaseGaps = runtime.subscribeGaps((gapSessionId) => gaps.push(gapSessionId));

    receiveEvent?.({
      type: "source.status",
      created: 1_700_000_000_050,
      data: { state: "observed" },
    } as never);
    receiveEvent?.({
      type: "session.step.started",
      created: 1_700_000_000_100,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_replayed_after_failure",
        model: { providerID: "openai", id: "gpt-test" },
        started: 1_700_000_000_090,
      },
    } as never);
    receiveEvent?.({
      type: "session.step.ended",
      created: 1_700_000_000_200,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_replayed_after_failure",
        tokens: { input: 20, cache: { read: 10, write: 0 } },
      },
    } as never);
    expect(runtime.query(sessionId)?.primaryCacheReadRatio?.value).toBe(1 / 3);

    receiveEvent?.({
      type: "source.status",
      created: 1_700_000_000_300,
      data: { state: "unavailable" },
    } as never);

    expect(runtime.transport()).toMatchObject({ rpc: "live", hostEvents: "unavailable" });
    expect(runtime.query(sessionId)?.primaryCacheReadRatio).toBeUndefined();
    expect(gaps).toEqual([sessionId]);

    releaseGaps();
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
      color: "gray",
      reason: "insufficient-evidence",
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
