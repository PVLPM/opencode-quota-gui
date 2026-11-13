import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestTimeoutError } from "../src/lib/http.js";
import { queryOpenAIQuota, type ResolvedOpenAIOAuth } from "../src/lib/openai.js";

const auth = (accessToken: string, accountId: string): ResolvedOpenAIOAuth => ({
  state: "configured",
  sourceKey: "openai",
  accessToken,
  // One login rotates its access token but keeps its refresh token.
  refreshToken: `refresh-of-${accountId}`,
  accountId,
});
const usage = () =>
  new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 60 },
      },
      rate_limit_reset_credits: { available_count: 2 },
    }),
  );
const limited = (retryAfter = "60") =>
  new Response("slow", { status: 429, headers: { "Retry-After": retryAfter } });
const credits = () =>
  new Response(JSON.stringify({ credits: [{ status: "available", title: "Reset" }] }));

describe("OpenAI reset-credit Retry-After cooldown", () => {
  const fetcher = vi.fn();
  const resetCalls = () =>
    fetcher.mock.calls.filter(([url]) => String(url).includes("rate-limit-reset-credits")).length;
  const usageCalls = () => fetcher.mock.calls.length - resetCalls();
  let resetResponse: () => Response;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    fetcher.mockReset();
    resetResponse = () => limited();
    fetcher.mockImplementation(async (url: string) =>
      String(url).includes("rate-limit-reset-credits") ? resetResponse() : usage(),
    );
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps healthy usage data, cools down only the detail endpoint, isolates accounts", async () => {
    const retryAtMs = Date.now() + 60_000;
    const query = (token: string, account: string) =>
      queryOpenAIQuota({ auth: auth(token, account), includeResetDetails: true });

    const first = await query("rc-token-1", "rc-acct-a");
    expect(first).toMatchObject({
      success: true,
      windows: { hourly: { percentRemaining: 90 } },
      bankedResets: { availableCount: 2, credits: [] },
    });
    const second = await query("rc-token-2", "rc-acct-a"); // rotated token, same account
    expect(second).toMatchObject({ success: true, bankedResets: { availableCount: 2 } });
    expect(resetCalls()).toBe(1);
    expect(usageCalls()).toBe(2); // usage itself is never blocked

    resetResponse = () => credits();
    await query("rc-token-3", "rc-acct-b"); // other account is unaffected
    expect(resetCalls()).toBe(2);

    vi.setSystemTime(retryAtMs);
    const resumed = await query("rc-token-1", "rc-acct-a");
    expect(resetCalls()).toBe(3);
    expect(resumed).toMatchObject({ bankedResets: { credits: [{ title: "Reset" }] } });
  });

  it("does not invent a deadline for invalid Retry-After", async () => {
    resetResponse = () => limited("soon");
    await queryOpenAIQuota({ auth: auth("rc-token-x", "rc-acct-x"), includeResetDetails: true });
    await queryOpenAIQuota({ auth: auth("rc-token-x", "rc-acct-x"), includeResetDetails: true });
    expect(resetCalls()).toBe(2);
  });

  it("keeps a captured reset-credit deadline when the timeout is handled", async () => {
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation((url: string) => {
      if (!String(url).includes("rate-limit-reset-credits")) return usage();
      throw new RequestTimeoutError("Request timeout after 1s", retryAtMs);
    });

    const queryWithTimeout = () =>
      queryOpenAIQuota({
        auth: auth("rc-timeout-token", "rc-timeout-account"),
        includeResetDetails: true,
        requestTimeoutMs: 1000,
      });
    expect(await queryWithTimeout()).toMatchObject({
      success: true,
      bankedResets: { availableCount: 2, credits: [] },
    });

    await queryWithTimeout();
    expect(resetCalls()).toBe(1);
  });
});
