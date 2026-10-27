import { describe, expect, it } from "vitest";
import {
  decodeAnalyticsEntityToken,
  encodeAnalyticsEntityToken,
} from "../src/contracts/analytics-entity";
import {
  canonicalizeLocation,
  formatPath,
  parseLocation,
  routeShowsRangeSelector,
  routeUsesRange,
} from "../src/ui/routing";

/**
 * Focused routing contract for the peer Models tab and its symmetric detail
 * pages. Identity travels only as the tagged entity token, so a raw id with a
 * slash, percent, hash or delimiter never collides with a real route segment.
 */

const IDS = ["", " ", "a/b", "100%", "a#b", "a?b", "a|||b", "unknown", "app.js", "模型/🤖"];

describe("Models and group detail routes", () => {
  it("parses and formats the peer Models route with its range", () => {
    expect(parseLocation("/models?range=24h", "7d")).toEqual({
      route: { name: "models", dimension: "model" },
      range: "24h",
    });
    expect(formatPath({ name: "models", dimension: "model" }, "24h")).toBe("/models?range=24h");
    expect(parseLocation("/models", "30d").range).toBe("30d");
  });

  it("preserves the Models grouping and detail origin without losing the range", () => {
    expect(parseLocation("/models?range=24h&group=provider", "7d")).toEqual({
      route: { name: "models", dimension: "provider" },
      range: "24h",
    });
    expect(formatPath({ name: "models", dimension: "provider" }, "24h")).toBe(
      "/models?range=24h&group=provider",
    );

    const identity = { kind: "known" as const, id: "model-alpha" };
    const token = encodeAnalyticsEntityToken(identity);
    expect(parseLocation(`/model/${token}?range=7d&group=provider`, "24h")).toEqual({
      route: { name: "model", identity, modelsGroup: "provider" },
      range: "7d",
    });
    expect(formatPath({ name: "model", identity, modelsGroup: "provider" }, "7d")).toBe(
      `/model/${token}?range=7d&group=provider`,
    );
    expect(parseLocation(`/model/${token}?range=7d&group=bogus`, "24h").route).toEqual({
      name: "model",
      identity,
    });

    const grouped = canonicalizeLocation(
      { pathname: "/models", search: "?range=24h&group=provider", hash: "" },
      "7d",
    );
    expect(grouped.location.route).toEqual({ name: "models", dimension: "provider" });
    expect(grouped.path).toBe("/models?range=24h&group=provider");
  });

  it.each(IDS)("round-trips the exact model identity %j", (id) => {
    const identity = { kind: "known" as const, id };
    const token = encodeAnalyticsEntityToken(identity);
    const path = `/model/${token}?range=7d`;
    expect(parseLocation(path, "24h")).toEqual({
      route: { name: "model", identity },
      range: "7d",
    });
    expect(formatPath({ name: "model", identity }, "7d")).toBe(path);
  });

  it.each(IDS)("round-trips the exact provider identity %j", (id) => {
    const identity = { kind: "known" as const, id };
    const token = encodeAnalyticsEntityToken(identity);
    const path = `/provider/${token}?range=lifetime`;
    expect(parseLocation(path, "7d")).toEqual({
      route: { name: "provider", identity },
      range: "lifetime",
    });
    expect(formatPath({ name: "provider", identity }, "lifetime")).toBe(path);
  });

  it("keeps unknown and known-empty identities distinct and navigable", () => {
    const unknownPath = formatPath({ name: "model", identity: { kind: "unknown" } }, "7d");
    const emptyPath = formatPath({ name: "model", identity: { kind: "known", id: "" } }, "7d");
    expect(unknownPath).toBe("/model/u?range=7d");
    expect(emptyPath).toBe("/model/k.?range=7d");
    expect(unknownPath).not.toBe(emptyPath);
    expect(parseLocation(unknownPath, "7d").route).toEqual({
      name: "model",
      identity: { kind: "unknown" },
    });
    expect(parseLocation(emptyPath, "7d").route).toEqual({
      name: "model",
      identity: { kind: "known", id: "" },
    });
  });

  it.each([
    "/model/",
    "/model/x",
    "/model/k.abc=",
    "/model/k.!!!",
    "/model/u.",
    "/provider/unknown",
    "/model/a/b",
    "/models/extra",
  ])("does not treat malformed identity route %s as a page", (path) => {
    expect(parseLocation(path, "7d").route.name).toBe("not-found");
  });

  it("keeps the range selector on Models and both details while Session stays range-free", () => {
    for (const route of [
      { name: "models" as const, dimension: "model" as const },
      { name: "model" as const, identity: { kind: "known" as const, id: "x" } },
      { name: "provider" as const, identity: { kind: "known" as const, id: "x" } },
    ]) {
      expect(routeUsesRange(route)).toBe(true);
      expect(routeShowsRangeSelector(route)).toBe(true);
    }
    expect(routeUsesRange({ name: "session", sessionId: "a" })).toBe(false);
    expect(routeShowsRangeSelector({ name: "session", sessionId: "a" })).toBe(false);
    expect(formatPath({ name: "session", sessionId: "ses 1" }, "7d")).toBe("/session/ses%201");
  });

  it("canonicalizes Models detail URLs and preserves a remembered Session range", () => {
    const identity = { kind: "known" as const, id: "a/b" };
    const path = formatPath({ name: "model", identity }, "30d");
    const canonical = canonicalizeLocation(
      { pathname: path.split("?")[0] ?? "", search: "?range=30d", hash: "" },
      "7d",
    );
    expect(canonical.location).toEqual({ route: { name: "model", identity }, range: "30d" });
    expect(canonical.path).toBe(path);
    expect(decodeAnalyticsEntityToken(path.split("/")[2]?.split("?")[0] ?? "")).toEqual(identity);

    const session = canonicalizeLocation(
      { pathname: "/session/ses%201", search: "", hash: "" },
      "7d",
    );
    expect(session.path).toBe("/session/ses%201");
    expect(session.location.range).toBe("7d");
  });
});
