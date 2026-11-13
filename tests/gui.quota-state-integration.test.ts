import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSnapshotService } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaProvider, QuotaProviderResult, QuotaToastEntry } from "../src/lib/entries.js";
import { collectQuotaDashboardProviderResults } from "../src/lib/quota-render-data.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";

const testPaths = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => {
    if (!testPaths.root) throw new Error("Test runtime directory is not initialized");
    return {
      dataDir: `${testPaths.root}/data`,
      configDir: `${testPaths.root}/config`,
      cacheDir: `${testPaths.root}/cache`,
      stateDir: `${testPaths.root}/state`,
    };
  },
}));

const accounting = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

beforeEach(async () => {
  testPaths.root = await mkdtemp(join(tmpdir(), "quota-state-integration-"));
});

afterEach(async () => {
  __resetQuotaStateForTests();
  if (testPaths.root) await rm(testPaths.root, { recursive: true, force: true });
  testPaths.root = "";
});

it("retries an initially partial provider on scheduled polls without substituting another account", async () => {
  const accounts = [{ sourceId: "a" }, { sourceId: "b" }, { sourceId: "c" }];
  const row = (sourceId: string, percentRemaining: number) => ({
    kind: "percent" as const,
    accounting: { ...accounting, sourceId },
    semantic: {
      metric: { kind: "window" as const, window: "week" as const },
      prominence: "primary" as const,
    },
    name: sourceId,
    percentRemaining,
  });
  const partial = {
    attempted: true,
    accounts,
    entries: [row("a", 71), row("c", 33)],
    errors: [{ sourceId: "b", label: "Account B", message: "temporarily unavailable" }],
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(partial)
    .mockResolvedValueOnce(partial)
    .mockResolvedValue({
      ...partial,
      entries: [row("a", 71), row("b", 42), row("c", 33)],
      errors: [],
    });
  const provider: QuotaProvider = {
    id: "partial-integration-test",
    cachePolicy: { kind: "account-neutral" },
    isAvailable: async () => true,
    fetch,
  };
  const source = createDashboardReadSource({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    workspaceRoot: "C:/synthetic-workspace",
    providers: [provider],
    loadConfig: async () => ({
      ...DEFAULT_CONFIG,
      enabledProviders: [provider.id],
      minIntervalMs: 60_000,
    }),
  });
  const snapshots = createSnapshotService({ source, quotaIntervalMs: 100 });
  const removeViewer = snapshots.addViewer();
  try {
    const initial = await snapshots.quota();
    expect(initial.stale).toBe(true);
    const failed = initial.providers.cards.find((card) => card.accountLabel === "Account 2");
    expect(failed?.rows).toEqual([]);
    expect(failed?.errors.map((error) => error.label)).toEqual(["Account B"]);
    expect(
      initial.providers.cards.find((card) => card.accountLabel === "Account 1")?.rows[0]
        ?.percentRemaining,
    ).toBe(71);
    expect(
      initial.providers.cards.find((card) => card.accountLabel === "Account 3")?.rows[0]
        ?.percentRemaining,
    ).toBe(33);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3), { timeout: 3000, interval: 20 });
    await vi.waitFor(
      async () => {
        const recovered = await snapshots.quota();
        expect(recovered.stale).toBe(false);
        expect(
          recovered.providers.cards.find((card) => card.accountLabel === "Account 2")?.rows[0]
            ?.percentRemaining,
        ).toBe(42);
        expect(
          recovered.providers.cards.find((card) => card.accountLabel === "Account 2")?.errors,
        ).toEqual([]);
      },
      { timeout: 3000, interval: 20 },
    );
  } finally {
    removeViewer();
    snapshots.close();
  }
});

it("keeps partial 429 account rows fresh and bounded across repeated dashboard polls", async () => {
  const accountSourceIds = ["workspace-a", "workspace-b", "workspace-c"] as const;
  const accounts = accountSourceIds.map((sourceId) => ({
    sourceId,
    label: `Workspace ${sourceId.slice(-1).toUpperCase()}`,
    active: true,
  }));
  const balance = (sourceId: string, decimal: string): QuotaToastEntry => ({
    accounting: {
      resultType: "balance",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      sourceId,
    },
    kind: "quantity",
    name: "zen-current-balance",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "current_balance" },
      prominence: "primary",
    },
    quantity: { decimal, unit: { kind: "currency", code: "USD" } },
  });
  const monthlyBudget = (sourceId: string, percentRemaining: number): QuotaToastEntry => ({
    accounting: {
      resultType: "budget",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "locally_derived",
      sourceId,
    },
    kind: "percent",
    name: "zen-monthly-budget",
    group: "OpenCode Zen",
    percentRemaining,
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
  });
  const previous: QuotaProviderResult = {
    attempted: true,
    accounts,
    entries: [
      balance("workspace-a", "42.00"),
      monthlyBudget("workspace-a", 65),
      balance("workspace-b", "12.00"),
      monthlyBudget("workspace-b", 75),
      balance("workspace-c", "8.00"),
      monthlyBudget("workspace-c", 25),
    ],
    errors: [],
  };
  const partial: QuotaProviderResult = {
    attempted: true,
    accounts,
    entries: [
      balance("workspace-a", "99.00"),
      balance("workspace-b", "15.00"),
      monthlyBudget("workspace-b", 55),
    ],
    errors: [
      {
        label: "Workspace A",
        message: "Optional monthly route is rate limited",
        sourceId: "workspace-a",
        failureCategory: "provider_api",
        retryAtMs: Date.now() + 60_000,
      },
      {
        label: "Workspace C",
        message: "Workspace request is rate limited",
        sourceId: "workspace-c",
        failureCategory: "provider_api",
        retryAtMs: Date.now() + 60_000,
      },
    ],
  };
  let fetchCount = 0;
  const provider: QuotaProvider = {
    id: "opencode",
    cachePolicy: { kind: "account-neutral" },
    isAvailable: async () => true,
    fetch: async () => (fetchCount++ === 0 ? previous : partial),
  };
  const client = {
    config: {
      providers: async () => ({ data: { providers: [] } }),
      get: async () => ({ data: {} }),
    },
  };
  const normalizedPolls: QuotaProviderResult[] = [];
  const source = createDashboardReadSource({
    client,
    workspaceRoot: "C:/synthetic-workspace",
    providers: [provider],
    loadConfig: async () => ({
      ...DEFAULT_CONFIG,
      enabledProviders: [provider.id],
      minIntervalMs: 0,
    }),
    collectProviderResults: async ({ config, providers }) => {
      const probes = await collectQuotaDashboardProviderResults({
        client,
        config,
        workspaceRoot: "C:/synthetic-workspace",
        providers,
      });
      const normalizedResult = probes[0]?.result;
      if (normalizedResult) normalizedPolls.push(normalizedResult);
      return probes;
    },
  });

  const first = await source.quota();
  const second = await source.quota();
  const third = await source.quota();

  expect(fetchCount).toBe(3);
  const partialEntries = normalizedPolls[1]?.entries ?? [];
  const normalizedRows = partialEntries.map((entry) => [
    entry.accounting.sourceId,
    entry.accounting.resultType,
    entry.name,
  ]);
  expect(normalizedRows).toEqual([
    ["workspace-a", "balance", "zen-current-balance"],
    ["workspace-b", "balance", "zen-current-balance"],
    ["workspace-b", "budget", "zen-monthly-budget"],
    ["workspace-c", "balance", "zen-current-balance"],
    ["workspace-c", "budget", "zen-monthly-budget"],
  ]);
  expect(normalizedPolls[2]?.entries).toEqual(partialEntries);
  expect(normalizedPolls.map((poll) => poll.entries.length)).toEqual([6, 5, 5]);

  const visibleRows = (snapshot: typeof second, label: string) =>
    snapshot.providers.cards
      .find((card) => card.accountLabel === label)
      ?.rows.map((row) => ({
        resultType: row.resultType,
        kind: row.kind,
        quantity: row.quantity?.decimal,
        percentRemaining: row.percentRemaining,
        booleanValue: row.booleanValue,
      })) ?? [];
  expect(first.stale).toBe(false);
  expect(second.stale).toBe(true);
  expect(visibleRows(second, "Workspace A")).toEqual([
    { resultType: "balance", kind: "quantity", quantity: "99.00" },
  ]);
  expect(visibleRows(second, "Workspace B")).toEqual([
    { resultType: "balance", kind: "quantity", quantity: "15.00" },
    { resultType: "budget", kind: "percent", percentRemaining: 55 },
  ]);
  expect(visibleRows(second, "Workspace C")).toEqual([
    { resultType: "balance", kind: "quantity", quantity: "8.00" },
    { resultType: "budget", kind: "percent", percentRemaining: 25 },
  ]);
  expect(visibleRows(third, "Workspace A")).toEqual(visibleRows(second, "Workspace A"));
  expect(visibleRows(third, "Workspace B")).toEqual(visibleRows(second, "Workspace B"));
  expect(visibleRows(third, "Workspace C")).toEqual(visibleRows(second, "Workspace C"));
});
