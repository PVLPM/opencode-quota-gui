import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

const mocks = vi.hoisted(() => ({
  queryOpenCodeZenQuota: vi.fn(),
  resolveOpenCodeConsoleAuth: vi.fn(),
  fetchResponse: vi.fn(),
  realQueryOpenCodeZenQuota: null as
    | null
    | typeof import("../src/lib/opencode-zen.js").queryOpenCodeZenQuota,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    url: string,
    options: { consume: (response: Response) => Promise<unknown> },
  ) => {
    const response = await mocks.fetchResponse(url);
    return await options.consume(response);
  },
}));

vi.mock("../src/lib/opencode-zen.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-zen.js")>();
  mocks.realQueryOpenCodeZenQuota = original.queryOpenCodeZenQuota;
  return {
    ...original,
    queryOpenCodeZenQuota: mocks.queryOpenCodeZenQuota,
  };
});

vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuth: mocks.resolveOpenCodeConsoleAuth,
}));

import { opencodeZenProvider } from "../src/providers/opencode-zen.js";

const balanceAccounting = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;
const budgetAccounting = {
  ...balanceAccounting,
  resultType: "budget",
  authority: "locally_derived",
} as const;
const statusAccounting = {
  ...balanceAccounting,
  resultType: "status",
} as const;

const consoleCredential = {
  accessToken: "st_secret-token",
  orgId: "wrk_123",
  orgName: "Acme",
};

function balanceEntry(prominence: "primary" | "supplementary") {
  return {
    accounting: balanceAccounting,
    kind: "quantity",
    name: "zen-current-balance",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "current_balance" },
      prominence,
    },
    quantity: { decimal: "42.5", unit: { kind: "currency", code: "USD" } },
  } as const;
}

function autoReloadEntry(value = false) {
  return {
    accounting: statusAccounting,
    kind: "boolean",
    name: "zen-auto-reload",
    group: "OpenCode Zen",
    semantic: {
      metric: { kind: "component", component: "auto_reload" },
      prominence: "supplementary",
    },
    value,
  } as const;
}

function budgetEntry(
  options: {
    percentRemaining?: number;
    used?: string;
    limit?: string;
    remaining?: string;
    limitAuthority?: "provider_reported" | "user_configured";
    resetTimeIso?: string;
  } = {},
) {
  return {
    accounting: budgetAccounting,
    name: "zen-monthly-budget",
    group: "OpenCode Zen",
    percentRemaining: options.percentRemaining ?? 94.25,
    ...(options.resetTimeIso ? { resetTimeIso: options.resetTimeIso } : {}),
    semantic: {
      metric: { kind: "window", window: "month" },
      prominence: "primary",
    },
    basis: {
      used: {
        quantity: {
          decimal: options.used ?? "5.75",
          unit: { kind: "currency", code: "USD" },
        },
        authority: "provider_reported",
      },
      limit: {
        quantity: {
          decimal: options.limit ?? "100",
          unit: { kind: "currency", code: "USD" },
        },
        authority: options.limitAuthority ?? "provider_reported",
      },
      remaining: {
        quantity: {
          decimal: options.remaining ?? "94.25",
          unit: { kind: "currency", code: "USD" },
        },
        authority: "locally_derived",
      },
    },
  } as const;
}

const LOGIN_HINT = "Run `opencode auth login opencode`.";

function configured(credential: Record<string, unknown> = consoleCredential): void {
  mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({ state: "configured", credential });
}

function success(overrides: Record<string, unknown> = {}, errors: string[] = []): void {
  mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
    success: true,
    errors,
    data: {
      balance: 4_250_000_000,
      monthlyLimit: null,
      monthlyUsage: null,
      lastPayment: null,
      reload: false,
      reloadAmount: null,
      reloadTrigger: null,
      budgetResetIso: null,
      budgetSource: "credit_limit",
      memberBudgetsSkipped: false,
      ...overrides,
    },
  });
}

function context(config: Record<string, unknown> = {}): any {
  return { config };
}

describe("opencode Zen provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the original canonical provider id", () => {
    expect(opencodeZenProvider.id).toBe("opencode");
  });

  it.each([
    [{ state: "configured", credential: consoleCredential }, "auto", true],
    [{ state: "configured", credential: consoleCredential }, ["opencode"], true],
    [{ state: "expired", credential: consoleCredential }, "auto", true],
    [{ state: "expired", credential: consoleCredential }, ["opencode"], true],
    [{ state: "invalid", error: "refresh_failed: boom" }, "auto", true],
    [{ state: "invalid", error: "refresh_failed: boom" }, ["opencode"], true],
    [{ state: "none" }, "auto", false],
    [{ state: "none" }, ["opencode"], true],
    [{ state: "none" }, ["openai"], false],
    [{ state: "none", reason: "not_oauth" }, "auto", false],
    [{ state: "none", reason: "not_oauth" }, ["opencode"], true],
  ])("reports availability for %j with enabledProviders %j -> %j", async (resolution, enabledProviders, expected) => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce(resolution);
    await expect(opencodeZenProvider.isAvailable(context({ enabledProviders }))).resolves.toBe(
      expected,
    );
  });

  it.each([
    ["opencode/gpt-5", true],
    ["opencode-zen/claude-opus", true],
    ["OPENCODE/gemini", true],
    ["openai/gpt-5", false],
    ["opencode-go/model", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeZenProvider.matchesCurrentModel?.(model)).toBe(expected);
  });

  it.each([
    { state: "none" },
    { state: "none", reason: "not_oauth" },
  ])("returns attempted:false in auto mode without a Console sign-in (%j)", async (resolution) => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce(resolution);

    const result = await opencodeZenProvider.fetch(context({ enabledProviders: "auto" }));

    expectNotAttempted(result);
    expect(result.statusDetails).toEqual([{ key: "console_auth_state", value: "none" }]);
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("shows the sign-in hint when Zen is explicitly enabled without a Console sign-in", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({ state: "none", reason: "not_oauth" });

    const result = await opencodeZenProvider.fetch(context({ enabledProviders: ["opencode"] }));

    expectAttemptedWithErrorLabel(result, "OpenCode Zen");
    expect(result.errors).toEqual([
      { label: "OpenCode Zen", message: `No OpenCode Console sign-in found. ${LOGIN_HINT}` },
    ]);
    expect(result.statusDetails).toEqual([{ key: "console_auth_state", value: "none" }]);
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("shows a failed Console sign-in as an attempted error with the scrubbed reason", async () => {
    const leakedToken = "a".repeat(40);
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "invalid",
      error: `refresh_failed: token ${leakedToken} was rejected`,
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode Zen");
    expect(result.errors).toEqual([
      {
        label: "OpenCode Zen",
        message: `OpenCode Console sign-in failed: refresh_failed: token [redacted] was rejected. ${LOGIN_HINT}`,
      },
    ]);
    expect(result.statusDetails).toEqual([{ key: "console_auth_state", value: "invalid" }]);
    expect(JSON.stringify(result)).not.toContain(leakedToken);
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("shows an expired Console sign-in as an attempted error", async () => {
    mocks.resolveOpenCodeConsoleAuth.mockResolvedValueOnce({
      state: "expired",
      credential: consoleCredential,
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode Zen");
    expect(result.errors).toEqual([
      {
        label: "OpenCode Zen",
        message: `OpenCode Console sign-in failed: the sign-in expired. ${LOGIN_HINT}`,
      },
    ]);
    expect(result.statusDetails).toEqual([{ key: "console_auth_state", value: "expired" }]);
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
    expect(mocks.queryOpenCodeZenQuota).not.toHaveBeenCalled();
  });

  it("projects Console failures as attempted errors", async () => {
    configured();
    mocks.queryOpenCodeZenQuota.mockResolvedValueOnce({
      success: false,
      error:
        "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.",
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithErrorLabel(result, "OpenCode Zen");
    expect(result.errors[0]?.message).toContain("opencode auth login opencode");
  });

  it("reports the Console server and org but never the token", async () => {
    configured({ accessToken: "st_secret-token", server: "https://console.self-hosted.example" });
    success();

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.statusDetails.slice(0, 3)).toEqual([
      { key: "console_auth_state", value: "configured" },
      { key: "console_server", value: "https://console.self-hosted.example" },
      { key: "console_org", value: "(none)" },
    ]);
    expect(JSON.stringify(result)).not.toContain("st_secret-token");
  });

  it("makes structured balance primary when no monthly budget is available", async () => {
    configured();
    success();

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
    expect(result.presentation).toBeUndefined();
  });

  it("shows current-month spend next to the balance when there is no monthly limit", async () => {
    configured();
    success({ monthlyLimit: null, monthlyUsage: 1_182_020_000 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      {
        accounting: { ...balanceAccounting, resultType: "spend" },
        kind: "quantity",
        name: "zen-monthly-spend",
        group: "OpenCode Zen",
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        quantity: { decimal: "11.8202", unit: { kind: "currency", code: "USD" } },
      },
      balanceEntry("primary"),
      autoReloadEntry(),
    ]);
    expect(result.statusDetails).toContainEqual({
      key: "monthly_usage_usd",
      value: "USD 11.8202",
    });
  });

  it("calculates monthly-limit remaining from monthly usage (default display)", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 575_000_000 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry(),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(result.statusDetails).toEqual([
      { key: "console_auth_state", value: "configured" },
      { key: "console_server", value: "https://opencode.ai/console" },
      { key: "console_org", value: "Acme" },
      { key: "balance_usd", value: "USD 42.5" },
      { key: "monthly_limit_usd", value: "USD 100" },
      { key: "monthly_usage_usd", value: "USD 5.75" },
      { key: "budget_source", value: "credit_limit" },
      { key: "auto_reload", value: "false" },
      { key: "auto_reload_amount_raw", value: "(none)" },
      { key: "auto_reload_trigger_raw", value: "(none)" },
    ]);
  });

  it("does not project a last payment status detail", async () => {
    configured();
    success({ lastPayment: 50 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.statusDetails.some((d) => d.key === "last_payment_usd")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("last_payment_usd");
  });

  it("emits only the contract-backed reload boolean and keeps ambiguous values diagnostic", async () => {
    configured();
    success({
      monthlyLimit: 100,
      monthlyUsage: 575_000_000,
      reload: true,
      reloadAmount: 20,
      reloadTrigger: 5,
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry(),
      balanceEntry("supplementary"),
      autoReloadEntry(true),
    ]);
    expect(
      result.entries.some(
        (entry) =>
          entry.semantic?.metric.kind === "component" &&
          (entry.semantic.metric.component === "auto_reload_amount" ||
            entry.semantic.metric.component === "auto_reload_trigger"),
      ),
    ).toBe(false);
    expect(result.statusDetails).toContainEqual({ key: "auto_reload_amount_raw", value: "20" });
    expect(result.statusDetails).toContainEqual({ key: "auto_reload_trigger_raw", value: "5" });
    expect(result.presentation).toBeUndefined();
  });

  it("attaches the member budget reset date to the monthly budget entry", async () => {
    configured();
    success({
      monthlyLimit: 60,
      monthlyUsage: 617_355_570,
      budgetResetIso: "2026-10-01T00:00:00.000Z",
      budgetSource: "member_budget",
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: Math.min(100, ((60 - 6.1735557) / 60) * 100),
        used: "6.1735557",
        limit: "60",
        remaining: "53.8264443",
        resetTimeIso: "2026-10-01T00:00:00.000Z",
      }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(result.statusDetails).toContainEqual({ key: "budget_source", value: "member_budget" });
    expect(result.statusDetails.some((d) => d.key === "member_budget_note")).toBe(false);
  });

  it("uses the credit limit without an error when member budgets cannot all be evaluated", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 575_000_000, memberBudgetsSkipped: true });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry(),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(result.statusDetails).toContainEqual({ key: "budget_source", value: "credit_limit" });
    expect(result.statusDetails).toContainEqual({
      key: "member_budget_note",
      value:
        "member budgets found, but not all can be evaluated (model filters, per-model limits, or missing amounts); using the credit limit",
    });
    expect(result.statusDetails.some((d) => d.key === "live_fetch_error")).toBe(false);
  });

  it("projects a member $0 budget as a blocking 0% budget, not a spend row", async () => {
    configured();
    success({
      monthlyLimit: 0,
      monthlyUsage: 0,
      budgetSource: "member_budget",
    });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({ percentRemaining: 0, used: "0", limit: "0", remaining: "0" }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(JSON.stringify(result)).not.toContain("NaN");
    expect(result.statusDetails).toContainEqual({
      key: "monthly_limit_usd",
      value: "USD 0",
    });
    expect(result.statusDetails).toContainEqual({ key: "budget_source", value: "member_budget" });
  });

  it("parses the policies/members shape in the real query pipeline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    configured({ ...consoleCredential, accountId: "usr_me" });
    // Run the real query pipeline against a fake HTTP layer serving the actual
    // member-detail response shape (dollar amounts, no reset date).
    mocks.fetchResponse.mockImplementation((url: string) => {
      const route = url.slice("https://opencode.ai/console/api/".length);
      const payloads: Record<string, unknown> = {
        "billing/status": { balanceMicroCents: "4250000000" },
        "billing/account": { orgId: "wrk_123", creditLimitMicroCents: null },
        "billing/auto-recharge": {
          enabled: false,
          thresholdDollars: 5,
          rechargeAmountDollars: 20,
          pending: false,
          failureReason: null,
        },
        "policies/members/usr_me": {
          userID: "usr_me",
          budgets: [
            {
              policyID: "pol_1",
              ruleID: "rule_1",
              scope: "combined",
              limitDollars: 60,
              spentDollars: 6.1735557,
            },
          ],
          policies: [
            {
              id: "pol_1",
              rules: [
                {
                  id: "rule_1",
                  kind: "budget",
                  period: "month",
                  scope: "combined",
                  per: "set",
                  limitDollars: 60,
                  spentDollars: 6.1735557,
                  selector: { includeUnknownPrice: false },
                },
              ],
            },
          ],
        },
        "usage/cost-by-day": [],
      };
      const payload = payloads[route];
      if (payload === undefined) throw new Error(`unexpected url ${url}`);
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    if (!mocks.realQueryOpenCodeZenQuota) throw new Error("real query not captured");
    const realQuery = mocks.realQueryOpenCodeZenQuota;
    mocks.queryOpenCodeZenQuota.mockImplementation(
      (credential: typeof consoleCredential, opts?: { requestTimeoutMs?: number }) =>
        realQuery(credential, opts),
    );

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toMatchObject({
      percentRemaining: Math.min(100, ((60 - 6.1735557) / 60) * 100),
      basis: {
        used: { quantity: { decimal: "6.1735557" } },
        limit: { quantity: { decimal: "60" } },
      },
    });
    // Console monthly budgets reset at the start of the next UTC month.
    expect(result.entries[0].resetTimeIso).toBe("2026-10-01T00:00:00.000Z");
    expect(result.statusDetails).toContainEqual({ key: "budget_source", value: "member_budget" });
  });

  it("prefers the positive plugin monthly-limit override", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 575_000_000 });

    const result = await opencodeZenProvider.fetch(context({ opencodeMonthlyLimit: 200 }));

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: 97.125,
        limit: "200",
        remaining: "194.25",
        limitAuthority: "user_configured",
      }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
  });

  it("keeps the balance and reports failed optional Console routes", async () => {
    configured();
    success({ reload: null }, [
      "OpenCode Console billing/auto-recharge error 500",
      "OpenCode Console usage/cost-by-day error 500",
    ]);

    const result = await opencodeZenProvider.fetch(context());

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([balanceEntry("primary")]);
    expect(result.errors).toEqual([
      { label: "OpenCode Zen", message: "OpenCode Console billing/auto-recharge error 500" },
      { label: "OpenCode Zen", message: "OpenCode Console usage/cost-by-day error 500" },
    ]);
    expect(result.statusDetails).toContainEqual({ key: "auto_reload", value: "(unknown)" });
    expect(result.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value:
        "OpenCode Console billing/auto-recharge error 500 | OpenCode Console usage/cost-by-day error 500",
    });
  });

  it("uses the plugin monthly limit when the Console credit-limit request fails", async () => {
    configured();
    success({ monthlyLimit: null, monthlyUsage: 575_000_000 }, [
      "OpenCode Console billing/account error 500",
    ]);

    const result = await opencodeZenProvider.fetch(context({ opencodeMonthlyLimit: 200 }));

    expect(result.entries).toEqual([
      budgetEntry({
        percentRemaining: 97.125,
        limit: "200",
        remaining: "194.25",
        limitAuthority: "user_configured",
      }),
      balanceEntry("supplementary"),
      autoReloadEntry(),
    ]);
    expect(result.errors).toEqual([
      { label: "OpenCode Zen", message: "OpenCode Console billing/account error 500" },
    ]);
  });

  it("does not treat the last payment as a monthly limit", async () => {
    configured();
    success({ lastPayment: 50 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
  });

  it("uses structured balance when monthly usage is unavailable", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: null });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
  });

  it("uses structured balance for a zero page limit instead of emitting NaN", async () => {
    configured();
    success({ monthlyLimit: 0 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries).toEqual([balanceEntry("primary"), autoReloadEntry()]);
    expect(JSON.stringify(result)).not.toContain("NaN");
  });

  it("clamps monthly usage above the limit to zero remaining", async () => {
    configured();
    success({ monthlyLimit: 100, monthlyUsage: 20_000_000_000 });

    const result = await opencodeZenProvider.fetch(context());

    expectAttemptedWithNoErrors(result);
    expect(result.entries[0]).toEqual(
      budgetEntry({ percentRemaining: 0, used: "200", remaining: "0" }),
    );
  });

  it("passes a user-configured timeout and otherwise keeps the Console default", async () => {
    configured();
    success();
    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 7_654, requestTimeoutMsConfigured: true }),
    );
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenLastCalledWith(consoleCredential, {
      requestTimeoutMs: 7_654,
    });

    configured();
    success();
    await opencodeZenProvider.fetch(
      context({ requestTimeoutMs: 5_000, requestTimeoutMsConfigured: false }),
    );
    expect(mocks.queryOpenCodeZenQuota).toHaveBeenLastCalledWith(consoleCredential, {
      requestTimeoutMs: undefined,
    });
  });
});
