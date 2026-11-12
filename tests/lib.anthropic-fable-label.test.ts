import { describe, expect, it } from "vitest";

import { getAccountingEntryLabel } from "../src/lib/accounting-format.js";

function namedPercentLabel(metricName: string): string {
  return getAccountingEntryLabel({
    kind: "percent",
    name: "Claude Fable Weekly",
    label: "Fable:",
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    semantic: { metric: { kind: "named", name: metricName }, prominence: "primary" },
    percentRemaining: 98,
  } as never);
}

describe("Anthropic Fable row label", () => {
  it("shows exactly Fable for the Fable weekly metric", () => {
    expect(namedPercentLabel("Fable weekly")).toBe("Fable");
  });

  it("keeps the quota suffix for other named metrics", () => {
    expect(namedPercentLabel("Sonnet weekly")).toBe("Sonnet weekly quota");
  });
});
