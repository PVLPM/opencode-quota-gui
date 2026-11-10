import { describe, expect, it, vi } from "vitest";
import { createProviderReview } from "../src/native/agent-provider-review-state.js";

const proposal = {
  id: "demo",
  definition: { id: "demo", mode: "local-estimate" },
  approved: false,
  enabled: false,
};

describe("native agent provider review", () => {
  it("requires approval before a separate enable action", async () => {
    const client = {
      agentCustomProviders: vi.fn().mockResolvedValue({ revision: "one", providers: [proposal] }),
      approveAgentCustomProvider: vi
        .fn()
        .mockResolvedValue({ revision: "two", providers: [{ ...proposal, approved: true }] }),
      setAgentCustomProviderEnabled: vi.fn().mockResolvedValue({
        revision: "three",
        providers: [{ ...proposal, approved: true, enabled: true }],
      }),
    };
    const review = createProviderReview(client, () => {});
    await review.refresh();
    await review.enable("demo", true);
    expect(client.setAgentCustomProviderEnabled).not.toHaveBeenCalled();
    await review.approve("demo");
    expect(client.approveAgentCustomProvider).toHaveBeenCalledWith({
      id: "demo",
      expectedRevision: "one",
    });
    expect(client.setAgentCustomProviderEnabled).not.toHaveBeenCalled();
    await review.enable("demo", true);
    expect(client.setAgentCustomProviderEnabled).toHaveBeenCalledWith({
      id: "demo",
      enabled: true,
      expectedRevision: "two",
    });
  });

  it("discards a stale review after a rejected approval and requires a fresh read", async () => {
    const client = {
      agentCustomProviders: vi.fn().mockResolvedValue({ revision: "old", providers: [proposal] }),
      approveAgentCustomProvider: vi.fn().mockRejectedValue(new Error("config-changed")),
      setAgentCustomProviderEnabled: vi.fn(),
    };
    const review = createProviderReview(client, () => {});
    await review.refresh();
    await review.approve("demo");
    expect(review.current().snapshot).toBeUndefined();
    expect(review.current().error).toContain("changed");
    await review.approve("demo");
    expect(client.approveAgentCustomProvider).toHaveBeenCalledTimes(1);
  });
});
