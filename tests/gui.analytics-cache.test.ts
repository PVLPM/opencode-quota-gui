import { describe, expect, it } from "vitest";
import {
  type AnalyticsHomeReader,
  createAnalyticsPresentationStore,
} from "../src/ui/analytics-cache.js";

const readHome: AnalyticsHomeReader = async () => {
  throw new Error("not used");
};

describe("analytics presentation store retention", () => {
  it("keeps a payload for the same owner and drops it on a source handoff", () => {
    let owner = {};
    const store = createAnalyticsPresentationStore(readHome, { owner: () => owner });
    store.remember("home:7d", { value: 1 });
    expect(store.take("home:7d")).toEqual({ value: 1 });
    owner = {};
    expect(store.take("home:7d")).toBeUndefined();
    store.dispose();
  });

  it("scopes provisional markers to the read that started last", () => {
    const store = createAnalyticsPresentationStore(readHome);
    const first = store.beginRead();
    const second = store.beginRead();
    store.noteProvisional("7d", first);
    expect(store.pending().has("7d")).toBe(true);
    store.noteProvisional("7d", second);
    // An older superseded read must not clear the newer read's marker.
    store.clearProvisional("7d", first);
    expect(store.pending().has("7d")).toBe(true);
    store.clearProvisional("7d", second);
    expect(store.pending().has("7d")).toBe(false);
    store.dispose();
  });

  it("bounds retained session trees while keeping rollups", () => {
    const store = createAnalyticsPresentationStore(readHome);
    for (let index = 0; index < 4; index += 1) {
      store.remember(`session:ses_${index}`, { detail: "x".repeat(1_000_000), index });
    }
    store.remember("home:7d", { rollup: true });
    store.remember("groups:model:7d", { rollup: true });
    store.remember("project:p1:7d", { rollup: true });

    const retainedSessions = [0, 1, 2, 3].filter(
      (index) => store.take(`session:ses_${index}`) !== undefined,
    );
    // Newest session trees survive; the two oldest were evicted by the budget.
    expect(retainedSessions).toEqual([2, 3]);
    expect(store.take("home:7d")).toEqual({ rollup: true });
    expect(store.take("groups:model:7d")).toEqual({ rollup: true });
    expect(store.take("project:p1:7d")).toEqual({ rollup: true });
    store.dispose();
  });

  it("bounds total retained bytes even across distinct shapes", () => {
    const store = createAnalyticsPresentationStore(readHome);
    const large = (size: number) => ({ text: "x".repeat(size) });
    for (let index = 0; index < 8; index += 1) {
      store.remember(`groups:dimension:${index}`, large(1_000_000));
    }
    // 12 MiB budget: the oldest large payloads cannot all survive.
    const retained = Array.from({ length: 8 }, (_, index) =>
      store.take(`groups:dimension:${index}`),
    ).filter((value) => value !== undefined);
    expect(retained.length).toBeLessThanOrEqual(6);
    // Only the suffix survives; insertion order is eviction order.
    expect(store.take("groups:dimension:7")).toBeDefined();
    expect(store.take("groups:dimension:0")).toBeUndefined();
    store.dispose();
  });
});
