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

function ready() {
  const tracker = new OpencodeWarmingRefreshTracker();
  tracker.onStepStarted(step);
  tracker.onStepEnded(step);
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
