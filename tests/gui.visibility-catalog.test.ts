import { describe, expect, it } from "vitest";
import {
  mergeVisibilityCatalog,
  readVisibilityCatalog,
  VISIBILITY_CATALOG_LIMITS,
  VISIBILITY_CATALOG_STORAGE_KEY,
  type VisibilityCard,
  visibilityCatalogEquals,
  writeVisibilityCatalog,
} from "../src/ui/visibility-catalog";

const ACCOUNT_A = `anthropic:${"a".repeat(64)}`;
const ACCOUNT_B = `anthropic:${"b".repeat(64)}`;
const PROVIDER_SCOPE = `anthropic:${"c".repeat(64)}`;

function card(overrides: Partial<VisibilityCard> = {}): VisibilityCard {
  const cardId = overrides.cardId ?? ACCOUNT_A;
  return {
    cardId,
    providerId: "anthropic",
    providerLabel: "Anthropic",
    planLabel: "Pro",
    accountLabel: "Personal",
    providerScopeId: PROVIDER_SCOPE,
    providerScopeHash: "c".repeat(64),
    rows: [{ id: `${cardId}#weekly`, label: "Weekly", info: "Quota help" }],
    ...overrides,
  };
}

function storage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
}

describe("card-centric visibility catalog v2", () => {
  it("round-trips separate card identities and owns rows without account suffixes", () => {
    const store = storage();
    const catalog = {
      cards: [card(), card({ cardId: ACCOUNT_B, accountLabel: "Work" })],
    };
    writeVisibilityCatalog(store, catalog);
    expect(VISIBILITY_CATALOG_STORAGE_KEY).toMatch(/\.v2$/u);
    expect(JSON.parse(store.getItem("") ?? "null").version).toBe(2);
    expect(readVisibilityCatalog(store)).toEqual(catalog);
    expect(readVisibilityCatalog(store).cards[0]?.rows[0]).not.toHaveProperty("accountLabel");
  });

  it("discards the old provider schema, even stored under the new key", () => {
    for (const value of [
      { version: 1, providers: [{ providerId: "anthropic", cardIds: ["a", "b"] }] },
      { version: 1, cards: [card()] },
      { version: 2, providers: [{ providerId: "anthropic" }] },
      { version: 3, cards: [card()] },
      null,
    ])
      expect(readVisibilityCatalog(storage(JSON.stringify(value)))).toEqual({ cards: [] });
    expect(readVisibilityCatalog(storage("{bad"))).toEqual({ cards: [] });
    expect(readVisibilityCatalog(undefined)).toEqual({ cards: [] });
    expect(
      readVisibilityCatalog({
        getItem: () => {
          throw new Error("Blocked");
        },
      }),
    ).toEqual({ cards: [] });
  });

  it("rejects malformed namespaces, hashes and foreign rows rather than inventing ids from labels", () => {
    const valid = card({
      rows: [
        { id: `${ACCOUNT_A}#weekly`, label: "Owned" },
        { id: `${ACCOUNT_B}#weekly`, label: "Foreign sibling" },
        { id: `openrouter:${"a".repeat(64)}#balance`, label: "Foreign provider" },
        { id: `${ACCOUNT_A}#`, label: "Empty key" },
        { id: `${ACCOUNT_A}#${"r".repeat(300)}`, label: "Oversized key" },
      ],
    });
    const malformed = [
      "Anthropic · Pro · Personal",
      "anthropic:account-a",
      `openrouter:${"a".repeat(64)}`,
      `anthropic:${"a".repeat(63)}`,
      `anthropic:${"g".repeat(64)}`,
      `${ACCOUNT_B}extra`,
      ` ${ACCOUNT_B}`,
      undefined,
    ].map((cardId) => ({ ...card(), cardId }));
    const store = storage(JSON.stringify({ version: 2, cards: [...malformed, valid] }));
    const expected = { cards: [{ ...valid, rows: [valid.rows[0]] }] };
    expect(readVisibilityCatalog(store)).toEqual(expected);
    writeVisibilityCatalog(store, { cards: [...malformed, valid] } as never);
    expect(readVisibilityCatalog(store)).toEqual(expected);
    expect(mergeVisibilityCatalog({ cards: [valid] }, { cards: malformed } as never)).toEqual(
      expected,
    );
  });

  it("merges only the same card and keeps cached siblings when a read is filtered", () => {
    const sibling = card({
      cardId: ACCOUNT_B,
      accountLabel: "Work",
      rows: [{ id: `${ACCOUNT_B}#weekly`, label: "Weekly" }],
    });
    const current = card({
      planLabel: "Max",
      accountLabel: "Renamed",
      rows: [{ id: `${ACCOUNT_A}#weekly`, label: "Current weekly" }],
    });
    const merged = mergeVisibilityCatalog({ cards: [current] }, { cards: [card(), sibling] });
    expect(merged.cards).toEqual([
      {
        ...current,
        rows: [{ id: `${ACCOUNT_A}#weekly`, label: "Current weekly", info: "Quota help" }],
      },
      sibling,
    ]);
    expect(merged.cards[0]?.rows).not.toContainEqual(sibling.rows[0]);
    expect(mergeVisibilityCatalog({ cards: [] }, merged)).toEqual(merged);
    expect(
      mergeVisibilityCatalog(
        { cards: [card({ planLabel: undefined, accountLabel: undefined })] },
        { cards: [card()] },
      ).cards[0],
    ).not.toHaveProperty("planLabel");
  });

  it("validates and bounds untrusted cards, rows, labels and duplicate identities", () => {
    const input = {
      version: 2,
      cards: [
        null,
        { ...card(), cardId: 7 },
        card({
          providerLabel: "P".repeat(400),
          planLabel: 7 as never,
          accountLabel: "A".repeat(400),
          rows: [
            {
              id: `${ACCOUNT_A}#valid`,
              label: "Weekly",
              info: "I".repeat(400),
              accountLabel: "not copied",
            } as never,
            { id: `${ACCOUNT_A}#valid`, label: "Duplicate" },
            { id: 7, label: "Bad" } as never,
          ],
        }),
        card({ accountLabel: "Duplicate" }),
      ],
    };
    const read = readVisibilityCatalog(storage(JSON.stringify(input)));
    expect(read.cards).toHaveLength(1);
    expect(read.cards[0]?.providerLabel).toHaveLength(VISIBILITY_CATALOG_LIMITS.textLength);
    expect(read.cards[0]?.accountLabel).toHaveLength(VISIBILITY_CATALOG_LIMITS.textLength);
    expect(read.cards[0]).not.toHaveProperty("planLabel");
    expect(read.cards[0]?.rows).toEqual([
      {
        id: `${ACCOUNT_A}#valid`,
        label: "Weekly",
        info: "I".repeat(VISIBILITY_CATALOG_LIMITS.textLength),
      },
    ]);
    const many = {
      cards: Array.from({ length: 4_100 }, (_, index) =>
        card({
          cardId: `anthropic:${index.toString(16).padStart(64, "0")}`,
          rows: [{ id: `anthropic:${index.toString(16).padStart(64, "0")}#quota`, label: "Quota" }],
        }),
      ),
    };
    const store = storage();
    writeVisibilityCatalog(store, many);
    const bounded = readVisibilityCatalog(store);
    expect(bounded.cards).toHaveLength(VISIBILITY_CATALOG_LIMITS.cards);
    expect(bounded.cards.reduce((sum, entry) => sum + entry.rows.length, 0)).toBe(
      VISIBILITY_CATALOG_LIMITS.rows,
    );
    expect(() =>
      writeVisibilityCatalog(
        {
          setItem: () => {
            throw new Error("Full");
          },
        },
        many,
      ),
    ).not.toThrow();
  });

  it("compares labels, card identity, row help and order before persisting", () => {
    const original = { cards: [card()] };
    expect(visibilityCatalogEquals(original, { cards: [card()] })).toBe(true);
    for (const changed of [
      card({ planLabel: "Max" }),
      card({ accountLabel: "Work" }),
      card({ cardId: "b" }),
      card({ rows: [{ id: `${ACCOUNT_A}#weekly`, label: "Weekly", info: "New" }] }),
    ])
      expect(visibilityCatalogEquals(original, { cards: [changed] })).toBe(false);
  });
});
