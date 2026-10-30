import { afterEach, describe, expect, it } from "vitest";

import {
  __resetTemporalSnapshotForTests,
  evaluateTemporalCondition,
  getNextTemporalTransition,
  getTemporalInstantState,
  getTemporalPolicy,
  getTemporalSnapshotMeta,
  listTemporalIntervals,
  normalizeTemporalSnapshot,
  resolveTemporalRates,
  setTemporalSnapshotForTests,
} from "../src/lib/modelsdev-temporal.js";

const REVISION = "4a58d0bc74552942a2aa29bc9065a38ed3fe04e4";
const GENERATED_AT = 1_793_377_482_000;

const CN_2026 = {
  timeZone: "Asia/Shanghai",
  source: "https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html",
  published: "2025-11-04",
  intervals: [
    {
      id: "new-year",
      localStart: "2026-01-01",
      localEnd: "2026-01-04",
      startMs: 1_767_196_800_000,
      endMs: 1_767_456_000_000,
    },
    {
      id: "spring-festival",
      localStart: "2026-02-15",
      localEnd: "2026-02-24",
      startMs: 1_771_084_800_000,
      endMs: 1_771_862_400_000,
    },
    {
      id: "qingming",
      localStart: "2026-04-04",
      localEnd: "2026-04-07",
      startMs: 1_775_232_000_000,
      endMs: 1_775_491_200_000,
    },
    {
      id: "labour-day",
      localStart: "2026-05-01",
      localEnd: "2026-05-06",
      startMs: 1_777_564_800_000,
      endMs: 1_777_996_800_000,
    },
    {
      id: "dragon-boat-festival",
      localStart: "2026-06-19",
      localEnd: "2026-06-22",
      startMs: 1_781_798_400_000,
      endMs: 1_782_057_600_000,
    },
    {
      id: "mid-autumn-festival",
      localStart: "2026-09-25",
      localEnd: "2026-09-28",
      startMs: 1_790_265_600_000,
      endMs: 1_790_524_800_000,
    },
    {
      id: "national-day",
      localStart: "2026-10-01",
      localEnd: "2026-10-08",
      startMs: 1_790_784_000_000,
      endMs: 1_791_388_800_000,
    },
  ],
  makeupWorkdays: [
    "2026-01-04",
    "2026-02-14",
    "2026-02-28",
    "2026-05-09",
    "2026-09-20",
    "2026-10-10",
  ],
};

function makeSnapshot(providers: Record<string, Record<string, unknown>>) {
  return {
    version: 1,
    revision: REVISION,
    source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
    generatedAt: GENERATED_AT,
    jurisdictions: { CN: { "2026": CN_2026 } },
    providers,
  };
}

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

const SNAPSHOT = makeSnapshot({
  alibaba: {
    "deepseek-v4.1-flash": {
      status: "supported",
      source: "providers/alibaba/models/deepseek-v4.1-flash.toml",
      overrides: [],
      multipliers: [
        {
          id: "multipliers[0]",
          when: { type: "utc_hours", op: "gte", value: "14:00" },
          factor: { text: 0.5 },
        },
      ],
    },
  },
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
                type: "any",
                of: [
                  {
                    type: "all",
                    of: [
                      { type: "utc_hours", op: "gte", value: "01:00" },
                      { type: "utc_hours", op: "lt", value: "04:00" },
                    ],
                  },
                  {
                    type: "all",
                    of: [
                      { type: "utc_hours", op: "gte", value: "06:00" },
                      { type: "utc_hours", op: "lt", value: "10:00" },
                    ],
                  },
                ],
              },
            ],
          },
          factor: 2,
        },
      ],
    },
  },
  openrouter: {
    "deepseek/deepseek-v4.1-flash-1017": {
      status: "supported",
      source: "providers/openrouter/models/deepseek/deepseek-v4.1-flash-1017.toml",
      overrides: [
        {
          id: "text.input.overrides[0]",
          field: "input",
          when: { type: "utc_days", op: "in", value: ["sat", "sun"] },
          rates: { input: 0.15, cache_read: 0.003 },
        },
        {
          id: "text.input.overrides[1]",
          field: "input",
          when: {
            type: "all",
            of: [
              { type: "utc_days", op: "in", value: WEEKDAYS },
              { type: "utc_hours", op: "gte", value: "01:00" },
              { type: "utc_hours", op: "lt", value: "04:00" },
            ],
          },
          rates: { input: 0.3, cache_read: 0.006 },
        },
        {
          id: "text.output.overrides[0]",
          field: "output",
          when: {
            type: "all",
            of: [
              { type: "utc_days", op: "in", value: WEEKDAYS },
              { type: "utc_hours", op: "gte", value: "01:00" },
              { type: "utc_hours", op: "lt", value: "04:00" },
            ],
          },
          rates: { output: 1.2 },
        },
      ],
      multipliers: [],
    },
  },
  "opencode-go": {
    "deepseek-v4-pro": {
      status: "unsupported",
      source: "providers/opencode-go/models/deepseek-v4-pro.toml",
      reason: "unsupported condition key: context",
    },
  },
  "calendar-test": {
    "holiday-only": {
      status: "supported",
      source: "providers/calendar-test/models/holiday-only.toml",
      overrides: [],
      multipliers: [
        {
          id: "multipliers[0]",
          when: { type: "holiday", op: "equals", value: "CN" },
          factor: 2,
        },
      ],
    },
  },
  "hour-test": {
    equals: {
      status: "supported",
      source: "providers/hour-test/models/equals.toml",
      overrides: [],
      multipliers: [
        {
          id: "multipliers[0]",
          when: { type: "utc_hours", op: "equals", value: "14:00" },
          factor: 2,
        },
      ],
    },
    in: {
      status: "supported",
      source: "providers/hour-test/models/in.toml",
      overrides: [],
      multipliers: [
        {
          id: "multipliers[0]",
          when: { type: "utc_hours", op: "in", value: ["14:00", "16:00"] },
          factor: 2,
        },
      ],
    },
    gt: {
      status: "supported",
      source: "providers/hour-test/models/gt.toml",
      overrides: [],
      multipliers: [
        {
          id: "multipliers[0]",
          when: { type: "utc_hours", op: "gt", value: "14:00" },
          factor: 2,
        },
      ],
    },
    lte: {
      status: "supported",
      source: "providers/hour-test/models/lte.toml",
      overrides: [],
      multipliers: [
        {
          id: "multipliers[0]",
          when: { type: "utc_hours", op: "lte", value: "14:00" },
          factor: 2,
        },
      ],
    },
  },
});

function loadFixture() {
  setTemporalSnapshotForTests(normalizeTemporalSnapshot(SNAPSHOT));
}

function at(iso: string): number {
  return Date.parse(iso);
}

afterEach(() => {
  __resetTemporalSnapshotForTests();
});

describe("modelsdev temporal condition evaluation", () => {
  it("treats utc_hours as a same-UTC-day minute window with exact boundaries", () => {
    const gte14 = {
      type: "utc_hours" as const,
      op: "gte" as const,
      value: "14:00",
    };

    expect(evaluateTemporalCondition(gte14, at("2026-01-05T13:59:59.999Z")).value).toBe(false);
    expect(evaluateTemporalCondition(gte14, at("2026-01-05T14:00:00.000Z")).value).toBe(true);
    expect(evaluateTemporalCondition(gte14, at("2026-01-05T23:59:59.999Z")).value).toBe(true);
    // Alibaba's ">= 14:00" must not wrap into the next UTC day.
    expect(evaluateTemporalCondition(gte14, at("2026-01-06T00:00:00.000Z")).value).toBe(false);

    const lt04 = { type: "utc_hours" as const, op: "lt" as const, value: "04:00" };
    expect(evaluateTemporalCondition(lt04, at("2026-01-05T03:59:59.999Z")).value).toBe(true);
    expect(evaluateTemporalCondition(lt04, at("2026-01-05T04:00:00.000Z")).value).toBe(false);
  });

  it("evaluates utc_days against the UTC calendar date", () => {
    const weekdays = {
      type: "utc_days" as const,
      op: "in" as const,
      value: WEEKDAYS,
    };
    expect(evaluateTemporalCondition(weekdays, at("2026-01-05T00:00:00.000Z")).value).toBe(true);
    expect(evaluateTemporalCondition(weekdays, at("2026-01-10T00:00:00.000Z")).value).toBe(false);
  });

  it("resolves CN 2026 public holidays in Asia/Shanghai civil time", () => {
    const holiday = {
      type: "holiday" as const,
      op: "equals" as const,
      value: "CN",
    };

    const beforeKnownYear = evaluateTemporalCondition(holiday, at("2025-12-31T15:59:59.999Z"));
    expect(beforeKnownYear.value).toBeNull();
    expect(beforeKnownYear.status).toBe("unresolved");
    expect(evaluateTemporalCondition(holiday, at("2025-12-31T16:00:00.000Z")).value).toBe(true);
    expect(evaluateTemporalCondition(holiday, at("2026-01-03T15:59:59.999Z")).value).toBe(true);
    expect(evaluateTemporalCondition(holiday, at("2026-01-03T16:00:00.000Z")).value).toBe(false);
    expect(evaluateTemporalCondition(holiday, at("2026-10-01T02:00:00.000Z")).value).toBe(true);

    const unknownYear = evaluateTemporalCondition(holiday, at("2027-01-01T00:00:00.000Z"));
    expect(unknownYear.value).toBeNull();
    expect(unknownYear.status).toBe("unresolved");

    const unknownJurisdiction = evaluateTemporalCondition(
      { type: "holiday", op: "equals", value: "US" },
      at("2026-01-01T00:00:00.000Z"),
    );
    expect(unknownJurisdiction.value).toBeNull();
    expect(unknownJurisdiction.status).toBe("unresolved");
  });

  it("propagates three-valued logic through all, any and not", () => {
    const truth = { type: "utc_hours", op: "gte", value: "14:00" } as const;
    const falsey = { type: "utc_hours", op: "lt", value: "00:00" } as const;
    const unknown = { type: "holiday", op: "equals", value: "US" } as const;

    expect(
      evaluateTemporalCondition(
        { type: "all", of: [falsey, unknown] },
        at("2026-01-05T12:00:00.000Z"),
      ).value,
    ).toBe(false);
    expect(
      evaluateTemporalCondition(
        { type: "all", of: [truth, unknown] },
        at("2026-01-05T15:00:00.000Z"),
      ).status,
    ).toBe("unresolved");
    expect(
      evaluateTemporalCondition(
        { type: "any", of: [truth, unknown] },
        at("2026-01-05T15:00:00.000Z"),
      ).value,
    ).toBe(true);
    expect(
      evaluateTemporalCondition(
        { type: "any", of: [falsey, unknown] },
        at("2026-01-05T12:00:00.000Z"),
      ).status,
    ).toBe("unresolved");
    expect(
      evaluateTemporalCondition({ type: "not", of: unknown }, at("2026-01-05T12:00:00.000Z"))
        .status,
    ).toBe("unresolved");
    expect(
      evaluateTemporalCondition({ type: "not", of: falsey }, at("2026-01-05T12:00:00.000Z")).value,
    ).toBe(true);
  });
});

describe("modelsdev temporal pricing runtime", () => {
  it("keeps the pinned revision and exact provider/model route", () => {
    loadFixture();
    expect(getTemporalSnapshotMeta()).toMatchObject({
      revision: REVISION,
      source: `https://github.com/anomalyco/models.dev/tree/${REVISION}`,
      generatedAt: GENERATED_AT,
    });
    expect(getTemporalPolicy("openrouter", "deepseek/deepseek-v4.1-flash-1017")).toMatchObject({
      status: "supported",
      source: "providers/openrouter/models/deepseek/deepseek-v4.1-flash-1017.toml",
    });
    expect(getTemporalPolicy("openrouter", "deepseek-v4.1-flash-1017")).toBeNull();
  });

  it("applies temporal overrides in source order and then multipliers", () => {
    loadFixture();
    const base = { input: 0.15, output: 0.6, cache_read: 0.003 };

    const peak = resolveTemporalRates(
      "openrouter",
      "deepseek/deepseek-v4.1-flash-1017",
      at("2026-01-05T02:00:00.000Z"),
      base,
    );
    expect(peak).toMatchObject({
      status: "resolved",
      rates: { input: 0.3, output: 1.2, cache_read: 0.006 },
    });
    expect(peak.appliedRuleIds).toEqual(["text.input.overrides[1]", "text.output.overrides[0]"]);

    const saturday = resolveTemporalRates(
      "openrouter",
      "deepseek/deepseek-v4.1-flash-1017",
      at("2026-01-10T02:00:00.000Z"),
      base,
    );
    expect(saturday.rates).toEqual({ input: 0.15, output: 0.6, cache_read: 0.003 });

    const outside = resolveTemporalRates(
      "openrouter",
      "deepseek/deepseek-v4.1-flash-1017",
      at("2026-01-05T05:00:00.000Z"),
      base,
    );
    expect(outside.rates).toEqual(base);
  });

  it("keeps DeepSeek's holiday exception and unresolved future years honest", () => {
    loadFixture();
    const base = { input: 0.66, output: 1.98, cache_read: 0.022 };

    const peak = resolveTemporalRates(
      "deepseek",
      "deepseek-v4-pro",
      at("2026-01-05T02:00:00.000Z"),
      base,
    );
    expect(peak.rates).toEqual({ input: 1.32, output: 3.96, cache_read: 0.044 });

    const holiday = resolveTemporalRates(
      "deepseek",
      "deepseek-v4-pro",
      at("2026-10-01T02:00:00.000Z"),
      base,
    );
    expect(holiday.rates).toEqual(base);

    const future = resolveTemporalRates(
      "deepseek",
      "deepseek-v4-pro",
      at("2027-01-04T02:00:00.000Z"),
      base,
    );
    expect(future.status).toBe("unresolved");
    expect(future.rates).toBeNull();
  });

  it("does not infer extra hours from Alibaba's >= 14:00 window", () => {
    loadFixture();
    const base = { input: 1.2, output: 6 };
    expect(
      resolveTemporalRates("alibaba", "deepseek-v4.1-flash", at("2026-01-05T13:59:59.999Z"), base)
        .rates,
    ).toEqual(base);
    expect(
      resolveTemporalRates("alibaba", "deepseek-v4.1-flash", at("2026-01-05T14:00:00.000Z"), base)
        .rates,
    ).toEqual({ input: 0.6, output: 3 });
    expect(
      resolveTemporalRates("alibaba", "deepseek-v4.1-flash", at("2026-01-05T23:59:59.999Z"), base)
        .rates,
    ).toEqual({ input: 0.6, output: 3 });
    expect(
      resolveTemporalRates("alibaba", "deepseek-v4.1-flash", at("2026-01-06T00:00:00.000Z"), base)
        .rates,
    ).toEqual(base);
  });

  it("fails closed for unsupported policies and leaves untouched models alone", () => {
    loadFixture();
    const base = { input: 1, output: 2 };
    const unsupported = resolveTemporalRates(
      "opencode-go",
      "deepseek-v4-pro",
      at("2026-01-05T02:00:00.000Z"),
      base,
    );
    expect(unsupported.status).toBe("unsupported");
    expect(unsupported.rates).toBeNull();

    const untouched = resolveTemporalRates(
      "openai",
      "gpt-5.5",
      at("2026-01-05T02:00:00.000Z"),
      base,
    );
    expect(untouched.status).toBe("resolved");
    expect(untouched.rates).toEqual(base);
  });

  it("finds exact next transitions and groups contiguous intervals", () => {
    loadFixture();
    expect(
      getNextTemporalTransition("alibaba", "deepseek-v4.1-flash", at("2026-01-05T13:59:00.000Z"))
        ?.atMs,
    ).toBe(at("2026-01-05T14:00:00.000Z"));
    expect(
      getNextTemporalTransition("alibaba", "deepseek-v4.1-flash", at("2026-01-05T14:00:00.000Z"))
        ?.atMs,
    ).toBe(at("2026-01-06T00:00:00.000Z"));
    expect(
      getNextTemporalTransition("alibaba", "deepseek-v4.1-flash", at("2026-01-06T00:00:00.000Z"))
        ?.atMs,
    ).toBe(at("2026-01-06T14:00:00.000Z"));
    expect(
      getNextTemporalTransition("deepseek", "deepseek-v4-pro", at("2026-12-31T15:00:00.000Z"))
        ?.atMs,
    ).toBe(at("2027-01-01T01:00:00.000Z"));
    expect(
      getNextTemporalTransition("openai", "gpt-5.5", at("2026-01-05T13:59:00.000Z")),
    ).toBeNull();
    expect(
      getNextTemporalTransition("opencode-go", "deepseek-v4-pro", at("2026-01-05T13:59:00.000Z")),
    ).toBeNull();
    expect(
      getNextTemporalTransition("calendar-test", "holiday-only", at("2025-12-31T15:00:00.000Z"))
        ?.atMs,
    ).toBe(at("2025-12-31T16:00:00.000Z"));
    expect(
      getNextTemporalTransition("calendar-test", "holiday-only", at("2026-01-03T16:00:00.000Z"))
        ?.atMs,
    ).toBe(at("2026-02-14T16:00:00.000Z"));
    expect(
      getNextTemporalTransition("calendar-test", "holiday-only", at("2026-10-07T16:00:00.000Z"))
        ?.atMs,
    ).toBe(at("2026-12-31T16:00:00.000Z"));

    const intervals = listTemporalIntervals(
      "alibaba",
      "deepseek-v4.1-flash",
      at("2026-01-05T13:00:00.000Z"),
      at("2026-01-06T01:00:00.000Z"),
    );
    expect(intervals.map((interval) => [interval.startMs, interval.endMs])).toEqual([
      [at("2026-01-05T13:00:00.000Z"), at("2026-01-05T14:00:00.000Z")],
      [at("2026-01-05T14:00:00.000Z"), at("2026-01-06T00:00:00.000Z")],
      [at("2026-01-06T00:00:00.000Z"), at("2026-01-06T01:00:00.000Z")],
    ]);
    expect(intervals.map((interval) => interval.activeRuleIds)).toEqual([
      [],
      ["multipliers[0]"],
      [],
    ]);

    const unresolved = listTemporalIntervals(
      "deepseek",
      "deepseek-v4-pro",
      at("2027-01-01T00:00:00.000Z"),
      at("2027-01-01T02:00:00.000Z"),
    );
    expect(unresolved.map((interval) => interval.status)).toEqual(["resolved", "unresolved"]);
  });

  it("includes every real clock boundary for equals, in, gt, and lte", () => {
    loadFixture();
    expect(
      getNextTemporalTransition("hour-test", "equals", at("2026-01-05T13:59:00.000Z"))?.atMs,
    ).toBe(at("2026-01-05T14:00:00.000Z"));
    expect(
      getNextTemporalTransition("hour-test", "equals", at("2026-01-05T14:00:00.000Z"))?.atMs,
    ).toBe(at("2026-01-05T14:01:00.000Z"));
    expect(
      getNextTemporalTransition("hour-test", "equals", at("2026-01-05T14:01:00.000Z"))?.atMs,
    ).toBe(at("2026-01-06T14:00:00.000Z"));

    expect(getNextTemporalTransition("hour-test", "in", at("2026-01-05T13:59:00.000Z"))?.atMs).toBe(
      at("2026-01-05T14:00:00.000Z"),
    );
    expect(getNextTemporalTransition("hour-test", "in", at("2026-01-05T14:00:00.000Z"))?.atMs).toBe(
      at("2026-01-05T14:01:00.000Z"),
    );
    expect(getNextTemporalTransition("hour-test", "in", at("2026-01-05T14:01:00.000Z"))?.atMs).toBe(
      at("2026-01-05T16:00:00.000Z"),
    );
    expect(getNextTemporalTransition("hour-test", "in", at("2026-01-05T16:00:00.000Z"))?.atMs).toBe(
      at("2026-01-05T16:01:00.000Z"),
    );

    expect(getNextTemporalTransition("hour-test", "gt", at("2026-01-05T13:59:00.000Z"))?.atMs).toBe(
      at("2026-01-05T14:01:00.000Z"),
    );
    expect(getNextTemporalTransition("hour-test", "gt", at("2026-01-05T14:00:00.000Z"))?.atMs).toBe(
      at("2026-01-05T14:01:00.000Z"),
    );

    expect(
      getNextTemporalTransition("hour-test", "lte", at("2026-01-05T14:00:00.000Z"))?.atMs,
    ).toBe(at("2026-01-05T14:01:00.000Z"));

    const intervals = listTemporalIntervals(
      "hour-test",
      "equals",
      at("2026-01-05T13:59:00.000Z"),
      at("2026-01-05T14:02:00.000Z"),
    );
    expect(intervals.map((interval) => [interval.startMs, interval.endMs])).toEqual([
      [at("2026-01-05T13:59:00.000Z"), at("2026-01-05T14:00:00.000Z")],
      [at("2026-01-05T14:00:00.000Z"), at("2026-01-05T14:01:00.000Z")],
      [at("2026-01-05T14:01:00.000Z"), at("2026-01-05T14:02:00.000Z")],
    ]);
    expect(intervals.map((interval) => interval.activeRuleIds)).toEqual([
      [],
      ["multipliers[0]"],
      [],
    ]);
  });

  it("reports unresolved instant state without inventing active rules", () => {
    loadFixture();
    expect(
      getTemporalInstantState("deepseek", "deepseek-v4-pro", at("2027-01-04T02:00:00.000Z")),
    ).toMatchObject({ status: "unresolved", activeRuleIds: [] });
    expect(
      getTemporalInstantState("opencode-go", "deepseek-v4-pro", at("2026-01-05T02:00:00.000Z")),
    ).toMatchObject({ status: "unsupported", activeRuleIds: [] });
  });
});

describe("modelsdev temporal snapshot validation", () => {
  it("rejects a missing authoritative CN 2026 calendar", () => {
    const invalid = makeSnapshot({});
    expect(() => normalizeTemporalSnapshot({ ...invalid, jurisdictions: {} })).toThrow(/CN 2026/);
  });

  it("rejects a holiday boundary that does not match Asia/Shanghai midnight", () => {
    const invalid = makeSnapshot({});
    const broken = {
      ...invalid,
      jurisdictions: {
        CN: {
          "2026": {
            ...CN_2026,
            intervals: [{ ...CN_2026.intervals[0], startMs: CN_2026.intervals[0].startMs + 1 }],
          },
        },
      },
    };
    expect(() => normalizeTemporalSnapshot(broken)).toThrow(/boundary/);
  });

  it("rejects an impossible civil date even when Date.parse would normalize it", () => {
    const invalid = makeSnapshot({});
    const broken = {
      ...invalid,
      jurisdictions: {
        CN: {
          "2026": {
            ...CN_2026,
            intervals: [
              {
                ...CN_2026.intervals[0],
                localStart: "2026-02-30",
              },
            ],
          },
        },
      },
    };
    expect(() => normalizeTemporalSnapshot(broken)).toThrow(/valid calendar date/);
  });

  it("rejects overlapping or unsorted holiday intervals", () => {
    const invalid = makeSnapshot({});
    const broken = {
      ...invalid,
      jurisdictions: {
        CN: {
          "2026": {
            ...CN_2026,
            intervals: [CN_2026.intervals[1], CN_2026.intervals[0]],
          },
        },
      },
    };
    expect(() => normalizeTemporalSnapshot(broken)).toThrow(/sorted/);
  });

  it("rejects unsupported policy fields and unknown condition shapes", () => {
    const invalid = makeSnapshot({
      openai: {
        "gpt-5.5": {
          status: "supported",
          source: "providers/openai/models/gpt-5.5.toml",
          overrides: [
            {
              id: "text.input.overrides[0]",
              field: "input",
              when: { type: "utc_hours", op: "gte", value: "14:00" },
              rates: { input: 1 },
            },
          ],
          multipliers: [],
          extra: true,
        },
      },
    });
    expect(() => normalizeTemporalSnapshot(invalid)).toThrow();

    const badCondition = makeSnapshot({
      openai: {
        "gpt-5.5": {
          status: "supported",
          source: "providers/openai/models/gpt-5.5.toml",
          overrides: [
            {
              id: "text.input.overrides[0]",
              field: "input",
              when: { type: "context", op: "gt", value: 1 },
              rates: { input: 1 },
            },
          ],
          multipliers: [],
        },
      },
    });
    expect(() => normalizeTemporalSnapshot(badCondition)).toThrow();
  });

  it("rejects a route that escapes the pinned provider/model namespace", () => {
    const invalid = makeSnapshot({
      openai: {
        "gpt-5.5": {
          status: "unsupported",
          source: "providers/openai/models/../../secret.toml",
          reason: "unsupported",
        },
      },
    });
    expect(() => normalizeTemporalSnapshot(invalid)).toThrow(/source/);
  });
});
