import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const fetchResponse = vi.fn();
  return {
    fetchResponse,
    fetchWithTimeout: vi.fn(
      async (
        _url: string,
        options: {
          consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
        },
      ) => {
        const response = await fetchResponse();
        return await options.consume(response, new AbortController().signal);
      },
    ),
  };
});

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../src/lib/opencode-go.js";

type WindowKey = "rolling" | "weekly" | "monthly";

function validPayload(): Record<string, unknown> {
  return {
    usage: {
      rolling: {
        status: "ok",
        percent: 12.5,
        resetsAt: "2026-08-12T12:30:00Z",
      },
      weekly: {
        status: "ok",
        percent: 45,
        resetsAt: "2026-08-16T18:00:00+02:00",
      },
      monthly: {
        status: "ok",
        percent: 80,
        resetsAt: "2026-09-01T00:00:00-04:00",
      },
    },
    ignored: true,
  };
}

function windowFrom(payload: Record<string, unknown>, key: WindowKey): Record<string, unknown> {
  return ((payload.usage as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;
}

function mockSuccess(payload: unknown): void {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue(payload),
  });
}

function mockHttpFailure(status: number, text: string): void {
  mocks.fetchResponse.mockResolvedValueOnce({
    ok: false,
    status,
    text: vi.fn().mockResolvedValue(text),
  });
}

describe("queryOpenCodeGoQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the fixed Bearer JSON request and normalizes all windows", async () => {
    const token = "go-test-token";
    mockSuccess(validPayload());

    const result = await queryOpenCodeGoQuota(token, { requestTimeoutMs: 4321 });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith("https://opencode.ai/zen/go/v1/usage", {
      request: {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      },
      timeoutMs: 4321,
      consume: expect.any(Function),
    });
    const request = mocks.fetchWithTimeout.mock.calls[0]?.[1]?.request;
    expect(JSON.stringify(request)).not.toContain("Cookie");
    expect(result).toEqual({
      success: true,
      rolling: {
        status: "ok",
        usagePercent: 12.5,
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      weekly: {
        status: "ok",
        usagePercent: 45,
        percentRemaining: 55,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      monthly: {
        status: "ok",
        usagePercent: 80,
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    });
  });

  it("accepts 0 and 100 percent plus valid past timestamps", async () => {
    const payload = validPayload();
    windowFrom(payload, "rolling").percent = 0;
    windowFrom(payload, "rolling").resetsAt = "2020-01-01T00:00:00Z";
    windowFrom(payload, "weekly").percent = 100;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({
      success: true,
      rolling: { usagePercent: 0, percentRemaining: 100 },
      weekly: { usagePercent: 100, percentRemaining: 0 },
    });
  });

  it("accepts a rate-limited window as a valid exhausted state", async () => {
    const payload = validPayload();
    windowFrom(payload, "monthly").status = "rate-limited";
    windowFrom(payload, "monthly").percent = 100;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({
      success: true,
      monthly: { status: "rate-limited", usagePercent: 100, percentRemaining: 0 },
    });
  });

  it.each([
    0, 42, 100,
  ])("treats a structurally valid rate-limited window as exhausted regardless of percent %j", async (percent) => {
    const payload = validPayload();
    windowFrom(payload, "weekly").status = "rate-limited";
    windowFrom(payload, "weekly").percent = percent;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({
      success: true,
      weekly: {
        status: "rate-limited",
        usagePercent: 100,
        percentRemaining: 0,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
    });
  });

  it("keeps healthy sibling windows when one window is rate-limited", async () => {
    const payload = validPayload();
    windowFrom(payload, "rolling").percent = 17;
    windowFrom(payload, "weekly").status = "rate-limited";
    windowFrom(payload, "weekly").percent = 42;
    windowFrom(payload, "monthly").percent = 91;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toEqual({
      success: true,
      rolling: {
        status: "ok",
        usagePercent: 17,
        percentRemaining: 83,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      weekly: {
        status: "rate-limited",
        usagePercent: 100,
        percentRemaining: 0,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      monthly: {
        status: "ok",
        usagePercent: 91,
        percentRemaining: 9,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    });
  });

  it.each([
    { percent: -1 },
    { percent: 101 },
    { percent: "10" },
    { percent: Number.NaN },
  ])("still rejects a rate-limited window with invalid percent $percent", async ({ percent }) => {
    const payload = validPayload();
    windowFrom(payload, "weekly").status = "rate-limited";
    windowFrom(payload, "weekly").percent = percent;
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: weekly percent must be a finite number from 0 to 100",
    });
  });

  it("still rejects a rate-limited window with a malformed reset", async () => {
    const payload = validPayload();
    windowFrom(payload, "monthly").status = "rate-limited";
    windowFrom(payload, "monthly").resetsAt = "2026-08-12T12:30:00";
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: monthly resetsAt must be an offset-qualified ISO timestamp",
    });
  });

  it.each([null, [], "bad", 1])("rejects a non-object root: %j", async (payload) => {
    mockSuccess(payload);
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: root must be an object",
    });
  });

  it.each([null, [], "bad", 1])("rejects a non-object usage value: %j", async (usage) => {
    mockSuccess({ usage });
    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: usage must be an object",
    });
  });

  it.each(["rolling", "weekly", "monthly"] as const)("requires the %s window", async (window) => {
    const payload = validPayload();
    delete (payload.usage as Record<string, unknown>)[window];
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error: `Invalid OpenCode Go API response: ${window} window is missing or malformed`,
    });
  });

  it.each([
    "OK",
    " ok",
    "ok ",
    "error",
    null,
    1,
  ])("requires exact raw status ok: %j", async (status) => {
    const payload = validPayload();
    windowFrom(payload, "weekly").status = status;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");
    expect(result).toMatchObject({ success: false });
    expect(result).toHaveProperty(
      "error",
      expect.stringContaining("Invalid OpenCode Go API response: weekly status is not ok"),
    );
  });

  it.each([
    -1,
    101,
    "10",
    null,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid percent %j", async (percent) => {
    const payload = validPayload();
    windowFrom(payload, "monthly").percent = percent;
    mockSuccess(payload);

    await expect(queryOpenCodeGoQuota("token")).resolves.toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: monthly percent must be a finite number from 0 to 100",
    });
  });

  it.each([
    "2026-08-12",
    "2026-08-12T12:30:00",
    "Wed, 12 Aug 2026 12:30:00 GMT",
    "2026-08-12T12:30:00+0200",
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "not-a-date",
    null,
  ])("rejects non-offset-qualified resetsAt %j", async (resetsAt) => {
    const payload = validPayload();
    windowFrom(payload, "rolling").resetsAt = resetsAt;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota("token");
    expect(result).toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: rolling resetsAt must be an offset-qualified ISO timestamp",
    });
  });

  it("returns a stable malformed JSON error with token redaction", async () => {
    const token = "distinctive-secret-token";
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      json: vi
        .fn()
        .mockRejectedValue(new SyntaxError(`Unexpected ${token}\nend ${token} of JSON input`)),
    });

    const result = await queryOpenCodeGoQuota(token);

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toEqual({
      success: false,
      error:
        "Invalid OpenCode Go API response: body is not valid JSON: Unexpected [redacted] end [redacted] of JSON input",
    });
  });

  it("redacts repeated tokens before sanitizing and bounding HTTP bodies", async () => {
    const token = "distinctive-secret-token";
    mockHttpFailure(401, `\u001b[31m${token}\n${"x".repeat(140)} ${token}\u001b[0m`);

    const result = await queryOpenCodeGoQuota(token);

    expect(result).toMatchObject({ success: false, retryable: false });
    expect(JSON.stringify(result)).not.toContain(token);
    expect((result as { error: string }).error).toContain("OpenCode Go API error 401: [redacted]");
    expect((result as { error: string }).error.length).toBeLessThanOrEqual(
      "OpenCode Go API error 401: ".length + 120,
    );
  });

  it("flags a 403 EntitlementError body as not subscribed", async () => {
    mockHttpFailure(
      403,
      '{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}',
    );

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toEqual({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });
  });

  it.each([
    [403, '{"error":"forbidden"}'],
    [403, '{"error":{"type":"EntitlementError"}}'],
    [403, '{"type":"error","error":{"type":"entitlementerror"}}'],
    [403, '{"error":{"type":"PermissionError","message":"subscription required"}}'],
    [403, "not-json EntitlementError"],
    [401, '{"type":"error","error":{"type":"EntitlementError"}}'],
  ])("keeps unrelated HTTP %s body %s as an ordinary error", async (status, body) => {
    mockHttpFailure(status, body);

    const result = await queryOpenCodeGoQuota("token");

    expect(result).toMatchObject({ success: false, retryable: false });
    expect((result as { error: string }).error).toContain(`OpenCode Go API error ${status}`);
    expect((result as { notSubscribed?: true }).notSubscribed).toBeUndefined();
  });

  it("retains the HTTP status when reading a non-success body fails", async () => {
    const token = "distinctive-secret-token";
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: vi
        .fn()
        .mockRejectedValue(new Error(`body ${token}\n${"x".repeat(140)} ${token} failed`)),
    });

    const result = await queryOpenCodeGoQuota(token);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(JSON.stringify(result)).not.toContain(token);
    expect((result as { error: string }).error).toContain(
      "OpenCode Go API error 503: body [redacted]",
    );
    expect((result as { error: string }).error.length).toBeLessThanOrEqual(
      "OpenCode Go API error 503: ".length + 120,
    );
  });

  it.each(["network", "body"])("redacts tokens from %s failures", async (failure) => {
    const token = "distinctive-secret-token";
    if (failure === "network") {
      mocks.fetchResponse.mockRejectedValueOnce(new Error(`failed ${token} twice ${token}`));
    } else {
      mocks.fetchResponse.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: vi.fn().mockRejectedValue(new Error(`body ${token} failed`)),
      });
    }

    const result = await queryOpenCodeGoQuota(token);

    expect(result).toMatchObject({ success: false, retryable: true });
    expect(JSON.stringify(result)).not.toContain(token);
    expect((result as { error: string }).error).toContain("[redacted]");
  });

  it("redacts a token returned as a remote window status", async () => {
    const token = "distinctive-secret-token";
    const payload = validPayload();
    windowFrom(payload, "rolling").status = `${token}\nretry`;
    mockSuccess(payload);

    const result = await queryOpenCodeGoQuota(token);

    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: rolling status is not ok: [redacted] retry",
    });
  });
});

describe("queryOpenCodeGoConsoleStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockConsoleStatus(): void {
    const meter = (usedMicroCents: number) => ({
      limitMicroCents: 1_000,
      usedMicroCents,
      resetsAt: "2026-10-01T00:00:00Z",
    });
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          access: { meters: { fiveHour: meter(0), week: meter(250), month: meter(500) } },
        }),
      ),
    });
  }

  it("asks the login's Console server, scoped to the login's org", async () => {
    mockConsoleStatus();

    const result = await queryOpenCodeGoConsoleStatus(
      { accessToken: "console-access", orgId: "wrk_1", server: "https://console.example.test" },
      { requestTimeoutMs: 4321 },
    );

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://console.example.test/api/go/status",
      {
        request: {
          method: "GET",
          headers: {
            Authorization: "Bearer console-access",
            Accept: "application/json",
            "x-org-id": "wrk_1",
          },
        },
        timeoutMs: 4321,
        consume: expect.any(Function),
      },
    );
    expect(result).toMatchObject({
      success: true,
      rolling: { percentRemaining: 100 },
      weekly: { percentRemaining: 75 },
      monthly: { percentRemaining: 50 },
    });
  });

  it("uses the default Console server and no org header when the login has neither", async () => {
    mockConsoleStatus();

    await queryOpenCodeGoConsoleStatus({ accessToken: "console-access" });

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      "https://opencode.ai/console/api/go/status",
      {
        request: {
          method: "GET",
          headers: { Authorization: "Bearer console-access", Accept: "application/json" },
        },
        timeoutMs: undefined,
        consume: expect.any(Function),
      },
    );
  });

  it.each([
    ["missing", undefined],
    ["null", null],
  ] as const)("treats a %s meter reset as optional without using access.endsAt", async (_name, resetsAt) => {
    const meter = (usedMicroCents: number) => ({
      limitMicroCents: 1_000,
      usedMicroCents,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          access: {
            endsAt: "2026-10-01T00:00:00Z",
            meters: { fiveHour: meter(0), week: meter(0), month: meter(0) },
          },
        }),
      ),
    });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: true,
      rolling: { status: "ok", usagePercent: 0, percentRemaining: 100 },
      weekly: { status: "ok", usagePercent: 0, percentRemaining: 100 },
      monthly: { status: "ok", usagePercent: 0, percentRemaining: 100 },
    });
  });

  it.each([
    "",
    "not-a-date",
    "2026-13-01T00:00:00Z",
    42,
  ])("rejects an explicit invalid meter reset %j", async (resetsAt) => {
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          access: {
            meters: {
              fiveHour: { limitMicroCents: 1_000, usedMicroCents: 0, resetsAt },
              week: { limitMicroCents: 1_000, usedMicroCents: 250 },
              month: { limitMicroCents: 1_000, usedMicroCents: 500 },
            },
          },
        }),
      ),
    });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: false,
      error: "Invalid OpenCode Go API response: console rolling resetsAt is missing or invalid",
    });
  });

  it("keeps unknown product metadata out of the result without inventing a plan", async () => {
    mocks.fetchResponse.mockResolvedValueOnce({
      ok: true,
      text: vi.fn().mockResolvedValue(
        JSON.stringify({
          access: {
            plan: "go_plus",
            product: { name: "OpenCode Go Plus", tier: "unknown" },
            meters: {
              fiveHour: {
                limitMicroCents: 1_000,
                usedMicroCents: 0,
                resetsAt: "2026-10-01T00:00:00Z",
              },
              week: {
                limitMicroCents: 1_000,
                usedMicroCents: 250,
                resetsAt: "2026-10-01T00:00:00Z",
              },
              month: {
                limitMicroCents: 1_000,
                usedMicroCents: 500,
                resetsAt: "2026-10-01T00:00:00Z",
              },
            },
          },
        }),
      ),
    });

    const result = await queryOpenCodeGoConsoleStatus({ accessToken: "console-access" });

    expect(result).toMatchObject({ success: true });
    expect(Object.keys(result).sort()).toEqual(["monthly", "rolling", "success", "weekly"]);
    expect(JSON.stringify(result)).not.toContain("Go Plus");
    expect(JSON.stringify(result)).not.toContain("go_plus");
  });

  it("reads HTTP 404 as no Go subscription", async () => {
    mocks.fetchResponse.mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: false,
      error: "OpenCode Go subscription not found for this console account (404)",
      notSubscribed: true,
    });
  });

  it.each([
    [401, false],
    [403, false],
    [500, true],
  ])("keeps HTTP %s as a failed Console request", async (status, retryable) => {
    mocks.fetchResponse.mockResolvedValueOnce({ ok: false, status });

    await expect(queryOpenCodeGoConsoleStatus({ accessToken: "console-access" })).resolves.toEqual({
      success: false,
      error: `OpenCode Console API error ${status} (/api/go/status)`,
      retryable,
    });
  });
});
