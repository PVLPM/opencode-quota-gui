import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
  fetchResponse: vi.fn(),
  cached: new Map<string, { accessToken: string }>(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({ readAuthFileCached: mocks.readAuthFileCached }));
vi.mock("../src/lib/api-key-resolver.js", () => ({
  readGlobalProviderConfigString: vi.fn(async () => undefined),
}));
vi.mock("../src/lib/http.js", async (importOriginal) => {
  const http = await importOriginal<typeof import("../src/lib/http.js")>();
  return {
    ...http,
    fetchWithTimeout: (url: string, options: Parameters<typeof http.fetchWithTimeout>[1]) =>
      http.fetchWithTimeout(url, {
        ...options,
        fetchFn: (requestUrl, request) => mocks.fetchResponse(requestUrl, request),
      }),
  };
});
vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: async ({ key }: { key: string }) => mocks.cached.get(key) ?? null,
  makeAccountCacheKey: ({ projectId }: { projectId: string }) => `cache-${projectId}`,
  setCachedAccessToken: vi.fn(),
}));
vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: vi.fn(),
  clearAgyCompanionCacheForTests: vi.fn(),
  resolveAgyClientCredentials: vi.fn(async () => ({
    state: "configured",
    clientId: "client-id",
    clientSecret: "client-secret",
  })),
}));
vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: vi.fn(),
  clearGeminiCliCompanionCacheForTests: vi.fn(),
  resolveGeminiCliClientCredentials: vi.fn(async () => ({
    state: "configured",
    clientId: "client-id",
    clientSecret: "client-secret",
  })),
}));

import { queryGoogleAgyQuota } from "../src/lib/google-agy.js";
import { queryGeminiCliQuota } from "../src/lib/google-gemini-cli.js";

const agyQuota = () =>
  new Response(
    JSON.stringify({
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [{ bucketId: "w", window: "WEEKLY", remainingFraction: 0.5 }],
        },
      ],
    }),
  );
const geminiQuota = () =>
  new Response(
    JSON.stringify({ buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.5 }] }),
  );
const token = () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }));
const limited = (retryAfter = "60") =>
  new Response("{}", { status: 429, headers: { "Retry-After": retryAfter } });

const cases = [
  {
    name: "Google AGY",
    query: queryGoogleAgyQuota,
    keys: ["google-agy", "opencode-agy-auth"],
    quota: agyQuota,
    refresh: (value: string, project: string) => `${value}|${project}`,
  },
  {
    name: "Gemini CLI",
    query: queryGeminiCliQuota,
    keys: ["google-gemini-cli", "google"],
    quota: geminiQuota,
    refresh: (value: string, project: string) => `${value}|${project}|`,
  },
] as const;

describe.each(cases)("$name token-refresh Retry-After cooldown", (adapter) => {
  const tokenCalls = () =>
    mocks.fetchResponse.mock.calls.filter(([url]) => String(url).includes("oauth2")).length;
  const quotaCalls = () => mocks.fetchResponse.mock.calls.length - tokenCalls();
  let tokenResponse: (request: RequestInit) => Response;
  let run = 0; // cooldowns are module state, so each test uses its own credentials
  const auth = () => ({
    [adapter.keys[0]]: {
      type: "oauth",
      refresh: adapter.refresh(`${adapter.name}-${run}-refresh-a`, "project-a"),
      email: "a@example.com",
    },
    [adapter.keys[1]]: {
      type: "oauth",
      refresh: adapter.refresh(`${adapter.name}-${run}-refresh-b`, "project-b"),
      email: "b@example.com",
    },
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    run += 1;
    mocks.cached.clear();
    mocks.fetchResponse.mockReset();
    mocks.readAuthFileCached.mockResolvedValue(auth());
    tokenResponse = (request) =>
      String(request.body).includes("-refresh-a") ? limited() : token();
    mocks.fetchResponse.mockImplementation(async (url: string, request: RequestInit) =>
      String(url).includes("oauth2") ? tokenResponse(request) : adapter.quota(),
    );
  });
  afterEach(() => vi.useRealTimers());

  it("scopes the deadline to the account's refresh token and resumes at the deadline", async () => {
    const retryAtMs = Date.now() + 60_000;
    const first = await adapter.query();
    expect(first).toMatchObject({
      success: true,
      errors: [{ email: "a@example.com", retryAtMs }],
    });
    expect(tokenCalls()).toBe(2);

    await adapter.query();
    expect(tokenCalls()).toBe(3); // only account B refreshes again

    tokenResponse = () => token();
    vi.setSystemTime(retryAtMs);
    await adapter.query();
    expect(tokenCalls()).toBe(5);
  });

  it("does not block quota reads that no longer need a refresh", async () => {
    await adapter.query();
    const quotaBefore = quotaCalls();
    mocks.cached.set("cache-project-a", { accessToken: "valid" });
    const result = await adapter.query();
    expect(result).toMatchObject({ success: true });
    expect((result as { errors?: unknown }).errors).toBeUndefined();
    expect(quotaCalls()).toBeGreaterThan(quotaBefore + 1); // account A queried with its cached token
  });

  it("does not invent a deadline for invalid Retry-After", async () => {
    tokenResponse = () => limited("soon");
    const result = await adapter.query();
    expect(JSON.stringify(result)).not.toContain("retryAtMs");
    await adapter.query();
    expect(tokenCalls()).toBe(4);
  });

  it("keeps the token 429 deadline when the error body stalls until timeout", async () => {
    const retryAtMs = Date.now() + 60_000;
    mocks.readAuthFileCached.mockResolvedValue({
      [adapter.keys[0]]: {
        type: "oauth",
        refresh: adapter.refresh(`${adapter.name}-${run}-timeout-refresh`, "project-timeout"),
        email: "timeout@example.com",
      },
    });
    tokenResponse = (request) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          request.signal?.addEventListener("abort", () => {
            controller.error(new Error("body aborted"));
          });
        },
      });
      return new Response(body, { status: 429, headers: { "Retry-After": "60" } });
    };

    const result = adapter.query({ requestTimeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(tokenCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({
      success: true,
      errors: [{ email: "timeout@example.com", retryAtMs }],
    });

    await adapter.query({ requestTimeoutMs: 1000 });
    expect(tokenCalls()).toBe(1);
  });
});
