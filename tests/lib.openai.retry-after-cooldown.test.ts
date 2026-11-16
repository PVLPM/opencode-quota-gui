import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryOpenAIQuota, type ResolvedOpenAIOAuth } from "../src/lib/openai.js";

const auth = (accessToken: string, accountId?: string): ResolvedOpenAIOAuth => ({
  state: "configured",
  sourceKey: "openai",
  accessToken,
  // One login rotates its access token but keeps its refresh token.
  refreshToken: `refresh-of-${accountId ?? accessToken}`,
  ...(accountId ? { accountId } : {}),
});
const limited = (retryAfter = "60") =>
  new Response('{"error":{"code":"rate_limited"}}', {
    status: 429,
    headers: { "Retry-After": retryAfter },
  });
const usage = () =>
  new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 60 },
      },
    }),
  );

describe("OpenAI Retry-After cooldown", () => {
  const fetcher = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("surfaces the deadline, blocks per account (even across token rotation), and resumes", async () => {
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation(async () => limited());

    const results = await Promise.all([
      queryOpenAIQuota({ auth: auth("oa-token-1", "oa-acct-a") }),
      queryOpenAIQuota({ auth: auth("oa-token-1", "oa-acct-a") }),
    ]);
    expect(results).toMatchObject([
      { success: false, retryAtMs },
      { success: false, retryAtMs },
    ]);
    // Rotated access token for the same account stays blocked.
    expect(await queryOpenAIQuota({ auth: auth("oa-token-2", "oa-acct-a") })).toMatchObject({
      success: false,
      retryAtMs,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockImplementation(async () => usage());
    expect(await queryOpenAIQuota({ auth: auth("oa-token-3", "oa-acct-b") })).toMatchObject({
      success: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.setSystemTime(retryAtMs);
    expect(await queryOpenAIQuota({ auth: auth("oa-token-1", "oa-acct-a") })).toMatchObject({
      success: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("does not invent or enforce a deadline for invalid Retry-After", async () => {
    fetcher.mockImplementation(async () => limited("soon"));
    const result = await queryOpenAIQuota({ auth: auth("oa-token-x", "oa-acct-x") });
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("retryAtMs");
    await queryOpenAIQuota({ auth: auth("oa-token-x", "oa-acct-x") });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a 429 deadline when the error body stalls until the bounded timeout", async () => {
    const retryAtMs = Date.now() + 60_000;
    let requestSignal: AbortSignal | undefined;
    fetcher.mockImplementation((_url: string | URL | Request, request?: RequestInit) => {
      requestSignal = request?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          requestSignal?.addEventListener("abort", () => {
            controller.error(new Error("body aborted"));
          });
        },
      });
      return Promise.resolve(new Response(body, { status: 429, headers: { "Retry-After": "60" } }));
    });

    const result = queryOpenAIQuota({
      auth: auth("oa-timeout-token", "oa-timeout-account"),
      requestTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ success: false, retryAtMs });
    expect(requestSignal?.aborted).toBe(true);

    await queryOpenAIQuota({
      auth: auth("oa-timeout-token", "oa-timeout-account"),
      requestTimeoutMs: 1000,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
