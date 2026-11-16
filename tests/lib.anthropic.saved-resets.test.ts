import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({ fetchResponse: vi.fn() }));

import { execFile } from "child_process";
import { readFile } from "fs/promises";
import {
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  parseOAuthUsageResponse,
  queryAnthropicQuotaWithOAuth,
} from "../src/lib/anthropic.js";
import { fetchWithTimeout } from "../src/lib/http.js";
import { REQUEST_TIMEOUT_MS } from "../src/lib/types.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn().mockResolvedValue(null),
}));
vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: vi.fn(
    async (
      _url: string,
      options: { consume: (response: Response, signal: AbortSignal) => Promise<unknown> },
    ) => await options.consume(await httpMocks.fetchResponse(), new AbortController().signal),
  ),
}));

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const execFileMock = vi.mocked(execFile);
const readFileMock = vi.mocked(readFile);
const fetchMock = vi.mocked(fetchWithTimeout);
const windows = { five_hour: { utilization: 10 }, seven_day: { utilization: 20 } };
const FIRST_PARTY = { authMethod: "claude.ai", apiProvider: "firstParty" };

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function withResets(cedar_ember: unknown) {
  return { ...windows, cedar_ember };
}

function parse(cedar_ember: unknown) {
  return parseOAuthUsageResponse(withResets(cedar_ember), NOW);
}

function mockCli(authJson: Record<string, unknown>, probes = 1): void {
  const steps = Array.from({ length: probes }, () => [
    { stdout: "claude 1.2.3\n" },
    { stdout: JSON.stringify(authJson) },
  ]).flat();
  execFileMock.mockImplementation((_f, _a, _o, callback) => {
    const step = steps.shift() ?? { stdout: "" };
    callback(null, step.stdout, "");
    return {} as never;
  });
}

beforeEach(() => {
  readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }));
});

afterEach(() => {
  execFileMock.mockReset();
  readFileMock.mockReset();
  fetchMock.mockClear();
  httpMocks.fetchResponse.mockReset();
  clearAnthropicDiagnosticsCacheForTests();
});

describe("saved reset inventory parsing", () => {
  it("sums resets_left, expands expiry per reset, keeps unknown expiry unknown, drops identifiers", () => {
    const quota = parse({
      eligible: true,
      next_grant_id: "g-secret",
      grants: [
        {
          id: "g-secret",
          label: "Private label",
          resets_left: 2,
          resets_total: 3,
          paused: false,
          starts_at: null,
          ends_at: "2026-12-01T00:00:00Z",
          clears: ["five_hour"],
          usable_now: false,
        },
        { resets_left: 1, paused: false },
        { resets_left: 1, paused: false, ends_at: null },
      ],
    });
    expect(quota?.saved_resets).toEqual({
      availableCount: 4,
      credits: [
        { expiresAtIso: "2026-12-01T00:00:00.000Z" },
        { expiresAtIso: "2026-12-01T00:00:00.000Z" },
        {},
        {},
      ],
    });
    expect(JSON.stringify(quota)).not.toMatch(/g-secret|Private label/);
    expect(quota?.five_hour).toBeDefined();
  });

  it.each([
    ["eligible false", { eligible: false, grants: [{ resets_left: 1, paused: false }] }],
    ["eligible absent", { grants: [{ resets_left: 1, paused: false }] }],
    ["grants not an array", { eligible: true, grants: {} }],
    ["paused", { eligible: true, grants: [{ resets_left: 1, paused: true }] }],
    ["unknown pause", { eligible: true, grants: [{ resets_left: 1 }] }],
    ["negative count", { eligible: true, grants: [{ resets_left: -1, paused: false }] }],
    ["fractional count", { eligible: true, grants: [{ resets_left: 1.5, paused: false }] }],
    ["zero left", { eligible: true, grants: [{ resets_left: 0, paused: false }] }],
    [
      "expired",
      {
        eligible: true,
        grants: [{ resets_left: 1, paused: false, ends_at: "2026-11-16T12:00:00Z" }],
      },
    ],
    [
      "not started",
      {
        eligible: true,
        grants: [{ resets_left: 1, paused: false, starts_at: "2027-01-01T00:00:00Z" }],
      },
    ],
    [
      "invalid end date",
      { eligible: true, grants: [{ resets_left: 1, paused: false, ends_at: "soon" }] },
    ],
    [
      "invalid start date",
      { eligible: true, grants: [{ resets_left: 1, paused: false, starts_at: "soon" }] },
    ],
  ])("yields no inventory when %s, leaving ordinary quota intact", (_name, cedar) => {
    const quota = parse(cedar);
    expect(quota?.saved_resets).toBeUndefined();
    expect(quota?.five_hour).toBeDefined();
  });

  it("counts valid grants even when a sibling grant is invalid", () => {
    const quota = parse({
      eligible: true,
      grants: [
        { resets_left: -4, paused: false },
        { resets_left: 2, paused: false },
      ],
    });
    expect(quota?.saved_resets?.availableCount).toBe(2);
  });

  it("accepts 100 resets and gives each its own expiry record", () => {
    const quota = parse({
      eligible: true,
      grants: [{ resets_left: 100, paused: false, ends_at: "2026-12-01T00:00:00Z" }],
    });
    expect(quota?.saved_resets?.availableCount).toBe(100);
    expect(quota?.saved_resets?.credits).toHaveLength(100);
    expect(quota?.saved_resets?.credits.every((c) => c.expiresAtIso !== undefined)).toBe(true);
  });

  it.each([
    [101],
    [5_000],
    [Number.MAX_SAFE_INTEGER],
    [50, 51],
  ])("omits the entire inventory above 100 (%s, %s)", (...counts) => {
    const quota = parse({
      eligible: true,
      grants: counts.map((resets_left) => ({ resets_left, paused: false })),
    });
    expect(quota?.saved_resets).toBeUndefined();
    expect(quota?.five_hour).toBeDefined();
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    Number.POSITIVE_INFINITY,
    Number.NaN,
  ])("rejects the non-safe count %s", (count) => {
    const quota = parse({
      eligible: true,
      grants: [
        { resets_left: count, paused: false },
        { resets_left: 2, paused: false },
      ],
    });
    expect(quota?.saved_resets?.availableCount).toBe(2);
  });

  it.each([
    ["resets_total below resets_left", { resets_left: 3, resets_total: 2 }],
    ["negative resets_total", { resets_left: 1, resets_total: -1 }],
    ["fractional resets_total", { resets_left: 1, resets_total: 1.5 }],
    ["null resets_total", { resets_left: 1, resets_total: null }],
    ["string resets_total", { resets_left: 1, resets_total: "3" }],
  ])("omits a grant with %s but keeps valid siblings", (_name, bad) => {
    const quota = parse({
      eligible: true,
      grants: [
        { ...bad, paused: false },
        { resets_left: 1, resets_total: 4, paused: false },
        { resets_left: 1, paused: false },
      ],
    });
    expect(quota?.saved_resets?.availableCount).toBe(2);
  });
});

describe("OAuth usage request shape and fallback", () => {
  async function run() {
    return await getAnthropicDiagnostics();
  }
  const urls = () => fetchMock.mock.calls.map((call) => call[0]);

  beforeEach(() => mockCli({ authenticated: true, ...FIRST_PARTY }, 1));

  it("requests the enhanced URL with a CLI-shaped user agent and no skip_spend", async () => {
    httpMocks.fetchResponse.mockResolvedValue(response(200, windows));
    await run();
    expect(urls()).toEqual(["https://api.anthropic.com/api/oauth/usage?cedar_ember=1"]);
    const headers = (
      fetchMock.mock.calls[0]![1] as { request: { headers: Record<string, string> } }
    ).request.headers;
    expect(headers["User-Agent"]).toBe("claude-cli/1.2.3 (external, cli)");
    expect(String(urls()[0])).not.toContain("skip_spend");
  });

  it.each([400, 403])("retries once without cedar_ember after HTTP %i", async (status) => {
    httpMocks.fetchResponse
      .mockResolvedValueOnce(response(status, "forbidden"))
      .mockResolvedValueOnce(response(200, windows));
    const diagnostics = await run();
    expect(urls()).toEqual([
      "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
      "https://api.anthropic.com/api/oauth/usage",
    ]);
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.saved_resets).toBeUndefined();
    const userAgent = (i: number) =>
      (fetchMock.mock.calls[i]![1] as { request: { headers: Record<string, string> } }).request
        .headers["User-Agent"];
    expect(userAgent(0)).toBe("claude-cli/1.2.3 (external, cli)");
    expect(userAgent(1)).toBe("claude-code/1.2.3");
  });

  it("falls back with the bare claude-code identity when the CLI version is unknown", async () => {
    execFileMock.mockReset();
    mockCli({ authenticated: true, ...FIRST_PARTY }, 1);
    // First exec step answers `--version` with no version at all.
    const steps = [
      { stdout: "claude\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY }) },
    ];
    execFileMock.mockImplementation((_f, _a, _o, callback) => {
      callback(null, steps.shift()?.stdout ?? "", "");
      return {} as never;
    });
    httpMocks.fetchResponse
      .mockResolvedValueOnce(response(400, "bad"))
      .mockResolvedValueOnce(response(200, windows));
    await run();
    const agents = fetchMock.mock.calls.map(
      (call) =>
        (call[1] as { request: { headers: Record<string, string> } }).request.headers["User-Agent"],
    );
    expect(agents).toEqual(["claude-cli (external, cli)", "claude-code"]);
  });

  it("spends one timeout budget across the enhanced attempt and its fallback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      httpMocks.fetchResponse
        .mockImplementationOnce(async () => {
          vi.setSystemTime(NOW + 1_500);
          return response(400, "bad");
        })
        .mockResolvedValueOnce(response(200, windows));
      await getAnthropicDiagnostics({ requestTimeoutMs: 4_000 });
      const timeouts = fetchMock.mock.calls.map(
        (call) => (call[1] as { timeoutMs?: number }).timeoutMs,
      );
      expect(timeouts).toEqual([4_000, 2_500]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the default timeout budget with the fallback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      httpMocks.fetchResponse
        .mockImplementationOnce(async () => {
          vi.setSystemTime(NOW + 1_500);
          return response(400, "bad");
        })
        .mockResolvedValueOnce(response(200, windows));
      await run();
      expect(fetchMock.mock.calls.map((call) => call[1].timeoutMs)).toEqual([
        undefined,
        REQUEST_TIMEOUT_MS - 1_500,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start the fallback once the budget is spent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      httpMocks.fetchResponse.mockImplementationOnce(async () => {
        vi.setSystemTime(NOW + 4_000);
        return response(403, "forbidden");
      });
      const diagnostics = await getAnthropicDiagnostics({ requestTimeoutMs: 4_000 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(diagnostics.quotaSupported).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [401, "unauthorized"],
    [403, "OAuth token does not meet scope requirement user:profile"],
    [429, "slow down"],
    [500, "boom"],
  ])("does not bypass HTTP %i (%s)", async (status, body) => {
    httpMocks.fetchResponse.mockResolvedValue(response(status, body));
    const diagnostics = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics.quotaSupported).toBe(false);
  });

  it("does not retry when the request itself fails (timeout or cancel)", async () => {
    httpMocks.fetchResponse.mockRejectedValue(new Error("aborted"));
    const diagnostics = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics.quotaSupported).toBe(false);
  });

  it("keeps the 429 cooldown token-scoped across the enhanced request", async () => {
    httpMocks.fetchResponse.mockResolvedValue(response(429, "slow"));
    await run();
    mockCli({ authenticated: true, ...FIRST_PARTY }, 1);
    const second = await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.retryAtMs).toBeGreaterThan(Date.now());
  });
});

describe("local CLI quota path", () => {
  const localQuota = {
    quota: {
      five_hour: { used_percentage: 57, resets_at: "2026-11-16T18:00:00.000Z" },
      seven_day: { usedPercentage: 12, resetsAt: "2026-11-23T00:00:00.000Z" },
    },
  };
  const eligible = {
    eligible: true,
    grants: [{ resets_left: 1, paused: false, ends_at: "2099-01-01T00:00:00Z" }],
  };

  it("adds reset inventory for a verified login and keeps local windows", async () => {
    mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota });
    httpMocks.fetchResponse.mockResolvedValue(
      response(200, { five_hour: { utilization: 99 }, cedar_ember: eligible }),
    );
    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics.quota?.five_hour?.percentRemaining).toBe(43);
    expect(diagnostics.quota?.saved_resets?.availableCount).toBe(1);
    expect(diagnostics.credentialFingerprint).toBeUndefined();
  });

  it("does not read a token or call OAuth when the login is not verified first-party", async () => {
    mockCli({ authenticated: true, ...localQuota });
    const diagnostics = await getAnthropicDiagnostics();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(diagnostics.quota?.saved_resets).toBeUndefined();
  });

  it.each([
    ["HTTP failure", () => httpMocks.fetchResponse.mockResolvedValue(response(500, "x"))],
    ["request error", () => httpMocks.fetchResponse.mockRejectedValue(new Error("timeout"))],
    ["unreadable token", () => readFileMock.mockRejectedValue(new Error("ENOENT"))],
  ])("leaves local quota untouched on %s", async (_name, arrange) => {
    mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota });
    arrange();
    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour?.percentRemaining).toBe(43);
    expect(diagnostics.quota?.saved_resets).toBeUndefined();
  });

  it("does not carry reset metadata to a later failure or another account token", async () => {
    mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota }, 2);
    httpMocks.fetchResponse.mockResolvedValueOnce(
      response(200, { cedar_ember: eligible, five_hour: { utilization: 1 } }),
    );
    expect(
      (await getAnthropicDiagnostics({ forceRefresh: true, operationCache: new Map() })).quota,
    ).toMatchObject({ saved_resets: { availableCount: 1 } });
    readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "tok-2" } }));
    httpMocks.fetchResponse.mockResolvedValueOnce(response(500, "x"));
    const second = await getAnthropicDiagnostics({ forceRefresh: true, operationCache: new Map() });
    expect(second.quota?.saved_resets).toBeUndefined();
  });

  it.each([
    "500",
    "401",
    "timeout",
  ])("removes cached resets after a forced %s failure without losing quota or another token", async (failure) => {
    const body = response(200, { ...windows, cedar_ember: eligible });
    httpMocks.fetchResponse.mockResolvedValue(body);
    await queryAnthropicQuotaWithOAuth("other-token");
    await queryAnthropicQuotaWithOAuth("tok-1");
    if (failure === "timeout") {
      httpMocks.fetchResponse.mockRejectedValueOnce(new Error("timeout"));
    } else {
      httpMocks.fetchResponse.mockResolvedValueOnce(response(Number(failure), "failure"));
    }
    mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota }, 2);
    const failed = await getAnthropicDiagnostics({
      forceRefresh: true,
      operationCache: new Map(),
    });
    expect(failed.quota?.saved_resets).toBeUndefined();
    const local = await getAnthropicDiagnostics();
    expect(local.quota?.five_hour?.percentRemaining).toBe(43);
    expect(local.quota?.saved_resets).toBeUndefined();
    const cached = await queryAnthropicQuotaWithOAuth("tok-1");
    expect(cached).toMatchObject({ success: true, five_hour: { percentRemaining: 90 } });
    expect(cached).not.toHaveProperty("saved_resets");
    expect(await queryAnthropicQuotaWithOAuth("other-token")).toMatchObject({
      saved_resets: { availableCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("exposes a claude-agent:resets value row through the provider", async () => {
    mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota });
    httpMocks.fetchResponse.mockResolvedValue(
      response(200, { five_hour: { utilization: 99 }, cedar_ember: eligible }),
    );
    const result = await claudeAgentProvider.fetch({ config: {} } as never);
    const row = result.entries.find((entry) => entry.rowKey === "claude-agent:resets");
    expect(row).toMatchObject({
      kind: "value",
      group: "Claude Agent",
      value: "1 available",
      bankedResets: { availableCount: 1, credits: [{ expiresAtIso: "2099-01-01T00:00:00.000Z" }] },
    });
    expect(result.entries.some((entry) => entry.rowKey === "window:five_hour")).toBe(true);
  });

  it("prunes expired cached resets before emitting a provider row", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota }, 2);
      httpMocks.fetchResponse.mockResolvedValue(
        response(200, {
          ...windows,
          cedar_ember: {
            eligible: true,
            grants: [
              { resets_left: 1, paused: false, ends_at: new Date(NOW + 1_000).toISOString() },
              { resets_left: 1, paused: false },
            ],
          },
        }),
      );
      await claudeAgentProvider.fetch({ config: {} } as never);
      vi.setSystemTime(NOW + 2_000);
      const result = await claudeAgentProvider.fetch({ config: {} } as never);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.entries.find((entry) => entry.rowKey === "claude-agent:resets")).toMatchObject({
        value: "1 available",
        bankedResets: { availableCount: 1, credits: [{}] },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
