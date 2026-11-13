import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSnapshotService } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaProvider } from "../src/lib/entries.js";
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
