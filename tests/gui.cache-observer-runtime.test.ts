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

  it("seeds child metadata into the per-session store and follows record refreshes", async () => {
    const records: Array<{
      id: string;
      parentID?: string;
      title?: string;
      agent?: string;
      model?: { providerID: string; id: string; variant?: string };
      timeCreatedMs?: number;
      timeUpdatedMs?: number;
    }> = [
      {
        id: "ses_meta_child",
        parentID: "ses_meta_root",
        title: "Worker",
        agent: "general",
        model: { providerID: "anthropic", id: "claude-test", variant: "high" },
        timeCreatedMs: 100,
        timeUpdatedMs: 200,
      },
    ];
    let onReconnect: (() => void) | undefined;
    const updates: Array<unknown> = [];
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => () => {},
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => records,
    });
    const releaseWatcher = runtime.subscribeChildren("ses_meta_root", () => {});
    const release = runtime.subscribe("ses_meta_child", (classification) =>
      updates.push(classification),
    );
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_child")).toMatchObject({
        title: "Worker",
        agent: "general",
        model: { providerID: "anthropic", id: "claude-test", variant: "high" },
        createdAtMs: 100,
        updatedAtMs: 200,
      }),
    );
    const updatesAtSeed = updates.length;

    // A record refresh with newer activity re-notifies the consumer.
    records[0] = { ...records[0], timeUpdatedMs: 300 };
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.metadata("ses_meta_child")?.updatedAtMs).toBe(300));
    expect(updates.length).toBeGreaterThan(updatesAtSeed);
    // Unsafe host text is sanitized rather than stored raw.
    records[0] = {
      ...records[0],
      agent: "bad\u0007agent",
      model: { providerID: "anthropic", id: "claude-test" },
    };
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.metadata("ses_meta_child")?.agent).toBe("bad agent"));
    // Releasing the last observer drops the tracked metadata.
    release();
    releaseWatcher();
    expect(runtime.metadata("ses_meta_child")).toBeUndefined();
    runtime.dispose();
  });

  it("keeps child identity current through narrow rename, agent and model events", async () => {
    let emit: ((event: unknown) => void) | undefined;
    const records: Array<Record<string, unknown>> = [
      { id: "ses_meta_child", parentID: "ses_meta_root", title: "Worker", timeUpdatedMs: 100 },
    ];
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => records as never,
    });
    const releaseWatcher = runtime.subscribeChildren("ses_meta_root", () => {});
    const release = runtime.subscribe("ses_meta_child", () => {});
    await vi.waitFor(() => expect(runtime.metadata("ses_meta_child")?.title).toBe("Worker"));

    // A relayed rename updates the stored title and the snapshot label.
    emit?.({
      type: "session.metadata",
      created: 150,
      data: { sessionID: "ses_meta_child", title: "Renamed worker" },
    });
    expect(runtime.metadata("ses_meta_child")).toMatchObject({
      title: "Renamed worker",
      updatedAtMs: 150,
    });
    // Model and agent selections patch their own fields only.
    emit?.({
      type: "session.metadata",
      created: 160,
      data: {
        sessionID: "ses_meta_child",
        model: { providerID: "zai", id: "glm-test", variant: "max" },
      },
    });
    emit?.({
      type: "session.metadata",
      created: 170,
      data: { sessionID: "ses_meta_child", agent: "build" },
    });
    expect(runtime.metadata("ses_meta_child")).toMatchObject({
      title: "Renamed worker",
      agent: "build",
      model: { providerID: "zai", id: "glm-test", variant: "max" },
      updatedAtMs: 170,
    });
    // A stale event (older than the stored update) is discarded.
    emit?.({
      type: "session.metadata",
      created: 120,
      data: { sessionID: "ses_meta_child", title: "Stale" },
    });
    expect(runtime.metadata("ses_meta_child")?.title).toBe("Renamed worker");
    // Unwatched sessions are never stored.
    emit?.({
      type: "session.metadata",
      created: 200,
      data: { sessionID: "ses_unwatched", title: "Nope" },
    });
    expect(runtime.metadata("ses_unwatched")).toBeUndefined();
    release();
    releaseWatcher();
    runtime.dispose();
  });

  it("seeds the selected session's metadata once per selection and refreshes it after reconnect", async () => {
    let onReconnect: (() => void) | undefined;
    let emit: ((event: unknown) => void) | undefined;
    const getSessionMetadata = vi.fn(async () => ({
      title: "Main session",
      agent: "build",
      model: { providerID: "zai", id: "glm-test" },
      timeCreatedMs: 10,
      timeUpdatedMs: 20,
    }));
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata,
    });
    const release = runtime.subscribe("ses_seed_main", () => {});
    await vi.waitFor(() => expect(runtime.metadata("ses_seed_main")?.title).toBe("Main session"));
    expect(getSessionMetadata).toHaveBeenCalledTimes(1);

    // A live rename updates without any refetch.
    emit?.({
      type: "session.metadata",
      created: 30,
      data: { sessionID: "ses_seed_main", title: "Renamed" },
    });
    expect(runtime.metadata("ses_seed_main")?.title).toBe("Renamed");
    expect(getSessionMetadata).toHaveBeenCalledTimes(1);

    // Reconnect refreshes; a newer stored event wins over an older record.
    getSessionMetadata.mockResolvedValueOnce({ title: "Older record", timeUpdatedMs: 25 });
    onReconnect?.();
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(2));
    expect(runtime.metadata("ses_seed_main")?.title).toBe("Renamed");
    // A newer record does apply.
    getSessionMetadata.mockResolvedValueOnce({ title: "Newer record", timeUpdatedMs: 40 });
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.metadata("ses_seed_main")?.title).toBe("Newer record"));
    // A failed refresh keeps the stored identity.
    getSessionMetadata.mockRejectedValueOnce(new Error("unavailable"));
    onReconnect?.();
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(4));
    expect(runtime.metadata("ses_seed_main")?.title).toBe("Newer record");
    // Releasing the observer drops the metadata; re-subscribing reseeds it.
    release();
    expect(runtime.metadata("ses_seed_main")).toBeUndefined();
    const secondRelease = runtime.subscribe("ses_seed_main", () => {});
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(5));
    await vi.waitFor(() => expect(runtime.metadata("ses_seed_main")?.title).toBe("Main session"));
    secondRelease();
    runtime.dispose();
  });

  it("tracks confirmed status from events and reconciles from session.active, staying unknown on failure", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let activeSessions: readonly string[] = [];
    let failActive = false;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listActiveSessions: async () => {
        if (failActive) throw new Error("unavailable");
        return activeSessions;
      },
    });
    expect(runtime.status("ses_status")).toBe("unknown");
    const updates: Array<string> = [];
    const release = runtime.subscribe("ses_status", () =>
      updates.push(runtime.status("ses_status")),
    );
    // The subscribe-time reconcile coalesces into one session.active read and
    // confirms idle from the authoritative empty snapshot.
    await vi.waitFor(() => expect(runtime.status("ses_status")).toBe("idle"));
    expect(updates).toContain("idle");

    // A relayed status event confirms busy; a retrying session is still busy.
    emit?.({
      type: "session.status",
      created: 1,
      data: { sessionID: "ses_status", state: "busy" },
    });
    expect(runtime.status("ses_status")).toBe("busy");
    emit?.({
      type: "session.status",
      created: 2,
      data: { sessionID: "ses_status", state: "idle" },
    });
    expect(runtime.status("ses_status")).toBe("idle");
    // A hosted started step is confirmed execution evidence.
    emit?.({
      type: "session.step.started",
      created: 3,
      data: {
        sessionID: "ses_status",
        assistantMessageID: "msg_1",
        model: { providerID: "p", id: "m" },
      },
    });
    expect(runtime.status("ses_status")).toBe("busy");

    // Reconnect reconciles from the snapshot without polling.
    activeSessions = [];
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.status("ses_status")).toBe("idle"));
    activeSessions = ["ses_status"];
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.status("ses_status")).toBe("busy"));

    // A failed snapshot without coverage loss is not evidence either: the last
    // event-confirmed value stands, and a never-reconciled session stays
    // unknown.
    failActive = true;
    const otherRelease = runtime.subscribe("ses_other", () => {});
    await vi.waitFor(() => expect(runtime.status("ses_other")).toBe("unknown"));
    expect(runtime.status("ses_status")).toBe("busy");
    otherRelease();

    // Releasing the last observer drops the tracked status entirely.
    release();
    expect(runtime.status("ses_status")).toBe("unknown");
    runtime.dispose();
  });

  it("drops confirmed status when event coverage is lost, and a failed snapshot cannot restore it", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let activeSessions: readonly string[] = [];
    let failActive = false;
    const listActiveSessions = vi.fn(async () => {
      if (failActive) throw new Error("unavailable");
      return activeSessions;
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listActiveSessions,
    });
    const release = runtime.subscribe("ses_gap_status", () => {});
    activeSessions = ["ses_gap_status"];
    await vi.waitFor(() => expect(runtime.status("ses_gap_status")).toBe("busy"));

    // Stream retirement is coverage loss: the confirmed busy no longer stands.
    emit?.({ type: "source.status", created: 1, data: { state: "unavailable" } });
    expect(runtime.status("ses_gap_status")).toBe("unknown");

    // A reconnect whose snapshot fails cannot restore the stale busy.
    failActive = true;
    onReconnect?.();
    await vi.waitFor(() => expect(listActiveSessions.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(runtime.status("ses_gap_status")).toBe("unknown");

    // A succeeding snapshot after recovery re-establishes confirmed state.
    failActive = false;
    activeSessions = [];
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.status("ses_gap_status")).toBe("idle"));
    release();
    runtime.dispose();
  });

  it("a pending session.active snapshot never overwrites a newer live status event", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let snapshotMode: "instant" | "deferred" = "instant";
    let activeSessions: readonly string[] = [];
    const deferredSnapshots: Array<(ids: readonly string[]) => void> = [];
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listActiveSessions: async () => {
        if (snapshotMode === "deferred") {
          return new Promise((resolve) => {
            deferredSnapshots.push(resolve);
          });
        }
        return activeSessions;
      },
    });
    const release = runtime.subscribe("ses_race", () => {});
    await vi.waitFor(() => expect(runtime.status("ses_race")).toBe("idle"));

    // A deferred snapshot (taken as busy) starts, then a live idle event lands
    // first: the live evidence is newer and the snapshot must not overwrite it.
    snapshotMode = "deferred";
    activeSessions = ["ses_race"];
    onReconnect?.();
    await vi.waitFor(() => expect(deferredSnapshots.length).toBe(1));
    emit?.({ type: "session.status", created: 50, data: { sessionID: "ses_race", state: "idle" } });
    expect(runtime.status("ses_race")).toBe("idle");
    deferredSnapshots[0]?.(activeSessions);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.status("ses_race")).toBe("idle");

    // A fresh snapshot with no intervening events applies again.
    snapshotMode = "instant";
    onReconnect?.();
    await vi.waitFor(() => expect(runtime.status("ses_race")).toBe("busy"));

    // The reverse direction: a live busy event survives a deferred idle snapshot.
    snapshotMode = "deferred";
    onReconnect?.();
    await vi.waitFor(() => expect(deferredSnapshots.length).toBe(2));
    emit?.({ type: "session.status", created: 60, data: { sessionID: "ses_race", state: "busy" } });
    expect(runtime.status("ses_race")).toBe("busy");
    deferredSnapshots[1]?.([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.status("ses_race")).toBe("busy");
    release();
    runtime.dispose();
  });

  it("advances child activity recency from status and started-step events", async () => {
    let emit: ((event: unknown) => void) | undefined;
    const records: Array<Record<string, unknown>> = [
      { id: "ses_act_a", parentID: "ses_act_root", title: "Worker A", timeUpdatedMs: 100 },
      { id: "ses_act_b", parentID: "ses_act_root", title: "Worker B", timeUpdatedMs: 200 },
    ];
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => records as never,
    });
    const releaseWatcher = runtime.subscribeChildren("ses_act_root", () => {});
    const releaseA = runtime.subscribe("ses_act_a", () => {});
    const releaseB = runtime.subscribe("ses_act_b", () => {});
    await vi.waitFor(() => expect(runtime.metadata("ses_act_b")?.updatedAtMs).toBe(200));
    expect(runtime.metadata("ses_act_a")?.updatedAtMs).toBe(100);

    // A status transition dates the session's activity with its host timestamp.
    emit?.({
      type: "session.status",
      created: 300,
      data: { sessionID: "ses_act_a", state: "idle" },
    });
    expect(runtime.metadata("ses_act_a")?.updatedAtMs).toBe(300);
    // A started step does the same.
    emit?.({
      type: "session.step.started",
      created: 400,
      data: {
        sessionID: "ses_act_b",
        assistantMessageID: "msg_1",
        model: { providerID: "p", id: "m" },
      },
    });
    expect(runtime.metadata("ses_act_b")?.updatedAtMs).toBe(400);
    // An out-of-order or replayed timestamp never regresses recency.
    emit?.({
      type: "session.status",
      created: 50,
      data: { sessionID: "ses_act_a", state: "busy" },
    });
    expect(runtime.metadata("ses_act_a")?.updatedAtMs).toBe(300);
    // Activity never fabricates identity for a session without a record.
    emit?.({
      type: "session.status",
      created: 500,
      data: { sessionID: "ses_act_none", state: "busy" },
    });
    expect(runtime.metadata("ses_act_none")).toBeUndefined();
    releaseA();
    releaseB();
    releaseWatcher();
    runtime.dispose();
  });

  it("a deferred root seed survives child discovery and is discarded after a switch", async () => {
    const deferred: Array<(record: { title?: string; timeUpdatedMs?: number }) => void> = [];
    let instantTitle: string | undefined;
    const getSessionMetadata = vi.fn((sessionId: string) => {
      if (instantTitle !== undefined) {
        return Promise.resolve({ title: instantTitle, timeUpdatedMs: 10 });
      }
      return new Promise((resolve) => {
        deferred.push(resolve as (record: { title?: string; timeUpdatedMs?: number }) => void);
      });
    });
    const listChildren = vi.fn(async () => [
      { id: "ses_defer_child", parentID: "ses_defer_root", title: "Child", timeUpdatedMs: 5 },
    ]);
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => () => {},
      rpcConnection: () => "live",
      listChildren,
      getSessionMetadata,
    });
    const releaseWatcher = runtime.subscribeChildren("ses_defer_root", () => {});
    const releaseRoot = runtime.subscribe("ses_defer_root", () => {});
    // The root's seed is deferred; the child's identity arrives by record.
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runtime.metadata("ses_defer_child")?.title).toBe("Child"));
    expect(runtime.metadata("ses_defer_root")).toBeUndefined();

    // The child's own subscription is deduped (identity known) and must not
    // invalidate the root's in-flight read.
    const releaseChild = runtime.subscribe("ses_defer_child", () => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(getSessionMetadata).toHaveBeenCalledTimes(1);
    deferred[0]?.({ title: "Root title", timeUpdatedMs: 10 });
    await vi.waitFor(() => expect(runtime.metadata("ses_defer_root")?.title).toBe("Root title"));

    // A switch away strands the in-flight read: its late result is discarded.
    deferred.length = 0;
    const releaseRoot2 = runtime.subscribe("ses_defer_root2", () => {});
    await vi.waitFor(() => expect(deferred.length).toBe(1));
    expect(runtime.metadata("ses_defer_root2")).toBeUndefined();
    releaseRoot();
    releaseChild();
    releaseWatcher();
    releaseRoot2();
    deferred[0]?.({ title: "Late root", timeUpdatedMs: 10 });
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.metadata("ses_defer_root2")).toBeUndefined();
    runtime.dispose();
  });

  it("applies reconnect identity newer than stored identity despite newer activity recency", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let resolveRefresh:
      | ((record: {
          title?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }) => void)
      | undefined;
    let calls = 0;
    const getSessionMetadata = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          title: "Session",
          model: { providerID: "openai", id: "old-model" },
          timeUpdatedMs: 10,
        });
      }
      return new Promise<{
        title?: string;
        model?: { providerID: string; id: string };
        timeUpdatedMs?: number;
      }>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata,
    });
    const release = runtime.subscribe("ses_meta_activity_race", () => {});
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_activity_race")?.model?.id).toBe("old-model"),
    );

    // The gap forces a record refresh after recovery. The session's model has
    // changed at 15, but this get remains pending while newer activity arrives.
    emit?.({ type: "source.status", created: 11, data: { state: "unavailable" } });
    onReconnect?.();
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(2));
    emit?.({
      type: "session.status",
      created: 20,
      data: { sessionID: "ses_meta_activity_race", state: "idle" },
    });
    expect(runtime.metadata("ses_meta_activity_race")?.updatedAtMs).toBe(20);

    resolveRefresh?.({
      title: "Session",
      model: { providerID: "openai", id: "new-model" },
      timeUpdatedMs: 15,
    });
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_activity_race")).toMatchObject({
        model: { providerID: "openai", id: "new-model" },
        updatedAtMs: 20,
      }),
    );
    release();
    runtime.dispose();
  });

  it("keeps repeated identity events over a pending get without abort churn", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let resolveRefresh:
      | ((record: {
          title?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }) => void)
      | undefined;
    let refreshSignal: AbortSignal | undefined;
    let calls = 0;
    const getSessionMetadata = vi.fn(
      (_sessionId: string, requestOptions?: { signal: AbortSignal }) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            title: "Session",
            model: { providerID: "openai", id: "old-model" },
            timeUpdatedMs: 10,
          });
        }
        refreshSignal = requestOptions?.signal;
        return new Promise<{
          title?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }>((resolve) => {
          resolveRefresh = resolve;
        });
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata,
    });
    const release = runtime.subscribe("ses_meta_identity_race", () => {});
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_identity_race")?.model?.id).toBe("old-model"),
    );
    onReconnect?.();
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(2));

    emit?.({
      type: "session.metadata",
      created: 15,
      data: {
        sessionID: "ses_meta_identity_race",
        model: { providerID: "openai", id: "intermediate-model" },
      },
    });
    emit?.({
      type: "session.metadata",
      created: 15,
      data: {
        sessionID: "ses_meta_identity_race",
        model: { providerID: "openai", id: "new-model" },
      },
    });
    expect(runtime.metadata("ses_meta_identity_race")?.model?.id).toBe("new-model");
    expect(refreshSignal?.aborted).toBe(false);
    expect(getSessionMetadata).toHaveBeenCalledTimes(2);

    // The pending record has the same timestamp as the events, but must not
    // replace a field updated since this read began.
    resolveRefresh?.({
      title: "Read completed",
      model: { providerID: "openai", id: "old-model" },
      timeUpdatedMs: 15,
    });
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_identity_race")?.title).toBe("Read completed"),
    );
    expect(runtime.metadata("ses_meta_identity_race")?.model?.id).toBe("new-model");
    release();
    runtime.dispose();
  });

  it("merges unaffected fields from the initial get after a partial identity event", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let resolveInitial:
      | ((record: {
          title?: string;
          agent?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }) => void)
      | undefined;
    let initialSignal: AbortSignal | undefined;
    const getSessionMetadata = vi.fn(
      (_sessionId: string, requestOptions?: { signal: AbortSignal }) => {
        initialSignal = requestOptions?.signal;
        return new Promise<{
          title?: string;
          agent?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }>((resolve) => {
          resolveInitial = resolve;
        });
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata,
    });
    const release = runtime.subscribe("ses_meta_initial_partial", () => {});
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(1));

    emit?.({
      type: "session.metadata",
      created: 15,
      data: {
        sessionID: "ses_meta_initial_partial",
        model: { providerID: "openai", id: "selected-model" },
      },
    });
    expect(initialSignal?.aborted).toBe(false);
    resolveInitial?.({
      title: "Loaded title",
      agent: "loaded-agent",
      model: { providerID: "openai", id: "stale-model" },
      timeUpdatedMs: 15,
    });
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_initial_partial")).toMatchObject({
        title: "Loaded title",
        agent: "loaded-agent",
        model: { providerID: "openai", id: "selected-model" },
        updatedAtMs: 15,
      }),
    );
    expect(getSessionMetadata).toHaveBeenCalledTimes(1);
    release();
    runtime.dispose();
  });

  it("preserves a reconnect rename while recovering model and agent from the same get", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let resolveRefresh:
      | ((record: {
          title?: string;
          agent?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }) => void)
      | undefined;
    let refreshSignal: AbortSignal | undefined;
    let calls = 0;
    const getSessionMetadata = vi.fn(
      (_sessionId: string, requestOptions?: { signal: AbortSignal }) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve({
            title: "Original title",
            agent: "old-agent",
            model: { providerID: "openai", id: "old-model" },
            timeUpdatedMs: 10,
          });
        }
        refreshSignal = requestOptions?.signal;
        return new Promise<{
          title?: string;
          agent?: string;
          model?: { providerID: string; id: string };
          timeUpdatedMs?: number;
        }>((resolve) => {
          resolveRefresh = resolve;
        });
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata,
    });
    const release = runtime.subscribe("ses_meta_reconnect_partial", () => {});
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_reconnect_partial")?.model?.id).toBe("old-model"),
    );

    emit?.({ type: "source.status", created: 11, data: { state: "unavailable" } });
    onReconnect?.();
    await vi.waitFor(() => expect(getSessionMetadata).toHaveBeenCalledTimes(2));
    emit?.({
      type: "session.metadata",
      created: 20,
      data: { sessionID: "ses_meta_reconnect_partial", title: "Renamed title" },
    });
    expect(refreshSignal?.aborted).toBe(false);

    resolveRefresh?.({
      title: "Original title",
      agent: "new-agent",
      model: { providerID: "openai", id: "new-model" },
      timeUpdatedMs: 15,
    });
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_meta_reconnect_partial")).toMatchObject({
        title: "Renamed title",
        agent: "new-agent",
        model: { providerID: "openai", id: "new-model" },
        updatedAtMs: 20,
      }),
    );
    expect(getSessionMetadata).toHaveBeenCalledTimes(2);
    release();
    runtime.dispose();
  });

  it("aborts pending metadata reads on gaps, session switches, and disposal", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    const requests: Array<{ sessionId: string; signal?: AbortSignal }> = [];
    const getSessionMetadata = vi.fn(
      (sessionId: string, requestOptions?: { signal: AbortSignal }) => {
        requests.push({ sessionId, signal: requestOptions?.signal });
        return new Promise<{
          title?: string;
          timeUpdatedMs?: number;
        }>(() => {});
      },
    );
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      subscribeReconnect: (listener) => {
        onReconnect = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata,
    });
    const releaseGap = runtime.subscribe("ses_meta_gap_cancel", () => {});
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    emit?.({ type: "source.status", created: 1, data: { state: "unavailable" } });
    expect(requests[0]?.signal?.aborted).toBe(true);

    onReconnect?.();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    onReconnect?.();
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect(requests[1]?.signal?.aborted).toBe(true);
    releaseGap();
    expect(requests[2]?.signal?.aborted).toBe(true);

    // A selection switch releases the old session's request and starts a
    // fresh one without accumulating active request records.
    const releaseNext = runtime.subscribe("ses_meta_switch_next", () => {});
    await vi.waitFor(() => expect(requests).toHaveLength(4));
    expect(requests[3]?.sessionId).toBe("ses_meta_switch_next");
    runtime.dispose();
    expect(requests[3]?.signal?.aborted).toBe(true);
    releaseNext();
  });
});
