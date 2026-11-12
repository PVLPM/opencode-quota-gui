import { describe, expect, it, vi } from "vitest";

import { projectOpenCodeCacheObserverEvent } from "../src/lib/cache-observer-ingestion.js";
import { createHostRouteConfigurationReader } from "../src/native/cache-observer-host-config.js";
import { createNativeCacheObserverRuntime } from "../src/native/cache-observer-runtime.js";
import { createGuiRpcCaller } from "../src/native/rpc.js";

describe("native cache observer runtime", () => {
  it("accepts successful projected RPC events and excludes unsuccessful raw completions", async () => {
    const sessionID = "ses_rpc_projection";
    let receiveEvent: ((event: never) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      now: () => 2_000,
    });
    const release = runtime.subscribe(sessionID, () => {});
    const raw = (messageID: string, finish: string, started: number) => [
      {
        type: "session.step.started",
        created: started + 10,
        data: {
          sessionID,
          assistantMessageID: messageID,
          model: { providerID: "anthropic", id: "claude-test" },
          started,
        },
      },
      {
        type: "session.step.ended",
        created: started + 100,
        data: {
          sessionID,
          assistantMessageID: messageID,
          finish,
          tokens: { input: 10, cache: { read: 30, write: 0 } },
        },
      },
    ];
    const events = [...raw("msg_ok", "stop", 1_000), ...raw("msg_bad", "error", 1_500)];
    const projected = events.map(projectOpenCodeCacheObserverEvent);
    expect(projected[3]).toBeUndefined();
    const caller = createGuiRpcCaller({
      client: {
        rpc: () => ({
          events: {
            subscribe: async function* () {
              for (const event of projected)
                if (event)
                  yield { data: { topic: "cache.observer", at: 2_000, cacheObserverEvent: event } };
            },
          },
        }),
      },
    } as never);
    for await (const envelope of caller.events.subscribe("invalidated")) {
      if (envelope.data.topic === "cache.observer")
        receiveEvent?.(envelope.data.cacheObserverEvent as never);
    }
    expect(runtime.query(sessionID)).toMatchObject({
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadRatio: { value: 0.75 },
    });
    release();
    runtime.dispose();
  });
  for (const state of ["unavailable", "stopped"] as const) {
    it(`applies source state ${state} while host-event confidence is fenced`, () => {
      let receiveEvent: ((event: unknown) => void) | undefined;
      let retire = () => {};
      const runtime = createNativeCacheObserverRuntime({
        subscribeEvents: (listener) => {
          receiveEvent = listener as (event: unknown) => void;
          return () => {};
        },
        subscribeEventStreamRetire: (listener) => {
          retire = listener;
          return () => {};
        },
        rpcConnection: () => "live",
        listChildren: async () => [],
      });
      const release = runtime.subscribe("ses_status_fence", () => {});
      receiveEvent?.({
        type: "source.status",
        created: 10,
        data: { state: "observed" },
      });
      retire();

      receiveEvent?.({
        type: "source.status",
        created: 1,
        data: { state },
      });

      expect(runtime.transport().hostEvents).toBe(state);
      release();
      runtime.dispose();
    });
  }

  it("requires a bound source status to recover from unavailable host events", () => {
    let receiveEvent: ((event: unknown) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener as (event: unknown) => void;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
    });
    const release = runtime.subscribe("ses_bound_source_status", () => {});

    receiveEvent?.({
      type: "source.status",
      created: 10,
      data: { state: "unavailable", sourceBinding: "source-owner-a" },
    });
    receiveEvent?.({
      type: "session.status",
      created: 20,
      data: { sessionID: "ses_bound_source_status", state: "idle" },
    });

    expect(runtime.transport().hostEvents).toBe("unavailable");

    // A source binding is the legacy-compatible proof when no attempt nonce is
    // present; ordinary lifecycle events above are not proof of recovery.
    receiveEvent?.({
      type: "source.status",
      created: 30,
      data: { state: "observed", sourceBinding: "source-owner-a" },
    });
    expect(runtime.transport().hostEvents).toBe("observed");

    release();
    runtime.dispose();
  });

  it("replays the latest bound source state after observer interest lapses", () => {
    let receiveEvent: ((event: unknown) => void) | undefined;
    let latestSourceStatus: unknown;
    let retire = () => {};
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener as (event: unknown) => void;
        if (latestSourceStatus !== undefined) receiveEvent(latestSourceStatus);
        return () => {
          receiveEvent = undefined;
        };
      },
      subscribeEventStreamRetire: (listener) => {
        retire = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
    });
    const publishSourceStatus = (event: unknown) => {
      latestSourceStatus = event;
      receiveEvent?.(event);
    };
    const firstRelease = runtime.subscribe("ses_passive_source_replay", () => {});
    publishSourceStatus({
      type: "source.status",
      created: 10,
      data: {
        state: "observed",
        attemptNonce: "attempt-one",
        sourceBinding: "source-owner-a",
      },
    });
    firstRelease();

    // A stream transition fences the runtime while no observer is attached;
    // the shared client continues retaining the latest, binding-validated
    // source snapshot for passive replay.
    retire();
    publishSourceStatus({
      type: "source.status",
      created: 20,
      data: { state: "observed", sourceBinding: "source-owner-a" },
    });
    expect(runtime.transport().hostEvents).toBe("unverified");

    const secondRelease = runtime.subscribe("ses_passive_source_replay", () => {});
    expect(runtime.transport().hostEvents).toBe("observed");

    secondRelease();
    runtime.dispose();
  });

  it("accepts a correlated source snapshot without clearing per-session history fences", async () => {
    let receiveEvent: ((event: unknown) => void) | undefined;
    let retire = () => {};
    let subsequent = false;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener as (event: unknown) => void;
        return () => {};
      },
      subscribeEventStreamRetire: (listener) => {
        retire = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages: async () => ({
        data: [
          {
            id: "msg_snapshot_fence",
            type: "assistant",
            finish: "stop",
            model: { providerID: "openai", id: "test" },
            time: { created: 1_000, completed: 1_100 },
            tokens: { input: 20, cache: { read: subsequent ? 60 : 80, write: 0 } },
          },
        ],
        cursor: { next: null },
      }),
    });
    const release = runtime.subscribe("ses_snapshot_fence", () => {});
    await runtime.bootstrapHistory(["ses_snapshot_fence"]);
    expect(runtime.query("ses_snapshot_fence")?.primaryCacheReadRatio?.value).toBe(0.8);

    retire();
    receiveEvent?.({
      type: "source.status",
      created: 2,
      data: {
        state: "observed",
        attemptNonce: "current-attempt",
        sourceBinding: "source-owner-a",
      },
    });
    expect(runtime.transport().hostEvents).toBe("observed");

    subsequent = true;
    await runtime.bootstrapHistory(["ses_snapshot_fence"]);
    // The last observed share persists through the snapshot; nothing is hidden.
    expect(runtime.query("ses_snapshot_fence")?.primaryCacheReadRatio?.value).toBe(0.8);
    release();
    runtime.dispose();
  });

  it.each([
    "changed counters",
    "compaction",
  ] as const)("keeps the last observed share after a gap when fresh history reports %s", async (scenario) => {
    let retire = () => {};
    let subsequent = false;
    const message = (read: number) => ({
      id: "msg_same",
      type: "assistant",
      finish: "stop",
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
    // An already observed message keeps its counters; the share persists through the gap.
    expect(runtime.query("ses_gap")?.primaryCacheReadRatio?.value).toBe(0.8);
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
                finish: "stop",
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
              finish: "stop",
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
      { sessionID: sessionId, limit: 1, order: "desc" },
      { sessionID: childSessionId, limit: 1, order: "desc" },
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

  it("uses one-message cursor pages and stops at the newest qualifying assistant", async () => {
    const sessionId = "ses_history_small_pages";
    const listMessages = vi.fn(async (input: { cursor?: string }) => {
      if (input.cursor === undefined) {
        return {
          data: [
            {
              id: "msg_unqualified_newest",
              type: "assistant",
              time: { created: 3_000, completed: 3_100 },
              content: [{ text: "private unqualified content" }],
            },
          ],
          cursor: { next: "latest-qualifying-page" },
        };
      }
      if (input.cursor === "latest-qualifying-page") {
        return {
          data: [
            {
              id: "msg_latest_qualifying",
              type: "assistant",
              finish: "stop",
              model: { providerID: "openai", id: "gpt-test" },
              time: { created: 2_000, completed: 2_100 },
              content: [{ text: "private qualifying content" }],
            },
          ],
          cursor: { next: "older-usable-page" },
        };
      }
      return {
        data: [
          {
            id: "msg_older_with_counters",
            type: "assistant",
            model: { providerID: "openai", id: "gpt-test" },
            time: { created: 1_000, completed: 1_100 },
            tokens: { input: 10, cache: { read: 90, write: 0 } },
          },
        ],
        cursor: { next: null },
      };
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: () => vi.fn(),
      rpcConnection: () => "live",
      listChildren: async () => [],
      listMessages,
    });

    await runtime.bootstrapHistory([sessionId]);

    expect(listMessages.mock.calls.map(([input]) => input)).toEqual([
      { sessionID: sessionId, limit: 1, order: "desc" },
      { sessionID: sessionId, limit: 1, cursor: "latest-qualifying-page" },
    ]);
    expect(runtime.query(sessionId)).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(runtime.query(sessionId)).not.toHaveProperty("primaryCacheReadRatio");
    expect(JSON.stringify(runtime.query(sessionId))).not.toContain("private");

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
                finish: "stop",
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
              finish: "stop",
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
    // The last observed share persists through the release; reselection re-reads history.
    expect(runtime.query(mainSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.8, messageId: "msg_history_before_release" },
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
              finish: "stop",
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

    // The child's last observed share persists through the released batch.
    expect(runtime.query(childSessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.8, messageId: "msg_child_history_1" },
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
        finish: "stop",
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
          finish: "stop",
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
        finish: "stop",
        tokens: { input: 10, cache: { read: 20, write: 0 } },
      },
    } as never);
    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });

    // Switching away keeps the last observed estimate: nothing blanket-grays on a gap.
    release();
    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });

    // Returning to the session re-reads fresh, identical history.
    const releaseAgain = runtime.subscribe("ses_revisit", vi.fn());
    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
    });
    await runtime.bootstrapHistory(["ses_revisit"]);

    expect(runtime.query("ses_revisit")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
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
            finish: "stop",
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
        finish: "stop",
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
        finish: "stop",
        tokens: { input: 50, cache: { read: 50, write: 0 } },
      },
    } as never);
    resolveMessages({
      data: [
        {
          id: "msg_history_stale",
          type: "assistant",
          finish: "stop",
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
        finish: "stop",
        tokens: { cache: { read: 8 } },
      },
    } as never);

    // An orphan Ended has no selected route, so the estimate stays gray for lack of route.
    expect(runtime.query("ses_child")).toMatchObject({
      color: "gray",
      reason: "route-unverified",
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
      reason: "route-unverified",
    });

    const remountedListener = vi.fn();
    const releaseRemounted = runtime.subscribe("ses_child", remountedListener);
    expect(subscribeEvents).toHaveBeenCalledTimes(2);
    expect(runtime.query("ses_child")).toMatchObject({
      color: "gray",
      reason: "route-unverified",
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
          finish: "stop",
          tokens: { input: 100, cache: { read: 20, write: 10 } },
        },
      } as never);

    started("msg_default", "default");
    ended("msg_default", 1_100);
    expect(runtime.query("ses_route")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { dispatchAtMs: 900, deadlineAtMs: 300_900 },
      primaryCacheReadRatio: { value: 0.15384615384615385, messageId: "msg_default" },
    });
    expect(runtime.query("ses_route")).not.toHaveProperty("configuredTtlDeadlineAtMs");

    started("msg_implicit_default");
    expect(runtime.query("ses_route")).toMatchObject({ reason: "estimated-reuse-within-ttl" });
    ended("msg_implicit_default", 1_200);
    expect(runtime.query("ses_route")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_implicit_default",
      },
    });

    started("msg_variant_change", "fast");
    expect(runtime.query("ses_route")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      primaryCacheReadRatio: { messageId: "msg_implicit_default" },
    });
    ended("msg_variant_change", 1_300);
    expect(runtime.query("ses_route")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
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
        data: { sessionID: sessionId, assistantMessageID: messageId, finish: "stop", tokens },
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

    // OpenAI-family routes use the generic 5-minute fallback, not a gray state.
    expect(runtime.query(parentSessionId)).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { kind: "fallback", ttlMs: 300_000, dispatchAtMs: 990 },
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_parent",
        observedAtMs: 1_100,
        numerator: "cache-read",
        denominator: "fresh+read+write",
      },
    });
    expect(runtime.query(childSessionId)).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { kind: "fallback", ttlMs: 300_000, dispatchAtMs: 1_190 },
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
    // The newer successful zero-telemetry call restarts the generic fallback estimate from
    // its own request start (1_400 - 10); its share is unavailable, not carried over.
    expect(runtime.query(parentSessionId)).toMatchObject({
      color: "green",
      reason: "estimated-within-ttl",
      ttlEstimate: { kind: "fallback", ttlMs: 300_000, dispatchAtMs: 1_390 },
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

  it("keeps host evidence fenced after an RPC gap without a provable stream cutover", async () => {
    const sessionId = "ses_rpc_gap_history_recovery";
    const unrelatedParentSessionId = "ses_unrelated_parent";
    const unrelatedChildSessionId = "ses_unrelated_child";
    const gapAt = 97_000;
    let rpcConnection: "connecting" | "live" | "reconnecting" | "closed" = "live";
    let receiveEvent: ((event: never) => void) | undefined;
    let onRpcConnection:
      | ((state: "connecting" | "live" | "reconnecting" | "closed") => void)
      | undefined;
    let retireEventStream: (() => void) | undefined;
    const listMessages = vi.fn(async () => ({
      data: [
        {
          id: "msg_after_rpc_gap",
          type: "assistant",
          finish: "stop",
          model: { providerID: "openai", id: "gpt-test" },
          time: { created: 100, completed: 200 },
          tokens: { input: 10, cache: { read: 10, write: 0 } },
        },
      ],
      cursor: { next: null },
    }));
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      subscribeRpcConnection: (listener) => {
        onRpcConnection = listener;
        return vi.fn();
      },
      subscribeEventStreamRetire: (listener) => {
        retireEventStream = listener;
        return vi.fn();
      },
      rpcConnection: () => rpcConnection,
      listChildren: async () => [],
      listMessages,
      now: () => gapAt,
    });
    const release = runtime.subscribe(sessionId, vi.fn());
    const childSnapshots: Array<{
      status: "loading" | "ready" | "error";
      children: Array<{ sessionId: string; label: string }>;
    }> = [];
    const releaseChildren = runtime.subscribeChildren(unrelatedParentSessionId, (snapshot) =>
      childSnapshots.push(snapshot),
    );
    await vi.waitFor(() => expect(childSnapshots.at(-1)?.status).toBe("ready"));

    receiveEvent?.({
      type: "source.status",
      created: 96_000,
      data: { state: "observed" },
    } as never);
    expect(runtime.transport()).toMatchObject({
      rpc: "live",
      hostEvents: "observed",
      lastHostEventAtMs: 96_000,
    });

    retireEventStream?.();
    expect(runtime.transport()).toEqual({
      rpc: "live",
      hostEvents: "unverified",
      lastHostEventAtMs: 96_000,
    });

    rpcConnection = "reconnecting";
    onRpcConnection?.("reconnecting");
    expect(runtime.transport()).toEqual({
      rpc: "reconnecting",
      hostEvents: "unverified",
      lastHostEventAtMs: 96_000,
    });

    rpcConnection = "live";
    onRpcConnection?.("live");
    await runtime.bootstrapHistory([sessionId]);
    expect(listMessages).toHaveBeenCalledOnce();
    expect(runtime.query(sessionId)?.primaryCacheReadRatio).toBeDefined();
    expect(runtime.transport()).toEqual({
      rpc: "live",
      hostEvents: "unverified",
      lastHostEventAtMs: 96_000,
    });

    // Lifecycle payloads without event timestamps still apply to their exact
    // session, but cannot establish post-gap freshness.
    receiveEvent?.({
      type: "session.created",
      data: { sessionID: unrelatedChildSessionId, parentID: unrelatedParentSessionId },
    } as never);
    await vi.waitFor(() =>
      expect(childSnapshots.at(-1)?.children).toContainEqual(
        expect.objectContaining({ sessionId: unrelatedChildSessionId }),
      ),
    );
    expect(runtime.transport()).toEqual({
      rpc: "live",
      hostEvents: "unverified",
      lastHostEventAtMs: 96_000,
    });

    // This delayed event is newer than the last one seen, but still before the
    // gap. No source timestamp or current RPC attempt proves its origin.
    receiveEvent?.({
      type: "session.metadata",
      created: gapAt - 500,
      data: { sessionID: "ses_unrelated_metadata", title: "delayed" },
    } as never);
    receiveEvent?.({
      type: "source.status",
      created: gapAt - 500,
      data: { state: "observed" },
    } as never);
    receiveEvent?.({
      type: "source.status",
      created: gapAt + 500,
      data: { state: "observed" },
    } as never);
    expect(runtime.transport()).toEqual({
      rpc: "live",
      hostEvents: "unverified",
      lastHostEventAtMs: 96_000,
    });

    releaseChildren();
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
        finish: "stop",
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
    // Losing the host source clears no retained evidence: the last observed share persists.
    expect(runtime.query(sessionId)?.primaryCacheReadRatio?.value).toBe(1 / 3);
    expect(gaps).toEqual([sessionId]);

    releaseGaps();
    release();
    runtime.dispose();
  });

  it("leaves the last successful estimate and share unchanged when a later raw step fails", () => {
    const sessionId = "ses_raw_unsuccessful";
    let receiveEvent: ((event: never) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      listChildren: async () => [],
      rpcConnection: () => "live",
      now: () => 2_000,
    });
    const release = runtime.subscribe(sessionId, vi.fn());
    const step = (
      messageId: string,
      started: number,
      finish: string,
      tokens: { input: number; cache: { read: number; write: number } },
    ) => {
      receiveEvent?.({
        type: "session.step.started",
        created: started + 50,
        data: {
          sessionID: sessionId,
          assistantMessageID: messageId,
          model: { providerID: "anthropic", id: "claude-test" },
          started,
        },
      } as never);
      const projectedEnd = projectOpenCodeCacheObserverEvent({
        type: "session.step.ended",
        created: started + 100,
        data: { sessionID: sessionId, assistantMessageID: messageId, finish, tokens },
      });
      if (projectedEnd !== undefined) receiveEvent?.(projectedEnd as never);
    };

    step("msg_ok", 1_000, "stop", { input: 10, cache: { read: 30, write: 0 } });
    expect(runtime.query(sessionId)).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    expect(runtime.query(sessionId)?.primaryCacheReadRatio?.value).toBe(0.75);

    // A later errored step is not cache evidence: estimate and share stay at the successful call.
    step("msg_error", 1_500, "error", { input: 0, cache: { read: 0, write: 0 } });
    expect(runtime.query(sessionId)).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    expect(runtime.query(sessionId)?.primaryCacheReadRatio?.value).toBe(0.75);

    release();
    runtime.dispose();
  });

  it("binds each live invocation to its own host TTL snapshot", async () => {
    let receive: ((event: never) => void) | undefined;
    let ttl: 300_000 | 3_600_000 = 3_600_000;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receive = listener;
        return vi.fn();
      },
      listChildren: async () => [],
      rpcConnection: () => "live",
      now: () => 2_000,
      readRouteConfiguration: async () => ({ configuredTtlMs: ttl }),
    });
    const release = runtime.subscribe("ses_snapshot", vi.fn());
    const start = (id: string, time: number) =>
      receive?.({
        type: "session.step.started",
        created: time + 1,
        data: {
          sessionID: "ses_snapshot",
          assistantMessageID: id,
          model: { providerID: "anthropic", id: "claude-test" },
          started: time,
        },
      } as never);
    const end = (id: string, time: number) =>
      receive?.({
        type: "session.step.ended",
        created: time,
        data: {
          sessionID: "ses_snapshot",
          assistantMessageID: id,
          tokens: { input: 10, cache: { read: 20 } },
        },
      } as never);
    start("one", 1_000);
    await Promise.resolve();
    await Promise.resolve();
    end("one", 1_100);
    expect(runtime.query("ses_snapshot")?.ttlEstimate).toMatchObject({
      kind: "configured",
      ttlMs: 3_600_000,
    });
    ttl = 300_000;
    expect(runtime.query("ses_snapshot")?.ttlEstimate?.ttlMs).toBe(3_600_000);
    start("two", 1_200);
    await Promise.resolve();
    await Promise.resolve();
    end("two", 1_300);
    expect(runtime.query("ses_snapshot")?.ttlEstimate).toMatchObject({
      kind: "configured",
      ttlMs: 300_000,
    });
    release();
    runtime.dispose();
  });

  it("reads provider/model TTL for live sessions without letting delayed reads rewrite completed calls", async () => {
    let receive: ((event: never) => void) | undefined;
    let resolveSlow!: (value: {
      data: { id: string; settings: { cache: { ttl: string } } };
    }) => void;
    const slow = new Promise<{ data: { id: string; settings: { cache: { ttl: string } } } }>(
      (resolve) => {
        resolveSlow = resolve;
      },
    );
    const client = {
      provider: {
        get: vi.fn(({ providerID }: { providerID: string }) =>
          providerID === "anthropic"
            ? slow
            : Promise.resolve({ data: { id: providerID, settings: { cache: { ttl: "1h" } } } }),
        ),
      },
      model: { list: vi.fn(async () => ({ data: [] })) },
    } as unknown as Parameters<typeof createHostRouteConfigurationReader>[0];
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receive = listener;
        return vi.fn();
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      now: () => 2_000,
      readRouteConfiguration: createHostRouteConfigurationReader(client),
    });
    const releaseA = runtime.subscribe("ses_slow", vi.fn());
    const releaseB = runtime.subscribe("ses_fast", vi.fn());
    const start = (sessionID: string, providerID: string) =>
      receive?.({
        type: "session.step.started",
        created: 1_050,
        data: {
          sessionID,
          assistantMessageID: "msg",
          model: { providerID, id: "model" },
          started: 1_000,
        },
      } as never);
    const end = (sessionID: string) =>
      receive?.({
        type: "session.step.ended",
        created: 1_100,
        data: { sessionID, assistantMessageID: "msg", tokens: { input: 10, cache: { read: 20 } } },
      } as never);
    start("ses_slow", "anthropic");
    start("ses_fast", "moonshotai");
    await new Promise((resolve) => setTimeout(resolve, 0));
    end("ses_fast");
    end("ses_slow");
    expect(runtime.query("ses_fast")?.ttlEstimate).toMatchObject({
      kind: "configured",
      ttlMs: 3_600_000,
    });
    expect(runtime.query("ses_slow")?.ttlEstimate?.ttlMs).toBe(300_000);
    resolveSlow({ data: { id: "anthropic", settings: { cache: { ttl: "1h" } } } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.query("ses_slow")?.ttlEstimate?.ttlMs).toBe(300_000);
    releaseA();
    releaseB();
    runtime.dispose();
  });

  it("does not apply current configuration to prior or subsequent invocations without binding", async () => {
    const sessionId = "ses_host_ttl";
    let receiveEvent: ((event: never) => void) | undefined;
    let now = 2_000;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        receiveEvent = listener;
        return vi.fn();
      },
      listChildren: async () => [],
      rpcConnection: () => "live",
      now: () => now,
    });
    const release = runtime.subscribe(sessionId, vi.fn());
    const step = (messageId: string, started: number) => {
      receiveEvent?.({
        type: "session.step.started",
        created: started + 50,
        data: {
          sessionID: sessionId,
          assistantMessageID: messageId,
          model: { providerID: "anthropic", id: "claude-test" },
          started,
        },
      } as never);
      receiveEvent?.({
        type: "session.step.ended",
        created: started + 100,
        data: {
          sessionID: sessionId,
          assistantMessageID: messageId,
          finish: "stop",
          tokens: { input: 10, cache: { read: 20, write: 0 } },
        },
      } as never);
    };

    step("msg_first", 1_000);
    await vi.waitFor(() =>
      expect(runtime.query(sessionId)).toMatchObject({
        ttlEstimate: { kind: "documented", ttlMs: 300_000 },
      }),
    );
    now = 30_000;
    step("msg_second", 30_000);
    expect(runtime.query(sessionId)?.ttlEstimate?.deadlineAtMs).toBe(330_000);

    now = 62_000;
    step("msg_third", 62_000);
    expect(runtime.query(sessionId)?.ttlEstimate?.deadlineAtMs).toBe(362_000);

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
        finish: "stop",
        tokens: { cache: { read: 4 } },
      },
    } as never);
    expect(runtime.query("ses_new")).toMatchObject({
      color: "gray",
      reason: "route-unverified",
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
    const getSessionMetadata = vi.fn((_sessionId: string) => {
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
    emit?.({ type: "source.status", created: 2, data: { state: "unavailable" } });
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

  it("tracks model-route mismatch transitions without changing the cached route", async () => {
    let emit: ((event: unknown) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata: async () => ({
        model: { providerID: "anthropic", id: "claude-cache" },
        timeUpdatedMs: 10,
      }),
    });
    const sessionId = "ses_model_route_main";
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe("claude-cache"));

    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_cache_route",
        model: { providerID: "anthropic", id: "claude-cache" },
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_cache_route",
        finish: "stop",
        tokens: { input: 100, cache: { read: 40, write: 10 } },
      },
    });
    const classificationBeforeSelection = runtime.query(sessionId);

    const selectModel = (
      created: number,
      model: { providerID: string; id: string; variant?: string },
    ) =>
      emit?.({
        type: "session.metadata",
        created,
        data: { sessionID: sessionId, model },
      });

    selectModel(40, { providerID: "openai", id: "gpt-selected" });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({
      status: "mismatched",
      selectedModel: { providerID: "openai", id: "gpt-selected" },
      cacheRoute: { providerID: "anthropic", id: "claude-cache" },
    });
    expect(transitions).toHaveLength(1);

    emit?.({
      type: "session.step.started",
      created: 42,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_failed_switch",
        model: { providerID: "openai", id: "gpt-selected" },
        started: 41,
      },
    });
    const failed = projectOpenCodeCacheObserverEvent({
      type: "session.step.ended",
      created: 43,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_failed_switch",
        finish: "error",
        tokens: { input: 0 },
      },
    });
    if (failed !== undefined) emit?.(failed);
    expect(runtime.modelMismatch(sessionId)).toMatchObject({
      status: "mismatched",
      cacheRoute: { providerID: "anthropic", id: "claude-cache" },
    });
    expect(runtime.query(sessionId)).toEqual(classificationBeforeSelection);
    expect(transitions).toHaveLength(1);

    // Repeated selection events and stale events do not create a new transition.
    selectModel(41, { providerID: "openai", id: "gpt-selected" });
    selectModel(35, { providerID: "anthropic", id: "claude-cache" });
    expect(transitions).toHaveLength(1);
    expect(runtime.metadata(sessionId)?.model?.id).toBe("gpt-selected");

    // Returning to the observed model restores the existing estimate; it does
    // not destroy or rewrite the earlier cache observation.
    selectModel(50, { providerID: "anthropic", id: "claude-cache" });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({
      status: "matched",
      selectedModel: { providerID: "anthropic", id: "claude-cache" },
      cacheRoute: { providerID: "anthropic", id: "claude-cache" },
    });
    expect(runtime.query(sessionId)).toEqual(classificationBeforeSelection);

    selectModel(60, { providerID: "anthropic", id: "claude-cache", variant: "high" });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({ status: "mismatched" });
    expect(transitions).toHaveLength(3);
    selectModel(70, { providerID: "anthropic", id: "claude-cache", variant: "default" });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({ status: "matched" });
    expect(transitions).toHaveLength(4);
    selectModel(80, { providerID: "openai", id: "gpt-selected" });
    expect(transitions).toHaveLength(5);
    release();
    runtime.dispose();
  });

  it("keeps unknown and other-session routes isolated", async () => {
    let emit: ((event: unknown) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata: async (sessionId) => ({
        model: {
          providerID: "anthropic",
          id: sessionId === "ses_route_known" ? "known-cache" : "unobserved",
        },
        timeUpdatedMs: 10,
      }),
    });
    const knownRelease = runtime.subscribe("ses_route_known", () => {});
    const unknownRelease = runtime.subscribe("ses_route_unknown", () => {});
    await vi.waitFor(() =>
      expect(runtime.metadata("ses_route_unknown")?.model?.id).toBe("unobserved"),
    );

    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: "ses_route_known",
        assistantMessageID: "msg_known_route",
        model: { providerID: "anthropic", id: "known-cache" },
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: "ses_route_known",
        assistantMessageID: "msg_known_route",
        finish: "stop",
        tokens: { input: 100, cache: { read: 30, write: 0 } },
      },
    });
    expect(runtime.modelMismatch("ses_route_known")).toMatchObject({ status: "matched" });
    expect(runtime.modelMismatch("ses_route_unknown")).toEqual({ status: "unknown" });

    emit?.({
      type: "session.metadata",
      created: 40,
      data: {
        sessionID: "ses_route_unknown",
        model: { providerID: "openai", id: "new-model" },
      },
    });
    expect(runtime.modelMismatch("ses_route_unknown")).toEqual({ status: "unknown" });
    expect(runtime.modelMismatch("ses_route_known")).toMatchObject({
      status: "matched",
      selectedModel: { providerID: "anthropic", id: "known-cache" },
    });
    knownRelease();
    unknownRelease();
    runtime.dispose();
  });

  it("does not alert for initial or reconnect metadata and rejects stale model events", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let metadataReads = 0;
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
      getSessionMetadata: async () => {
        metadataReads += 1;
        return metadataReads === 1
          ? { model: { providerID: "openai", id: "initial-model" }, timeUpdatedMs: 20 }
          : { model: { providerID: "openai", id: "reconnected-model" }, timeUpdatedMs: 40 };
      },
    });
    const sessionId = "ses_model_route_reconnect";
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe("initial-model"));

    emit?.({
      type: "session.step.started",
      created: 25,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_reconnect_route",
        model: { providerID: "anthropic", id: "cache-route" },
        started: 21,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_reconnect_route",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({ status: "mismatched" });
    expect(transitions).toHaveLength(0);

    onReconnect?.();
    await vi.waitFor(() => expect(metadataReads).toBe(2));
    await vi.waitFor(() =>
      expect(runtime.metadata(sessionId)?.model?.id).toBe("reconnected-model"),
    );
    expect(transitions).toHaveLength(0);

    // An older event cannot rewind the selected model or notify.
    emit?.({
      type: "session.metadata",
      created: 35,
      data: { sessionID: sessionId, model: { providerID: "anthropic", id: "cache-route" } },
    });
    expect(runtime.metadata(sessionId)?.model?.id).toBe("reconnected-model");
    expect(transitions).toHaveLength(0);

    emit?.({
      type: "session.metadata",
      created: 50,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "new-live-model" } },
    });
    expect(transitions).toHaveLength(1);
    release();
    runtime.dispose();
  });

  it("treats the first live model event as a baseline when no initial metadata was available", () => {
    let emit: ((event: unknown) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
    });
    const sessionId = "ses_model_route_initial_event";
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));

    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_initial_event_route",
        model: { providerID: "anthropic", id: "cache-route" },
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_initial_event_route",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });

    emit?.({
      type: "session.metadata",
      created: 40,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "initial-model" } },
    });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({ status: "mismatched" });
    expect(transitions).toHaveLength(0);

    release();
    runtime.dispose();
  });

  it("ends reconnect suppression after an older snapshot without a catch-up alert", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let metadataReads = 0;
    let resolveReconnectMetadata:
      | ((record: { model: { providerID: string; id: string }; timeUpdatedMs: number }) => void)
      | undefined;
    let reconnectReadSettled = false;
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
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
      getSessionMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) return { model: cacheRoute, timeUpdatedMs: 10 };
        return new Promise<{
          model: { providerID: string; id: string };
          timeUpdatedMs: number;
        }>((resolve) => {
          resolveReconnectMetadata = resolve;
        }).finally(() => {
          reconnectReadSettled = true;
        });
      },
    });
    const sessionId = "ses_model_route_reconnect_older_snapshot";
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe(cacheRoute.id));

    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_reconnect_older_snapshot",
        model: cacheRoute,
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_reconnect_older_snapshot",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({ status: "matched" });

    onReconnect?.();
    await vi.waitFor(() => expect(metadataReads).toBe(2));
    emit?.({
      type: "session.metadata",
      created: 50,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-50" } },
    });
    expect(transitions).toHaveLength(0);

    resolveReconnectMetadata?.({ model: cacheRoute, timeUpdatedMs: 40 });
    await vi.waitFor(() => expect(reconnectReadSettled).toBe(true));
    expect(runtime.metadata(sessionId)?.model?.id).toBe("selected-50");
    expect(transitions).toHaveLength(0);

    await vi.waitFor(() => {
      emit?.({
        type: "session.metadata",
        created: 60,
        data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-60" } },
      });
      expect(transitions).toHaveLength(1);
    });
    emit?.({
      type: "session.metadata",
      created: 70,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-70" } },
    });
    expect(transitions).toHaveLength(2);

    release();
    runtime.dispose();
  });

  it("ends reconnect suppression after a failed metadata read without catch-up alerts", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let metadataReads = 0;
    let rejectReconnectMetadata: ((reason: Error) => void) | undefined;
    let reconnectReadSettled = false;
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
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
      getSessionMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) return { model: cacheRoute, timeUpdatedMs: 10 };
        return new Promise<{
          model: { providerID: string; id: string };
          timeUpdatedMs: number;
        }>((_resolve, reject) => {
          rejectReconnectMetadata = reject;
        }).finally(() => {
          reconnectReadSettled = true;
        });
      },
    });
    const sessionId = "ses_model_route_reconnect_failed_read";
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe(cacheRoute.id));

    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_reconnect_failed_read",
        model: cacheRoute,
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_reconnect_failed_read",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    expect(runtime.modelMismatch(sessionId)).toMatchObject({ status: "matched" });

    onReconnect?.();
    await vi.waitFor(() => expect(metadataReads).toBe(2));
    emit?.({
      type: "session.metadata",
      created: 50,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-50" } },
    });
    expect(transitions).toHaveLength(0);

    rejectReconnectMetadata?.(new Error("metadata unavailable"));
    await vi.waitFor(() => expect(reconnectReadSettled).toBe(true));
    expect(transitions).toHaveLength(0);

    await vi.waitFor(() => {
      emit?.({
        type: "session.metadata",
        created: 60,
        data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-60" } },
      });
      expect(transitions).toHaveLength(1);
    });
    emit?.({
      type: "session.metadata",
      created: 70,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-70" } },
    });
    expect(transitions).toHaveLength(2);

    release();
    runtime.dispose();
  });

  it("starts a fresh model baseline when host events recover while RPC stays live", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let metadataReads = 0;
    let resolveRecoveryMetadata:
      | ((record: { model: { providerID: string; id: string }; timeUpdatedMs: number }) => void)
      | undefined;
    let recoveryReadSettled = false;
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) return { model: cacheRoute, timeUpdatedMs: 10 };
        return new Promise<{
          model: { providerID: string; id: string };
          timeUpdatedMs: number;
        }>((resolve) => {
          resolveRecoveryMetadata = resolve;
        }).finally(() => {
          recoveryReadSettled = true;
        });
      },
    });
    const sessionId = "ses_model_route_source_recovery";
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe(cacheRoute.id));

    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_source_recovery_before_gap",
        model: cacheRoute,
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_source_recovery_before_gap",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });

    emit?.({
      type: "source.status",
      created: 40,
      data: { state: "unavailable", sourceBinding: "source-owner-a" },
    });
    emit?.({
      type: "source.status",
      created: 50,
      data: { state: "observed", sourceBinding: "source-owner-a" },
    });
    await vi.waitFor(() => expect(metadataReads).toBe(2));

    emit?.({
      type: "session.step.started",
      created: 55,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_source_recovery_after_gap",
        model: cacheRoute,
        started: 52,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 58,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_source_recovery_after_gap",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    emit?.({
      type: "session.metadata",
      created: 60,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-60" } },
    });
    expect(transitions).toHaveLength(0);

    resolveRecoveryMetadata?.({ model: cacheRoute, timeUpdatedMs: 59 });
    await vi.waitFor(() => expect(recoveryReadSettled).toBe(true));
    expect(runtime.metadata(sessionId)?.model?.id).toBe("selected-60");
    expect(transitions).toHaveLength(0);

    await vi.waitFor(() => {
      emit?.({
        type: "session.metadata",
        created: 70,
        data: { sessionID: sessionId, model: { providerID: "openai", id: "selected-70" } },
      });
      expect(transitions).toHaveLength(1);
    });

    release();
    runtime.dispose();
  });

  it("does not notify for metadata that recovers a no-API gap", () => {
    let emit: ((event: unknown) => void) | undefined;
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
    });
    const sessionId = "ses_model_route_no_api_recovery_event";
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));

    emit?.({
      type: "session.metadata",
      created: 10,
      data: { sessionID: sessionId, model: cacheRoute },
    });
    emit?.({
      type: "session.step.started",
      created: 20,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_no_api_before_gap",
        model: cacheRoute,
        started: 15,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 30,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_no_api_before_gap",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });

    emit?.({ type: "source.status", created: 40, data: { state: "unavailable" } });
    emit?.({
      type: "session.metadata",
      created: 50,
      data: {
        sessionID: sessionId,
        model: { providerID: "openai", id: "recovery-selection" },
      },
    });
    expect(transitions).toHaveLength(0);

    emit?.({
      type: "session.step.started",
      created: 60,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_no_api_after_gap",
        model: cacheRoute,
        started: 55,
      },
    });
    emit?.({
      type: "session.step.ended",
      created: 70,
      data: {
        sessionID: sessionId,
        assistantMessageID: "msg_no_api_after_gap",
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    emit?.({
      type: "session.metadata",
      created: 80,
      data: { sessionID: sessionId, model: { providerID: "openai", id: "real-selection" } },
    });
    expect(transitions).toHaveLength(1);

    release();
    runtime.dispose();
  });

  it.each([
    "session.status",
    "session.step.started",
    "session.step.ended",
    "session.metadata",
  ] as const)("recovers a waiting model baseline before applying %s evidence", async (firstEvidenceType) => {
    let emit: ((event: unknown) => void) | undefined;
    let metadataReads = 0;
    let recoveryReadSettled = false;
    let resolveRecoveryMetadata:
      | ((record: { model: { providerID: string; id: string }; timeUpdatedMs: number }) => void)
      | undefined;
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
    const sessionId = `ses_model_route_recovery_${firstEvidenceType.replaceAll(".", "_")}`;
    const started = (messageId: string, created: number) => ({
      type: "session.step.started",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        model: cacheRoute,
        started: created - 5,
      },
    });
    const ended = (messageId: string, created: number) => ({
      type: "session.step.ended",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    const select = (id: string, created: number) => ({
      type: "session.metadata",
      created,
      data: { sessionID: sessionId, model: { providerID: "openai", id } },
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) return { model: cacheRoute, timeUpdatedMs: 10 };
        return new Promise<{
          model: { providerID: string; id: string };
          timeUpdatedMs: number;
        }>((resolve) => {
          resolveRecoveryMetadata = resolve;
        }).finally(() => {
          recoveryReadSettled = true;
        });
      },
    });
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe(cacheRoute.id));

    emit?.(started("msg_before_gap", 20));
    emit?.(ended("msg_before_gap", 30));
    emit?.({ type: "source.status", created: 40, data: { state: "unavailable" } });

    if (firstEvidenceType === "session.status") {
      emit?.({
        type: "session.status",
        created: 50,
        data: { sessionID: sessionId, state: "busy" },
      });
    } else if (firstEvidenceType === "session.step.started") {
      emit?.(started("msg_first_after_gap", 50));
    } else if (firstEvidenceType === "session.step.ended") {
      emit?.(ended("msg_first_after_gap", 50));
    } else {
      emit?.(select("selected-50", 50));
    }
    await vi.waitFor(() => expect(metadataReads).toBe(2));

    emit?.(started("msg_after_gap", 60));
    emit?.(ended("msg_after_gap", 65));
    emit?.(select("selected-70", 70));
    expect(transitions).toHaveLength(0);

    resolveRecoveryMetadata?.({ model: cacheRoute, timeUpdatedMs: 69 });
    await vi.waitFor(() => expect(recoveryReadSettled).toBe(true));
    expect(runtime.metadata(sessionId)?.model?.id).toBe("selected-70");
    expect(transitions).toHaveLength(0);

    emit?.(select("selected-80", 80));
    expect(transitions).toHaveLength(1);

    release();
    runtime.dispose();
  });

  it("shares one recovery generation across reconnect and source recovery, and ignores older completions", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let onReconnect: (() => void) | undefined;
    let metadataReads = 0;
    let settledReads = 0;
    const pendingReads: Array<
      (record: { model: { providerID: string; id: string }; timeUpdatedMs: number }) => void
    > = [];
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
    const sessionId = "ses_model_route_overlapping_recovery";
    const started = (messageId: string, created: number) => ({
      type: "session.step.started",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        model: cacheRoute,
        started: created - 5,
      },
    });
    const ended = (messageId: string, created: number) => ({
      type: "session.step.ended",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    const select = (id: string, created: number) => ({
      type: "session.metadata",
      created,
      data: { sessionID: sessionId, model: { providerID: "openai", id } },
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
      getSessionMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) return { model: cacheRoute, timeUpdatedMs: 10 };
        return new Promise<{
          model: { providerID: string; id: string };
          timeUpdatedMs: number;
        }>((resolve) => pendingReads.push(resolve)).finally(() => {
          settledReads += 1;
        });
      },
    });
    const transitions: unknown[] = [];
    const release = runtime.subscribe(sessionId, () => {});
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    await vi.waitFor(() => expect(runtime.metadata(sessionId)?.model?.id).toBe(cacheRoute.id));
    emit?.(started("msg_before_overlapping_gaps", 20));
    emit?.(ended("msg_before_overlapping_gaps", 30));

    emit?.({
      type: "source.status",
      created: 40,
      data: { state: "unavailable", sourceBinding: "source-owner-a" },
    });
    emit?.({
      type: "source.status",
      created: 50,
      data: { state: "observed", sourceBinding: "source-owner-a" },
    });
    await vi.waitFor(() => expect(metadataReads).toBe(2));
    emit?.({
      type: "source.status",
      created: 60,
      data: { state: "unavailable", sourceBinding: "source-owner-a" },
    });
    emit?.({ type: "session.status", created: 70, data: { sessionID: sessionId, state: "busy" } });
    onReconnect?.();
    emit?.({
      type: "source.status",
      created: 80,
      data: { state: "observed", sourceBinding: "source-owner-a" },
    });
    await vi.waitFor(() => expect(metadataReads).toBe(3));
    expect(metadataReads).toBe(3);

    emit?.(started("msg_after_latest_gap", 90));
    emit?.(ended("msg_after_latest_gap", 95));
    emit?.(select("selected-100", 100));
    expect(transitions).toHaveLength(0);

    pendingReads[0]?.({
      model: { providerID: "openai", id: "stale-old-read" },
      timeUpdatedMs: 110,
    });
    pendingReads[1]?.({ model: cacheRoute, timeUpdatedMs: 99 });
    await vi.waitFor(() => expect(settledReads).toBe(2));
    expect(runtime.metadata(sessionId)?.model?.id).toBe("selected-100");
    expect(transitions).toHaveLength(0);

    emit?.(select("selected-120", 120));
    expect(transitions).toHaveLength(1);
    release();
    runtime.dispose();
  });

  it("suppresses buffered first-interest model events per session until each baseline settles", async () => {
    let emit: ((event: unknown) => void) | undefined;
    type MetadataRecord = {
      model: { providerID: string; id: string };
      timeUpdatedMs: number;
    };
    const resolveMetadata = new Map<string, (record: MetadataRecord) => void>();
    const settledMetadata = new Set<string>();
    const requestedSessionIds: string[] = [];
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
    const firstSessionId = "ses_model_route_initial_baseline_first";
    const secondSessionId = "ses_model_route_initial_baseline_second";
    const started = (sessionId: string, messageId: string, created: number) => ({
      type: "session.step.started",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        model: cacheRoute,
        started: created - 5,
      },
    });
    const ended = (sessionId: string, messageId: string, created: number) => ({
      type: "session.step.ended",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    const select = (sessionId: string, id: string, created: number) => ({
      type: "session.metadata",
      created,
      data: { sessionID: sessionId, model: { providerID: "openai", id } },
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        // Model events buffered by the relay can arrive synchronously as the
        // first observer attaches, before its metadata request is started.
        listener(started(firstSessionId, "msg_initial_buffered", 20) as never);
        listener(ended(firstSessionId, "msg_initial_buffered", 30) as never);
        listener(select(firstSessionId, "selected-40", 40) as never);
        listener(select(firstSessionId, "selected-50", 50) as never);
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata: async (sessionId) => {
        requestedSessionIds.push(sessionId);
        return new Promise<MetadataRecord>((resolve) => {
          resolveMetadata.set(sessionId, resolve);
        }).finally(() => settledMetadata.add(sessionId));
      },
    });
    const transitions: unknown[] = [];
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    const releaseFirst = runtime.subscribe(firstSessionId, () => {});
    const releaseSecond = runtime.subscribe(secondSessionId, () => {});
    await vi.waitFor(() => expect(requestedSessionIds).toEqual([firstSessionId, secondSessionId]));
    expect(resolveMetadata.size).toBe(2);

    emit?.(started(secondSessionId, "msg_second_initial", 20));
    emit?.(ended(secondSessionId, "msg_second_initial", 30));
    emit?.(select(secondSessionId, "second-selected-40", 40));
    emit?.(select(secondSessionId, "second-selected-50", 50));
    expect(transitions).toHaveLength(0);

    resolveMetadata.get(firstSessionId)?.({
      model: { providerID: "openai", id: "selected-50" },
      timeUpdatedMs: 60,
    });
    await vi.waitFor(() => expect(settledMetadata.has(firstSessionId)).toBe(true));
    await vi.waitFor(() => {
      emit?.(select(firstSessionId, "selected-60", 60));
      expect(transitions).toHaveLength(1);
    });

    emit?.(select(secondSessionId, "second-selected-60", 60));
    expect(transitions).toHaveLength(1);
    resolveMetadata.get(secondSessionId)?.({
      model: { providerID: "openai", id: "second-selected-60" },
      timeUpdatedMs: 60,
    });
    await vi.waitFor(() => expect(settledMetadata.has(secondSessionId)).toBe(true));
    expect(transitions).toHaveLength(1);

    await vi.waitFor(() => {
      emit?.(select(secondSessionId, "second-selected-70", 70));
      expect(transitions).toHaveLength(2);
    });

    releaseFirst();
    releaseSecond();
    runtime.dispose();
  });

  it("keeps the reselected session suppressed when an older initial read settles", async () => {
    let emit: ((event: unknown) => void) | undefined;
    let metadataReads = 0;
    let resolveOldMetadata:
      | ((record: { model: { providerID: string; id: string }; timeUpdatedMs: number }) => void)
      | undefined;
    let rejectNewMetadata: ((reason: Error) => void) | undefined;
    let oldReadSettled = false;
    let newReadSettled = false;
    const cacheRoute = { providerID: "anthropic", id: "cache-route" };
    const sessionId = "ses_model_route_initial_reselected";
    const started = (messageId: string, created: number) => ({
      type: "session.step.started",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        model: cacheRoute,
        started: created - 5,
      },
    });
    const ended = (messageId: string, created: number) => ({
      type: "session.step.ended",
      created,
      data: {
        sessionID: sessionId,
        assistantMessageID: messageId,
        finish: "stop",
        tokens: { input: 50, cache: { read: 20, write: 0 } },
      },
    });
    const select = (id: string, created: number) => ({
      type: "session.metadata",
      created,
      data: { sessionID: sessionId, model: { providerID: "openai", id } },
    });
    const runtime = createNativeCacheObserverRuntime({
      subscribeEvents: (listener) => {
        emit = listener;
        return () => {};
      },
      rpcConnection: () => "live",
      listChildren: async () => [],
      getSessionMetadata: async () => {
        metadataReads += 1;
        if (metadataReads === 1) {
          return new Promise<{
            model: { providerID: string; id: string };
            timeUpdatedMs: number;
          }>((resolve) => {
            resolveOldMetadata = resolve;
          }).finally(() => {
            oldReadSettled = true;
          });
        }
        return new Promise<{
          model: { providerID: string; id: string };
          timeUpdatedMs: number;
        }>((_resolve, reject) => {
          rejectNewMetadata = reject;
        }).finally(() => {
          newReadSettled = true;
        });
      },
    });
    const transitions: unknown[] = [];
    runtime.subscribeModelMismatchTransitions((transition) => transitions.push(transition));
    const releaseFirst = runtime.subscribe(sessionId, () => {});
    await vi.waitFor(() => expect(metadataReads).toBe(1));
    emit?.(started("msg_initial_before_switch", 20));
    emit?.(ended("msg_initial_before_switch", 30));
    emit?.(select("selected-40", 40));
    emit?.(select("selected-50", 50));
    expect(transitions).toHaveLength(0);

    releaseFirst();
    const releaseAgain = runtime.subscribe(sessionId, () => {});
    await vi.waitFor(() => expect(metadataReads).toBe(2));
    emit?.(started("msg_initial_after_switch", 55));
    emit?.(ended("msg_initial_after_switch", 58));
    emit?.(select("selected-60", 60));
    emit?.(select("selected-70", 70));
    expect(transitions).toHaveLength(0);

    resolveOldMetadata?.({ model: cacheRoute, timeUpdatedMs: 51 });
    await vi.waitFor(() => expect(oldReadSettled).toBe(true));
    emit?.(select("selected-80", 80));
    expect(transitions).toHaveLength(0);

    rejectNewMetadata?.(new Error("initial metadata unavailable"));
    await vi.waitFor(() => expect(newReadSettled).toBe(true));
    expect(transitions).toHaveLength(0);
    await vi.waitFor(() => {
      emit?.(select("selected-90", 90));
      expect(transitions).toHaveLength(1);
    });

    releaseAgain();
    runtime.dispose();
  });
});
