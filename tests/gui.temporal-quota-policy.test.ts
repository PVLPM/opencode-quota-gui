import { describe, expect, it } from "vitest";
import { buildQuotaPolicyModels, quotaPolicyPhase } from "../src/gui/temporal-quota-policy.js";
import { TEMPORAL_QUOTA_POLICIES } from "../src/gui/temporal-quota-policy-data.js";

const PEAK_MONDAY = Date.parse("2026-11-02T06:00:00.000Z");
const OFFPEAK_MONDAY = Date.parse("2026-11-02T10:00:00.000Z");
const HORIZON = 3 * 24 * 60 * 60 * 1000;

/**
 * Exact source evidence captured 2026-10-30 from the official docs. The
 * current credits-based plan and the discontinued Legacy Plan V2 are separate
 * sections on separate pages; their factors must never be merged.
 */
const CURRENT_PLAN_SOURCE = {
  url: "https://docs.z.ai/devpack/overview#usage-instruction",
  accessedAt: "2026-10-30",
  models: ["GLM-5.3", "GLM-5.3-Flash"],
  offpeakQuote: "During off-peak hours, model usage is charged at 50% of the standard credit rate.",
  peakQuote: "Peak hours: Monday to Friday, 14:00-18:00 Singapore Standard Time (UTC+8).",
  maxAllowanceQuote:
    "Maximum token allowance: All usage occurs during off-peak hours and is charged at 0.5x the standard credit rate.",
  minAllowanceQuote:
    "Minimum token allowance: All usage occurs during peak hours and is charged at 1x the standard credit rate.",
  factors: {
    "glm-5.3": { peakFactor: 1, offpeakFactor: 0.5 },
    "glm-5.3-flash": { peakFactor: 1, offpeakFactor: 0.5 },
  },
} as const;

const LEGACY_PLAN_V2_SOURCE = {
  url: "https://docs.z.ai/devpack/notice/usage-revision",
  published: "2026-07-30",
  section: "Usage Reference for Legacy Plans > Legacy Plan V2",
  glm53Quote:
    'GLM-5.3: As the flagship model, API calls consume quota at a rate of "1x during off-peak hours and 3x during peak hours".',
  flashQuote:
    "GLM-5.3-Flash: API calls consume quota at a rate of 0.4x during off-peak hours and 1.2x during peak hours.",
  factors: {
    "glm-5.3": { peakFactor: 3, offpeakFactor: 1 },
    "glm-5.3-flash": { peakFactor: 1.2, offpeakFactor: 0.4 },
  },
} as const;

function zaiPolicy() {
  const policy = TEMPORAL_QUOTA_POLICIES.find((entry) => entry.providerId === "zai");
  if (!policy) throw new Error("Z.ai quota policy is missing");
  return policy;
}

describe("Z.ai quota pricing policy", () => {
  it("is sourced from the official plan usage documentation", () => {
    const policy = zaiPolicy();
    expect(policy.source).toBe(CURRENT_PLAN_SOURCE.url);
    expect(policy.sourceAccessedAt).toBe(CURRENT_PLAN_SOURCE.accessedAt);
    expect(policy.sourceLabel).toBe("Z.ai current credits-plan usage");
    expect(CURRENT_PLAN_SOURCE.offpeakQuote).toContain("50% of the standard credit rate");
    expect(CURRENT_PLAN_SOURCE.peakQuote).toContain("Monday to Friday, 14:00-18:00");
    expect(CURRENT_PLAN_SOURCE.maxAllowanceQuote).toContain("0.5x the standard credit rate");
    expect(CURRENT_PLAN_SOURCE.minAllowanceQuote).toContain("1x the standard credit rate");
    expect(policy.peak).toEqual({
      days: ["mon", "tue", "wed", "thu", "fri"],
      start: "14:00",
      end: "18:00",
    });
    expect(policy.utcOffsetMinutes).toBe(480);
    expect(CURRENT_PLAN_SOURCE.models).toEqual(["GLM-5.3", "GLM-5.3-Flash"]);
    expect(policy.models).toEqual(CURRENT_PLAN_SOURCE.factors);
    expect(policy.models["glm-5.3"]).toEqual({ peakFactor: 1, offpeakFactor: 0.5 });
    expect(policy.models["glm-5.3-flash"]).toEqual({ peakFactor: 1, offpeakFactor: 0.5 });
  });

  it("keeps current credits-plan factors separate from the Legacy Plan V2 notice", () => {
    const policy = zaiPolicy();
    // The 2026-07-30 notice explicitly groups these rates under "Usage
    // Reference for Legacy Plans > Legacy Plan V2"; the current plan page uses
    // 1x peak / 0.5x off-peak instead. Do not apply the legacy factors.
    expect(LEGACY_PLAN_V2_SOURCE.published).toBe("2026-07-30");
    expect(LEGACY_PLAN_V2_SOURCE.section).toBe("Usage Reference for Legacy Plans > Legacy Plan V2");
    expect(LEGACY_PLAN_V2_SOURCE.glm53Quote).toContain("1x during off-peak hours and 3x");
    expect(LEGACY_PLAN_V2_SOURCE.flashQuote).toContain("0.4x during off-peak hours and 1.2x");
    expect(LEGACY_PLAN_V2_SOURCE.factors["glm-5.3"]).toEqual({
      peakFactor: 3,
      offpeakFactor: 1,
    });
    expect(LEGACY_PLAN_V2_SOURCE.factors["glm-5.3-flash"]).toEqual({
      peakFactor: 1.2,
      offpeakFactor: 0.4,
    });
    expect(policy.models).not.toEqual(LEGACY_PLAN_V2_SOURCE.factors);
    expect(policy.models).toEqual(CURRENT_PLAN_SOURCE.factors);
    expect(policy.source).toBe(CURRENT_PLAN_SOURCE.url);
    expect(policy.source).not.toBe(LEGACY_PLAN_V2_SOURCE.url);
    expect(policy.source).not.toContain("usage-revision");
  });

  it("evaluates peak and off-peak quota effects in the plan's own time zone", () => {
    const policy = zaiPolicy();
    expect(quotaPolicyPhase(policy, PEAK_MONDAY)).toBe("peak");
    expect(quotaPolicyPhase(policy, OFFPEAK_MONDAY)).toBe("offpeak");
    expect(quotaPolicyPhase(policy, Date.parse("2026-11-07T06:00:00.000Z"))).toBe("offpeak");

    const peakModels = buildQuotaPolicyModels(policy, PEAK_MONDAY, HORIZON);
    expect(peakModels.map((model) => model.modelId)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(peakModels[0]).toMatchObject({
      state: "peak",
      effect: { factor: 1, direction: "peak", unit: "quota_points" },
      nextChangeAtMs: OFFPEAK_MONDAY,
      nextState: "offpeak",
    });
    expect(peakModels[0]?.intervals[0]).toMatchObject({
      startMs: PEAK_MONDAY,
      endMs: OFFPEAK_MONDAY,
      phase: "peak",
      effect: { factor: 1, direction: "peak", unit: "quota_points" },
    });

    const offpeak = buildQuotaPolicyModels(policy, OFFPEAK_MONDAY, HORIZON)[0];
    expect(offpeak).toMatchObject({
      state: "offpeak",
      effect: { factor: 0.5, direction: "offpeak", unit: "quota_points" },
      nextChangeAtMs: Date.parse("2026-11-03T06:00:00.000Z"),
      nextState: "peak",
    });
  });

  it("projects the next weekday window after a weekend", () => {
    const policy = zaiPolicy();
    const saturday = Date.parse("2026-11-07T06:00:00.000Z");
    const model = buildQuotaPolicyModels(policy, saturday, HORIZON)[0];
    expect(model?.state).toBe("offpeak");
    expect(model?.nextChangeAtMs).toBe(Date.parse("2026-11-09T06:00:00.000Z"));
    expect(model?.nextState).toBe("peak");
    expect(model?.intervals[0]).toMatchObject({
      startMs: saturday,
      endMs: Date.parse("2026-11-09T06:00:00.000Z"),
      phase: "offpeak",
    });
  });

  it("reports the true weekly transition beyond a shortened display horizon", () => {
    const policy = zaiPolicy();
    // Friday 18:00 SGT, just after the weekday peak window. The preview is
    // shorter than the weekend gap, so the next transition is not in it.
    const fridayAfterPeak = Date.parse("2026-11-06T10:00:00.000Z");
    const shortHorizon = 24 * 60 * 60 * 1000;
    const model = buildQuotaPolicyModels(policy, fridayAfterPeak, shortHorizon)[0];
    expect(model?.state).toBe("offpeak");
    expect(model?.intervals).toHaveLength(1);
    expect(model?.intervals[0]).toMatchObject({
      startMs: fridayAfterPeak,
      endMs: fridayAfterPeak + shortHorizon,
      phase: "offpeak",
    });
    expect(model?.nextChangeAtMs).toBe(Date.parse("2026-11-09T06:00:00.000Z"));
    expect(model?.nextState).toBe("peak");
  });
});
