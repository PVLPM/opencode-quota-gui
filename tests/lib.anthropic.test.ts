import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpMocks = vi.hoisted(() => ({
  fetchResponse: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  readAuthFileCached: vi.fn(),
}));

const fsMocks = vi.hoisted(() => ({
  existsSync: vi.fn((_path: string) => false),
}));

const identityMocks = vi.hoisted(() => ({
  deriveResolvedAuthIdentity: vi.fn(
    async (params: { providerId: string }) => `identity:${params.providerId}`,
  ),
  composeResolvedAuthIdentities: vi.fn(
    async (params: { providerId: string; identities: readonly string[] }) =>
      `composed:${params.providerId}:${params.identities.join("|")}`,
  ),
}));

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "child_process";
import { readFile } from "fs/promises";
import {
  buildClaudeCommandInvocation,
  clearAnthropicDiagnosticsCacheForTests,
  fingerprintAccessToken,
  getAnthropicDiagnostics,
  getClaudeCodeAccountDiagnostics,
  hasAnthropicCredentialsConfigured,
  parseOAuthUsageResponse,
  parseUsageResponse,
  queryAnthropicQuota,
  queryAnthropicQuotaWithOAuth,
  resolveAnthropicAccountSetIdentity,
  resolveAnthropicAuthIdentity,
} from "../src/lib/anthropic.js";
import { fetchWithTimeout } from "../src/lib/http.js";
import { projectQuotaRunway } from "../src/lib/quota-exhaustion-projection.js";
import fableWeeklyUsage from "./fixtures/anthropic/fable-weekly.sanitized.json";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  existsSync: fsMocks.existsSync,
}));

vi.mock("../src/lib/opencode-auth.js", () => ({
  readAuthFileCached: authMocks.readAuthFileCached,
}));

vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: vi.fn(
    async (
      _url: string,
      options: {
        consume: (response: Response, signal: AbortSignal) => Promise<unknown> | unknown;
      },
    ) => {
      const response = await httpMocks.fetchResponse();
      return await options.consume(response, new AbortController().signal);
    },
  ),
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => identityMocks);

type ExecSequenceStep = {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  errorMessage?: string;
  killed?: boolean;
};

const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_INSTALL_FOLDER_CANDIDATES = [
  join(homedir(), ".claude", "local", "claude"),
  join(homedir(), ".local", "bin", "claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

const execFileMock = vi.mocked(execFile);
const readFileMock = vi.mocked(readFile);
const readAuthFileCachedMock = authMocks.readAuthFileCached;
const fetchWithTimeoutMock = vi.mocked(fetchWithTimeout);
const fetchResponseMock = httpMocks.fetchResponse;
const originalProcessPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setProcessPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
}

function mockExecSequence(steps: ExecSequenceStep[]): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const step = steps.shift();
    if (!step) {
      throw new Error("Unexpected execFile call");
    }

    const error =
      step.code === undefined
        ? null
        : Object.assign(new Error(step.errorMessage ?? `Command failed: ${String(step.code)}`), {
            code: step.code,
            killed: step.killed ?? false,
          });

    callback(error, step.stdout ?? "", step.stderr ?? "");
    return {} as never;
  });
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function mockInvalidJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockRejectedValue(new Error("invalid json")),
    text: vi.fn().mockResolvedValue("{"),
  } as unknown as Response;
}

function mockOAuthResponse(status: number, body: string, retryAfter?: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(retryAfter === undefined ? {} : { "Retry-After": retryAfter }),
    json: vi.fn(),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

/** The first-party claude.ai login fields a signed-in Claude CLI reports in `auth status --json`. */
const FIRST_PARTY_CLAUDE_AI_LOGIN = { authMethod: "claude.ai", apiProvider: "firstParty" } as const;

/** A custom config directory whose path contains spaces, as CLAUDE_CONFIG_DIR would name it. */
const SPACED_CLAUDE_CONFIG_DIRECTORY = join(homedir(), "claude config with spaces");

/** The directory the Claude CLI reads its login from when neither the CLI nor the environment names one. */
const DEFAULT_CLAUDE_CONFIG_DIRECTORY = resolve(join(homedir(), ".claude"));

function authenticatedWithoutQuotaSteps(count: number): ExecSequenceStep[] {
  return Array.from({ length: count }, () => [
    { stdout: "claude 1.2.3\n" },
    { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
  ]).flat();
}

const originalClaudeConfigDirectory = process.env["CLAUDE_CONFIG_DIR"];

beforeEach(() => {
  readAuthFileCachedMock.mockResolvedValue(null);
  // The probe inherits this process's environment, so a developer's own CLAUDE_CONFIG_DIR must not leak in.
  delete process.env["CLAUDE_CONFIG_DIR"];
});

afterEach(() => {
  vi.useRealTimers();
  execFileMock.mockReset();
  fsMocks.existsSync.mockReset();
  fsMocks.existsSync.mockReturnValue(false);
  readFileMock.mockReset();
  readAuthFileCachedMock.mockReset();
  fetchWithTimeoutMock.mockClear();
  fetchResponseMock.mockReset();
  clearAnthropicDiagnosticsCacheForTests();
  if (originalProcessPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalProcessPlatformDescriptor);
  }
  if (originalClaudeConfigDirectory === undefined) {
    delete process.env["CLAUDE_CONFIG_DIR"];
  } else {
    process.env["CLAUDE_CONFIG_DIR"] = originalClaudeConfigDirectory;
  }
});

describe("parseUsageResponse", () => {
  it("parses the current five_hour / seven_day response shape", () => {
    const result = parseUsageResponse({
      five_hour: { utilization: 57, resets_at: "2026-03-25T18:00:00.000Z" },
      seven_day: { utilization: 12, resets_at: "2026-04-01T00:00:00.000Z" },
    });

    expect(result).not.toBeNull();
    expect(result?.five_hour.percentRemaining).toBe(43);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(88);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses nested quota roots and extra alias fields", () => {
    const result = parseUsageResponse({
      quota: {
        fiveHour: { usedPercent: "35", resetAt: "2026-03-25T18:00:00.000Z" },
        sevenDay: { percent_used: 15, resetsAt: "2026-04-01T00:00:00.000Z" },
      },
    });

    expect(result?.five_hour.percentRemaining).toBe(65);
    expect(result?.five_hour.resetTimeIso).toBe("2026-03-25T18:00:00.000Z");
    expect(result?.seven_day.percentRemaining).toBe(85);
    expect(result?.seven_day.resetTimeIso).toBe("2026-04-01T00:00:00.000Z");
  });

  it("parses enabled extra usage as remaining quota", () => {
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 57 },
        seven_day: { utilization: 12 },
        extra_usage: { is_enabled: true, utilization: 37.8 },
      },
      { includeExtraUsage: true },
    );

    expect(result?.extra_usage).toEqual({ percentRemaining: 62 });
  });

  it.each([
    { utilization: 0, percentRemaining: 100 },
    { utilization: 100, percentRemaining: 0 },
  ])("preserves extra usage boundary utilization $utilization", ({
    utilization,
    percentRemaining,
  }) => {
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 57 },
        seven_day: { utilization: 12 },
        extra_usage: { is_enabled: true, utilization },
      },
      { includeExtraUsage: true },
    );

    expect(result?.extra_usage).toEqual({ percentRemaining });
  });

  it("ignores disabled or invalid extra usage without dropping quota windows", () => {
    for (const extraUsage of [
      undefined,
      { is_enabled: false, utilization: 37 },
      { is_enabled: true, utilization: "not-a-number" },
      { is_enabled: true, utilization: 101 },
      { is_enabled: true, utilization: -1 },
    ]) {
      const result = parseUsageResponse(
        {
          five_hour: { utilization: 57 },
          seven_day: { utilization: 12 },
          extra_usage: extraUsage,
        },
        { includeExtraUsage: true },
      );

      expect(result?.five_hour.percentRemaining).toBe(43);
      expect(result?.seven_day.percentRemaining).toBe(88);
      expect(result?.extra_usage).toBeUndefined();
    }
  });

  it("ignores extra usage aliases and string utilization values", () => {
    for (const extraUsage of [
      { is_enabled: true, used_percentage: 37 },
      { is_enabled: true, usedPercent: 37 },
      { is_enabled: true, utilization: "37" },
    ]) {
      const result = parseUsageResponse(
        {
          five_hour: { utilization: 57 },
          seven_day: { utilization: 12 },
          extra_usage: extraUsage,
        },
        { includeExtraUsage: true },
      );

      expect(result?.extra_usage).toBeUndefined();
    }
  });

  it("ignores camelCase extraUsage in OAuth payloads", () => {
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 57 },
        seven_day: { utilization: 12 },
        extraUsage: { is_enabled: true, utilization: 37 },
      },
      { includeExtraUsage: true },
    );

    expect(result?.extra_usage).toBeUndefined();
  });

  it("parses the exact Fable weekly_scoped window from a sanitized response", () => {
    const observedAtMs = Date.parse("2026-07-21T10:00:00.000Z");
    const result = parseOAuthUsageResponse(fableWeeklyUsage, observedAtMs);

    expect(parseUsageResponse(fableWeeklyUsage)).not.toHaveProperty("fable_weekly");
    expect(result).toEqual({
      success: true,
      five_hour: {
        percentRemaining: 58,
        resetTimeIso: "2026-07-21T14:10:00.268Z",
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2026-07-21T09:10:00.268Z",
          observedAtIso: "2026-07-21T10:00:00.000Z",
          endsAtIso: "2026-07-21T14:10:00.268Z",
          fullReset: true,
        },
      },
      seven_day: {
        percentRemaining: 72,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
        fixedWindow: {
          kind: "fixed_window",
          startedAtIso: "2026-07-20T07:00:00.268Z",
          observedAtIso: "2026-07-21T10:00:00.000Z",
          endsAtIso: "2026-07-27T07:00:00.268Z",
          fullReset: true,
        },
      },
      // weekly_scoped carries only a reset time: no fixed cycle or duration is supplied, so the
      // Fable window gets no fixed-window evidence.
      fable_weekly: {
        percentRemaining: 98,
        resetTimeIso: "2026-07-27T07:00:00.268Z",
      },
    });
    expect(result?.fable_weekly).not.toHaveProperty("fixedWindow");
  });

  it("attaches 5h and 7d fixed-window evidence on the CLI payload path", () => {
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 20, resets_at: "2026-07-21T14:10:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-07-27T07:00:00.000Z" },
      },
      { observedAtMs: Date.parse("2026-07-21T10:00:00.000Z") },
    );

    expect(result?.five_hour?.fixedWindow?.startedAtIso).toBe("2026-07-21T09:10:00.000Z");
    expect(result?.seven_day?.fixedWindow?.startedAtIso).toBe("2026-07-20T07:00:00.000Z");
  });

  it("omits fixed-window evidence for a window whose reset has already passed", () => {
    const result = parseOAuthUsageResponse(
      {
        five_hour: { utilization: 20, resets_at: "2026-07-21T14:10:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-07-27T07:00:00.000Z" },
      },
      Date.parse("2026-07-21T15:00:00.000Z"),
    );

    // The 5h reset (14:10) has passed at the observation (15:00), so no evidence. The weekly
    // window still spans the observation, so it keeps its evidence.
    expect(result?.five_hour).not.toHaveProperty("fixedWindow");
    expect(result?.seven_day?.fixedWindow?.startedAtIso).toBe("2026-07-20T07:00:00.000Z");
  });

  it("gives an Anthropic window runway while live and none once its reset has passed", () => {
    const observedAtMs = Date.parse("2026-07-21T10:00:00.000Z");
    const result = parseUsageResponse(
      {
        five_hour: { utilization: 20, resets_at: "2026-07-21T14:10:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-07-27T07:00:00.000Z" },
      },
      { observedAtMs },
    );
    const fiveHour = result?.five_hour;
    expect(fiveHour?.fixedWindow).toBeDefined();

    const runwayAt = (nowMs: number) =>
      projectQuotaRunway({
        percentRemaining: fiveHour?.percentRemaining ?? Number.NaN,
        fixedWindow: fiveHour?.fixedWindow,
        resetTimeIso: fiveHour?.resetTimeIso,
        nowMs,
      });

    expect(runwayAt(observedAtMs)?.kind).toBe("before_reset");
    expect(runwayAt(Date.parse("2026-07-21T14:10:00.000Z"))).toBeNull();
    expect(runwayAt(Date.parse("2026-07-21T15:00:00.000Z"))).toBeNull();
  });

  it("keeps the existing windows when Fable scoped data is absent or malformed", () => {
    const withoutFable = parseOAuthUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Opus" } },
        },
        {
          kind: "weekly_scoped",
          percent: 40,
          scope: { model: { display_name: "Claude Fable 5" } },
        },
        {
          kind: "weekly_scoped",
          percent: "not-a-number",
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });

    expect(withoutFable).toEqual({
      success: true,
      five_hour: { percentRemaining: 80, resetTimeIso: undefined },
      seven_day: { percentRemaining: 70, resetTimeIso: undefined },
    });
  });

  it("accepts a zero-percent Fable window without a reset timestamp", () => {
    const result = parseOAuthUsageResponse({
      five_hour: { utilization: 20 },
      seven_day: { utilization: 30 },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 0,
          resets_at: null,
          scope: { model: { display_name: "Fable" } },
          is_active: false,
        },
      ],
    });

    expect(result?.fable_weekly).toEqual({
      percentRemaining: 100,
      resetTimeIso: undefined,
    });
  });

  it("drops invalid reset timestamps and only caps percent remaining above 100", () => {
    const result = parseUsageResponse({
      usage: {
        five_hour: { used_percentage: 120, resets_at: "\u001b[31mbad-reset" },
        seven_day: { used_percent: -10, reset_at: "not-a-date" },
      },
    });

    expect(result?.five_hour.percentRemaining).toBe(-20);
    expect(result?.five_hour.resetTimeIso).toBeUndefined();
    expect(result?.seven_day.percentRemaining).toBe(100);
    expect(result?.seven_day.resetTimeIso).toBeUndefined();
  });

  it("returns null when required quota windows are missing or invalid", () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse("bad-shape")).toBeNull();
    expect(
      parseUsageResponse({
        rate_limits: {
          five_hour: { used_percentage: "nope" },
          seven_day: { utilization: 12 },
        },
      }),
    ).toBeNull();
    expect(
      parseUsageResponse({
        rateLimits: {
          fiveHour: { used_percentage: 30 },
        },
      }),
    ).toBeNull();
  });

  it.each([
    [
      "an Enterprise response without a weekly limit",
      {
        five_hour: { utilization: 25 },
        seven_day: null,
      },
    ],
    [
      "an Ultra response without a five-hour limit",
      {
        five_hour: null,
        seven_day: { utilization: 35 },
      },
    ],
  ])("parses the reported OAuth window for %s", (_label, response) => {
    expect(parseOAuthUsageResponse(response)).toEqual(
      response.five_hour === null
        ? { success: true, seven_day: { percentRemaining: 65, resetTimeIso: undefined } }
        : { success: true, five_hour: { percentRemaining: 75, resetTimeIso: undefined } },
    );
  });

  it.each([
    [
      "the 5-hour field",
      { seven_day: { utilization: 35 } },
      { success: true, seven_day: { percentRemaining: 65, resetTimeIso: undefined } },
    ],
    [
      "the weekly field",
      { five_hour: { utilization: 25 } },
      { success: true, five_hour: { percentRemaining: 75, resetTimeIso: undefined } },
    ],
  ])("accepts a valid OAuth reply with omitted %s", (_label, response, expected) => {
    expect(parseOAuthUsageResponse(response)).toEqual(expected);
  });

  it.each([
    { five_hour: { utilization: "invalid" }, seven_day: null },
    { five_hour: null, seven_day: { utilization: "invalid" } },
    { five_hour: null, seven_day: null },
  ])("does not infer absent or malformed windows from %j", (response) => {
    expect(parseOAuthUsageResponse(response)).toBeNull();
  });

  it("does not treat a partial local CLI response as quota", () => {
    expect(parseUsageResponse({ five_hour: null, seven_day: { utilization: 35 } })).toBeNull();
  });

  it("parses Enterprise extra usage from its reported used and monthly credits", () => {
    expect(
      parseOAuthUsageResponse({
        five_hour: { utilization: 25 },
        seven_day: null,
        extra_usage: { is_enabled: true, utilization: null, used_credits: 50, monthly_limit: 200 },
      }),
    ).toEqual({
      success: true,
      five_hour: { percentRemaining: 75, resetTimeIso: undefined },
      extra_usage: { percentRemaining: 75 },
    });
  });

  it("parses an Enterprise OAuth reply containing only reported usage credits", () => {
    expect(
      parseOAuthUsageResponse({
        five_hour: null,
        seven_day: null,
        limits: [],
        extra_usage: {
          is_enabled: true,
          monthly_limit: 50_000,
          used_credits: 40_000,
          utilization: 80,
        },
      }),
    ).toEqual({ success: true, extra_usage: { percentRemaining: 20 } });
  });

  it("does not treat a malformed window as an omitted optional window", () => {
    expect(
      parseOAuthUsageResponse({
        five_hour: { utilization: "malformed" },
        seven_day: { utilization: 35 },
        extra_usage: { is_enabled: true, utilization: 20 },
      }),
    ).toBeNull();
  });
});

describe("Claude CLI diagnostics", () => {
  it("keeps selected Claude Code CLI quota uncached without an Anthropic account identity", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
    ]);

    await expect(
      resolveAnthropicAuthIdentity({ useClaudeCodeCredentials: true }),
    ).resolves.toBeNull();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("shows the Claude Code login only when it is reliably signed in and a different account from OpenCode's", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-login-token" } }),
    );
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
    );

    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    await expect(
      getClaudeCodeAccountDiagnostics({}, [fingerprintAccessToken("claude-login-token")]),
    ).resolves.toBeNull();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();

    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    const shown = await getClaudeCodeAccountDiagnostics({}, [
      fingerprintAccessToken("opencode-personal-token"),
    ]);
    expect(shown?.quotaSupported).toBe(true);
    expect(shown?.credentialFingerprint).toBe(fingerprintAccessToken("claude-login-token"));

    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: false }) },
    ]);
    await expect(getClaudeCodeAccountDiagnostics({}, [])).resolves.toBeNull();
  });

  it("does not deduplicate CLI-reported quota using a token the quota did not identify", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "stored-token" } }),
    );
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: { five_hour: { used_percentage: 10 }, seven_day: { used_percentage: 20 } },
        }),
      },
    ]);

    const diagnostics = await getClaudeCodeAccountDiagnostics({}, [
      fingerprintAccessToken("stored-token"),
    ]);

    expect(diagnostics?.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics?.credentialFingerprint).toBeUndefined();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("derives the Claude Code route identity from the Claude CLI login only, scoped to the binary", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-secret" },
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-access-secret" } }),
    );

    const identity = await resolveAnthropicAuthIdentity({
      useClaudeCodeCredentials: true,
      binaryPath: "claude",
    });

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledTimes(1);
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:claude-code-route",
      principal: { kind: "credential", value: "claude-access-secret" },
      qualifiers: ["claude", DEFAULT_CLAUDE_CONFIG_DIRECTORY],
    });
    expect(identityMocks.composeResolvedAuthIdentities).not.toHaveBeenCalled();
    expect(identity).toBe("identity:anthropic:claude-code-route");
  });

  it("returns no Claude Code route identity when the CLI login is absent, even with an OpenCode login", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: false }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-secret" },
    });

    await expect(
      resolveAnthropicAuthIdentity({ useClaudeCodeCredentials: true }),
    ).resolves.toBeNull();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("derives identity for the OpenCode OAuth winner when Claude CLI is unavailable", async () => {
    mockExecSequence([{ code: "ENOENT", errorMessage: "spawn claude ENOENT" }]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-secret" },
    });

    const identity = await resolveAnthropicAuthIdentity();

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:opencode-auth",
      principal: { kind: "credential", value: "opencode-access-secret" },
    });
    expect(identity).not.toContain("opencode-access-secret");
  });

  it("counts an OpenCode login it could not read as present but derives no identity from it", async () => {
    mockExecSequence([{ code: "ENOENT", errorMessage: "spawn claude ENOENT" }]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", resolveError: "refresh_failed: HTTP 500" },
    });

    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    await expect(resolveAnthropicAuthIdentity()).resolves.toBeNull();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("composes both credentials when authenticated Claude may receive OAuth fallback", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(1));
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-secret" },
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-access-secret" } }),
    );

    const identity = await resolveAnthropicAuthIdentity();

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:claude-credentials",
      principal: { kind: "credential", value: "claude-access-secret" },
    });
    expect(identityMocks.composeResolvedAuthIdentities).toHaveBeenCalledWith({
      providerId: "anthropic",
      identities: ["identity:anthropic:opencode-auth", "identity:anthropic:claude-credentials"],
    });
    expect(identity).not.toMatch(/opencode-access-secret|claude-access-secret/u);
  });

  it("passes every OpenCode login row with its state into the account-set identity", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: false }) },
    ]);

    await resolveAnthropicAccountSetIdentity({
      binaryPath: "claude",
      openCodeAccounts: [
        {
          sourceId: "row-active",
          label: "Work",
          active: true,
          state: "configured",
          accessToken: "work-token",
        },
        {
          sourceId: "row-idle",
          label: "Home",
          active: false,
          state: "configured",
          accessToken: "home-token",
        },
        { sourceId: "row-broken", label: "Old", active: false, state: "failed" },
      ],
      onlyCurrentModel: false,
      claudeCodeRuntimeDetected: false,
    });

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:opencode-account",
      principal: { kind: "credential", value: "work-token" },
      qualifiers: ["row-active", "Work", "active", "configured"],
    });
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:opencode-account",
      principal: { kind: "credential", value: "home-token" },
      qualifiers: ["row-idle", "Home", "idle", "configured"],
    });
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:opencode-account",
      principal: { kind: "stable-id", value: "row-broken" },
      qualifiers: ["row-broken", "Old", "idle", "failed"],
    });
    expect(identityMocks.composeResolvedAuthIdentities).toHaveBeenCalledWith({
      providerId: "anthropic",
      identities: [
        "identity:anthropic:opencode-account",
        "identity:anthropic:opencode-account",
        "identity:anthropic:opencode-account",
        "identity:anthropic:claude-cli-state",
      ],
      qualifiers: ["all-models"],
    });
  });

  it("keys the Claude CLI row by its stored token, without any network call", async () => {
    setProcessPlatform("linux");

    for (const token of ["claude-token-a", "claude-token-b"]) {
      mockExecSequence([
        { stdout: "claude 1.2.3\n" },
        { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      ]);
      readFileMock.mockResolvedValue(JSON.stringify({ claudeAiOauth: { accessToken: token } }));

      await resolveAnthropicAccountSetIdentity({
        binaryPath: "claude",
        openCodeAccounts: [],
        onlyCurrentModel: false,
        claudeCodeRuntimeDetected: false,
      });
    }

    for (const token of ["claude-token-a", "claude-token-b"]) {
      expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
        providerId: "anthropic:claude-cli-account",
        principal: { kind: "credential", value: token },
        qualifiers: ["claude", DEFAULT_CLAUDE_CONFIG_DIRECTORY],
      });
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("keys the Claude CLI row by its sign-in state when no first-party token is readable", async () => {
    setProcessPlatform("linux");
    const runWith = async (
      status: Record<string, unknown>,
      claudeCodeRuntimeDetected: boolean,
    ): Promise<void> => {
      mockExecSequence([{ stdout: "claude 1.2.3\n" }, { stdout: JSON.stringify(status) }]);
      await resolveAnthropicAccountSetIdentity({
        binaryPath: "claude",
        openCodeAccounts: [],
        onlyCurrentModel: false,
        claudeCodeRuntimeDetected,
      });
    };

    await runWith({ loggedIn: false }, true);
    await runWith({ loggedIn: true }, false);

    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:claude-cli-state",
      principal: { kind: "stable-id", value: "claude-cli-state" },
      qualifiers: [
        "installed",
        "1.2.3",
        "unauthenticated",
        "",
        "unresolved",
        "unverified",
        "detected",
      ],
    });
    expect(identityMocks.deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "anthropic:claude-cli-state",
      principal: { kind: "stable-id", value: "claude-cli-state" },
      qualifiers: [
        "installed",
        "1.2.3",
        "authenticated",
        "claude",
        DEFAULT_CLAUDE_CONFIG_DIRECTORY,
        "unverified",
        "undetected",
      ],
    });
  });

  it("derives no account-set identity when the Claude CLI reports quota", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
    ]);

    await expect(
      resolveAnthropicAccountSetIdentity({
        binaryPath: "claude",
        openCodeAccounts: [
          {
            sourceId: "row-active",
            label: "Work",
            active: true,
            state: "configured",
            accessToken: "work-token",
          },
        ],
        onlyCurrentModel: false,
        claudeCodeRuntimeDetected: false,
      }),
    ).resolves.toBeNull();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("keys the whole account set by the selected-route flag", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: false }) },
    ]);

    await resolveAnthropicAccountSetIdentity({
      binaryPath: "claude",
      openCodeAccounts: [],
      onlyCurrentModel: true,
      claudeCodeRuntimeDetected: false,
    });

    expect(identityMocks.composeResolvedAuthIdentities).toHaveBeenCalledWith({
      providerId: "anthropic",
      identities: ["identity:anthropic:claude-cli-state"],
      qualifiers: ["only-current-model"],
    });
  });

  it("builds a Windows-safe Claude CLI invocation for shim-based installs", () => {
    const invocation = buildClaudeCommandInvocation(
      "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd",
      ["auth", "status", "--json"],
      { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd" "auth" "status" "--json""',
      ],
      display: "C:\\Users\\alice\\AppData\\Roaming\\npm\\claude.cmd auth status --json",
      windowsVerbatimArguments: true,
    });
  });

  it("keeps Windows PATH-based Claude commands behind cmd.exe", () => {
    const invocation = buildClaudeCommandInvocation("claude.exe", ["--version"], {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    });

    expect(invocation).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '""claude.exe" "--version""'],
      display: "claude.exe --version",
      windowsVerbatimArguments: true,
    });
  });

  it("refuses Windows Claude paths that cmd.exe cannot carry safely", () => {
    expect(() =>
      buildClaudeCommandInvocation('C:\\tools\\claude.cmd" & calc & "x.cmd', ["--version"], {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toThrow(/cannot be passed safely through cmd\.exe/u);
    expect(() =>
      buildClaudeCommandInvocation("C:\\tools\\%USERNAME%\\claude.cmd", ["--version"], {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      }),
    ).toThrow(/cannot be passed safely through cmd\.exe/u);
  });

  it("executes configured Windows Claude .exe paths directly", () => {
    const invocation = buildClaudeCommandInvocation(
      "C:/Users/alice/.local/bin/claude.exe",
      ["auth", "status", "--json"],
      { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" },
    );

    expect(invocation).toEqual({
      file: "C:/Users/alice/.local/bin/claude.exe",
      args: ["auth", "status", "--json"],
      display: "C:/Users/alice/.local/bin/claude.exe auth status --json",
    });
  });

  it("probes configured Windows Claude .exe paths without cmd wrapping", async () => {
    setProcessPlatform("win32");
    mockExecSequence([
      { stdout: "2.1.123 (Claude Code)\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " C:/Users/alice/.local/bin/claude.exe ",
    });

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("2.1.123");
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.binaryPath).toBe("C:/Users/alice/.local/bin/claude.exe");
    expect(diagnostics.checkedCommands).toEqual([
      "C:/Users/alice/.local/bin/claude.exe --version",
      "C:/Users/alice/.local/bin/claude.exe auth status --json",
    ]);
    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "C:/Users/alice/.local/bin/claude.exe",
      ["--version"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "C:/Users/alice/.local/bin/claude.exe",
      ["auth", "status", "--json"],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });

  it("hides the Windows cmd bridge for the version, JSON auth, and plain-auth fallback", async () => {
    setProcessPlatform("win32");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { code: 1, stderr: "unexpected argument '--json'" },
      { stdout: "Authenticated" },
    ]);

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.authStatus).toBe("authenticated");
    expect(execFileMock).toHaveBeenCalledTimes(3);
    for (const [file, , options] of execFileMock.mock.calls) {
      expect(file.toLowerCase()).toContain("cmd.exe");
      expect(options).toEqual(
        expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true }),
      );
    }
  });

  it.each([
    { name: "missing version command", steps: [{ code: "ENOENT" }] },
    {
      name: "timed-out auth command",
      steps: [{ stdout: "claude 1.2.3\n" }, { code: "ETIMEDOUT", killed: true }],
    },
  ])("hides Windows processes on $name", async ({ steps }) => {
    setProcessPlatform("win32");
    mockExecSequence([...steps]);

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.quotaSupported).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(steps.length);
    for (const [, , options] of execFileMock.mock.calls) {
      expect(options).toEqual(expect.objectContaining({ windowsHide: true }));
    }
  });

  it("rejects a Claude CLI login on a non-subscription method as stale credentials", async () => {
    setProcessPlatform("linux");
    readFileMock.mockClear();
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "stale-api-login-token" } }),
    );
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "api_key",
          apiProvider: "firstParty",
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("claude.ai subscription");
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("rejects a Claude CLI login that reports a non-first-party API provider", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "bedrock" }),
      },
    ]);

    await expect(getClaudeCodeAccountDiagnostics({}, [])).resolves.toBeNull();
  });

  it("keeps a claude.ai subscription login, or a login that reports no method, as authenticated", async () => {
    setProcessPlatform("linux");
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
        }),
      },
    ]);
    expect((await getAnthropicDiagnostics({ useClaudeCodeCredentials: true })).authStatus).toBe(
      "authenticated",
    );

    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    expect((await getAnthropicDiagnostics({ useClaudeCodeCredentials: true })).authStatus).toBe(
      "authenticated",
    );
  });

  it("shows a known subscription plan on the verified Claude CLI login", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-login-token" } }),
    );
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
    );
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          subscriptionType: "max",
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);

    const diagnostics = await getClaudeCodeAccountDiagnostics({}, []);
    expect(diagnostics?.quotaSupported).toBe(true);
    expect(diagnostics?.planLabel).toBe("Max");
    expect(diagnostics?.credentialFingerprint).toBe(fingerprintAccessToken("claude-login-token"));
  });

  it("omits a subscription plan that is absent, null, malformed, or not on the known list", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-login-token" } }),
    );
    fetchResponseMock.mockResolvedValue(mockJsonResponse({ five_hour: { utilization: 10 } }));

    for (const plan of [
      {},
      { subscriptionType: null },
      { subscriptionType: "max_20x" },
      { subscriptionType: "constructor" },
      { subscriptionType: 5 },
    ]) {
      mockExecSequence([
        { stdout: "claude 1.2.3\n" },
        { stdout: JSON.stringify({ loggedIn: true, ...plan, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      ]);
      const diagnostics = await getClaudeCodeAccountDiagnostics({}, []);
      expect(diagnostics?.quotaSupported).toBe(true);
      expect(diagnostics?.planLabel).toBeUndefined();
    }
  });

  it("shows the exact Ultra plan and omits guessed aliases of it", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-login-token" } }),
    );
    fetchResponseMock.mockResolvedValue(mockJsonResponse({ five_hour: { utilization: 10 } }));

    for (const [subscriptionType, expected] of [
      ["ultra", "Ultra"],
      ["ultra_20x", undefined],
      ["ultra-20x", undefined],
      ["max_ultra", undefined],
    ] as const) {
      mockExecSequence([
        { stdout: "claude 1.2.3\n" },
        {
          stdout: JSON.stringify({
            loggedIn: true,
            subscriptionType,
            ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          }),
        },
      ]);
      const diagnostics = await getClaudeCodeAccountDiagnostics({}, []);
      expect(diagnostics?.planLabel).toBe(expected);
    }
  });

  it("never takes a plan from a Claude CLI login not verified as first-party claude.ai", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-login-token" } }),
    );
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "pro" }) },
    ]);

    const diagnostics = await getClaudeCodeAccountDiagnostics({}, []);
    expect(diagnostics?.quotaSupported).toBe(false);
    expect(diagnostics?.planLabel).toBeUndefined();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("never gives the Claude CLI plan to a diagnostics answer from OpenCode's login", async () => {
    setProcessPlatform("linux");
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-token", expires: Date.now() + 60_000 },
    });
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({ five_hour: { utilization: 20 }, seven_day: { utilization: 30 } }),
    );
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          subscriptionType: "max",
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.planLabel).toBeUndefined();
  });

  it("reports missing Claude CLI as unavailable without quota data", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      ...Array.from({ length: 3 }, () => ({
        code: "ENOENT",
        errorMessage: "spawn claude ENOENT",
      })),
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync.mock.calls.map(([path]) => path)).toEqual(
      CLAUDE_INSTALL_FOLDER_CANDIDATES,
    );
    expect(diagnostics).toEqual({
      installed: false,
      version: null,
      authStatus: "unknown",
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: null,
      checkedCommands: ["claude --version"],
      message: `Claude CLI (\`claude\`) is not installed or not on PATH. Also checked: ${CLAUDE_INSTALL_FOLDER_CANDIDATES.join(", ")}.`,
    });
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    await expect(queryAnthropicQuota()).resolves.toBeNull();
  });

  it("runs claude from PATH without looking in install folders", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(diagnostics.binaryPath).toBe("claude (PATH)");
    expect(diagnostics.checkedCommands).toEqual(["claude --version", "claude auth status --json"]);
  });

  it("uses the first install folder that has claude when it is not on PATH", async () => {
    setProcessPlatform("linux");
    const [claudeLocal, localBin] = CLAUDE_INSTALL_FOLDER_CANDIDATES;
    fsMocks.existsSync.mockImplementation(
      (path) => path === localBin || path === "/usr/local/bin/claude",
    );
    mockExecSequence([
      { code: "ENOENT", errorMessage: "spawn claude ENOENT" },
      { stdout: "2.1.0 (Claude Code)\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync.mock.calls.map(([path]) => path)).toEqual([claudeLocal, localBin]);
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("2.1.0");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.binaryPath).toBe(localBin);
    expect(diagnostics.checkedCommands).toEqual([
      "claude --version",
      buildClaudeCommandInvocation(localBin!, ["--version"]).display,
      buildClaudeCommandInvocation(localBin!, ["auth", "status", "--json"]).display,
    ]);
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      localBin,
      ["auth", "status", "--json"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("does not look in install folders on Windows", async () => {
    setProcessPlatform("win32");
    mockExecSequence([{ code: "ENOENT", errorMessage: "spawn cmd.exe ENOENT" }]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(diagnostics.installed).toBe(false);
    expect(diagnostics.binaryPath).toBeNull();
    expect(diagnostics.message).toBe("Claude CLI (`claude`) is not installed or not on PATH.");
  });

  it("uses OpenCode Anthropic OAuth when Claude CLI is unavailable", async () => {
    mockExecSequence([
      ...Array.from({ length: 2 }, () => ({
        code: "ENOENT",
        errorMessage: "spawn claude ENOENT",
      })),
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-token", expires: Date.now() + 60_000 },
    });
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        five_hour: { utilization: 20 },
        seven_day: { utilization: 30 },
      }),
    );

    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(false);
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("opencode-auth-oauth-api");
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(80);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(70);
    await expect(queryAnthropicQuota()).resolves.toMatchObject({ success: true });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("reports an OpenCode OAuth failure when Claude CLI is unavailable", async () => {
    mockExecSequence([
      ...Array.from({ length: 2 }, () => ({
        code: "ENOENT",
        errorMessage: "spawn claude ENOENT",
      })),
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-token", expires: Date.now() + 60_000 },
    });
    fetchResponseMock.mockResolvedValue(mockOAuthResponse(429, "rate limited", "30"));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.message).toContain("Anthropic API error 429: rate limited");

    await expect(queryAnthropicQuota()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining("Anthropic OAuth usage probe paused after HTTP 429"),
      failureCategory: "provider_api",
    });
    expect(diagnostics.failureCategory).toBe("provider_api");
  });

  it("labels OAuth HTTP, transport, and malformed-response failures as provider API", async () => {
    fetchResponseMock.mockResolvedValueOnce(mockOAuthResponse(500, "server error"));
    await expect(queryAnthropicQuotaWithOAuth("oauth-http-failure-token")).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });

    fetchWithTimeoutMock.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(
      queryAnthropicQuotaWithOAuth("oauth-transport-failure-token"),
    ).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });

    fetchResponseMock.mockResolvedValueOnce(mockInvalidJsonResponse());
    await expect(queryAnthropicQuotaWithOAuth("oauth-invalid-json-token")).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });

    fetchResponseMock.mockResolvedValueOnce(mockJsonResponse({ unexpected: true }));
    await expect(queryAnthropicQuotaWithOAuth("oauth-invalid-shape-token")).resolves.toMatchObject({
      success: false,
      failureCategory: "provider_api",
    });
  });

  it("reuses a recent OAuth quota only for the same credential", async () => {
    fetchResponseMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 40 },
          seven_day: { utilization: 50 },
        }),
      );

    const first = await queryAnthropicQuotaWithOAuth("account-a-token");
    const sameCredential = await queryAnthropicQuotaWithOAuth("account-a-token");
    const otherCredential = await queryAnthropicQuotaWithOAuth("account-b-token");

    expect(first).toMatchObject({ success: true, five_hour: { percentRemaining: 90 } });
    expect(sameCredential).toMatchObject({ success: true, five_hour: { percentRemaining: 90 } });
    expect(otherCredential).toMatchObject({ success: true, five_hour: { percentRemaining: 60 } });
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("preserves OAuth quota state through the shared global Symbol across module reloads", async () => {
    fetchResponseMock.mockResolvedValueOnce(
      mockJsonResponse({
        five_hour: { utilization: 20 },
        seven_day: { utilization: 30 },
      }),
    );
    const first = await queryAnthropicQuotaWithOAuth("shared-state-token");
    const stateKey = Symbol.for("opencode-quota-gui.anthropic-oauth-shared-state.v1");
    const globalState = (globalThis as unknown as Record<PropertyKey, unknown>)[stateKey];

    expect(globalState).toBeDefined();
    vi.resetModules();
    const reloadedAnthropic = await import("../src/lib/anthropic.js");

    await expect(
      reloadedAnthropic.queryAnthropicQuotaWithOAuth("shared-state-token"),
    ).resolves.toEqual(first);
    expect((globalThis as unknown as Record<PropertyKey, unknown>)[stateKey]).toBe(globalState);
    expect(fetchResponseMock).toHaveBeenCalledOnce();
  });

  it("labels OAuth authentication failures as credentials", async () => {
    mockExecSequence([
      ...Array.from({ length: 2 }, () => ({
        code: "ENOENT",
        errorMessage: "spawn claude ENOENT",
      })),
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: {
        type: "oauth",
        access: "oauth-authentication-failure-token",
        expires: Date.now() + 60_000,
      },
    });
    fetchResponseMock.mockResolvedValue(mockOAuthResponse(401, "unauthorized"));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.failureCategory).toBe("credentials");
    await expect(queryAnthropicQuota()).resolves.toMatchObject({
      success: false,
      failureCategory: "credentials",
    });
  });

  it("uses a configured Claude binary path for probe commands", async () => {
    mockExecSequence([
      {
        code: "ENOENT",
        errorMessage: "spawn /Applications/Claude Code.app/Contents/MacOS/claude ENOENT",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({
      binaryPath: " /Applications/Claude Code.app/Contents/MacOS/claude ",
    });

    expect(diagnostics.checkedCommands).toEqual([
      '"/Applications/Claude Code.app/Contents/MacOS/claude" --version',
    ]);
    expect(fsMocks.existsSync).not.toHaveBeenCalled();
    expect(diagnostics.binaryPath).toBeNull();
    expect(diagnostics.message).toBe(
      "Claude CLI (`/Applications/Claude Code.app/Contents/MacOS/claude`) is not installed or not on PATH.",
    );
  });

  it("reports unauthenticated Claude CLI status", async () => {
    const unauthenticatedProbe: ExecSequenceStep[] = [
      { stdout: "claude 1.2.3\n" },
      {
        code: 1,
        stderr: "Not logged in. Run `claude auth login` to continue.",
      },
    ];
    mockExecSequence([...unauthenticatedProbe, ...unauthenticatedProbe, ...unauthenticatedProbe]);

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.version).toBe("1.2.3");
    expect(diagnostics.authStatus).toBe("unauthenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("claude auth login");
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(false);
    await expect(queryAnthropicQuota()).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it.each([
    ["no login method or API provider", { loggedIn: true }],
    ["login method without API provider", { loggedIn: true, authMethod: "claude.ai" }],
    ["API provider without login method", { loggedIn: true, apiProvider: "firstParty" }],
  ])("does not use the stored Claude CLI token without first-party evidence (%s)", async (_label, status) => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "unverified-cli-token" } }),
    );
    mockExecSequence([{ stdout: "claude 1.2.3\n" }, { stdout: JSON.stringify(status) }]);

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain(
      "Claude CLI did not confirm a first-party claude.ai login, so its stored token is not used.",
    );
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain("unverified-cli-token");
  });

  it("derives no Claude Code identity from a Claude CLI login without first-party evidence", async () => {
    setProcessPlatform("linux");
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "unverified-cli-token" } }),
    );
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true }) },
    ]);

    await expect(
      resolveAnthropicAuthIdentity({ useClaudeCodeCredentials: true }),
    ).resolves.toBeNull();
    expect(readFileMock).not.toHaveBeenCalled();
    expect(identityMocks.deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });

  it("still shows quota the Claude CLI reports itself when its login is unverified", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          quota: {
            five_hour: { used_percentage: 57, resets_at: "2026-03-25T18:00:00.000Z" },
            seven_day: { usedPercentage: 12, resetsAt: "2026-04-01T00:00:00.000Z" },
          },
        }),
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(43);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("returns quota data when Claude auth status JSON includes quota windows", async () => {
    const localQuotaProbe: ExecSequenceStep[] = [
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: {
              used_percentage: 57,
              resets_at: "2026-03-25T18:00:00.000Z",
            },
            seven_day: {
              usedPercentage: 12,
              resetsAt: "2026-04-01T00:00:00.000Z",
            },
            extra_usage: { is_enabled: true, utilization: 37.8 },
          },
        }),
      },
    ];
    mockExecSequence([...localQuotaProbe, ...localQuotaProbe, ...localQuotaProbe]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-auth-status-json");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(43);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(88);
    expect(diagnostics.quota?.extra_usage).toBeUndefined();

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(true);
    if (quota?.success) {
      expect(quota.five_hour.percentRemaining).toBe(43);
      expect(quota.seven_day.percentRemaining).toBe(88);
    }
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
  });

  it("keeps Anthropic availability local-only when only the OAuth fallback can provide quota", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);

    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("falls back to Claude OAuth usage when local Claude auth omits quota windows", async () => {
    setProcessPlatform("linux");
    const authenticatedProbe: ExecSequenceStep[] = [
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ];
    mockExecSequence([...authenticatedProbe, ...authenticatedProbe]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        ...fableWeeklyUsage,
        extra_usage: { is_enabled: true, utilization: 37.8 },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(58);
    expect(diagnostics.quota?.five_hour.resetTimeIso).toBe("2026-07-21T14:10:00.268Z");
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(72);
    expect(diagnostics.quota?.seven_day.resetTimeIso).toBe("2026-07-27T07:00:00.268Z");
    expect(diagnostics.quota?.extra_usage).toEqual({ percentRemaining: 62 });
    expect(diagnostics.quota?.fable_weekly).toEqual({
      percentRemaining: 98,
      resetTimeIso: "2026-07-27T07:00:00.268Z",
    });
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: "Bearer oauth-access-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      timeoutMs: undefined,
      consume: expect.any(Function),
    });

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(true);
    if (quota?.success) {
      expect(quota.five_hour.percentRemaining).toBe(58);
      expect(quota.seven_day.percentRemaining).toBe(72);
      expect(quota.fable_weekly?.percentRemaining).toBe(98);
    }

    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("prefers OpenCode's own Anthropic OAuth credentials over Claude Code credentials", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-token", expires: Date.now() + 60_000 },
    });
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        five_hour: { utilization: 20, resets_at: "2026-03-25T18:00:00.000Z" },
        seven_day: { utilization: 30, resets_at: "2026-04-01T00:00:00.000Z" },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("opencode-auth-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(80);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(70);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: "Bearer opencode-access-token",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      timeoutMs: undefined,
      consume: expect.any(Function),
    });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not substitute Claude credentials when OpenCode OAuth is rejected", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "revoked-opencode-token", expires: Date.now() + 60_000 },
    });
    fetchResponseMock.mockResolvedValueOnce(mockOAuthResponse(401, "revoked"));

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.failureCategory).toBe("credentials");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(JSON.stringify(diagnostics)).not.toContain("claude-keychain-token");
  });

  it("retains the cooldown for a rate-limited OpenCode token without touching the Claude CLI account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "limited-opencode-token", expires: Date.now() + 120_000 },
    });
    fetchResponseMock.mockResolvedValueOnce(mockOAuthResponse(429, "rate limited", "30"));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 30s.");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_001);
    const second = await getAnthropicDiagnostics();
    expect(second.message).toContain("retry in 25s.");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("does not substitute Claude Code credentials when OpenCode's Anthropic OAuth login is expired", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "expired-opencode-token", expires: Date.now() - 60_000 },
    });

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.message).toContain("opencode auth login anthropic");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("reports an OpenCode Anthropic 401 without answering with the Claude CLI account", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-secret" },
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-access-secret" } }),
    );
    fetchResponseMock.mockResolvedValue(mockOAuthResponse(401, "unauthorized"));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
    expect(diagnostics.failureCategory).toBe("credentials");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchWithTimeoutMock.mock.calls)).not.toContain("claude-access-secret");
    expect(JSON.stringify(diagnostics)).not.toContain("claude-access-secret");
  });

  it("reads Claude credentials from the config directory the CLI reports, not a guessed default", async () => {
    setProcessPlatform("darwin");
    const configDirectory = join(homedir(), "claude-custom-config");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({ loggedIn: true, configDirectory, ...FIRST_PARTY_CLAUDE_AI_LOGIN }),
      },
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path === join(configDirectory, ".credentials.json")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "custom-dir-token" } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(true);
    expect(readFileMock).toHaveBeenCalledWith(join(configDirectory, ".credentials.json"), "utf8");
    expect(readFileMock).not.toHaveBeenCalledWith(
      join(homedir(), ".claude", ".credentials.json"),
      "utf8",
    );
    expect(JSON.stringify(fetchWithTimeoutMock.mock.calls)).toContain("Bearer custom-dir-token");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back to the default Claude config directory when the reported one has no login", async () => {
    setProcessPlatform("linux");
    const configDirectory = join(homedir(), "claude-empty-config");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({ loggedIn: true, configDirectory, ...FIRST_PARTY_CLAUDE_AI_LOGIN }),
      },
    ]);
    readFileMock.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(false);
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(readFileMock).toHaveBeenCalledWith(join(configDirectory, ".credentials.json"), "utf8");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("reads the login from CLAUDE_CONFIG_DIR, not the default directory, when the CLI omits configDirectory", async () => {
    setProcessPlatform("darwin");
    process.env["CLAUDE_CONFIG_DIR"] = SPACED_CLAUDE_CONFIG_DIRECTORY;
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readFileMock.mockImplementation(async (path: string) => {
      if (path === join(SPACED_CLAUDE_CONFIG_DIRECTORY, ".credentials.json")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "env-dir-token" } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(true);
    expect(readFileMock).toHaveBeenCalledWith(
      join(SPACED_CLAUDE_CONFIG_DIRECTORY, ".credentials.json"),
      "utf8",
    );
    expect(readFileMock).not.toHaveBeenCalledWith(
      join(homedir(), ".claude", ".credentials.json"),
      "utf8",
    );
    expect(execFileMock.mock.calls.map(([file]) => file)).not.toContain("security");
    expect(JSON.stringify(fetchWithTimeoutMock.mock.calls)).toContain("Bearer env-dir-token");
  });

  it.each([
    ["a relative path", "relative claude config"],
    ["an empty value", ""],
  ])("reads no login when CLAUDE_CONFIG_DIR is %s, because it cannot name the CLI's directory", async (_description, value) => {
    setProcessPlatform("darwin");
    process.env["CLAUDE_CONFIG_DIR"] = value;
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "default-dir-token" } }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.map(([file]) => file)).not.toContain("security");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("fails closed when CLAUDE_CONFIG_DIR and the CLI-reported directory disagree", async () => {
    setProcessPlatform("linux");
    process.env["CLAUDE_CONFIG_DIR"] = SPACED_CLAUDE_CONFIG_DIRECTORY;
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          configDirectory: join(homedir(), "other claude config"),
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "must-not-be-read" } }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("fails closed when the CLI reports a relative config directory and CLAUDE_CONFIG_DIR is unset", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          loggedIn: true,
          configDirectory: "relative-claude-config",
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "default-dir-token" } }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(false);
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.map(([file]) => file)).not.toContain("security");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("does not use the default macOS Keychain when CLAUDE_CONFIG_DIR is set", async () => {
    setProcessPlatform("darwin");
    process.env["CLAUDE_CONFIG_DIR"] = join(homedir(), ".claude");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) },
    ]);
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(false);
    expect(execFileMock.mock.calls.map(([file]) => file)).not.toContain("security");
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("keys the Claude Code identity by the login of the directory CLAUDE_CONFIG_DIR names", async () => {
    setProcessPlatform("linux");
    identityMocks.deriveResolvedAuthIdentity.mockClear();
    readFileMock.mockImplementation(async (path: string) => {
      if (path === join(homedir(), ".claude", ".credentials.json")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "default-dir-token" } });
      }
      if (path === join(SPACED_CLAUDE_CONFIG_DIRECTORY, ".credentials.json")) {
        return JSON.stringify({ claudeAiOauth: { accessToken: "env-dir-token" } });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);

    await resolveAnthropicAuthIdentity({ useClaudeCodeCredentials: true });
    process.env["CLAUDE_CONFIG_DIR"] = SPACED_CLAUDE_CONFIG_DIRECTORY;
    readFileMock.mockClear();
    await resolveAnthropicAuthIdentity({ useClaudeCodeCredentials: true });

    const principalValues = identityMocks.deriveResolvedAuthIdentity.mock.calls.map(
      ([params]) => (params as { principal?: { value: string } }).principal?.value,
    );
    expect(principalValues).toEqual(["default-dir-token", "env-dir-token"]);
    expect(readFileMock).not.toHaveBeenCalledWith(
      join(homedir(), ".claude", ".credentials.json"),
      "utf8",
    );
  });

  it("does not show the custom config directory path when its login is missing", async () => {
    setProcessPlatform("linux");
    process.env["CLAUDE_CONFIG_DIR"] = SPACED_CLAUDE_CONFIG_DIRECTORY;
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ loggedIn: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readFileMock.mockRejectedValue(
      Object.assign(
        new Error(
          `ENOENT: no such file, open '${join(SPACED_CLAUDE_CONFIG_DIRECTORY, ".credentials.json")}'`,
        ),
        { code: "ENOENT" },
      ),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("not found in the Claude CLI config directory");
    expect(JSON.stringify(diagnostics)).not.toContain(SPACED_CLAUDE_CONFIG_DIRECTORY);
    expect(diagnostics.message ?? "").not.toContain(homedir());
  });

  it("ignores non-OAuth OpenCode Anthropic auth entries", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      {
        stdout: JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-from-keychain" },
        }),
      },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "api", key: "sk-ant-api-key" },
    });
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20 },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: "Bearer oauth-access-token-from-keychain",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      timeoutMs: undefined,
      consume: expect.any(Function),
    });
  });

  it("keeps the first usable credential when the usage endpoint rate limits it", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-token" },
    });
    fetchResponseMock.mockResolvedValue(
      mockOAuthResponse(429, JSON.stringify({ error: { type: "rate_limit_error" } })),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("reports which credential store answered the usage probe even when it fails", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
    ]);
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-access-token" },
    });
    fetchResponseMock.mockResolvedValue(
      mockOAuthResponse(429, JSON.stringify({ error: { type: "rate_limit_error" } })),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.oauthCredentialSource).toBe("opencode-auth");
  });

  it("reports the Claude credential store when OpenCode has no Anthropic OAuth entry", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      {
        stdout: JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-from-keychain" },
        }),
      },
    ]);
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20 },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.oauthCredentialSource).toBe("claude-credentials");
  });

  it("falls back to macOS Keychain Claude OAuth credentials when local Claude auth omits quota windows", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
      {
        stdout: JSON.stringify({
          claudeAiOauth: {
            accessToken: "oauth-access-token-from-keychain",
          },
        }),
      },
    ]);
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        oauth_usage: {
          fiveHour: {
            usedPercent: 25,
            resetAt: "2026-03-25T18:00:00.000Z",
          },
          sevenDay: {
            usedPercent: 40,
            resetAt: "2026-04-01T00:00:00.000Z",
          },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quotaSource).toBe("claude-credentials-oauth-api");
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(75);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(60);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: "Bearer oauth-access-token-from-keychain",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      timeoutMs: undefined,
      consume: expect.any(Function),
    });
    expect(readFileMock).not.toHaveBeenCalled();
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock.mock.calls[2]?.[2]).toEqual(expect.objectContaining({ windowsHide: true }));
  });

  it("falls back to the Claude credentials file when the macOS Keychain entry is unusable", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
      {
        stdout: JSON.stringify({
          claudeAiOauth: {},
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token-from-file",
        },
      }),
    );
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        usage: {
          five_hour: { used_percentage: 5 },
          seven_day: { used_percentage: 10 },
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(true);
    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(95);
    expect(diagnostics.quota?.seven_day.percentRemaining).toBe(90);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: "Bearer oauth-access-token-from-file",
          "anthropic-beta": "oauth-2025-04-20",
        },
      },
      timeoutMs: undefined,
      consume: expect.any(Function),
    });
    expect(readFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { code: 1, errorMessage: "security failed" },
    { code: "ETIMEDOUT", killed: true },
  ])("hides the credential helper when it fails: $code", async (failure) => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      failure,
    ]);
    readFileMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.quotaSupported).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock.mock.calls[2]?.[0]).toBe("security");
    expect(execFileMock.mock.calls[2]?.[2]).toEqual(expect.objectContaining({ windowsHide: true }));
  });

  it("returns no quota when the Claude OAuth fallback credentials are unavailable", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.message).toContain(
      "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.",
    );
    expect(diagnostics.message).toContain("~/.claude/.credentials.json");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain(
        "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.",
      );
      expect(quota.error).toContain("~/.claude/.credentials.json");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it("includes the macOS Keychain source when Claude OAuth fallback credentials are unavailable on macOS", async () => {
    setProcessPlatform("darwin");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
      {
        code: 44,
        stderr: "The specified item could not be found in the keychain.",
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
      {
        code: 44,
        stderr: "The specified item could not be found in the keychain.",
      },
    ]);
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Claude Code-credentials");
    expect(diagnostics.message).toContain("~/.claude/.credentials.json");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Claude Code-credentials");
      expect(quota.error).toContain("~/.claude/.credentials.json");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock).toHaveBeenCalledTimes(6);
  });

  it("returns no quota when the Claude OAuth fallback access token is malformed", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 123,
        },
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Claude OAuth access token missing");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Claude OAuth access token missing");
    }
    expect(fetchWithTimeoutMock).not.toHaveBeenCalled();
  });

  it("returns no quota when the Claude OAuth fallback API returns a non-2xx response", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchResponseMock.mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn(),
      text: vi.fn().mockResolvedValue("rate\u001b[31m limited"),
    } as unknown as Response);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Anthropic API error 429: rate limited");
    expect(diagnostics.message).not.toContain("\u001b");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Anthropic OAuth usage probe paused after HTTP 429");
      expect(quota.error).not.toContain("\u001b");
      expect(quota.failureCategory).toBe("provider_api");
    }
  });

  it("honors Retry-After delta-seconds and suppresses repeated OAuth usage requests", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(3));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-secret-token" } }),
    );
    fetchResponseMock
      .mockResolvedValueOnce(
        mockOAuthResponse(429, "rate limited oauth-\u001b[31msecret-token", "45"),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      );

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("Anthropic API error 429: rate limited [redacted]");
    expect(first.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 45s.",
    );
    expect(first.message).not.toContain("oauth-secret-token");
    expect(first.message).not.toContain("\u001b");

    await vi.advanceTimersByTimeAsync(5_001);
    const suppressed = await getAnthropicDiagnostics();
    expect(suppressed.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 40s.",
    );
    expect(suppressed.message).not.toContain("oauth-secret-token");
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(40_000);
    const retried = await getAnthropicDiagnostics();
    expect(retried.quotaSupported).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("redacts an access token reconstructed while sanitizing a request error", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(1));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-secret-token" } }),
    );
    fetchResponseMock.mockRejectedValue(
      new Error("request failed for oauth-\u001b[31msecret-token"),
    );

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.message).toContain("request failed for [redacted]");
    expect(diagnostics.message).not.toContain("oauth-secret-token");
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it("honors future Retry-After HTTP dates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    fetchResponseMock.mockResolvedValue(
      mockOAuthResponse(429, "rate limited", "Fri, 10 Jul 2026 12:02:00 GMT"),
    );

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 120s.");

    await vi.advanceTimersByTimeAsync(5_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", undefined],
    ["invalid", "30junk"],
    ["negative", "-1"],
    ["zero", "0"],
    ["past date", "Thu, 09 Jul 2026 12:00:00 GMT"],
  ])("uses the safe backoff floor for %s Retry-After", async (_label, retryAfter) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    fetchResponseMock.mockResolvedValue(mockOAuthResponse(429, "rate limited", retryAfter));

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(5_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("caps Retry-After cooldowns at fifteen minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(1));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    fetchResponseMock.mockResolvedValue(mockOAuthResponse(429, "rate limited", "3600"));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.message).toContain("retry in 900s.");
  });

  it("establishes a cooldown when the 429 response body cannot be read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    const response = mockOAuthResponse(429, "rate limited");
    vi.mocked(response.text).mockRejectedValue(new Error("body unavailable"));
    fetchResponseMock.mockResolvedValue(response);

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("Anthropic API returned 429");
    expect(first.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(5_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("establishes a cooldown before a timed-out 429 response body finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    const response = mockOAuthResponse(429, "rate limited", "45");
    vi.mocked(response.text).mockRejectedValue(new Error("body stalled"));
    fetchWithTimeoutMock.mockImplementationOnce(async (_url, options) => {
      const controller = new AbortController();
      controller.abort();
      return await options.consume(response, controller.signal);
    });

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("body stalled");

    await vi.advanceTimersByTimeAsync(5_001);
    const suppressed = await getAnthropicDiagnostics();
    expect(suppressed.message).toContain(
      "Anthropic OAuth usage probe paused after HTTP 429; retry in 40s.",
    );
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("increases fallback backoff for consecutive 429 responses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(4));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    fetchResponseMock
      .mockResolvedValueOnce(mockOAuthResponse(429, "first"))
      .mockResolvedValueOnce(mockOAuthResponse(429, "second"))
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      );

    const first = await getAnthropicDiagnostics();
    expect(first.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(30_001);
    const second = await getAnthropicDiagnostics();
    expect(second.message).toContain("retry in 60s.");

    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(3);
  });

  it("resets the backoff sequence after a non-429 response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(4));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    fetchResponseMock
      .mockResolvedValueOnce(mockOAuthResponse(429, "first"))
      .mockResolvedValueOnce(mockOAuthResponse(500, "server error"))
      .mockResolvedValueOnce(mockOAuthResponse(429, "second"))
      .mockResolvedValueOnce(mockOAuthResponse(500, "server error"));

    await getAnthropicDiagnostics();
    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    await vi.advanceTimersByTimeAsync(5_001);
    const second429 = await getAnthropicDiagnostics();
    expect(second429.message).toContain("retry in 30s.");

    await vi.advanceTimersByTimeAsync(30_001);
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(4);
  });

  it("deduplicates concurrent OAuth usage requests for the same observed token", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    let resolveFetch!: (response: Response) => void;
    fetchResponseMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    // The exec mock hands out steps in call order, so the second probe starts only once the
    // first has reached its in-flight usage request. Its probe then gets its own steps.
    const first = getAnthropicDiagnostics({ binaryPath: "claude-a" });
    await vi.waitFor(() => expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1));
    const second = getAnthropicDiagnostics({ binaryPath: "claude-b" });
    resolveFetch(
      mockJsonResponse({
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20 },
      }),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.quotaSupported).toBe(true);
    expect(secondResult.quotaSupported).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(1);
  });

  it("shares in-flight OAuth usage requests across module instances", async () => {
    let resolveFetch!: (response: Response) => void;
    fetchResponseMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const first = queryAnthropicQuotaWithOAuth("shared-oauth-token");
    await vi.waitFor(() => expect(fetchResponseMock).toHaveBeenCalledTimes(1));

    vi.resetModules();
    const secondModule = await import("../src/lib/anthropic.js");
    const second = secondModule.queryAnthropicQuotaWithOAuth("shared-oauth-token");
    await Promise.resolve();
    expect(fetchResponseMock).toHaveBeenCalledTimes(1);

    resolveFetch(
      mockJsonResponse({
        five_hour: { utilization: 10 },
        seven_day: { utilization: 20 },
      }),
    );
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({
      success: true,
      five_hour: { percentRemaining: 90, resetTimeIso: undefined },
      seven_day: { percentRemaining: 80, resetTimeIso: undefined },
    });
    expect(secondResult).toEqual(firstResult);
    expect(fetchResponseMock).toHaveBeenCalledTimes(1);
  });

  it("shares OAuth cooldown and recent success across instances per token", async () => {
    fetchResponseMock
      .mockResolvedValueOnce(mockOAuthResponse(429, "rate limited", "900"))
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      );

    const blocked = await queryAnthropicQuotaWithOAuth("opencode-account-token");
    expect(blocked?.success).toBe(false);

    vi.resetModules();
    const secondModule = await import("../src/lib/anthropic.js");
    const stillBlocked = await secondModule.queryAnthropicQuotaWithOAuth("opencode-account-token");
    expect(stillBlocked?.success).toBe(false);
    expect(fetchResponseMock).toHaveBeenCalledTimes(1);

    const claudeCredentialQuota = await secondModule.queryAnthropicQuotaWithOAuth(
      "claude-credentials-token",
    );
    expect(claudeCredentialQuota).toEqual({
      success: true,
      five_hour: { percentRemaining: 90, resetTimeIso: undefined },
      seven_day: { percentRemaining: 80, resetTimeIso: undefined },
    });
    expect(fetchResponseMock).toHaveBeenCalledTimes(2);

    vi.resetModules();
    const thirdModule = await import("../src/lib/anthropic.js");
    await expect(
      thirdModule.queryAnthropicQuotaWithOAuth("claude-credentials-token"),
    ).resolves.toEqual(claudeCredentialQuota);
    expect(fetchResponseMock).toHaveBeenCalledTimes(2);
  });

  it("does not apply an old token cooldown to a newly observed token", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "old-token" } }))
      .mockResolvedValueOnce(JSON.stringify({ claudeAiOauth: { accessToken: "new-token" } }));
    fetchResponseMock
      .mockResolvedValueOnce(mockOAuthResponse(429, "rate limited", "900"))
      .mockResolvedValueOnce(
        mockJsonResponse({
          five_hour: { utilization: 10 },
          seven_day: { utilization: 20 },
        }),
      );

    const first = await getAnthropicDiagnostics({ binaryPath: "claude-a" });
    expect(first.quotaSupported).toBe(false);
    const second = await getAnthropicDiagnostics({ binaryPath: "claude-b" });
    expect(second.quotaSupported).toBe(true);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("clears OAuth cooldown state through the test reset helper", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(2));
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "oauth-access-token" } }),
    );
    fetchResponseMock.mockResolvedValue(mockOAuthResponse(429, "rate limited", "900"));

    await getAnthropicDiagnostics();
    clearAnthropicDiagnosticsCacheForTests();
    await getAnthropicDiagnostics();
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("returns no quota when the Claude OAuth fallback API returns invalid JSON", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchResponseMock.mockResolvedValue(mockInvalidJsonResponse());

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Failed to parse Anthropic quota response");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Failed to parse Anthropic quota response");
    }
  });

  it("returns no quota when the Claude OAuth fallback API returns an unexpected JSON shape", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      { stdout: JSON.stringify({ authenticated: true, ...FIRST_PARTY_CLAUDE_AI_LOGIN }) },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock.mockResolvedValue(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "oauth-access-token",
        },
      }),
    );
    fetchResponseMock.mockResolvedValue(mockJsonResponse({ ok: true }));

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.message).toContain("Unexpected Anthropic quota response shape");

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain("Unexpected Anthropic quota response shape");
    }
  });

  it("falls back to plain auth status when --json is unsupported", async () => {
    setProcessPlatform("linux");
    const unsupportedJsonProbe: ExecSequenceStep[] = [
      { stdout: "Claude CLI version 1.2.3\n" },
      {
        code: 1,
        stderr: "unexpected argument '--json'",
      },
      {
        stdout: "Authenticated",
      },
    ];
    mockExecSequence([...unsupportedJsonProbe, ...unsupportedJsonProbe, ...unsupportedJsonProbe]);
    readFileMock.mockRejectedValue(
      Object.assign(new Error("missing credentials"), {
        code: "ENOENT",
      }),
    );

    const diagnostics = await getAnthropicDiagnostics();

    expect(diagnostics.installed).toBe(true);
    expect(diagnostics.authStatus).toBe("authenticated");
    expect(diagnostics.quotaSupported).toBe(false);
    expect(diagnostics.quotaSource).toBe("none");
    expect(diagnostics.checkedCommands).toEqual([
      "claude --version",
      "claude auth status --json",
      "claude auth status",
    ]);
    expect(diagnostics.message).toContain(
      "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.",
    );
    // Plain "Authenticated" text cannot prove a first-party claude.ai login, so the stored CLI
    // token is not read from the default credentials file.
    expect(diagnostics.message).toContain(
      "Claude CLI did not confirm a first-party claude.ai login, so its stored token is not used.",
    );
    expect(readFileMock).not.toHaveBeenCalled();
    await expect(hasAnthropicCredentialsConfigured()).resolves.toBe(true);

    const quota = await queryAnthropicQuota();
    expect(quota?.success).toBe(false);
    if (quota && !quota.success) {
      expect(quota.error).toContain(
        "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.",
      );
      expect(quota.error).toContain(
        "Claude CLI did not confirm a first-party claude.ai login, so its stored token is not used.",
      );
    }
  });

  it("sanitizes unexpected auth probe output", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        code: 1,
        stderr: "bad\u001b[31m-output",
      },
    ]);

    const diagnostics = await getAnthropicDiagnostics();
    expect(diagnostics.authStatus).toBe("unknown");
    expect(diagnostics.message).toContain("bad-output");
    expect(diagnostics.message).not.toContain("\u001b");
  });

  it("does not reuse CLI quota by binary path across probes", async () => {
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
          quota: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      },
    ]);

    const first = await getAnthropicDiagnostics({ binaryPath: "shared-claude" });
    const second = await getAnthropicDiagnostics({ binaryPath: "shared-claude" });
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(70);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("does not reuse fallback diagnostics across credentials sharing a CLI path", async () => {
    setProcessPlatform("linux");
    mockExecSequence([
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
      { stdout: "claude 1.2.3\n" },
      {
        stdout: JSON.stringify({
          authenticated: true,
          ...FIRST_PARTY_CLAUDE_AI_LOGIN,
        }),
      },
    ]);
    readFileMock
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-1" },
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({
          claudeAiOauth: { accessToken: "oauth-access-token-2" },
        }),
      );
    fetchResponseMock
      .mockResolvedValueOnce(
        mockJsonResponse({
          usage: {
            five_hour: { used_percentage: 10 },
            seven_day: { used_percentage: 20 },
          },
        }),
      )
      .mockResolvedValueOnce(
        mockJsonResponse({
          usage: {
            five_hour: { used_percentage: 30 },
            seven_day: { used_percentage: 40 },
          },
        }),
      );

    const first = await getAnthropicDiagnostics({ binaryPath: "shared-claude" });
    const second = await getAnthropicDiagnostics({ binaryPath: "shared-claude" });
    expect(first.quota?.five_hour.percentRemaining).toBe(90);
    expect(second.quota?.five_hour.percentRemaining).toBe(70);
    expect(first.quotaSource).toBe("claude-credentials-oauth-api");
    expect(second.quotaSource).toBe("claude-credentials-oauth-api");
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(readFileMock).toHaveBeenCalledTimes(2);
    expect(fetchWithTimeoutMock).toHaveBeenCalledTimes(2);
  });

  it("uses Claude's own OAuth token when probing the Claude Code runtime", async () => {
    setProcessPlatform("linux");
    mockExecSequence(authenticatedWithoutQuotaSteps(1));
    readAuthFileCachedMock.mockResolvedValue({
      anthropic: { type: "oauth", access: "opencode-account-token" },
    });
    readFileMock.mockResolvedValue(
      JSON.stringify({ claudeAiOauth: { accessToken: "claude-code-token" } }),
    );
    fetchResponseMock.mockResolvedValue(
      mockJsonResponse({
        five_hour: { utilization: 10 },
        seven_day: null,
      }),
    );

    const diagnostics = await getAnthropicDiagnostics({ useClaudeCodeCredentials: true });

    expect(diagnostics.quota?.five_hour.percentRemaining).toBe(90);
    expect(fetchWithTimeoutMock).toHaveBeenCalledWith(
      ANTHROPIC_USAGE_URL,
      expect.objectContaining({
        request: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer claude-code-token" }),
        }),
      }),
    );
  });

  it("returns a sanitized error result when the CLI probe throws unexpectedly", async () => {
    execFileMock.mockImplementation(() => {
      throw new Error("probe \u001b[31mboom");
    });

    const result = await queryAnthropicQuota();
    expect(result?.success).toBe(false);
    if (result && !result.success) {
      expect(result.error).toContain("Claude CLI probe failed");
      expect(result.error).toContain("probe boom");
      expect(result.error).not.toContain("\u001b");
    }
  });
});
