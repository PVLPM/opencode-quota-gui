import { describe, expect, it, vi } from "vitest";

import {
  cacheObserverUpdateFromOpenCodeEvent,
  cacheObserverUpdateFromRawOpenCodeEvent,
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
    finish: "stop",
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
  it("does not expose mutable route configuration that changes existing sessions", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_one", "one");
    ingestLiveRecoverableStep(ingestor, "ses_two", "two");
    expect(ingestor).not.toHaveProperty("setRouteConfiguration");
    for (const session of ["ses_one", "ses_two"]) {
      expect(ingestor.query(session)?.ttlEstimate?.deadlineAtMs).toBe(301_000);
    }
    ingestor.dispose();
  });

  it("retains live takeover after a failed different-route start", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_fence", "live");
    const before = ingestor.query("ses_fence");
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_fence",
          "failed",
          { providerID: "openai", id: "gpt-6.1" },
          1_200,
          1_250,
        ),
      ),
    );
    const failed = stepEndedEvent("ses_fence", "failed", {}, 1_300);
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent({ ...failed, data: { ...failed.data, finish: "error" } }),
    );
    expect(ingestor.hasUsableLiveObservation("ses_fence")).toBe(true);
    ingestor.ingestHistory([
      recoverableHistoryInvocation("ses_fence", "history", { created: 1_400, completed: 1_500 }),
    ]);
    expect(ingestor.query("ses_fence")).toEqual(before);
    ingestor.dispose();
  });
  it("preserves successful evidence when a different model starts but fails", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_switch", "ok");
    const before = ingestor.query("ses_switch");
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_switch",
          "failed",
          { providerID: "openai", id: "gpt-6.1" },
          2_000,
          2_010,
        ),
      ),
    );
    const failed = stepEndedEvent("ses_switch", "failed", {}, 2_100);
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent({ ...failed, data: { ...failed.data, finish: "error" } }),
    );
    expect(ingestor.query("ses_switch")).toEqual(before);
    ingestor.dispose();
  });
  it("records ended steps as successful primary requests from the runner path and requires Started for route", () => {
    expect(
      cacheObserverUpdateFromOpenCodeEvent(
        stepEndedEvent("ses_child", "msg_1", { cache: { read: 12 } }),
      ),
    ).toEqual({
      kind: "invocation",
      observation: {
        sessionId: "ses_child",
        order: { completedAtMs: 1_700_000_000_000, messageId: "msg_1" },
        basis: {
          source: "opencode-v2.2.0-session-runner",
          reference: "packages/core/src/session/runner/llm.ts#233-287",
        },
        counts: { read: 12 },
      },
    });
  });

  it("admits only successful finishes (stop and tool handoff) and excludes failed or incomplete steps", () => {
    const usage = { input: 10, cache: { read: 20, write: 0 } };
    const eligible = (finish: string) => {
      const event = stepEndedEvent("ses_finish", `msg_${finish}`, usage, 1_100);
      return { ...event, data: { ...event.data, finish } };
    };

    expect(projectOpenCodeCacheObserverEvent(eligible("stop"))).toMatchObject({
      type: "session.step.ended",
    });
    expect(projectOpenCodeCacheObserverEvent(eligible("tool-calls"))).toMatchObject({
      type: "session.step.ended",
    });
    for (const finish of ["length", "content-filter", "error", "unknown"]) {
      expect(projectOpenCodeCacheObserverEvent(eligible(finish))).toBeUndefined();
    }
    const withoutFinish = stepEndedEvent("ses_finish", "msg_no_finish", usage, 1_100);
    const { finish: _omitted, ...dataWithoutFinish } = withoutFinish.data;
    expect(
      projectOpenCodeCacheObserverEvent({ ...withoutFinish, data: dataWithoutFinish }),
    ).toBeUndefined();
  });

  it("keeps the last successful estimate when a newer step fails", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_failed", "msg_ok");
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_failed",
          "msg_failed",
          { providerID: "anthropic", id: "claude-test" },
          5_000,
          5_050,
        ),
      ),
    );
    const failedEnd = stepEndedEvent("ses_failed", "msg_failed", { input: 0 }, 5_100);
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent({
        ...failedEnd,
        data: { ...failedEnd.data, finish: "error" },
      }),
    );

    expect(ingestor.query("ses_failed")).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
  });

  it("starts a successful step's estimate from request start for a write, and reports a zero read as 0%", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestLiveRecoverableStep(ingestor, "ses_write", "msg_write", {
      input: 10,
      cache: { read: 0, write: 5 },
    });

    expect(ingestor.query("ses_write")).toMatchObject({
      color: "green",
      reason: "estimated-write-within-ttl",
      ttlEstimate: { kind: "documented", dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadRatio: { value: 0 },
      primaryCacheReadTelemetry: "available",
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

  it("correlates Started and Ended by exact session/message and estimates the documented route TTL", () => {
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
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: {
        kind: "documented",
        dispatchAtMs: 1_000,
        deadlineAtMs: 301_000,
      },
    });
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
      reason: "route-unverified",
    });
  });

  it("classifies documented direct-provider estimates green, then yellow and red at TTL boundaries", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    const dispatch = (sessionId: string, providerId: string) => {
      ingestor.ingest(
        projectOpenCodeCacheObserverEvent(
          stepStartedEvent(
            sessionId,
            `msg_${sessionId}`,
            { providerID: providerId, id: "model-test" },
            1_000,
            1_050,
          ),
        ),
      );
      ingestor.ingest(
        projectOpenCodeCacheObserverEvent(
          stepEndedEvent(
            sessionId,
            `msg_${sessionId}`,
            { input: 10, cache: { read: 20, write: 0 } },
            1_100,
          ),
        ),
      );
    };

    dispatch("ses_direct", "moonshotai");
    expect(ingestor.query("ses_direct")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: {
        kind: "documented",
        ttlMs: 300_000,
        dispatchAtMs: 1_000,
        deadlineAtMs: 301_000,
        assumption:
          "assuming direct standard route/default TTL; custom endpoint, gateway, changed configuration or provider eviction may cause miss",
      },
    });

    now = 241_000;
    expect(ingestor.query("ses_direct")).toMatchObject({
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
      recheckAtMs: 301_000,
    });
    now = 301_000;
    expect(ingestor.query("ses_direct")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });

    // A gateway is not a vendor route: it gets the generic 5-minute fallback, never a vendor window.
    dispatch("ses_gateway", "openrouter");
    expect(ingestor.query("ses_gateway")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
      ttlEstimate: { kind: "fallback", ttlMs: 300_000, deadlineAtMs: 301_000 },
    });
    ingestor.dispose();
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
      reason: "route-unverified",
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
      color: "green",
      reason: "estimated-reuse-within-ttl",
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
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { dispatchAtMs: 10_000 },
    });
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
      reason: "route-unverified",
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
      reason: "route-unverified",
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
      reason: "route-unverified",
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
      reason: "route-unverified",
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
      expect.objectContaining({ color: "gray", reason: "route-unverified" }),
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
      reason: "route-unverified",
    });

    const remountedListener = vi.fn();
    const secondRelease = ingestor.subscribe("ses_remount", remountedListener);
    expect(ingestor.query("ses_remount")).toMatchObject({
      color: "gray",
      reason: "route-unverified",
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
      reason: "route-unverified",
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
        color: "green",
        reason: "estimated-reuse-within-ttl",
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
      expect(colors).toEqual(["green", "yellow", "red"]);
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
      finish: "stop",
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

  it("projects only successful history messages, excluding failed, incomplete, or errored ones", () => {
    const base = {
      type: "assistant",
      id: "msg_history_gate",
      model: { providerID: "anthropic", id: "claude-test" },
      time: { created: 1_000, completed: 1_500 },
      tokens: { input: 10, cache: { read: 20, write: 0 } },
    };
    const sessionId = "ses_history_gate";

    expect(projectOpenCodeCacheObserverHistoryMessage(sessionId, base)).toBeUndefined();
    for (const finish of ["length", "error", "content-filter", "unknown"]) {
      expect(
        projectOpenCodeCacheObserverHistoryMessage(sessionId, { ...base, finish }),
      ).toBeUndefined();
    }
    expect(
      projectOpenCodeCacheObserverHistoryMessage(sessionId, {
        ...base,
        finish: "stop",
        error: { type: "aborted", message: "interrupted" },
      }),
    ).toBeUndefined();
    expect(
      projectOpenCodeCacheObserverHistoryMessage(sessionId, { ...base, finish: "tool-calls" }),
    ).toMatchObject({ messageId: "msg_history_gate", dispatchAtMs: 1_000 });
  });

  it("estimates old history sessions from the message-list request-start time", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    const history = projectOpenCodeCacheObserverHistoryMessage("ses_history_start", {
      type: "assistant",
      id: "msg_history_start",
      finish: "stop",
      model: { providerID: "anthropic", id: "claude-test" },
      time: { created: 1_000, completed: 1_500 },
      tokens: { input: 100, cache: { read: 20, write: 10 } },
    });
    expect(history?.dispatchAtMs).toBe(1_000);
    if (history === undefined) throw new Error("expected the history message to be projected");

    ingestor.ingestHistory([history]);

    expect(ingestor.query("ses_history_start")).toMatchObject({
      color: "green",
      reason: "estimated-reuse-within-ttl",
      ttlEstimate: { kind: "documented", dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });

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
      reason: "route-unverified",
    });
    expect(ingestor.query("ses_orphan_live")).not.toHaveProperty("primaryCacheReadRatio");
    expect(ingestor.query("ses_orphan_live")).not.toHaveProperty("ttlEstimate");
    ingestor.dispose();
  });

  it("keeps zero-telemetry openai-family calls unavailable for share while estimating them with the generic fallback", () => {
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
      color: "green",
      reason: "estimated-within-ttl",
      ttlEstimate: { kind: "fallback", ttlMs: 300_000, deadlineAtMs: 301_000 },
      primaryCacheReadTelemetry: "unavailable",
    });
    expect(ingestor.query("ses_unsupported_live")).not.toHaveProperty("primaryCacheReadRatio");
    ingestor.dispose();
  });

  it("keeps the last observed estimate and cache share through an observation gap, without gray", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    ingestLiveRecoverableStep(ingestor, "ses_persist", "msg_persist");
    const before = ingestor.query("ses_persist");
    expect(before).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
      primaryCacheReadRatio: { messageId: "msg_persist" },
    });

    ingestor.markObservationGap("ses_persist");
    expect(ingestor.query("ses_persist")).toEqual(before);

    // The clock keeps running across the gap: the final 20% (from 241_000) turns yellow, then red.
    now = 241_000;
    expect(ingestor.query("ses_persist")).toMatchObject({
      color: "yellow",
      reason: "estimated-ttl-near-expiry",
    });
    now = 301_000;
    expect(ingestor.query("ses_persist")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
    ingestor.dispose();
  });

  it("keeps a retained estimate across the last subscriber leaving and a later reopen", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    const release = ingestor.subscribe("ses_reopen", vi.fn());
    ingestLiveRecoverableStep(ingestor, "ses_reopen", "msg_reopen");
    release();

    now = 100_000;
    const reopened = vi.fn();
    const releaseAgain = ingestor.subscribe("ses_reopen", reopened);
    expect(ingestor.query("ses_reopen")).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    releaseAgain();
    ingestor.dispose();
  });

  it("lets a fresh history read after a gap supersede the estimate with the newer successful call", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    ingestLiveRecoverableStep(ingestor, "ses_refresh", "msg_old");
    ingestor.markObservationGap("ses_refresh");

    now = 6_000;
    ingestor.ingestHistory([
      recoverableHistoryInvocation("ses_refresh", "msg_new", {
        created: 5_000,
        completed: 5_100,
        tokens: { input: 10, cache: { read: 0, write: 0 } },
      }),
    ]);

    expect(ingestor.query("ses_refresh")).toMatchObject({
      color: "green",
      ttlEstimate: { dispatchAtMs: 5_000, deadlineAtMs: 305_000 },
      primaryCacheReadRatio: { value: 0, messageId: "msg_new" },
    });
    ingestor.dispose();
  });

  it("does not let history supersede the live stream's estimate without an observation gap", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    ingestLiveRecoverableStep(ingestor, "ses_no_gap", "msg_live");
    const before = ingestor.query("ses_no_gap");

    now = 6_000;
    ingestor.ingestHistory([
      recoverableHistoryInvocation("ses_no_gap", "msg_history_newer", {
        created: 5_000,
        completed: 5_100,
      }),
    ]);

    expect(ingestor.query("ses_no_gap")).toEqual(before);
    ingestor.dispose();
  });

  it("anchors a long successful call's estimate at its request start, not its completion", () => {
    let now = 2_000;
    const ingestor = createCacheObserverIngestor({ now: () => now });
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepStartedEvent(
          "ses_long",
          "msg_long",
          { providerID: "anthropic", id: "claude-test" },
          1_000,
          1_050,
        ),
      ),
    );
    ingestor.ingest(
      projectOpenCodeCacheObserverEvent(
        stepEndedEvent(
          "ses_long",
          "msg_long",
          { input: 10, cache: { read: 20, write: 0 } },
          290_100,
        ),
      ),
    );

    now = 241_000;
    expect(ingestor.query("ses_long")).toMatchObject({
      color: "yellow",
      ttlEstimate: { dispatchAtMs: 1_000, deadlineAtMs: 301_000 },
    });
    now = 301_000;
    expect(ingestor.query("ses_long")).toMatchObject({
      color: "red",
      reason: "estimated-ttl-expired",
    });
    ingestor.dispose();
  });

  it("drops an unsuccessful raw step.ended before it reaches the ingestor", () => {
    const end = stepEndedEvent(
      "ses_raw",
      "msg_raw",
      { input: 0, cache: { read: 5, write: 0 } },
      5_100,
    );
    for (const finish of ["length", "content-filter", "error", "unknown"]) {
      expect(
        cacheObserverUpdateFromRawOpenCodeEvent({ ...end, data: { ...end.data, finish } }),
      ).toBeUndefined();
    }
    expect(cacheObserverUpdateFromRawOpenCodeEvent(end)).toBeDefined();
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
