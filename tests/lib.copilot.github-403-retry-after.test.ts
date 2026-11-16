import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({ existsSync: vi.fn(() => false), readFileSync: vi.fn() }));
const configDir = vi.hoisted(() =>
  process.platform === "win32" ? "C:\\gh403\\config" : "/gh403/config",
);
const patPath = join(configDir, "copilot-quota-token.json");

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

const forbidden = (headers: Record<string, string>, message = "Forbidden") =>
  new Response(JSON.stringify({ message }), { status: 403, headers });
const oauth = (access: string) => ({ "github-copilot": { type: "oauth", access } }) as never;
const stalledForbidden = (headers: Record<string, string>) => (_url: string, init: RequestInit) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new Error("body aborted")), {
          once: true,
        });
      },
    }),
    { status: 403, headers },
  );

describe("GitHub 403 Retry-After handling", () => {
  const fetcher = vi.fn();
  let run = 0;
  beforeEach(() => {
    run += 1; // cooldowns are module state
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

  it.each([
    [
      "primary limit (x-ratelimit-remaining: 0)",
      { "x-ratelimit-remaining": "0" },
      "API rate limit exceeded",
    ],
    ["secondary rate limit message", {}, "You have exceeded a secondary rate limit."],
  ])("honors a valid Retry-After on a confirmed %s", async (_name, extra, message) => {
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation(async () => forbidden({ ...extra, "Retry-After": "60" }, message));
    const auth = oauth(`gh403-limited-${run}`);
    expect(await queryCopilotQuota({ authData: auth })).toMatchObject({
      success: false,
      failureCategory: "provider_api",
      retryAtMs,
    });
    expect(await queryCopilotQuota({ authData: auth })).toMatchObject({ retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await queryCopilotQuota({ authData: oauth(`gh403-other-${run}`) })).toMatchObject({
      success: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not invent a deadline for a confirmed rate limit without Retry-After", async () => {
    fetcher.mockImplementation(async () => forbidden({ "x-ratelimit-remaining": "0" }));
    const auth = oauth(`gh403-bare-${run}`);
    const result = await queryCopilotQuota({ authData: auth });
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("retryAtMs");
    await queryCopilotQuota({ authData: auth });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("preserves the primary 403 Retry-After deadline when the error body times out", async () => {
    const retryAtMs = Date.now() + 60_000;
    fetcher.mockImplementation(
      stalledForbidden({ "x-ratelimit-remaining": "0", "Retry-After": "60" }),
    );
    const auth = oauth(`gh403-stalled-${run}`);
    const pending = queryCopilotQuota({ authData: auth, requestTimeoutMs: 3000 });

    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({
      success: false,
      error: "Request timeout after 3s",
      failureCategory: "provider_api",
      retryAtMs,
    });

    expect(await queryCopilotQuota({ authData: auth, requestTimeoutMs: 3000 })).toMatchObject({
      retryAtMs,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves the primary 403 deadline on the PAT billing endpoint when its body times out", async () => {
    const retryAtMs = Date.now() + 60_000;
    fsMocks.existsSync.mockImplementation((path) => path === patPath);
    fsMocks.readFileSync.mockReturnValue(
      JSON.stringify({ token: `ghp-stalled-${run}`, tier: "pro", username: "alice" }),
    );
    fetcher.mockImplementation(
      stalledForbidden({ "x-ratelimit-remaining": "0", "Retry-After": "60" }),
    );
    const pending = queryCopilotQuota({ requestTimeoutMs: 3000 });

    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({
      success: false,
      error: "Request timeout after 3s",
      failureCategory: "provider_api",
      retryAtMs,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not use Retry-After from an ordinary 403 whose body times out", async () => {
    fetcher.mockImplementation(stalledForbidden({ "Retry-After": "60" }));
    const auth = oauth(`gh403-ordinary-stalled-${run}`);
    const first = queryCopilotQuota({ authData: auth, requestTimeoutMs: 3000 });

    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).not.toHaveProperty("retryAtMs");

    const second = queryCopilotQuota({ authData: auth, requestTimeoutMs: 3000 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await second).not.toHaveProperty("retryAtMs");
  });

  it("ignores Retry-After on an ordinary 403 permission failure", async () => {
    fetcher.mockImplementation(async () => forbidden({ "Retry-After": "60" }));
    const auth = oauth(`gh403-plain-${run}`);
    const result = await queryCopilotQuota({ authData: auth });
    expect(result).toMatchObject({ success: false, failureCategory: "credentials" });
    expect(result).not.toHaveProperty("retryAtMs");
    await queryCopilotQuota({ authData: auth });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
