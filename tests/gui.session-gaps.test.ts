import { describe, expect, it } from "vitest";
import type { ModelIdentity, SessionSnapshot, StepPoint } from "../src/contracts/dashboard.js";
import { formatElapsed } from "../src/ui/format.js";
import {
  formatCacheReuse,
  HIGH_REUSE_THRESHOLD_PCT,
  SESSION_GAP_LABELS,
  sessionGapMetrics,
  stepCacheReuse,
  stepTimings,
} from "../src/ui/session-gaps.js";

const MODEL: ModelIdentity = { providerId: "openai", modelId: "gpt-5", effort: "high" };

interface StepSpec {
  id: string;
  created?: number;
  done: number;
  session?: string;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  model?: ModelIdentity | null;
  readUnknown?: true;
  writeUnknown?: true;
}

function step(spec: StepSpec): StepPoint {
  const stack = {
    input: spec.input ?? 100,
    cacheRead: spec.cacheRead ?? 0,
    cacheWrite: spec.cacheWrite ?? 0,
    output: 1,
    reasoning: 0,
  };
  const point: StepPoint = {
    sessionId: spec.session ?? "ses_root",
    messageId: spec.id,
    atMs: spec.done,
    branch: 0,
    stack,
    contextTokens: stack.input + stack.cacheRead + stack.cacheWrite,
    totalTokens: stack.input + stack.cacheRead + stack.cacheWrite + 1,
  };
  if (spec.created !== undefined) point.createdAtMs = spec.created;
  if (spec.model !== null) point.model = spec.model ?? MODEL;
  if (spec.readUnknown) point.cacheReadUnknown = true;
  if (spec.writeUnknown) point.cacheWriteUnknown = true;
  return point;
}

function snapshot(
  steps: StepPoint[],
  extra: Partial<Pick<SessionSnapshot, "compactionMarkers" | "unobservedAtMs">> = {},
): SessionSnapshot {
  return {
    focusSessionId: "ses_root",
    steps,
    compactionMarkers: [],
    ...extra,
  } as SessionSnapshot;
}

const SEC = 1_000;

describe("labels and formatting", () => {
  it("exposes the exact owner wording", () => {
    expect(SESSION_GAP_LABELS.longestIdleGap).toBe("Longest idle gap");
    expect(SESSION_GAP_LABELS.longestHighReuseGap).toBe("Longest high-reuse gap");
    expect(SESSION_GAP_LABELS.unavailable).toBe("Unavailable");
    expect(SESSION_GAP_LABELS.messageDuration).toBe("Message created → completed");
    expect(HIGH_REUSE_THRESHOLD_PCT).toBe(90);
    expect(formatCacheReuse(16.6)).toBe("Cache reuse: 17%");
    expect(formatCacheReuse(null)).toBe("Cache reuse: Unavailable");
    expect(formatCacheReuse(Number.NaN)).toBe("Cache reuse: Unavailable");
  });

  it("separates unknown from zero cache reads and never invents 0%", () => {
    expect(stepCacheReuse(step({ id: "a", done: 1, cacheRead: 0 }))).toBe(0);
    expect(stepCacheReuse(step({ id: "a", done: 1, readUnknown: true }))).toBeNull();
    expect(stepCacheReuse(step({ id: "a", done: 1, cacheRead: 5, writeUnknown: true }))).toBeNull();
    expect(stepCacheReuse(step({ id: "a", done: 1, input: 0 }))).toBeNull();
    expect(
      stepCacheReuse(step({ id: "a", done: 1, input: 10, cacheRead: 80, cacheWrite: 10 })),
    ).toBe(80);
  });
});

describe("per-step timing", () => {
  it("reports duration and idle for a sequential session", () => {
    const steps = [
      step({ id: "a", created: 0 + 1, done: 11 * SEC }),
      step({ id: "b", created: 21 * SEC, done: 25 * SEC }),
    ];
    const [first, second] = stepTimings(steps);
    expect(first).toMatchObject({ durationMs: 11 * SEC - 1, overlap: false });
    expect(first).not.toHaveProperty("idleMs");
    expect(second).toMatchObject({ previousStepIndex: 0, idleMs: 10 * SEC, durationMs: 4 * SEC });
  });

  it("flags overlap and never reports a negative idle", () => {
    const steps = [
      step({ id: "a", created: 1_000, done: 100_000 }),
      step({ id: "b", created: 10_000, done: 50_000 }),
      step({ id: "c", created: 120_000, done: 130_000 }),
    ];
    const timings = stepTimings(steps);
    expect(timings[1]).toMatchObject({ overlap: true, overlapMs: 90_000 });
    expect(timings[1]).not.toHaveProperty("idleMs");
    // Idle is measured from the latest finisher (a), not the overlapped b.
    expect(timings[2]).toMatchObject({ previousStepIndex: 0, idleMs: 20_000, overlap: false });
  });

  it("omits timing it cannot trust (missing, invalid or inverted timestamps)", () => {
    const steps = [
      step({ id: "a", done: 5_000 }),
      step({ id: "b", created: 9_000, done: 8_000 }),
      step({ id: "c", created: 0, done: 20_000 }),
      step({ id: "d", created: Number.NaN, done: 30_000 }),
    ];
    const [a, b, c, d] = stepTimings(steps);
    expect(a).not.toHaveProperty("createdAtMs");
    expect(a).not.toHaveProperty("durationMs");
    expect(b).toMatchObject({ createdAtMs: 9_000 });
    expect(b).not.toHaveProperty("durationMs");
    expect(c).not.toHaveProperty("idleMs");
    expect(d).not.toHaveProperty("idleMs");
    for (const timing of [a, b, c, d]) expect(timing?.idleMs ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("sequences every session separately so parallel child agents are not one run", () => {
    const steps = [
      step({ id: "root1", created: 0 + 1, done: 10_000 }),
      step({ id: "kid1", session: "ses_a", created: 2_000, done: 12_000 }),
      step({ id: "kid2", session: "ses_b", created: 3_000, done: 13_000 }),
      step({ id: "root2", created: 40_000, done: 50_000 }),
      step({ id: "kid3", session: "ses_a", created: 60_000, done: 70_000 }),
    ];
    const timings = stepTimings(steps);
    expect(timings[1]).not.toHaveProperty("previousStepIndex");
    expect(timings[2]).not.toHaveProperty("previousStepIndex");
    expect(timings[3]).toMatchObject({ previousStepIndex: 0, idleMs: 30_000 });
    expect(timings[4]).toMatchObject({ previousStepIndex: 1, idleMs: 48_000 });
  });
});

describe("longest idle / high-reuse gaps", () => {
  const warm = { input: 5, cacheRead: 95 };

  it("picks the longest sequential gap and the longest one with cache reuse >= 90%", () => {
    const metrics = sessionGapMetrics(
      snapshot([
        step({ id: "a", created: 1_000, done: 2_000 }),
        step({ id: "b", created: 12_000, done: 13_000, ...warm }), // 10s idle, 95%
        step({ id: "c", created: 313_000, done: 314_000, input: 90, cacheRead: 10 }), // 300s idle, 10%
        step({ id: "d", created: 334_000, done: 335_000, ...warm }), // 20s idle, 95%
      ]),
    );
    expect(metrics.sessionId).toBe("ses_root");
    expect(metrics.longestIdle).toMatchObject({
      fromStepIndex: 1,
      toStepIndex: 2,
      idleMs: 300_000,
    });
    expect(metrics.longestIdle?.cacheReusePct).toBeCloseTo(10);
    expect(metrics.longestHighReuse).toMatchObject({ toStepIndex: 3, idleMs: 20_000 });
    expect(formatCacheReuse(metrics.longestHighReuse?.cacheReusePct ?? null)).toBe(
      "Cache reuse: 95%",
    );
    expect(metrics.overlappingSteps).toBe(0);
  });

  it("reports Unavailable data as null when nothing qualifies", () => {
    expect(sessionGapMetrics(snapshot([]))).toMatchObject({
      longestIdle: null,
      longestHighReuse: null,
    });
    const single = sessionGapMetrics(snapshot([step({ id: "a", created: 1_000, done: 2_000 })]));
    expect(single.longestIdle).toBeNull();
    const cold = sessionGapMetrics(
      snapshot([
        step({ id: "a", created: 1_000, done: 2_000 }),
        step({ id: "b", created: 9_000, done: 10_000, input: 100, cacheRead: 0 }),
      ]),
    );
    expect(cold.longestIdle).toMatchObject({ idleMs: 7_000, cacheReusePct: 0 });
    expect(cold.longestHighReuse).toBeNull();
  });

  it("keeps the gap but never invents reuse when the next message's counters are unknown", () => {
    const metrics = sessionGapMetrics(
      snapshot([
        step({ id: "a", created: 1_000, done: 2_000 }),
        step({ id: "b", created: 9_000, done: 10_000, readUnknown: true }),
      ]),
    );
    expect(metrics.longestIdle).toMatchObject({ idleMs: 7_000, cacheReusePct: null });
    expect(metrics.longestHighReuse).toBeNull();
    expect(stepCacheReuse(step({ id: "z", done: 1, cacheRead: 0 }))).toBe(0);
  });

  it("excludes overlapping and concurrent requests from idle gaps", () => {
    const metrics = sessionGapMetrics(
      snapshot([
        step({ id: "a", created: 1_000, done: 100_000 }),
        step({ id: "b", created: 10_000, done: 50_000, ...warm }), // overlaps a
        step({ id: "c", created: 120_000, done: 130_000, ...warm }), // prev finisher a is not adjacent
      ]),
    );
    expect(metrics.overlappingSteps).toBe(1);
    expect(metrics.longestIdle).toBeNull();
  });

  it("uses only the focused session's own sequence, never child agents", () => {
    const metrics = sessionGapMetrics(
      snapshot([
        step({ id: "r1", created: 1_000, done: 2_000 }),
        step({ id: "k1", session: "ses_kid", created: 3_000, done: 4_000 }),
        step({ id: "k2", session: "ses_kid", created: 900_000, done: 901_000, ...warm }),
        step({ id: "r2", created: 9_000, done: 10_000, ...warm }),
      ]),
    );
    expect(metrics.longestIdle).toMatchObject({ fromStepIndex: 0, toStepIndex: 3, idleMs: 7_000 });
  });

  it("does not compare incomparable provider/model/effort identities", () => {
    const high = { ...MODEL };
    const base = [
      step({ id: "a", created: 1_000, done: 2_000, model: high }),
      step({
        id: "b",
        created: 500_000,
        done: 501_000,
        model: { ...high, effort: "low" },
        ...warm,
      }),
      step({
        id: "c",
        created: 510_000,
        done: 511_000,
        model: { ...high, modelId: "other" },
        ...warm,
      }),
      step({ id: "d", created: 520_000, done: 521_000, model: null, ...warm }),
      step({ id: "e", created: 530_000, done: 531_000, model: null, ...warm }),
    ];
    const metrics = sessionGapMetrics(snapshot(base));
    // effort-only, model switch and unknown identity (both sides) all fail.
    expect(metrics.longestIdle).toBeNull();
    const same = sessionGapMetrics(
      snapshot([
        step({ id: "a", created: 1_000, done: 2_000, model: high }),
        step({ id: "b", created: 500_000, done: 501_000, model: { ...high }, ...warm }),
      ]),
    );
    expect(same.longestHighReuse).toMatchObject({ idleMs: 498_000 });
  });

  it("does not bridge a compaction boundary", () => {
    const steps = [
      step({ id: "a", created: 1_000, done: 2_000 }),
      step({ id: "b", created: 500_000, done: 501_000, ...warm }),
      step({ id: "c", created: 510_000, done: 511_000, ...warm }),
    ];
    const metrics = sessionGapMetrics(
      snapshot(steps, {
        compactionMarkers: [
          { sessionId: "ses_root", atMs: 250_000, messageId: "cmp" },
          { sessionId: "ses_other", atMs: 505_000, messageId: "elsewhere" },
        ],
      }),
    );
    expect(metrics.longestIdle).toMatchObject({ toStepIndex: 2, idleMs: 9_000 });
  });

  it("does not bridge a history gap (excluded or unowned message between)", () => {
    const steps = [
      step({ id: "a", created: 1_000, done: 2_000 }),
      step({ id: "b", created: 500_000, done: 501_000, ...warm }),
    ];
    expect(
      sessionGapMetrics(snapshot(steps, { unobservedAtMs: [250_000] })).longestIdle,
    ).toBeNull();
    expect(
      sessionGapMetrics(snapshot(steps, { unobservedAtMs: [700_000] })).longestIdle,
    ).toMatchObject({ idleMs: 498_000 });
  });

  it("skips pairs whose timestamps are missing or invalid", () => {
    const metrics = sessionGapMetrics(
      snapshot([
        step({ id: "a", done: 2_000 }),
        step({ id: "b", done: 500_000, ...warm }),
        step({ id: "c", created: 0, done: 600_000, ...warm }),
      ]),
    );
    expect(metrics.longestIdle).toBeNull();
    expect(metrics.longestHighReuse).toBeNull();
  });

  it("treats exactly 90% as high reuse and 89.9% as not", () => {
    const at = (cacheRead: number, input: number) =>
      sessionGapMetrics(
        snapshot([
          step({ id: "a", created: 1_000, done: 2_000 }),
          step({ id: "b", created: 9_000, done: 10_000, input, cacheRead }),
        ]),
      ).longestHighReuse;
    expect(at(90, 10)).not.toBeNull();
    expect(at(899, 101)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("formats short, minute and hour spans and rejects bad input", () => {
    expect(formatElapsed(850)).toBe("850 ms");
    expect(formatElapsed(4200)).toBe("4.2s");
    expect(formatElapsed(725_000)).toBe("12m 05s");
    expect(formatElapsed(7_380_000)).toBe("2h 03m");
    expect(formatElapsed(undefined)).toBe("-");
    expect(formatElapsed(-1)).toBe("-");
  });
});
