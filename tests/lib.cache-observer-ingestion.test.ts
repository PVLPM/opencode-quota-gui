import { describe, expect, it, vi } from "vitest";

import {
  cacheObserverUpdateFromOpenCodeEvent,
  createCacheObserverIngestor,
  projectOpenCodeCacheObserverEvent,
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
      reason: "ttl-unverified",
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
      color: "yellow",
      reason: "ambiguous-invocation",
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
      color: "yellow",
      reason: "ambiguous-invocation",
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
      reason: "ttl-unverified",
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
      reason: "ttl-unverified",
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
      color: "yellow",
      reason: "ambiguous-invocation",
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
      color: "yellow",
      reason: "ambiguous-invocation",
    });

    ingestor.ingest({
      type: "session.deleted",
      id: "evt_delete_parent",
      created: 1_700_000_000_007,
      data: { sessionID: "ses_parent" },
    });

    expect(ingestor.query("ses_parent")).toBeUndefined();
    expect(ingestor.query("ses_child")).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
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
      color: "yellow",
      reason: "ambiguous-invocation",
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
      expect.objectContaining({ color: "yellow", reason: "ambiguous-invocation" }),
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
      color: "yellow",
      reason: "ambiguous-invocation",
    });

    const remountedListener = vi.fn();
    const secondRelease = ingestor.subscribe("ses_remount", remountedListener);
    expect(ingestor.query("ses_remount")).toMatchObject({
      color: "yellow",
      reason: "ambiguous-invocation",
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
      color: "yellow",
      reason: "ambiguous-invocation",
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
});
