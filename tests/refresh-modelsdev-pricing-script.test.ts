import { describe, expect, it } from "vitest";

import {
  buildRefreshedSnapshot,
  keepRetiredModels,
} from "../scripts/refresh-modelsdev-pricing.mjs";

function snapshot(providers: Record<string, Record<string, Record<string, unknown>>>) {
  return {
    _meta: {
      generatedAt: 1,
      providers: Object.keys(providers),
      source: "https://models.dev/api.json",
      units: "USD per 1M tokens",
    },
    providers,
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

  it("still honors an explicit dynamic provider scope", () => {
    const api = {
      openai: { models: { "gpt-new": { cost: { input: 1, output: 2 } } } },
      opencode: { models: { "big-pickle": { cost: { input: 3, output: 15 } } } },
    };
    const previous = snapshot({ xai: { "grok-old": { input: 4, output: 8 } } });

    const { snapshot: built } = buildRefreshedSnapshot(api, previous, ["openai"]);

    expect(Object.keys(built.providers)).toEqual(["openai"]);
  });

  it("refuses a models.dev answer with no priced models instead of keeping everything", () => {
    const previous = snapshot({ anthropic: { "claude-old": { input: 3, output: 15 } } });

    expect(() => buildRefreshedSnapshot({}, previous, ["anthropic"])).toThrow(
      "returned no priced models",
    );
    expect(() =>
      buildRefreshedSnapshot({ anthropic: { models: { x: { cost: {} } } } }, previous, [
        "anthropic",
      ]),
    ).toThrow("returned no priced models");
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
