import { describe, expect, it } from "vitest";
import {
  cardIdentityLabel,
  isInheritedProviderHidden,
  keyboardMovedCardOrder,
  reorderedCardOrder,
  showCardKeepingKnownSiblingsHidden,
  toggleHiddenCard,
} from "../src/ui/settings-model";

describe("card identity and independent draft operations", () => {
  it.each([
    [
      { providerLabel: "OpenRouter", planLabel: "Credits", accountLabel: "Personal" },
      "OpenRouter · Credits · Personal",
    ],
    [{ providerLabel: "OpenRouter", accountLabel: "Personal" }, "OpenRouter · Personal"],
    [{ providerLabel: "OpenRouter", planLabel: "Credits" }, "OpenRouter · Credits"],
    [{ providerLabel: "OpenRouter" }, "OpenRouter"],
    [{ providerLabel: "OpenAI", accountLabel: "[OpenAI] (Plus)" }, "OpenAI · Plus"],
  ])("names only present identity parts: %j", (identity, expected) => {
    expect(cardIdentityLabel(identity)).toBe(expected);
  });

  it("toggles exactly one sibling while retaining every unknown id", () => {
    const hidden = ["unknown-legacy", "anthropic:a", "openrouter:a"];
    expect(toggleHiddenCard(hidden, "anthropic:b")).toEqual([...hidden, "anthropic:b"]);
    expect(toggleHiddenCard(hidden, "anthropic:a")).toEqual(["unknown-legacy", "openrouter:a"]);
    expect(toggleHiddenCard(hidden, "openrouter:a")).toEqual(["unknown-legacy", "anthropic:a"]);
    expect(hidden).toEqual(["unknown-legacy", "anthropic:a", "openrouter:a"]);
  });

  it("moves cards rather than providers and clamps keyboard moves without inventing ids", () => {
    const ids = ["anthropic:a", "openrouter:a", "anthropic:b", "openrouter:b"];
    expect(reorderedCardOrder(ids, "anthropic:b", 0)).toEqual([ids[2], ids[0], ids[1], ids[3]]);
    expect(keyboardMovedCardOrder(ids, "openrouter:a", 1)).toEqual([
      ids[0],
      ids[2],
      ids[1],
      ids[3],
    ]);
    expect(keyboardMovedCardOrder(ids, "anthropic:a", -1)).toEqual(ids);
    expect(reorderedCardOrder(ids, "not-known", 0)).toEqual(ids);
  });
});

describe("showing a card hidden by an inherited provider group", () => {
  const hash = (letter: string) => letter.repeat(64);
  const card = (
    cardId: string,
    providerId: string,
    providerScopeHash?: string,
  ): { cardId: string; providerId: string; providerScopeHash?: string } => ({
    cardId,
    providerId,
    ...(providerScopeHash === undefined ? {} : { providerScopeHash }),
  });

  const scope = card(`anthropic:${hash("a")}`, "anthropic", hash("a"));
  const personal = card(`anthropic:${hash("b")}`, "anthropic", hash("a"));
  const work = card(`anthropic:${hash("c")}`, "anthropic", hash("a"));
  const family = card(`anthropic:${hash("d")}`, "anthropic", hash("a"));
  const openrouter = card(`openrouter:${hash("e")}`, "openrouter", hash("e"));
  const catalog = [scope, personal, work, family, openrouter];

  it("turns a provider id group hide into exact hides for two known siblings", () => {
    expect(
      showCardKeepingKnownSiblingsHidden(["anthropic", "unknown-id"], scope, [
        scope,
        personal,
        work,
        openrouter,
      ]),
    ).toEqual(["unknown-id", personal.cardId, work.cardId]);
  });

  it("removes the selected exact id as well as both legacy markers and dedupes known siblings", () => {
    const hidden = ["anthropic", hash("a"), scope.cardId, personal.cardId, "unknown-id"];
    expect(showCardKeepingKnownSiblingsHidden(hidden, scope, catalog)).toEqual([
      personal.cardId,
      "unknown-id",
      work.cardId,
      family.cardId,
    ]);
  });

  it("removes a bare authoritative provider-scope hash when it is the only group marker", () => {
    expect(
      showCardKeepingKnownSiblingsHidden([hash("a"), "unknown-id"], personal, catalog),
    ).toEqual(["unknown-id", scope.cardId, work.cardId, family.cardId]);
  });

  it("takes the authoritative hash from a matching known card when the selected card omits it", () => {
    const selectedWithoutHash = card(scope.cardId, "anthropic");
    expect(
      showCardKeepingKnownSiblingsHidden(
        [hash("a"), hash("f"), "unknown-id"],
        selectedWithoutHash,
        [selectedWithoutHash, personal, work],
      ),
    ).toEqual([hash("f"), "unknown-id", personal.cardId, work.cardId]);
    expect(
      isInheritedProviderHidden(selectedWithoutHash, new Set([hash("a")]), [
        selectedWithoutHash,
        personal,
      ]),
    ).toBe(true);
  });

  it("preserves unrelated ids, other providers, and bare hashes the catalog cannot attribute", () => {
    const hidden = [
      "anthropic",
      "unknown-provider",
      openrouter.providerId,
      hash("e"),
      hash("f"),
      "unknown-id",
    ];
    expect(showCardKeepingKnownSiblingsHidden(hidden, scope, catalog)).toEqual([
      "unknown-provider",
      openrouter.providerId,
      hash("e"),
      hash("f"),
      "unknown-id",
      personal.cardId,
      work.cardId,
      family.cardId,
    ]);
  });

  it("leaves an exact version 2 hide as a plain show with no sibling changes", () => {
    expect(
      showCardKeepingKnownSiblingsHidden([personal.cardId, "unknown-id"], personal, catalog),
    ).toEqual(["unknown-id"]);
  });

  it("uses provider metadata rather than shared labels for a non-OpenCode provider", () => {
    const syntheticA = card("synthetic:a", "synthetic-provider");
    const syntheticB = card("synthetic:b", "synthetic-provider");
    const otherSameLabel = card("synthetic:other", "other-provider");
    expect(
      showCardKeepingKnownSiblingsHidden(
        ["synthetic-provider", "other-provider", "unknown-id"],
        syntheticA,
        [syntheticA, syntheticB, otherSameLabel],
      ),
    ).toEqual(["other-provider", "unknown-id", syntheticB.cardId]);
  });
});
