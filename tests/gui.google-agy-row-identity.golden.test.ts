/**
 * Golden row identity for the existing Google AGY companion provider.
 *
 * The v1.4.0 provider work adds two new providers; the companion path must keep
 * emitting byte-identical row ids so persisted `dashboard.hiddenRows` choices
 * keep working. This test pins both halves of that id: the provider bucket row
 * key and the composed row id for the provider-scope card.
 */
import { describe, expect, it } from "vitest";

import { buildProviderCards } from "../src/gui/provider-cards.js";
import type { QuotaToastEntry } from "../src/lib/entries.js";
import { agyBucketRowKey } from "../src/providers/google-agy.js";

const NOW = Date.UTC(2026, 11, 2, 12, 0, 0);

/**
 * The account card id for the `account-1` companion login; a card hash of the
 * provider id and the account source id, never a raw account identifier.
 */
const GOLDEN_CARD_ID =
  "google-agy:a48c310e6638b1811e85fe8c5e962f846cbb8a92c81601872e2c68155fe616b5";

/** Companion families and windows, mapped exactly as the adapter maps them. */
const GOLDEN_ROWS = [
  {
    family: "Gemini Models",
    window: "weekly",
    windowLabel: "Weekly",
    rowKey: "named:Gemini Models weekly",
  },
  {
    family: "Gemini Models",
    window: "five_hour",
    windowLabel: "5h",
    rowKey: "named:Gemini Models five_hour",
  },
  {
    family: "Claude and GPT models",
    window: "weekly",
    windowLabel: "Weekly",
    rowKey: "named:Claude and GPT models weekly",
  },
  {
    family: "Claude and GPT models",
    window: "five_hour",
    windowLabel: "5h",
    rowKey: "named:Claude and GPT models five_hour",
  },
] as const;

function companionEntries(): QuotaToastEntry[] {
  return GOLDEN_ROWS.map((row) => ({
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      sourceId: "account-1",
    },
    name: `${row.family} (Google account) ${row.windowLabel}`,
    group: `AGY (Google account): ${row.family}`,
    label: `${row.windowLabel}:`,
    rowKey: agyBucketRowKey({ family: row.family, window: row.window }),
    percentRemaining: 100,
  }));
}

describe("google-agy companion row identity (golden)", () => {
  it("keeps the documented bucket row keys byte-identical", () => {
    for (const row of GOLDEN_ROWS) {
      expect(agyBucketRowKey({ family: row.family, window: row.window })).toBe(row.rowKey);
    }
  });

  it("composes the same row ids as before this provider work", () => {
    const cards = buildProviderCards({
      probes: [
        {
          providerId: "google-agy",
          result: {
            attempted: true,
            entries: companionEntries(),
            errors: [],
            accounts: [{ sourceId: "account-1", label: "Google account" }],
          },
        },
      ],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    });

    const card = cards[0];
    expect(card?.cardId).toBe(GOLDEN_CARD_ID);
    expect(card?.rows.map((row) => row.rowId)).toEqual(
      GOLDEN_ROWS.map((row) => `${GOLDEN_CARD_ID}#${row.rowKey}|quota:percent`),
    );
    expect(card?.rows.map((row) => row.rowId)).toEqual([
      `${GOLDEN_CARD_ID}#named:Gemini Models weekly|quota:percent`,
      `${GOLDEN_CARD_ID}#named:Gemini Models five_hour|quota:percent`,
      `${GOLDEN_CARD_ID}#named:Claude and GPT models weekly|quota:percent`,
      `${GOLDEN_CARD_ID}#named:Claude and GPT models five_hour|quota:percent`,
    ]);
  });

  it("keeps the companion declared controls unchanged", async () => {
    const { getQuotaProviderRegistration } = await import("../src/lib/provider-metadata.js");
    const registration = getQuotaProviderRegistration("google-agy");
    expect(registration?.id).toBe("google-agy");
    // The companion declares no optional Visibility rows, so no Settings control
    // can appear or disappear because of this change.
    expect(registration?.optionalVisibilityRows).toBeUndefined();
  });
});
