import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({ fetchResponse: vi.fn() }));

const stateMocks = vi.hoisted(() => ({
  dir: `${process.env["TEMP"] ?? process.cwd()}/ocq-anthropic-saved-resets-${process.pid}`,
}));

const fsPromisesMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  stat: vi.fn(),
}));

import { rmSync } from "node:fs";

import { execFile } from "child_process";
import {
  clearAnthropicDiagnosticsCacheForTests,
  getAnthropicDiagnostics,
  parseOAuthUsageResponse,
  queryAnthropicQuotaWithOAuth,
} from "../src/lib/anthropic.js";
import { fetchWithTimeout } from "../src/lib/http.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const isThrottlePath = (path: unknown) => String(path).includes("anthropic-oauth-throttle");
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) =>
      isThrottlePath(args[0]) ? actual.readFile(...args) : fsPromisesMocks.readFile(...args),
    ),
    stat: vi.fn((...args: Parameters<typeof actual.stat>) =>
      isThrottlePath(args[0]) ? actual.stat(...args) : fsPromisesMocks.stat(...args),
    ),
  };
});
vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: vi.fn().mockResolvedValue(null),
  readAuthFile: vi.fn().mockResolvedValue(null),
  getCredentialDatabasePaths: vi.fn().mockReturnValue([]),
}));
vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: vi.fn(
    async (
      _url: string,
      options: { consume: (response: Response, signal: AbortSignal) => Promise<unknown> },
    ) => await options.consume(await httpMocks.fetchResponse(), new AbortController().signal),
  ),
}));
vi.mock("../src/lib/private-state-paths.js", () => ({
  getGuiPrivateStatePath: (...segments: string[]) => [stateMocks.dir, ...segments].join("/"),
}));

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const execFileMock = vi.mocked(execFile);
const readFileMock = fsPromisesMocks.readFile;
const statMock = fsPromisesMocks.stat;
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

beforeEach(async () => {
  rmSync(stateMocks.dir, { recursive: true, force: true });
  readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: "tok-1" } }));
});

afterEach(async () => {
  vi.useRealTimers();
  rmSync(stateMocks.dir, { recursive: true, force: true });
  execFileMock.mockReset();
  readFileMock.mockReset();
  statMock.mockReset();
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
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])("caps display at 100 segments instead of hiding inventory (%s, %s)", (...counts) => {
    const quota = parse({
      eligible: true,
      grants: counts.map((resets_left) => ({ resets_left, paused: false })),
    });
    expect(quota?.saved_resets?.availableCount).toBe(100);
    expect(quota?.saved_resets?.credits).toHaveLength(100);
    expect(quota?.five_hour).toBeDefined();
  });

  it("orders unsorted grants earliest known expiry first and unknown last, keeping the earliest when capped", () => {
    const quota = parse({
      eligible: true,
      grants: [
        { resets_left: 60, paused: false },
        { resets_left: 60, paused: false, ends_at: "2026-12-05T00:00:00Z" },
        { resets_left: 2, paused: false, ends_at: "2026-12-01T00:00:00Z" },
        { resets_left: 2, paused: false, ends_at: "2026-12-05T00:00:00Z" },
        { resets_left: 1, paused: false, ends_at: "2026-12-03T00:00:00Z" },
      ],
    });
    const credits = quota?.saved_resets?.credits ?? [];
    expect(quota?.saved_resets?.availableCount).toBe(100);
    expect(credits).toHaveLength(100);
    expect(credits.slice(0, 3)).toEqual([
      { expiresAtIso: "2026-12-01T00:00:00.000Z" },
      { expiresAtIso: "2026-12-01T00:00:00.000Z" },
      { expiresAtIso: "2026-12-03T00:00:00.000Z" },
    ]);
    expect(credits.filter((c) => c.expiresAtIso === "2026-12-05T00:00:00.000Z")).toHaveLength(62);
    expect(credits.filter((c) => c.expiresAtIso === undefined)).toHaveLength(35);
    expect(credits.at(-1)).toEqual({});
  });

  it("keeps repeated expiries and sorts known before unknown below the cap", () => {
    const quota = parse({
      eligible: true,
      grants: [
        { resets_left: 1, paused: false },
        { resets_left: 1, paused: false, ends_at: "2026-12-02T00:00:00Z" },
        { resets_left: 1, paused: false, ends_at: "2026-12-02T00:00:00Z" },
      ],
    });
    expect(quota?.saved_resets).toEqual({
      availableCount: 3,
      credits: [
        { expiresAtIso: "2026-12-02T00:00:00.000Z" },
        { expiresAtIso: "2026-12-02T00:00:00.000Z" },
        {},
      ],
    });
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

  const ENHANCED_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1";
  const PLAIN_URL = "https://api.anthropic.com/api/oauth/usage";
  const userAgentAt = (index: number) =>
    (fetchMock.mock.calls[index]![1] as { request: { headers: Record<string, string> } }).request
      .headers["User-Agent"];

  it.each([
    400, 403,
  ])("uses the plain form only on the next eligible claim after HTTP %i", async (status) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      mockCli({ authenticated: true, ...FIRST_PARTY }, 3);
      httpMocks.fetchResponse
        .mockResolvedValueOnce(response(status, "forbidden"))
        .mockResolvedValueOnce(response(200, windows));

      const first = await run();
      expect(urls()).toEqual([ENHANCED_URL]);
      expect(first.quotaSupported).toBe(false);

      // One claim, one HTTP request: the same spacing window never carries a
      // second enhanced/plain attempt.
      const suppressed = await run();
      expect(urls()).toEqual([ENHANCED_URL]);
      expect(suppressed.retryAtMs).toBe(NOW + 180_000);

      await vi.advanceTimersByTimeAsync(180_001);
      const plain = await run();
      expect(urls()).toEqual([ENHANCED_URL, PLAIN_URL]);
      expect(plain.quotaSupported).toBe(true);
      expect(plain.quota?.saved_resets).toBeUndefined();
      expect(userAgentAt(0)).toBe("claude-cli/1.2.3 (external, cli)");
      expect(userAgentAt(1)).toBe("claude-code/1.2.3");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the bare plain identity only on the next eligible claim when the CLI version is unknown", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      execFileMock.mockReset();
      // First exec step answers `--version` with no version at all; three
      // probes cover the rejected enhanced claim, the spacing skip and the
      // eligible plain claim.
      const steps = Array.from({ length: 3 }, () => [
        { stdout: "claude\n" },
        { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY }) },
      ]).flat();
      execFileMock.mockImplementation((_f, _a, _o, callback) => {
        callback(null, steps.shift()?.stdout ?? "", "");
        return {} as never;
      });
      httpMocks.fetchResponse
        .mockResolvedValueOnce(response(400, "bad"))
        .mockResolvedValueOnce(response(200, windows));
      await run();
      expect(urls()).toEqual([ENHANCED_URL]);
      await vi.advanceTimersByTimeAsync(180_001);
      await run();
      expect(urls()).toEqual([ENHANCED_URL, PLAIN_URL]);
      const agents = fetchMock.mock.calls.map(
        (call) =>
          (call[1] as { request: { headers: Record<string, string> } }).request.headers[
            "User-Agent"
          ],
      );
      expect(agents).toEqual(["claude-cli (external, cli)", "claude-code"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    undefined,
    4_000,
  ])("gives the next plain-form claim its own timeout budget (%s)", async (requestTimeoutMs) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      mockCli({ authenticated: true, ...FIRST_PARTY }, 3);
      httpMocks.fetchResponse
        .mockImplementationOnce(async () => {
          vi.setSystemTime(NOW + 1_500);
          return response(400, "bad");
        })
        .mockResolvedValueOnce(response(200, windows));
      const options = requestTimeoutMs === undefined ? {} : { requestTimeoutMs };
      await getAnthropicDiagnostics(options);
      await vi.advanceTimersByTimeAsync(180_001);
      await getAnthropicDiagnostics(options);
      expect(
        fetchMock.mock.calls.map((call) => (call[1] as { timeoutMs?: number }).timeoutMs),
      ).toEqual([requestTimeoutMs, requestTimeoutMs]);
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

  it.each([
    "forbidden: user:profile required",
    JSON.stringify({ error: { message: "missing User:Profile permission" } }),
  ])("does not fall back on a 403 naming user:profile without the word scope", async (body) => {
    httpMocks.fetchResponse.mockResolvedValue(response(403, body));
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
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockCli({ authenticated: true, ...FIRST_PARTY, ...localQuota }, 2);
    httpMocks.fetchResponse.mockResolvedValueOnce(
      response(200, { cedar_ember: eligible, five_hour: { utilization: 1 } }),
    );
    expect(
      (await getAnthropicDiagnostics({ forceRefresh: true, operationCache: new Map() })).quota,
    ).toMatchObject({ saved_resets: { availableCount: 1 } });
    await vi.advanceTimersByTimeAsync(180_001);
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
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const body = response(200, { ...windows, cedar_ember: eligible });
    httpMocks.fetchResponse.mockResolvedValue(body);
    await queryAnthropicQuotaWithOAuth("other-token");
    await vi.advanceTimersByTimeAsync(180_001);
    await queryAnthropicQuotaWithOAuth("tok-1");
    await vi.advanceTimersByTimeAsync(180_001);
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
    // The failure does not bypass the shared request spacing.
    expect(await queryAnthropicQuotaWithOAuth("tok-1")).toMatchObject({ success: false });
    await vi.advanceTimersByTimeAsync(180_001);
    expect(await queryAnthropicQuotaWithOAuth("other-token")).toMatchObject({
      success: true,
      saved_resets: { availableCount: 1 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    expect(
      result.entries.some(
        (entry) =>
          entry.semantic?.metric.kind === "window" && entry.semantic.metric.window === "five_hour",
      ),
    ).toBe(true);
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
