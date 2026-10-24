import { describe, expect, it } from "vitest";

import { buildCardId, buildProviderScopeCardId } from "../src/gui/identity.js";
import {
  dashboardProviderScopeHash,
  legacyProviderIdForScopeCardId,
  normalizeLegacyDashboardHiddenCards,
} from "../src/lib/dashboard-visibility.js";

describe("dashboard hiddenCards legacy normalization", () => {
  it("pins the provider-scope hash to the GUI identity semantics", () => {
    expect(`openai:${dashboardProviderScopeHash("openai")}`).toBe(
      buildProviderScopeCardId("openai"),
    );
    expect(`synthetic-provider:${dashboardProviderScopeHash("synthetic-provider")}`).toBe(
      buildProviderScopeCardId("synthetic-provider"),
    );
  });

  it("converts a full legacy provider-scope card id to its provider id", () => {
    expect(legacyProviderIdForScopeCardId(buildProviderScopeCardId("opencode-go"))).toBe(
      "opencode-go",
    );
    expect(normalizeLegacyDashboardHiddenCards([buildProviderScopeCardId("openai")])).toEqual([
      "openai",
    ]);
  });

  it("preserves account card ids, bare hashes, unknown ids, and arbitrary hashes", () => {
    const account = buildCardId("openai", "account-1");
    const bareScopeHash = dashboardProviderScopeHash("openai");
    const arbitrary = `openai:${"a".repeat(64)}`;

    expect(
      normalizeLegacyDashboardHiddenCards([
        account,
        bareScopeHash,
        "unknown-hidden-card",
        arbitrary,
        "openai",
      ]),
    ).toEqual([account, bareScopeHash, "unknown-hidden-card", arbitrary, "openai"]);
    expect(legacyProviderIdForScopeCardId(arbitrary)).toBeUndefined();
  });

  it("dedupes by first occurrence after conversion and never mutates input", () => {
    const scope = buildProviderScopeCardId("openai");
    const input = [scope, "openai", buildCardId("openai", "account-1")];

    expect(normalizeLegacyDashboardHiddenCards(input)).toEqual([
      "openai",
      buildCardId("openai", "account-1"),
    ]);
    expect(input).toEqual([scope, "openai", buildCardId("openai", "account-1")]);
  });
});
