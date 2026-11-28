/**
 * Mistral Vibe billing reads, pinned to the documented platform payloads.
 *
 * Every request is served by an injected fetch: no test reaches api.mistral.ai.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isWellFormedMistralVibeApiKey,
  MISTRAL_VIBE_BILLING_UNAVAILABLE_MESSAGE,
  MISTRAL_VIBE_BUDGET_URL,
  MISTRAL_VIBE_FORBIDDEN_MESSAGE,
  MISTRAL_VIBE_INVALID_KEY_MESSAGE,
  MISTRAL_VIBE_INVALID_RESPONSE_MESSAGE,
  MISTRAL_VIBE_NETWORK_ERROR_MESSAGE,
  MISTRAL_VIBE_REDIRECT_MESSAGE,
  MISTRAL_VIBE_SUBSCRIPTION_URL,
  MISTRAL_VIBE_TIMEOUT_MESSAGE,
  MISTRAL_VIBE_UNAUTHORIZED_MESSAGE,
  parseMistralVibeBudget,
  parseMistralVibeSubscription,
  queryMistralVibeQuota,
} from "../src/lib/mistral-vibe.js";

const API_KEY = "mistral-test-key";

const VIBE_BUDGET = {
  usage_percentage: 42.5,
  initial_budget: 300,
  currency: "EUR",
  reset_at: "2026-12-01T00:00:00Z",
  payg_enabled: false,
};

const API_BUDGET = {
  usage_percentage: 10,
  initial_budget: 50,
  currency: "EUR",
  reset_at: "2026-12-01T00:00:00Z",
  payg_enabled: true,
};

const SUBSCRIPTION = {
  plan_name: "INDIVIDUAL",
  payg_enabled: false,
  vibe_payg_enabled: false,
  enterprise: false,
};

type RouteResult = { status: number; body?: unknown; raw?: string };

function jsonResponse(result: RouteResult): Response {
  return new Response(result.raw ?? JSON.stringify(result.body ?? {}), {
    status: result.status,
    headers: { "content-type": "application/json" },
  });
}

/** One stub serving the budget and subscription routes, recording each request. */
function fetchStub(routes: {
  budget: RouteResult | (() => Promise<Response>);
  subscription?: RouteResult | (() => Promise<Response>);
}) {
  const calls: Array<{
    url: string;
    authorization: string | null;
    accept: string | null;
    redirect: RequestInit["redirect"];
  }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get("authorization"),
      accept: headers.get("accept"),
      redirect: init?.redirect,
    });
    const route = url === MISTRAL_VIBE_BUDGET_URL ? routes.budget : routes.subscription;
    if (route === undefined) throw new Error("unexpected subscription request");
    if (typeof route === "function") return await route();
    return jsonResponse(route);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("Mistral Vibe budget reads", () => {
  it("reads the Vibe budget and plan label from both documented endpoints", async () => {
    const { fetchFn, calls } = fetchStub({
      budget: {
        status: 200,
        body: { vibe_budget: VIBE_BUDGET, api_budget: { ...API_BUDGET, payg_enabled: false } },
      },
      subscription: { status: 200, body: SUBSCRIPTION },
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(calls.map((call) => call.url).sort()).toEqual(
      [MISTRAL_VIBE_BUDGET_URL, MISTRAL_VIBE_SUBSCRIPTION_URL].sort(),
    );
    for (const call of calls) {
      expect(call.authorization).toBe(`Bearer ${API_KEY}`);
      expect(call.accept).toBe("application/json");
    }
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.vibeBudget).toEqual({
      usagePercentage: 42.5,
      initialBudget: 300,
      currency: "EUR",
      resetTimeIso: "2026-12-01T00:00:00.000Z",
      paygEnabled: false,
    });
    // PAYG is disabled, so the API budget is not a limit this account is measured against.
    expect(result.apiBudget).toBeUndefined();
    expect(result.subscription?.planLabel).toBe("Pro");
    expect(result.subscription?.planName).toBe("INDIVIDUAL");
    expect(Number.isNaN(Date.parse(result.observedAtIso))).toBe(false);
  });

  it("reports the API budget only when pay-as-you-go billing is enabled", async () => {
    const { fetchFn } = fetchStub({
      budget: { status: 200, body: { vibe_budget: VIBE_BUDGET, api_budget: API_BUDGET } },
      subscription: { status: 200, body: SUBSCRIPTION },
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.apiBudget?.usagePercentage).toBe(10);
    expect(result.apiBudget?.initialBudget).toBe(50);
  });

  it("keeps a null currency as a fact and still reports the exact reset", async () => {
    const { fetchFn } = fetchStub({
      budget: { status: 200, body: { vibe_budget: { ...VIBE_BUDGET, currency: null } } },
      subscription: { status: 200, body: SUBSCRIPTION },
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.vibeBudget?.currency).toBeNull();
    expect(result.vibeBudget?.resetTimeIso).toBe("2026-12-01T00:00:00.000Z");
  });

  it("reports success without a budget when the platform sends no vibe_budget", async () => {
    const { fetchFn } = fetchStub({
      budget: { status: 200, body: {} },
      subscription: { status: 200, body: SUBSCRIPTION },
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.vibeBudget).toBeUndefined();
    expect(result.apiBudget).toBeUndefined();
    expect(result.subscription?.planLabel).toBe("Pro");
  });

  it("drops an unparsable reset instead of inventing one", async () => {
    const { fetchFn } = fetchStub({
      budget: { status: 200, body: { vibe_budget: { ...VIBE_BUDGET, reset_at: "not-a-date" } } },
      subscription: { status: 200, body: SUBSCRIPTION },
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.vibeBudget?.resetTimeIso).toBeUndefined();
  });

  it("keeps the budget when only the plan read fails", async () => {
    const { fetchFn } = fetchStub({
      budget: { status: 200, body: { vibe_budget: VIBE_BUDGET } },
      subscription: { status: 500 },
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.vibeBudget?.usagePercentage).toBe(42.5);
    expect(result.subscription).toBeUndefined();
  });
});

describe("Mistral Vibe auth and error mapping", () => {
  it("maps 401 to an invalid-credential failure", async () => {
    const { fetchFn } = fetchStub({ budget: { status: 401 } });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result).toEqual({
      success: false,
      error: MISTRAL_VIBE_UNAUTHORIZED_MESSAGE,
      failureCategory: "credentials",
      httpStatus: 401,
    });
  });

  it("reports the exact 403 permission error for a personal credential", async () => {
    const { fetchFn } = fetchStub({ budget: { status: 403 } });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe(MISTRAL_VIBE_FORBIDDEN_MESSAGE);
    expect(result.error).toContain("see_org_inference_usage");
    expect(result.failureCategory).toBe("credentials");
    expect(result.httpStatus).toBe(403);
    expect(result.error).not.toContain(API_KEY);
  });

  it("maps 404 to a platform without the billing API", async () => {
    const { fetchFn } = fetchStub({ budget: { status: 404 } });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result).toEqual({
      success: false,
      error: MISTRAL_VIBE_BILLING_UNAVAILABLE_MESSAGE,
      failureCategory: "provider_api",
      httpStatus: 404,
    });
  });

  it("maps a non-JSON body to a provider API failure", async () => {
    const { fetchFn } = fetchStub({ budget: { status: 200, raw: "<html>gateway</html>" } });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe("Mistral budget response was not valid JSON.");
    expect(result.failureCategory).toBe("provider_api");
  });

  it("fails on a request that never answers, without echoing the key", async () => {
    const { fetchFn } = fetchStub({
      budget: () => new Promise<Response>(() => {}),
      subscription: () => new Promise<Response>(() => {}),
    });

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn, requestTimeoutMs: 20 });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBe(MISTRAL_VIBE_TIMEOUT_MESSAGE);
    expect(result.error).not.toContain(API_KEY);
    expect(result.failureCategory).toBe("provider_api");
  });

  it("pins both billing reads with redirect: error", async () => {
    const { fetchFn, calls } = fetchStub({
      budget: { status: 200, body: { vibe_budget: VIBE_BUDGET } },
      subscription: { status: 200, body: SUBSCRIPTION },
    });

    await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.redirect).toBe("error");
  });

  it("maps a refused redirect to a fixed message", async () => {
    const fetchFn = (async () => {
      throw new TypeError("unexpected redirect");
    }) as typeof fetch;

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result).toEqual({
      success: false,
      error: MISTRAL_VIBE_REDIRECT_MESSAGE,
      failureCategory: "provider_api",
    });
  });

  it("maps a thrown transport error to a fixed message that never quotes the key", async () => {
    const fetchFn = (async () => {
      throw new TypeError(`fetch failed: header value ${API_KEY} rejected`);
    }) as typeof fetch;

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result).toEqual({
      success: false,
      error: MISTRAL_VIBE_NETWORK_ERROR_MESSAGE,
      failureCategory: "provider_api",
    });
    if (result.success) return;
    expect(result.error).not.toContain(API_KEY);
  });

  it("maps an unreadable response to a fixed invalid-response message", async () => {
    const fetchFn = (async () => {
      throw new SyntaxError(`Unexpected token < in JSON for ${API_KEY}`);
    }) as typeof fetch;

    const result = await queryMistralVibeQuota({ apiKey: API_KEY, fetchFn });

    expect(result).toEqual({
      success: false,
      error: MISTRAL_VIBE_INVALID_RESPONSE_MESSAGE,
      failureCategory: "provider_api",
    });
  });
});

describe("Mistral Vibe credential syntax", () => {
  it("accepts only printable non-whitespace ASCII of a sane length", () => {
    expect(isWellFormedMistralVibeApiKey(API_KEY)).toBe(true);
    expect(isWellFormedMistralVibeApiKey("a")).toBe(true);
    expect(isWellFormedMistralVibeApiKey("")).toBe(false);
    expect(isWellFormedMistralVibeApiKey("key with space")).toBe(false);
    expect(isWellFormedMistralVibeApiKey("key\twith\ttab")).toBe(false);
    expect(isWellFormedMistralVibeApiKey("key\nwith\nnewline")).toBe(false);
    expect(isWellFormedMistralVibeApiKey(`key${String.fromCharCode(7)}bell`)).toBe(false);
    expect(isWellFormedMistralVibeApiKey("clé")).toBe(false);
    expect(isWellFormedMistralVibeApiKey("k".repeat(513))).toBe(false);
  });

  it("refuses an unusable key before any request exists", async () => {
    const fetchFn = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

    for (const key of [`sk-mistral${String.fromCharCode(10)}X-Injected: 1`, "sk-mistral key", ""]) {
      const result = await queryMistralVibeQuota({ apiKey: key, fetchFn });

      expect(result).toEqual({
        success: false,
        error: MISTRAL_VIBE_INVALID_KEY_MESSAGE,
        failureCategory: "credentials",
      });
      expect(fetchFn).not.toHaveBeenCalled();
      if (result.success) continue;
      expect(result.error).not.toContain("sk-mistral");
      expect(result.error).not.toContain("X-Injected");
    }
    expect(MISTRAL_VIBE_INVALID_KEY_MESSAGE).toContain("invalid");
  });
});

describe("Mistral Vibe payload parsing", () => {
  it("keeps a FREE plan labelled and never derives identity from the plan", () => {
    expect(parseMistralVibeSubscription({ ...SUBSCRIPTION, plan_name: "FREE" })?.planLabel).toBe(
      "Free",
    );
    expect(parseMistralVibeSubscription({ ...SUBSCRIPTION, plan_name: "TEAM" })?.planLabel).toBe(
      "Team",
    );
    expect(parseMistralVibeSubscription({ ...SUBSCRIPTION, plan_name: "OTHER" })?.planLabel).toBe(
      undefined,
    );
    expect(parseMistralVibeSubscription({})?.planLabel).toBeUndefined();
  });

  it("rejects a budget object without the reported facts", () => {
    expect(parseMistralVibeBudget({ usage_percentage: 1 })).toBeUndefined();
    expect(parseMistralVibeBudget({ initial_budget: 10 })).toBeUndefined();
    expect(parseMistralVibeBudget(null)).toBeUndefined();
    expect(parseMistralVibeBudget({ usage_percentage: 0, initial_budget: 10 })).toEqual({
      usagePercentage: 0,
      initialBudget: 10,
      currency: null,
      paygEnabled: false,
    });
  });
});
