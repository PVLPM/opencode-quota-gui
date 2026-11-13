import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import type { OpenCodeConsoleCredential } from "../src/lib/opencode-console-auth.js";
import { queryOpenCodeZenQuota } from "../src/lib/opencode-zen.js";

const credential: OpenCodeConsoleCredential = {
  accessToken: "st_test-token",
  accountId: "usr_me",
  orgId: "wrk_test",
};

const OPTIONAL_RESPONSES: Record<string, unknown> = {
  "billing/account": { creditLimitMicroCents: null },
  "billing/auto-recharge": {
    enabled: false,
    thresholdDollars: 5,
    rechargeAmountDollars: 20,
  },
  "policies/members/usr_me": {
    userID: "usr_me",
    budgets: [],
    policies: [],
  },
  "usage/cost-by-day": [],
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("queryOpenCodeZenQuota concurrent request deduplication", () => {
  beforeEach(() => {
    mocks.fetchWithTimeout.mockReset();
  });

  it("does not repeat settled optional routes while a concurrent query waits on billing status", async () => {
    const billingResponse = deferred<Response>();
    const optionalRoutesSettled = deferred<void>();
    const routeCalls = new Map<string, number>();
    let settledOptionalCount = 0;

    mocks.fetchWithTimeout.mockImplementation(
      async (
        url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const route = new URL(url).pathname.replace("/console/api/", "");
        routeCalls.set(route, (routeCalls.get(route) ?? 0) + 1);
        const response =
          route === "billing/status"
            ? await billingResponse.promise
            : json(OPTIONAL_RESPONSES[route]);
        const result = await options.consume(response, new AbortController().signal);

        if (route !== "billing/status" && ++settledOptionalCount === 4) {
          optionalRoutesSettled.resolve();
        }
        return result;
      },
    );

    const first = queryOpenCodeZenQuota(credential);
    expect(Object.fromEntries(routeCalls)).toEqual({
      "billing/status": 1,
      "billing/account": 1,
      "billing/auto-recharge": 1,
      "policies/members/usr_me": 1,
      "usage/cost-by-day": 1,
    });

    const second = queryOpenCodeZenQuota(credential);
    await optionalRoutesSettled.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    billingResponse.resolve(
      json({
        balanceMicroCents: "100000000",
      }),
    );

    const results = await Promise.all([first, second]);

    expect(results.every((result) => result.success)).toBe(true);
    expect(Object.fromEntries(routeCalls)).toEqual({
      "billing/status": 1,
      "billing/account": 1,
      "billing/auto-recharge": 1,
      "policies/members/usr_me": 1,
      "usage/cost-by-day": 1,
    });
  });
});
