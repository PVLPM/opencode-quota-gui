import { describe, expect, it } from "vitest";

import {
  buildRefreshedSnapshot,
  keepRetiredModels,
} from "../scripts/refresh-modelsdev-pricing.mjs";

function snapshot(
  providers: Record<string, Record<string, Record<string, unknown>>>,
  catalog?: Record<string, string[]>,
) {
  return {
    _meta: {
      generatedAt: 1,
      providers: Object.keys(providers),
      source: "https://models.dev/api.json",
      units: "USD per 1M tokens",
    },
    providers,
    ...(catalog ? { catalog } : {}),
  };
}

describe("refresh-modelsdev-pricing keepRetiredModels", () => {
  it("keeps priced models that models.dev dropped, and models.dev prices win", () => {
    const fresh = snapshot({ anthropic: { "claude-new": { input: 1, output: 2 } } });
    const previous = snapshot({
      anthropic: {
        "claude-new": { input: 9, output: 9 },
        "claude-old": { input: 3, output: 15 },
      },
      xai: { "grok-old": { input: 2, output: 10 } },
    });

    const kept = keepRetiredModels(fresh, previous, ["anthropic", "xai"]);

    expect(kept).toEqual(["anthropic/claude-old", "xai/grok-old"]);
    expect(fresh.providers).toEqual({
      anthropic: {
        "claude-new": { input: 1, output: 2 },
        "claude-old": { input: 3, output: 15 },
      },
      xai: { "grok-old": { input: 2, output: 10 } },
    });
    expect(fresh._meta.providers).toEqual(["anthropic", "xai"]);
  });

  it("ignores providers outside the requested list and a missing previous file", () => {
    const fresh = snapshot({ openai: { "gpt-new": { input: 1, output: 2 } } });
    const previous = snapshot({ zai: { "glm-old": { input: 1, output: 1 } } });

    expect(keepRetiredModels(fresh, previous, ["openai"])).toEqual([]);
    expect(keepRetiredModels(fresh, null, ["openai"])).toEqual([]);
    expect(Object.keys(fresh.providers)).toEqual(["openai"]);
  });

  it("drops non-number prices from kept models", () => {
    const fresh = snapshot({ openai: { "gpt-new": { input: 1, output: 2 } } });
    const previous = {
      providers: {
        openai: {
          "gpt-text-price": { input: "3" },
          "gpt-mixed": { input: "3", output: 4, reasoning: "3" },
        },
      },
    };

    expect(keepRetiredModels(fresh, previous, ["openai"])).toEqual(["openai/gpt-mixed"]);
    expect(fresh.providers.openai).toEqual({
      "gpt-mixed": { output: 4 },
      "gpt-new": { input: 1, output: 2 },
    });
  });
});

describe("refresh-modelsdev-pricing catalog presence retention", () => {
  it("retains only models absent from the authoritative catalog", () => {
    const fresh = snapshot({ openai: { "keep-priced": { input: 2, output: 4 } } });
    const previous = snapshot({
      openai: {
        "keep-priced": { input: 1, output: 99 },
        "absent-retired": { input: 3, output: 15 },
        "present-unpriced": { input: 4, output: 8 },
        "present-malformed": { input: 5, output: 10 },
      },
    });
    const catalog = {
      openai: ["keep-priced", "present-unpriced", "present-malformed", "new-unpriced"],
    };

    expect(keepRetiredModels(fresh, previous, ["openai"], catalog)).toEqual([
      "openai/absent-retired",
    ]);
    expect(fresh.providers.openai).toEqual({
      "absent-retired": { input: 3, output: 15 },
      "keep-priced": { input: 2, output: 4 },
    });
  });

  it("treats providers missing from the catalog as unknown and retains them", () => {
    const fresh = snapshot({ openai: { "gpt-new": { input: 1, output: 2 } } });
    const previous = snapshot({
      openai: { "openai-old": { input: 3, output: 4 } },
      xai: { "grok-old": { input: 2, output: 10 } },
    });

    expect(keepRetiredModels(fresh, previous, ["openai", "xai"], { openai: ["gpt-new"] })).toEqual([
      "openai/openai-old",
      "xai/grok-old",
    ]);
    expect(fresh.providers).toEqual({
      openai: {
        "gpt-new": { input: 1, output: 2 },
        "openai-old": { input: 3, output: 4 },
      },
      xai: { "grok-old": { input: 2, output: 10 } },
    });
  });

  it("applies catalog retention when building the refreshed snapshot", () => {
    const api = {
      openai: {
        models: {
          repriced: { cost: { input: 2, output: 4 } },
          unpriced: { cost: {} },
          malformed: { cost: { input: "2" } },
        },
      },
    };
    const previous = snapshot({
      openai: {
        repriced: { input: 1, output: 2 },
        unpriced: { input: 4, output: 8 },
        malformed: { input: 5, output: 10 },
        retired: { input: 3, output: 15 },
      },
      xai: { "grok-old": { input: 2, output: 10 } },
    });

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, undefined);

    expect(built.providers.openai).toEqual({
      repriced: { input: 2, output: 4 },
      retired: { input: 3, output: 15 },
    });
    expect(built.providers.xai).toEqual({ "grok-old": { input: 2, output: 10 } });
    expect(new Set(keptModelIDs)).toEqual(new Set(["openai/retired", "xai/grok-old"]));
  });
});

describe("refresh-modelsdev-pricing buildRefreshedSnapshot", () => {
  it("refreshes every central provider by default and retains providers the API dropped", () => {
    const api = {
      openai: { models: { "gpt-new": { cost: { input: 1, output: 2 } } } },
      opencode: { models: { "big-pickle": { cost: { input: 3, output: 15 } } } },
    };
    const previous = snapshot({ xai: { "grok-old": { input: 4, output: 8 } } });

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, undefined);

    expect(Object.keys(built.providers)).toEqual(["openai", "opencode", "xai"]);
    expect(keptModelIDs).toEqual(["xai/grok-old"]);
    expect(built.providers.xai["grok-old"]).toEqual({ input: 4, output: 8 });
  });

  it("still refreshes only the explicit dynamic provider scope", () => {
    const api = {
      openai: { models: { "gpt-new": { cost: { input: 1, output: 2 } } } },
      opencode: { models: { "big-pickle": { cost: { input: 3, output: 15 } } } },
    };
    const previous = snapshot({ xai: { "grok-old": { input: 4, output: 8 } } });

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["openai"]);

    // Only openai was fetched; opencode is neither refreshed nor invented, and
    // the previous out-of-scope provider survives.
    expect(Object.keys(built.providers)).toEqual(["openai", "xai"]);
    expect(built.providers.xai["grok-old"]).toEqual({ input: 4, output: 8 });
  });

  it("refuses a scoped response that names none of the requested providers", () => {
    const previous = snapshot({ anthropic: { "claude-old": { input: 3, output: 15 } } });

    expect(() => buildRefreshedSnapshot({}, previous, ["anthropic"])).toThrow(
      "returned no priced models",
    );
  });

  it("accepts an all-unpriced scoped catalog and drops the stale scoped price", () => {
    const previous = snapshot({
      anthropic: { "claude-old": { input: 3, output: 15 } },
      xai: { "grok-old": { input: 4, output: 8 } },
    });

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(
      { anthropic: { models: { "claude-old": { cost: {} } } } },
      previous,
      ["anthropic"],
    );

    expect(built.providers.anthropic).toBeUndefined();
    expect(built.providers.xai).toEqual(previous.providers.xai);
    expect(built.catalog).toEqual({ anthropic: ["claude-old"] });
    expect(keptModelIDs).toEqual([]);
  });

  it("still refuses a full refresh when the response has no priced models", () => {
    const previous = snapshot({ anthropic: { "claude-old": { input: 3, output: 15 } } });

    for (const api of [
      {},
      { anthropic: { models: { "claude-old": { cost: {} } } } },
      { anthropic: { models: {} } },
    ]) {
      expect(() => buildRefreshedSnapshot(api, previous, undefined)).toThrow(
        "returned no priced models",
      );
    }
  });

  it("builds the models.dev snapshot and reports kept models", () => {
    const previous = snapshot({ anthropic: { "claude-old": { input: 3, output: 15 } } });
    const api = { anthropic: { models: { "claude-new": { cost: { input: 1, output: 2 } } } } };

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, ["anthropic"]);

    expect(keptModelIDs).toEqual(["anthropic/claude-old"]);
    expect(Object.keys(built.providers.anthropic)).toEqual(["claude-new", "claude-old"]);
  });

  it("preserves explicit context tiers in deterministic order and drops unsupported tiers", () => {
    const api = {
      openai: {
        models: {
          "gpt-6.1-terra": {
            cost: {
              input: 1,
              output: 5,
              cache_read: 0.05,
              cache_write: 1.25,
              reasoning: 1.5,
              tiers: [
                {
                  input: 4,
                  output: 18,
                  cache_read: 0.4,
                  reasoning: 11,
                  tier: { type: "context", size: 272_000 },
                },
                {
                  input: 2,
                  output: 7.5,
                  cache_read: 0.1,
                  cache_write: 2.5,
                  reasoning: 2.25,
                  tier: { type: "context", size: 200_000 },
                },
                {
                  input: 9,
                  output: 9,
                  tier: { type: "batch", size: 1_000 },
                },
                {
                  input: 9,
                  output: 9,
                  tier: { type: "context", size: 0 },
                },
              ],
              context_over_200k: { input: 2, output: 7.5 },
            },
          },
        },
      },
    };

    const { snapshot: built } = buildRefreshedSnapshot(api, null, ["openai"]);

    expect(built.providers.openai["gpt-6.1-terra"]).toEqual({
      input: 1,
      output: 5,
      cache_read: 0.05,
      cache_write: 1.25,
      reasoning: 1.5,
      tiers: [
        {
          input: 2,
          output: 7.5,
          cache_read: 0.1,
          cache_write: 2.5,
          reasoning: 2.25,
          tier: { type: "context", size: 200_000 },
        },
        {
          input: 4,
          output: 18,
          cache_read: 0.4,
          reasoning: 11,
          tier: { type: "context", size: 272_000 },
        },
      ],
    });
  });

  it("keeps context tiers on retired models", () => {
    const fresh = snapshot({ openai: { "gpt-new": { input: 1, output: 2 } } });
    const previous = snapshot({
      openai: {
        "gpt-retired": {
          input: 1,
          output: 5,
          reasoning: 2,
          tiers: [
            {
              input: 2,
              output: 7.5,
              reasoning: 3,
              tier: { type: "context", size: 272_000 },
            },
          ],
        },
      },
    });

    expect(keepRetiredModels(fresh, previous, ["openai"])).toEqual(["openai/gpt-retired"]);
    expect(fresh.providers.openai["gpt-retired"]).toEqual({
      input: 1,
      output: 5,
      reasoning: 2,
      tiers: [
        {
          input: 2,
          output: 7.5,
          reasoning: 3,
          tier: { type: "context", size: 272_000 },
        },
      ],
    });
  });
});

const UNION_ALPHA_COST = { input: 0, output: 0, cache_read: 0 };

describe("refresh-modelsdev-pricing scoped refresh retention", () => {
  it("takes current models.dev prices for the scoped provider", () => {
    const api = {
      openai: {
        models: {
          "gpt-current": { cost: { input: 2, output: 4 } },
          "gpt-fresh": { cost: { input: 1, output: 2 } },
        },
      },
    };
    const previous = snapshot({
      openai: {
        "gpt-current": { input: 9, output: 9 },
        "gpt-retired": { input: 3, output: 15 },
      },
      xai: { "grok-old": { input: 4, output: 8 } },
    });

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["openai"]);

    expect(built.providers.openai).toEqual({
      "gpt-current": { input: 2, output: 4 },
      "gpt-fresh": { input: 1, output: 2 },
      "gpt-retired": { input: 3, output: 15 },
    });
    expect(built.providers.xai).toEqual({ "grok-old": { input: 4, output: 8 } });
  });

  it("drops stale prices for scoped models the catalog lists as present but unpriced", () => {
    const api = {
      openai: {
        models: {
          priced: { cost: { input: 1, output: 2 } },
          "present-unpriced": { cost: {} },
        },
      },
    };
    const previous = snapshot({
      openai: {
        priced: { input: 9, output: 9 },
        "present-unpriced": { input: 4, output: 8 },
        retired: { input: 3, output: 15 },
      },
    });

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, ["openai"]);

    expect(built.providers.openai).toEqual({
      priced: { input: 1, output: 2 },
      retired: { input: 3, output: 15 },
    });
    expect(built.catalog.openai).toEqual(["present-unpriced", "priced"]);
    expect(keptModelIDs).toEqual(["openai/retired"]);
  });

  it("merges previous out-of-scope catalog entries and rebuilds the scoped catalog", () => {
    const api = {
      openai: {
        models: {
          "gpt-current": { cost: { input: 1, output: 2 } },
          "present-unpriced": { cost: {} },
        },
      },
      // Present in the response but outside the requested scope: this presence
      // must not become an authoritative catalog for these providers.
      opencode: { models: { "union-alpha": { cost: {} } } },
      "opencode-go": { models: { "union-alpha": { cost: {} } } },
    };
    const previous = snapshot(
      {
        openai: {
          "gpt-current": { input: 9, output: 9 },
          "present-unpriced": { input: 4, output: 8 },
          "gpt-retired": { input: 3, output: 15 },
        },
        opencode: {
          "union-alpha": UNION_ALPHA_COST,
          "big-pickle": { input: 0, output: 0, cache_read: 0, cache_write: 0 },
        },
        "opencode-go": { "union-alpha": UNION_ALPHA_COST },
      },
      {
        openai: ["gpt-current", "present-unpriced", "gpt-retired"],
        // Both retired union-alpha routes are absent from the saved catalog.
        opencode: ["big-pickle"],
        "opencode-go": [],
      },
    );

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, ["openai"]);

    expect(built.providers.openai).toEqual({
      "gpt-current": { input: 1, output: 2 },
      "gpt-retired": { input: 3, output: 15 },
    });
    expect(built.providers.opencode).toEqual(previous.providers.opencode);
    expect(built.providers["opencode-go"]).toEqual(previous.providers["opencode-go"]);
    // Scoped catalog is rebuilt from the response; out-of-scope entries are
    // preserved exactly and the retained retired prices stay uncatalogued.
    expect(built.catalog).toEqual({
      openai: ["gpt-current", "present-unpriced"],
      opencode: ["big-pickle"],
      "opencode-go": [],
    });
    expect(built._meta.providers).toEqual(["openai", "opencode", "opencode-go"]);
    expect(keptModelIDs).toEqual(["openai/gpt-retired"]);
  });

  it("copies out-of-scope provider objects without reinterpreting cost shape", () => {
    const api = {
      openai: { models: { current: { cost: { input: 1, output: 2 } } } },
    };
    const previous = snapshot({
      openai: { current: { input: 9, output: 9 } },
      opencode: {
        "union-alpha": UNION_ALPHA_COST,
        tiered: {
          input: 1,
          output: 2,
          reasoning: 3,
          cache_write: 4,
          tiers: [
            {
              input: 2,
              output: 4,
              cache_read: 1,
              cache_write: 2,
              tier: { type: "context", size: 200_000 },
            },
            // A normalization pass would sort and dedupe these tiers by size.
            {
              input: 2,
              output: 4,
              cache_read: 1,
              cache_write: 2,
              tier: { type: "context", size: 200_000 },
            },
          ],
        },
      },
    });

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["openai"]);

    expect(built.providers.opencode).toEqual(previous.providers.opencode);
    expect(built.providers.opencode.tiered.tiers).toHaveLength(2);
  });

  it("replaces a scoped catalog entry with an authoritative empty model list", () => {
    const previous = snapshot({}, { openai: ["retired-model"] });

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(
      { openai: { models: {} } },
      previous,
      ["openai"],
    );

    expect(built.providers).toEqual({});
    expect(built.catalog).toEqual({ openai: [] });
    expect(keptModelIDs).toEqual([]);
  });

  it("removes previous catalog entries for scoped providers the response no longer lists", () => {
    const api = {
      opencode: { models: { "big-pickle": { cost: { input: 1, output: 2 } } } },
    };
    const previous = snapshot(
      { opencode: { "big-pickle": { input: 9, output: 9 } } },
      {
        openai: ["gone"],
        opencode: ["old-model"],
        xai: ["grok-old"],
      },
    );

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["openai", "opencode"]);

    expect(built.catalog).toEqual({
      opencode: ["big-pickle"],
      xai: ["grok-old"],
    });
  });

  it("rejects malformed model maps for present scoped providers before writing", () => {
    const previous = snapshot(
      {
        openai: { "gpt-old": { input: 9, output: 9 } },
        anthropic: { "claude-old": { input: 3, output: 15 } },
      },
      {
        openai: ["gpt-old"],
        anthropic: ["claude-old"],
        xai: ["grok-old"],
      },
    );
    const before = structuredClone(previous);
    const validOpenai = {
      openai: { models: { "gpt-new": { cost: { input: 1, output: 2 } } } },
    };

    for (const malformedAnthropic of [
      { models: [] },
      { models: "not-a-map" },
      { models: null },
      {},
    ]) {
      expect(() =>
        buildRefreshedSnapshot({ ...validOpenai, anthropic: malformedAnthropic }, previous, [
          "openai",
          "anthropic",
        ]),
      ).toThrow(/malformed model map for anthropic/);
    }

    // The rejected build must not rewrite the previous catalog or prices.
    expect(previous).toEqual(before);
  });

  it("accepts a mixed scoped response with priced and authoritative empty model maps", () => {
    const api = {
      openai: { models: { "gpt-new": { cost: { input: 1, output: 2 } } } },
      anthropic: { models: {} },
    };
    const previous = snapshot(
      {},
      {
        openai: ["gpt-old"],
        anthropic: ["claude-old"],
      },
    );

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["openai", "anthropic"]);

    expect(built.catalog).toEqual({ anthropic: [], openai: ["gpt-new"] });
    expect(built.providers).toEqual({
      openai: { "gpt-new": { input: 1, output: 2 } },
    });
  });

  it("matches scoped provider ids exactly without splitting raw route ids", () => {
    const api = {
      opencode: { models: { "union-alpha": { cost: { input: 1, output: 1 } } } },
      "opencode-go": { models: { "union-alpha": { cost: { input: 2, output: 2 } } } },
    };
    const previous = snapshot({
      opencode: { "union-alpha": UNION_ALPHA_COST },
      "opencode-go": { "union-alpha": UNION_ALPHA_COST },
    });

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["opencode-go"]);

    expect(built.providers.opencode).toEqual(previous.providers.opencode);
    expect(built.providers["opencode-go"]).toEqual({ "union-alpha": { input: 2, output: 2 } });
  });

  it("keeps the unscoped refresh behavior that retains providers the API dropped", () => {
    const api = {
      openai: { models: { "gpt-new": { cost: { input: 1, output: 2 } } } },
    };
    const previous = snapshot(
      {
        openai: { "gpt-old": { input: 9, output: 9 } },
        opencode: { "union-alpha": UNION_ALPHA_COST },
        "opencode-go": { "union-alpha": UNION_ALPHA_COST },
      },
      {
        openai: ["gpt-old"],
        opencode: ["union-alpha"],
        "opencode-go": ["union-alpha"],
      },
    );

    const { snapshot: built, keptModelIDs } = buildRefreshedSnapshot(api, previous, undefined);

    expect(built.providers.openai).toEqual({
      "gpt-new": { input: 1, output: 2 },
      "gpt-old": { input: 9, output: 9 },
    });
    expect(built.providers.opencode).toEqual(previous.providers.opencode);
    expect(built.providers["opencode-go"]).toEqual(previous.providers["opencode-go"]);
    // An unscoped refresh rebuilds the catalog from the current API only.
    expect(built.catalog).toEqual({ openai: ["gpt-new"] });
    expect(keptModelIDs).toEqual([
      "openai/gpt-old",
      "opencode/union-alpha",
      "opencode-go/union-alpha",
    ]);
  });
});
