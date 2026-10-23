import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import businessIndividualLimitUsage from "./fixtures/openai/business-individual-limit.sanitized.json";
import businessTeamMonthlyUsage from "./fixtures/openai/business-team-monthly.sanitized.json";

const mocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
  deriveResolvedAuthIdentity: vi.fn(async () => "rai1_test-opaque-identity"),
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: mocks.readAuthFileCached,
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: mocks.deriveResolvedAuthIdentity,
}));

import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  queryOpenAIQuota,
  resolveOpenAIAuthIdentity,
  resolveOpenAIOAuth,
} from "../src/lib/openai.js";

function mockOpenAIUsageResponse(usage: unknown): void {
  mocks.readAuthFileCached.mockResolvedValueOnce({
    openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => usage })) as any);
}

describe("openai auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers the resolved stable account id for opaque cache identity", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      openai: {
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        accountId: "account-stable-id",
      },
    });

    await expect(resolveOpenAIAuthIdentity()).resolves.toBe("rai1_test-opaque-identity");
    expect(mocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openai",
      principal: { kind: "stable-id", value: "account-stable-id" },
    });
    expect(JSON.stringify(await resolveOpenAIAuthIdentity())).not.toMatch(
      /access-secret|refresh-secret|account-stable-id/u,
    );
  });

  it("uses the winning credential rather than advisory email when no account id exists", async () => {
    const emailPayload = Buffer.from(JSON.stringify({ email: "shared@example.com" })).toString(
      "base64url",
    );
    mocks.readAuthFileCached
      .mockResolvedValueOnce({
        openai: {
          type: "oauth",
          access: `header.${emailPayload}.signature-one`,
          refresh: "refresh-secret-one",
        },
      })
      .mockResolvedValueOnce({
        openai: {
          type: "oauth",
          access: `header.${emailPayload}.signature-two`,
          refresh: "refresh-secret-two",
        },
      });

    await resolveOpenAIAuthIdentity();
    await resolveOpenAIAuthIdentity();

    expect(mocks.deriveResolvedAuthIdentity).toHaveBeenNthCalledWith(1, {
      providerId: "openai",
      principal: { kind: "credential", value: "refresh-secret-one" },
    });
    expect(mocks.deriveResolvedAuthIdentity).toHaveBeenNthCalledWith(2, {
      providerId: "openai",
      principal: { kind: "credential", value: "refresh-secret-two" },
    });
  });

  it("returns none when no supported native OpenCode auth entry exists", () => {
    expect(resolveOpenAIOAuth({})).toEqual({ state: "none" });
  });

  it("prefers openai before legacy compatibility keys", () => {
    expect(
      resolveOpenAIOAuth({
        codex: { type: "oauth", access: "codex-token" },
        openai: { type: "oauth", access: "openai-token" },
        chatgpt: { type: "oauth", access: "chatgpt-token" },
        opencode: { type: "oauth", access: "opencode-token" },
      }),
    ).toMatchObject({
      state: "configured",
      sourceKey: "openai",
      accessToken: "openai-token",
    });
  });

  it("keeps a login OpenCode could not return present, with no identity and a clear error", async () => {
    const failed = { openai: { type: "oauth", resolveError: "refresh_failed: HTTP 400" } };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(resolveOpenAIOAuth(failed)).toEqual({
      state: "failed",
      sourceKey: "openai",
      error: "refresh_failed: HTTP 400",
    });
    mocks.readAuthFileCached.mockResolvedValue(failed);
    await expect(hasOpenAIOAuthCached()).resolves.toBe(true);
    await expect(resolveOpenAIAuthIdentity()).resolves.toBeNull();
    await expect(queryOpenAIQuota()).resolves.toEqual({
      success: false,
      error:
        "OpenAI sign-in could not be refreshed: refresh_failed: HTTP 400. Run `opencode auth login openai`.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("names the logout command for a failed login with a shell-safe label (#316)", async () => {
    const failed = resolveOpenAIOAuth({
      openai: { type: "oauth", resolveError: "refresh_failed: Request failed: 401" },
    });

    await expect(queryOpenAIQuota({ auth: failed, loginLabel: "default" })).resolves.toEqual({
      success: false,
      error:
        "OpenAI sign-in could not be refreshed: refresh_failed: Request failed: 401. Run `opencode auth logout openai default`, then `opencode auth login openai`.",
    });
    for (const loginLabel of ["My work; rm", " Work ", "--help"]) {
      await expect(queryOpenAIQuota({ auth: failed, loginLabel })).resolves.toEqual({
        success: false,
        error:
          "OpenAI sign-in could not be refreshed: refresh_failed: Request failed: 401. Run `opencode auth login openai`.",
      });
    }
  });

  it("lets a failed openai login win over a later compatibility key, as a configured one would", () => {
    expect(
      resolveOpenAIOAuth({
        openai: { type: "oauth", resolveError: "resolve_empty: no value" },
        codex: { type: "oauth", access: "codex-token" },
      }),
    ).toEqual({ state: "failed", sourceKey: "openai", error: "resolve_empty: no value" });
  });

  it("returns null when quota is not configured", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({});

    await expect(queryOpenAIQuota()).resolves.toBeNull();
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
      integrationIds: ["openai", "codex", "chatgpt"],
    });
  });

  it("returns token expired error when expires is in the past", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "tok", expires: Date.now() - 1 },
    });

    const out = await queryOpenAIQuota();
    expect(out && !out.success ? out.error : "").toContain("Token expired");
  });

  it("does not echo upstream response identity material in errors", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "access-secret", expires: Date.now() + 60_000 },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "account alice@example.com account-id-123 access-secret",
            }),
            { status: 403 },
          ),
      ) as any,
    );

    const result = await queryOpenAIQuota();
    expect(result).toEqual({ success: false, error: "OpenAI API error 403" });
    expect(JSON.stringify(result)).not.toMatch(/alice@example\.com|account-id-123|access-secret/u);
  });

  it("adds only OpenAI's short error code to an HTTP error (#316)", async () => {
    const respond = (code: unknown) =>
      new Response(
        JSON.stringify({
          error: {
            message: "Unauthorized alice@example.com",
            type: "rejected_by_access_enforcement",
            code,
          },
        }),
        { status: 401 },
      );
    const openai = { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 };
    mocks.readAuthFileCached.mockResolvedValue({ openai });

    vi.stubGlobal("fetch", vi.fn(async () => respond("no_matching_rule")) as any);
    await expect(queryOpenAIQuota()).resolves.toEqual({
      success: false,
      error: "OpenAI API error 401 (no_matching_rule)",
    });

    vi.stubGlobal("fetch", vi.fn(async () => respond("alice@example.com is blocked")) as any);
    await expect(queryOpenAIQuota()).resolves.toEqual({
      success: false,
      error: "OpenAI API error 401",
    });
  });

  it("reads auth from chatgpt when codex and openai are absent", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      chatgpt: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(80);
  });

  it("never treats the OpenCode Console login under opencode as an OpenAI login", async () => {
    // OpenCode 2 imports a legacy console login as `methodID: "device"`, often without an orgID.
    mocks.readAuthFileCached.mockResolvedValueOnce({
      codex: { type: "oauth", access: "   " },
      openai: { type: "api", access: "ignored" },
      chatgpt: { type: "oauth", access: "   " },
      opencode: {
        type: "oauth",
        methodID: "device",
        access: "console-token",
        expires: Date.now() + 60_000,
      },
    } as any);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(queryOpenAIQuota()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses cached auth reads for hasOpenAIOAuthCached", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "cached-token" },
    });

    await expect(hasOpenAIOAuthCached()).resolves.toBe(true);
    expect(mocks.readAuthFileCached).toHaveBeenCalledWith({
      maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
      integrationIds: ["openai", "codex", "chatgpt"],
    });
  });

  it("classifies the sanitized Business window as monthly without inventing absent windows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify(businessTeamMonthlyUsage), { status: 200 }),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 67,
        resetTimeIso: new Date(1_786_262_548_000).toISOString(),
      },
    });
  });

  it("parses the sanitized Business individual spend limit as monthly quota", async () => {
    mockOpenAIUsageResponse(businessIndividualLimitUsage);

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 100,
        resetTimeIso: new Date(1_785_542_400_000).toISOString(),
      },
    });
  });

  it("falls back to individual-limit reset_after_seconds when reset_at is absent", async () => {
    mockOpenAIUsageResponse({
      ...businessIndividualLimitUsage,
      spend_control: {
        individual_limit: {
          remaining_percent: 80,
          reset_after_seconds: 60,
        },
      },
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.windows.monthly : undefined).toEqual({
      percentRemaining: 80,
      resetTimeIso: "2026-01-01T00:01:00.000Z",
    });
  });

  it.each([
    { name: "zero", value: 0, expected: 0 },
    { name: "negative", value: -25, expected: 0 },
    { name: "above 100", value: 140, expected: 100 },
  ])("clamps $name Business individual-limit percentages", async ({ value, expected }) => {
    mockOpenAIUsageResponse({
      ...businessIndividualLimitUsage,
      spend_control: {
        individual_limit: {
          ...businessIndividualLimitUsage.spend_control.individual_limit,
          remaining_percent: value,
        },
      },
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.windows.monthly?.percentRemaining : -1).toBe(expected);
  });

  it.each([
    { name: "missing spend control", spendControl: undefined },
    { name: "missing value", spendControl: { individual_limit: {} } },
    { name: "null value", spendControl: { individual_limit: { remaining_percent: null } } },
    { name: "wrong type", spendControl: { individual_limit: { remaining_percent: "50" } } },
    { name: "NaN", spendControl: { individual_limit: { remaining_percent: Number.NaN } } },
    {
      name: "infinite",
      spendControl: { individual_limit: { remaining_percent: Number.POSITIVE_INFINITY } },
    },
  ])("omits $name while preserving personal, credits, and code-review paths", async ({
    spendControl,
  }) => {
    mockOpenAIUsageResponse({
      plan_type: "plus",
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_after_seconds: 3_600,
        },
        secondary_window: null,
      },
      code_review_rate_limit: {
        primary_window: {
          used_percent: 5,
          reset_after_seconds: 60,
        },
      },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: "12.34",
      },
      ...(spendControl === undefined ? {} : { spend_control: spendControl }),
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T01:00:00.000Z",
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2025-12-31T20:00:00.000Z",
          observedAtIso: "2026-01-01T00:00:00.000Z",
          endsAtIso: "2026-01-01T01:00:00.000Z",
          fullReset: true,
        },
      },
      codeReview: {
        percentRemaining: 95,
        resetTimeIso: "2026-01-01T00:01:00.000Z",
      },
    });
    expect(out && out.success ? out.credits : undefined).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: "12.34",
    });
  });

  it("keeps an existing Business monthly rate-limit window authoritative", async () => {
    mockOpenAIUsageResponse({
      ...businessTeamMonthlyUsage,
      spend_control: {
        individual_limit: {
          remaining_percent: 5,
          reset_at: 1_800_000_000,
        },
      },
    });

    const out = await queryOpenAIQuota();

    expect(out && out.success ? out.label : "").toBe("OpenAI (Business)");
    expect(out && out.success ? out.windows : {}).toEqual({
      monthly: {
        percentRemaining: 67,
        resetTimeIso: new Date(1_786_262_548_000).toISOString(),
      },
    });
  });

  it.each([
    ["business", "OpenAI (Business)"],
    [" TEAM ", "OpenAI (Business)"],
    ["business_trial", "OpenAI (business_trial)"],
    ["team_workspace", "OpenAI (team_workspace)"],
    ["plus", "OpenAI (Plus)"],
    ["pro", "OpenAI (Pro)"],
  ])("derives the plan label for %j", async (planType, expectedLabel) => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: planType,
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3_600,
                },
                secondary_window: null,
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.label : "").toBe(expectedLabel);
  });

  it("classifies known windows by duration when their positions are reversed", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(30);
    expect(out && out.success ? out.windows.weekly?.percentRemaining : -1).toBe(90);
  });

  it("omits an unknown duration while preserving a valid sibling", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 3_600,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      weekly: {
        percentRemaining: 30,
        resetTimeIso: "2026-01-08T00:00:00.000Z",
      },
    });
  });

  it("omits a malformed window while preserving a valid sibling", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "team",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: "33",
                  limit_window_seconds: 2_628_000,
                  reset_after_seconds: 2_585_763,
                },
                secondary_window: {
                  used_percent: 25,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 18_000,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 75,
        resetTimeIso: "2026-01-01T05:00:00.000Z",
      },
    });
  });

  it("collapses equivalent duplicate durations", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
                secondary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      weekly: {
        percentRemaining: 90,
        resetTimeIso: "2026-01-15T00:00:00.000Z",
      },
    });
  });

  it("omits conflicting duplicate durations while preserving an unrelated valid window", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
                secondary_window: {
                  used_percent: 20,
                  limit_window_seconds: 604_800,
                  reset_at: 1_768_435_200,
                },
              },
              code_review_rate_limit: {
                primary_window: {
                  used_percent: 5,
                  reset_after_seconds: 60,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      codeReview: {
        percentRemaining: 95,
        resetTimeIso: "2026-01-01T00:01:00.000Z",
      },
    });
  });

  it("isolates unrepresentable reset dates and falls back when possible", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_at: Number.MAX_VALUE,
                  reset_after_seconds: 3_600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: Number.MAX_VALUE,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows : {}).toEqual({
      hourly: {
        percentRemaining: 80,
        resetTimeIso: "2026-01-01T01:00:00.000Z",
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2025-12-31T20:00:00.000Z",
          observedAtIso: "2026-01-01T00:00:00.000Z",
          endsAtIso: "2026-01-01T01:00:00.000Z",
          fullReset: true,
        },
      },
      weekly: {
        percentRemaining: 30,
        resetTimeIso: undefined,
      },
    });
  });

  it("returns the summary reset count without a detail request by default", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3_600,
              },
            },
            credits: { has_credits: true, unlimited: false, balance: "12.34" },
            rate_limit_reset_credits: { available_count: 3 },
          }),
          { status: 200 },
        ),
    );
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = await queryOpenAIQuota();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out && out.success ? out.bankedResets : undefined).toEqual({
      availableCount: 3,
      credits: [],
    });
    expect(out && out.success ? out.credits : undefined).toEqual({
      hasCredits: true,
      unlimited: false,
      balance: "12.34",
    });
  });

  it("never requests reset details for a zero or malformed count", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });
    for (const availableCount of [0, -2, "3", 1.5]) {
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit: {
                primary_window: {
                  used_percent: 20,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3_600,
                },
              },
              rate_limit_reset_credits: { available_count: availableCount },
            }),
            { status: 200 },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const out = await queryOpenAIQuota({ includeResetDetails: true });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(out && out.success ? out.bankedResets : undefined).toBeUndefined();
    }
  });

  it("fetches available reset details with the same auth and account headers", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: { ...(init?.headers as Record<string, string>) },
      });
      if (String(url).endsWith("/usage")) {
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3_600,
              },
            },
            rate_limit_reset_credits: { available_count: 3 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          available_count: 3,
          credits: [
            {
              id: "raw-reset-one",
              reset_type: "rate_limit",
              status: "available",
              granted_at: "2025-12-31T00:00:00.000Z",
              expires_at: "2026-01-02T03:04:05Z",
              title: "Full reset",
              description: "raw description one",
            },
            {
              id: "raw-reset-two",
              reset_type: "rate_limit",
              status: "available",
              granted_at: "2025-12-31T00:00:00.000Z",
              expires_at: null,
              description: "raw description two",
            },
            {
              id: "raw-reset-redeemed",
              reset_type: "rate_limit",
              status: "redeemed",
              granted_at: "2025-12-31T00:00:00.000Z",
              expires_at: "2026-01-03T00:00:00.000Z",
              title: "Already used",
            },
            {
              id: "raw-reset-three",
              reset_type: "rate_limit",
              status: "available",
              granted_at: "2025-12-31T00:00:00.000Z",
            },
            {
              id: "raw-reset-four",
              reset_type: "rate_limit",
              status: "available",
              granted_at: "2025-12-31T00:00:00.000Z",
              expires_at: "not-a-date",
            },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const auth = {
      state: "configured" as const,
      sourceKey: "openai" as const,
      accessToken: "token-secret",
      accountId: "account-42",
    };

    const out = await queryOpenAIQuota({ auth, includeResetDetails: true });

    expect(requests.map((request) => request.url)).toEqual([
      "https://chatgpt.com/backend-api/wham/usage",
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    ]);
    for (const request of requests) {
      expect(request.headers).toEqual({
        Authorization: "Bearer token-secret",
        "User-Agent": "opencode-quota-gui/1.0",
        "ChatGPT-Account-Id": "account-42",
      });
    }
    expect(out && out.success ? out.bankedResets : undefined).toEqual({
      availableCount: 3,
      credits: [
        { title: "Full reset", expiresAtIso: "2026-01-02T03:04:05.000Z" },
        { expiresAtIso: null },
        {},
        {},
      ],
    });
    expect(JSON.stringify(out)).not.toMatch(
      /raw-reset|raw description|token-secret|account-42|Already used/u,
    );
  });

  it.each([
    ["HTTP failure", () => new Response(JSON.stringify({ error: "private" }), { status: 500 })],
    ["invalid JSON", () => new Response("{not json", { status: 200 })],
    ["network failure", () => Promise.reject(new Error("socket closed"))],
  ])("contains reset-detail %s while keeping ordinary data", async (_label, detailResponse) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/usage")) {
        return new Response(
          JSON.stringify({
            plan_type: "pro",
            rate_limit: {
              primary_window: {
                used_percent: 10,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3_600,
              },
            },
            credits: { has_credits: true, unlimited: false, balance: "5.00" },
            rate_limit_reset_credits: { available_count: 2 },
          }),
          { status: 200 },
        );
      }
      return detailResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    const out = await queryOpenAIQuota({ includeResetDetails: true });

    expect(out && out.success ? out.windows.hourly?.percentRemaining : undefined).toBe(90);
    expect(out && out.success ? out.credits?.balance : undefined).toBe("5.00");
    expect(out && out.success ? out.bankedResets : undefined).toEqual({
      availableCount: 2,
      credits: [],
    });
  });

  it("keeps only explicit available reset details and treats a partial list as partial", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/usage")) {
        return new Response(
          JSON.stringify({
            plan_type: "plus",
            rate_limit: {
              primary_window: {
                used_percent: 20,
                limit_window_seconds: 18_000,
                reset_after_seconds: 3_600,
              },
            },
            rate_limit_reset_credits: { available_count: 4 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          available_count: 99,
          credits: [
            { id: "a", status: "redeeming", title: "Redeeming" },
            { id: "b", status: "available", title: "One" },
            { id: "c", status: "unknown", title: "Unknown" },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    const out = await queryOpenAIQuota({ includeResetDetails: true });

    expect(out && out.success ? out.bankedResets : undefined).toEqual({
      availableCount: 4,
      credits: [{ title: "One" }],
    });
  });

  it("accepts useful credits-only and reset-count-only payloads but not an empty one", async () => {
    mocks.readAuthFileCached.mockResolvedValue({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              credits: { has_credits: true, unlimited: false, balance: "12.34" },
            }),
            { status: 200 },
          ),
      ),
    );
    const creditsOnly = await queryOpenAIQuota();
    expect(creditsOnly && creditsOnly.success ? creditsOnly.windows : undefined).toEqual({});
    expect(creditsOnly && creditsOnly.success ? creditsOnly.credits?.balance : undefined).toBe(
      "12.34",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              rate_limit_reset_credits: { available_count: 2 },
            }),
            { status: 200 },
          ),
      ),
    );
    const resetsOnly = await queryOpenAIQuota();
    expect(resetsOnly && resetsOnly.success ? resetsOnly.windows : undefined).toEqual({});
    expect(resetsOnly && resetsOnly.success ? resetsOnly.bankedResets?.availableCount : 0).toBe(2);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "plus",
              credits: { has_credits: true, unlimited: false, balance: "0" },
            }),
            { status: 200 },
          ),
      ),
    );
    await expect(queryOpenAIQuota()).resolves.toEqual({
      success: false,
      error: "No quota data",
    });
  });

  it("returns separate hourly and weekly windows", async () => {
    mocks.readAuthFileCached.mockResolvedValueOnce({
      openai: { type: "oauth", access: "a.b.c", expires: Date.now() + 60_000 },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              plan_type: "pro",
              rate_limit: {
                limit_reached: false,
                primary_window: {
                  used_percent: 10,
                  limit_window_seconds: 18_000,
                  reset_after_seconds: 3600,
                },
                secondary_window: {
                  used_percent: 70,
                  limit_window_seconds: 604_800,
                  reset_after_seconds: 604_800,
                },
              },
            }),
            { status: 200 },
          ),
      ) as any,
    );

    const out = await queryOpenAIQuota();
    expect(out && out.success ? out.windows.hourly?.percentRemaining : -1).toBe(90);
    expect(out && out.success ? out.windows.weekly?.percentRemaining : -1).toBe(30);
  });
});
