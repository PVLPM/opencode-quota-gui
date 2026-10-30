import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../src/contracts/dashboard.js";
import { TEMPORAL_QUOTA_POLICIES } from "../src/gui/temporal-quota-policy-data.js";
import {
  buildTemporalStatus,
  listTemporalProviderSources,
  readBundledTemporalCatalog,
} from "../src/gui/temporal-status.js";
import {
  __resetTemporalSnapshotForTests,
  normalizeTemporalSnapshot,
  setTemporalSnapshotForTests,
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
    });
    expect(deepseek?.models[0]?.effect?.factor).toBe(2);
    expect(mixed?.phase).toBe("mixed");
    expect(mixed?.models.map((model) => model.state).sort()).toEqual(["offpeak", "peak"]);
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
    });

    const discounted = at("2026-01-05T14:00:00.000Z");
    expect(discounted?.phase).toBe("offpeak");
    expect(modelAt(discounted)).toMatchObject({
      modelId: "deepseek-v4-flash-0731",
      state: "offpeak",
      effect: { factor: 0.5, direction: "offpeak", unit: "api_price" },
      nextChangeAtMs: Date.parse("2026-01-06T00:00:00.000Z"),
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
    for (const model of provider?.models ?? []) expect(model.effect).toBeUndefined();
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
    });

    const offpeak = buildTemporalStatus({
      providers: [{ providerId: "zai", providerLabel: "Z.ai", discovered: false }],
      nowMs: Date.parse("2026-11-02T10:00:00.000Z"),
      routes: {},
    }).providers[0]?.models[0];
    expect(temporalEffectLabel(offpeak?.effect)).toBe("0.5× quota points");
    expect(temporalEffectLabel({ factor: 0.5, direction: "offpeak", unit: "api_price" })).toBe(
      "0.5× API price",
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
