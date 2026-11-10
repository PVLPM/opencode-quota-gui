import { describe, expect, it, vi } from "vitest";

import {
  CACHE_OBSERVER_MAX_SESSIONS,
  cacheObserverUpdateFromOpenCodeEvent,
  createCacheObserverIngestor,
  projectOpenCodeCacheObserverEvent,
  projectOpenCodeCacheObserverHistoryMessage,
} from "../src/lib/cache-observer-ingestion.js";
import { isDashboardRpcCacheObserverEvent } from "../src/rpc.js";

function stepEndedEvent(
  sessionID: string,
  assistantMessageID: string,
  tokens: Record<string, unknown>,
  created = 1_700_000_000_000,
) {
  return {
    type: "session.step.ended",
    id: `evt_${assistantMessageID}`,
    created,
    data: { sessionID, assistantMessageID, finish: "stop", cost: 0, tokens },
  };
}

function stepStartedEvent(
  sessionID: string,
  assistantMessageID: string,
  model: Record<string, unknown>,
  started: number,
  created = 1_700_000_000_000,
) {
  return {
    type: "session.step.started",
    id: `evt_${assistantMessageID}`,
    created,
    data: { sessionID, assistantMessageID, agent: "build", model, started },
  };
}

/** One correlated live Started+Ended step whose request start is 1_000. */
function ingestLiveRecoverableStep(
  ingestor: ReturnType<typeof createCacheObserverIngestor>,
  sessionId: string,
  messageId: string,
  tokens: Record<string, unknown> = { input: 10, cache: { read: 20, write: 0 } },
): void {
  ingestor.ingest(
    projectOpenCodeCacheObserverEvent(
      stepStartedEvent(
        sessionId,
        messageId,
        { providerID: "anthropic", id: "claude-test" },
        1_000,
        1_050,
      ),
    ),
  );
  ingestor.ingest(
    projectOpenCodeCacheObserverEvent(stepEndedEvent(sessionId, messageId, tokens, 1_100)),
  );
}

/** Project the matching history DTO; defaults re-confirm the live step exactly. */
function recoverableHistoryInvocation(
  sessionId: string,
  messageId: string,
  overrides: {
    created?: number;
    completed?: number;
    model?: Record<string, unknown>;
    tokens?: Record<string, unknown>;
  } = {},
) {
  const history = projectOpenCodeCacheObserverHistoryMessage(sessionId, {
    type: "assistant",
    id: messageId,
    model: overrides.model ?? { providerID: "anthropic", id: "claude-test" },
    time: {
      // Default re-confirms the live step's request start; an explicit
      // `created: undefined` omits the timestamp entirely.
      ...("created" in overrides && overrides.created === undefined
        ? {}
        : { created: overrides.created ?? 1_000 }),
      completed: overrides.completed ?? 1_100,
    },
    tokens: overrides.tokens ?? { input: 10, cache: { read: 20, write: 0 } },
  });
  if (history === undefined) throw new Error("expected the history message to be projected");
  return history;
}

describe("cache observer event ingestion", () => {
  it("classifies ended steps as primary from the runner path and requires Started for route", () => {
    expect(
      cacheObserverUpdateFromOpenCodeEvent(
        stepEndedEvent("ses_child", "msg_1", { cache: { read: 12 } }),
      ),
    ).toEqual({
      kind: "invocation",
      observation: {
        sessionId: "ses_child",
        order: { completedAtMs: 1_700_000_000_000, messageId: "msg_1" },
        primaryClassification: {
          kind: "primary",
          basis: {
            source: "opencode-v2.2.0-session-runner",
            reference: "packages/core/src/session/runner/llm.ts#233-287",
          },
        },
        counts: { read: 12 },
      },
    });
  });

  it("projects selected model identity and dispatch time, normalizing the host default variant", () => {
    expect(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_one",
          "msg_1",
          { providerID: "anthropic", id: "claude-test", variant: "default" },
          1_000,
          9_000,
        ),
      ),
    ).toEqual({
      type: "session.step.started",
      created: 9_000,
      data: {
        sessionID: "ses_one",
        assistantMessageID: "msg_1",
        model: { providerID: "anthropic", id: "claude-test" },
        started: 1_000,
      },
    });

    expect(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_one",
          "msg_fast",
          { providerID: "anthropic", id: "claude-test", variant: "fast" },
          1_100,
        ),
      ),
    ).toMatchObject({
      data: { model: { providerID: "anthropic", id: "claude-test", variant: "fast" } },
    });

    expect(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_one",
          "msg_1h",
          { providerID: "anthropic", id: "claude-test" },
          1_000,
        ),
      ),
    ).not.toHaveProperty("data.cacheTtlMs");

    const missingDispatch = projectOpenCodeCacheObserverEvent(
      stepStartedEvent(
        "ses_one",
        "msg_no_dispatch",
        { providerID: "anthropic", id: "claude-test" },
        Number.NaN,
      ),
    );
    expect(missingDispatch).not.toHaveProperty("data.started");
    expect(missingDispatch).not.toHaveProperty("data.cacheTtlMs");
  });

  it("validates the narrow Started DTO and rejects unverified route or TTL claims", () => {
    const projected = projectOpenCodeCacheObserverEvent(
      stepStartedEvent(
        "ses_one",
        "msg_rpc",
        { providerID: "anthropic", id: "claude-test", variant: "fast" },
        1_000,
      ),
    );
    expect(isDashboardRpcCacheObserverEvent(projected)).toBe(true);
    if (projected?.type !== "session.step.started") throw new Error("Expected Started DTO");

    expect(
      isDashboardRpcCacheObserverEvent({
        ...projected,
        data: { ...projected.data, protocolId: "anthropic-messages" },
      }),
    ).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        ...projected,
        data: { ...projected.data, cacheTtlMs: 3_600_000 },
      }),
    ).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        ...projected,
        data: { ...projected.data, authorization: "must-not-cross-rpc" },
      }),
    ).toBe(false);
  });

  it("does not infer a protocol or dispatch TTL from the selected model identity", () => {
    const started = projectOpenCodeCacheObserverEvent(
      stepStartedEvent(
        "ses_one",
        "msg_compatible",
        { providerID: "anthropic", id: "claude-test", variant: "fast" },
        1_000,
      ),
    );
    expect(started).toMatchObject({ type: "session.step.started" });
    expect(started).not.toHaveProperty("data.protocolId");
    expect(started).not.toHaveProperty("data.cacheTtlMs");
    expect(started).not.toHaveProperty("data.warmingEnabled");
  });

  it("correlates Started and Ended by exact session/message without asserting route or TTL", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    const started = projectOpenCodeCacheObserverEvent(
      stepStartedEvent(
        "ses_one",
        "msg_1",
        { providerID: "anthropic", id: "claude-test", variant: "fast" },
        1_000,
        9_000,
      ),
    );
    const ended = projectOpenCodeCacheObserverEvent(
      stepEndedEvent("ses_one", "msg_1", { input: 100, cache: { read: 20, write: 10 } }, 9_500),
    );
    expect(started).toBeDefined();
    expect(ended).toBeDefined();
    ingestor.ingest(started);
    ingestor.ingest(ended);

    expect(ingestor.query("ses_one")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: {
        kind: "documented",
        dispatchAtMs: 1_000,
        deadlineAtMs: 301_000,
      },
    });
    expect(ingestor.query("ses_one")).not.toHaveProperty("configuredTtlDeadlineAtMs");
    expect(ingestor.query("ses_one")).toMatchObject({
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_1",
      },
    });
    expect(ingestor.query("ses_one")).not.toHaveProperty("warmingEnabled");

    const unrelated = projectOpenCodeCacheObserverEvent(
      stepEndedEvent("ses_other", "msg_1", { input: 100, cache: { read: 20, write: 10 } }, 9_500),
    );
    ingestor.ingest(unrelated);
    expect(ingestor.query("ses_other")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
  });

  it("does not report ratios for an unmatched Ended event, then correlates it when Started arrives late", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    const ended = projectOpenCodeCacheObserverEvent(
      stepEndedEvent("ses_out_of_order", "msg_late_start", {
        input: 100,
        cache: { read: 20, write: 10 },
      }),
    );
    const started = projectOpenCodeCacheObserverEvent(
      stepStartedEvent(
        "ses_out_of_order",
        "msg_late_start",
        { providerID: "openai", id: "gpt-test" },
        9_000,
      ),
    );

    expect(ended).toBeDefined();
    expect(started).toBeDefined();
    ingestor.ingest(ended);
    expect(ingestor.query("ses_out_of_order")).not.toHaveProperty("primaryCacheReadRatio");
    expect(ingestor.query("ses_out_of_order")).toMatchObject({
      primaryCacheReadTelemetry: "unavailable",
    });

    ingestor.ingest(started);
    expect(ingestor.query("ses_out_of_order")).toMatchObject({
      primaryCacheReadRatio: {
        value: 0.15384615384615385,
        messageId: "msg_late_start",
      },
      primaryCacheReadTelemetry: "available",
    });
  });

  it("recovers unmatched live Ended telemetry from the exact historical assistant and merges missing counters", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    const sessionId = "ses_history_recovery";
    const messageId = "msg_history_recovery";
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(sessionId, messageId, { input: 100 }, 9_500),
      ),
    );
    expect(ingestor.query(sessionId)).not.toHaveProperty("primaryCacheReadRatio");

    ingestor.ingestHistory([
      {
        sessionId,
        messageId,
        completedAtMs: 9_000,
        route: {
          providerId: "openai",
          modelId: "gpt-test",
          basis: { source: "OpenCode message.list assistant model identity", reference: messageId },
        },
        counts: { fresh: 100, read: 50, write: 0 },
      },
    ]);

    expect(ingestor.query(sessionId)).toMatchObject({
      primaryCacheReadRatio: {
        value: 1 / 3,
        messageId,
        observedAtMs: 9_500,
      },
    });
  });

  it("recovers history for an orphan without clearing a newer live Started on the current route", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    const sessionId = "ses_history_does_not_reset_live";
    const liveRoute = { providerID: "openai", id: "gpt-live" };

    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(sessionId, "msg_live_previous", liveRoute, 1_000),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          sessionId,
          "msg_live_previous",
          { input: 40, cache: { read: 60, write: 0 } },
          1_100,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(sessionId, "msg_orphan_history", { input: 100 }, 1_200),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(sessionId, "msg_live_newer", liveRoute, 1_300),
      ),
    );

    ingestor.ingestHistory([
      {
        sessionId,
        messageId: "msg_orphan_history",
        completedAtMs: 1_250,
        route: {
          providerId: "anthropic",
          modelId: "claude-history",
          basis: {
            source: "OpenCode message.list assistant model identity",
            reference: "msg_orphan_history",
          },
        },
        counts: { fresh: 50, read: 50, write: 0 },
      },
    ]);

    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          sessionId,
          "msg_live_newer",
          { input: 30, cache: { read: 70, write: 0 } },
          1_400,
        ),
      ),
    );

    expect(ingestor.query(sessionId)).toMatchObject({
      primaryCacheReadRatio: { value: 0.7, messageId: "msg_live_newer" },
      primaryCacheReadTelemetry: "available",
    });
  });

  it("correlates selected model identity only with the exact assistant message", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_message",
          "msg_started",
          { providerID: "anthropic", id: "claude-test", variant: "fast" },
          1_000,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_message",
          "msg_other",
          { input: 100, cache: { read: 20, write: 10 } },
          9_500,
        ),
      ),
    );
    expect(ingestor.query("ses_message")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });

    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_message",
          "msg_started",
          { input: 100, cache: { read: 20, write: 10 } },
          9_600,
        ),
      ),
    );
    expect(ingestor.query("ses_message")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000 },
    });
  });

  it("resets the old route epoch on variant transition and recovers with new evidence", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_variant",
          "msg_variant",
          { providerID: "anthropic", id: "claude-test", variant: "fast" },
          1_000,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_variant",
          "msg_variant",
          { input: 100, cache: { read: 20, write: 10 } },
          9_500,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_variant",
          "msg_variant_two",
          { providerID: "anthropic", id: "claude-test", variant: "slow" },
          10_000,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_variant",
          "msg_variant_two",
          { input: 100, cache: { read: 20, write: 10 } },
          10_500,
        ),
      ),
    );

    expect(ingestor.query("ses_variant")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 10_000 },
    });
    expect(ingestor.query("ses_variant")).not.toHaveProperty("configuredTtlDeadlineAtMs");
  });

  it("preserves explicit zeroes and omitted cache categories independently", () => {
    expect(
      cacheObserverUpdateFromOpenCodeEvent(
        stepEndedEvent("ses_one", "msg_2", {
          input: 0,
          cache: { read: 0, write: 0 },
        }),
      ),
    ).toMatchObject({
      kind: "invocation",
      observation: { counts: { fresh: 0, read: 0, write: 0 } },
    });

    expect(
      cacheObserverUpdateFromOpenCodeEvent(
        stepEndedEvent("ses_one", "msg_3", { cache: { read: 4 } }),
      ),
    ).toMatchObject({ kind: "invocation", observation: { counts: { read: 4 } } });
    expect(
      cacheObserverUpdateFromOpenCodeEvent(stepEndedEvent("ses_one", "msg_4", { input: 9 })),
    ).toMatchObject({ kind: "invocation", observation: { counts: { fresh: 9 } } });
  });

  it("keeps session observations independent and resets only the compacted session", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 1_700_000_000_010 });

    ingestor.ingest(stepEndedEvent("ses_parent", "msg_parent", { cache: { read: 5 } }));
    ingestor.ingest(stepEndedEvent("ses_child", "msg_child", { cache: { read: 7 } }));
    ingestor.ingest({
      type: "session.compaction.ended",
      id: "evt_compaction",
      created: 1_700_000_000_005,
      data: { sessionID: "ses_child", reason: "auto", text: "private summary must not leak" },
    });

    expect(ingestor.query("ses_parent")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    expect(ingestor.query("ses_child")).toBeUndefined();

    ingestor.ingest(
      stepEndedEvent(
        "ses_child",
        "msg_after_compaction",
        { cache: { read: 2 } },
        1_700_000_000_006,
      ),
    );
    expect(ingestor.query("ses_child")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });

    ingestor.ingest({
      type: "session.deleted",
      id: "evt_delete_parent",
      created: 1_700_000_000_007,
      data: { sessionID: "ses_parent" },
    });

    expect(ingestor.query("ses_parent")).toBeUndefined();
    expect(ingestor.query("ses_child")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
  });

  it("resets only the forked child and never rolls its evidence into its parent", () => {
    const ingestor = createCacheObserverIngestor();
    ingestor.ingest(stepEndedEvent("ses_parent", "msg_parent", { cache: { read: 5 } }));
    ingestor.ingest(stepEndedEvent("ses_child", "msg_child", { cache: { read: 7 } }));

    ingestor.ingest({
      type: "session.forked",
      id: "evt_forked",
      created: 1_700_000_000_001,
      data: { sessionID: "ses_child", parentID: "ses_parent", boundary: {} },
    });

    expect(ingestor.query("ses_parent")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    expect(ingestor.query("ses_child")).toBeUndefined();
  });

  it("notifies only the exact subscribed session and stops notifying after unsubscribe", () => {
    const ingestor = createCacheObserverIngestor();
    const parentListener = vi.fn();
    const childListener = vi.fn();
    const releaseParent = ingestor.subscribe("ses_parent", parentListener);
    ingestor.subscribe("ses_child", childListener);

    ingestor.ingest(stepEndedEvent("ses_child", "msg_child", { cache: { read: 3 } }));

    expect(parentListener).not.toHaveBeenCalled();
    expect(childListener).toHaveBeenCalledTimes(1);
    expect(childListener).toHaveBeenLastCalledWith(
      expect.objectContaining({ color: "gray", reason: "insufficient-evidence" }),
    );

    releaseParent();
    ingestor.ingest(stepEndedEvent("ses_parent", "msg_parent", { cache: { read: 4 } }));
    expect(parentListener).not.toHaveBeenCalled();
  });

  it("retains classifications after the last subscriber leaves and across remounts", () => {
    const ingestor = createCacheObserverIngestor();
    const firstRelease = ingestor.subscribe("ses_remount", vi.fn());
    ingestor.ingest(stepEndedEvent("ses_remount", "msg_remount", { cache: { read: 3 } }));
    firstRelease();

    expect(ingestor.query("ses_remount")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });

    const remountedListener = vi.fn();
    const secondRelease = ingestor.subscribe("ses_remount", remountedListener);
    expect(ingestor.query("ses_remount")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    secondRelease();
  });

  it("bounds retained per-session observer state with least-recently-used eviction", () => {
    const ingestor = createCacheObserverIngestor();
    for (let index = 0; index < 140; index += 1) {
      const sessionID = `ses_${index}`;
      const release = ingestor.subscribe(sessionID, vi.fn());
      ingestor.ingest(stepEndedEvent(sessionID, `msg_${index}`, { cache: { read: 1 } }, index + 1));
      release();
    }

    expect(ingestor.query("ses_0")).toBeUndefined();
    expect(ingestor.query("ses_139")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
  });

  it("projects only minimal per-step cache fields and rejects aggregate usage updates", () => {
    const rawEvent = {
      ...stepEndedEvent("ses_opaque", "msg_opaque", {
        input: 0,
        output: 99,
        reasoning: 12,
        cache: { read: 0, write: 4 },
      }),
      metadata: { prompt: "private" },
      data: {
        ...stepEndedEvent("ses_opaque", "msg_opaque", {
          input: 0,
          output: 99,
          reasoning: 12,
          cache: { read: 0, write: 4 },
        }).data,
        model: { providerID: "private-provider", modelID: "private-model" },
      },
    };

    expect(projectOpenCodeCacheObserverEvent(rawEvent)).toEqual({
      type: "session.step.ended",
      created: 1_700_000_000_000,
      data: {
        sessionID: "ses_opaque",
        assistantMessageID: "msg_opaque",
        tokens: { input: 0, cache: { read: 0, write: 4 } },
      },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.usage.updated",
        id: "evt_usage",
        created: 1_700_000_000_000,
        data: { sessionID: "ses_opaque", cost: 1, tokens: { cache: { read: 10 } } },
      }),
    ).toBeUndefined();
  });

  it("projects direct-child lifecycle events without summaries, models, or costs", () => {
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.compaction.ended",
        id: "evt_compaction",
        created: 1,
        data: { sessionID: "ses_child", reason: "auto", text: "private summary" },
      }),
    ).toEqual({ type: "session.compaction.ended", data: { sessionID: "ses_child" } });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.created",
        id: "evt_created",
        created: 2,
        data: {
          sessionID: "ses_new_child",
          parentID: "ses_parent",
          title: "private title is fetched only through session.list",
          metadata: { prompt: "private" },
        },
      }),
    ).toEqual({
      type: "session.created",
      data: { sessionID: "ses_new_child", parentID: "ses_parent" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.forked",
        id: "evt_fork",
        created: 2,
        data: { sessionID: "ses_child", parentID: "ses_parent", boundary: {} },
      }),
    ).toEqual({
      type: "session.forked",
      data: { sessionID: "ses_child", parentID: "ses_parent" },
    });
  });

  it("classifies timer transitions from dispatch time without simulating invalidation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const ingestor = createCacheObserverIngestor();
    const colors: string[] = [];
    const release = ingestor.subscribe("ses_timer", (value) => {
      if (value) colors.push(value.color);
    });

    try {
      ingestor.ingest(
        stepStartedEvent(
          "ses_timer",
          "msg_timer",
          { providerID: "anthropic", id: "claude-test" },
          1_000,
        ),
      );
      ingestor.ingest(
        stepEndedEvent(
          "ses_timer",
          "msg_timer",
          { input: 10, cache: { read: 20, write: 0 } },
          1_100,
        ),
      );

      expect(ingestor.query("ses_timer")).toMatchObject({
        color: "yellow",
        reason: "assumed-route-risk",
        ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      });
      vi.advanceTimersByTime(240_000);
      expect(ingestor.query("ses_timer")).toMatchObject({
        color: "yellow",
        reason: "estimated-ttl-near-expiry",
      });
      vi.advanceTimersByTime(60_000);
      expect(ingestor.query("ses_timer")).toMatchObject({
        color: "red",
        reason: "estimated-ttl-expired",
      });
      expect(colors).toEqual(["yellow", "yellow", "red"]);
      expect(ingestor.query("ses_timer")?.primaryCacheReadRatio?.value).toBe(2 / 3);
    } finally {
      release();
      ingestor.dispose();
      vi.useRealTimers();
    }
  });

  it("keeps history without a request-start time from receiving a fabricated TTL timer", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 20_000 });
    const history = projectOpenCodeCacheObserverHistoryMessage("ses_history_ttl", {
      type: "assistant",
      id: "msg_history_ttl",
      time: { completed: 10_000 },
      model: { providerID: "anthropic", id: "claude-test" },
      tokens: { input: 10, cache: { read: 20, write: 0 } },
    });
    expect(history).toBeDefined();
    if (history === undefined) throw new Error("expected the history message to be projected");

    ingestor.ingestHistory([history]);

    expect(ingestor.query("ses_history_ttl")).toMatchObject({
      color: "gray",
      reason: "dispatch-time-unavailable",
      ttlEstimate: { kind: "documented", ttlMs: 300_000 },
    });
    expect(ingestor.query("ses_history_ttl")?.ttlEstimate).not.toHaveProperty("deadlineAtMs");
  });

  it("estimates old history sessions from the message-list request-start time", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    const history = projectOpenCodeCacheObserverHistoryMessage("ses_history_start", {
      type: "assistant",
      id: "msg_history_start",
      model: { providerID: "anthropic", id: "claude-test" },
      time: { created: 1_000, completed: 1_500 },
      tokens: { input: 100, cache: { read: 20, write: 10 } },
    });
    expect(history?.dispatchAtMs).toBe(1_000);
    if (history === undefined) throw new Error("expected the history message to be projected");

    ingestor.ingestHistory([history]);

    expect(ingestor.query("ses_history_start")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { kind: "documented", dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    expect(ingestor.query("ses_history_start")).not.toHaveProperty("configuredTtlDeadlineAtMs");

    now = 301_000;
    expect(ingestor.query("ses_history_start")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
    ingestor.dispose();
  });

  it("keeps an orphan live Ended without Started correlation gray instead of ambiguity risk", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_orphan_live",
          "msg_orphan_live",
          { input: 100, cache: { read: 20, write: 10 } },
          9_500,
        ),
      ),
    );

    expect(ingestor.query("ses_orphan_live")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    expect(ingestor.query("ses_orphan_live")).not.toHaveProperty("primaryCacheReadRatio");
    expect(ingestor.query("ses_orphan_live")).not.toHaveProperty("ttlEstimate");
    ingestor.dispose();
  });

  it("keeps unsupported-provider zero telemetry gray through the live ingest path", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 10_000 });
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_unsupported_live",
          "msg_unsupported",
          { providerID: "openai", id: "gpt-test" },
          1_000,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_unsupported_live",
          "msg_unsupported",
          { input: 0, cache: { read: 0, write: 0 } },
          9_500,
        ),
      ),
    );

    expect(ingestor.query("ses_unsupported_live")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    ingestor.dispose();
  });

  it("fences traffic-light estimates across a session gap until a new correlated cache event", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    const dispatch = (messageId: string, started: number, completed: number) => {
      ingestor.ingest(
        stepStartedEvent(
          "ses_gap_ttl",
          messageId,
          { providerID: "anthropic", id: "claude-test" },
          started,
        ),
      );
      ingestor.ingest(
        stepEndedEvent(
          "ses_gap_ttl",
          messageId,
          { input: 10, cache: { read: 20, write: 0 } },
          completed,
        ),
      );
    };

    dispatch("msg_before_gap", 1_000, 1_100);
    expect(ingestor.query("ses_gap_ttl")?.color).toBe("yellow");

    ingestor.markObservationGap("ses_gap_ttl");
    expect(ingestor.query("ses_gap_ttl")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });

    now = 3_000;
    dispatch("msg_after_gap", 2_900, 2_950);
    expect(ingestor.query("ses_gap_ttl")?.color).toBe("yellow");
    ingestor.dispose();
  });

  it("restores the historical estimate when fresh identical history re-confirms the latest invocation after a gap", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_recover", "msg_recover");
    expect(ingestor.query("ses_gap_recover")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });

    ingestor.markObservationGap("ses_gap_recover");
    expect(ingestor.query("ses_gap_recover")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    expect(ingestor.query("ses_gap_recover")).not.toHaveProperty("ttlEstimate");

    const history = recoverableHistoryInvocation("ses_gap_recover", "msg_recover");
    expect(history.dispatchAtMs).toBe(1_000);
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_recover")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadRatio: { messageId: "msg_recover" },
    });
    ingestor.dispose();
  });

  it("keeps the estimate fenced when the fresh history request-start timestamp differs", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_start", "msg_start");
    ingestor.markObservationGap("ses_gap_start");

    const history = recoverableHistoryInvocation("ses_gap_start", "msg_start", {
      created: 1_050,
    });
    expect(history.dispatchAtMs).toBe(1_050);
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_start")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    expect(ingestor.query("ses_gap_start")).not.toHaveProperty("ttlEstimate");
    // The identical counters still re-confirm the ratio telemetry itself.
    expect(ingestor.query("ses_gap_start")?.primaryCacheReadRatio).toMatchObject({
      messageId: "msg_start",
    });
    ingestor.dispose();
  });

  it("does not restore the estimate when the fresh history carries no request-start timestamp", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_nostart", "msg_nostart");
    ingestor.markObservationGap("ses_gap_nostart");

    const history = recoverableHistoryInvocation("ses_gap_nostart", "msg_nostart", {
      created: undefined,
    });
    expect(history.dispatchAtMs).toBeUndefined();
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_nostart")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    expect(ingestor.query("ses_gap_nostart")).not.toHaveProperty("ttlEstimate");
    ingestor.dispose();
  });

  it("keeps the estimate and ratio fenced when the fresh history route differs", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_route", "msg_route");
    ingestor.markObservationGap("ses_gap_route");

    const history = recoverableHistoryInvocation("ses_gap_route", "msg_route", {
      model: { providerID: "openai", id: "gpt-test" },
    });
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_route")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    expect(ingestor.query("ses_gap_route")).not.toHaveProperty("ttlEstimate");
    expect(ingestor.query("ses_gap_route")).not.toHaveProperty("primaryCacheReadRatio");
    ingestor.dispose();
  });

  it("keeps the estimate and ratio fenced when the fresh history counters differ", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_counts", "msg_counts");
    ingestor.markObservationGap("ses_gap_counts");

    const history = recoverableHistoryInvocation("ses_gap_counts", "msg_counts", {
      tokens: { input: 10, cache: { read: 25, write: 0 } },
    });
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_counts")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    expect(ingestor.query("ses_gap_counts")).not.toHaveProperty("ttlEstimate");
    expect(ingestor.query("ses_gap_counts")).not.toHaveProperty("primaryCacheReadRatio");
    ingestor.dispose();
  });

  it("does not restore the estimate across a compaction between the history read and its confirm", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_compaction", "msg_compaction");
    ingestor.markObservationGap("ses_gap_compaction");

    const history = recoverableHistoryInvocation("ses_gap_compaction", "msg_compaction");
    ingestor.ingestHistory([history]);
    ingestor.ingest({
      type: "session.compaction.ended",
      data: { sessionID: "ses_gap_compaction" },
    });
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_compaction")).toBeUndefined();
    ingestor.dispose();
  });

  it("keeps the estimate fenced when a newer gap follows the history read before its confirm", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_race", "msg_race");
    ingestor.markObservationGap("ses_gap_race");

    const history = recoverableHistoryInvocation("ses_gap_race", "msg_race");
    ingestor.ingestHistory([history]);
    ingestor.markObservationGap("ses_gap_race");
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_race")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });
    expect(ingestor.query("ses_gap_race")).not.toHaveProperty("ttlEstimate");

    // The next fresh, gap-free read still recovers the estimate.
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);
    expect(ingestor.query("ses_gap_race")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    ingestor.dispose();
  });

  it("recovers a write-only estimate after a gap when fresh history re-confirms the latest qualifying invocation", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    const writeOnly = { input: 10, cache: { read: 0, write: 30 } };
    ingestLiveRecoverableStep(ingestor, "ses_gap_write", "msg_write", writeOnly);
    expect(ingestor.query("ses_gap_write")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(ingestor.query("ses_gap_write")).not.toHaveProperty("primaryCacheReadRatio");

    ingestor.markObservationGap("ses_gap_write");
    expect(ingestor.query("ses_gap_write")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });

    const history = recoverableHistoryInvocation("ses_gap_write", "msg_write", {
      tokens: writeOnly,
    });
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_write")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(ingestor.query("ses_gap_write")).not.toHaveProperty("primaryCacheReadRatio");
    ingestor.dispose();
  });

  it("recovers an expired write-only estimate after a gap through fresh identical history", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 301_000 });
    const writeOnly = { input: 10, cache: { read: 0, write: 30 } };
    ingestLiveRecoverableStep(ingestor, "ses_gap_write_old", "msg_write_old", writeOnly);
    expect(ingestor.query("ses_gap_write_old")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });

    ingestor.markObservationGap("ses_gap_write_old");
    expect(ingestor.query("ses_gap_write_old")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });

    const history = recoverableHistoryInvocation("ses_gap_write_old", "msg_write_old", {
      tokens: writeOnly,
    });
    ingestor.ingestHistory([history]);
    ingestor.confirmLatestHistory(history);

    expect(ingestor.query("ses_gap_write_old")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    ingestor.dispose();
  });

  it("does not retain an observation gap for a session without retained state", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestor.markObservationGap("ses_stateless_gap");

    // Fresh history classifies directly: there is no pre-gap state to hide.
    const history = recoverableHistoryInvocation("ses_stateless_gap", "msg_stateless");
    ingestor.ingestHistory([history]);
    expect(ingestor.query("ses_stateless_gap")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    // Without a gap, the confirm is a no-op and the estimate stands.
    ingestor.confirmLatestHistory(history);
    expect(ingestor.query("ses_stateless_gap")).toMatchObject({ color: "yellow" });

    // A post-gap live orphan classifies on its own merits, not as a gap.
    ingestor.markObservationGap("ses_stateless_orphan");
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_stateless_orphan",
          "msg_orphan",
          { input: 10, cache: { read: 20, write: 0 } },
          1_500,
        ),
      ),
    );
    expect(ingestor.query("ses_stateless_orphan")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });
    ingestor.dispose();
  });

  it("resets gap markers with the route epoch on a selection change", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_route_epoch", "msg_old_route");
    ingestor.markObservationGap("ses_gap_route_epoch");
    const history = recoverableHistoryInvocation("ses_gap_route_epoch", "msg_old_route");
    ingestor.ingestHistory([history]);

    // A live Started on a different route replaces the state with a new epoch.
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_gap_route_epoch",
          "msg_new_route",
          { providerID: "openai", id: "gpt-test" },
          1_900,
          1_950,
        ),
      ),
    );
    expect(ingestor.query("ses_gap_route_epoch")).toMatchObject({
      color: "gray",
      reason: "insufficient-evidence",
    });

    // The stale pre-reset read cannot restore anything into the new epoch.
    ingestor.confirmLatestHistory(history);
    expect(ingestor.query("ses_gap_route_epoch")).toMatchObject({
      reason: "insufficient-evidence",
    });
    ingestor.dispose();
  });

  it("resets the gap markers on session deletion", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_gap_deleted", "msg_deleted");
    ingestor.markObservationGap("ses_gap_deleted");
    expect(ingestor.query("ses_gap_deleted")).toMatchObject({
      color: "gray",
      reason: "observation-gap",
    });

    ingestor.ingest({ type: "session.deleted", data: { sessionID: "ses_gap_deleted" } });
    expect(ingestor.query("ses_gap_deleted")).toBeUndefined();

    // Re-observation after deletion starts without a stale gap fence.
    ingestLiveRecoverableStep(ingestor, "ses_gap_deleted", "msg_deleted");
    expect(ingestor.query("ses_gap_deleted")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    ingestor.dispose();
  });

  it("drops gap fences with evicted state and keeps sessions independent across churn", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    for (let index = 0; index < CACHE_OBSERVER_MAX_SESSIONS; index += 1) {
      const sessionId = `ses_churn_${index}`;
      const messageId = `msg_churn_${index}`;
      ingestLiveRecoverableStep(ingestor, sessionId, messageId);
      ingestor.markObservationGap(sessionId);
      const history = recoverableHistoryInvocation(sessionId, messageId);
      ingestor.ingestHistory([history]);
      ingestor.confirmLatestHistory(history);
      expect(ingestor.query(sessionId)).toMatchObject({
        color: "yellow",
        reason: "assumed-route-risk",
      });
    }

    // One more retained state evicts the least-recently-used session.
    ingestLiveRecoverableStep(ingestor, "ses_churn_new", "msg_churn_new");
    expect(ingestor.query("ses_churn_0")).toBeUndefined();

    // The evicted session re-observes without a stale gap fence.
    ingestLiveRecoverableStep(ingestor, "ses_churn_0", "msg_churn_0");
    expect(ingestor.query("ses_churn_0")).toMatchObject({
      color: "yellow",
      reason: "assumed-route-risk",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    ingestor.dispose();
  });

  it("projects host session status, idle and execution events to the content-free status DTO", () => {
    const created = 1_700_000_000_000;
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.status",
        id: "evt_status_busy",
        created,
        data: { sessionID: "ses_status", status: { type: "busy" } },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "busy" },
    });
    // A retrying session is still executing: confirmed busy, no attempt detail.
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.status",
        id: "evt_status_retry",
        created,
        data: {
          sessionID: "ses_status",
          status: { type: "retry", attempt: 2, message: "PRIVATE RETRY DETAIL", next: created + 5 },
        },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "busy" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.status",
        id: "evt_status_idle",
        created,
        data: { sessionID: "ses_status", status: { type: "idle" } },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "idle" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.idle",
        id: "evt_idle",
        created,
        data: { sessionID: "ses_status" },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "idle" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.execution.started",
        id: "evt_exec_started",
        created,
        data: { sessionID: "ses_status" },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "busy" },
    });
    // A failed execution ends execution; its structured error is not carried.
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.execution.failed",
        id: "evt_exec_failed",
        created,
        data: { sessionID: "ses_status", error: { name: "PRIVATE_ERROR", message: "secret" } },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "idle" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.execution.interrupted",
        id: "evt_exec_interrupted",
        created,
        data: { sessionID: "ses_status", reason: "user" },
      }),
    ).toEqual({
      type: "session.status",
      created,
      data: { sessionID: "ses_status", state: "idle" },
    });
  });

  it("rejects malformed or content-bearing session status projections", () => {
    const created = 1_700_000_000_000;
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.status",
        id: "evt_status_unknown",
        created,
        data: { sessionID: "ses_status", status: { type: "something-else" } },
      }),
    ).toBeUndefined();
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.status",
        id: "evt_status_no_time",
        data: { sessionID: "ses_status", status: { type: "busy" } },
      }),
    ).toBeUndefined();
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.status",
        created,
        data: { sessionID: "ses_status", state: "busy" },
      }),
    ).toBe(true);
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.status",
        created,
        data: { sessionID: "ses_status", state: "running" },
      }),
    ).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.status",
        created,
        data: { sessionID: "ses_status", state: "busy", note: "extra" },
      }),
    ).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.status",
        data: { sessionID: "ses_status", state: "busy" },
      }),
    ).toBe(false);
  });

  it("projects host rename, agent and model selections to the narrow metadata DTO", () => {
    const created = 1_700_000_000_000;
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.renamed",
        id: "evt_renamed",
        created,
        data: { sessionID: "ses_meta", title: "New  title\u0007here" },
      }),
    ).toEqual({
      type: "session.metadata",
      created,
      data: { sessionID: "ses_meta", title: "New title here" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.agent.selected",
        id: "evt_agent",
        created,
        data: { sessionID: "ses_meta", agent: "build", previous: "plan" },
      }),
    ).toEqual({
      type: "session.metadata",
      created,
      data: { sessionID: "ses_meta", agent: "build" },
    });
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.model.selected",
        id: "evt_model",
        created,
        data: {
          sessionID: "ses_meta",
          model: { providerID: "zai", id: "glm-test", variant: "max" },
          previous: { providerID: "zai", id: "glm-old" },
        },
      }),
    ).toEqual({
      type: "session.metadata",
      created,
      data: {
        sessionID: "ses_meta",
        model: { providerID: "zai", id: "glm-test", variant: "max" },
      },
    });
    // Over-long titles are truncated to the relay bound, never dropped whole.
    const longTitle = projectOpenCodeCacheObserverEvent({
      type: "session.renamed",
      id: "evt_long",
      created,
      data: { sessionID: "ses_meta", title: "x".repeat(500) },
    });
    expect(longTitle).toMatchObject({ type: "session.metadata" });
    if (longTitle?.type !== "session.metadata") throw new Error("Expected metadata DTO");
    expect(longTitle.data.title?.length).toBe(200);
  });

  it("rejects malformed or content-bearing metadata projections", () => {
    const created = 1_700_000_000_000;
    // A rename to a control-character-only title relays nothing.
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.renamed",
        id: "evt_blank",
        created,
        data: { sessionID: "ses_meta", title: "\u0007\u0008" },
      }),
    ).toBeUndefined();
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.model.selected",
        id: "evt_bad_model",
        created,
        data: { sessionID: "ses_meta", model: { providerID: "" } },
      }),
    ).toBeUndefined();
    expect(
      projectOpenCodeCacheObserverEvent({
        type: "session.metadata.updated",
        id: "evt_metadata_updated",
        created,
        data: { sessionID: "ses_meta", metadata: { arbitrary: "content" } },
      }),
    ).toBeUndefined();
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.metadata",
        created,
        data: { sessionID: "ses_meta", title: "Fine" },
      }),
    ).toBe(true);
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.metadata",
        created,
        data: { sessionID: "ses_meta", title: "Fine", cost: 12 },
      }),
    ).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.metadata",
        created,
        data: { sessionID: "ses_meta", title: "has\u0007control" },
      }),
    ).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        type: "session.metadata",
        data: { sessionID: "ses_meta", title: "Fine" },
      }),
    ).toBe(false);
  });
});
