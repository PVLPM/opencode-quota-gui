import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-storage.js", () => {
  class SessionNotFoundError extends Error {
    sessionID: string;
    checkedPath: string;

    constructor(sessionID: string, checkedPath: string) {
      super(`Session not found: ${sessionID}`);
      this.name = "SessionNotFoundError";
      this.sessionID = sessionID;
      this.checkedPath = checkedPath;
    }
  }

  return {
    getOpenCodeDbPath: vi.fn(() => "/tmp/opencode.db"),
    iterAssistantMessages: vi.fn(),
    iterAssistantMessagesForSession: vi.fn(),
    iterAssistantMessagesForSessions: vi.fn(),
    readAllSessionsIndex: vi.fn(),
    SessionNotFoundError,
  };
});

const PRICED_EDGE_PROVIDER = "pair-labs";
const PRICED_EDGE_MODEL = "alpha|||beta";
const PARTIAL_PROVIDER = "partial-labs";
const PARTIAL_MODEL = "input-only";
const FREE_PROVIDER = "free-labs";
const FREE_MODEL = "zero-cost";

vi.mock("../src/lib/modelsdev-pricing.js", () => ({
  hasCost: vi.fn(
    (providerID: string, modelID: string) =>
      (providerID === "openai" && modelID === "gpt-5") ||
      (providerID === PRICED_EDGE_PROVIDER && modelID === PRICED_EDGE_MODEL) ||
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      (providerID === FREE_PROVIDER && modelID === FREE_MODEL),
  ),
  hasProvider: vi.fn(
    (providerID: string) =>
      providerID === "openai" ||
      providerID === "unpriced-labs" ||
      providerID === PRICED_EDGE_PROVIDER ||
      providerID === PARTIAL_PROVIDER ||
      providerID === FREE_PROVIDER,
  ),
  hasCatalogModel: vi.fn(
    (providerID: string, modelID: string) => providerID === "catalog-labs" && modelID === "gpt-5",
  ),
  hasModel: vi.fn(
    (providerID: string, modelID: string) =>
      (providerID === "openai" && modelID === "gpt-5") ||
      (providerID === "unpriced-labs" && modelID === "mystery-1") ||
      (providerID === PRICED_EDGE_PROVIDER && modelID === PRICED_EDGE_MODEL) ||
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      (providerID === FREE_PROVIDER && modelID === FREE_MODEL),
  ),
  isModelsDevProviderId: vi.fn(
    (providerID: string) =>
      providerID === "openai" ||
      providerID === "unpriced-labs" ||
      providerID === PRICED_EDGE_PROVIDER ||
      providerID === PARTIAL_PROVIDER ||
      providerID === FREE_PROVIDER,
  ),
  listProvidersForModelId: vi.fn((modelID: string) => (modelID === "gpt-5" ? ["openai"] : [])),
  lookupCost: vi.fn((providerID: string, modelID: string) => {
    if (providerID === "openai" && modelID === "gpt-5")
      return { input: 1, output: 1, reasoning: 1, cache_read: 1, cache_write: 1 };
    if (providerID === PRICED_EDGE_PROVIDER && modelID === PRICED_EDGE_MODEL)
      return { input: 1, output: 1, reasoning: 1, cache_read: 1, cache_write: 1 };
    if (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) return { input: 2 };
    if (providerID === FREE_PROVIDER && modelID === FREE_MODEL) return { input: 0, output: 0 };
    return null;
  }),
}));

vi.mock("../src/lib/cursor-pricing.js", () => ({
  isCursorModelId: vi.fn(() => false),
  isCursorProviderId: vi.fn(() => false),
  lookupCursorLocalCost: vi.fn(() => null),
  resolveCursorModel: vi.fn(() => ({ kind: "unknown" })),
}));

vi.mock("../src/lib/token-cost.js", () => ({
  tokenRateCoverage: vi.fn(
    (
      rates: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache_read?: number;
        cache_write?: number;
      },
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache_read: number;
        cache_write: number;
      },
    ) => {
      const rateFor = (bucket: keyof typeof tokens): number | undefined => {
        switch (bucket) {
          case "input":
            return rates.input;
          case "output":
            return rates.output;
          case "cache_read":
            return rates.cache_read ?? rates.input;
          case "cache_write":
            return rates.cache_write ?? rates.input;
          case "reasoning":
            return rates.reasoning ?? rates.output;
        }
      };
      let pricedTokens = 0;
      let unpricedTokens = 0;
      for (const bucket of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
        const count = tokens[bucket];
        if (!(count > 0)) continue;
        if (typeof rateFor(bucket) === "number") pricedTokens += count;
        else unpricedTokens += count;
      }
      return { pricedTokens, unpricedTokens };
    },
  ),
  splitTokenBucketsByRate: vi.fn(
    (
      rates: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache_read?: number;
        cache_write?: number;
      },
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache_read: number;
        cache_write: number;
      },
    ) => {
      const rateFor = (bucket: keyof typeof tokens): number | undefined => {
        switch (bucket) {
          case "input":
            return rates.input;
          case "output":
            return rates.output;
          case "cache_read":
            return rates.cache_read ?? rates.input;
          case "cache_write":
            return rates.cache_write ?? rates.input;
          case "reasoning":
            return rates.reasoning ?? rates.output;
        }
      };
      const priced = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
      const unpriced = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };
      for (const bucket of ["input", "output", "cache_read", "cache_write", "reasoning"] as const) {
        const count = tokens[bucket];
        if (!(count > 0)) continue;
        if (typeof rateFor(bucket) === "number") priced[bucket] = count;
        else unpriced[bucket] = count;
      }
      return { priced, unpriced };
    },
  ),
  calculateUsdFromTokenBuckets: vi.fn(
    (
      rates: {
        input?: number;
        output?: number;
        reasoning?: number;
        cache_read?: number;
        cache_write?: number;
      },
      tokens: {
        input: number;
        output: number;
        reasoning: number;
        cache_read: number;
        cache_write: number;
      },
    ) =>
      tokens.input * (rates.input ?? 0) +
      tokens.output * (rates.output ?? 0) +
      tokens.reasoning * (rates.reasoning ?? rates.output ?? 0) +
      tokens.cache_read * (rates.cache_read ?? rates.input ?? 0) +
      tokens.cache_write * (rates.cache_write ?? rates.input ?? 0),
  ),
}));

import {
  aggregateUsage,
  getSessionTokenSummary,
  getSessionTreeTokenSummary,
  priceTokenBuckets,
  resolveSessionTree,
  SessionNotFoundError,
} from "../src/lib/quota-stats.js";

describe("shared priceTokenBuckets primitive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const tokens = { input: 2, output: 3, reasoning: 4, cache_read: 5, cache_write: 6 };

  it("returns a priced outcome with the resolved key and cost", () => {
    expect(priceTokenBuckets({ providerID: "openai", modelID: "gpt-5", tokens })).toEqual({
      status: "priced",
      key: { provider: "openai", model: "gpt-5" },
      costUsd: 20,
    });
  });

  it("classifies a mapped model without rates as unpriced", () => {
    const outcome = priceTokenBuckets({
      providerID: "unpriced-labs",
      modelID: "mystery-1",
      tokens,
    });

    expect(outcome).toMatchObject({
      status: "unpriced",
      key: { provider: "unpriced-labs", model: "mystery-1" },
    });
    if (outcome.status === "unpriced") {
      expect(outcome.reason).toContain("no token pricing");
    }
  });

  it("blocks cross-provider fallback when the source catalog knows the model without rates", () => {
    const outcome = priceTokenBuckets({
      providerID: "catalog-labs",
      modelID: "gpt-5",
      tokens,
    });

    expect(outcome).toMatchObject({
      status: "unpriced",
      key: { provider: "catalog-labs", model: "gpt-5" },
    });
  });

  it("classifies an unmappable source as unknown", () => {
    const outcome = priceTokenBuckets({
      providerID: "phantom-labs",
      modelID: "ghost-9",
      tokens,
    });

    expect(outcome.status).toBe("unknown");
    if (outcome.status === "unknown") {
      expect(outcome.unknown.sourceProviderID).toBe("phantom-labs");
      expect(outcome.unknown.sourceModelID).toBe("ghost-9");
    }
  });

  it("reuses a supplied resolution cache across calls", async () => {
    const modelsdev = await import("../src/lib/modelsdev-pricing.js");
    const callsBefore = vi.mocked(modelsdev.isModelsDevProviderId).mock.calls.length;
    const cache = new Map();

    priceTokenBuckets({ providerID: "openai", modelID: "gpt-5", tokens, cache });
    const callsAfterFirst = vi.mocked(modelsdev.isModelsDevProviderId).mock.calls.length;
    priceTokenBuckets({ providerID: "openai", modelID: "gpt-5", tokens, cache });

    expect(callsAfterFirst).toBeGreaterThan(callsBefore);
    expect(vi.mocked(modelsdev.isModelsDevProviderId).mock.calls.length).toBe(callsAfterFirst);
    expect(cache.size).toBe(1);
  });

  it("keeps colliding pair encodings in separate cache entries in both orders", () => {
    const pricedPair = { providerID: PRICED_EDGE_PROVIDER, modelID: PRICED_EDGE_MODEL };
    const collidingPair = {
      providerID: `${PRICED_EDGE_PROVIDER}|||alpha`,
      modelID: "beta",
    };

    for (const reverse of [false, true]) {
      const cache = new Map();
      const first = priceTokenBuckets({ ...(reverse ? collidingPair : pricedPair), tokens, cache });
      const second = priceTokenBuckets({
        ...(reverse ? pricedPair : collidingPair),
        tokens,
        cache,
      });
      const pricedOutcome = reverse ? second : first;
      const unknownOutcome = reverse ? first : second;

      expect(pricedOutcome.status).toBe("priced");
      expect(unknownOutcome.status).toBe("unknown");
      if (unknownOutcome.status === "unknown") {
        expect(unknownOutcome.unknown.sourceProviderID).toBe(collidingPair.providerID);
        expect(unknownOutcome.unknown.sourceModelID).toBe(collidingPair.modelID);
      }
      expect(cache.size).toBe(2);
    }
  });

  it("distinguishes missing, null, and empty raw ids in the cache", () => {
    const cache = new Map();
    const missing = priceTokenBuckets({ providerID: undefined, modelID: "ghost", tokens, cache });
    const empty = priceTokenBuckets({ providerID: "", modelID: "ghost", tokens, cache });
    const nulled = priceTokenBuckets({ providerID: null, modelID: "ghost", tokens, cache });

    expect(missing.status).toBe("unknown");
    expect(empty.status).toBe("unknown");
    expect(nulled.status).toBe("unknown");
    if (missing.status === "unknown") {
      expect(missing.unknown.sourceProviderID).toBe("unknown");
    }
    if (empty.status === "unknown") {
      expect(empty.unknown.sourceProviderID).toBe("");
    }
    if (nulled.status === "unknown") {
      expect(nulled.unknown.sourceProviderID).toBe("unknown");
    }
    expect(cache.size).toBe(3);

    const modelCache = new Map();
    const missingModel = priceTokenBuckets({
      providerID: "phantom-labs",
      modelID: undefined,
      tokens,
      cache: modelCache,
    });
    const emptyModel = priceTokenBuckets({
      providerID: "phantom-labs",
      modelID: "",
      tokens,
      cache: modelCache,
    });

    if (missingModel.status === "unknown") {
      expect(missingModel.unknown.sourceModelID).toBe("unknown");
    }
    if (emptyModel.status === "unknown") {
      expect(emptyModel.unknown.sourceModelID).toBe("");
    }
    expect(modelCache.size).toBe(2);
  });
});

describe("quota stats session tree", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves recursive descendants in preorder using session creation order", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: { id: "ses_root", title: "Root", time: { created: 1 } },
      ses_child_b: {
        id: "ses_child_b",
        parentID: "ses_root",
        title: "Child B",
        time: { created: 30 },
      },
      ses_grandchild: {
        id: "ses_grandchild",
        parentID: "ses_child_a",
        title: "Grandchild",
        time: { created: 20 },
      },
      ses_child_a: {
        id: "ses_child_a",
        parentID: "ses_root",
        title: "Child A",
        time: { created: 10 },
      },
    });

    await expect(resolveSessionTree("ses_root")).resolves.toEqual([
      { sessionID: "ses_root", parentID: undefined, title: "Root", depth: 0 },
      { sessionID: "ses_child_a", parentID: "ses_root", title: "Child A", depth: 1 },
      {
        sessionID: "ses_grandchild",
        parentID: "ses_child_a",
        title: "Grandchild",
        depth: 2,
      },
      { sessionID: "ses_child_b", parentID: "ses_root", title: "Child B", depth: 1 },
    ]);
  });

  it("skips repeated nodes when parent links form a cycle", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: {
        id: "ses_root",
        parentID: "ses_leaf",
        title: "Root",
        time: { created: 1 },
      },
      ses_mid: {
        id: "ses_mid",
        parentID: "ses_root",
        title: "Mid",
        time: { created: 2 },
      },
      ses_leaf: {
        id: "ses_leaf",
        parentID: "ses_mid",
        title: "Leaf",
        time: { created: 3 },
      },
    });

    const tree = await resolveSessionTree("ses_root");

    expect(tree.map((node) => node.sessionID)).toEqual(["ses_root", "ses_mid", "ses_leaf"]);
  });

  it("throws SessionNotFoundError when the requested root session is missing", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({});

    await expect(resolveSessionTree("ses_missing")).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("session token summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("aggregates the current session and unique descendants without pricing", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: {
        id: "ses_root",
        parentID: "ses_leaf",
        title: "Root",
        time: { created: 1 },
      },
      ses_child: {
        id: "ses_child",
        parentID: "ses_root",
        title: "Child",
        time: { created: 2 },
      },
      ses_leaf: {
        id: "ses_leaf",
        parentID: "ses_child",
        title: "Leaf",
        time: { created: 3 },
      },
    });
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        modelID: "gpt-5",
        tokens: { input: 10, output: 5, cache: { read: 4 } },
      },
      {
        sessionID: "ses_child",
        role: "assistant",
        modelID: "gpt-5",
        tokens: { input: 2, output: 3, cache: { read: 6 } },
      },
      {
        sessionID: "ses_leaf",
        role: "assistant",
        modelID: "future-model",
        tokens: { input: 1, output: 1, cache: { read: 0 } },
      },
    ]);

    const result = await getSessionTreeTokenSummary("ses_root");

    expect(storage.iterAssistantMessagesForSessions).toHaveBeenCalledWith({
      sessionIDs: ["ses_root", "ses_child", "ses_leaf"],
    });
    expect(storage.iterAssistantMessagesForSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      sessionID: "ses_root",
      totalInput: 13,
      totalCachedInput: 10,
      totalCombinedInput: 23,
      totalOutput: 9,
      models: [
        {
          modelID: "gpt-5",
          input: 12,
          cachedInput: 10,
          totalInput: 22,
          output: 8,
        },
        {
          modelID: "future-model",
          input: 1,
          cachedInput: 0,
          totalInput: 1,
          output: 1,
        },
      ],
    });
  });

  it("returns new and cached input token totals separately", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSession as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 4, write: 0 } },
      },
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 6, write: 0 } },
      },
    ]);

    const result = await getSessionTokenSummary("ses_root");

    expect(result).toEqual({
      sessionID: "ses_root",
      totalInput: 12,
      totalCachedInput: 10,
      totalCombinedInput: 22,
      totalOutput: 8,
      models: [
        {
          modelID: "gpt-5",
          input: 12,
          cachedInput: 10,
          totalInput: 22,
          output: 8,
        },
      ],
    });
  });
});

describe("aggregateUsage session scoping", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.readAllSessionsIndex as any).mockResolvedValue({
      ses_root: { id: "ses_root", title: "Root Session", time: { created: 1 } },
      ses_child: {
        id: "ses_child",
        parentID: "ses_root",
        title: "Child Session",
        time: { created: 2 },
      },
      ses_unknown: { id: "ses_unknown", title: "Unknown Pricing", time: { created: 3 } },
    });
  });

  it("aggregates only the requested session set when sessionIDs are provided", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        sessionID: "ses_child",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 4, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_root", "ses_child"] });

    expect(storage.iterAssistantMessagesForSessions).toHaveBeenCalledWith({
      sessionIDs: ["ses_root", "ses_child"],
      sinceMs: undefined,
      untilMs: undefined,
    });
    expect(storage.iterAssistantMessagesForSession).not.toHaveBeenCalled();
    expect(result.totals.messageCount).toBe(2);
    expect(result.totals.sessionCount).toBe(2);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_root",
        title: "Root Session",
        messageCount: 1,
        costUsd: 15,
      }),
      expect.objectContaining({
        sessionID: "ses_child",
        title: "Child Session",
        messageCount: 1,
        costUsd: 5,
      }),
    ]);
  });

  it("keeps the single-session path unchanged for sessionID filters", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSession as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionID: "ses_root" });

    expect(storage.iterAssistantMessagesForSession).toHaveBeenCalledWith({
      sessionID: "ses_root",
      sinceMs: undefined,
      untilMs: undefined,
    });
    expect(storage.iterAssistantMessagesForSessions).not.toHaveBeenCalled();
    expect(result.totals.messageCount).toBe(1);
    expect(result.totals.sessionCount).toBe(1);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_root",
        title: "Root Session",
        messageCount: 1,
        costUsd: 5,
      }),
    ]);
  });

  it("keeps per-session breakdown rows for unknown-pricing usage", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_unknown",
        role: "assistant",
        providerID: "mystery-provider",
        modelID: "future-model",
        tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_unknown"] });

    expect(result.unknown).toHaveLength(1);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_unknown",
        title: "Unknown Pricing",
        messageCount: 1,
        costUsd: 0,
        tokens: expect.objectContaining({ input: 7, output: 2 }),
      }),
    ]);
  });

  it("tracks fully unpriced messages per session without claiming a partial rate", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5",
        tokens: { input: 3, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: "unpriced-labs",
        modelID: "mystery-1",
        tokens: { input: 7, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_root"] });

    expect(result.totals).not.toHaveProperty("partialMessageCount");
    expect(result.totals.priced).toEqual(expect.objectContaining({ input: 3, output: 2 }));
    expect(result.totals.unpriced).toEqual(expect.objectContaining({ input: 7, output: 2 }));
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_root",
        messageCount: 2,
        costUsd: 5,
        pricedMessageCount: 1,
        unpricedMessageCount: 1,
      }),
    ]);
    expect(result.bySession[0]).not.toHaveProperty("partialMessageCount");
  });

  it("splits a partially rated message between priced and unpriced totals", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: PARTIAL_PROVIDER,
        modelID: PARTIAL_MODEL,
        tokens: {
          input: 1_000_000,
          output: 2_000_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_root"] });
    const empty = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };

    // Known subtotal stays, but only the input bucket is classified as priced.
    expect(result.totals.priced).toEqual({ ...empty, input: 1_000_000 });
    expect(result.totals.unpriced).toEqual({ ...empty, output: 2_000_000 });
    expect(result.totals.unknown).toEqual(empty);
    expect(result.totals.costUsd).toBe(2_000_000);
    expect(result.totals.partialCostUsd).toBe(2_000_000);
    expect(result.totals.partialMessageCount).toBe(1);
    expect(result.byModel).toEqual([
      expect.objectContaining({
        costUsd: 2_000_000,
        partialMessageCount: 1,
        tokens: expect.objectContaining({ input: 1_000_000, output: 2_000_000 }),
      }),
    ]);
    expect(result.bySession).toEqual([
      expect.objectContaining({
        sessionID: "ses_root",
        costUsd: 2_000_000,
        partialMessageCount: 1,
      }),
    ]);
  });

  it("keeps explicit zero rates fully priced with no partial marker", async () => {
    const storage = await import("../src/lib/opencode-storage.js");
    (storage.iterAssistantMessagesForSessions as any).mockResolvedValue([
      {
        sessionID: "ses_root",
        role: "assistant",
        providerID: FREE_PROVIDER,
        modelID: FREE_MODEL,
        tokens: {
          input: 1_000_000,
          output: 2_000_000,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    ]);

    const result = await aggregateUsage({ sessionIDs: ["ses_root"] });
    const empty = { input: 0, output: 0, reasoning: 0, cache_read: 0, cache_write: 0 };

    expect(result.totals.priced).toEqual({
      ...empty,
      input: 1_000_000,
      output: 2_000_000,
    });
    expect(result.totals.unpriced).toEqual(empty);
    expect(result.totals.costUsd).toBe(0);
    expect(result.totals).not.toHaveProperty("partialCostUsd");
    expect(result.totals).not.toHaveProperty("partialMessageCount");
    expect(result.byModel[0]).not.toHaveProperty("partialMessageCount");
  });
});
