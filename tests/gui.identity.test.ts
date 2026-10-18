/**
 * P3B — card/row identity (design spec §8 R20, plan P3 step 1).
 *
 * Server-side hashing only: raw account identities are inputs, never outputs.
 * Row keys are typed semantics (metric + resultType/kind where rows differ) or
 * a provider-supplied stable `rowKey` — never a display label or an ordinal.
 */
import { describe, expect, it } from "vitest";

import {
  buildCardId,
  buildProviderScopeCardId,
  hashQuotaCardIdentity,
  PROVIDER_SCOPE_IDENTITY_KEY,
  rowIdForEntry,
  rowKeyForEntry,
} from "../src/gui/identity.js";
import type {
  AccountingMetadata,
  QuotaBooleanEntry,
  QuotaPercentEntry,
  QuotaQuantityEntry,
  QuotaToastEntry,
} from "../src/lib/entries.js";

const RAW_ACCOUNT_ID = "RAW-account-9000-abcdef";
const RAW_IDENTITY_KEY = "RAW-identity-0001-zyxwvu";

const TEST_ACCOUNTING: AccountingMetadata = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};

function percentEntry(overrides: Partial<QuotaPercentEntry> = {}): QuotaPercentEntry {
  return {
    kind: "percent",
    name: "Weekly",
    percentRemaining: 62.5,
    accounting: { ...TEST_ACCOUNTING },
    semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
    ...overrides,
  };
}

function booleanEntry(overrides: Partial<QuotaBooleanEntry> = {}): QuotaBooleanEntry {
  return {
    kind: "boolean",
    name: "Availability",
    value: true,
    accounting: { ...TEST_ACCOUNTING, resultType: "status" },
    semantic: { metric: { kind: "named", name: "Status" }, prominence: "primary" },
    ...overrides,
  };
}

function quantityEntry(overrides: Partial<QuotaQuantityEntry> = {}): QuotaQuantityEntry {
  return {
    kind: "quantity",
    name: "Remaining credits",
    quantity: { decimal: "12.50", unit: { kind: "currency", code: "USD" } },
    accounting: { ...TEST_ACCOUNTING, resultType: "spend" },
    semantic: {
      metric: { kind: "component", component: "remaining_credits" },
      prominence: "primary",
    },
    ...overrides,
  };
}

describe("gui identity — card hashing", () => {
  it("hashes providerId + identityKey deterministically into an opaque hex digest", () => {
    const digest = hashQuotaCardIdentity("anthropic", RAW_ACCOUNT_ID);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashQuotaCardIdentity("anthropic", RAW_ACCOUNT_ID)).toBe(digest);
    expect(hashQuotaCardIdentity("anthropic", RAW_IDENTITY_KEY)).not.toBe(digest);
    expect(hashQuotaCardIdentity("openai", RAW_ACCOUNT_ID)).not.toBe(digest);
    expect(digest).not.toContain(RAW_ACCOUNT_ID);
  });

  it("namespaces card ids by provider and never embeds the raw identity", () => {
    const cardId = buildCardId("anthropic", RAW_ACCOUNT_ID);
    expect(cardId).toBe(`anthropic:${hashQuotaCardIdentity("anthropic", RAW_ACCOUNT_ID)}`);
    expect(cardId.startsWith("anthropic:")).toBe(true);
    expect(cardId).not.toContain(RAW_ACCOUNT_ID);
    expect(buildCardId("openai", RAW_ACCOUNT_ID)).not.toBe(cardId);
    expect(buildCardId("anthropic", RAW_IDENTITY_KEY)).not.toBe(cardId);
  });

  it("gives the provider scope its own reserved identity key", () => {
    const scopeId = buildProviderScopeCardId("xai");
    expect(scopeId).toBe(buildCardId("xai", PROVIDER_SCOPE_IDENTITY_KEY));
    expect(scopeId).not.toBe(buildCardId("xai", RAW_ACCOUNT_ID));
    expect(scopeId).not.toBe(buildCardId("anthropic", PROVIDER_SCOPE_IDENTITY_KEY));
  });
});

describe("gui identity — row keys", () => {
  it("builds typed semantic keys with the resultType/kind discriminator", () => {
    expect(rowKeyForEntry(percentEntry())).toBe("window:week|quota:percent");
    expect(rowKeyForEntry(booleanEntry())).toBe("named:Status|status:boolean");
    expect(rowKeyForEntry(quantityEntry())).toBe("component:remaining_credits|spend:quantity");
  });

  it("uses the provider-supplied stable rowKey when no typed semantic exists", () => {
    const entry = percentEntry({
      semantic: undefined,
      rowKey: "window:five_hour",
    });
    expect(rowKeyForEntry(entry)).toBe("window:five_hour|quota:percent");
  });

  it("falls back to the aggregate key for rows with neither semantic nor rowKey", () => {
    const entry = percentEntry({ semantic: undefined });
    expect(rowKeyForEntry(entry)).toBe("aggregate|quota:percent");
  });

  it("is stable across display-label renames (name/label/group/sortPriority)", () => {
    const original = percentEntry({ name: "Weekly old", label: "Weekly:" });
    const renamed = percentEntry({
      name: "Weekly new",
      label: "Completely different:",
      group: "Other",
      sortPriority: 7,
    });
    expect(rowKeyForEntry(renamed)).toBe(rowKeyForEntry(original));
    expect(rowIdForEntry(buildCardId("anthropic", RAW_ACCOUNT_ID), renamed)).toBe(
      rowIdForEntry(buildCardId("anthropic", RAW_ACCOUNT_ID), original),
    );
  });

  it("distinguishes rows by resultType and entry kind where they differ", () => {
    const quota = percentEntry();
    const spend = percentEntry({ accounting: { ...TEST_ACCOUNTING, resultType: "spend" } });
    expect(rowKeyForEntry(spend)).not.toBe(rowKeyForEntry(quota));
    const asValue: QuotaToastEntry = {
      kind: "value",
      name: "Weekly",
      value: "ok",
      accounting: { ...TEST_ACCOUNTING },
      semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
    };
    expect(rowKeyForEntry(asValue)).not.toBe(rowKeyForEntry(quota));
  });

  it("composes rowId = cardId + '#' + rowKey", () => {
    const cardId = buildCardId("anthropic", RAW_ACCOUNT_ID);
    const entry = percentEntry();
    const rowId = rowIdForEntry(cardId, entry);
    expect(rowId).toBe(`${cardId}#${rowKeyForEntry(entry)}`);
    expect(rowId.startsWith(cardId)).toBe(true);
    expect(rowId).not.toContain(RAW_ACCOUNT_ID);
  });
});
