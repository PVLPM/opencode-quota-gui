import { afterEach, describe, expect, it } from "vitest";
import { buildTemporalStatus } from "../src/gui/temporal-status.js";
import {
  __resetTemporalSnapshotForTests,
  normalizeTemporalSnapshot,
  setTemporalSnapshotForTests,
  type TemporalCondition,
  type TemporalRates,
  type TemporalSnapshot,
} from "../src/lib/modelsdev-temporal.js";

const REVISION = "4a58d0bc74552942a2aa29bc9065a38ed3fe04e4";
const GENERATED_AT = 1_793_377_482_000;

const CN_2026 = {
  timeZone: "Asia/Shanghai",
  source: "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
  published: "2025-11-04",
  intervals: [
    {
      id: "spring-festival",
      localStart: "2026-02-15",
      localEnd: "2026-02-24",
      startMs: Date.parse("2026-02-14T16:00:00.000Z"),
      endMs: Date.parse("2026-02-23T16:00:00.000Z"),
    },
  ],
  makeupWorkdays: ["2026-02-14"],
};

const ALWAYS = { type: "utc_hours", op: "gte", value: "00:00" } as const;
const MORNING = {
  type: "all",
  of: [
    { type: "utc_hours", op: "gte", value: "00:00" },
    { type: "utc_hours", op: "lt", value: "12:00" },
  ],
} as const satisfies TemporalCondition;

/** Every model is a surcharge-only or discount-only policy, so a base state exists. */
function scalarSnapshot(): TemporalSnapshot {
  return normalizeTemporalSnapshot({
    version: 1,
    revision: REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
    generatedAt: GENERATED_AT,
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers: {
      scalar: {
        // Surge applies only in the morning; the afternoon is the 1x base state.
        inactive: {
          status: "supported",
          source: "providers/scalar/models/inactive.toml",
          overrides: [],
          multipliers: [{ id: "multipliers[0]", when: MORNING, factor: 2 }],
        },
        uniform: {
          status: "supported",
          source: "providers/scalar/models/uniform.toml",
          overrides: [],
          multipliers: [{ id: "multipliers[0]", when: ALWAYS, factor: 2 }],
        },
        // The override halves the input bucket only; output stays unchanged.
        partial: {
          status: "supported",
          source: "providers/scalar/models/partial.toml",
          overrides: [
            {
              id: "overrides[0]",
              field: "input",
              when: MORNING,
              rates: { input: 0.5 },
            },
          ],
          multipliers: [],
        },
        // A zero base gains a positive override rate, then a uniform multiplier.
        "zero-bucket": {
          status: "supported",
          source: "providers/scalar/models/zero-bucket.toml",
          overrides: [
            {
              id: "overrides[0]",
              field: "input",
              when: ALWAYS,
              rates: { input: 5 },
            },
          ],
          multipliers: [{ id: "multipliers[0]", when: ALWAYS, factor: 2 }],
        },
        // Every bucket has a zero base, so no ratio can be compared.
        "zero-only": {
          status: "supported",
          source: "providers/scalar/models/zero-only.toml",
          overrides: [],
          multipliers: [{ id: "multipliers[0]", when: ALWAYS, factor: 2 }],
        },
      },
    },
  });
}

const BASE_RATES: Record<string, TemporalRates> = {
  inactive: { input: 1, output: 2, cache_read: 0.1 },
  uniform: { input: 1, output: 2, cache_read: 0.1 },
  partial: { input: 1, output: 2, cache_read: 0.1 },
  "zero-bucket": { input: 0, output: 2, cache_read: 0.1 },
  "zero-only": { input: 0, output: 0, cache_read: 0 },
};

function build(nowIso: string, providerId = "scalar") {
  setTemporalSnapshotForTests(scalarSnapshot());
  return buildTemporalStatus({
    providers: [{ providerId, providerLabel: "Scalar", discovered: true }],
    nowMs: Date.parse(nowIso),
    routes: { [providerId]: Object.keys(BASE_RATES) },
    baseRates: (_provider, model) => BASE_RATES[model] ?? null,
  }).providers[0];
}

function modelAt(nowIso: string, modelId: string) {
  return build(nowIso)?.models.find((model) => model.modelId === modelId);
}

afterEach(() => {
  __resetTemporalSnapshotForTests();
});

describe("temporal effect scalar classification", () => {
  it("marks an unchanged 1x base state as an explicit scalar", () => {
    expect(modelAt("2026-01-05T13:00:00.000Z", "inactive")).toMatchObject({
      state: "offpeak",
      effect: { factor: 1, direction: "unchanged", unit: "api_price", scalar: true },
    });
  });

  it("marks a uniform multiplier across every bucket as an explicit scalar", () => {
    const model = modelAt("2026-01-05T02:00:00.000Z", "uniform");
    expect(model).toMatchObject({
      state: "peak",
      effect: { factor: 2, direction: "peak", unit: "api_price", scalar: true },
    });
    expect(model?.intervals[0]?.effect).toMatchObject({ factor: 2, scalar: true });
  });

  it("never presents a differing-bucket override as one scalar multiplier", () => {
    const model = modelAt("2026-01-05T02:00:00.000Z", "partial");
    // input is halved while output is unchanged: 0.5 is not a global multiplier.
    expect(model).toMatchObject({
      state: "offpeak",
      effect: { factor: 0.5, direction: "offpeak", unit: "api_price", scalar: false },
    });
    expect(model?.intervals[0]?.effect).toMatchObject({ scalar: false });
  });

  it("classifies each projected interval from its own current rates", () => {
    const model = modelAt("2026-01-05T02:00:00.000Z", "partial");
    expect(model?.intervals[0]).toMatchObject({
      startMs: Date.parse("2026-01-05T02:00:00.000Z"),
      endMs: Date.parse("2026-01-05T12:00:00.000Z"),
      phase: "offpeak",
      effect: { factor: 0.5, direction: "offpeak", scalar: false },
    });
    expect(model?.intervals[1]).toMatchObject({
      startMs: Date.parse("2026-01-05T12:00:00.000Z"),
      phase: "peak",
      effect: { factor: 1, direction: "unchanged", scalar: true },
    });
  });

  it("does not fold a non-comparable zero base into a scalar factor", () => {
    // input 0 -> 10 has no finite ratio; the remaining output ratio is 2.
    expect(modelAt("2026-01-05T02:00:00.000Z", "zero-bucket")).toMatchObject({
      state: "peak",
      effect: { factor: 2, direction: "peak", unit: "api_price", scalar: false },
    });
  });

  it("omits the effect entirely when no bucket has a comparable base", () => {
    const model = modelAt("2026-01-05T02:00:00.000Z", "zero-only");
    expect(model).toMatchObject({ state: "unknown" });
    expect(model?.effect).toBeUndefined();
    expect(model?.intervals[0]?.effect).toBeUndefined();
  });

  it("leaves provider-maintained quota-point effects scalar without a rate comparison", () => {
    const provider = buildTemporalStatus({
      providers: [{ providerId: "zai", providerLabel: "Z.ai", discovered: false }],
      nowMs: Date.parse("2026-11-02T06:00:00.000Z"),
      routes: {},
    }).providers[0];
    expect(provider?.models[0]?.effect).toMatchObject({
      factor: 1,
      unit: "quota_points",
    });
    expect(provider?.models[0]?.effect?.scalar).toBeUndefined();
  });
});
