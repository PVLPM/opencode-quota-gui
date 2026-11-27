import { describe, expect, it } from "vitest";
import { canonicalizeLocation, formatPath, parseLocation } from "../src/ui/routing";

describe("usage route", () => {
  it("defaults to the current window without consuming the analytics range", () => {
    const location = parseLocation("/usage", "30d");
    expect(location.route).toEqual({ name: "usage", usageRange: "current" });
    expect(location.range).toBe("30d");
    expect(formatPath(location.route, location.range)).toBe("/usage");
  });

  it.each([
    "current",
    "24h",
    "7d",
    "30d",
    "lifetime",
  ] as const)("round-trips the %s usage range on its own query", (range) => {
    const location = parseLocation(`/usage?range=${range}`, "30d");
    expect(location.route).toEqual({ name: "usage", usageRange: range });
    expect(location.range).toBe("30d");
    expect(formatPath(location.route, location.range)).toBe(
      range === "current" ? "/usage" : `/usage?range=${range}`,
    );
  });

  it("falls back to the current window for an invalid usage range", () => {
    expect(parseLocation("/usage?range=90d", "7d").route).toEqual({
      name: "usage",
      usageRange: "current",
    });
  });

  it("canonicalizes the usage path and range", () => {
    const result = canonicalizeLocation(
      { pathname: "/", search: "", hash: "#/usage?range=7d" },
      "30d",
    );
    expect(result.location).toEqual({ route: { name: "usage", usageRange: "7d" }, range: "30d" });
    expect(result.path).toBe("/usage?range=7d");
  });
});

describe("clean history route canonicalization", () => {
  it.each([
    "/project/.js",
    "/project/a.js%2F",
    "/session/.js",
    "/session/a.js%2F",
  ])("rejects asset-shaped resource path %s consistently with the server", (path) => {
    expect(parseLocation(path, "7d").route.name).toBe("not-found");
  });

  it.each([
    ["/", "30d", "/quota", "30d"],
    ["/#/analytics?range=7d", "30d", "/analytics?range=7d", "7d"],
    ["/#/project/a%2Fb?range=24h", "7d", "/project/a%2Fb?range=24h", "24h"],
    ["/#/session/ses%201?range=24h", "30d", "/session/ses%201", "24h"],
    [
      "/#/session/ses%201?view=individual&range=24h",
      "30d",
      "/session/ses%201?view=individual",
      "24h",
    ],
    ["/#/?range=lifetime", "7d", "/quota", "lifetime"],
    ["/analytics", "30d", "/analytics?range=30d", "30d"],
  ] as const)("canonicalizes %s without retaining hash state", (input, stored, path, range) => {
    const url = new URL(input, "http://localhost:4144");
    const result = canonicalizeLocation(url, stored);
    expect(result.path).toBe(path);
    expect(result.location.range).toBe(range);
    expect(result.path).not.toContain("#");
    expect(formatPath(result.location.route, result.location.range)).toBe(path);
  });

  it.each([
    "/project/%ZZ",
    "/project/a/extra",
    "/project//a",
    "/session/%00",
    "/quota/",
  ])("does not parse malformed route %s as a page", (path) => {
    expect(parseLocation(path, "7d").route.name).toBe("not-found");
  });

  it("round-trips the individual session view and drops it on browser back", () => {
    const individual = parseLocation("/session/ses%201?view=individual", "7d");
    expect(individual.route).toEqual({
      name: "session",
      sessionId: "ses 1",
      individual: true,
    });
    expect(formatPath(individual.route, individual.range)).toBe("/session/ses%201?view=individual");

    // Browser back returns to the plain session URL, which parses as the main chart.
    expect(parseLocation("/session/ses%201", "7d").route).toEqual({
      name: "session",
      sessionId: "ses 1",
    });
    expect(parseLocation("/session/ses%201?view=other", "7d").route).toEqual({
      name: "session",
      sessionId: "ses 1",
    });
  });
});
