import { describe, expect, it, vi } from "vitest";

import { getCurrentCursorUsageSummary } from "../src/lib/cursor-usage.js";

vi.mock("../src/lib/opencode-storage.js", () => ({
  iterAssistantMessages: vi.fn(),
}));

vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>();
  const PARTIAL_PROVIDER = "openai";
  const PARTIAL_MODEL = "gpt-5-partial";

  return {
    ...actual,
    hasCost: (providerID: string, modelID: string) =>
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      actual.hasCost(providerID, modelID),
    hasModel: (providerID: string, modelID: string) =>
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      actual.hasModel(providerID, modelID),
    lookupCost: (providerID: string, modelID: string) => {
      if (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) return { input: 2 };
      return actual.lookupCost(providerID, modelID);
    },
  };
});

vi.mock("../src/lib/cursor-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/cursor-pricing.js")>();

  return {
    ...actual,
    isCursorProviderId: (providerID?: string) => providerID === "cursor",
    isCursorModelId: (modelID?: string) => modelID === "cursor-acp/gpt-5-partial",
    lookupCursorLocalCost: (model: string) => {
      if (model === "local-partial") return { input: 2 };
      if (model === "local-free") return { input: 0, output: 0 };
      if (model === "local-full") return { input: 1, output: 2 };
      return actual.lookupCursorLocalCost(model);
    },
    resolveCursorModel: (modelID?: string) => {
      if (modelID === "local-partial" || modelID === "local-free" || modelID === "local-full") {
        return { kind: "local", model: modelID };
      }
      if (modelID === "cursor-acp/gpt-5-partial") {
        return { kind: "official", providerHint: "openai", modelHint: "gpt-5-partial" };
      }
      return { kind: "unknown" };
    },
  };
});

const NOW = new Date(2026, 2, 19, 10, 0, 0, 0).getTime();

function message(modelID: string, input: number, output: number) {
  return {
    role: "assistant",
    providerID: "cursor",
    modelID,
    tokens: { input, output, cache: { read: 0, write: 0 } },
  };
}

describe("cursor usage partial pricing", () => {
  it("routes a partially rated local model to unknown usage instead of a subtotal", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([
      message("local-partial", 1_000_000, 1_000_000),
    ]);

    const summary = await getCurrentCursorUsageSummary({ nowMs: NOW });

    expect(summary.autoComposer.messageCount).toBe(0);
    expect(summary.autoComposer.costUsd).toBe(0);
    expect(summary.total.messageCount).toBe(1);
    expect(summary.total.costUsd).toBe(0);
    expect(summary.unknownModels).toEqual([
      expect.objectContaining({
        sourceModelID: "local-partial",
        messageCount: 1,
        tokens: expect.objectContaining({ input: 1_000_000, output: 1_000_000 }),
      }),
    ]);
  });

  it("routes a partially rated official model to unknown usage", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([
      message("cursor-acp/gpt-5-partial", 1_000_000, 1_000_000),
    ]);

    const summary = await getCurrentCursorUsageSummary({ nowMs: NOW });

    expect(summary.api.messageCount).toBe(0);
    expect(summary.api.costUsd).toBe(0);
    expect(summary.total.messageCount).toBe(1);
    expect(summary.unknownModels).toEqual([
      expect.objectContaining({ sourceModelID: "cursor-acp/gpt-5-partial", messageCount: 1 }),
    ]);
  });

  it("keeps explicitly zero local rates as known zero-cost usage", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([message("local-free", 1_000_000, 1_000_000)]);

    const summary = await getCurrentCursorUsageSummary({ nowMs: NOW });

    expect(summary.autoComposer.messageCount).toBe(1);
    expect(summary.autoComposer.costUsd).toBe(0);
    expect(summary.unknownModels).toEqual([]);
  });

  it("keeps fully rated local pricing unchanged", async () => {
    const { iterAssistantMessages } = await import("../src/lib/opencode-storage.js");
    (iterAssistantMessages as any).mockResolvedValue([message("local-full", 1_000_000, 1_000_000)]);

    const summary = await getCurrentCursorUsageSummary({ nowMs: NOW });

    expect(summary.autoComposer.messageCount).toBe(1);
    expect(summary.autoComposer.costUsd).toBeCloseTo(3, 6);
    expect(summary.total.costUsd).toBeCloseTo(3, 6);
    expect(summary.unknownModels).toEqual([]);
  });
});
