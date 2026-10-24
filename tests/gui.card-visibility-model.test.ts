import { describe, expect, it } from "vitest";
import {
  cardIdentityLabel,
  keyboardMovedCardOrder,
  reorderedCardOrder,
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
