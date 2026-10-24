import { describe, expect, it } from "vitest";

import { buildProviderCards } from "../src/gui/provider-cards.js";
import { formatQuotaCommand } from "../src/lib/quota-command-format.js";
import type { QuotaRenderData } from "../src/lib/quota-render-data.js";
import { formatQuotaRowsGrouped } from "../src/lib/toast-format-grouped.js";
import { buildCompactQuotaStatusLine } from "../src/lib/tui-compact-format.js";
import { buildSidebarQuotaPanelLines } from "../src/lib/tui-sidebar-format.js";

const data: QuotaRenderData = {
  entries: [
    {
      accounting: {
        resultType: "budget",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      name: "OpenRouter key limit",
      group: "OpenRouter",
      label: "Key limit:",
      metricLabel: "Key limit",
      percentRemaining: 80,
      right: "$2.00/$10.00",
    },
    {
      accounting: {
        resultType: "spend",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      },
      kind: "value",
      name: "OpenRouter spend",
      group: "OpenRouter",
      label: "Spend:",
      value: "$140.70",
    },
  ],
  errors: [],
};

describe("OpenRouter four-surface formatting", () => {
  it("shows the key limit and separate lifetime spend on command, toast, sidebar, and compact output", () => {
    const command = formatQuotaCommand({ ...data, generatedAtMs: 0 });
    const toast = formatQuotaRowsGrouped(data);
    const sidebar = buildSidebarQuotaPanelLines({
      data,
      config: { formatStyle: "allWindows", percentDisplayMode: "remaining" },
    }).join("\n");
    const compact = buildCompactQuotaStatusLine({
      data,
      percentDisplayMode: "remaining",
      maxWidth: 200,
    });

    for (const output of [command, toast, sidebar, compact]) {
      expect(output).toContain("OpenRouter");
      expect(output).toContain("Key limit");
      expect(output).not.toContain("Budget");
      expect(output).not.toContain("reset");
    }
    for (const output of [command, toast, sidebar]) {
      expect(output).toContain("Spend");
      expect(output).toContain("$140.70");
    }

    const cards = buildProviderCards({
      probes: [
        {
          providerId: "openrouter",
          result: { attempted: true, entries: data.entries, errors: [] },
        },
      ],
      preferences: { accountingDetail: "summary" },
      nowMs: 0,
    });
    expect(cards[0]?.rows.map((row) => row.label)).toEqual(["Key limit", "Spend"]);
  });

  it("renders plain alias account labels on the actual OpenRouter cards", () => {
    const accountKeyLimit = (sourceId: string, group: string) => ({
      accounting: {
        resultType: "budget" as const,
        acquisitionMethod: "remote_api" as const,
        ownership: "maintained" as const,
        authority: "provider_reported" as const,
        sourceId,
      },
      kind: "percent" as const,
      name: `${group} key limit`,
      group,
      label: "Key limit:",
      metricLabel: "Key limit",
      percentRemaining: 80,
      right: "$2.00/$10.00",
    });

    const cards = buildProviderCards({
      probes: [
        {
          providerId: "openrouter",
          result: {
            attempted: true,
            entries: [
              accountKeyLimit("row_work", "[OpenRouter Work]"),
              accountKeyLimit("row_personal", "[OpenRouter Personal]"),
            ],
            errors: [],
            accounts: [
              { sourceId: "row_work", label: "Work", active: true },
              { sourceId: "row_personal", label: "Personal", active: false },
            ],
          },
        },
      ],
      preferences: { accountingDetail: "summary" },
      nowMs: 0,
    });

    expect(cards.map((card) => card.accountLabel)).toEqual(["Work", "Personal"]);
    expect(cards.map((card) => card.providerLabel)).toEqual(["OpenRouter", "OpenRouter"]);
    expect(cards[0]?.rows.map((row) => row.label)).toEqual(["Key limit"]);
  });
});
