import { describe, expect, it } from "vitest";
import {
  mergeVisibilityCatalog,
  readVisibilityCatalog,
  VISIBILITY_CATALOG_LIMITS,
  VISIBILITY_CATALOG_STORAGE_KEY,
  type VisibilityCatalog,
  type VisibilityProvider,
  visibilityCatalogEquals,
  writeVisibilityCatalog,
} from "../src/ui/visibility-catalog";

function provider(overrides: Partial<VisibilityProvider> = {}): VisibilityProvider {
  return {
    providerId: "provider-1",
    providerLabel: "Provider One",
    accountLabels: ["Plus"],
    cardIds: ["provider-1#cardhash"],
    rows: [{ id: "provider-1#cardhash#window:weekly", label: "Weekly", accountLabel: "Plus" }],
    ...overrides,
  };
}

function memoryStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(VISIBILITY_CATALOG_STORAGE_KEY, initial);
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function decoded(storage: ReturnType<typeof memoryStorage>): unknown {
  return JSON.parse(storage.values.get(VISIBILITY_CATALOG_STORAGE_KEY) ?? "null");
}

describe("visibility catalog cache", () => {
  it("round-trips a valid catalog through storage", () => {
    const storage = memoryStorage();
    const catalog: VisibilityCatalog = {
      providers: [
        provider(),
        provider({
          providerId: "provider-2",
          providerLabel: "Provider Two",
          accountLabels: ["Team"],
          cardIds: ["provider-2#cardhash"],
          rows: [{ id: "provider-2#cardhash#window:monthly", label: "Monthly" }],
        }),
      ],
    };

    writeVisibilityCatalog(storage, catalog);
    expect(readVisibilityCatalog(storage)).toEqual(catalog);
  });

  it("reads malformed JSON, wrong versions, and wrong root shapes as an empty catalog", () => {
    for (const raw of [
      "{not json",
      "null",
      "[]",
      JSON.stringify({ version: 2, providers: [provider()] }),
      JSON.stringify({ version: 1, providers: "nope" }),
      JSON.stringify({ version: 1, providers: [null, 7, "x"] }),
    ]) {
      expect(readVisibilityCatalog(memoryStorage(raw))).toEqual({ providers: [] });
    }
    expect(readVisibilityCatalog(undefined)).toEqual({ providers: [] });
  });

  it("skips non-string ids and labels, and drops malformed optional account labels", () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: 1,
        providers: [
          { providerId: 7, providerLabel: "Bad provider" },
          {
            providerId: "valid",
            providerLabel: "Valid Provider",
            accountLabels: ["Plus", 5],
            cardIds: ["valid#card", null],
            rows: [
              { id: "valid#row-1", label: "Weekly", accountLabel: 42 },
              { id: 8, label: "Bad row" },
              { id: "valid#row-2", label: "Monthly" },
            ],
          },
        ],
      }),
    );

    expect(readVisibilityCatalog(storage)).toEqual({
      providers: [
        {
          providerId: "valid",
          providerLabel: "Valid Provider",
          accountLabels: ["Plus"],
          cardIds: ["valid#card"],
          rows: [
            { id: "valid#row-1", label: "Weekly" },
            { id: "valid#row-2", label: "Monthly" },
          ],
        },
      ],
    });
  });

  it("clamps oversized stored arrays, text and duplicate ids", () => {
    const storage = memoryStorage(
      JSON.stringify({
        version: 1,
        providers: Array.from({ length: 250 }, (_value, index) => ({
          providerId: `provider-${index}`,
          providerLabel: `${"P".repeat(300)}-${index}`,
          accountLabels: [`account-${index}`, `account-${index}`],
          cardIds: Array.from({ length: 20 }, (_card, card) => `card-${index}-${card}`),
          rows: Array.from({ length: 10 }, (_row, row) => ({
            id: `row-${index}-${row}`,
            label: "L".repeat(300),
            accountLabel: "A".repeat(300),
          })),
        })),
      }),
    );

    const catalog = readVisibilityCatalog(storage);
    expect(catalog.providers).toHaveLength(VISIBILITY_CATALOG_LIMITS.providers);
    const rows = catalog.providers.reduce((count, entry) => count + entry.rows.length, 0);
    const cardIds = catalog.providers.reduce((count, entry) => count + entry.cardIds.length, 0);
    expect(rows).toBe(VISIBILITY_CATALOG_LIMITS.rows);
    expect(cardIds).toBe(VISIBILITY_CATALOG_LIMITS.cardIds);
    for (const entry of catalog.providers) {
      expect(entry.providerLabel.length).toBeLessThanOrEqual(VISIBILITY_CATALOG_LIMITS.textLength);
      expect(entry.accountLabels).toHaveLength(1);
      for (const row of entry.rows) {
        expect(row.label.length).toBeLessThanOrEqual(VISIBILITY_CATALOG_LIMITS.textLength);
        expect(row.accountLabel?.length).toBeLessThanOrEqual(VISIBILITY_CATALOG_LIMITS.textLength);
      }
    }
  });

  it("bounds the catalog it writes as well as the one it reads", () => {
    const storage = memoryStorage();
    writeVisibilityCatalog(storage, {
      providers: Array.from({ length: 250 }, (_value, index) => ({
        providerId: `provider-${index}`,
        providerLabel: "P".repeat(300),
        accountLabels: ["account"],
        cardIds: Array.from({ length: 20 }, (_card, card) => `card-${index}-${card}`),
        rows: Array.from({ length: 10 }, (_row, row) => ({
          id: `row-${index}-${row}`,
          label: "L".repeat(300),
        })),
      })),
    });

    const stored = decoded(storage) as { providers: VisibilityProvider[] };
    expect(stored.providers).toHaveLength(VISIBILITY_CATALOG_LIMITS.providers);
    expect(stored.providers.reduce((count, entry) => count + entry.rows.length, 0)).toBe(
      VISIBILITY_CATALOG_LIMITS.rows,
    );
    expect(stored.providers[0]?.providerLabel.length).toBe(VISIBILITY_CATALOG_LIMITS.textLength);
  });

  it("keeps a cached provider that the filtered quota snapshot no longer contains", () => {
    const visible = provider();
    const hidden = provider({
      providerId: "hidden-provider",
      providerLabel: "Hidden Provider",
      accountLabels: ["Team"],
      cardIds: ["hidden-provider#cardhash"],
      rows: [
        { id: "hidden-provider#cardhash#window:weekly", label: "Weekly", accountLabel: "Team" },
      ],
    });

    expect(mergeVisibilityCatalog({ providers: [visible] }, { providers: [hidden] })).toEqual({
      providers: [visible, hidden],
    });
    // An empty current result is the normal state while the optional quota read
    // is unavailable: the cache alone still has to keep Settings configurable.
    expect(mergeVisibilityCatalog({ providers: [] }, { providers: [hidden] })).toEqual({
      providers: [hidden],
    });
  });

  it("lets current fields win while retaining cached ids, rows and account labels", () => {
    const merged = mergeVisibilityCatalog(
      {
        providers: [
          provider({
            providerLabel: "Current Name",
            accountLabels: ["Plus"],
            cardIds: ["current-card"],
            rows: [
              { id: "shared-row", label: "Current Weekly", accountLabel: "Plus" },
              { id: "current-row", label: "Current Monthly", accountLabel: "Plus" },
              { id: "accountless-row", label: "Current Accountless" },
            ],
          }),
        ],
      },
      {
        providers: [
          provider({
            providerLabel: "Cached Name",
            accountLabels: ["Plus", "Team"],
            cardIds: ["cached-card", "current-card"],
            rows: [
              { id: "shared-row", label: "Cached Weekly", accountLabel: "Team" },
              { id: "cached-row", label: "Cached Monthly", accountLabel: "Team" },
              { id: "accountless-row", label: "Cached Accountless", accountLabel: "Team" },
            ],
          }),
        ],
      },
    );

    expect(merged).toEqual({
      providers: [
        {
          providerId: "provider-1",
          providerLabel: "Current Name",
          accountLabels: ["Plus", "Team"],
          cardIds: ["current-card", "cached-card"],
          rows: [
            { id: "shared-row", label: "Current Weekly", accountLabel: "Plus" },
            { id: "current-row", label: "Current Monthly", accountLabel: "Plus" },
            { id: "accountless-row", label: "Current Accountless", accountLabel: "Team" },
            { id: "cached-row", label: "Cached Monthly", accountLabel: "Team" },
          ],
        },
      ],
    });
  });

  it("dedupes duplicate providers and repeated ids when reading", () => {
    const first = provider();
    const storage = memoryStorage(
      JSON.stringify({
        version: 1,
        providers: [
          first,
          {
            ...first,
            providerLabel: "Duplicate Provider",
            accountLabels: ["Plus", "Plus"],
            cardIds: ["provider-1#cardhash", "provider-1#cardhash"],
            rows: [
              { id: "provider-1#cardhash#window:weekly", label: "Weekly", accountLabel: "Plus" },
              { id: "provider-1#cardhash#window:weekly", label: "Duplicate Weekly" },
            ],
          },
        ],
      }),
    );

    expect(readVisibilityCatalog(storage)).toEqual({ providers: [first] });
  });

  it("compares catalogs structurally so only real changes are persisted", () => {
    const catalog: VisibilityCatalog = { providers: [provider()] };
    const same = JSON.parse(JSON.stringify(catalog)) as VisibilityCatalog;
    expect(visibilityCatalogEquals(catalog, same)).toBe(true);
    expect(
      visibilityCatalogEquals(catalog, {
        providers: [{ ...provider(), providerLabel: "Renamed" }],
      }),
    ).toBe(false);
    expect(
      visibilityCatalogEquals(catalog, {
        providers: [provider({ rows: [{ id: "other", label: "Other" }] })],
      }),
    ).toBe(false);
  });

  it("never throws when storage is unavailable or blocked", () => {
    const throwingReader = {
      getItem: () => {
        throw new Error("storage blocked");
      },
    };
    const throwingWriter = {
      setItem: () => {
        throw new Error("storage full");
      },
    };

    expect(readVisibilityCatalog(throwingReader)).toEqual({ providers: [] });
    expect(readVisibilityCatalog(undefined)).toEqual({ providers: [] });
    expect(() => writeVisibilityCatalog(throwingWriter, { providers: [provider()] })).not.toThrow();
    expect(() => writeVisibilityCatalog(undefined, { providers: [provider()] })).not.toThrow();
  });
});
