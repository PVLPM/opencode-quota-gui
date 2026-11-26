import { describe, expect, it } from "vitest";
import type { CostedTokens, ProjectActivityRow, Usage } from "../src/contracts/dashboard";
import {
  compositionBucket,
  compositionTokenShare,
  costContribution,
  createProjectChartComposition,
} from "../src/ui/project-composition";

function tokens(overrides: Partial<CostedTokens> = {}): CostedTokens {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    apiEquivalentCostUsd: 0,
    unpricedTokens: 0,
    unknownTokens: 0,
    ...overrides,
  };
}

function usage(bucketCount: number): Usage {
  return {
    range: "7d",
    window: { untilMs: 2_000 },
    bucketUnit: "day",
    timeZone: "UTC",
    buckets: Array.from({ length: bucketCount }, (_, index) => ({
      startMs: index,
      endMs: index + 1,
      tokens: tokens(),
    })),
    totals: tokens(),
    stepCount: 0,
    sessionCount: 0,
    stale: false,
  };
}

function project(overrides: Partial<ProjectActivityRow> = {}): ProjectActivityRow {
  return {
    projectId: "p1",
    name: "Project one",
    tokens: tokens({ total: 100 }),
    rootSessionCount: 1,
    latestActivityAtMs: 1,
    ...overrides,
  };
}

describe("project chart composition", () => {
  it("builds an aligned composition from the existing home rollup", () => {
    const chart = usage(2);
    const buckets = [
      tokens({ input: 10, total: 10, apiEquivalentCostUsd: 0.1 }),
      tokens({ output: 5, total: 5, apiEquivalentCostUsd: 0.05 }),
    ];
    const composition = createProjectChartComposition(
      chart,
      project({ buckets, tokens: tokens({ total: 15 }) }),
    );

    expect(composition).toMatchObject({
      projectId: "p1",
      label: "Project one",
      totals: { total: 15 },
    });
    expect(composition?.buckets).toBe(buckets);
    expect(compositionBucket(composition, 1)?.total).toBe(5);
    expect(compositionBucket(composition, 2)).toBeUndefined();
    expect(compositionBucket(composition, -1)).toBeUndefined();
    expect(compositionBucket(composition, 0.5)).toBeUndefined();
  });

  it("rejects a payload whose bucket alignment breaks either way", () => {
    const chart = usage(2);
    expect(
      createProjectChartComposition(usage(3), project({ buckets: [tokens(), tokens()] })),
    ).toBeUndefined();
    expect(
      createProjectChartComposition(chart, project({ buckets: [tokens(), tokens(), tokens()] })),
    ).toBeUndefined();
  });

  it("keeps older aggregate-only payloads working", () => {
    expect(createProjectChartComposition(usage(2), project())).toBeUndefined();
    expect(
      createProjectChartComposition(usage(2), project({ buckets: [tokens()] })),
    ).toBeUndefined();
    expect(compositionBucket(undefined, 0)).toBeUndefined();
  });

  it("returns a truthful token share or none", () => {
    expect(compositionTokenShare(25, 100)).toBe(0.25);
    expect(compositionTokenShare(100, 100)).toBe(1);
    expect(compositionTokenShare(100, 50)).toBe(1);
    expect(compositionTokenShare(0, 100)).toBeUndefined();
    expect(compositionTokenShare(-5, 100)).toBeUndefined();
    expect(compositionTokenShare(10, 0)).toBeUndefined();
    expect(compositionTokenShare(Number.NaN, 100)).toBeUndefined();
    expect(compositionTokenShare(10, Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  it("shares cost only when both sides are fully priced", () => {
    const projectTotal = tokens({ total: 50, apiEquivalentCostUsd: 2 });
    const chartTotal = tokens({ total: 200, apiEquivalentCostUsd: 8 });

    expect(costContribution(projectTotal, chartTotal)).toEqual({
      priced: true,
      partial: false,
      unpriced: false,
      complete: true,
      share: 0.25,
    });
    expect(
      costContribution(tokens({ total: 50, apiEquivalentCostUsd: 0 }), chartTotal),
    ).toMatchObject({ priced: true, partial: false, unpriced: false, complete: true, share: 0 });
  });

  it("never invents a cost share for unpriced or partially priced usage", () => {
    const chartTotal = tokens({ total: 200, apiEquivalentCostUsd: 8 });

    expect(
      costContribution(tokens({ total: 50, apiEquivalentCostUsd: null }), chartTotal),
    ).toMatchObject({ priced: false, partial: false, unpriced: true });
    const partial = costContribution(
      tokens({ total: 50, apiEquivalentCostUsd: 2, unpricedTokens: 7 }),
      chartTotal,
    );
    expect(partial).toMatchObject({ priced: true, partial: true, unpriced: false });
    expect(partial.share).toBeUndefined();

    const unknown = costContribution(
      tokens({ total: 50, apiEquivalentCostUsd: 2, unknownTokens: 7 }),
      chartTotal,
    );
    expect(unknown).toMatchObject({ partial: true });
    expect(unknown.share).toBeUndefined();

    const partialTotal = costContribution(
      tokens({ total: 50, apiEquivalentCostUsd: 2 }),
      tokens({ total: 200, apiEquivalentCostUsd: null, unpricedTokens: 20 }),
    );
    expect(partialTotal.share).toBeUndefined();
  });

  it("reports no cost state for zero-token buckets and no share for a zero estimate", () => {
    expect(costContribution(tokens(), tokens({ total: 10, apiEquivalentCostUsd: 1 }))).toEqual({
      priced: false,
      partial: false,
      unpriced: false,
      complete: false,
    });
    const zeroEstimate = costContribution(
      tokens({ total: 5, apiEquivalentCostUsd: 0 }),
      tokens({ total: 10, apiEquivalentCostUsd: 0 }),
    );
    expect(zeroEstimate).toMatchObject({
      priced: true,
      partial: false,
      unpriced: false,
      complete: true,
    });
    expect(zeroEstimate.share).toBeUndefined();
  });
});
