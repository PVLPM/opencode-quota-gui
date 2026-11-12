import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/lib/opencode-storage.js", () => ({
  iterAssistantMessages: vi.fn(),
  iterAssistantMessagesForSession: vi.fn(),
  iterAssistantMessagesForSessions: vi.fn(),
  readAllSessionsIndex: vi.fn(),
  SessionNotFoundError: class extends Error {},
}));

import { setPricingSnapshotSelection } from "../src/lib/modelsdev-pricing.js";
import * as storage from "../src/lib/opencode-storage.js";
import { aggregateUsage, priceTokenBuckets } from "../src/lib/quota-stats.js";

beforeEach(() => setPricingSnapshotSelection("bundled"));

it("keeps source identities and every token component consistent across aggregate views", async () => {
  const tokens = { input: 1000, output: 2000, reasoning: 300, cache_read: 4000, cache_write: 5000 };
  vi.mocked(storage.readAllSessionsIndex).mockResolvedValue({});
  vi.mocked(storage.iterAssistantMessages).mockResolvedValue([
    {
      id: "m1",
      sessionID: "ses_1",
      role: "assistant",
      providerID: "claude-agent",
      modelID: "sonnet",
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cache_read, write: tokens.cache_write },
      },
      time: { completed: 1 },
    },
  ]);
  const result = await aggregateUsage({});
  const price = priceTokenBuckets({
    providerID: "anthropic",
    modelID: "claude-sonnet-5-5",
    tokens,
  });
  expect(price.status).toBe("priced");
  if (price.status !== "priced") throw new Error("Expected complete rates");
  expect(result.totals.priced).toEqual(tokens);
  expect(result.totals.costUsd).toBe(price.costUsd);
  for (const rows of [
    result.bySession,
    result.bySourceModel,
    result.bySourceProvider,
    result.byModel,
  ]) {
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tokens, costUsd: price.costUsd });
  }
  expect(result.bySourceModel[0]).toMatchObject({
    sourceProviderID: "claude-agent",
    sourceModelID: "sonnet",
  });
  expect(result.bySourceProvider[0]).toMatchObject({ providerID: "claude-agent" });
});
