import { describe, expect, it, vi } from "vitest";

import { createAnalyticsPricingUpkeep } from "../src/gui/analytics-pricing-upkeep.js";

describe("analytics pricing upkeep", () => {
  it("advertises start before the reply frame and finish only after the refresh settles", async () => {
    const frames: unknown[] = [];
    let settle: (() => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const routes = [{ providerID: "mistral", modelID: "mistral/deepseek-v4-1-flash-1017" }];
    const upkeep = createAnalyticsPricingUpkeep({
      postMessage: (message) => frames.push(message),
      routes: () => routes,
      refresh,
    });

    upkeep.begin();
    frames.push({ reply: "last analytics response" });
    expect(frames).toEqual([
      { type: "analytics-upkeep", active: true },
      { reply: "last analytics response" },
    ]);
    expect(refresh).not.toHaveBeenCalled();

    // The refresh starts after the reply frame, not on the read path.
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledWith({ routes });
    expect(frames).toHaveLength(2);

    // A slow refresh keeps the worker advertised as busy until it settles.
    settle?.();
    await vi.waitFor(() => {
      expect(frames.at(-1)).toEqual({ type: "analytics-upkeep", active: false });
    });
    expect(frames).toHaveLength(3);
  });

  it("clears the busy flag when the refresh rejects", async () => {
    const frames: unknown[] = [];
    const upkeep = createAnalyticsPricingUpkeep({
      postMessage: (message) => frames.push(message),
      routes: () => [],
      refresh: () => Promise.reject(new Error("offline")),
    });

    upkeep.begin();
    await vi.waitFor(() => {
      expect(frames.at(-1)).toEqual({ type: "analytics-upkeep", active: false });
    });
    expect(frames).toEqual([
      { type: "analytics-upkeep", active: true },
      { type: "analytics-upkeep", active: false },
    ]);
  });
});
