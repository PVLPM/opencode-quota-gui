import { describe, expect, it, vi } from "vitest";
import type { QuotaSnapshot, SettingsSnapshot } from "../src/contracts/dashboard.js";
import {
  copySettingsDiagnostics,
  settingsDiagnosticsFromSnapshots,
} from "../src/native/settings-copy-action.js";

describe("Native Settings diagnostics action", () => {
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
    expect(output).toContain("Quota: stale; 1 card; 1 error");
    expect(output).toContain("Configuration: issues (1 issue)");
    expect(output).toContain("Temporal: available; 1 provider; 1 discovered; peak 1");
    expect(output).not.toContain("SENTINEL");
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

  it("handles an unavailable clipboard without claiming success", async () => {
    const notify = vi.fn();
    await copySettingsDiagnostics(() => "safe", undefined, notify);
    expect(notify).toHaveBeenCalledExactlyOnceWith(
      "error",
      "Could not copy diagnostics. Check clipboard permissions and try again.",
    );
  });
});
