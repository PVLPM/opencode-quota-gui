import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/contracts/dashboard.js";
import { TEMPORAL_QUOTA_POLICIES } from "../src/gui/temporal-quota-policy-data.js";
import {
  buildTemporalStatus,
  listTemporalProviderSources,
  readBundledTemporalCatalog,
  TEMPORAL_SCHEDULE_HORIZON_MS,
} from "../src/gui/temporal-status.js";
import {
  __resetTemporalSnapshotForTests,
  getNextTemporalTransition,
  listTemporalIntervals,
  normalizeTemporalSnapshot,
  setTemporalSnapshotForTests,
  type TemporalCondition,
  type TemporalRates,
  type TemporalSnapshot,
} from "../src/lib/modelsdev-temporal.js";
import { parseQuotaSnapshot } from "../src/ui/dashboard-client.js";
import { formatTemporalCountdown, temporalEffectLabel } from "../src/ui/temporal-format.js";

const REVISION = "4a58d0bc74552942a2aa29bc9065a38ed3fe04e4";
const GENERATED_AT = 1_793_377_482_000;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

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

function fixture(): TemporalSnapshot {
  return normalizeTemporalSnapshot({
    version: 1,
    revision: REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
    generatedAt: GENERATED_AT,
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers: {
      deepseek: {
        "deepseek-v4-pro": {
          status: "supported",
          source: "providers/deepseek/models/deepseek-v4-pro.toml",
          overrides: [],
          multipliers: [
            {
              id: "multipliers[0]",
              when: {
                type: "all",
                of: [
                  { type: "utc_days", op: "in", value: WEEKDAYS },
                  { type: "not", of: { type: "holiday", op: "equals", value: "CN" } },
                  {
                    type: "all",
                    of: [
                      { type: "utc_hours", op: "gte", value: "01:00" },
                      { type: "utc_hours", op: "lt", value: "04:00" },
                    ],
                  },
                ],
              },
              factor: 2,
            },
          ],
        },
      },
      "test-mixed": {
        "peak-model": {
          status: "supported",
          source: "providers/test-mixed/models/peak-model.toml",
          overrides: [],
          multipliers: [
            {
              id: "multipliers[0]",
              when: { type: "utc_hours", op: "gte", value: "00:00" },
              factor: 2,
            },
          ],
        },
        "offpeak-model": {
          status: "supported",
          source: "providers/test-mixed/models/offpeak-model.toml",
          overrides: [],
          multipliers: [
            {
              id: "multipliers[0]",
              when: { type: "utc_hours", op: "gte", value: "00:00" },
              factor: 0.5,
            },
          ],
        },
      },
    },
  });
}

const baseRates = (providerId: string, modelId: string): TemporalRates => {
  void providerId;
  void modelId;
  return { input: 1, output: 2, cache_read: 0.1 };
};

/** The shipped snapshot, so the Alibaba regression uses real route data. */
function actualSnapshot(): TemporalSnapshot {
  return normalizeTemporalSnapshot(
    JSON.parse(
      readFileSync(new URL("../src/data/modelsdev-temporal.min.json", import.meta.url), "utf8"),
    ),
  );
}

/** A policy that cannot establish which side of the schedule factor 1 is. */
function ambiguousSnapshot(): TemporalSnapshot {
  return normalizeTemporalSnapshot({
    version: 1,
    revision: REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
    generatedAt: GENERATED_AT,
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers: {
      ambiguous: {
        mixed: {
          status: "supported",
          source: "providers/ambiguous/models/mixed.toml",
          overrides: [],
          multipliers: [
            {
              id: "multipliers[0]",
              when: { type: "utc_hours", op: "gte", value: "00:00" },
              factor: 2,
            },
            {
              id: "multipliers[1]",
              when: { type: "utc_hours", op: "gte", value: "00:00" },
              factor: 0.5,
            },
          ],
        },
        equal: {
          status: "supported",
          source: "providers/ambiguous/models/equal.toml",
          overrides: [],
          multipliers: [
            {
              id: "multipliers[0]",
              when: { type: "utc_hours", op: "gte", value: "00:00" },
              factor: 1,
            },
          ],
        },
      },
    },
  });
}

function routes(): Record<string, string[]> {
  return {
    deepseek: ["deepseek-v4-pro"],
    "test-mixed": ["peak-model", "offpeak-model"],
  };
}

const ALWAYS = { type: "utc_hours", op: "gte", value: "00:00" } as const;
const HOLIDAY_ONLY = { type: "holiday", op: "equals", value: "CN" } as const;

function multiplierPolicy(
  providerId: string,
  modelId: string,
  rules: readonly { when: TemporalCondition; factor: number }[],
) {
  return {
    status: "supported",
    source: `providers/${providerId}/models/${modelId}.toml`,
    overrides: [],
    multipliers: rules.map((rule, index) => ({
      id: `multipliers[${index}]`,
      when: rule.when,
      factor: rule.factor,
    })),
  };
}

function aggregatePolicy(
  providerId: string,
  modelId: string,
  factor: number,
  when: TemporalCondition = ALWAYS,
) {
  return multiplierPolicy(providerId, modelId, [{ when, factor }]);
}

function aggregationSnapshot(): TemporalSnapshot {
  return normalizeTemporalSnapshot({
    version: 1,
    revision: REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
    generatedAt: GENERATED_AT,
    // Only 2026 exists, so a holiday-only rule is unresolved in 2027.
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers: {
      "agg-peak": { "only-peak": aggregatePolicy("agg-peak", "only-peak", 2) },
      "agg-offpeak": { "only-offpeak": aggregatePolicy("agg-offpeak", "only-offpeak", 0.5) },
      "agg-mixed": {
        peak: aggregatePolicy("agg-mixed", "peak", 2),
        offpeak: aggregatePolicy("agg-mixed", "offpeak", 0.5),
      },
      "agg-unknown": {
        "holiday-only": aggregatePolicy("agg-unknown", "holiday-only", 2, HOLIDAY_ONLY),
      },
      "agg-peak-unknown": {
        peak: aggregatePolicy("agg-peak-unknown", "peak", 2),
        "holiday-only": aggregatePolicy("agg-peak-unknown", "holiday-only", 2, HOLIDAY_ONLY),
      },
      "agg-offpeak-unknown": {
        offpeak: aggregatePolicy("agg-offpeak-unknown", "offpeak", 0.5),
        "holiday-only": aggregatePolicy("agg-offpeak-unknown", "holiday-only", 2, HOLIDAY_ONLY),
      },
      "agg-mixed-unknown": {
        peak: aggregatePolicy("agg-mixed-unknown", "peak", 2),
        offpeak: aggregatePolicy("agg-mixed-unknown", "offpeak", 0.5),
        "holiday-only": aggregatePolicy("agg-mixed-unknown", "holiday-only", 2, HOLIDAY_ONLY),
      },
      "agg-two-peak": {
        "peak-a": aggregatePolicy("agg-two-peak", "peak-a", 2),
        "peak-b": aggregatePolicy("agg-two-peak", "peak-b", 2),
      },
      "agg-two-offpeak": {
        "offpeak-a": aggregatePolicy("agg-two-offpeak", "offpeak-a", 0.5),
        "offpeak-b": aggregatePolicy("agg-two-offpeak", "offpeak-b", 0.5),
      },
      "agg-two-and-two": {
        "peak-a": aggregatePolicy("agg-two-and-two", "peak-a", 2),
        "peak-b": aggregatePolicy("agg-two-and-two", "peak-b", 2),
        "offpeak-a": aggregatePolicy("agg-two-and-two", "offpeak-a", 0.5),
        "offpeak-b": aggregatePolicy("agg-two-and-two", "offpeak-b", 0.5),
      },
      "agg-two-and-two-unknown": {
        "peak-a": aggregatePolicy("agg-two-and-two-unknown", "peak-a", 2),
        "peak-b": aggregatePolicy("agg-two-and-two-unknown", "peak-b", 2),
        "offpeak-a": aggregatePolicy("agg-two-and-two-unknown", "offpeak-a", 0.5),
        "offpeak-b": aggregatePolicy("agg-two-and-two-unknown", "offpeak-b", 0.5),
        "holiday-only": aggregatePolicy("agg-two-and-two-unknown", "holiday-only", 2, HOLIDAY_ONLY),
      },
    },
  });
}

const AGGREGATE_ROUTES: Record<string, string[]> = {
  "agg-peak": ["only-peak"],
  "agg-offpeak": ["only-offpeak"],
  "agg-mixed": ["peak", "offpeak"],
  "agg-unknown": ["holiday-only"],
  "agg-peak-unknown": ["peak", "holiday-only"],
  "agg-offpeak-unknown": ["offpeak", "holiday-only"],
  "agg-mixed-unknown": ["peak", "offpeak", "holiday-only"],
  "agg-two-peak": ["peak-a", "peak-b"],
  "agg-two-offpeak": ["offpeak-a", "offpeak-b"],
  "agg-two-and-two": ["peak-a", "peak-b", "offpeak-a", "offpeak-b"],
  "agg-two-and-two-unknown": ["peak-a", "peak-b", "offpeak-a", "offpeak-b", "holiday-only"],
};

const NOT_HOLIDAY_CN = { type: "not", of: HOLIDAY_ONLY } as const satisfies TemporalCondition;
const MORNING = {
  type: "all",
  of: [
    { type: "utc_hours", op: "gte", value: "00:00" },
    { type: "utc_hours", op: "lt", value: "12:00" },
  ],
} as const satisfies TemporalCondition;
const AFTERNOON = {
  type: "all",
  of: [
    { type: "utc_hours", op: "gte", value: "12:00" },
    { type: "utc_hours", op: "lt", value: "18:00" },
  ],
} as const satisfies TemporalCondition;
const AFTERNOON_TO_MIDNIGHT = {
  type: "utc_hours",
  op: "gte",
  value: "12:00",
} as const satisfies TemporalCondition;

/** 24 one-hour rules: every hour swaps active rule ids without changing peak 2×. */
function hourlyNotHolidayRules(): { when: TemporalCondition; factor: number }[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const start = `${String(hour).padStart(2, "0")}:00`;
    const of: TemporalCondition[] = [
      NOT_HOLIDAY_CN,
      { type: "utc_hours", op: "gte", value: start },
    ];
    if (hour < 23) {
      of.push({ type: "utc_hours", op: "lt", value: `${String(hour + 1).padStart(2, "0")}:00` });
    }
    return { when: { type: "all", of }, factor: 2 };
  });
}

function transitionSnapshot(): TemporalSnapshot {
  return normalizeTemporalSnapshot({
    version: 1,
    revision: REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
    generatedAt: GENERATED_AT,
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers: {
      "rule-churn": {
        // A and B are different active rule ids with the same classified peak
        // effect; switching between them is not a UI-visible transition.
        "same-effect": multiplierPolicy("rule-churn", "same-effect", [
          { when: MORNING, factor: 2 },
          { when: AFTERNOON, factor: 2 },
        ]),
        // The same rule-id churn repeats forever with no classified change.
        "same-effect-all-day": multiplierPolicy("rule-churn", "same-effect-all-day", [
          { when: MORNING, factor: 2 },
          { when: AFTERNOON_TO_MIDNIGHT, factor: 2 },
        ]),
      },
      "unresolved-after": {
        // Resolved off-peak now; at the 2027 Shanghai boundary the missing
        // calendar turns the state unresolved, so the destination is unknown.
        "holiday-only": multiplierPolicy("unresolved-after", "holiday-only", [
          { when: HOLIDAY_ONLY, factor: 2 },
        ]),
      },
      "hourly-churn": {
        // Hourly rule ids swap all day; the long CN holiday finally changes
        // the classified phase. The next real transition is >16 no-ops away.
        "holiday-wait": multiplierPolicy("hourly-churn", "holiday-wait", hourlyNotHolidayRules()),
      },
    },
  });
}

const TRANSITION_ROUTES: Record<string, string[]> = {
  "rule-churn": ["same-effect", "same-effect-all-day"],
  "unresolved-after": ["holiday-only"],
  "hourly-churn": ["holiday-wait"],
};

const HOLIDAYS = [
  {
    jurisdiction: "CN" as const,
    id: "spring-festival",
    localStart: "2026-02-15",
    localEnd: "2026-02-24",
    startMs: Date.parse("2026-02-14T16:00:00.000Z"),
    endMs: Date.parse("2026-02-23T16:00:00.000Z"),
  },
];

afterEach(() => {
  __resetTemporalSnapshotForTests();
});

function build(nowIso: string) {
  setTemporalSnapshotForTests(fixture());
  return buildTemporalStatus({
    providers: [
      { providerId: "deepseek", providerLabel: "DeepSeek", discovered: true },
      { providerId: "test-mixed", providerLabel: "Test Mixed", discovered: true },
      { providerId: "zai", providerLabel: "Z.ai", discovered: false },
      { providerId: "unknown", providerLabel: "Unknown", discovered: false },
    ],
    nowMs: Date.parse(nowIso),
    routes: routes(),
    holidays: HOLIDAYS,
    baseRates,
  });
}

describe("temporal status projection", () => {
  it("evaluates only exact provider/model routes and never invents a match", () => {
    const status = build("2026-01-05T02:00:00.000Z");
    expect(status.providers.map((provider) => provider.providerId)).toEqual([
      "deepseek",
      "test-mixed",
      "zai",
    ]);
    expect(status.providers.every((provider) => provider.models.length > 0)).toBe(true);
    expect(status.providers.some((provider) => provider.providerId === "unknown")).toBe(false);
  });

  it("reports peak, off-peak and mixed providers from live model rules", () => {
    const status = build("2026-01-05T02:00:00.000Z");
    const deepseek = status.providers.find((provider) => provider.providerId === "deepseek");
    const mixed = status.providers.find((provider) => provider.providerId === "test-mixed");
    expect(deepseek?.phase).toBe("peak");
    expect(deepseek?.models[0]).toMatchObject({
      modelId: "deepseek-v4-pro",
      state: "peak",
      nextChangeAtMs: Date.parse("2026-01-05T04:00:00.000Z"),
      nextState: "offpeak",
    });
    expect(deepseek?.models[0]?.effect?.factor).toBe(2);
    expect(mixed?.phase).toBe("mixed");
    expect(mixed?.models.map((model) => model.state).sort()).toEqual(["offpeak", "peak"]);
  });

  it.each([
    ["peak only", "agg-peak", "peak"],
    ["off-peak only", "agg-offpeak", "offpeak"],
    ["peak and off-peak", "agg-mixed", "mixed"],
    ["unknown only", "agg-unknown", "unknown"],
    ["peak and unknown", "agg-peak-unknown", "unknown"],
    ["off-peak and unknown", "agg-offpeak-unknown", "unknown"],
    ["peak, off-peak and unknown", "agg-mixed-unknown", "unknown"],
    ["two peak models", "agg-two-peak", "peak"],
    ["two off-peak models", "agg-two-offpeak", "offpeak"],
    ["two peak and two off-peak models", "agg-two-and-two", "mixed"],
    ["two peak, two off-peak and unknown", "agg-two-and-two-unknown", "unknown"],
  ] as const)("aggregates %s conservatively, treating any in-scope unknown as unknown", (_label, providerId, expected) => {
    setTemporalSnapshotForTests(aggregationSnapshot());
    const status = buildTemporalStatus({
      providers: [{ providerId, providerLabel: providerId, discovered: true }],
      nowMs: Date.parse("2027-01-05T02:00:00.000Z"),
      routes: AGGREGATE_ROUTES,
      baseRates,
    });
    expect(status.providers[0]?.phase).toBe(expected);
  });

  it("classifies the real Alibaba discount-only policy across baseline and discounted hours", () => {
    setTemporalSnapshotForTests(actualSnapshot());
    const catalog = readBundledTemporalCatalog();
    const providers = [{ providerId: "alibaba", providerLabel: "Alibaba", discovered: true }];
    const at = (nowIso: string) =>
      buildTemporalStatus({
        providers,
        nowMs: Date.parse(nowIso),
        routes: catalog.routes,
        holidays: catalog.holidays,
      }).providers[0];
    const modelAt = (status: ReturnType<typeof at>) =>
      status?.models.find((entry) => entry.modelId === "deepseek-v4-flash-0731");

    const baseline = at("2026-01-05T13:00:00.000Z");
    expect(baseline?.phase).toBe("peak");
    expect(modelAt(baseline)).toMatchObject({
      modelId: "deepseek-v4-flash-0731",
      state: "peak",
      effect: { factor: 1, direction: "unchanged", unit: "api_price" },
      nextChangeAtMs: Date.parse("2026-01-05T14:00:00.000Z"),
      nextState: "offpeak",
    });
    expect(modelAt(baseline)?.weekly).toEqual({
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      basePhase: "peak",
      baseEffect: { factor: 1, direction: "unchanged", unit: "api_price", scalar: true },
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
          startMinute: 840,
          endMinute: 1440,
          phase: "offpeak",
          effect: { factor: 0.5, direction: "offpeak", unit: "api_price", scalar: true },
        },
      ],
    });

    const discounted = at("2026-01-05T14:00:00.000Z");
    expect(discounted?.phase).toBe("offpeak");
    expect(modelAt(discounted)).toMatchObject({
      modelId: "deepseek-v4-flash-0731",
      state: "offpeak",
      effect: { factor: 0.5, direction: "offpeak", unit: "api_price" },
      nextChangeAtMs: Date.parse("2026-01-06T00:00:00.000Z"),
      nextState: "peak",
    });
  });

  it("describes the declared DeepSeek weekly windows and keeps CN holidays separate", () => {
    setTemporalSnapshotForTests(actualSnapshot());
    const catalog = readBundledTemporalCatalog();
    const provider = buildTemporalStatus({
      providers: [{ providerId: "deepseek", providerLabel: "DeepSeek", discovered: true }],
      // Inside the 2026 Spring Festival: today is off-peak, but the declared
      // weekday frequency must not be sampled away.
      nowMs: Date.parse("2026-02-17T02:00:00.000Z"),
      routes: catalog.routes,
      holidays: catalog.holidays,
    }).providers[0];
    const model = provider?.models.find((entry) => entry.modelId === "deepseek-v4-pro");
    expect(model?.state).toBe("offpeak");
    // Exact holiday dates stay on the provider; the weekly base stays weekly.
    expect(provider?.holidays).toEqual(
      expect.arrayContaining([expect.objectContaining({ jurisdiction: "CN" })]),
    );
    expect(model?.weekly).toEqual({
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      basePhase: "offpeak",
      baseEffect: { factor: 1, direction: "unchanged", unit: "api_price", scalar: true },
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          startMinute: 60,
          endMinute: 240,
          phase: "peak",
          effect: { factor: 2, direction: "peak", unit: "api_price", scalar: true },
        },
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          startMinute: 360,
          endMinute: 600,
          phase: "peak",
          effect: { factor: 2, direction: "peak", unit: "api_price", scalar: true },
        },
      ],
      exceptHolidays: ["CN"],
    });
  });

  it("keeps a surcharge-only policy's unchanged baseline on off-peak", () => {
    const deepseek = build("2026-01-05T04:00:00.000Z").providers.find(
      (provider) => provider.providerId === "deepseek",
    );
    expect(deepseek?.models[0]).toMatchObject({
      state: "offpeak",
      effect: { factor: 1, direction: "unchanged", unit: "api_price" },
    });
  });

  it("fails closed when a policy cannot establish one baseline direction", () => {
    setTemporalSnapshotForTests(ambiguousSnapshot());
    const status = buildTemporalStatus({
      providers: [{ providerId: "ambiguous", providerLabel: "Ambiguous", discovered: true }],
      nowMs: Date.parse("2026-01-05T02:00:00.000Z"),
      routes: { ambiguous: ["mixed", "equal"] },
      baseRates,
    });
    const provider = status.providers[0];
    expect(provider?.phase).toBe("unknown");
    expect(provider?.models.map((model) => model.state)).toEqual(["unknown", "unknown"]);
    for (const model of provider?.models ?? []) {
      expect(model.effect).toBeUndefined();
      // No provable weekly classification, so no descriptor is invented.
      expect(model.weekly).toBeUndefined();
    }
  });

  it("ships a live Z.ai quota-point policy from the official schedule", () => {
    const peak = buildTemporalStatus({
      providers: [{ providerId: "zai", providerLabel: "Z.ai", discovered: false }],
      nowMs: Date.parse("2026-11-02T06:00:00.000Z"),
      routes: {},
    });
    const zai = peak.providers[0];
    expect(zai).toMatchObject({
      providerId: "zai",
      discovered: false,
      phase: "peak",
      source: {
        label: "Z.ai current credits-plan usage",
        url: "https://docs.z.ai/devpack/overview#usage-instruction",
        accessedAt: "2026-10-30",
      },
    });
    expect(zai?.models.map((model) => model.modelId)).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(zai?.models[0]).toMatchObject({
      modelId: "glm-5.3",
      state: "peak",
      effect: { factor: 1, unit: "quota_points" },
      nextChangeAtMs: Date.parse("2026-11-02T10:00:00.000Z"),
      nextState: "offpeak",
    });

    const offpeak = buildTemporalStatus({
      providers: [{ providerId: "zai", providerLabel: "Z.ai", discovered: false }],
      nowMs: Date.parse("2026-11-02T10:00:00.000Z"),
      routes: {},
    }).providers[0]?.models[0];
    expect(temporalEffectLabel(offpeak?.effect)).toBe("Quota points: 0.5×");
    expect(
      temporalEffectLabel({
        factor: 0.5,
        direction: "offpeak",
        unit: "api_price",
        scalar: true,
      }),
    ).toBe("API price: 0.5×");
    expect(
      temporalEffectLabel({
        factor: 1,
        direction: "unchanged",
        unit: "api_price",
        scalar: true,
      }),
    ).toBe("API price: 1×");
    expect(
      temporalEffectLabel({
        factor: 0.5,
        direction: "offpeak",
        unit: "api_price",
        scalar: false,
      }),
    ).toBe("API price varies by token type");
    // Old wire and multiplier-only effects have no cross-rate indicator, so
    // only the direction is safe to show.
    expect(temporalEffectLabel({ factor: 2, direction: "peak", unit: "api_price" })).toBe(
      "API price: higher",
    );
    expect(temporalEffectLabel({ factor: 0.5, direction: "offpeak", unit: "api_price" })).toBe(
      "API price: lower",
    );
    expect(temporalEffectLabel({ factor: 1, direction: "unchanged", unit: "api_price" })).toBe(
      "API price: unchanged",
    );
  });

  it("lists every temporal-capable provider and marks account discovery", () => {
    const catalog = readBundledTemporalCatalog();
    const sources = listTemporalProviderSources(catalog, TEMPORAL_QUOTA_POLICIES, [
      { providerId: "deepseek", providerLabel: "DeepSeek Account" },
    ]);
    const ids = sources.map((source) => source.providerId);
    for (const providerId of Object.keys(catalog.routes)) expect(ids).toContain(providerId);
    expect(ids).toContain("zai");
    expect(sources.find((source) => source.providerId === "deepseek")).toMatchObject({
      providerLabel: "DeepSeek Account",
      discovered: true,
    });
    expect(sources.find((source) => source.providerId === "zai")).toMatchObject({
      providerLabel: "Z.ai",
      discovered: false,
    });
    expect(sources[0]?.discovered).toBe(true);

    const aliasSources = listTemporalProviderSources(catalog, TEMPORAL_QUOTA_POLICIES, [
      { providerId: "zai-coding-plan", providerLabel: "Z.ai Coding Plan" },
    ]);
    expect(aliasSources.find((source) => source.providerId === "zai")).toMatchObject({
      providerLabel: "Z.ai Coding Plan",
      discovered: true,
    });
    expect(aliasSources.some((source) => source.providerId === "zai-coding-plan")).toBe(false);
  });

  it("projects upcoming local-time intervals and referenced holiday exceptions", () => {
    const status = build("2026-01-05T02:00:00.000Z");
    const deepseek = status.providers.find((provider) => provider.providerId === "deepseek");
    expect(deepseek?.models[0]?.intervals[0]).toMatchObject({
      startMs: Date.parse("2026-01-05T02:00:00.000Z"),
      endMs: Date.parse("2026-01-05T04:00:00.000Z"),
      phase: "peak",
    });
    expect(deepseek?.holidays).toEqual(HOLIDAYS);
    expect(
      formatTemporalCountdown(
        Date.parse("2026-01-05T02:00:00.000Z"),
        Date.parse("2026-01-05T04:00:00.000Z"),
      ),
    ).toBe("2h");
  });

  it("keeps the true next transition when a long CN holiday outlasts the display horizon", () => {
    const nowMs = Date.parse("2026-02-17T02:00:00.000Z");
    const status = build("2026-02-17T02:00:00.000Z");
    const model = status.providers.find((provider) => provider.providerId === "deepseek")
      ?.models[0];
    expect(model?.state).toBe("offpeak");
    // The preview remains short: its last interval ends at the display horizon.
    expect(model?.intervals.at(-1)?.endMs).toBe(nowMs + TEMPORAL_SCHEDULE_HORIZON_MS);
    // The holiday runs to 2026-02-23T16:00Z; the next real rule change is the
    // first weekday peak window after it, beyond the three-day preview.
    expect(model?.nextChangeAtMs).toBe(Date.parse("2026-02-24T01:00:00.000Z"));
    expect(model?.nextState).toBe("peak");
  });

  it("skips rule-id changes that do not change the classified phase or effect", () => {
    const nowMs = Date.parse("2026-01-05T02:00:00.000Z");
    setTemporalSnapshotForTests(transitionSnapshot());
    const status = buildTemporalStatus({
      providers: [{ providerId: "rule-churn", providerLabel: "Rule Churn", discovered: true }],
      nowMs,
      routes: TRANSITION_ROUTES,
      baseRates,
    });
    const model = status.providers[0]?.models.find((entry) => entry.modelId === "same-effect");
    expect(model).toMatchObject({
      state: "peak",
      effect: { factor: 2, direction: "peak", unit: "api_price" },
      // Noon only swaps active rule ids; the next classified change is 18:00.
      nextChangeAtMs: Date.parse("2026-01-05T18:00:00.000Z"),
      nextState: "offpeak",
    });

    const raw = getNextTemporalTransition("rule-churn", "same-effect", nowMs);
    expect(raw?.atMs).toBe(Date.parse("2026-01-05T12:00:00.000Z"));
    expect(raw?.before.activeRuleIds).not.toEqual(raw?.after.activeRuleIds);

    const atNoon = buildTemporalStatus({
      providers: [{ providerId: "rule-churn", providerLabel: "Rule Churn", discovered: true }],
      nowMs: Date.parse("2026-01-05T12:00:00.000Z"),
      routes: TRANSITION_ROUTES,
      baseRates,
    }).providers[0]?.models.find((entry) => entry.modelId === "same-effect");
    expect(atNoon).toMatchObject({
      state: "peak",
      effect: { factor: 2, direction: "peak", unit: "api_price" },
    });
  });

  it("omits nextChangeAtMs when only rule-id churn remains", () => {
    setTemporalSnapshotForTests(transitionSnapshot());
    const status = buildTemporalStatus({
      providers: [{ providerId: "rule-churn", providerLabel: "Rule Churn", discovered: true }],
      nowMs: Date.parse("2026-01-05T02:00:00.000Z"),
      routes: TRANSITION_ROUTES,
      baseRates,
    });
    const model = status.providers[0]?.models.find(
      (entry) => entry.modelId === "same-effect-all-day",
    );
    expect(model?.state).toBe("peak");
    expect(model?.effect?.factor).toBe(2);
    expect(model).not.toHaveProperty("nextChangeAtMs");
    expect(model).not.toHaveProperty("nextState");
  });

  it("finds a long-holiday transition after more than sixteen no-op rule changes", () => {
    const nowMs = Date.parse("2026-02-13T02:00:00.000Z");
    setTemporalSnapshotForTests(transitionSnapshot());
    const build = (atMs: number) =>
      buildTemporalStatus({
        providers: [{ providerId: "hourly-churn", providerLabel: "Hourly", discovered: true }],
        nowMs: atMs,
        routes: TRANSITION_ROUTES,
        baseRates,
      }).providers[0]?.models.find((entry) => entry.modelId === "holiday-wait");

    // The first core transition only swaps the hourly rule id.
    const raw = getNextTemporalTransition("hourly-churn", "holiday-wait", nowMs);
    expect(raw?.atMs).toBe(Date.parse("2026-02-13T03:00:00.000Z"));
    expect(raw?.before.activeRuleIds).not.toEqual(raw?.after.activeRuleIds);
    expect(build(raw?.atMs ?? nowMs)).toMatchObject({
      state: "peak",
      effect: { factor: 2, direction: "peak", unit: "api_price" },
    });

    // Hourly churn continues for >16 transitions; the long CN holiday start is
    // the first classified change and carries its actual off-peak destination.
    const rawAt = raw?.atMs ?? nowMs;
    const holidayStart = Date.parse("2026-02-14T16:00:00.000Z");
    const churn = listTemporalIntervals("hourly-churn", "holiday-wait", rawAt, holidayStart);
    expect(churn.length).toBeGreaterThan(16);
    expect(build(nowMs)).toMatchObject({
      state: "peak",
      nextChangeAtMs: holidayStart,
      nextState: "offpeak",
    });
  });

  it("reports a transition whose unresolved destination is unknown", () => {
    const nowMs = Date.parse("2026-12-31T15:00:00.000Z");
    setTemporalSnapshotForTests(transitionSnapshot());
    const build = (atMs: number) =>
      buildTemporalStatus({
        providers: [
          { providerId: "unresolved-after", providerLabel: "Unresolved", discovered: true },
        ],
        nowMs: atMs,
        routes: TRANSITION_ROUTES,
        baseRates,
      }).providers[0]?.models.find((entry) => entry.modelId === "holiday-only");
    const model = build(nowMs);
    expect(model).toMatchObject({
      state: "offpeak",
      effect: { factor: 1, direction: "unchanged", unit: "api_price" },
      nextChangeAtMs: Date.parse("2026-12-31T16:00:00.000Z"),
      nextState: "unknown",
    });

    const raw = getNextTemporalTransition("unresolved-after", "holiday-only", nowMs);
    expect(raw).toMatchObject({
      atMs: Date.parse("2026-12-31T16:00:00.000Z"),
      after: { status: "unresolved" },
    });
    // The destination cannot be named as the raw rule classification would:
    // an unresolved after-state must stay unknown, with no effect.
    expect(build(Date.parse("2026-12-31T16:00:00.000Z"))).toMatchObject({ state: "unknown" });
    expect(build(Date.parse("2026-12-31T16:00:00.000Z"))?.effect).toBeUndefined();
  });

  it("keeps unresolved calendar windows unknown instead of guessing a phase", () => {
    setTemporalSnapshotForTests(fixture());
    const status = buildTemporalStatus({
      providers: [{ providerId: "deepseek", providerLabel: "DeepSeek", discovered: false }],
      nowMs: Date.parse("2027-01-01T02:00:00.000Z"),
      routes: { deepseek: ["deepseek-v4-pro"] },
      holidays: HOLIDAYS,
      baseRates,
    });
    const model = status.providers[0]?.models[0];
    expect(model).toMatchObject({ state: "unknown" });
    expect(model?.reason).toContain("2027");
    expect(model?.intervals[0]).toMatchObject({ phase: "unknown" });
    expect(model?.intervals[0]?.effect).toBeUndefined();
  });

  it("projects a Settings row for every temporal-capable provider without an account", () => {
    const catalog = readBundledTemporalCatalog();
    const sources = listTemporalProviderSources(catalog, TEMPORAL_QUOTA_POLICIES, []);
    const status = buildTemporalStatus({
      providers: sources,
      nowMs: Date.parse("2026-11-02T06:00:00.000Z"),
      routes: catalog.routes,
      holidays: catalog.holidays,
      quotaPolicies: TEMPORAL_QUOTA_POLICIES,
    });
    expect(status.providers.map((provider) => provider.providerId).sort()).toEqual(
      sources.map((source) => source.providerId).sort(),
    );
    expect(status.providers.every((provider) => provider.discovered === false)).toBe(true);
    expect(status.providers.find((provider) => provider.providerId === "zai")).toMatchObject({
      source: { label: "Z.ai current credits-plan usage" },
      phase: "peak",
    });
  });

  it("keeps the bundled catalog server-side and decodes a browser-safe quota DTO", () => {
    const catalog = readBundledTemporalCatalog();
    expect(Object.keys(catalog.routes).length).toBeGreaterThan(0);
    // Unsupported-only providers have no schedule, so they are not capable rows.
    expect(Object.keys(catalog.routes)).toContain("deepseek");
    expect(Object.keys(catalog.routes)).not.toContain("google");
    expect(Object.keys(catalog.routes)).not.toContain("opencode");
    expect(catalog.routes["opencode-go"]).toEqual(expect.arrayContaining(["deepseek-v4-pro"]));
    const status = build("2026-01-05T02:00:00.000Z");
    const payload = {
      generatedAtMs: status.generatedAtMs,
      stale: false,
      timeZone: "UTC",
      providers: { cards: [], enabledProviders: "auto" as const, polledAtMs: status.generatedAtMs },
      temporal: JSON.parse(JSON.stringify(status)) as JsonValue,
    };
    const decoded = parseQuotaSnapshot(payload);
    expect(decoded.temporal?.providers[1]?.providerLabel).toBe("Test Mixed");
    expect(decoded.temporal?.providers[1]?.discovered).toBe(true);
    expect(decoded.temporal?.providers[1]?.models[0]?.state).toBe("peak");
    expect(decoded.temporal?.providers[2]).toMatchObject({
      providerId: "zai",
      discovered: false,
      source: {
        label: "Z.ai current credits-plan usage",
        url: "https://docs.z.ai/devpack/overview#usage-instruction",
        accessedAt: "2026-10-30",
      },
    });
  });
});
