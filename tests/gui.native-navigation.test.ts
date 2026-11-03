import { describe, expect, it } from "vitest";
import { encodeAnalyticsEntityToken } from "../src/contracts/analytics-entity";
import { DEFAULT_RANGE_KEY } from "../src/contracts/ranges";
import {
  initialNativeLocation,
  navigateNative,
  replaceModelsDimension,
  setNativeRange,
} from "../src/native/navigation";
import {
  analyticsTabForRoute,
  isInternalDashboardHref,
  viewScopeForRoute,
} from "../src/ui/navigation-model";
import { formatPath } from "../src/ui/routing";

/**
 * Native navigation contract (Stage 5).
 *
 * The Desktop panel has no address bar or history stack. These tests pin the
 * window-local transitions that replace them: the same app paths and range
 * rules as the browser, with no storage or transport involvement. The panel
 * shell only applies the returned `Location` to its signal.
 */

const identity = { kind: "known" as const, id: "openai/gpt-5" };

describe("native navigation", () => {
  it("starts on Quota with the shared default range", () => {
    expect(initialNativeLocation()).toEqual({
      route: { name: "home" },
      range: DEFAULT_RANGE_KEY,
    });
  });

  it("parses every dashboard destination and keeps the current range", () => {
    const start = setNativeRange(initialNativeLocation(), "30d");
    const token = encodeAnalyticsEntityToken(identity);
    const cases = [
      ["/quota", { name: "home" }],
      ["/analytics?range=24h", { name: "analytics" }],
      ["/models?range=30d", { name: "models", dimension: "provider" }],
      ["/models?range=30d&group=model", { name: "models", dimension: "model" }],
      [
        `/model/${token}?range=30d&group=provider`,
        { name: "model", identity, modelsGroup: "provider" },
      ],
      [`/provider/${token}?range=30d`, { name: "provider", identity }],
      ["/project/proj%201?range=7d", { name: "project", projectId: "proj 1" }],
      ["/session/ses%201", { name: "session", sessionId: "ses 1" }],
    ] as const;

    for (const [path, route] of cases) {
      expect(navigateNative(start, path)?.route).toEqual(route);
    }

    // Only an explicit range in the path replaces the remembered one.
    expect(navigateNative(start, "/analytics")?.range).toBe("30d");
    expect(navigateNative(start, "/analytics?range=24h")?.range).toBe("24h");
    expect(navigateNative(start, "/session/ses%201")?.range).toBe("30d");
  });

  it("ignores an unknown or malformed path instead of leaving the dashboard", () => {
    const start = initialNativeLocation();
    expect(navigateNative(start, "/not-a-page")).toBeUndefined();
    expect(navigateNative(start, "/model/not-a-token")).toBeUndefined();
    expect(navigateNative(start, "/project/..")).toBeUndefined();
  });

  it("replaces the range without changing the route", () => {
    const detail = setNativeRange(
      {
        route: { name: "model", identity, modelsGroup: "model" },
        range: "7d",
      },
      "lifetime",
    );
    expect(detail).toEqual({
      route: { name: "model", identity, modelsGroup: "model" },
      range: "lifetime",
    });
  });

  it("switches the Models grouping only while on Models", () => {
    const models = {
      route: { name: "models", dimension: "provider" } as const,
      range: "7d" as const,
    };
    expect(replaceModelsDimension(models, "model")).toEqual({
      route: { name: "models", dimension: "model" },
      range: "7d",
    });

    const analytics = { route: { name: "analytics" } as const, range: "7d" as const };
    expect(replaceModelsDimension(analytics, "model")).toBe(analytics);
  });

  it("maps routes to the same section tabs and viewer scope as the browser", () => {
    const modelToken = encodeAnalyticsEntityToken(identity);
    const cases = [
      [{ name: "home" } as const, undefined, "quota" as const],
      [{ name: "analytics" } as const, "analytics" as const, "analytics" as const],
      [{ name: "project", projectId: "p" } as const, "analytics" as const, "analytics" as const],
      [{ name: "session", sessionId: "s" } as const, "analytics" as const, "analytics" as const],
      [{ name: "models", dimension: "provider" } as const, "models" as const, "analytics" as const],
      [
        { name: "model", identity, modelsGroup: "model" } as const,
        "models" as const,
        "analytics" as const,
      ],
      [{ name: "provider", identity } as const, "models" as const, "analytics" as const],
      [{ name: "settings" } as const, undefined, "quota" as const],
      [{ name: "not-found", path: `/model/${modelToken}` } as const, undefined, "quota" as const],
    ];

    for (const [route, tab, scope] of cases) {
      expect(analyticsTabForRoute(route)).toBe(tab);
      expect(viewScopeForRoute(route)).toBe(scope);
    }
  });

  it("recognizes only same-origin app paths as internal links", () => {
    for (const href of ["/quota", "/analytics?range=7d", "/model/k.abc?range=7d"]) {
      expect(isInternalDashboardHref(href)).toBe(true);
    }
    for (const href of [
      undefined,
      null,
      "",
      "#settings",
      "analytics",
      "https://example.com/quota",
      "//example.com/quota",
      "mailto:test@example.com",
    ]) {
      expect(isInternalDashboardHref(href)).toBe(false);
    }
  });

  it("formats the same internal paths the shared views emit", () => {
    expect(formatPath({ name: "analytics" }, "7d")).toBe("/analytics?range=7d");
    expect(formatPath({ name: "models", dimension: "model" }, "24h")).toBe(
      "/models?range=24h&group=model",
    );
    expect(formatPath({ name: "session", sessionId: "ses 1" }, "7d")).toBe("/session/ses%201");
  });
});
