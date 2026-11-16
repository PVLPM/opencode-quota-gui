import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { queryMimoDashboard } from "../src/lib/mimo.js";
import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../src/lib/opencode-go.js";
import { queryOpenCodeZenQuota } from "../src/lib/opencode-zen.js";
import { queryXaiQuota } from "../src/lib/xai.js";

const limited = (retryAfter?: string) =>
  new Response("slow down", {
    status: 429,
    ...(retryAfter ? { headers: { "Retry-After": retryAfter } } : {}),
  });

const stalledLimited = (retryAfter: string, signal?: AbortSignal) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
          once: true,
        });
      },
    }),
    { status: 429, headers: { "Retry-After": retryAfter } },
  );

describe("direct adapter Retry-After cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("xAI: per-token cooldown, coalesced, expires at the deadline", async () => {
    const fetcher = vi.fn(async () => limited("60"));
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    const auth = (accessToken: string) => ({ state: "configured" as const, accessToken });
    expect(
      await Promise.all([queryXaiQuota({ auth: auth("xa") }), queryXaiQuota({ auth: auth("xa") })]),
    ).toMatchObject([
      { success: false, retryAtMs },
      { success: false, retryAtMs },
    ]);
    expect(await queryXaiQuota({ auth: auth("xa") })).toMatchObject({ success: false, retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await queryXaiQuota({ auth: auth("xb") });
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(retryAtMs);
    await queryXaiQuota({ auth: auth("xa") });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("xAI: no deadline is invented without a valid Retry-After", async () => {
    const fetcher = vi.fn(async () => limited());
    vi.stubGlobal("fetch", fetcher);
    const auth = { state: "configured" as const, accessToken: "xc" };
    const first = await queryXaiQuota({ auth });
    expect(first && !first.success ? first.retryAtMs : "x").toBeUndefined();
    await queryXaiQuota({ auth });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("xAI: a stalled credits error body preserves its 429 deadline", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      stalledLimited("60", init.signal ?? undefined),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    const auth = { state: "configured" as const, accessToken: "xai-body-stall" };

    const firstRequest = queryXaiQuota({ auth, requestTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(firstRequest).resolves.toMatchObject({ success: false, retryAtMs });

    await expect(queryXaiQuota({ auth, requestTimeoutMs: 10 })).resolves.toMatchObject({
      success: false,
      retryAtMs,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("xAI: optional subscription 429 cools down independently of healthy credits", async () => {
    const subscriptionUrl = "https://grok.com/rest/subscriptions";
    const fetcher = vi.fn(async (url: string) =>
      url === subscriptionUrl
        ? limited("60")
        : new Response(
            JSON.stringify({
              config: {
                currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
                creditUsagePercent: 5,
              },
            }),
          ),
    );
    vi.stubGlobal("fetch", fetcher);
    const auth = { state: "configured" as const, accessToken: "xai-optional-429" };

    await expect(queryXaiQuota({ auth })).resolves.toMatchObject({
      success: true,
      label: "xAI SuperGrok",
      window: { percentRemaining: 95 },
    });
    await expect(queryXaiQuota({ auth })).resolves.toMatchObject({
      success: true,
      label: "xAI SuperGrok",
      window: { percentRemaining: 95 },
    });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([url]) => url === subscriptionUrl)).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([url]) => url !== subscriptionUrl)).toHaveLength(2);
  });

  it("OpenCode Go API key: per-key cooldown", async () => {
    const fetcher = vi.fn(async () => limited("60"));
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    expect(await queryOpenCodeGoQuota("go-a")).toMatchObject({ success: false, retryAtMs });
    expect(await queryOpenCodeGoQuota("go-a")).toMatchObject({ success: false, retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await queryOpenCodeGoQuota("go-b");
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.setSystemTime(retryAtMs);
    await queryOpenCodeGoQuota("go-a");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("OpenCode Go Console: cooldown isolates token and workspace", async () => {
    const fetcher = vi.fn(async () => limited("60"));
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    const cred = { accessToken: "tok", orgId: "org1" };
    expect(await queryOpenCodeGoConsoleStatus(cred)).toMatchObject({ success: false, retryAtMs });
    expect(await queryOpenCodeGoConsoleStatus({ ...cred })).toMatchObject({ retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await queryOpenCodeGoConsoleStatus({ ...cred, orgId: "org2" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await queryOpenCodeGoConsoleStatus({ accessToken: "tok2", orgId: "org1" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    vi.setSystemTime(retryAtMs);
    await queryOpenCodeGoConsoleStatus(cred);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  describe("OpenCode Zen", () => {
    const cred = (orgId: string) => ({ accessToken: "zen-tok", orgId });

    it("required route 429 fails the query and blocks until the deadline", async () => {
      const fetcher = vi.fn(async () => limited("60"));
      vi.stubGlobal("fetch", fetcher);
      const retryAtMs = Date.now() + 60_000;
      expect(await queryOpenCodeZenQuota(cred("z1"))).toMatchObject({
        success: false,
        retryAtMs,
      });
      const afterFirst = fetcher.mock.calls.length;
      expect(await queryOpenCodeZenQuota(cred("z1"))).toMatchObject({ success: false, retryAtMs });
      expect(fetcher).toHaveBeenCalledTimes(afterFirst);
      await queryOpenCodeZenQuota(cred("z2"));
      expect(fetcher.mock.calls.length).toBeGreaterThan(afterFirst);
      const afterOther = fetcher.mock.calls.length;
      vi.setSystemTime(retryAtMs);
      await queryOpenCodeZenQuota(cred("z1"));
      expect(fetcher.mock.calls.length).toBeGreaterThan(afterOther);
    });

    it("billing-only 429: first attempt is concurrent, the blocked repeat sends nothing", async () => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/billing/status")
          ? limited("60")
          : new Response(JSON.stringify({})),
      );
      vi.stubGlobal("fetch", fetcher);
      const retryAtMs = Date.now() + 60_000;
      expect(await queryOpenCodeZenQuota(cred("z4"))).toMatchObject({ success: false, retryAtMs });
      const firstAttempt = fetcher.mock.calls.length;
      expect(firstAttempt).toBeGreaterThan(1);
      expect(await queryOpenCodeZenQuota(cred("z4"))).toMatchObject({ success: false, retryAtMs });
      expect(fetcher).toHaveBeenCalledTimes(firstAttempt);
    });

    it("an optional-route session error still wins over a non-429 billing failure", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) =>
          String(input).endsWith("/billing/status")
            ? new Response("boom", { status: 500 })
            : new Response("no", { status: 401 }),
        ),
      );
      expect(await queryOpenCodeZenQuota(cred("z5"))).toMatchObject({
        success: false,
        failureCategory: "credentials",
        error: expect.stringContaining("session expired"),
      });
    });

    it("optional route 429 keeps success, carries the deadline, and stops re-requesting that route", async () => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/billing/status")
          ? new Response(JSON.stringify({ balanceMicroCents: "100000000" }))
          : limited("60"),
      );
      vi.stubGlobal("fetch", fetcher);
      const retryAtMs = Date.now() + 60_000;
      const first = await queryOpenCodeZenQuota(cred("z3"));
      expect(first).toMatchObject({
        success: true,
        optionalErrors: expect.arrayContaining([expect.objectContaining({ retryAtMs })]),
      });
      const statusCalls = () =>
        fetcher.mock.calls.filter(([url]) => String(url).endsWith("/billing/status")).length;
      const optionalCalls = () => fetcher.mock.calls.length - statusCalls();
      const optionalBefore = optionalCalls();
      const second = await queryOpenCodeZenQuota(cred("z3"));
      expect(second).toMatchObject({ success: true });
      expect(statusCalls()).toBe(2);
      expect(optionalCalls()).toBe(optionalBefore);
    });
  });

  it("MiMo: per-cookie, per-endpoint cooldown surfaces retryAtMs", async () => {
    const fetcher = vi.fn(async () => limited("60"));
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    const first = await queryMimoDashboard("cookie=a");
    for (const endpoint of [first.usage, first.detail, first.balance]) {
      expect(endpoint).toMatchObject({ state: "error", retryAtMs });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
    const second = await queryMimoDashboard("cookie=a");
    expect(second.usage).toMatchObject({ state: "error", retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await queryMimoDashboard("cookie=b");
    expect(fetcher).toHaveBeenCalledTimes(6);
    vi.setSystemTime(retryAtMs);
    await queryMimoDashboard("cookie=a");
    expect(fetcher).toHaveBeenCalledTimes(9);
  });
});
