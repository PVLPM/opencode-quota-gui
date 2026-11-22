import { describe, expect, it } from "vitest";

import {
  createCacheObserverIngestor,
  projectOpenCodeCacheObserverEvent,
} from "../src/lib/cache-observer-ingestion.js";
import { isDashboardRpcCacheObserverEvent } from "../src/rpc.js";

const SESSION = "ses_claude";
const STEP = "msg_step";

function started(provider: string, id = STEP, session = SESSION, at = 1_000) {
  return {
    type: "session.step.started",
    created: at + 50,
    data: {
      sessionID: session,
      assistantMessageID: id,
      agent: "build",
      model: { providerID: provider, id: "claude-test" },
      started: at,
    },
  };
}
function ended(id = STEP, session = SESSION, at = 1_100) {
  return {
    type: "session.step.ended",
    created: at,
    data: {
      sessionID: session,
      assistantMessageID: id,
      finish: "stop",
      cost: 0,
      tokens: { input: 3, cache: { read: 100, write: 50 } },
    },
  };
}
const ttlEvent = (id = STEP, session = SESSION, ttlMs: unknown = 3_600_000) => ({
  type: "session.cache.ttl",
  created: 1_200,
  data: { sessionID: session, assistantMessageID: id, ttlMs },
});

function ingestStep(
  ingestor: ReturnType<typeof createCacheObserverIngestor>,
  provider = "claude-agent",
  id = STEP,
  session = SESSION,
  at = 1_000,
) {
  ingestor.ingest(projectOpenCodeCacheObserverEvent(started(provider, id, session, at)));
  ingestor.ingest(projectOpenCodeCacheObserverEvent(ended(id, session, at + 100)));
}

describe("claude-agent observed 1h refinement", () => {
  it("keeps the generic 5-minute estimate until a refinement arrives", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestStep(ingestor);
    expect(ingestor.query(SESSION)?.ttlEstimate).toMatchObject({
      kind: "fallback",
      ttlMs: 300_000,
    });
  });

  it("upgrades exactly the completed invocation to a 60-minute observed estimate from request start", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestStep(ingestor);
    ingestor.ingest(ttlEvent());
    expect(ingestor.query(SESSION)?.ttlEstimate).toMatchObject({
      kind: "observed",
      ttlMs: 3_600_000,
      dispatchAtMs: 1_000,
      deadlineAtMs: 3_601_000,
    });
  });

  it("ignores a refinement for another session, another message, or a non-claude route", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestStep(ingestor);
    ingestor.ingest(ttlEvent(STEP, "ses_other"));
    ingestor.ingest(ttlEvent("msg_other"));
    expect(ingestor.query(SESSION)?.ttlEstimate?.kind).toBe("fallback");

    const anthropic = createCacheObserverIngestor({ now: () => 2_000 });
    ingestStep(anthropic, "anthropic");
    anthropic.ingest(ttlEvent());
    expect(anthropic.query(SESSION)?.ttlEstimate?.kind).toBe("documented");
    expect(anthropic.query(SESSION)?.ttlEstimate?.ttlMs).toBe(300_000);
  });

  it("ignores a live refinement whose ttlMs is not exactly 3600000", () => {
    for (const ttlMs of [300_000, 1_800_000, "3600000"]) {
      const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
      ingestStep(ingestor);
      ingestor.ingest(ttlEvent(STEP, SESSION, ttlMs));
      expect(ingestor.query(SESSION)?.ttlEstimate?.kind).toBe("fallback");
    }
  });

  it("does not upgrade when a newer invocation exists, and the newer one is not refined", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestStep(ingestor, "claude-agent", "msg_old", SESSION, 1_000);
    ingestStep(ingestor, "claude-agent", "msg_new", SESSION, 1_500);
    ingestor.ingest(ttlEvent("msg_old"));
    expect(ingestor.query(SESSION)?.ttlEstimate?.kind).toBe("fallback");
  });

  it("does not leak into a later invocation", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestStep(ingestor, "claude-agent", "msg_old", SESSION, 1_000);
    ingestor.ingest(ttlEvent("msg_old"));
    ingestStep(ingestor, "claude-agent", "msg_new", SESSION, 1_500);
    expect(ingestor.query(SESSION)?.ttlEstimate?.kind).toBe("fallback");
  });

  it("history ingestion never produces an observed estimate", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestor.ingestHistory([
      {
        sessionId: SESSION,
        messageId: STEP,
        completedAtMs: 1_100,
        dispatchAtMs: 1_000,
        route: {
          providerId: "claude-agent",
          modelId: "m",
          basis: { source: "test", reference: STEP },
        },
        counts: { fresh: 3, read: 100, write: 50 },
      },
    ]);
    expect(ingestor.query(SESSION)?.ttlEstimate?.kind).toBe("fallback");
  });

  it("ignores a refinement without any completed invocation", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestor.ingest(ttlEvent());
    expect(ingestor.query(SESSION)).toBeUndefined();
  });
});

describe("session.cache.ttl DTO validation", () => {
  it("accepts only the exact 1h shape", () => {
    expect(isDashboardRpcCacheObserverEvent(ttlEvent())).toBe(true);
    expect(isDashboardRpcCacheObserverEvent(ttlEvent(STEP, SESSION, 300_000))).toBe(false);
    expect(isDashboardRpcCacheObserverEvent(ttlEvent(STEP, SESSION, "3600000"))).toBe(false);
    expect(isDashboardRpcCacheObserverEvent(ttlEvent(""))).toBe(false);
    expect(
      isDashboardRpcCacheObserverEvent({
        ...ttlEvent(),
        data: { ...ttlEvent().data, path: "C:\\x" },
      }),
    ).toBe(false);
    expect(isDashboardRpcCacheObserverEvent({ ...ttlEvent(), extra: 1 })).toBe(false);
    expect(isDashboardRpcCacheObserverEvent({ ...ttlEvent(), created: Number.NaN })).toBe(false);
  });
});

describe("warming refresh", () => {
  const warming = (dispatchMs: number, sessionID = SESSION) => ({
    type: "session.cache.warming",
    data: { sessionID, dispatchMs, evidence: "warming-inferred" },
  });

  it("validates the exact relay shape", () => {
    expect(isDashboardRpcCacheObserverEvent(warming(1_500))).toBe(true);
    for (const bad of [
      warming(-1),
      warming(Number.NaN),
      warming(1_500, ""),
      { ...warming(1_500), extra: true },
      { ...warming(1_500), data: { ...warming(1_500).data, evidence: "observed" } },
    ])
      expect(isDashboardRpcCacheObserverEvent(bad)).toBe(false);
  });

  it("reanchors only an existing newer estimate and clears on a later completed step", () => {
    const ingestor = createCacheObserverIngestor({ now: () => 2_000 });
    ingestor.ingest(warming(1_500));
    expect(ingestor.query(SESSION)).toBeUndefined();
    ingestStep(ingestor);
    expect(ingestor.query(SESSION)?.ttlEstimate?.anchor).toBeUndefined();
    ingestor.ingest(warming(1_500));
    expect(ingestor.query(SESSION)?.ttlEstimate).toMatchObject({
      ttlMs: 300_000,
      deadlineAtMs: 301_500,
      anchor: "warming-inferred",
      anchorAtMs: 1_500,
    });
    ingestor.ingest(warming(1_200));
    expect(ingestor.query(SESSION)?.ttlEstimate?.anchorAtMs).toBe(1_500);
    ingestStep(ingestor, "claude-agent", "new", SESSION, 1_700);
    expect(ingestor.query(SESSION)?.ttlEstimate?.anchor).toBeUndefined();
    ingestor.dispose();
  });
});
