import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
  fetchResponse: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({ readAuthFileCached: mocks.readAuthFileCached }));
vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    url: string,
    options: {
      request: RequestInit;
      consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
    },
  ) =>
    options.consume(await mocks.fetchResponse(url, options.request), new AbortController().signal),
}));
vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: vi.fn(async () => ({ accessToken: "access" })),
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

import { queryGoogleAgyQuota } from "../src/lib/google-agy.js";

const account = (refresh: string, project: string, email: string) => ({
  type: "oauth",
  refresh: `${refresh}|${project}`,
  email,
});
const quota = () =>
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
const limited = (retryAfter = "60") =>
  new Response("slow", { status: 429, headers: { "Retry-After": retryAfter } });

describe("Google AGY Retry-After cooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    mocks.fetchResponse.mockReset();
    mocks.readAuthFileCached.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("surfaces the deadline, blocks only that account, and resumes at the deadline", async () => {
    const retryAtMs = Date.now() + 60_000;
    mocks.readAuthFileCached.mockResolvedValue({
      "google-agy": account("agy-refresh-a", "project-a", "a@example.com"),
      "opencode-agy-auth": account("agy-refresh-b", "project-b", "b@example.com"),
    });
    mocks.fetchResponse.mockImplementation(async (_url: string, request: RequestInit) =>
      String(request.body).includes("project-a") ? limited() : quota(),
    );

    const first = await queryGoogleAgyQuota();
    expect(first).toMatchObject({
      success: true,
      buckets: [{ accountEmail: "b@example.com" }],
      errors: [{ email: "a@example.com", retryAtMs }],
    });
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(2);

    const second = await queryGoogleAgyQuota();
    expect(second).toMatchObject({ errors: [{ email: "a@example.com", retryAtMs }] });
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(3); // only account B fetched again

    vi.setSystemTime(retryAtMs);
    await queryGoogleAgyQuota();
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(5);
  });

  it("does not invent or enforce a deadline for invalid Retry-After", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      "google-agy": account("agy-refresh-c", "project-c", "c@example.com"),
    });
    mocks.fetchResponse.mockImplementation(async () => limited("soon"));
    const result = await queryGoogleAgyQuota();
    expect(JSON.stringify(result)).not.toContain("retryAtMs");
    await queryGoogleAgyQuota();
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(2);
  });
});
