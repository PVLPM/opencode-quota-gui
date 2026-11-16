import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));
const configDir = vi.hoisted(() =>
  process.platform === "win32" ? "C:\\budget-retry\\config" : "/budget-retry/config",
);

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: fsMocks.existsSync,
  readFileSync: fsMocks.readFileSync,
}));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: configDir,
    configDir,
    cacheDir: configDir,
    stateDir: configDir,
  }),
}));
vi.mock("../src/lib/opencode-auth.js", () => ({ readAuthFile: vi.fn(async () => null) }));

import { queryCopilotQuota } from "../src/lib/copilot.js";

const patPath = join(configDir, "copilot-quota-token.json");
const usage = (netAmount = 0.2) =>
  new Response(
    JSON.stringify({
      timePeriod: { year: 2026, month: 1 },
      usageItems: [
        {
          product: "Copilot AI Credits",
          sku: "AI Credit",
          unitType: "ai-credits",
          grossQuantity: 100,
          discountQuantity: 80,
          netQuantity: 20,
          netAmount,
        },
      ],
    }),
  );
const budgets = () =>
  new Response(
    JSON.stringify({
      budgets: [
        {
          budget_type: "BundlePricing",
          budget_product_sku: "ai_credits",
          budget_scope: "organization",
          budget_amount: 10,
        },
      ],
    }),
  );
const limited = (retryAfter = "60") =>
  new Response('{"message":"slow"}', { status: 429, headers: { "Retry-After": retryAfter } });

describe("Copilot budget Retry-After cooldown", () => {
  const fetcher = vi.fn();
  const budgetCalls = () =>
    fetcher.mock.calls.filter(([url]) => String(url).includes("/budgets")).length;
  const usageCalls = () => fetcher.mock.calls.length - budgetCalls();
  let budgetResponse: () => Response;
  const configure = (token: string, username?: string) => {
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ token, tier: "business", organization: "acme", username }),
    );
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    fsMocks.existsSync.mockReset().mockReturnValue(false);
    fetcher.mockReset();
    budgetResponse = () => limited();
    fetcher.mockImplementation(async (url: string) =>
      String(url).includes("/budgets") ? budgetResponse() : usage(),
    );
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps usage, scopes the warning, cools down only the budget endpoint, isolates tokens", async () => {
    const retryAtMs = Date.now() + 60_000;
    configure("bud-token-a");
    const first = await queryCopilotQuota();
    expect(first).toMatchObject({
      success: true,
      used: 100,
      warnings: [expect.stringContaining("429")],
    });
    expect((first as { budget?: unknown }).budget).toBeUndefined();

    const second = await queryCopilotQuota();
    expect(second).toMatchObject({
      success: true,
      used: 100,
      warnings: [expect.stringContaining(new Date(retryAtMs).toISOString())],
    });
    expect(budgetCalls()).toBe(1);
    expect(usageCalls()).toBe(2);

    budgetResponse = () => budgets();
    configure("bud-token-b");
    expect(await queryCopilotQuota()).toMatchObject({ budget: { amountUsd: 10 } });
    expect(budgetCalls()).toBe(2);

    configure("bud-token-a");
    vi.setSystemTime(retryAtMs);
    expect(await queryCopilotQuota()).toMatchObject({ budget: { amountUsd: 10 } });
    expect(budgetCalls()).toBe(3);
  });

  it("does not invent a deadline for invalid Retry-After", async () => {
    budgetResponse = () => limited("soon");
    configure("bud-token-x");
    await queryCopilotQuota();
    await queryCopilotQuota();
    expect(budgetCalls()).toBe(2);
  });

  it("does not share in-flight usage or budgets across different query filters", async () => {
    const budgetResolutions: Array<(response: Response) => void> = [];
    fetcher.mockImplementation((url: string) => {
      const requestUrl = new URL(url);
      if (requestUrl.pathname.includes("/budgets")) {
        return new Promise<Response>((resolve) => budgetResolutions.push(resolve));
      }
      return usage(requestUrl.searchParams.get("user") === "alice" ? 0.2 : 0.8);
    });

    configure("shared-pat", "alice");
    const alice = queryCopilotQuota();
    configure("shared-pat", "bob");
    const bob = queryCopilotQuota();

    await vi.advanceTimersByTimeAsync(0);
    const usageRequestCount = usageCalls();
    const budgetRequestCount = budgetCalls();
    for (const resolve of budgetResolutions) resolve(budgets());
    const [aliceResult, bobResult] = await Promise.all([alice, bob]);

    expect(usageRequestCount).toBe(2);
    expect(budgetRequestCount).toBe(2);
    const budgetUsers = fetcher.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes("/budgets"))
      .map((url) => new URL(url).searchParams.get("user"));
    expect(budgetUsers).toEqual(expect.arrayContaining(["alice", "bob"]));
    expect(aliceResult).toMatchObject({ budget: { spentUsd: 0.2 } });
    expect(bobResult).toMatchObject({ budget: { spentUsd: 0.8 } });
  });
});
