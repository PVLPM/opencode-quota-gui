import { describe, expect, it } from "vitest";

import {
  decodeAnalyticsEntityToken,
  encodeAnalyticsEntityToken,
  encodeAnalyticsGroupQueryKey,
  isAnalyticsGroupQuery,
  UNKNOWN_ANALYTICS_ENTITY_TOKEN,
} from "../src/contracts/analytics-entity.js";
import type { AnalyticsGroupQuery } from "../src/contracts/dashboard.js";

const ROUND_TRIP_IDS = [
  "",
  " ",
  "  padded  ",
  "a/b",
  "100%",
  "what?",
  "a#b",
  "a|||b",
  "unknown",
  "assets/app.js",
  "app.js",
  "logo.svg",
  "C:\\dir\\file.js",
  "../escape",
  "模型/🤖",
  "a\u0000b",
  "\uD800",
  "k.unrelated",
  UNKNOWN_ANALYTICS_ENTITY_TOKEN,
];

describe("tagged analytics entity tokens", () => {
  it.each(ROUND_TRIP_IDS)("round-trips the exact known identity %j", (id) => {
    const token = encodeAnalyticsEntityToken({ kind: "known", id });
    expect(token).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(decodeAnalyticsEntityToken(token)).toEqual({ kind: "known", id });
  });

  it("keeps known-empty distinct from unknown", () => {
    const empty = encodeAnalyticsEntityToken({ kind: "known", id: "" });
    const unknown = encodeAnalyticsEntityToken({ kind: "unknown" });
    expect(empty).not.toBe(unknown);
    expect(decodeAnalyticsEntityToken(empty)).toEqual({ kind: "known", id: "" });
    expect(decodeAnalyticsEntityToken(unknown)).toEqual({ kind: "unknown" });
    expect(UNKNOWN_ANALYTICS_ENTITY_TOKEN).toBe(unknown);
  });

  it("keeps an id that literally spells the tag words known", () => {
    for (const id of ["u", "k.", "unknown"]) {
      const token = encodeAnalyticsEntityToken({ kind: "known", id });
      expect(token).not.toBe(UNKNOWN_ANALYTICS_ENTITY_TOKEN);
      expect(decodeAnalyticsEntityToken(token)).toEqual({ kind: "known", id });
    }
  });

  it.each([
    "",
    "x",
    "k",
    "K.",
    "u.",
    "unknown",
    "k.!!!",
    "k.a",
    "k.abc=",
    "k.abc/def",
    "k.abc def",
    "k.+",
  ])("rejects malformed token %j", (token) => {
    expect(decodeAnalyticsEntityToken(token)).toBeUndefined();
  });

  it("uses length-safe query keys that distinguish dimensions, filters and kinds", () => {
    const unfiltered: AnalyticsGroupQuery = { range: "7d", dimension: "model" };
    const knownEmpty: AnalyticsGroupQuery = {
      range: "7d",
      dimension: "model",
      filter: { dimension: "model", identity: { kind: "known", id: "" } },
    };
    const unknown: AnalyticsGroupQuery = {
      range: "7d",
      dimension: "model",
      filter: { dimension: "model", identity: { kind: "unknown" } },
    };
    const knownUnknownLiteral: AnalyticsGroupQuery = {
      range: "7d",
      dimension: "model",
      filter: { dimension: "model", identity: { kind: "known", id: "unknown" } },
    };
    const keys = new Set([
      encodeAnalyticsGroupQueryKey(unfiltered),
      encodeAnalyticsGroupQueryKey(knownEmpty),
      encodeAnalyticsGroupQueryKey(unknown),
      encodeAnalyticsGroupQueryKey(knownUnknownLiteral),
      encodeAnalyticsGroupQueryKey({ ...unfiltered, dimension: "provider" }),
      encodeAnalyticsGroupQueryKey({ ...unfiltered, range: "24h" }),
      encodeAnalyticsGroupQueryKey({
        ...unfiltered,
        filter: { dimension: "provider", identity: { kind: "unknown" } },
      }),
    ]);
    expect(keys.size).toBe(7);
  });

  it("validates group queries independently of filesystem route restrictions", () => {
    expect(isAnalyticsGroupQuery({ range: "lifetime", dimension: "provider" })).toBe(true);
    expect(
      isAnalyticsGroupQuery({
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: { kind: "known", id: "assets/app.js" } },
      }),
    ).toBe(true);
    expect(
      isAnalyticsGroupQuery({
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: { kind: "unknown" } },
      }),
    ).toBe(true);
    expect(
      isAnalyticsGroupQuery({
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: { kind: "known", id: "" } },
      }),
    ).toBe(true);

    expect(isAnalyticsGroupQuery(undefined)).toBe(false);
    expect(isAnalyticsGroupQuery({})).toBe(false);
    expect(isAnalyticsGroupQuery({ range: "1d", dimension: "model" })).toBe(false);
    expect(isAnalyticsGroupQuery({ range: "24h", dimension: "session" })).toBe(false);
    expect(
      isAnalyticsGroupQuery({
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: { kind: "missing" } },
      }),
    ).toBe(false);
    expect(
      isAnalyticsGroupQuery({
        range: "24h",
        dimension: "model",
        filter: { dimension: "provider", identity: { kind: "known", id: 7 } },
      }),
    ).toBe(false);
    expect(
      isAnalyticsGroupQuery({
        range: "24h",
        dimension: "model",
        filter: { dimension: "tool", identity: { kind: "unknown" } },
      }),
    ).toBe(false);
  });
});
