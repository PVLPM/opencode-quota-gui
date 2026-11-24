import { expect, it, vi } from "vitest";
import { createSnapshotService } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaPercentEntry } from "../src/lib/entries.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { buildSessionHeaderView } from "../src/native/session-header-model.js";
import { createQuotaQuery } from "../src/ui/quota-query.js";

it("updates the query's Polled time on an unchanged scheduled collection without recollecting", async () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 1);
  vi.setSystemTime(start);
  const collect = vi.fn(async () => ({
    generatedAtMs: Date.now(),
    stale: false,
    timeZone: "UTC",
    providers: { cards: [], enabledProviders: "auto" as const, polledAtMs: Date.now() },
  }));
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const source = { quota: collect, home: unused, project: unused, session: unused };
  const snapshots = createSnapshotService({ source, quotaIntervalMs: 60_000 });
  const release = snapshots.addViewer();
  const query = createQuotaQuery((refresh) =>
    snapshots.quota(refresh ? { refresh: true } : undefined),
  );
  const events: string[] = [];
  const unsubscribe = snapshots.subscribe((event) => {
    events.push(event.topic);
    if (event.topic === "quota.changed") void query.read({ changed: true });
  });
  try {
    await query.read();
    expect(query.data()?.providers.polledAtMs).toBe(start);
    await query.read();
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual(["quota.changed"]);
    expect(query.data()?.providers.polledAtMs).toBe(start + 60_000);
    expect(collect).toHaveBeenCalledTimes(2);
    await query.read();
    expect(query.data()?.providers.polledAtMs).toBe(start + 60_000);
    expect(collect).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    release();
    snapshots.close();
    vi.useRealTimers();
  }
});

it.each([
  "viewer",
  "source",
] as const)("discards an obsolete %s poll without updating the query", async (reason) => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 1);
  vi.setSystemTime(start);
  const initial = {
    generatedAtMs: start,
    stale: false,
    timeZone: "UTC",
    providers: { cards: [], enabledProviders: "auto" as const, polledAtMs: start },
  };
  let finish!: (value: typeof initial) => void;
  const collect = vi
    .fn()
    .mockResolvedValueOnce(initial)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const snapshots = createSnapshotService({
    source: { quota: collect, home: unused, project: unused, session: unused },
    quotaIntervalMs: 60_000,
  });
  const release = snapshots.addViewer();
  const query = createQuotaQuery((refresh) =>
    snapshots.quota(refresh ? { refresh: true } : undefined),
  );
  const events: string[] = [];
  let handoff = false;
  const unsubscribe = snapshots.subscribe((event) => {
    if (handoff) return;
    events.push(event.topic);
    if (event.topic === "quota.changed") void query.read({ changed: true });
  });
  try {
    await query.read();
    await vi.advanceTimersByTimeAsync(60_000);
    if (reason === "viewer") release();
    else {
      handoff = true;
      snapshots.sourceChanged();
      handoff = false;
    }
    finish({ ...initial, providers: { ...initial.providers, polledAtMs: start + 60_000 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(query.data()?.providers.polledAtMs).toBe(start);
  } finally {
    unsubscribe();
    release();
    snapshots.close();
    vi.useRealTimers();
  }
});

it("propagates Polled through early retry and manual refresh", async () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 10, 1);
  vi.setSystemTime(start);
  const collect = vi.fn(async () => ({
    generatedAtMs: Date.now(),
    stale: false,
    timeZone: "UTC",
    providers: {
      cards: [
        {
          cardId: "test" as import("../src/contracts/identity.js").CardId,
          providerId: "test",
          providerLabel: "Test",
          labelSource: "provider" as const,
          rows: [],
          errors: [{ label: "Test", message: "failed", failureCategory: "provider_api" as const }],
        },
      ],
      enabledProviders: "auto" as const,
      polledAtMs: Date.now(),
    },
  }));
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const snapshots = createSnapshotService({
    source: { quota: collect, home: unused, project: unused, session: unused },
    quotaIntervalMs: 60_000,
  });
  const release = snapshots.addViewer();
  const query = createQuotaQuery((refresh) =>
    snapshots.quota(refresh ? { refresh: true } : undefined),
  );
  const unsubscribe = snapshots.subscribe((event) => {
    if (event.topic === "quota.changed") void query.read({ changed: true });
  });
  try {
    await query.read();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(query.data()?.providers.polledAtMs).toBe(start + 70_000);
    expect(collect).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    await query.refresh();
    expect(query.data()?.providers.polledAtMs).toBe(start + 71_000);
    expect(collect).toHaveBeenCalledTimes(4);
  } finally {
    unsubscribe();
    release();
    snapshots.close();
    vi.useRealTimers();
  }
});

it("serializes Retry behind a poll and updates both account views without the event", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 1));
  let releasePoll!: () => void;
  const pollGate = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  let cycle = 0;
  const collect = vi.fn(async () => {
    const current = ++cycle;
    if (current === 2) await pollGate;
    return [
      {
        providerId: "anthropic",
        cacheScope: "same-scope",
        result: {
          attempted: true,
          accounts: [
            { sourceId: "a", label: "A" },
            { sourceId: "b", label: "B" },
          ],
          entries: ["a", "b"].map(
            (sourceId, index): QuotaPercentEntry => ({
              kind: "percent",
              name: "5h",
              rowKey: "window:five_hour",
              percentRemaining: current * 10 + index,
              accounting: {
                resultType: "quota",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
                sourceId,
              },
            }),
          ),
          errors: [],
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
    quotaIntervalMs: 60_000,
    now: () => Date.now(),
  });
  const removeViewer = snapshots.addViewer();
  const query = createQuotaQuery((refresh) =>
    snapshots.quota(refresh ? { refresh: true } : undefined),
  );
  const values = () =>
    query
      .data()
      ?.providers.cards.map((card) => [card.accountLabel, card.rows[0]?.percentRemaining]);
  try {
    await query.read();
    expect(values()).toEqual([
      ["A", 10],
      ["B", 11],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(collect).toHaveBeenCalledTimes(2);
    const retry = query.refresh();
    const retryAgain = query.refresh();
    await Promise.resolve();
    expect(collect).toHaveBeenCalledTimes(2);
    releasePoll();
    await Promise.all([retry, retryAgain]);
    expect(collect).toHaveBeenCalledTimes(3);
    expect(values()).toEqual([
      ["A", 30],
      ["B", 31],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    // Deliberately do not subscribe to quota.changed: the next read gets the poll.
    await query.read();
    expect(values()).toEqual([
      ["A", 40],
      ["B", 41],
    ]);
    const snapshot = query.data();
    if (!snapshot) throw new Error("expected quota snapshot");
    const header = buildSessionHeaderView({
      snapshot,
      hiddenCards: [],
      hiddenRows: [],
      preferences: { percentMode: "used", showRunway: false, detailed: false },
      nowMs: Date.now(),
    });
    expect(header.cards).toHaveLength(2);

    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let reads = 0;
    const reconnecting = createQuotaQuery(async () => {
      const snapshot = await snapshots.quota();
      if (++reads === 1) await oldGate;
      return snapshot;
    });
    const oldRead = reconnecting.read();
    await vi.advanceTimersByTimeAsync(60_000);
    reconnecting.invalidate();
    reconnecting.reconnected();
    await reconnecting.afterReconnect();
    expect(
      reconnecting
        .data()
        ?.providers.cards.map((card) => [card.accountLabel, card.rows[0]?.percentRemaining]),
    ).toEqual([
      ["A", 50],
      ["B", 51],
    ]);
    releaseOld();
    expect(await oldRead).toBe(false);
    expect(
      reconnecting
        .data()
        ?.providers.cards.map((card) => [card.accountLabel, card.rows[0]?.percentRemaining]),
    ).toEqual([
      ["A", 50],
      ["B", 51],
    ]);
  } finally {
    releasePoll();
    removeViewer();
    snapshots.close();
    vi.useRealTimers();
  }
});

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
              ? // A known retry deadline makes this a rate-limited failure: it is
                // retained without arming the early transient re-poll, so this
                // test keeps its one-poll-per-minute timeline.
                [{ sourceId: "b", label: "B", message: "temporary", retryAtMs: start + 90_000 }]
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
