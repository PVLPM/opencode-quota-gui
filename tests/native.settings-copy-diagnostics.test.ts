import { describe, expect, it } from "vitest";
import {
  formatNativeSettingsCopyDiagnostics,
  projectNativeSettingsCopyDiagnostics,
} from "../src/native/settings-copy-diagnostics.js";

describe("Native Settings Copy diagnostics projection", () => {
  it("projects only validated operational summaries and formats them with fixed labels", () => {
    const diagnostics = projectNativeSettingsCopyDiagnostics({
      appVersion: "1.3.0",
      hostVersion: "2.4.1",
      providerAvailability: {
        enabledCount: 4,
        availableCount: 2,
        status: "partial",
      },
      quota: {
        source: "remote-api",
        status: "partial",
        stale: true,
        providerCount: 3,
        cardCount: 4,
        errorCount: 1,
      },
      configuration: { source: "files", status: "issues", issueCount: 2 },
      pricing: { source: "runtime", stale: true },
      temporal: {
        providers: [
          { discovered: true, phase: "peak" },
          { discovered: false, phase: "offpeak" },
          { discovered: true, phase: "unknown" },
        ],
      },
    });

    expect(diagnostics).toEqual({
      schemaVersion: 1,
      appVersion: "1.3.0",
      hostVersion: "2.4.1",
      providers: {
        enabledCount: 4,
        availableCount: 2,
        availability: "partial",
        status: "partial",
      },
      quota: {
        source: "remote-api",
        status: "partial",
        stale: true,
        providerCount: 3,
        cardCount: 4,
        errorCount: 1,
      },
      configuration: { source: "files", status: "issues", issueCount: 2 },
      pricing: { source: "runtime", status: "stale" },
      temporal: {
        status: "available",
        providerCount: 3,
        discoveredCount: 2,
        phases: { peak: 1, offpeak: 1, mixed: 0, unknown: 1 },
      },
    });

    expect(formatNativeSettingsCopyDiagnostics(diagnostics)).toBe(
      [
        "Native Settings diagnostics",
        "Application version: 1.3.0",
        "Host version: 2.4.1",
        "Provider availability: partial (2/4 available); status partial",
        "Quota: remote API; partial; stale; 3 providers; 4 cards; 1 error",
        "Configuration: files; issues (2 issues)",
        "Pricing: runtime; stale",
        "Temporal: available; 3 providers; 2 discovered; peak 1, off-peak 1, mixed 0, unknown 1",
      ].join("\n"),
    );
  });

  it("drops raw status details, freeform strings, identities, paths, and unknown fields", () => {
    const diagnostics = projectNativeSettingsCopyDiagnostics({
      appVersion: "1.3.0",
      providerAvailability: {
        enabledCount: 1,
        availableCount: 1,
        status: "success",
        providerId: "SENTINEL_PROVIDER_ID",
        accountLabel: "SENTINEL_ACCOUNT_LABEL",
      },
      quota: {
        source: "local-estimate",
        status: "success",
        stale: false,
        providerCount: 1,
        cardCount: 1,
        errorCount: 0,
        statusDetails: [
          { key: "SENTINEL_STATUS_KEY", value: "SENTINEL_STATUS_VALUE" },
          { key: "config_path", value: "C:\\SENTINEL\\private.json" },
        ],
        rawDetails: [{ key: "token", value: "SENTINEL_TOKEN" }],
        providerId: "SENTINEL_RAW_PROVIDER",
        endpoint: "https://SENTINEL_ENDPOINT.invalid/path",
        apiKey: "SENTINEL_CREDENTIAL",
        exception: "SENTINEL_EXCEPTION_TEXT",
      },
      configuration: {
        source: "defaults",
        status: "ready",
        issueCount: 0,
        path: "C:\\SENTINEL\\config.json",
        values: { secret: "SENTINEL_CONFIG_VALUE" },
        content: "SENTINEL_CONFIG_CONTENT",
      },
      pricing: {
        source: "bundled",
        stale: false,
        url: "https://SENTINEL_PRICING_ENDPOINT.invalid",
      },
      temporal: {
        providers: [
          {
            discovered: true,
            phase: "offpeak",
            providerId: "SENTINEL_TEMPORAL_PROVIDER",
            providerLabel: "SENTINEL_TEMPORAL_LABEL",
            modelId: "SENTINEL_MODEL_ID",
            reason: "SENTINEL_TEMPORAL_REASON",
            source: { url: "https://SENTINEL_TEMPORAL_SOURCE.invalid" },
          },
        ],
        statusDetails: "SENTINEL_TEMPORAL_DETAILS",
      },
      statusDetails: [{ key: "SENTINEL_TOP_STATUS", value: "SENTINEL_TOP_VALUE" }],
      configPath: "SENTINEL_TOP_PATH",
      credentials: "SENTINEL_TOP_CREDENTIAL",
      token: "SENTINEL_TOP_TOKEN",
      content: "SENTINEL_TOP_CONTENT",
    } as never);

    const forgedDto = {
      ...diagnostics,
      statusDetails: [{ key: "SENTINEL_FORMATTER_KEY", value: "SENTINEL_FORMATTER_VALUE" }],
      quota: {
        ...diagnostics.quota,
        path: "SENTINEL_FORMATTER_PATH",
        endpoint: "SENTINEL_FORMATTER_ENDPOINT",
      },
    };
    const serialized = `${JSON.stringify(diagnostics)}\n${formatNativeSettingsCopyDiagnostics(forgedDto as never)}`;
    for (const sentinel of [
      "SENTINEL_STATUS_KEY",
      "SENTINEL_STATUS_VALUE",
      "SENTINEL_TOKEN",
      "SENTINEL_PROVIDER_ID",
      "SENTINEL_ACCOUNT_LABEL",
      "SENTINEL_RAW_PROVIDER",
      "SENTINEL_ENDPOINT",
      "SENTINEL_CREDENTIAL",
      "SENTINEL_EXCEPTION_TEXT",
      "SENTINEL_CONFIG_VALUE",
      "SENTINEL_CONFIG_CONTENT",
      "SENTINEL_PRICING_ENDPOINT",
      "SENTINEL_TEMPORAL_PROVIDER",
      "SENTINEL_TEMPORAL_LABEL",
      "SENTINEL_MODEL_ID",
      "SENTINEL_TEMPORAL_REASON",
      "SENTINEL_TEMPORAL_SOURCE",
      "SENTINEL_TEMPORAL_DETAILS",
      "SENTINEL_TOP_STATUS",
      "SENTINEL_TOP_VALUE",
      "SENTINEL_TOP_PATH",
      "SENTINEL_TOP_CREDENTIAL",
      "SENTINEL_TOP_TOKEN",
      "SENTINEL_TOP_CONTENT",
      "SENTINEL_FORMATTER_KEY",
      "SENTINEL_FORMATTER_VALUE",
      "SENTINEL_FORMATTER_PATH",
      "SENTINEL_FORMATTER_ENDPOINT",
      "private.json",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("accepts only stable semantic versions and controlled values with bounded counts", () => {
    const diagnostics = projectNativeSettingsCopyDiagnostics({
      appVersion: "01.3.0",
      hostVersion: "C:\\Users\\SENTINEL\\host\\2.4.1",
      providerAvailability: {
        enabledCount: 1_000_001,
        availableCount: 1,
        status: "SENTINEL_PROVIDER_STATUS",
      },
      quota: {
        source: "https://SENTINEL_SOURCE.invalid",
        status: "SENTINEL_QUOTA_STATUS",
        stale: "SENTINEL_BOOLEAN",
        errorCount: -1,
      },
      configuration: {
        source: "C:\\SENTINEL\\config.json",
        status: "SENTINEL_CONFIG_STATUS",
        issueCount: 2.5,
      },
      pricing: { source: "SENTINEL_PRICING_SOURCE", stale: "false" },
      temporal: {
        providers: [
          { discovered: true, phase: "SENTINEL_TEMPORAL_PHASE" },
          { discovered: "true", phase: "peak" },
        ],
      },
      error: "SENTINEL_EXCEPTION_TEXT",
    } as never);

    expect(diagnostics).toEqual({ schemaVersion: 1 });
  });

  it("never turns a thrown exception into copied diagnostics", () => {
    const source = Object.defineProperty({}, "quota", {
      get() {
        throw new Error("SENTINEL_EXCEPTION_TEXT");
      },
    });

    expect(() => projectNativeSettingsCopyDiagnostics(source as never)).not.toThrow();
    const diagnostics = projectNativeSettingsCopyDiagnostics(source as never);
    expect(diagnostics).toEqual({ schemaVersion: 1 });
    expect(formatNativeSettingsCopyDiagnostics(diagnostics)).toBe("Native Settings diagnostics");
    expect(JSON.stringify(diagnostics)).not.toContain("SENTINEL_EXCEPTION_TEXT");

    const forgedDto = Object.defineProperty({ schemaVersion: 1 }, "quota", {
      get() {
        throw new Error("SENTINEL_FORMATTER_EXCEPTION_TEXT");
      },
    });
    expect(() => formatNativeSettingsCopyDiagnostics(forgedDto as never)).not.toThrow();
    expect(formatNativeSettingsCopyDiagnostics(forgedDto as never)).toBe(
      "Native Settings diagnostics",
    );
  });
});
