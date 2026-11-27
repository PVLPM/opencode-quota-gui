import { describe, expect, it } from "vitest";
import type { CostedTokens } from "../src/contracts/dashboard.js";
import type { UsageActivityEntry, UsageActivityInterval } from "../src/contracts/usage-activity.js";
import {
  attributeUsageWindow,
  modelEligibilityForNamedWindow,
  quotaProviderRuntimeIds,
  type UsageAttributionIntervalInput,
} from "../src/gui/usage-attribution.js";

function costed(
  input: number,
  apiEquivalentCostUsd: number | null,
  overrides: Partial<CostedTokens> = {},
): CostedTokens {
  return {
    input,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: input,
    apiEquivalentCostUsd,
    unpricedTokens: 0,
    unknownTokens: 0,
    ...overrides,
  };
}

function activity(
  startMs: number,
  endMs: number,
  entries: UsageActivityEntry[],
): UsageActivityInterval {
  return {
    startMs,
    endMs,
    entries,
    incomplete: entries.some(
      (entry) =>
        entry.tokens.apiEquivalentCostUsd === null ||
        entry.tokens.unpricedTokens > 0 ||
        entry.tokens.unknownTokens > 0,
    ),
    unpricedTokens: entries.reduce((sum, entry) => sum + entry.tokens.unpricedTokens, 0),
    unknownTokens: entries.reduce((sum, entry) => sum + entry.tokens.unknownTokens, 0),
  };
}

function interval(
  overrides: Partial<UsageAttributionIntervalInput> = {},
): UsageAttributionIntervalInput {
  return {
    startMs: 0,
    endMs: 1_000,
    burnPercentPoints: 10,
    link: "observed",
    soleObservedAccount: true,
    ...overrides,
  };
}

describe("usage attribution D7", () => {
  it("attributes a single eligible model's whole burn", () => {
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          {
            providerId: "openai",
            modelId: "gpt-5",
            effort: "high",
            tokens: costed(100, 2),
            stepCount: 2,
          },
        ]),
      ],
      providerIds: ["openai"],
    });

    const first = result.intervals[0];
    expect(first?.attributedBurnPercentPoints).toBe(10);
    expect(first?.unattributedBurnPercentPoints).toBe(0);
    expect(first?.unattributedReason).toBeUndefined();
    expect(first?.activity[0]?.estimatedBurnPercentPoints).toBeCloseTo(10);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]?.estimatedBurnPercentPoints).toBeCloseTo(10);
    expect(result.breakdown[0]?.efforts[0]?.effort).toBe("high");
  });

  it("splits burn proportionally by precomputed cost weight", () => {
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 1), stepCount: 1 },
          { providerId: "openai", modelId: "o3", tokens: costed(300, 3), stepCount: 1 },
        ]),
      ],
      providerIds: ["openai"],
    });

    const estimates = result.intervals[0]?.activity.map(
      (entry) => entry.estimatedBurnPercentPoints,
    );
    expect(estimates?.[0]).toBeCloseTo(2.5);
    expect(estimates?.[1]).toBeCloseTo(7.5);
    expect((estimates?.[0] ?? 0) + (estimates?.[1] ?? 0)).toBeCloseTo(
      result.intervals[0]?.attributedBurnPercentPoints ?? 0,
    );
  });

  it("leaves the whole burn unattributed when any eligible step is partially unpriced", () => {
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 1), stepCount: 1 },
          {
            providerId: "openai",
            modelId: "o3",
            tokens: costed(100, 0.5, { unpricedTokens: 25 }),
            stepCount: 1,
          },
        ]),
      ],
      providerIds: ["openai"],
    });

    const first = result.intervals[0];
    expect(first?.unattributedReason).toBe("unpriced");
    expect(first?.attributedBurnPercentPoints).toBe(0);
    expect(first?.unattributedBurnPercentPoints).toBe(10);
    expect(first?.activity).toHaveLength(2);
    expect(first?.activity.every((entry) => entry.estimatedBurnPercentPoints === undefined)).toBe(
      true,
    );
    expect(first?.activity[1]?.tokens.total).toBe(100);
  });

  it("treats an all-free priced interval as zero weight", () => {
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          { providerId: "free-labs", modelId: "free-1", tokens: costed(500, 0), stepCount: 1 },
        ]),
      ],
      providerIds: ["free-labs"],
    });

    expect(result.intervals[0]?.unattributedReason).toBe("zero-weight");
    expect(result.intervals[0]?.unattributedBurnPercentPoints).toBe(10);
    expect(result.intervals[0]?.activity[0]?.tokens.total).toBe(500);
  });

  it("reports no activity without inventing a model", () => {
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [activity(0, 1_000, [])],
      providerIds: ["openai"],
    });
    expect(result.intervals[0]?.unattributedReason).toBe("no-activity");
    expect(result.intervals[0]?.unattributedBurnPercentPoints).toBe(10);
    expect(result.intervals[0]?.activity).toEqual([]);
    expect(result.breakdown).toEqual([]);
  });

  it("never attributes while the account is ambiguous", () => {
    const result = attributeUsageWindow({
      intervals: [interval({ soleObservedAccount: false })],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 3), stepCount: 1 },
        ]),
      ],
      providerIds: ["openai"],
    });
    expect(result.intervals[0]?.unattributedReason).toBe("ambiguous-account");
    expect(result.intervals[0]?.attributedBurnPercentPoints).toBe(0);
    expect(result.intervals[0]?.activity[0]?.tokens.total).toBe(100);
  });

  it("keeps an unobserved interval unattributed even with matching activity", () => {
    const result = attributeUsageWindow({
      intervals: [interval({ link: "unobserved" })],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 3), stepCount: 1 },
        ]),
      ],
      providerIds: ["openai"],
    });
    expect(result.intervals[0]?.unattributedReason).toBe("unobserved-interval");
    expect(result.intervals[0]?.unattributedBurnPercentPoints).toBe(10);
  });

  it("prefers the interval reason over missing activity", () => {
    const result = attributeUsageWindow({
      intervals: [
        interval({ link: "unobserved" }),
        interval({ startMs: 1_000, endMs: 2_000, soleObservedAccount: false }),
      ],
      activity: [activity(0, 1_000, []), activity(1_000, 2_000, [])],
      providerIds: ["openai"],
    });
    expect(result.intervals[0]?.unattributedReason).toBe("unobserved-interval");
    expect(result.intervals[1]?.unattributedReason).toBe("ambiguous-account");
  });

  it("attributes activity across every runtime id of the card's provider", () => {
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          {
            providerId: "claude-agent",
            modelId: "claude-fable-5",
            tokens: costed(100, 1),
            stepCount: 1,
          },
          {
            providerId: "claude-code",
            modelId: "claude-fable-5",
            tokens: costed(300, 3),
            stepCount: 1,
          },
          { providerId: "openai", modelId: "gpt-5", tokens: costed(900, 9), stepCount: 1 },
        ]),
      ],
      providerIds: quotaProviderRuntimeIds("claude-agent"),
    });

    const first = result.intervals[0];
    expect(first?.activity.map((entry) => entry.providerId)).toEqual([
      "claude-agent",
      "claude-code",
    ]);
    expect(first?.activity.map((entry) => entry.estimatedBurnPercentPoints)).toEqual([2.5, 7.5]);
    expect(first?.attributedBurnPercentPoints).toBe(10);
  });

  it("does not attribute across a boundary or a null burn", () => {
    const result = attributeUsageWindow({
      intervals: [
        interval({ burnPercentPoints: null, link: "boundary" }),
        interval({ startMs: 1_000, endMs: 2_000, burnPercentPoints: 0 }),
      ],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 3), stepCount: 1 },
        ]),
        activity(1_000, 2_000, []),
      ],
      providerIds: ["openai"],
    });
    for (const first of result.intervals) {
      expect(first.attributedBurnPercentPoints).toBe(0);
      expect(first.unattributedBurnPercentPoints).toBe(0);
      expect(first.unattributedReason).toBeUndefined();
    }
  });

  it("excludes models outside a model-specific window", () => {
    const eligibility = modelEligibilityForNamedWindow("claude-agent", "Fable weekly");
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          {
            providerId: "claude-agent",
            modelId: "claude-fable-5",
            tokens: costed(100, 1),
            stepCount: 1,
          },
          {
            providerId: "claude-agent",
            modelId: "claude-sonnet-4-5",
            tokens: costed(900, 9),
            stepCount: 1,
          },
        ]),
      ],
      providerIds: ["claude-agent"],
      isEligibleModel: eligibility.matches,
    });

    expect(eligibility.known).toBe(true);
    expect(result.intervals[0]?.activity.map((entry) => entry.modelId)).toEqual(["claude-fable-5"]);
    expect(result.intervals[0]?.attributedBurnPercentPoints).toBe(10);
    expect(result.breakdown[0]?.modelId).toBe("claude-fable-5");
  });

  it("treats an unknown named window as unattributable instead of guessing", () => {
    const eligibility = modelEligibilityForNamedWindow("openai", "Mystery weekly");
    const result = attributeUsageWindow({
      intervals: [interval()],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 1), stepCount: 1 },
        ]),
      ],
      providerIds: ["openai"],
      isEligibleModel: eligibility.matches,
    });
    expect(eligibility.known).toBe(false);
    expect(result.intervals[0]?.unattributedReason).toBe("zero-weight");
    expect(result.intervals[0]?.unattributedBurnPercentPoints).toBe(10);
    expect(result.intervals[0]?.activity).toEqual([]);
  });
});

describe("usage attribution breakdown", () => {
  it("sums one window's intervals into model rows with effort children", () => {
    const result = attributeUsageWindow({
      intervals: [interval(), interval({ startMs: 1_000, endMs: 2_000 })],
      activity: [
        activity(0, 1_000, [
          { providerId: "openai", modelId: "gpt-5", tokens: costed(100, 1), stepCount: 1 },
          {
            providerId: "openai",
            modelId: "gpt-5",
            effort: "default",
            tokens: costed(50, 0.5),
            stepCount: 2,
          },
        ]),
        activity(1_000, 2_000, [
          {
            providerId: "openai",
            modelId: "gpt-5",
            effort: "high",
            tokens: costed(200, 2),
            stepCount: 1,
          },
        ]),
      ],
      providerIds: ["openai"],
    });

    const row = result.breakdown[0];
    expect(row?.tokens.total).toBe(350);
    expect(row?.stepCount).toBe(4);
    expect(row?.estimatedBurnPercentPoints).toBeCloseTo(20);
    expect(row?.efforts.map((effort) => effort.effort)).toEqual(["high", undefined, "default"]);
    expect(row?.efforts[0]?.tokens.total).toBe(200);
    expect(row?.efforts[0]?.estimatedBurnPercentPoints).toBeCloseTo(10);
    expect(result.intervals[0]?.attributedBurnPercentPoints).toBe(10);
    expect(result.intervals[1]?.attributedBurnPercentPoints).toBe(10);
  });
});

describe("quota provider runtime id mapping", () => {
  it("maps canonical and synonymous quota ids to registration runtime ids", () => {
    expect(quotaProviderRuntimeIds("claude-agent")).toEqual(["claude-agent", "claude-code"]);
    expect(quotaProviderRuntimeIds("github-copilot")).toEqual([
      "copilot",
      "github-copilot",
      "copilot-chat",
      "github-copilot-chat",
    ]);
    expect(quotaProviderRuntimeIds("not-a-provider")).toEqual([]);
  });

  it("recognizes Fable as the model-scoped named window for the Anthropic family", () => {
    for (const providerId of ["claude-agent", "anthropic"]) {
      const eligibility = modelEligibilityForNamedWindow(providerId, "named:Fable weekly");
      expect(eligibility.known).toBe(true);
      expect(eligibility.matches("claude-fable-5")).toBe(true);
      expect(eligibility.matches("fable")).toBe(true);
      expect(eligibility.matches("claude-sonnet-4-5")).toBe(false);
    }
  });

  it("treats a declared provider-wide named window as all-model eligible", () => {
    const eligibility = modelEligibilityForNamedWindow("copilot", "additional_usage");
    expect(eligibility.known).toBe(true);
    expect(eligibility.matches("gpt-5")).toBe(true);
    expect(eligibility.matches("claude-sonnet-4-5")).toBe(true);
  });
});
