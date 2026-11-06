import { describe, expect, it } from "vitest";

import { createLoadConfigMeta } from "../src/lib/config.js";
import {
  getDashboardEnabledSetting,
  hasInvalidDashboardWebConfig,
  resolveDashboardWebEnabled,
} from "../src/lib/dashboard-web-policy.js";

describe("effective web dashboard policy", () => {
  it.each([
    [true, "2.0.16", true],
    [true, "2.1.4", true],
    [true, "2.2.0", true],
    [true, "2.2.1", true],
    [true, "2.3.0", true],
    [true, undefined, true],
    [false, "2.0.16", false],
    [false, "2.1.4", false],
    [false, "2.2.0", false],
    [false, undefined, false],
  ] as const)("explicit %j wins on host %j", (explicitEnabled, hostVersion, expected) => {
    expect(resolveDashboardWebEnabled({ explicitEnabled, hostVersion })).toBe(expected);
  });

  it.each([
    ["2.0.16", true],
    ["2.1.4", true],
    ["2.2.0", true],
    ["2.2.0-beta.1", true],
    ["2.2.1", false],
    ["2.2.5", false],
    ["2.3.0", false],
    ["2.2.1-beta.1", false],
  ] as const)("absent key on host %j defaults to %j", (hostVersion, expected) => {
    expect(resolveDashboardWebEnabled({ hostVersion })).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["garbage"],
    ["opencode latest"],
  ])("absent key with an unusable host version %j fails closed", (hostVersion) => {
    expect(resolveDashboardWebEnabled({ hostVersion })).toBe(false);
  });

  it("fails closed for malformed config even when the host predates 2.2.1", () => {
    expect(resolveDashboardWebEnabled({ hostVersion: "2.1.4", invalidConfig: true })).toBe(false);
  });

  it("reads explicit presence from the loader setting sources", () => {
    const meta = createLoadConfigMeta();
    expect(getDashboardEnabledSetting({ dashboard: { enabled: false } }, meta)).toBeUndefined();

    meta.settingSources["dashboard.enabled"] = "config.jsonc";
    expect(getDashboardEnabledSetting({ dashboard: { enabled: false } }, meta)).toBe(false);
    expect(getDashboardEnabledSetting({ dashboard: { enabled: true } }, meta)).toBe(true);
    expect(getDashboardEnabledSetting(undefined, meta)).toBe(false);
  });

  it("treats a malformed root or invalid dashboard.enabled as invalid", () => {
    const meta = createLoadConfigMeta();
    expect(hasInvalidDashboardWebConfig(meta)).toBe(false);

    meta.configIssues.push({ path: "config.jsonc", key: "$root", message: "malformed JSONC" });
    expect(hasInvalidDashboardWebConfig(meta)).toBe(true);

    const invalidKey = createLoadConfigMeta();
    invalidKey.configIssues.push({
      path: "config.jsonc",
      key: "dashboard.enabled",
      message: "expected boolean",
    });
    expect(hasInvalidDashboardWebConfig(invalidKey)).toBe(true);

    const unrelated = createLoadConfigMeta();
    unrelated.configIssues.push({
      path: "config.jsonc",
      key: "dashboard.port",
      message: "expected an integer between 1 and 65535",
    });
    expect(hasInvalidDashboardWebConfig(unrelated)).toBe(false);
  });
});
