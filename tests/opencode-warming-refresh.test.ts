import { describe, expect, it } from "vitest";
import { OpencodeWarmingRefreshTracker } from "../src/lib/opencode-warming-refresh.js";

const model = { providerID: "provider", id: "model" };
const step = { data: { sessionID: "session", model } };
const usage = (read?: number) => ({
  data: { sessionID: "session", tokens: { cache: { read } } },
});
const request = (kind = "generate", requestModel = model) => ({
  sessionID: "session",
  kind,
  model: requestModel,
});

function ready(stepModel = model) {
  const tracker = new OpencodeWarmingRefreshTracker();
  tracker.onStepStarted({ data: { sessionID: "session", model: stepModel } });
  tracker.onStepEnded({ data: { sessionID: "session", model: stepModel } });
  tracker.onUsageUpdated(usage(10));
  return tracker;
}

describe("OpencodeWarmingRefreshTracker", () => {
  it("accepts a single matching generate with increased cache reads", () => {
    const tracker = ready();
    tracker.onModelRequest(request(), 123);
    expect(tracker.onUsageUpdated(usage(11))).toEqual({
      sessionID: "session",
      dispatchMs: 123,
      evidence: "warming-inferred",
      route: { providerID: "provider", id: "model" },
    });
  });

  it("rejects a different variant and carries a matching variant route", () => {
    const high = { providerID: "provider", id: "model", variant: "high" };
    const mismatch = ready(high);
    mismatch.onModelRequest(request("generate", { ...high, variant: "low" }), 123);
    expect(mismatch.onUsageUpdated(usage(11))).toBeUndefined();

    const match = ready(high);
    match.onModelRequest(request("generate", high), 123);
    expect(match.onUsageUpdated(usage(11))?.route).toEqual(high);
  });

  it("normalizes the default variant to an omitted route variant", () => {
    const tracker = ready({ providerID: "provider", id: "model", variant: "default" });
    tracker.onModelRequest(request(), 123);
    expect(tracker.onUsageUpdated(usage(11))).toEqual({
      sessionID: "session",
      dispatchMs: 123,
      evidence: "warming-inferred",
      route: { providerID: "provider", id: "model" },
    });
  });

  it.each(["started", "ended"])("rejects a step %s in the window", (phase) => {
    const tracker = ready();
    tracker.onModelRequest(request(), 123);
    if (phase === "started") tracker.onStepStarted(step);
    else tracker.onStepEnded(step);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
  });

  it.each([
    "generate",
    "title",
    "compaction",
    "primary",
  ])("rejects a window containing an additional %s request", (kind) => {
    const tracker = ready();
    tracker.onModelRequest(request(), 123);
    tracker.onModelRequest(request(kind), 124);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
  });

  it.each([10, undefined])("rejects unchanged or missing cache reads: %s", (read) => {
    const tracker = ready();
    tracker.onModelRequest(request(), 123);
    expect(tracker.onUsageUpdated(usage(read))).toBeUndefined();
  });

  it("rejects a missing baseline cache read", () => {
    const tracker = ready();
    tracker.onUsageUpdated(usage());
    tracker.onModelRequest(request(), 123);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
  });

  it("rejects when no baseline exists", () => {
    const tracker = new OpencodeWarmingRefreshTracker();
    tracker.onStepStarted(step);
    tracker.onModelRequest(request(), 123);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
  });

  it("rejects a different model", () => {
    const tracker = ready();
    tracker.onModelRequest(request("generate", { providerID: "provider", id: "other" }), 123);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
  });

  it("does not attribute delayed usage after a rejected generate until a step ends", () => {
    const tracker = ready();
    tracker.onModelRequest(request(), 123);
    expect(tracker.onUsageUpdated(usage(10))).toBeUndefined();
    tracker.onModelRequest(request(), 124);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
    tracker.onStepEnded(step);
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
    tracker.onModelRequest(request(), 125);
    expect(tracker.onUsageUpdated(usage(12))?.dispatchMs).toBe(125);
  });

  it("never accepts without a request and ignores malformed events", () => {
    const tracker = ready();
    expect(() => {
      tracker.onModelRequest(null as never, 1);
      tracker.onStepStarted(null);
      tracker.onStepEnded({});
      tracker.onUsageUpdated(null);
    }).not.toThrow();
    expect(tracker.onUsageUpdated(usage(11))).toBeUndefined();
  });
});
