import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard.js";
import {
  DASHBOARD_EVENT_TOPICS,
  isCostedTokens,
  isDashboardEvent,
  isTokenStack,
  sumTokenStack,
} from "../src/contracts/guards.js";
import { buildRowKey, type CardId, composeRowId } from "../src/contracts/identity.js";
import {
  DEFAULT_RANGE_KEY,
  isRangeKey,
  planRangeBuckets,
  RANGE_KEYS,
  rangeBucketUnit,
  rangeWindow,
} from "../src/contracts/ranges.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function expectContiguous(buckets: { startMs: number; endMs: number }[]): void {
  expect(buckets.length).toBeGreaterThan(0);
  for (let index = 1; index < buckets.length; index++) {
    expect(buckets[index]?.startMs).toBe(buckets[index - 1]?.endMs);
  }
}

describe("GUI contract range vocabulary", () => {
  it("exposes the four frozen range keys and the 7d default", () => {
    expect(RANGE_KEYS).toEqual(["24h", "7d", "30d", "lifetime"]);
    expect(DEFAULT_RANGE_KEY).toBe("7d");
  });

  it("accepts only the frozen range keys", () => {
    expect(RANGE_KEYS.every((key) => isRangeKey(key))).toBe(true);
    expect(isRangeKey("1d")).toBe(false);
    expect(isRangeKey("LIFETIME")).toBe(false);
    expect(isRangeKey(null)).toBe(false);
    expect(isRangeKey(24)).toBe(false);
  });

  it("builds exact rolling windows [now - duration, now)", () => {
    expect(rangeWindow("24h", NOW)).toEqual({ sinceMs: NOW - DAY_MS, untilMs: NOW });
    expect(rangeWindow("7d", NOW)).toEqual({ sinceMs: NOW - 7 * DAY_MS, untilMs: NOW });
    expect(rangeWindow("30d", NOW)).toEqual({ sinceMs: NOW - 30 * DAY_MS, untilMs: NOW });
    expect(rangeWindow("lifetime", NOW)).toEqual({ untilMs: NOW });
  });

  it("uses hourly buckets for 24h and daily buckets for every other range", () => {
    expect(rangeBucketUnit("24h")).toBe("hour");
    expect(rangeBucketUnit("7d")).toBe("day");
    expect(rangeBucketUnit("30d")).toBe("day");
    expect(rangeBucketUnit("lifetime")).toBe("day");
  });

  it("clips a partial hour at each edge of the 24h window", () => {
    const buckets = planRangeBuckets("24h", NOW);

    expect(buckets).toHaveLength(25);
    expect(buckets[0]).toEqual({ startMs: NOW - DAY_MS, endMs: NOW - 23 * HOUR_MS - 30 * 60_000 });
    expect(buckets[1]).toEqual({
      startMs: NOW - 23 * HOUR_MS - 30 * 60_000,
      endMs: NOW - 22 * HOUR_MS - 30 * 60_000,
    });
    expect(buckets[buckets.length - 1]).toEqual({
      startMs: Date.parse("2026-10-18T10:00:00.000Z"),
      endMs: NOW,
    });
    expectContiguous(buckets);
  });

  it("renders exactly 24 hourly buckets when now sits on the hour", () => {
    const onHour = Date.parse("2026-10-18T10:00:00.000Z");
    const buckets = planRangeBuckets("24h", onHour);

    expect(buckets).toHaveLength(24);
    expect(buckets[0]).toEqual({ startMs: onHour - DAY_MS, endMs: onHour - 23 * HOUR_MS });
    expect(buckets[buckets.length - 1]).toEqual({ startMs: onHour - HOUR_MS, endMs: onHour });
    expectContiguous(buckets);
  });

  it("clips partial UTC days at the edges of the 7d and 30d windows", () => {
    const week = planRangeBuckets("7d", NOW);
    expect(week).toHaveLength(8);
    expect(week[0]).toEqual({
      startMs: NOW - 7 * DAY_MS,
      endMs: Date.parse("2026-10-12T00:00:00.000Z"),
    });
    expect(week[week.length - 1]).toEqual({
      startMs: Date.parse("2026-10-18T00:00:00.000Z"),
      endMs: NOW,
    });
    expectContiguous(week);

    const month = planRangeBuckets("30d", NOW);
    expect(month).toHaveLength(31);
    expect(month[0]).toEqual({
      startMs: NOW - 30 * DAY_MS,
      endMs: Date.parse("2026-09-19T00:00:00.000Z"),
    });
    expect(month[month.length - 1]).toEqual({
      startMs: Date.parse("2026-10-18T00:00:00.000Z"),
      endMs: NOW,
    });
    expectContiguous(month);
  });

  it("renders exact 7 and 30 day spans when now sits on a UTC midnight", () => {
    const midnight = Date.parse("2026-10-18T00:00:00.000Z");
    expect(planRangeBuckets("7d", midnight)).toHaveLength(7);
    expect(planRangeBuckets("30d", midnight)).toHaveLength(30);
  });

  it("zero-fills lifetime from the earliest activity with no fixed bucket cap", () => {
    const earliest = Date.parse("2026-09-03T05:00:00.000Z");
    const buckets = planRangeBuckets("lifetime", NOW, earliest);

    expect(buckets).toHaveLength(46);
    expect(buckets[0]).toEqual({
      startMs: Date.parse("2026-09-03T00:00:00.000Z"),
      endMs: Date.parse("2026-09-04T00:00:00.000Z"),
    });
    expect(buckets[buckets.length - 1]).toEqual({
      startMs: Date.parse("2026-10-18T00:00:00.000Z"),
      endMs: NOW,
    });
    expectContiguous(buckets);

    const longer = planRangeBuckets("lifetime", NOW, earliest - 10 * DAY_MS);
    expect(longer).toHaveLength(buckets.length + 10);
  });

  it("returns one current-UTC-day bucket for an empty lifetime", () => {
    expect(planRangeBuckets("lifetime", NOW)).toEqual([
      { startMs: Date.parse("2026-10-18T00:00:00.000Z"), endMs: NOW },
    ]);

    const midnight = Date.parse("2026-10-18T00:00:00.000Z");
    expect(planRangeBuckets("lifetime", midnight)).toEqual([
      { startMs: midnight, endMs: midnight },
    ]);
  });

  it("rejects a non-finite now instead of looping", () => {
    expect(() => planRangeBuckets("24h", Number.NaN)).toThrow(/finite/);
    expect(() => planRangeBuckets("lifetime", Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});

describe("GUI contract guards", () => {
  const stack = { input: 10, cacheRead: 3, cacheWrite: 4, output: 5, reasoning: 2 };
  const costed = {
    ...stack,
    total: 24,
    apiEquivalentCostUsd: 1.5,
    unpricedTokens: 0,
    unknownTokens: 0,
  };

  it("sums the five additive token categories", () => {
    expect(sumTokenStack(stack)).toBe(24);
  });

  it("accepts a valid TokenStack and rejects malformed values", () => {
    expect(isTokenStack(stack)).toBe(true);
    expect(isTokenStack({ ...stack, input: -1 })).toBe(false);
    expect(isTokenStack({ ...stack, output: Number.NaN })).toBe(false);
    expect(isTokenStack({ ...stack, reasoning: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isTokenStack({ ...stack, reasoning: "2" })).toBe(false);
    expect(isTokenStack({ input: 1, output: 2 })).toBe(false);
    expect(isTokenStack(null)).toBe(false);
    expect(isTokenStack([1, 2, 3, 4, 5])).toBe(false);
  });

  it("accepts a valid CostedTokens and rejects a total that contradicts the categories", () => {
    expect(isCostedTokens(costed)).toBe(true);
    expect(isCostedTokens({ ...costed, apiEquivalentCostUsd: null })).toBe(true);
    expect(isCostedTokens({ ...costed, total: 25 })).toBe(false);
    expect(isCostedTokens({ ...costed, apiEquivalentCostUsd: "1.5" })).toBe(false);
    expect(isCostedTokens({ ...costed, unpricedTokens: -1 })).toBe(false);
  });

  it("accepts only the three frozen SSE topics with an optional visibility scope", () => {
    expect(DASHBOARD_EVENT_TOPICS).toEqual([
      "quota.changed",
      "sessions.changed",
      "settings.changed",
    ]);
    expect(isDashboardEvent({ topic: "quota.changed", at: 123 })).toBe(true);
    expect(isDashboardEvent({ topic: "settings.changed", at: 123, scope: "visibility" })).toBe(
      true,
    );
    expect(isDashboardEvent({ topic: "other", at: 123 })).toBe(false);
    expect(isDashboardEvent({ topic: "quota.changed", at: "123" })).toBe(false);
    expect(isDashboardEvent({ topic: "quota.changed", at: 123, scope: "everything" })).toBe(false);
    expect(isDashboardEvent(null)).toBe(false);
  });

  it("freezes contract version 1", () => {
    expect(DASHBOARD_CONTRACT_VERSION).toBe(1);
  });
});

describe("GUI contract identity seam", () => {
  it("builds stable typed row keys and never a display label or ordinal", () => {
    expect(buildRowKey({ kind: "window", window: "day" })).toBe("window:day");
    expect(buildRowKey({ kind: "component", component: "total_balance" })).toBe(
      "component:total_balance",
    );
    expect(buildRowKey({ kind: "named", name: "gift-credits" })).toBe("named:gift-credits");
    expect(buildRowKey({ kind: "aggregate" })).toBe("aggregate");
    expect(buildRowKey({ kind: "explicit", key: "primary" })).toBe("primary");
  });

  it("rejects an empty explicit row key", () => {
    expect(() => buildRowKey({ kind: "explicit", key: "  " })).toThrow(/row key/);
    expect(() => buildRowKey({ kind: "named", name: "" })).toThrow(/row key/);
  });

  it("composes row ids as cardId#rowKey without hashing in contracts", () => {
    // SAFETY: CardId is a compile-time-only string brand; the literal below is the
    // exact id text asserted by this test.
    const cardId = "openai:deadbeef" as CardId;
    const rowId = composeRowId(cardId, buildRowKey({ kind: "window", window: "five_hour" }));
    expect(rowId).toBe("openai:deadbeef#window:five_hour");
  });

  it("keeps contracts free of Node imports and hashing", () => {
    const contractsDir = fileURLToPath(new URL("../src/contracts", import.meta.url));
    const files = readdirSync(contractsDir).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(join(contractsDir, file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']node:/);
      expect(source, file).not.toMatch(/createHash|createHmac|sha256|digest\(/i);
    }
  });
});
