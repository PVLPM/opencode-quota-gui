import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));
const configDir = vi.hoisted(() =>
  process.platform === "win32" ? "C:\\retry-after\\config" : "/retry-after/config",
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

const oauth = (access: string) => ({ "github-copilot": { type: "oauth", access } }) as never;
const limited = (retryAfter = "60") =>
  new Response('{"message":"slow"}', { status: 429, headers: { "Retry-After": retryAfter } });
const user = () =>
  new Response(
    JSON.stringify({
      copilot_plan: "pro",
      quota_snapshots: {
        premium_interactions: { entitlement: 100, remaining: 50, percent_remaining: 50 },
      },
    }),
  );

describe("Copilot Retry-After cooldown", () => {
  const fetcher = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    fsMocks.existsSync.mockReset().mockReturnValue(false);
    fetcher.mockReset();
    vi.stubGlobal("fetch", fetcher);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("OAuth: surfaces the deadline, isolates tokens, and resumes at the deadline", async () => {
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation(async () => limited());
    const results = await Promise.all([
      queryCopilotQuota({ authData: oauth("cp-oauth-a") }),
      queryCopilotQuota({ authData: oauth("cp-oauth-a") }),
    ]);
    expect(results).toMatchObject([
      { success: false, retryAtMs },
      { success: false, retryAtMs },
    ]);
    expect(await queryCopilotQuota({ authData: oauth("cp-oauth-a") })).toMatchObject({
      success: false,
      retryAtMs,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    fetcher.mockImplementation(async () => user());
    expect(await queryCopilotQuota({ authData: oauth("cp-oauth-b") })).toMatchObject({
      success: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.setSystemTime(retryAtMs);
    expect(await queryCopilotQuota({ authData: oauth("cp-oauth-a") })).toMatchObject({
      success: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("PAT: honors a billing-report 429 deadline", async () => {
    const patPath = join(configDir, "copilot-quota-token.json");
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ token: "cp-pat-a", tier: "pro", username: "octo" }),
    );
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation(async () => limited());
    expect(await queryCopilotQuota()).toMatchObject({ success: false, retryAtMs });
    expect(await queryCopilotQuota()).toMatchObject({ success: false, retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not invent or enforce a deadline for invalid Retry-After", async () => {
    fetcher.mockImplementation(async () => limited("soon"));
    const result = await queryCopilotQuota({ authData: oauth("cp-oauth-x") });
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("retryAtMs");
    await queryCopilotQuota({ authData: oauth("cp-oauth-x") });
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

    const result = queryCopilotQuota({
      authData: oauth("cp-timeout-token"),
      requestTimeoutMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ success: false, retryAtMs });
    expect(requestSignal?.aborted).toBe(true);

    await queryCopilotQuota({ authData: oauth("cp-timeout-token"), requestTimeoutMs: 1000 });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
