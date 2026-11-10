import { describe, expect, it, vi } from "vitest";
import type { QuotaSnapshot, SettingsSnapshot } from "../src/contracts/dashboard.js";
import {
  copySettingsDiagnostics,
  settingsDiagnosticsFromSnapshots,
} from "../src/native/settings-copy-action.js";

describe("Native Settings diagnostics action", () => {
  it("includes only safe operational aggregates from populated snapshots", () => {
    const quota = {
      stale: false,
      providers: {
        enabledProviders: ["provider-a", "provider-b"],
        cards: [
          { providerId: "provider-a", errors: [] },
          { providerId: "provider-a", errors: [{ message: "SENTINEL_RAW_ERROR" }] },
          { providerId: "provider-b", errors: [] },
        ],
      },
      temporal: {
        providers: [
          { discovered: true, phase: "peak", providerId: "SENTINEL_TEMPORAL_ID" },
          { discovered: false, phase: "offpeak", providerId: "SENTINEL_TEMPORAL_ID_2" },
        ],
      },
    } as QuotaSnapshot;
    const settings = {
      provenance: {
        "dashboard.enabled": { scope: "global" },
        "dashboard.port": { scope: "defaults" },
      },
      sources: { "dashboard.enabled": "C:\\SENTINEL\\config.json" },
      issues: [{ label: "SENTINEL_LABEL", key: "SENTINEL_KEY", message: "SENTINEL_ISSUE" }],
      pathLabel: "C:\\SENTINEL\\config.json",
    } as SettingsSnapshot;

    const output = settingsDiagnosticsFromSnapshots(quota, settings, false, {
      appVersion: "1.3.1",
      hostVersion: "2.4.0",
    });

    expect(output).toContain("Application version: 1.3.1");
    expect(output).toContain("Host version: 2.4.0");
    expect(output).toContain("Provider availability: partial (1/2 available); status partial");
    expect(output).toContain("Quota: partial; fresh; 2 providers; 3 cards; 1 error");
    expect(output).toContain("Configuration: files; issues (1 issue)");
    expect(output).not.toContain("Pricing:");
    expect(output).toContain(
      "Temporal: available; 2 providers; 1 discovered; peak 1, off-peak 1, mixed 0, unknown 0",
    );
    expect(output).not.toContain("SENTINEL");
    expect(output).not.toContain("config.json");
  });

  it("distinguishes known unavailable reads from snapshots that are merely missing", () => {
    const missing = settingsDiagnosticsFromSnapshots(undefined, undefined, false);
    expect(missing).toBe("Native Settings diagnostics");

    const untrustedPricing = settingsDiagnosticsFromSnapshots(undefined, undefined, false, {
      pricing: { source: "runtime", stale: false },
    } as never);
    expect(untrustedPricing).not.toContain("Pricing:");

    const unavailable = settingsDiagnosticsFromSnapshots(undefined, undefined, true, {
      quotaUnavailable: true,
      settingsUnavailable: true,
    });
    expect(unavailable).toContain("Quota: unavailable; stale");
    expect(unavailable).toContain("Configuration: unavailable");
    expect(unavailable).not.toContain("Error:");
  });

  it("fails closed when snapshot accessors are hostile", () => {
    const hostileQuota = Object.defineProperty({}, "providers", {
      get() {
        throw new Error("SENTINEL_RAW_EXCEPTION");
      },
    }) as QuotaSnapshot;
    const hostileSettings = Object.defineProperty({}, "issues", {
      get() {
        throw new Error("SENTINEL_SETTINGS_EXCEPTION");
      },
    }) as SettingsSnapshot;

    expect(() => settingsDiagnosticsFromSnapshots(hostileQuota, undefined, false)).not.toThrow();
    expect(() => settingsDiagnosticsFromSnapshots(undefined, hostileSettings, false)).not.toThrow();
    expect(settingsDiagnosticsFromSnapshots(hostileQuota, undefined, false)).toBe(
      "Native Settings diagnostics",
    );
    expect(settingsDiagnosticsFromSnapshots(undefined, hostileSettings, false)).toBe(
      "Native Settings diagnostics",
    );
  });

  it("projects existing snapshots without copying sensitive content", () => {
    const quota = {
      stale: true,
      providers: {
        cards: [
          {
            providerId: "SENTINEL_ID",
            errors: [{ message: "SENTINEL_ERROR" }],
            details: [{ label: "SENTINEL", value: "SENTINEL_TOKEN" }],
          },
        ],
      },
      temporal: {
        providers: [{ discovered: true, phase: "peak", providerId: "SENTINEL_TEMPORAL" }],
      },
    } as QuotaSnapshot;
    const settings = {
      pathLabel: "SENTINEL_PATH",
      issues: [{ message: "SENTINEL_ISSUE" }],
    } as SettingsSnapshot;
    const output = settingsDiagnosticsFromSnapshots(quota, settings, true);
    expect(output).toContain("Quota: error; stale; 1 provider; 1 card; 1 error");
    expect(output).toContain("Configuration: issues (1 issue)");
    expect(output).toContain("Temporal: available; 1 provider; 1 discovered; peak 1");
    expect(output).not.toContain("SENTINEL");
  });

  it("reports provider status from existing cards and never copies raw error text", () => {
    const quota = {
      stale: false,
      providers: {
        enabledProviders: ["openai", "anthropic", "copilot", "gemini", "SENTINEL_PRIVATE_PROVIDER"],
        cards: [
          {
            providerId: "openai",
            rows: [{ rowId: "quota-row", label: "quota" }],
            errors: [{ message: "SENTINEL_RAW_CREDENTIAL_ERROR", failureCategory: "credentials" }],
          },
          { providerId: "anthropic", rows: [], errors: [] },
          {
            providerId: "copilot",
            rows: [],
            errors: [{ message: "SENTINEL_DISCOVERY_ERROR", failureCategory: "discovery" }],
          },
          {
            providerId: "SENTINEL_PRIVATE_PROVIDER",
            rows: [],
            errors: [{ message: "SENTINEL_PRIVATE_MESSAGE", failureCategory: "provider_api" }],
          },
        ],
      },
    } as QuotaSnapshot;

    const output = settingsDiagnosticsFromSnapshots(quota, undefined, false);

    expect(output).toContain("- openai: partial; reasons credentials");
    expect(output).toContain("- anthropic: no_data; reasons no_data");
    expect(output).toContain("- copilot: error; reasons discovery");
    expect(output).toContain("- google-gemini-cli: unknown; reasons unknown");
    expect(output).not.toContain("SENTINEL_PRIVATE_PROVIDER");
    expect(output).not.toContain("SENTINEL");
  });

  it("marks a known provider with no errors and quota rows successful, but absent evidence unknown", () => {
    const quota = {
      stale: false,
      providers: {
        enabledProviders: ["openai", "anthropic"],
        cards: [{ providerId: "openai", rows: [{ rowId: "quota-row" }], errors: [] }],
      },
    } as QuotaSnapshot;

    const output = settingsDiagnosticsFromSnapshots(quota, undefined, false);

    expect(output).toContain("- openai: success");
    expect(output).toContain("- anthropic: unknown; reasons unknown");
  });

  it("copies once and reports success or a fixed failure without exposing errors", async () => {
    const notify = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    await copySettingsDiagnostics(() => "safe", write, notify);
    expect(write).toHaveBeenCalledExactlyOnceWith("safe");
    expect(notify).toHaveBeenLastCalledWith("success", "Diagnostics copied to clipboard.");
    write.mockRejectedValueOnce(new Error("SENTINEL_SECRET"));
    await copySettingsDiagnostics(() => "safe", write, notify);
    expect(notify).toHaveBeenLastCalledWith(
      "error",
      "Could not copy diagnostics. Check clipboard permissions and try again.",
    );
    expect(JSON.stringify(notify.mock.calls)).not.toContain("SENTINEL");
  });

  it("awaits asynchronous diagnostics collection before copying", async () => {
    const notify = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    await copySettingsDiagnostics(async () => "async-safe", write, notify);
    expect(write).toHaveBeenCalledExactlyOnceWith("async-safe");
    expect(notify).toHaveBeenCalledExactlyOnceWith("success", "Diagnostics copied to clipboard.");
  });

  it("handles an unavailable clipboard without claiming success", async () => {
    const notify = vi.fn();
    await copySettingsDiagnostics(() => "safe", undefined, notify);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "error",
      "Could not copy diagnostics. Check clipboard permissions and try again.",
    );
  });
});
