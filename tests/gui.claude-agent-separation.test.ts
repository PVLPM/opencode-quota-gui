import { expect, it } from "vitest";
import { CLAUDE_AGENT_RESETS_ROW_KEY } from "../src/contracts/openai-quota.js";
import { buildProviderCards } from "../src/gui/provider-cards.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../src/lib/entries.js";
import { buildQuotaProviderStateCacheKey } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { anthropicQuotaEntries } from "../src/providers/anthropic.js";

const quota = {
  success: true as const,
  five_hour: { percentRemaining: 80 },
  seven_day: { percentRemaining: 60 },
  fable_weekly: { percentRemaining: 40 },
  extra_usage: { percentRemaining: 20 },
};
const anthropic: QuotaProviderResult = {
  attempted: true,
  accounts: [{ sourceId: "open-code", label: "OpenCode", active: true }],
  entries: anthropicQuotaEntries(quota, {
    group: "OpenCode",
    acquisitionMethod: "remote_api",
    sourceId: "open-code",
  }),
  errors: [],
};
const claude: QuotaProviderResult = {
  attempted: true,
  planLabel: "Max",
  entries: anthropicQuotaEntries(quota, { group: "Claude", acquisitionMethod: "local_cli" }),
  errors: [],
};

it("projects separate provider cards and stable primary ring slots", () => {
  const cards = buildProviderCards({
    probes: [
      { providerId: "anthropic", result: anthropic },
      { providerId: "claude-agent", result: claude },
    ],
    preferences: { accountingDetail: "summary" },
    nowMs: Date.now(),
  });
  expect(cards).toHaveLength(2);
  const a = cards.find((card) => card.providerId === "anthropic")!;
  const c = cards.find((card) => card.providerId === "claude-agent")!;
  expect(a.cardId).not.toBe(c.cardId);
  expect(a.accountLabel).toBe("OpenCode");
  expect(c.planLabel).toBe("Max");
  for (const card of [a, c]) {
    expect(card.rows.map((row) => row.label)).toEqual(["5h", "Weekly", "Monthly", "Fable"]);
    expect(
      card.primaryQuotaWindows?.map(({ rowId, slot }) => ({
        label: card.rows.find((row) => row.rowId === rowId)?.label,
        slot,
      })),
    ).toEqual([
      { label: "5h", slot: 0 },
      { label: "Weekly", slot: 1 },
      { label: "Fable", slot: 2 },
    ]);
  }
  expect(a.rows.every((row) => !c.rows.some((other) => other.rowId === row.rowId))).toBe(true);
});

it("retains last-good rows independently across failures and recovery", async () => {
  let aResult = anthropic;
  let cResult = claude;
  const provider = (id: string, get: () => QuotaProviderResult): QuotaProvider => ({
    id,
    cachePolicy: { kind: "uncached" },
    isAvailable: async () => true,
    fetch: async () => get(),
  });
  const providers = [provider("anthropic", () => aResult), provider("claude-agent", () => cResult)];
  const source = createDashboardReadSource({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    workspaceRoot: "C:/synthetic-workspace",
    providers,
    collectProviderResults: async () => [
      { providerId: "anthropic", result: aResult, cacheScope: "anthropic-scope" },
      { providerId: "claude-agent", result: cResult, cacheScope: "claude-scope" },
    ],
    loadConfig: async () => ({
      ...DEFAULT_CONFIG,
      enabledProviders: providers.map((p) => p.id),
      minIntervalMs: 0,
    }),
  });
  const card = (snapshot: Awaited<ReturnType<typeof source.quota>>, id: string) =>
    snapshot.providers.cards.find((item) => item.providerId === id)!;
  const initial = await source.quota();
  cResult = { attempted: true, entries: [], errors: [{ label: "Claude", message: "CLI failed" }] };
  const cFailed = await source.quota();
  expect(card(cFailed, "claude-agent")).toMatchObject({
    stale: true,
    errors: [{ message: "CLI failed" }],
  });
  expect(card(cFailed, "claude-agent").rows).toEqual(card(initial, "claude-agent").rows);
  expect(card(cFailed, "anthropic").stale).toBeUndefined();
  expect(card(cFailed, "anthropic").errors).toEqual([]);

  cResult = claude;
  aResult = {
    attempted: true,
    accounts: anthropic.accounts,
    entries: [],
    errors: [{ sourceId: "open-code", label: "OpenCode", message: "Anthropic failed" }],
  };
  const aFailed = await source.quota();
  expect(card(aFailed, "anthropic")).toMatchObject({
    stale: true,
    errors: [{ message: "Anthropic failed" }],
  });
  expect(card(aFailed, "anthropic").rows).toEqual(card(initial, "anthropic").rows);
  expect(card(aFailed, "claude-agent").stale).toBeUndefined();
  expect(card(aFailed, "claude-agent").errors).toEqual([]);
});

it.each([
  ["a plain failure", { label: "Claude", message: "CLI failed" }],
  ["a rate limit", { label: "Claude", message: "limited", retryable: true, retryAtMs: 9e15 }],
])("keeps last-good quota but never retained saved resets after %s", async (_name, error) => {
  const resets: QuotaToastEntry = {
    kind: "value",
    accounting: {
      resultType: "status",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
    },
    name: "Claude Agent Resets",
    group: "Claude Agent",
    label: "Resets:",
    rowKey: CLAUDE_AGENT_RESETS_ROW_KEY,
    value: "1 available",
    bankedResets: { availableCount: 1, credits: [{ expiresAtIso: "2099-01-01T00:00:00.000Z" }] },
  };
  const window = anthropicQuotaEntries(quota, {
    group: "Claude Agent",
    acquisitionMethod: "remote_api",
  });
  let current: QuotaProviderResult = {
    attempted: true,
    entries: [...window, resets],
    errors: [],
  };
  const provider: QuotaProvider = {
    id: "claude-agent",
    cachePolicy: { kind: "uncached" },
    isAvailable: async () => true,
    fetch: async () => current,
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
    collectProviderResults: async () => [
      { providerId: "claude-agent", result: current, cacheScope: "claude-scope" },
    ],
    loadConfig: async () => ({
      ...DEFAULT_CONFIG,
      enabledProviders: ["claude-agent"],
      minIntervalMs: 0,
    }),
  });
  const rows = async () =>
    (await source.quota()).providers.cards.find((item) => item.providerId === "claude-agent")!.rows;

  const fresh = await rows();
  expect(fresh.some((row) => row.bankedResets?.availableCount === 1)).toBe(true);

  current = { attempted: true, entries: [], errors: [error] };
  const failed = await rows();
  expect(failed.length).toBeGreaterThan(0);
  expect(failed.some((row) => row.bankedResets !== undefined)).toBe(false);
  expect(failed.map((row) => row.label)).toEqual(
    fresh.filter((row) => row.bankedResets === undefined).map((row) => row.label),
  );
});

it("includes the provider id in otherwise identical quota cache keys", () => {
  const ctx = { config: DEFAULT_CONFIG } as QuotaProviderContext;
  const a = buildQuotaProviderStateCacheKey("anthropic", ctx);
  const c = buildQuotaProviderStateCacheKey("claude-agent", ctx);
  expect(a).toMatch(/^anthropic\|/);
  expect(c).toMatch(/^claude-agent\|/);
  expect(a).not.toBe(c);
});
