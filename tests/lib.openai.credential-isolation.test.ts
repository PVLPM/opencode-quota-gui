import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryOpenAIQuota, type ResolvedOpenAIOAuth } from "../src/lib/openai.js";

// A ChatGPT workspace id is shared by every member, so it never proves identity.
const credential = (
  accessToken: string,
  refreshToken: string | undefined,
  accountId = "iso-shared-workspace",
): ResolvedOpenAIOAuth => ({
  state: "configured",
  sourceKey: "openai",
  accessToken,
  ...(refreshToken ? { refreshToken } : {}),
  accountId,
});
const plan = (request: RequestInit) =>
  String((request.headers as Record<string, string>).Authorization).includes("member-one")
    ? "plus"
    : "pro";
const usage = (request: RequestInit) =>
  new Response(
    JSON.stringify({
      plan_type: plan(request),
      rate_limit: {
        limit_reached: false,
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 60 },
      },
      rate_limit_reset_credits: { available_count: 1 },
    }),
  );
const limited = () => new Response("slow", { status: 429, headers: { "Retry-After": "60" } });

describe("OpenAI per-credential isolation inside one workspace", () => {
  const fetcher = vi.fn();
  const callsTo = (fragment: string) =>
    fetcher.mock.calls.filter(([url]) => String(url).includes(fragment)).length;
  const one = (run: number) => credential(`member-one-${run}`, `refresh-one-${run}`);
  const two = (run: number) => credential(`member-two-${run}`, `refresh-two-${run}`);
  let run = 0;

  beforeEach(() => {
    run += 1; // cooldowns are module state
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not share concurrent results between credentials with the same workspace id", async () => {
    fetcher.mockImplementation(async (_url: string, request: RequestInit) => usage(request));
    const results = await Promise.all([
      queryOpenAIQuota({ auth: one(run) }),
      queryOpenAIQuota({ auth: two(run) }),
    ]);
    expect(results).toMatchObject([
      { success: true, label: "OpenAI (Plus)" },
      { success: true, label: "OpenAI (Pro)" },
    ]);
    expect(callsTo("wham/usage")).toBe(2);
  });

  it("keeps one credential's usage cooldown from blocking another in the workspace", async () => {
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation(async (_url: string, request: RequestInit) =>
      plan(request) === "plus" ? limited() : usage(request),
    );
    expect(await queryOpenAIQuota({ auth: one(run) })).toMatchObject({ retryAtMs });
    expect(await queryOpenAIQuota({ auth: two(run) })).toMatchObject({ success: true });
    // Same credential with a rotated access token stays blocked via its refresh token.
    const rotated = credential(`member-one-rotated-${run}`, `refresh-one-${run}`);
    expect(await queryOpenAIQuota({ auth: rotated })).toMatchObject({ retryAtMs });
    expect(callsTo("wham/usage")).toBe(2);
  });

  it("keeps one credential's reset-detail cooldown from blocking another", async () => {
    fetcher.mockImplementation(async (url: string, request: RequestInit) => {
      if (!String(url).includes("rate-limit-reset-credits")) return usage(request);
      return plan(request) === "plus"
        ? limited()
        : new Response(JSON.stringify({ credits: [{ status: "available", title: "Reset" }] }));
    });
    const query = (auth: ResolvedOpenAIOAuth) =>
      queryOpenAIQuota({ auth, includeResetDetails: true });
    expect(await query(one(run))).toMatchObject({ bankedResets: { credits: [] } });
    expect(await query(two(run))).toMatchObject({
      bankedResets: { credits: [{ title: "Reset" }] },
    });
    await query(one(run));
    expect(callsTo("rate-limit-reset-credits")).toBe(2);
  });

  it("falls back to the access token when there is no refresh token", async () => {
    fetcher.mockImplementation(async (_url: string, request: RequestInit) =>
      plan(request) === "plus" ? limited() : usage(request),
    );
    await queryOpenAIQuota({ auth: credential(`member-one-bare-${run}`, undefined) });
    expect(
      await queryOpenAIQuota({ auth: credential(`member-two-bare-${run}`, undefined) }),
    ).toMatchObject({ success: true });
  });
});
