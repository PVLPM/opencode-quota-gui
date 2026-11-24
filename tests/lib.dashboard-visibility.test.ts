import { describe, expect, it } from "vitest";
import {
  effectiveHiddenRowIds,
  materializeLegacyHiddenRowsForCard,
} from "../src/contracts/row-visibility.js";
import { buildCardId, buildProviderScopeCardId, rowIdForEntry } from "../src/gui/identity.js";
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

describe("dashboard hiddenRows legacy aggregate resolution", () => {
  const quota = {
    resultType: "quota",
    acquisitionMethod: "remote_api",
    ownership: "maintained",
    authority: "provider_reported",
  } as const;

  function windowRowId(cardId: ReturnType<typeof buildCardId>, window: "five_hour" | "week") {
    return rowIdForEntry(cardId, {
      semantic: { metric: { kind: "window", window }, prominence: "primary" },
      accounting: quota,
    });
  }

  it("resolves a legacy aggregate id to the first emitted typed row of its card", () => {
    const cardId = buildCardId("synthetic", "account-1");
    const fiveHour = windowRowId(cardId, "five_hour");
    const weekly = windowRowId(cardId, "week");
    const legacy = `${cardId}#aggregate|quota:percent`;

    expect(effectiveHiddenRowIds([fiveHour, weekly], [legacy])).toEqual(new Set([fiveHour]));
    // The historical choice followed emission order, not a fixed window.
    expect(effectiveHiddenRowIds([weekly, fiveHour], [legacy])).toEqual(new Set([weekly]));
  });

  it("resolves a weekly-only card to its weekly row, not the absent 5h row", () => {
    // Golden case: the old eager migration wrote a `window:five_hour` id even
    // when Alibaba Token Plan emitted only Weekly, re-showing the saved hide.
    const cardId = buildCardId("alibaba-token-plan", "account-1");
    const weekly = windowRowId(cardId, "week");
    const fiveHour = windowRowId(cardId, "five_hour");
    const legacy = `${cardId}#aggregate|quota:percent`;

    const hidden = effectiveHiddenRowIds([weekly], [legacy]);
    expect(hidden.has(weekly)).toBe(true);
    expect(hidden.has(fiveHour)).toBe(false);
  });

  it("resolves an Ollama weekly-only legacy hide without inventing a Session row", () => {
    const cardId = buildCardId("ollama-cloud", "account-1");
    const weekly = windowRowId(cardId, "week");
    const legacy = `${cardId}#aggregate|quota:percent`;
    const hidden = effectiveHiddenRowIds([weekly], [legacy]);
    expect(hidden.has(weekly)).toBe(true);
    expect(hidden.has(`${cardId}#named:Session|quota:percent` as never)).toBe(false);
  });

  it("keeps an exact aggregate row id for a provider that still emits one", () => {
    const cardId = buildCardId("custom", "account-1");
    const exact = `${cardId}#aggregate|quota:percent`;
    expect(effectiveHiddenRowIds([exact], [exact]).has(exact)).toBe(true);
  });

  it("leaves unresolved and malformed legacy ids inert and never mutates input", () => {
    const cardId = buildCardId("chutes", "account-1");
    const legacy = `${cardId}#aggregate|quota:percent`;
    const malformed = `${cardId}#aggregate|`;
    const input = [legacy, malformed];
    expect(effectiveHiddenRowIds([], input)).toEqual(new Set(input));
    expect(input).toEqual([legacy, malformed]);
  });

  it("materializes the legacy id only on an explicit card toggle", () => {
    const cardId = buildCardId("synthetic", "account-1");
    const fiveHour = windowRowId(cardId, "five_hour");
    const weekly = windowRowId(cardId, "week");
    const otherCard = buildCardId("openai", "account-1");
    const otherRow = windowRowId(otherCard, "week");
    const legacy = `${cardId}#aggregate|quota:percent`;

    const materialized = materializeLegacyHiddenRowsForCard(
      cardId,
      [legacy, otherRow],
      [fiveHour, weekly],
    );
    expect(materialized).toEqual([fiveHour, otherRow]);
    // Idempotent: the typed id is already explicit.
    expect(materializeLegacyHiddenRowsForCard(cardId, materialized, [fiveHour, weekly])).toEqual([
      fiveHour,
      otherRow,
    ]);
  });

  it("hides every emitted shape of a declared control from one stable or alias id", () => {
    const primary = "card#window:five_hour|quota:percent" as never;
    const valueAlias = "card#window:five_hour|status:value" as never;
    const controls = [{ rowId: primary, aliases: [valueAlias] }];

    expect(effectiveHiddenRowIds([valueAlias], [primary], controls)).toEqual(
      new Set([primary, valueAlias]),
    );
    expect(effectiveHiddenRowIds([primary], [valueAlias], controls)).toEqual(
      new Set([primary, valueAlias]),
    );
    expect(effectiveHiddenRowIds([valueAlias], ["card#other"], controls)).toEqual(
      new Set(["card#other"]),
    );
  });

  it("materializes a weekly-only hide to Weekly and drops ids that no longer resolve", () => {
    const cardId = buildCardId("alibaba-token-plan", "account-1");
    const weekly = windowRowId(cardId, "week");
    const legacy = `${cardId}#aggregate|quota:percent`;

    expect(materializeLegacyHiddenRowsForCard(cardId, [legacy], [weekly])).toEqual([weekly]);
    expect(materializeLegacyHiddenRowsForCard(cardId, [legacy], [])).toEqual([]);
    // Other cards' legacy ids are untouched until their own card is toggled.
    const otherLegacy = `${buildCardId("synthetic", "account-1")}#aggregate|quota:percent`;
    expect(materializeLegacyHiddenRowsForCard(cardId, [legacy, otherLegacy], [weekly])).toEqual([
      weekly,
      otherLegacy,
    ]);
  });

  it("keeps a still-existing exact aggregate id unchanged on toggle", () => {
    const cardId = buildCardId("custom", "account-1");
    const exact = `${cardId}#aggregate|quota:percent`;
    expect(materializeLegacyHiddenRowsForCard(cardId, [exact], [exact])).toEqual([exact]);
  });
});
