import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        url: string,
        options: {
          request: RequestInit;
          timeoutMs?: number;
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) =>
        await options.consume(
          await fetchResponse(url, options.request, options.timeoutMs),
          new AbortController().signal,
        ),
    ),
    getCachedAccessToken: vi.fn(async () => ({ accessToken: "cached-access-token" })),
    makeAccountCacheKey: vi.fn(
      ({ refreshToken, projectId }: { refreshToken: string; projectId: string }) =>
        `${refreshToken}\n${projectId}`,
    ),
    setCachedAccessToken: vi.fn(),
    readAuthFileCached: vi.fn(),
    readGlobalProviderConfigString: vi.fn(async () => undefined),
    resolveAgyClientCredentials: vi.fn(async () => ({
      state: "configured" as const,
      clientId: "agy-client",
      clientSecret: "agy-secret",
    })),
    inspectAgyCompanionPresence: vi.fn(),
    clearAgyCompanionCacheForTests: vi.fn(),
    resolveGeminiCliClientCredentials: vi.fn(async () => ({
      state: "configured" as const,
      clientId: "gemini-client",
      clientSecret: "gemini-secret",
    })),
    inspectGeminiCliCompanionPresence: vi.fn(),
    clearGeminiCliCompanionCacheForTests: vi.fn(),
    deriveResolvedAuthIdentity: vi.fn(async () => "identity"),
    composeResolvedAuthIdentities: vi.fn(async () => "composed-identity"),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
  RequestTimeoutError: class RequestTimeoutError extends Error {},
}));
vi.mock("../src/lib/google-token-cache.js", () => ({
  getCachedAccessToken: mocks.getCachedAccessToken,
  makeAccountCacheKey: mocks.makeAccountCacheKey,
  setCachedAccessToken: mocks.setCachedAccessToken,
}));
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));
vi.mock("../src/lib/api-key-resolver.js", () => ({
  readGlobalProviderConfigString: mocks.readGlobalProviderConfigString,
}));
vi.mock("../src/lib/google-agy-companion.js", () => ({
  resolveAgyClientCredentials: mocks.resolveAgyClientCredentials,
  inspectAgyCompanionPresence: mocks.inspectAgyCompanionPresence,
  clearAgyCompanionCacheForTests: mocks.clearAgyCompanionCacheForTests,
}));
vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  resolveGeminiCliClientCredentials: mocks.resolveGeminiCliClientCredentials,
  inspectGeminiCliCompanionPresence: mocks.inspectGeminiCliCompanionPresence,
  clearGeminiCliCompanionCacheForTests: mocks.clearGeminiCliCompanionCacheForTests,
}));
vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: mocks.deriveResolvedAuthIdentity,
  composeResolvedAuthIdentities: mocks.composeResolvedAuthIdentities,
}));

import { queryGoogleAgyQuota } from "../src/lib/google-agy.js";
import { queryGeminiCliQuota } from "../src/lib/google-gemini-cli.js";
import type { AuthData, GeminiCliResult, GoogleAgyResult } from "../src/lib/types.js";

function account(refreshToken: string, projectId: string, email: string) {
  return {
    type: "oauth" as const,
    refresh: `${refreshToken}|${projectId}`,
    email,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setQuotaRace() {
  const targetStarted = deferred();
  const secondNeighborStarted = deferred();
  const releaseTarget = deferred();
  let targetRequests = 0;

  mocks.fetchResponse.mockImplementation(async (url: string, request: RequestInit) => {
    const project = (JSON.parse(String(request.body)) as { project: string }).project;
    if (project === "shared-project") {
      targetRequests += 1;
      targetStarted.resolve();
      await releaseTarget.promise;
    }
    if (project === "neighbor-second") secondNeighborStarted.resolve();

    const payload = url.includes("retrieveUserQuotaSummary")
      ? {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                {
                  bucketId: `bucket-${project}`,
                  window: "WEEKLY",
                  remainingFraction: 0.5,
                },
              ],
            },
          ],
        }
      : {
          buckets: [{ modelId: `gemini-${project}`, remainingFraction: 0.5 }],
        };
    return new Response(JSON.stringify(payload));
  });

  return {
    targetStarted: targetStarted.promise,
    secondNeighborStarted: secondNeighborStarted.promise,
    releaseTarget: releaseTarget.resolve,
    targetRequests: () => targetRequests,
  };
}

async function runConcurrentQueries(
  query: (authData: AuthData) => Promise<unknown>,
  firstAuth: AuthData,
  secondAuth: AuthData,
) {
  const race = setQuotaRace();
  const first = query(firstAuth);
  await race.targetStarted;
  const second = query(secondAuth);
  await race.secondNeighborStarted;
  race.releaseTarget();
  const results = await Promise.all([first, second]);
  return { results, targetRequests: race.targetRequests() };
}

describe("Google quota request coalescing metadata", () => {
  beforeEach(() => {
    mocks.fetchResponse.mockReset();
    mocks.getCachedAccessToken.mockReset().mockResolvedValue({
      accessToken: "cached-access-token",
    });
  });

  it("projects AGY bucket identity after concurrent requests reorder accounts", async () => {
    const { results, targetRequests } = await runConcurrentQueries(
      (authData) => queryGoogleAgyQuota({ authData }),
      {
        "google-agy": account("shared-refresh", "shared-project", "red@example.com"),
        "opencode-agy-auth": account(
          "neighbor-first-refresh",
          "neighbor-first",
          "first-neighbor@example.com",
        ),
      },
      {
        "google-agy": account(
          "neighbor-second-refresh",
          "neighbor-second",
          "second-neighbor@example.com",
        ),
        "opencode-agy-auth": account("shared-refresh", "shared-project", "blue@example.com"),
      },
    );

    expect(targetRequests).toBe(1);
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(3);
    for (const [index, expected] of [
      { accountIndex: 0, accountEmail: "red@example.com", sourceKey: "google-agy" },
      { accountIndex: 1, accountEmail: "blue@example.com", sourceKey: "opencode-agy-auth" },
    ].entries()) {
      const result = results[index] as GoogleAgyResult;
      if (!result || !result.success) throw new Error("expected AGY quota data");
      const targetBuckets = result.buckets.filter(
        (bucket) => bucket.bucketId === "bucket-shared-project",
      );
      expect(targetBuckets).toHaveLength(1);
      expect(targetBuckets[0]).toMatchObject(expected);
    }
  });

  it("projects Gemini CLI bucket identity for concurrent requests using different auth rows", async () => {
    const { results, targetRequests } = await runConcurrentQueries(
      (authData) => queryGeminiCliQuota({ authData }),
      {
        "google-gemini-cli": account("shared-refresh", "shared-project", "red@example.com"),
        "gemini-cli": account(
          "neighbor-first-refresh",
          "neighbor-first",
          "first-neighbor@example.com",
        ),
      },
      {
        "google-gemini-cli": account(
          "neighbor-second-refresh",
          "neighbor-second",
          "second-neighbor@example.com",
        ),
        "gemini-cli": account("shared-refresh", "shared-project", "blue@example.com"),
      },
    );

    expect(targetRequests).toBe(1);
    expect(mocks.fetchResponse).toHaveBeenCalledTimes(3);
    const first = results[0] as GeminiCliResult;
    const second = results[1] as GeminiCliResult;
    if (!first || !first.success || !second || !second.success) {
      throw new Error("expected Gemini CLI quota data");
    }
    expect(
      first.buckets.find((bucket) => bucket.modelId === "gemini-shared-project"),
    ).toMatchObject({
      accountEmail: "red@example.com",
      sourceKey: "google-gemini-cli",
    });
    expect(
      second.buckets.find((bucket) => bucket.modelId === "gemini-shared-project"),
    ).toMatchObject({
      accountEmail: "blue@example.com",
      sourceKey: "gemini-cli",
    });
  });
});
