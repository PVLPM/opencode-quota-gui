import { describe, expect, it } from "vitest";

import { orderCardsByPreference } from "../src/contracts/card-order.js";

interface TestCard {
  cardId: string;
  providerId: string;
}

function card(cardId: string, providerId: string): TestCard {
  return { cardId, providerId };
}

const GO_A = card("opencode-go:go-a", "opencode-go");
const GO_B = card("opencode-go:go-b", "opencode-go");
const OPENAI_A = card("openai:openai-a", "openai");
const SYNTHETIC_A = card("synthetic-provider:synthetic-a", "synthetic-provider");

describe("orderCardsByPreference", () => {
  it("always returns a fresh array, even without preferences", () => {
    const cards = [GO_A, OPENAI_A];

    const ordered = orderCardsByPreference(cards);

    expect(ordered).not.toBe(cards);
    expect(ordered).toEqual(cards);
  });

  it("puts listed cards first and appends unlisted cards in input order", () => {
    const cards = [GO_A, OPENAI_A, GO_B, SYNTHETIC_A];

    const ordered = orderCardsByPreference(cards, [GO_B.cardId, OPENAI_A.cardId]);

    expect(ordered.map((entry) => entry.cardId)).toEqual([
      GO_B.cardId,
      OPENAI_A.cardId,
      GO_A.cardId,
      SYNTHETIC_A.cardId,
    ]);
  });

  it("ignores unknown and duplicate card preference ids", () => {
    const cards = [GO_A, OPENAI_A, GO_B];

    const ordered = orderCardsByPreference(cards, [
      "unknown-card",
      OPENAI_A.cardId,
      OPENAI_A.cardId,
      GO_A.cardId,
    ]);

    expect(ordered.map((entry) => entry.cardId)).toEqual([
      OPENAI_A.cardId,
      GO_A.cardId,
      GO_B.cardId,
    ]);
  });

  it("treats a non-empty all-unknown card order as authoritative, not as legacy fallback", () => {
    const cards = [GO_A, OPENAI_A, GO_B, SYNTHETIC_A];

    const ordered = orderCardsByPreference(
      cards,
      ["unknown-card"],
      ["synthetic-provider", "openai"],
    );

    expect(ordered.map((entry) => entry.cardId)).toEqual(cards.map((entry) => entry.cardId));
  });

  it("uses the legacy provider order only when cardOrder is absent or empty", () => {
    const cards = [GO_A, OPENAI_A, GO_B, SYNTHETIC_A];

    for (const cardOrder of [undefined, []]) {
      const ordered = orderCardsByPreference(cards, cardOrder, [
        "synthetic-provider",
        "openai",
        "openai",
        "unknown-provider",
      ]);

      expect(ordered.map((entry) => entry.cardId)).toEqual([
        SYNTHETIC_A.cardId,
        OPENAI_A.cardId,
        GO_A.cardId,
        GO_B.cardId,
      ]);
    }
  });

  it("keeps the input order when the legacy provider order has no known provider", () => {
    const cards = [GO_A, OPENAI_A, GO_B];

    const ordered = orderCardsByPreference(cards, [], ["unknown-provider"]);

    expect(ordered.map((entry) => entry.cardId)).toEqual(cards.map((entry) => entry.cardId));
  });

  it("never mutates the input array", () => {
    const cards = [GO_A, OPENAI_A, GO_B];
    const original = [...cards];

    orderCardsByPreference(cards, [GO_B.cardId], ["openai"]);

    expect(cards).toEqual(original);
  });
});
