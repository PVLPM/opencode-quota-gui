import { describe, expect, it } from "vitest";
import { canonicalizeLocation, formatPath, parseLocation } from "../src/ui/routing";

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
});
