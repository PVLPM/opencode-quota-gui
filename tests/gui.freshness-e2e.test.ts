import { expect, it, vi } from "vitest";
import { createSnapshotService } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaPercentEntry } from "../src/lib/entries.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { buildSessionHeaderView } from "../src/native/session-header-model.js";

it("keeps healthy account rings during a failed poll and restores the failed account on recovery", async () => {
  const start = Date.UTC(2026, 10, 1);
  vi.useFakeTimers();
  vi.setSystemTime(start);
  let cycle = 0;
  const row = (
    sourceId: string,
    name: string,
    rowKey: string,
    value: number,
  ): QuotaPercentEntry => ({
    kind: "percent",
    name,
    rowKey,
    percentRemaining: value,
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      sourceId,
    },
  });
  const accounts = [
    { sourceId: "a", label: "A" },
    { sourceId: "b", label: "B" },
  ];
  const collect = vi.fn(async () => {
    cycle++;
    return [
      {
        providerId: "anthropic",
        cacheScope: "same-scope",
        result: {
          attempted: true,
          accounts,
          entries:
            cycle >= 4
              ? []
              : [
                  row("a", "5h", "window:five_hour", cycle === 1 ? 80 : 70),
                  row("a", "Weekly", "window:week", 60),
                  {
                    ...row("a", "Fable", "fable", 50),
                    semantic: {
                      metric: { kind: "named" as const, name: "Fable weekly" },
                      prominence: "primary" as const,
                    },
                  },
                  ...(cycle === 2
                    ? []
                    : [row("b", "5h", "window:five_hour", cycle === 1 ? 30 : 40)]),
                ],
          errors:
            cycle === 2
              ? [{ sourceId: "b", label: "B", message: "temporary" }]
              : cycle >= 4
                ? [
                    { sourceId: "a", label: "A", message: "offline" },
                    { sourceId: "b", label: "B", message: "offline" },
                  ]
                : [],
        },
      },
    ];
  });
  const source = createDashboardReadSource({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    workspaceRoot: "C:/synthetic-workspace",
    loadConfig: async () => ({ ...DEFAULT_CONFIG, enabledProviders: ["anthropic"] }),
    collectProviderResults: collect,
    now: () => Date.now(),
  });
  const snapshots = createSnapshotService({
    source,
    now: () => Date.now(),
    quotaIntervalMs: 60_000,
  });
  const removeViewer = snapshots.addViewer();
  try {
    const initial = await snapshots.quota();
    expect((await snapshots.quota()).providers.polledAtMs).toBe(initial.providers.polledAtMs);
    await vi.advanceTimersByTimeAsync(60_000);
    const partial = await snapshots.quota();
    expect(partial.providers.polledAtMs).toBe(start + 60_000);
    expect(partial.stale).toBe(false);
    const a = partial.providers.cards.find((card) => card.accountLabel === "A");
    const b = partial.providers.cards.find((card) => card.accountLabel === "B");
    expect(a?.rows.map((item) => item.percentRemaining)).toEqual([70, 60, 50]);
    expect(a?.stale).toBeUndefined();
    expect(b?.rows.map((item) => item.percentRemaining)).toEqual([30]);
    expect(b?.stale).toBe(true);
    expect(b?.errors.map((item) => item.label)).toEqual(["B"]);
    const header = buildSessionHeaderView({
      snapshot: partial,
      hiddenCards: [],
      hiddenRows: [],
      preferences: { percentMode: "used", showRunway: false, detailed: false },
      nowMs: Date.now(),
    });
    expect(header.cards.map((card) => card.cardId)).toEqual([a?.cardId]);
    expect(header.cards[0]?.rings).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(60_000);
    const recovered = await snapshots.quota();
    expect(collect).toHaveBeenCalledTimes(3);
    expect(recovered.providers.cards.find((card) => card.accountLabel === "B")).toMatchObject({
      rows: [expect.objectContaining({ percentRemaining: 40 })],
      errors: [],
    });
    expect(
      recovered.providers.cards.find((card) => card.accountLabel === "B")?.stale,
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await snapshots.quota()).stale).toBe(true);
  } finally {
    removeViewer();
    snapshots.close();
    vi.useRealTimers();
  }
});
