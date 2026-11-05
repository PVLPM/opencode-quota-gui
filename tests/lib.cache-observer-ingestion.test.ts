import { describe, expect, it, vi } from "vitest";

import {
  cacheObserverUpdateFromOpenCodeEvent,
  createCacheObserverIngestor,
  projectOpenCodeCacheObserverEvent,
} from "../src/lib/cache-observer-ingestion.js";

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

describe("cache observer event ingestion", () => {
  it("uses the assistant message identity without inferring primary or route", () => {
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
          kind: "unknown",
          basis: { source: "OpenCode event session.step.ended", reference: "msg_1" },
        },
        counts: { read: 12 },
      },
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
