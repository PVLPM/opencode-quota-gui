/**
 * Anthropic Claude quota probing.
 *
 * Uses the local Claude CLI/runtime to detect install/auth state first. When
 * Claude auth is confirmed but local quota windows are missing, it falls back
 * to Anthropic's OAuth usage endpoint using the first usable OAuth access
 * token from Claude OAuth credentials (macOS Keychain first, then the local credentials file).
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile, stat } from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";

import type { BankedResetAvailability, BankedResetCredit } from "../contracts/openai-quota.js";
import {
  isTransientProviderFailureCategory,
  type ProviderFailureCategory,
  type QuotaAttemptOutcome,
} from "../contracts/provider-failure.js";
import {
  ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS,
  type AnthropicOAuthAttemptCompletionResult,
  claimAnthropicOAuthUsageRequest,
  clearAnthropicOAuthThrottleStateForTests,
  normalizeAnthropicOAuthPollIntervalMs,
} from "./anthropic-oauth-throttle.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import type { FixedWindowProjectionEvidence } from "./entries.js";
import { fetchWithTimeout } from "./http.js";
import { buildFixedWindowEvidence } from "./quota-exhaustion-projection.js";
import {
  composeProcessLocalAuthIdentities,
  composeResolvedAuthIdentities,
  deriveProcessLocalAuthIdentity,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";
import { REQUEST_TIMEOUT_MS } from "./types.js";

const DEFAULT_CLAUDE_BINARY = "claude";
/** How `binaryPath` reads when the default `claude` ran from PATH. */
const CLAUDE_ON_PATH_DISPLAY = "claude (PATH)";
const CLAUDE_COMMAND_TIMEOUT_MS = 3_000;
/** Window for treating a failed credential-file read as a transient write race. */
const CLAUDE_CREDENTIALS_READ_RETRY_MS = 60_000;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_USAGE_ENHANCED_URL = `${ANTHROPIC_USAGE_URL}?cedar_ember=1`;
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_CREDENTIALS_SERVICE = "Claude Code-credentials";
const CLAUDE_NO_LOCAL_QUOTA_MESSAGE =
  "Claude CLI auth detected, but local quota windows were not exposed.";
const ANTHROPIC_NO_QUOTA_MESSAGE =
  "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.";
const CLAUDE_NON_SUBSCRIPTION_LOGIN_MESSAGE =
  "Claude CLI is not signed in with a claude.ai subscription. Run `claude auth login` and try again.";
const CLAUDE_CLI_TOKEN_UNVERIFIED_DETAIL =
  "Claude CLI did not confirm a first-party claude.ai login, so its stored token is not used.";
/** Environment variable the Claude CLI reads for its config directory. */
const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";
const CLAUDE_CONFIG_DIRECTORY_UNRESOLVED_DETAIL =
  "The Claude CLI config directory could not be determined, so its login is not used.";
/** Fixed labels for where a Claude login is kept. They name neither the home folder nor a custom path. */
const CLAUDE_DEFAULT_CREDENTIALS_LOCATION = "~/.claude/.credentials.json";
const CLAUDE_CUSTOM_CONFIG_DIRECTORY_LOCATION = "the Claude CLI config directory";

export interface AnthropicQuotaWindow {
  utilization?: number;
  used_percentage?: number;
  usedPercentage?: number;
  used_percent?: number;
  usedPercent?: number;
  percent_used?: number;
  percentUsed?: number;
  resets_at?: string;
  resetsAt?: string;
  reset_at?: string;
  resetAt?: string;
}

export interface AnthropicExtraUsage {
  is_enabled?: boolean;
  utilization?: number;
}

export interface AnthropicUsageResponse {
  five_hour?: AnthropicQuotaWindow | null;
  seven_day?: AnthropicQuotaWindow | null;
  extra_usage?: AnthropicExtraUsage;
  limits?: unknown[];
}

export interface AnthropicQuotaResult {
  success: true;
  five_hour?: {
    percentRemaining: number;
    resetTimeIso?: string;
    fixedWindow?: FixedWindowProjectionEvidence;
  };
  seven_day?: {
    percentRemaining: number;
    resetTimeIso?: string;
    fixedWindow?: FixedWindowProjectionEvidence;
  };
  extra_usage?: { percentRemaining: number };
  /**
   * The Fable scope is `weekly_scoped` with a reset time only. No fixed cycle or duration is
   * supplied, so it carries no fixed-window evidence and gets no runway.
   */
  fable_weekly?: {
    percentRemaining: number;
    resetTimeIso?: string;
  };
  /** Eligible, active, unpaused saved resets; only counts and expiry. Absent means none or unknown. */
  saved_resets?: BankedResetAvailability;
}

export interface AnthropicUsageParseOptions {
  includeExtraUsage?: boolean;
  /** When the usage payload was observed; defaults to now. Used only for fixed-window evidence. */
  observedAtMs?: number;
}

export interface AnthropicQuotaError {
  success: false;
  error: string;
  /** Source-assigned safe category; absence means unknown and consumers fail closed. */
  failureCategory?: ProviderFailureCategory;
}

export type AnthropicResult = AnthropicQuotaResult | AnthropicQuotaError | null;
export type AnthropicAuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type AnthropicQuotaSource =
  | "claude-auth-status-json"
  | "claude-credentials-oauth-api"
  | "none";

export interface AnthropicDiagnostics {
  installed: boolean;
  version: string | null;
  authStatus: AnthropicAuthStatus;
  quotaSupported: boolean;
  quotaSource: AnthropicQuotaSource;
  /** Credential store that supplied the OAuth token for the usage probe. */
  oauthCredentialSource?: AnthropicCredentialSource;
  /**
   * The Claude CLI the probe ran: the configured path, `claude (PATH)`, or an
   * install-folder path. Null when no Claude CLI was found.
   */
  binaryPath: string | null;
  checkedCommands: string[];
  message?: string;
  /** Source-assigned category for a failed OAuth usage request; absent otherwise. */
  failureCategory?: ProviderFailureCategory;
  /** Outcome of this attempt; never inferred from display text. */
  attemptOutcome?: QuotaAttemptOutcome;
  /**
   * When the returned quota was actually measured. Absent when no quota is
   * returned. A reused measurement keeps its original time.
   */
  quotaMeasuredAtMs?: number;
  /** True when the CLI probe itself did not complete (timeout or unusable output). */
  probeFailure?: true;
  /** Epoch ms when a rate-limited usage request may be retried; absent otherwise. */
  retryAtMs?: number;
  /** True when the usage request returned 401 and the stored token's own expiry is in the past. */
  storedAccessTokenExpired?: true;
  quota?: AnthropicQuotaResult;
  /** sha256 of the OAuth token bound to this probe, when a CLI token was used. */
  credentialFingerprint?: string;
  /** Display-only plan (e.g. `Claude (Max)`) of the verified Claude CLI login that answered the quota probe. */
  planLabel?: string;
}

export interface AnthropicProbeOptions {
  binaryPath?: string;
  operationCache?: Map<symbol, unknown>;
  forceRefresh?: boolean;
  requestTimeoutMs?: number;
  /** Minimum spacing between Anthropic usage requests for Claude Agent. */
  pollIntervalMs?: number;
}

type ClaudeCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnErrorCode?: number | string;
  errorMessage?: string;
};

export type ClaudeCommandInvocation = {
  file: string;
  args: string[];
  display: string;
  /** Set for cmd.exe bridges: the command line is already quoted, so Node must not re-quote it. */
  windowsVerbatimArguments?: boolean;
};

type AnthropicLocalDiagnostics = {
  installed: boolean;
  version: string | null;
  authStatus: AnthropicAuthStatus;
  binaryPath: string | null;
  checkedCommands: string[];
  message?: string;
  localQuota?: AnthropicQuotaResult;
  /** The exact binary the probe ran (configured path, bare `claude`, or install-folder path). */
  effectiveBinary?: string;
  /** The directory the Claude CLI's login is read from. Set once the CLI reports a signed-in state. */
  configDirectory?: ClaudeConfigDirectory;
  /**
   * True only when the CLI's JSON status positively reports a first-party claude.ai login. Only then
   * may the Claude CLI's stored token be used; an absent field or non-JSON status is not proof.
   */
  claudeAiLoginVerified?: boolean;
  /** Display-only plan, set only for a verified login whose `subscriptionType` is a known plan. */
  planLabel?: string;
  /**
   * Account-specific CLI login evidence (org id and email). It is hashed into the cache identity
   * and never displayed or persisted. Absent when the CLI reports no account.
   */
  accountHint?: string;
  /**
   * True when the CLI reported an organization id but no user-specific account evidence. An
   * organization is shared by its members, so it can neither key nor reuse a row scope.
   */
  orgOnlyAccountEvidence?: true;
  /** Set when the probe itself failed transiently; the CLI's auth may still be valid. */
  failureCategory?: ProviderFailureCategory;
  probeFailure?: true;
};

type ResolvedClaudeConfigDirectory = {
  state: "resolved";
  /** Absolute, normalized directory the login is read from. It is never shown to the user. */
  path: string;
  /** True for `~/.claude`, the only directory whose login is also kept in the macOS Keychain. */
  isDefault: boolean;
};

/** Where the Claude CLI keeps its login. "unresolved" names no directory, so nothing is read. */
type ClaudeConfigDirectory = ResolvedClaudeConfigDirectory | { state: "unresolved" };

type AnthropicOAuthRecentQuota = {
  quota: AnthropicQuotaResult;
  measuredAtMs: number;
};

/** Which credential store provided the OAuth access token used for the usage probe. */
export type AnthropicCredentialSource = "claude-credentials";

type AnthropicCredentialsAccess =
  | {
      state: "configured";
      accessToken: string;
      /** The CLI's own `expiresAt` for this access token (epoch ms), when stored. */
      expiresAtMs?: number;
      source: AnthropicCredentialSource;
      /** Which credential store supplied it; only a file source can be stat-verified. */
      storage: "file" | "keychain";
    }
  | {
      state: "unavailable";
      detail?: string;
    };

type ClaudeCredentialSourceResult =
  | {
      state: "configured";
      accessToken: string;
      expiresAtMs?: number;
      storage: "file" | "keychain";
    }
  | {
      state: "not-found";
      location: string;
    }
  | {
      state: "unavailable";
      detail: string;
    };

type AnthropicFallbackQuota =
  | {
      state: "success";
      quota: AnthropicQuotaResult;
      /** `fresh` made the request; `reuse` served the recent measurement. */
      attempt: "fresh" | "reuse";
      /** When the returned quota was measured, not when it was reused. */
      measuredAtMs: number;
    }
  | {
      state: "unavailable";
      detail?: string;
      failureKind?: "authentication";
      /** HTTP status of a rejected usage request. */
      httpStatus?: number;
      failureCategory?: ProviderFailureCategory;
      retryAtMs?: number;
      /** True when this outcome was a 429; the shared throttle publishes it. */
      rateLimited?: true;
      /** Parsed Retry-After for a 429, when the server supplied a usable value. */
      retryAfterMs?: number;
      /** `cooldown` made no request; the rest are real attempt outcomes. */
      attempt: "cooldown" | "transient" | "credentials";
    };

type ParsedAuthProbe = {
  authStatus: AnthropicAuthStatus;
  message?: string;
  jsonPayload?: unknown;
  unsupportedCommand?: boolean;
  claudeAiLoginVerified?: boolean;
  failureCategory?: ProviderFailureCategory;
  probeFailure?: true;
};

type AnthropicOAuthSharedState = {
  inFlight: Map<string, Promise<AnthropicFallbackQuota>>;
  forcedInFlight?: Map<string, Promise<AnthropicFallbackQuota>>;
  recent: Map<string, AnthropicOAuthRecentQuota>;
  /**
   * Credentials whose enhanced usage form was rejected. The plain form is used
   * on the next eligible claim, never as a second request inside the same claim.
   */
  plainForm?: Set<string>;
};

const ANTHROPIC_OAUTH_SHARED_STATE_KEY = Symbol.for(
  "opencode-quota-gui.anthropic-oauth-shared-state.v1",
);
const anthropicOAuthGlobal = globalThis as unknown as Record<PropertyKey, unknown>;
let anthropicOAuthSharedState = anthropicOAuthGlobal[ANTHROPIC_OAUTH_SHARED_STATE_KEY] as
  | AnthropicOAuthSharedState
  | undefined;
if (anthropicOAuthSharedState === undefined) {
  anthropicOAuthSharedState = {
    inFlight: new Map<string, Promise<AnthropicFallbackQuota>>(),
    recent: new Map<string, AnthropicOAuthRecentQuota>(),
  };
  Object.defineProperty(anthropicOAuthGlobal, ANTHROPIC_OAUTH_SHARED_STATE_KEY, {
    value: anthropicOAuthSharedState,
    configurable: true,
    writable: true,
  });
}

const anthropicOAuthInFlight = anthropicOAuthSharedState.inFlight;
anthropicOAuthSharedState.forcedInFlight ??= new Map();
anthropicOAuthSharedState.plainForm ??= new Set();
const anthropicOAuthForcedInFlight = anthropicOAuthSharedState.forcedInFlight;
const anthropicOAuthRecent = anthropicOAuthSharedState.recent;
const anthropicOAuthPlainForm = anthropicOAuthSharedState.plainForm;
const anthropicForcedResultsKey = Symbol("anthropic forced results");
/**
 * Config directories whose credentials file was read successfully in this process. The CLI
 * rewrites that file while refreshing its token, so a read that fails during that window is
 * retried once instead of being reported as a missing login.
 */
const claudeCredentialsLastGoodReads = new Map<string, number>();

type ClaudeCredentialFileSignature = {
  path: string;
  configDirEnv: string | undefined;
  mtimeMs: number;
  size: number;
};

type ClaudeIdentitySuccess = {
  identity: ResolvedAuthIdentity;
  signature: ClaudeCredentialFileSignature;
};

/**
 * The last successful Claude CLI identity for each config directory. It lives only in this
 * process: a transient probe failure may reuse it only while the credentials file is provably
 * unchanged, so a switch or a rotated login can never borrow another account's last-good.
 */
const claudeIdentitySuccesses = new Map<string, ClaudeIdentitySuccess>();

export function resolveAnthropicBinaryPath(binaryPath?: string): string {
  const trimmed = binaryPath?.trim();
  return trimmed ? trimmed : DEFAULT_CLAUDE_BINARY;
}

/**
 * Usual Claude CLI install locations, tried in order when `anthropicBinaryPath`
 * is not set and `claude` is not on the PATH of the OpenCode service. Windows
 * is skipped: set `anthropicBinaryPath` there.
 */
function claudeInstallFolderCandidates(): string[] {
  if (process.platform === "win32") return [];
  return [
    join(homedir(), ".claude", "local", "claude"),
    join(homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
}

function formatCommandDisplayArg(value: string): string {
  const sanitized = sanitizeDisplayText(value);
  return /[\s"]/u.test(sanitized) ? JSON.stringify(sanitized) : sanitized;
}

function formatCommandDisplay(parts: string[]): string {
  return parts.map(formatCommandDisplayArg).join(" ");
}

/**
 * cmd.exe cannot escape `"` inside a quoted argument, and `%` and `!` expand even inside
 * quotes, so a path containing any of these is refused rather than handed to the shell.
 */
const WINDOWS_CMD_UNSAFE_ARG = /[%!^&|<>"\r\n]/u;

function quoteWindowsCmdArg(value: string): string {
  if (WINDOWS_CMD_UNSAFE_ARG.test(value)) {
    throw new Error(
      "Claude CLI path contains characters that cannot be passed safely through cmd.exe.",
    );
  }
  return `"${value}"`;
}

function shouldBridgeClaudeCommandThroughWindowsShell(binaryPath: string): boolean {
  const normalized = binaryPath.trim().toLowerCase();
  if (!/[\\/]/u.test(normalized)) {
    return true;
  }

  return /\.(?:cmd|bat)$/u.test(normalized);
}

export function buildClaudeCommandInvocation(
  binaryPath: string,
  args: string[],
  runtime: { platform?: NodeJS.Platform; comspec?: string } = {},
): ClaudeCommandInvocation {
  const resolvedBinaryPath = resolveAnthropicBinaryPath(binaryPath);
  const display = formatCommandDisplay([resolvedBinaryPath, ...args]);

  if (
    (runtime.platform ?? process.platform) === "win32" &&
    shouldBridgeClaudeCommandThroughWindowsShell(resolvedBinaryPath)
  ) {
    // `/s` strips only the outermost quote pair, so the quoted command line is wrapped once more.
    const commandLine = [resolvedBinaryPath, ...args].map(quoteWindowsCmdArg).join(" ");
    return {
      file: runtime.comspec?.trim() || process.env["ComSpec"]?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      display,
      windowsVerbatimArguments: true,
    };
  }

  return {
    file: resolvedBinaryPath,
    args: [...args],
    display,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeResetTimeIso(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return new Date(parsed).toISOString();
}

function normalizeUsagePercent(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getWindowUsedPercent(window: Record<string, unknown>): number | undefined {
  const candidates = [
    window["utilization"],
    window["used_percentage"],
    window["usedPercentage"],
    window["used_percent"],
    window["usedPercent"],
    window["percent_used"],
    window["percentUsed"],
  ];

  for (const candidate of candidates) {
    const normalized = normalizeUsagePercent(candidate);
    if (normalized !== undefined) {
      return normalized;
    }
  }

  return undefined;
}

function getWindowResetTimeIso(window: Record<string, unknown>): string | undefined {
  return normalizeResetTimeIso(
    window["resets_at"] ?? window["resetsAt"] ?? window["reset_at"] ?? window["resetAt"],
  );
}

function parseQuotaWindow(
  window: unknown,
): { percentRemaining: number; resetTimeIso?: string } | null {
  const record = asRecord(window);
  if (!record) {
    return null;
  }

  const used = getWindowUsedPercent(record);
  if (used === undefined) {
    return null;
  }

  return {
    percentRemaining: Math.min(100, Math.round(100 - used)),
    resetTimeIso: getWindowResetTimeIso(record),
  };
}

function parseExtraUsageQuota(extraUsage: unknown): { percentRemaining: number } | undefined {
  const record = asRecord(extraUsage);
  if (!record || record["is_enabled"] !== true) {
    return undefined;
  }

  const utilization = record["utilization"];
  const usedCredits = record["used_credits"];
  const monthlyLimit = record["monthly_limit"];
  const used =
    typeof utilization === "number" && Number.isFinite(utilization)
      ? utilization
      : typeof usedCredits === "number" &&
          Number.isFinite(usedCredits) &&
          typeof monthlyLimit === "number" &&
          Number.isFinite(monthlyLimit) &&
          monthlyLimit > 0
        ? (usedCredits / monthlyLimit) * 100
        : undefined;
  if (used === undefined || used < 0 || used > 100) {
    return undefined;
  }

  return { percentRemaining: Math.round(100 - used) };
}

function getUsageRoots(data: unknown): Record<string, unknown>[] {
  const root = asRecord(data);
  if (!root) {
    return [];
  }

  const candidates = [
    root,
    asRecord(root["quota"]),
    asRecord(root["usage"]),
    asRecord(root["rate_limits"]),
    asRecord(root["rateLimits"]),
    asRecord(root["oauth_usage"]),
    asRecord(root["oauthUsage"]),
  ];

  const seen = new Set<Record<string, unknown>>();
  const roots: Record<string, unknown>[] = [];

  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    roots.push(candidate);
  }

  return roots;
}

function parseFableWeeklyWindow(
  limits: unknown,
): { percentRemaining: number; resetTimeIso?: string } | undefined {
  if (!Array.isArray(limits)) {
    return undefined;
  }

  for (const value of limits) {
    const limit = asRecord(value);
    if (!limit || limit["kind"] !== "weekly_scoped") {
      continue;
    }

    const scope = asRecord(limit["scope"]);
    const model = asRecord(scope?.["model"]);
    const displayName = model?.["display_name"];
    if (displayName !== "Fable") {
      continue;
    }

    const window = parseQuotaWindow({
      utilization: limit["percent"],
      resets_at: limit["resets_at"],
    });
    if (window) {
      return window;
    }
  }

  return undefined;
}

type ParsedUsageWindow = NonNullable<ReturnType<typeof parseQuotaWindow>>;

type UsageWindowRead =
  | { state: "absent" }
  | { state: "malformed" }
  | { state: "present"; window: ParsedUsageWindow };

function readUsageWindow(
  root: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
): UsageWindowRead {
  const hasSnakeKey = Object.hasOwn(root, snakeKey);
  const hasCamelKey = Object.hasOwn(root, camelKey);
  if (!hasSnakeKey && !hasCamelKey) {
    return { state: "absent" };
  }

  if (hasSnakeKey && hasCamelKey && root[snakeKey] !== root[camelKey]) {
    return { state: "malformed" };
  }

  const value = hasSnakeKey ? root[snakeKey] : root[camelKey];
  if (value === null) {
    return { state: "absent" };
  }

  const window = parseQuotaWindow(value);
  return window ? { state: "present", window } : { state: "malformed" };
}

function findUsageWindows(
  data: unknown,
  options: { allowSupplementalOnly?: boolean } = {},
): {
  root: Record<string, unknown>;
  fiveHour?: ParsedUsageWindow;
  sevenDay?: ParsedUsageWindow;
} | null {
  for (const root of getUsageRoots(data)) {
    const fiveHour = readUsageWindow(root, "five_hour", "fiveHour");
    const sevenDay = readUsageWindow(root, "seven_day", "sevenDay");
    if (fiveHour.state === "malformed" || sevenDay.state === "malformed") {
      continue;
    }

    const fiveHourWindow = fiveHour.state === "present" ? fiveHour.window : undefined;
    const sevenDayWindow = sevenDay.state === "present" ? sevenDay.window : undefined;
    if (!fiveHourWindow && !sevenDayWindow) {
      if (!options.allowSupplementalOnly) {
        continue;
      }
      if (!parseExtraUsageQuota(root["extra_usage"]) && !parseFableWeeklyWindow(root["limits"])) {
        continue;
      }
    }

    return {
      root,
      ...(fiveHourWindow ? { fiveHour: fiveHourWindow } : {}),
      ...(sevenDayWindow ? { sevenDay: sevenDayWindow } : {}),
    };
  }

  return null;
}

/** Anthropic's 5-hour session window and its weekly windows (including the Fable weekly scope). */
const FIVE_HOUR_WINDOW_MS = 5 * 60 * 60_000;
const SEVEN_DAY_WINDOW_MS = 7 * 24 * 60 * 60_000;

/**
 * Attaches fixed-window evidence derived from the window length and its reset. The 5h and weekly
 * windows are assumed to reset on a fixed cycle; that is not verified against the provider. A
 * window without a valid reset, or observed outside its inferred span, gets no evidence.
 */
function windowWithFixedEvidence<T extends { resetTimeIso?: string }>(
  window: T,
  durationMs: number,
  observedAtMs: number,
): T {
  const fixedWindow = buildFixedWindowEvidence({
    durationMs,
    resetTimeIso: window.resetTimeIso,
    observedAtMs,
  });
  return fixedWindow ? { ...window, fixedWindow } : window;
}

function parseUsageResponse(
  data: unknown,
  options: AnthropicUsageParseOptions = {},
): AnthropicQuotaResult | null {
  const windows = findUsageWindows(data);
  if (!windows?.fiveHour || !windows.sevenDay) return null;

  const extraUsage = options.includeExtraUsage
    ? parseExtraUsageQuota(windows.root["extra_usage"])
    : undefined;
  const observedAtMs = options.observedAtMs ?? Date.now();

  return {
    success: true,
    five_hour: windowWithFixedEvidence(windows.fiveHour, FIVE_HOUR_WINDOW_MS, observedAtMs),
    seven_day: windowWithFixedEvidence(windows.sevenDay, SEVEN_DAY_WINDOW_MS, observedAtMs),
    ...(extraUsage ? { extra_usage: extraUsage } : {}),
  };
}

/** Display cap for saved reset segments and the displayed count; larger valid inventories are truncated, not hidden. */
const MAX_SAVED_RESET_SEGMENTS = 100;

/** An optional ISO date: absent/null is open (`undefined`), a bad string is invalid (`NaN`). */
function savedResetDateMs(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * Independent of the quota windows: any malformed part only drops that grant (or the inventory).
 * Identifiers, labels and every other field are discarded; unknown expiry stays absent.
 */
function parseSavedResets(raw: unknown, nowMs: number): BankedResetAvailability | undefined {
  const root = asRecord(raw);
  if (root?.["eligible"] !== true || !Array.isArray(root["grants"])) return undefined;

  const grants: Array<{ count: number; endMs: number | undefined }> = [];
  for (const entry of root["grants"] as unknown[]) {
    const grant = asRecord(entry);
    if (!grant || grant["paused"] !== false) continue;
    const left = grant["resets_left"];
    if (typeof left !== "number" || !Number.isSafeInteger(left) || left <= 0) continue;
    const startMs = savedResetDateMs(grant["starts_at"]);
    const endMs = savedResetDateMs(grant["ends_at"]);
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue;
    if (startMs !== undefined && startMs > nowMs) continue;
    if (endMs !== undefined && endMs <= nowMs) continue;
    const total = grant["resets_total"];
    if (
      total !== undefined &&
      (typeof total !== "number" || !Number.isSafeInteger(total) || total < left)
    ) {
      continue;
    }
    // Counts are clamped per grant so huge safe integers never grow the sum or the allocation.
    grants.push({ count: Math.min(left, MAX_SAVED_RESET_SEGMENTS), endMs });
  }
  // Earliest known expiry first, unknown last; stable for equal expiries.
  grants.sort((a, b) => (a.endMs ?? Infinity) - (b.endMs ?? Infinity) || 0);
  const credits: BankedResetCredit[] = [];
  for (const grant of grants) {
    const expiry =
      grant.endMs === undefined ? {} : { expiresAtIso: new Date(grant.endMs).toISOString() };
    for (let n = grant.count; n > 0 && credits.length < MAX_SAVED_RESET_SEGMENTS; n -= 1) {
      credits.push({ ...expiry });
    }
  }
  return credits.length > 0 ? { availableCount: credits.length, credits } : undefined;
}

function parseOAuthUsageResponse(
  data: unknown,
  observedAtMs = Date.now(),
): AnthropicQuotaResult | null {
  const windows = findUsageWindows(data, { allowSupplementalOnly: true });
  if (!windows) return null;

  const extraUsage = parseExtraUsageQuota(windows.root["extra_usage"]);
  const fableWeekly = parseFableWeeklyWindow(windows.root["limits"]);
  const savedResets = parseSavedResets(windows.root["cedar_ember"], observedAtMs);
  return {
    ...(savedResets ? { saved_resets: savedResets } : {}),
    success: true,
    ...(windows.fiveHour
      ? {
          five_hour: windowWithFixedEvidence(windows.fiveHour, FIVE_HOUR_WINDOW_MS, observedAtMs),
        }
      : {}),
    ...(windows.sevenDay
      ? {
          seven_day: windowWithFixedEvidence(windows.sevenDay, SEVEN_DAY_WINDOW_MS, observedAtMs),
        }
      : {}),
    ...(extraUsage ? { extra_usage: extraUsage } : {}),
    ...(fableWeekly ? { fable_weekly: fableWeekly } : {}),
  };
}

/**
 * Parses one candidate config directory. `undefined` means the value is absent, which is not an
 * error. `null` means it is present but cannot name a directory (not a string, empty, padded with
 * whitespace, or relative), so the caller must fail closed rather than read another login.
 */
export function parseClaudeConfigDirectoryCandidate(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  if (!value || value.trim() !== value || !isAbsolute(value)) return null;
  return resolve(value);
}

function isSameConfigDirectory(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The directory the Claude CLI reads its login from. A directory the CLI reports is authoritative;
 * otherwise CLAUDE_CONFIG_DIR names it, and with neither set it is the default `~/.claude`. An
 * invalid value, or a reported directory that disagrees with CLAUDE_CONFIG_DIR, is unresolved, so
 * no login is read in its place.
 */
function resolveClaudeConfigDirectory(
  reported: unknown,
  environment: string | undefined,
): ClaudeConfigDirectory {
  const fromReport = parseClaudeConfigDirectoryCandidate(reported);
  const fromEnvironment = parseClaudeConfigDirectoryCandidate(environment);
  if (fromReport === null || fromEnvironment === null) return { state: "unresolved" };
  if (fromReport && fromEnvironment && !isSameConfigDirectory(fromReport, fromEnvironment)) {
    return { state: "unresolved" };
  }

  const defaultDirectory = resolve(join(homedir(), ".claude"));
  const path = fromReport ?? fromEnvironment ?? defaultDirectory;
  return {
    state: "resolved",
    path,
    // An explicit config directory may use a different macOS Keychain service,
    // even when it names the default path; never guess that service's identity.
    isDefault: fromEnvironment === undefined && isSameConfigDirectory(path, defaultDirectory),
  };
}

/** The identity qualifier for a config directory: its resolved path, or a fixed word when none is bound. */
function claudeConfigDirectoryQualifier(
  configDirectory: ClaudeConfigDirectory | undefined,
): string {
  return configDirectory?.state === "resolved" ? configDirectory.path : "unresolved";
}

function claudeCredentialsLocation(directory: ResolvedClaudeConfigDirectory): string {
  return directory.isDefault
    ? CLAUDE_DEFAULT_CREDENTIALS_LOCATION
    : CLAUDE_CUSTOM_CONFIG_DIRECTORY_LOCATION;
}

function getClaudeKeychainLocation(): string {
  return `macOS Keychain service ${sanitizeDisplayText(CLAUDE_CODE_CREDENTIALS_SERVICE)}`;
}

function getClaudeCredentialsNotFoundDetail(locations: string[]): string {
  if (locations.length === 0) {
    return "Claude OAuth credentials were not found.";
  }

  if (locations.length === 1) {
    return `Claude OAuth credentials not found in ${locations[0]}.`;
  }

  const [head, ...tail] = locations;
  return `Claude OAuth credentials not found in ${head} or ${tail.join(" or ")}.`;
}

function buildAnthropicNoQuotaDiagnosticsMessage(detail?: string): string {
  const normalizedDetail = detail?.trim();
  return normalizedDetail
    ? `${ANTHROPIC_NO_QUOTA_MESSAGE} ${normalizedDetail}`
    : ANTHROPIC_NO_QUOTA_MESSAGE;
}

function extractClaudeCredentialsAccessToken(data: unknown): {
  accessToken: string;
  expiresAtMs?: number;
} {
  const root = asRecord(data);
  if (!root) {
    return { accessToken: "" };
  }

  for (const candidate of [asRecord(root["claudeAiOauth"]), asRecord(root["oauth"]), root]) {
    if (!candidate) {
      continue;
    }

    for (const key of ["accessToken", "access_token", "token"]) {
      const token = candidate[key];
      if (typeof token === "string" && token.trim()) {
        const expiresAt = candidate["expiresAt"];
        return {
          accessToken: token.trim(),
          ...(typeof expiresAt === "number" && Number.isFinite(expiresAt)
            ? { expiresAtMs: expiresAt }
            : {}),
        };
      }
    }
  }

  return { accessToken: "" };
}

function parseClaudeCredentialsAccessToken(
  content: string,
  options: { allowPlainText: boolean },
): { accessToken?: string; expiresAtMs?: number; error?: string } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { error: "missing" };
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return options.allowPlainText ? { accessToken: trimmed } : { error: "missing" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const { accessToken, expiresAtMs } = extractClaudeCredentialsAccessToken(parsed);
    return accessToken
      ? { accessToken, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) }
      : { error: "missing" };
  } catch {
    // The parser's own message can quote a fragment of the token, so only a fixed reason is kept.
    return { error: "invalid JSON" };
  }
}

async function runCredentialCommand(file: string, args: string[]): Promise<ClaudeCommandResult> {
  return await new Promise<ClaudeCommandResult>((resolve, reject) => {
    try {
      execFile(
        file,
        args,
        {
          encoding: "utf8",
          timeout: CLAUDE_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
          const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");

          if (!error) {
            resolve({
              code: 0,
              stdout: stdoutText,
              stderr: stderrText,
              timedOut: false,
            });
            return;
          }

          const execError = error as Error & { code?: number | string; killed?: boolean };
          resolve({
            code: typeof execError.code === "number" ? execError.code : null,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: isTimedOutError(execError),
            spawnErrorCode: execError.code,
            errorMessage: execError.message,
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

async function readClaudeCredentialsAccessTokenFromMacOSKeychain(): Promise<ClaudeCredentialSourceResult | null> {
  if (process.platform !== "darwin") {
    return null;
  }

  const location = getClaudeKeychainLocation();
  const result = await runCredentialCommand("security", [
    "find-generic-password",
    "-s",
    CLAUDE_CODE_CREDENTIALS_SERVICE,
    "-w",
  ]);

  if (result.code !== 0) {
    return {
      state: "not-found",
      location,
    };
  }

  const parsed = parseClaudeCredentialsAccessToken(result.stdout, { allowPlainText: true });
  if (parsed.accessToken) {
    return {
      state: "configured",
      accessToken: parsed.accessToken,
      storage: "keychain",
      ...(parsed.expiresAtMs === undefined ? {} : { expiresAtMs: parsed.expiresAtMs }),
    };
  }

  return {
    state: "unavailable",
    detail:
      parsed.error && parsed.error !== "missing"
        ? `Could not parse Claude OAuth credentials from ${location}: ${parsed.error}.`
        : `Claude OAuth access token missing in ${location}.`,
  };
}

async function readClaudeCredentialsAccessTokenFromFile(
  directory: ResolvedClaudeConfigDirectory,
): Promise<ClaudeCredentialSourceResult> {
  const location = claudeCredentialsLocation(directory);
  try {
    const content = await readFile(join(directory.path, ".credentials.json"), "utf8");
    const parsed = parseClaudeCredentialsAccessToken(content, { allowPlainText: false });
    const accessToken = parsed.accessToken?.trim() ?? "";

    if (!accessToken) {
      return {
        state: "unavailable",
        detail:
          parsed.error && parsed.error !== "missing"
            ? `Could not parse Claude credentials in ${location}: ${parsed.error}.`
            : `Claude OAuth access token missing in ${location}.`,
      };
    }

    return {
      state: "configured",
      accessToken,
      storage: "file",
      ...(parsed.expiresAtMs === undefined ? {} : { expiresAtMs: parsed.expiresAtMs }),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;

    if (code === "ENOENT") {
      return {
        state: "not-found",
        location,
      };
    }

    // Only a system error code is shown: a file system message can name the path it failed on.
    const shownCode = typeof code === "string" && /^E[A-Z0-9]+$/u.test(code) ? code : "unknown";
    return {
      state: "unavailable",
      detail: `Could not read Claude credentials in ${location}: ${shownCode} error.`,
    };
  }
}

function rememberClaudeCredentialsRead(directory: ResolvedClaudeConfigDirectory): void {
  const nowMs = Date.now();
  for (const [path, readAtMs] of claudeCredentialsLastGoodReads) {
    if (nowMs - readAtMs >= CLAUDE_CREDENTIALS_READ_RETRY_MS) {
      claudeCredentialsLastGoodReads.delete(path);
    }
  }
  claudeCredentialsLastGoodReads.set(directory.path, nowMs);
}

function hadRecentClaudeCredentialsRead(directory: ResolvedClaudeConfigDirectory): boolean {
  const readAtMs = claudeCredentialsLastGoodReads.get(directory.path);
  return readAtMs !== undefined && Date.now() - readAtMs < CLAUDE_CREDENTIALS_READ_RETRY_MS;
}

/**
 * The credential file's identity signature, captured before its token is read. `stat` is the only
 * read here: a changed, missing, or unreadable file yields null, which disables reuse.
 */
async function readClaudeCredentialFileSignature(
  configDirectory: ClaudeConfigDirectory | undefined,
): Promise<ClaudeCredentialFileSignature | null> {
  if (configDirectory?.state !== "resolved") return null;
  const path = join(configDirectory.path, ".credentials.json");
  try {
    const stats = await stat(path);
    if (!stats.isFile()) return null;
    return {
      path,
      configDirEnv: process.env[CLAUDE_CONFIG_DIR_ENV],
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

/**
 * Remember a successful, file-backed, user-specific Claude identity. Organization-only evidence
 * never reaches this helper: it cannot distinguish two members of one organization. A keychain
 * token has no stat-able source, so it is never remembered and can never be reused from memory.
 */
function rememberClaudeIdentitySuccess(
  configDirectory: ClaudeConfigDirectory | undefined,
  identity: ResolvedAuthIdentity,
  signature: ClaudeCredentialFileSignature | null,
): void {
  if (configDirectory?.state !== "resolved" || signature === null) return;
  claudeIdentitySuccesses.set(configDirectory.path, { identity, signature });
}

/** Drop a remembered identity once the current probe can no longer attribute the same user. */
function forgetClaudeIdentitySuccess(configDirectory: ClaudeConfigDirectory | undefined): void {
  if (configDirectory?.state !== "resolved") return;
  claudeIdentitySuccesses.delete(configDirectory.path);
}

/**
 * Reuse the last successful identity only while the credential source is provably unchanged:
 * the same directory, the same CLAUDE_CONFIG_DIR value, and an identical credentials-file stat.
 * Any change, an unreadable file, or no record yields null, leaving this cycle without a scope.
 */
async function recallClaudeIdentitySuccess(): Promise<ResolvedAuthIdentity | null> {
  const configDirectory = resolveClaudeConfigDirectory(
    undefined,
    process.env[CLAUDE_CONFIG_DIR_ENV],
  );
  if (configDirectory.state !== "resolved") return null;
  const remembered = claudeIdentitySuccesses.get(configDirectory.path);
  if (!remembered) return null;
  if (remembered.signature.configDirEnv !== process.env[CLAUDE_CONFIG_DIR_ENV]) return null;
  const current = await readClaudeCredentialFileSignature(configDirectory);
  if (
    current === null ||
    current.path !== remembered.signature.path ||
    current.mtimeMs !== remembered.signature.mtimeMs ||
    current.size !== remembered.signature.size
  ) {
    return null;
  }
  return remembered.identity;
}

async function readClaudeOAuthAccessToken(
  configDirectory: ClaudeConfigDirectory,
): Promise<AnthropicCredentialsAccess> {
  if (configDirectory.state !== "resolved") {
    return { state: "unavailable", detail: CLAUDE_CONFIG_DIRECTORY_UNRESOLVED_DETAIL };
  }

  const locationsChecked: string[] = [];
  const unavailableDetails: string[] = [];
  // Only the default directory has a macOS Keychain entry, so a custom directory never reads it.
  const keychainCredentials = configDirectory.isDefault
    ? await readClaudeCredentialsAccessTokenFromMacOSKeychain()
    : null;
  if (keychainCredentials?.state === "configured") {
    return { ...keychainCredentials, source: "claude-credentials" };
  }
  if (keychainCredentials?.state === "unavailable") {
    unavailableDetails.push(keychainCredentials.detail);
  }
  if (keychainCredentials?.state === "not-found") {
    locationsChecked.push(keychainCredentials.location);
  }

  let fileCredentials = await readClaudeCredentialsAccessTokenFromFile(configDirectory);
  // The CLI rewrites this file while refreshing its token. If it was readable moments ago, one
  // more read can land after the write instead of reporting a missing login for a poll.
  if (fileCredentials.state !== "configured" && hadRecentClaudeCredentialsRead(configDirectory)) {
    fileCredentials = await readClaudeCredentialsAccessTokenFromFile(configDirectory);
  }
  if (fileCredentials.state === "configured") {
    rememberClaudeCredentialsRead(configDirectory);
    return { ...fileCredentials, source: "claude-credentials" };
  }
  if (fileCredentials.state === "unavailable") {
    unavailableDetails.push(fileCredentials.detail);
  }
  if (fileCredentials.state === "not-found") {
    locationsChecked.push(fileCredentials.location);
  }
  return {
    state: "unavailable",
    detail: unavailableDetails[0] ?? getClaudeCredentialsNotFoundDetail(locationsChecked),
  };
}

/**
 * The Claude CLI's stored subscription token. It is read only when the CLI positively reports a
 * first-party claude.ai login, because an absent or non-JSON status cannot prove whose token it is.
 */
async function readClaudeCliSubscriptionToken(
  localDiagnostics: AnthropicLocalDiagnostics,
): Promise<AnthropicCredentialsAccess> {
  if (localDiagnostics.claudeAiLoginVerified !== true) {
    return { state: "unavailable", detail: CLAUDE_CLI_TOKEN_UNVERIFIED_DETAIL };
  }
  return await readClaudeOAuthAccessToken(
    localDiagnostics.configDirectory ?? { state: "unresolved" },
  );
}

export function fingerprintAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    const durationMs = seconds * 1_000;
    return Number.isFinite(durationMs) &&
      durationMs > 0 &&
      durationMs <= ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS
      ? durationMs
      : undefined;
  }

  const retryAtMs = Date.parse(trimmed);
  const durationMs = retryAtMs - nowMs;
  return Number.isFinite(durationMs) &&
    durationMs > 0 &&
    durationMs <= ANTHROPIC_OAUTH_RETRY_AFTER_MAX_MS
    ? durationMs
    : undefined;
}

function getAnthropicOAuthCooldownMessage(remainingMs: number): string {
  return `Anthropic OAuth usage probe paused after HTTP 429; retry in ${Math.ceil(
    Math.max(0, remainingMs) / 1_000,
  )}s.`;
}

function rememberAnthropicOAuthQuota(
  tokenFingerprint: string,
  quota: AnthropicQuotaResult,
  measuredAtMs: number,
  pollIntervalMs?: number,
): void {
  const nowMs = Date.now();
  const reuseWindowMs = normalizeAnthropicOAuthPollIntervalMs(pollIntervalMs);
  for (const [fingerprint, entry] of anthropicOAuthRecent) {
    if (nowMs - entry.measuredAtMs >= reuseWindowMs) {
      anthropicOAuthRecent.delete(fingerprint);
    }
  }
  anthropicOAuthRecent.set(tokenFingerprint, { quota, measuredAtMs });
}

function redactAccessTokenFromSanitizedDetail(detail: string, accessToken: string): string {
  const sanitizedDetail = sanitizeDisplayText(detail);
  const sanitizedAccessToken = sanitizeDisplayText(accessToken);
  const redactedDetail = sanitizedDetail.split(accessToken).join("[redacted]");
  return sanitizedAccessToken
    ? redactedDetail.split(sanitizedAccessToken).join("[redacted]")
    : redactedDetail;
}

function sanitizeAnthropicApiDetail(detail: string, accessToken: string): string {
  return redactAccessTokenFromSanitizedDetail(detail, accessToken).slice(0, 120);
}

function sanitizeAnthropicRequestError(detail: string, accessToken: string): string {
  return redactAccessTokenFromSanitizedDetail(detail, accessToken);
}

/** The usage endpoint rejects unrecognized clients, so identify as the Claude CLI that owns the login. */
function claudeCodeUserAgent(cliVersion: string | null | undefined, enhanced: boolean): string {
  const version = (cliVersion ?? "").replace(/[^0-9A-Za-z.+-]/gu, "").slice(0, 48);
  if (enhanced)
    return version ? `claude-cli/${version} (external, cli)` : "claude-cli (external, cli)";
  // The plain fallback keeps the identity the usage probe has always sent.
  return version ? `claude-code/${version}` : "claude-code";
}

/** The 429 deadline is published before the body is consumed, which may time out. */
type AnthropicRateLimitPublisher = (info: {
  retryAfterMs: number | undefined;
  nowMs: number;
}) => Promise<unknown>;

/**
 * One HTTP request per claim. The enhanced form is remembered per credential; a
 * rejection switches later, separately-spaced claims to the plain form instead
 * of firing a second request inside this claim's spacing window.
 */
async function performAnthropicOAuthUsageRequest(
  accessToken: string,
  tokenFingerprint: string,
  requestTimeoutMs?: number,
  cliVersion?: string | null,
  publishRateLimit?: AnthropicRateLimitPublisher,
): Promise<AnthropicFallbackQuota> {
  const enhanced = !anthropicOAuthPlainForm.has(tokenFingerprint);
  return await requestAnthropicOAuthUsage(
    accessToken,
    tokenFingerprint,
    requestTimeoutMs,
    cliVersion,
    enhanced,
    publishRateLimit,
  );
}

async function requestAnthropicOAuthUsage(
  accessToken: string,
  tokenFingerprint: string,
  requestTimeoutMs: number | undefined,
  cliVersion: string | null | undefined,
  enhanced: boolean,
  publishRateLimit?: AnthropicRateLimitPublisher,
): Promise<AnthropicFallbackQuota> {
  try {
    return await fetchWithTimeout(enhanced ? ANTHROPIC_USAGE_ENHANCED_URL : ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": ANTHROPIC_BETA_HEADER,
          "User-Agent": claudeCodeUserAgent(cliVersion, enhanced),
        },
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response, timeoutSignal): Promise<AnthropicFallbackQuota> => {
        if (response.status === 429) {
          anthropicOAuthRecent.delete(tokenFingerprint);
          const nowMs = Date.now();
          const retryAfterMs = parseRetryAfterMs(
            response.headers?.get?.("Retry-After") ?? null,
            nowMs,
          );

          // The headers already prove the deadline; publish it before the body
          // read, which may time out and would otherwise lose the cooldown.
          if (publishRateLimit) {
            try {
              await publishRateLimit({ retryAfterMs, nowMs });
            } catch {
              // The throttle keeps the deadline in-process and retries the write.
            }
          }

          // The 429 is already proven; a body read failure must not discard the
          // known deadline or turn this attempt into an unclassified error.
          let detail = "";
          try {
            detail = sanitizeAnthropicApiDetail(await response.text(), accessToken);
          } catch {
            detail = "";
          }

          const errorDetail = detail
            ? `Anthropic API error ${response.status}: ${detail}`
            : `Anthropic API returned ${response.status}`;
          return {
            state: "unavailable",
            detail: errorDetail,
            failureCategory: "provider_api",
            rateLimited: true,
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
            attempt: "transient",
          };
        }

        if (!response.ok) {
          const authenticationFailure = response.status === 401 || response.status === 403;
          let detail = "";
          let enhancedRejected = enhanced && response.status === 400;
          try {
            const body = await response.text();
            // A 403 naming a missing scope or user:profile is a real credential problem, never an enhanced-form rejection.
            if (enhanced && response.status === 403 && !/scope|user:profile/iu.test(body)) {
              enhancedRejected = true;
            }
            detail = sanitizeAnthropicApiDetail(body, accessToken);
          } catch (error) {
            if (timeoutSignal.aborted && !authenticationFailure) throw error;
            detail = "";
          }
          if (enhancedRejected) anthropicOAuthPlainForm.add(tokenFingerprint);

          return {
            state: "unavailable",
            detail: detail
              ? `Anthropic API error ${response.status}: ${detail}`
              : `Anthropic API returned ${response.status}`,
            ...(authenticationFailure ? { failureKind: "authentication" as const } : {}),
            httpStatus: response.status,
            failureCategory: authenticationFailure ? "credentials" : "provider_api",
            attempt: authenticationFailure ? "credentials" : "transient",
          };
        }

        let data: unknown;
        try {
          data = await response.json();
        } catch (error) {
          if (timeoutSignal.aborted) throw error;
          return {
            state: "unavailable",
            detail: "Failed to parse Anthropic quota response",
            failureCategory: "provider_api",
            attempt: "transient",
          };
        }

        const quota = parseOAuthUsageResponse(data);
        if (!quota) {
          return {
            state: "unavailable",
            detail: "Unexpected Anthropic quota response shape",
            failureCategory: "provider_api",
            attempt: "transient",
          };
        }

        return {
          state: "success",
          quota,
          attempt: "fresh",
          measuredAtMs: Date.now(),
        };
      },
    });
  } catch (error) {
    return {
      state: "unavailable",
      detail: sanitizeAnthropicRequestError(
        error instanceof Error ? error.message : String(error),
        accessToken,
      ),
      failureCategory: "provider_api",
      attempt: "transient",
    };
  }
}

async function queryAnthropicQuotaFromOAuthAccessToken(
  accessToken: string,
  requestTimeoutMs?: number,
  forcedOperationCache?: Map<symbol, unknown>,
  cliVersion?: string | null,
  pollIntervalMs?: number,
): Promise<AnthropicFallbackQuota> {
  const tokenFingerprint = fingerprintAccessToken(accessToken);
  const intervalMs = normalizeAnthropicOAuthPollIntervalMs(pollIntervalMs);

  let forcedResults: Map<string, Promise<AnthropicFallbackQuota>> | undefined;
  if (forcedOperationCache) {
    forcedResults = forcedOperationCache.get(anthropicForcedResultsKey) as
      | Map<string, Promise<AnthropicFallbackQuota>>
      | undefined;
    if (!forcedResults) {
      forcedResults = new Map();
      forcedOperationCache.set(anthropicForcedResultsKey, forcedResults);
    }
    const existing = forcedResults.get(tokenFingerprint);
    if (existing) return await existing;
  }

  if (forcedResults) {
    const existingForced = anthropicOAuthForcedInFlight.get(tokenFingerprint);
    if (existingForced) {
      forcedResults.set(tokenFingerprint, existingForced);
      return await existingForced;
    }
  } else {
    const existing = anthropicOAuthInFlight.get(tokenFingerprint);
    if (existing) return await existing;
  }

  const prior = forcedResults ? anthropicOAuthInFlight.get(tokenFingerprint) : undefined;
  const inFlight = (async (): Promise<AnthropicFallbackQuota> => {
    if (prior) await prior;

    // The claim is cross-process: a busy lock, an active cooldown or a request
    // still inside the configured spacing window all skip without fetching.
    const claim = await claimAnthropicOAuthUsageRequest({
      nowMs: Date.now(),
      pollIntervalMs: intervalMs,
      requestTimeoutMs,
    });
    if (claim.state === "skip") {
      if (claim.reason === "spacing") {
        const recent = anthropicOAuthRecent.get(tokenFingerprint);
        const nowMs = Date.now();
        if (recent && nowMs >= recent.measuredAtMs && nowMs - recent.measuredAtMs < intervalMs) {
          return {
            state: "success",
            quota: recent.quota,
            attempt: "reuse",
            measuredAtMs: recent.measuredAtMs,
          };
        }
        return {
          state: "unavailable",
          detail: "Claude Agent waiting for its next configured usage request.",
          failureCategory: "provider_api",
          ...(claim.retryAtMs !== undefined ? { retryAtMs: claim.retryAtMs } : {}),
          attempt: "cooldown",
        };
      }
      const nowMs = Date.now();
      const retryAtMs = claim.retryAtMs ?? (claim.reason === "cooldown" ? nowMs : undefined);
      return {
        state: "unavailable",
        detail:
          claim.reason === "cooldown" && retryAtMs !== undefined
            ? getAnthropicOAuthCooldownMessage(retryAtMs - nowMs)
            : "Claude Agent usage request is already being coordinated.",
        failureCategory: "provider_api",
        ...(retryAtMs !== undefined ? { retryAtMs } : {}),
        attempt: "cooldown",
      };
    }

    let publishedCompletion: AnthropicOAuthAttemptCompletionResult | undefined;
    let publishedRetryAfterMs: number | undefined;
    const publishRateLimit: AnthropicRateLimitPublisher = async (info) => {
      publishedRetryAfterMs = info.retryAfterMs;
      publishedCompletion = await claim.complete({
        kind: "rate-limited",
        ...(info.retryAfterMs !== undefined ? { retryAfterMs: info.retryAfterMs } : {}),
        nowMs: info.nowMs,
      });
    };

    let result: AnthropicFallbackQuota;
    try {
      result = await performAnthropicOAuthUsageRequest(
        accessToken,
        tokenFingerprint,
        requestTimeoutMs,
        cliVersion,
        publishRateLimit,
      );
    } catch (error) {
      if (publishedCompletion === undefined) {
        await claim.complete({ kind: "network-error" });
        throw error;
      }
      // The 429 was proven from headers before this failure; report the cooldown.
      result = {
        state: "unavailable",
        detail: "Anthropic API returned 429",
        failureCategory: "provider_api",
        rateLimited: true,
        ...(publishedRetryAfterMs !== undefined ? { retryAfterMs: publishedRetryAfterMs } : {}),
        attempt: "transient",
      };
    }

    // A body-read timeout is classified as a plain transient failure, but the
    // headers already proved the 429. Keep that deadline and do not downgrade it.
    if (
      publishedCompletion !== undefined &&
      result.state !== "success" &&
      result.rateLimited !== true
    ) {
      result = {
        state: "unavailable",
        detail: "Anthropic API returned 429",
        failureCategory: "provider_api",
        rateLimited: true,
        ...(publishedRetryAfterMs !== undefined ? { retryAfterMs: publishedRetryAfterMs } : {}),
        attempt: "transient",
      };
    }

    let completion: AnthropicOAuthAttemptCompletionResult | undefined;
    if (result.state === "success") {
      await claim.complete({ kind: "success" });
      rememberAnthropicOAuthQuota(tokenFingerprint, result.quota, result.measuredAtMs, intervalMs);
    } else if (result.rateLimited === true) {
      completion =
        publishedCompletion ??
        (await claim.complete({
          kind: "rate-limited",
          ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
          nowMs: Date.now(),
        }));
      const nowMs = Date.now();
      const blockedUntilMs = completion.blockedUntilMs ?? nowMs;
      // The shared request spacing still applies: the card and diagnostics must
      // name the next real attempt, not an earlier server deadline.
      const nextAttemptAtMs = Math.max(blockedUntilMs, claim.claimedAtMs + intervalMs);
      result = {
        ...result,
        detail: `${result.detail ?? ""} ${getAnthropicOAuthCooldownMessage(
          nextAttemptAtMs - nowMs,
        )}`.trim(),
        retryAtMs: nextAttemptAtMs,
      };
    } else if (result.httpStatus !== undefined) {
      // Any response other than 429 ends the previous 429 streak.
      await claim.complete({ kind: "response" });
    } else {
      await claim.complete({ kind: "network-error" });
    }

    if (result.state !== "success") {
      const cached = anthropicOAuthRecent.get(tokenFingerprint);
      if (cached?.quota.saved_resets) {
        const { saved_resets: _savedResets, ...quota } = cached.quota;
        anthropicOAuthRecent.set(tokenFingerprint, { ...cached, quota });
      }
    }
    return result;
  })();
  anthropicOAuthInFlight.set(tokenFingerprint, inFlight);
  if (forcedResults) {
    forcedResults.set(tokenFingerprint, inFlight);
    anthropicOAuthForcedInFlight.set(tokenFingerprint, inFlight);
  }
  try {
    return await inFlight;
  } finally {
    if (anthropicOAuthInFlight.get(tokenFingerprint) === inFlight)
      anthropicOAuthInFlight.delete(tokenFingerprint);
    if (anthropicOAuthForcedInFlight.get(tokenFingerprint) === inFlight)
      anthropicOAuthForcedInFlight.delete(tokenFingerprint);
  }
}

export async function queryAnthropicQuotaWithOAuth(
  accessToken: string,
  requestTimeoutMs?: number,
  forcedOperationCache?: Map<symbol, unknown>,
): Promise<AnthropicResult> {
  const result = await queryAnthropicQuotaFromOAuthAccessToken(
    accessToken,
    requestTimeoutMs,
    forcedOperationCache,
  );
  return result.state === "success"
    ? result.quota
    : {
        success: false,
        error: result.detail ?? "Anthropic OAuth quota unavailable",
        ...(result.failureCategory !== undefined
          ? { failureCategory: result.failureCategory }
          : {}),
      };
}

function extractAuthBoolean(data: unknown): boolean | undefined {
  const record = asRecord(data);
  if (!record) {
    return undefined;
  }

  for (const candidate of [
    record["authenticated"],
    record["isAuthenticated"],
    record["loggedIn"],
  ]) {
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  const authRecord = asRecord(record["auth"]);
  if (authRecord) {
    for (const candidate of [authRecord["authenticated"], authRecord["loggedIn"]]) {
      if (typeof candidate === "boolean") {
        return candidate;
      }
    }
  }

  const status = record["status"];
  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    if (normalized === "authenticated") {
      return true;
    }
    if (normalized === "unauthenticated") {
      return false;
    }
  }

  return undefined;
}

/**
 * `auth status --json` reports how the login was made. Only a claude.ai subscription login on
 * Anthropic's first-party API is the Claude Code account; any other reported method or provider is
 * stale or unrelated. A field that is absent is not evidence either way.
 */
/**
 * Positive evidence that the Claude CLI login is a first-party claude.ai subscription. Both fields
 * must be reported; an absent field proves nothing, so a login without them cannot prove its identity.
 */
function hasFirstPartyClaudeAiLogin(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const method = record["authMethod"];
  const provider = record["apiProvider"];
  return (
    typeof method === "string" &&
    method.trim().toLowerCase() === "claude.ai" &&
    typeof provider === "string" &&
    provider.trim().toLowerCase() === "firstparty"
  );
}

/** Field names that carry a user-specific account id in the CLI's own status. */
const CLAUDE_USER_ACCOUNT_ID_FIELDS = [
  "accountUuid",
  "account_uuid",
  "userUuid",
  "user_uuid",
  "userId",
  "user_id",
] as const;

/**
 * User-specific evidence in the CLI's own status, used only to key the cache identity when the
 * stored token cannot be read. An organization id alone is not evidence because every member
 * shares it; when user evidence exists, the organization is only a qualifier. It is never
 * displayed, persisted, or sent anywhere.
 */
function claudeLoginAccountHint(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  const orgId = typeof record["orgId"] === "string" ? record["orgId"].trim() : "";
  const email = typeof record["email"] === "string" ? record["email"].trim().toLowerCase() : "";
  const userId =
    CLAUDE_USER_ACCOUNT_ID_FIELDS.map((key) =>
      typeof record[key] === "string" ? record[key].trim() : "",
    ).find((value) => value !== "") ?? "";
  if (!email && !userId) return undefined;
  // The organization id is only a qualifier here; the email/user id keeps it user-specific.
  // Omitting the extra element when no user id exists preserves the existing email-only scope.
  return userId ? JSON.stringify([orgId, email, userId]) : JSON.stringify([orgId, email]);
}

/** True when the CLI named an organization but no user-specific account evidence. */
function hasClaudeOrgOnlyAccountEvidence(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const orgId = typeof record["orgId"] === "string" ? record["orgId"].trim() : "";
  return orgId !== "" && claudeLoginAccountHint(payload) === undefined;
}

/** The only plan names shown. The CLI's `subscriptionType` is undocumented, so anything else is omitted. */
const CLAUDE_PLAN_LABELS: ReadonlyMap<string, string> = new Map([
  ["free", "Free"],
  ["pro", "Pro"],
  ["max", "Max"],
  ["team", "Team"],
  ["enterprise", "Enterprise"],
  ["ultra", "Ultra"],
]);

/**
 * Display-only plan name from a verified login's `subscriptionType`; absent, null, or unknown gives none.
 * Bare name (e.g. "Max"): the card already names the provider, so the header reads `Anthropic · Max`,
 * the same shape as OpenAI's account header (`OpenAI · Pro`).
 */
function deriveClaudePlanLabel(payload: unknown): string | undefined {
  const subscriptionType = asRecord(payload)?.["subscriptionType"];
  if (typeof subscriptionType !== "string") return undefined;
  return CLAUDE_PLAN_LABELS.get(subscriptionType.trim().toLowerCase());
}

function hasNonSubscriptionLogin(payload: unknown): boolean {
  const record = asRecord(payload);
  if (!record) return false;
  const method = record["authMethod"];
  if (method !== undefined && method !== null) {
    if (typeof method !== "string" || method.trim().toLowerCase() !== "claude.ai") return true;
  }
  const provider = record["apiProvider"];
  if (provider !== undefined && provider !== null) {
    if (typeof provider !== "string" || provider.trim().toLowerCase() !== "firstparty") return true;
  }
  return false;
}

function hasUnsupportedCommandText(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("unknown command") ||
    normalized.includes("unrecognized command") ||
    normalized.includes("unexpected argument")
  );
}

function hasUnauthenticatedText(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("not logged in") ||
    normalized.includes("login required") ||
    normalized.includes("authentication required") ||
    normalized.includes("run `claude login`") ||
    normalized.includes("run `claude auth login`") ||
    normalized.includes("run claude login") ||
    normalized.includes("run claude auth login")
  );
}

function detailFromCommandResult(result: ClaudeCommandResult): string | undefined {
  const detail = `${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.trim();
  return detail ? sanitizeDisplaySnippet(detail, 160) : undefined;
}

function parseVersion(output: string): string | null {
  const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : null;
}

function isCommandMissing(result: ClaudeCommandResult): boolean {
  if (result.spawnErrorCode === "ENOENT") {
    return true;
  }

  const output = `${result.stderr}\n${result.stdout}\n${result.errorMessage ?? ""}`.toLowerCase();
  return (
    output.includes("command not found") ||
    output.includes("not recognized as an internal or external command") ||
    output.includes("no such file or directory")
  );
}

function isTimedOutError(error: Error & { code?: number | string; killed?: boolean }): boolean {
  return (
    error.code === "ETIMEDOUT" ||
    error.killed === true ||
    error.message.toLowerCase().includes("timed out")
  );
}

async function runClaudeCommand(invocation: ClaudeCommandInvocation): Promise<ClaudeCommandResult> {
  return await new Promise<ClaudeCommandResult>((resolve, reject) => {
    try {
      execFile(
        invocation.file,
        invocation.args,
        {
          encoding: "utf8",
          timeout: CLAUDE_COMMAND_TIMEOUT_MS,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        },
        (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => {
          const stdoutText = typeof stdout === "string" ? stdout : stdout.toString("utf8");
          const stderrText = typeof stderr === "string" ? stderr : stderr.toString("utf8");

          if (!error) {
            resolve({
              code: 0,
              stdout: stdoutText,
              stderr: stderrText,
              timedOut: false,
            });
            return;
          }

          const execError = error as Error & { code?: number | string; killed?: boolean };
          resolve({
            code: typeof execError.code === "number" ? execError.code : null,
            stdout: stdoutText,
            stderr: stderrText,
            timedOut: isTimedOutError(execError),
            spawnErrorCode: execError.code,
            errorMessage: execError.message,
          });
        },
      );
    } catch (error) {
      reject(error);
    }
  });
}

function parseClaudeAuthStatusResult(result: ClaudeCommandResult): ParsedAuthProbe {
  const combinedOutput = `${result.stdout}\n${result.stderr}`;
  const trimmed = result.stdout.trim();
  let jsonPayload: unknown;
  let hasJsonBody = false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      jsonPayload = JSON.parse(trimmed) as unknown;
      hasJsonBody = true;
    } catch {
      // Not a JSON body; the text/exit-code fallbacks below decide.
    }
  }

  // A JSON status body is authoritative. stderr noise (banners, update notices) must not turn a
  // positively reported login into a sign-out.
  if (hasJsonBody) {
    const auth = extractAuthBoolean(jsonPayload);
    if (auth === true) {
      if (hasNonSubscriptionLogin(jsonPayload)) {
        return {
          authStatus: "unknown",
          message: CLAUDE_NON_SUBSCRIPTION_LOGIN_MESSAGE,
        };
      }
      return {
        authStatus: "authenticated",
        jsonPayload,
        claudeAiLoginVerified: hasFirstPartyClaudeAiLogin(jsonPayload),
      };
    }

    if (auth === false) {
      return {
        authStatus: "unauthenticated",
        message: "Claude is not authenticated. Run `claude auth login` and try again.",
        jsonPayload,
      };
    }
  }

  if (hasUnsupportedCommandText(combinedOutput)) {
    return {
      authStatus: "unknown",
      unsupportedCommand: true,
      message: "Claude CLI authentication status JSON is unavailable in this version of Claude.",
    };
  }

  if (hasUnauthenticatedText(combinedOutput)) {
    return {
      authStatus: "unauthenticated",
      message: "Claude is not authenticated. Run `claude auth login` and try again.",
    };
  }

  if (hasJsonBody) {
    return {
      authStatus: "unknown",
      message: "Could not verify Claude authentication status from JSON output.",
      jsonPayload,
      failureCategory: "provider_api",
    };
  }

  if (result.code === 0) {
    return { authStatus: "authenticated" };
  }

  if (result.timedOut) {
    return {
      authStatus: "unknown",
      message: "Timed out while running Claude CLI auth status.",
      failureCategory: "provider_api",
      probeFailure: true,
    };
  }

  const detail = detailFromCommandResult(result);
  return {
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
    failureCategory: "provider_api",
    probeFailure: true,
  };
}

function mapLocalDiagnosticsToAnthropicDiagnostics(
  localDiagnostics: AnthropicLocalDiagnostics,
): AnthropicDiagnostics {
  if (localDiagnostics.localQuota) {
    return {
      installed: localDiagnostics.installed,
      version: localDiagnostics.version,
      authStatus: localDiagnostics.authStatus,
      quotaSupported: true,
      quotaSource: "claude-auth-status-json",
      binaryPath: localDiagnostics.binaryPath,
      checkedCommands: localDiagnostics.checkedCommands,
      quota: localDiagnostics.localQuota,
      ...(localDiagnostics.planLabel === undefined
        ? {}
        : { planLabel: localDiagnostics.planLabel }),
    };
  }

  const diagnostics: AnthropicDiagnostics = {
    installed: localDiagnostics.installed,
    version: localDiagnostics.version,
    authStatus: localDiagnostics.authStatus,
    quotaSupported: false,
    quotaSource: "none",
    binaryPath: localDiagnostics.binaryPath,
    checkedCommands: localDiagnostics.checkedCommands,
  };

  if (localDiagnostics.message) {
    diagnostics.message = localDiagnostics.message;
  }
  if (localDiagnostics.failureCategory !== undefined) {
    diagnostics.failureCategory = localDiagnostics.failureCategory;
  }
  if (localDiagnostics.probeFailure === true) {
    diagnostics.probeFailure = true;
  }

  return diagnostics;
}

async function runClaudeVersionCommand(
  binaryPath: string,
  checkedCommands: string[],
): Promise<ClaudeCommandResult> {
  const versionCommand = buildClaudeCommandInvocation(binaryPath, ["--version"]);
  checkedCommands.push(versionCommand.display);
  return await runClaudeCommand(versionCommand);
}

async function probeAnthropicLocalDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicLocalDiagnostics> {
  const configuredBinaryPath = resolveAnthropicBinaryPath(options.binaryPath);
  const checkedCommands: string[] = [];

  let binaryPath = configuredBinaryPath;
  let versionResult = await runClaudeVersionCommand(binaryPath, checkedCommands);
  // No configured path and no `claude` on PATH: the first install folder whose CLI runs wins.
  const installFolderCandidates =
    configuredBinaryPath === DEFAULT_CLAUDE_BINARY ? claudeInstallFolderCandidates() : [];
  if (isCommandMissing(versionResult)) {
    for (const candidate of installFolderCandidates) {
      if (!existsSync(candidate)) continue;
      binaryPath = candidate;
      versionResult = await runClaudeVersionCommand(candidate, checkedCommands);
      if (!isCommandMissing(versionResult)) break;
    }
  }
  if (isCommandMissing(versionResult)) {
    const alsoChecked =
      installFolderCandidates.length > 0
        ? ` Also checked: ${installFolderCandidates.map((candidate) => sanitizeDisplayText(candidate)).join(", ")}.`
        : "";
    return {
      installed: false,
      version: null,
      authStatus: "unknown",
      binaryPath: null,
      checkedCommands,
      message: `Claude CLI (\`${sanitizeDisplayText(configuredBinaryPath)}\`) is not installed or not on PATH.${alsoChecked}`,
    };
  }

  const binaryPathDisplay =
    binaryPath === DEFAULT_CLAUDE_BINARY ? CLAUDE_ON_PATH_DISPLAY : binaryPath;
  const version = parseVersion(`${versionResult.stdout}\n${versionResult.stderr}`);

  const authStatusJsonCommand = buildClaudeCommandInvocation(binaryPath, [
    "auth",
    "status",
    "--json",
  ]);
  checkedCommands.push(authStatusJsonCommand.display);
  const authJsonResult = await runClaudeCommand(authStatusJsonCommand);
  let parsedAuth = parseClaudeAuthStatusResult(authJsonResult);

  if (parsedAuth.unsupportedCommand) {
    const authStatusCommand = buildClaudeCommandInvocation(binaryPath, ["auth", "status"]);
    checkedCommands.push(authStatusCommand.display);
    parsedAuth = parseClaudeAuthStatusResult(await runClaudeCommand(authStatusCommand));
  }

  if (parsedAuth.authStatus !== "authenticated") {
    return {
      installed: true,
      version,
      authStatus: parsedAuth.authStatus,
      binaryPath: binaryPathDisplay,
      checkedCommands,
      message: parsedAuth.message,
      ...(parsedAuth.failureCategory !== undefined
        ? { failureCategory: parsedAuth.failureCategory }
        : {}),
      ...(parsedAuth.probeFailure === true ? { probeFailure: true as const } : {}),
    };
  }

  // The CLI's report wins; otherwise CLAUDE_CONFIG_DIR, then the default. The CLI inherits this
  // environment, so this is the directory it reads its login from.
  const configDirectory = resolveClaudeConfigDirectory(
    asRecord(parsedAuth.jsonPayload)?.["configDirectory"],
    process.env[CLAUDE_CONFIG_DIR_ENV],
  );
  const accountHint = claudeLoginAccountHint(parsedAuth.jsonPayload);
  const orgOnlyAccountEvidence = hasClaudeOrgOnlyAccountEvidence(parsedAuth.jsonPayload);
  const quota = parsedAuth.jsonPayload ? parseUsageResponse(parsedAuth.jsonPayload) : null;
  // Only a verified first-party login may name its plan; the same login answers the quota above.
  const planLabel =
    parsedAuth.claudeAiLoginVerified === true
      ? deriveClaudePlanLabel(parsedAuth.jsonPayload)
      : undefined;
  // Both successful returns are the same authenticated CLI diagnostics; only the quota evidence
  // or the no-quota message differs.
  const diagnostics = {
    installed: true,
    version,
    authStatus: "authenticated",
    binaryPath: binaryPathDisplay,
    checkedCommands,
    effectiveBinary: binaryPath,
    configDirectory,
    claudeAiLoginVerified: parsedAuth.claudeAiLoginVerified === true,
    ...(planLabel === undefined ? {} : { planLabel }),
    ...(accountHint === undefined ? {} : { accountHint }),
    ...(orgOnlyAccountEvidence ? { orgOnlyAccountEvidence: true as const } : {}),
  } satisfies AnthropicLocalDiagnostics;
  if (quota) {
    return { ...diagnostics, localQuota: quota };
  }

  return { ...diagnostics, message: CLAUDE_NO_LOCAL_QUOTA_MESSAGE };
}

export function clearAnthropicDiagnosticsCacheForTests(): void {
  anthropicOAuthInFlight.clear();
  anthropicOAuthForcedInFlight.clear();
  anthropicOAuthRecent.clear();
  anthropicOAuthPlainForm.clear();
  clearAnthropicOAuthThrottleStateForTests();
  claudeCredentialsLastGoodReads.clear();
  claudeIdentitySuccesses.clear();
}

const localDiagnosticsCacheKey = Symbol("anthropic local diagnostics");

async function getAnthropicLocalDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicLocalDiagnostics> {
  if (!options.operationCache) return await probeAnthropicLocalDiagnostics(options);
  let probes = options.operationCache.get(localDiagnosticsCacheKey) as
    | Map<string, Promise<AnthropicLocalDiagnostics>>
    | undefined;
  if (!probes) {
    probes = new Map();
    options.operationCache.set(localDiagnosticsCacheKey, probes);
  }
  const key = JSON.stringify([
    resolveAnthropicBinaryPath(options.binaryPath),
    process.env[CLAUDE_CONFIG_DIR_ENV],
  ]);
  let probe = probes.get(key);
  if (!probe) {
    probe = probeAnthropicLocalDiagnostics(options);
    probes.set(key, probe);
  }
  return await probe;
}

async function readSavedResetsForLocalQuota(
  localDiagnostics: AnthropicLocalDiagnostics,
  options: AnthropicProbeOptions,
): Promise<BankedResetAvailability | undefined> {
  try {
    const credentials = await readClaudeCliSubscriptionToken(localDiagnostics);
    if (credentials.state !== "configured") return undefined;
    const result = await queryAnthropicQuotaFromOAuthAccessToken(
      credentials.accessToken,
      options.requestTimeoutMs,
      options.forceRefresh ? options.operationCache : undefined,
      localDiagnostics.version,
      options.pollIntervalMs,
    );
    return result.state === "success" ? result.quota.saved_resets : undefined;
  } catch {
    return undefined;
  }
}

export async function getAnthropicDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicDiagnostics> {
  const localDiagnostics = await getAnthropicLocalDiagnostics(options);
  if (localDiagnostics.localQuota) {
    // Local quota stays authoritative and needs no token. Saved resets are an optional extra read
    // with the same verified-login token gate; the cache identity is derived separately from the
    // CLI login's own token or account evidence.
    const mapped = mapLocalDiagnosticsToAnthropicDiagnostics(localDiagnostics);
    const savedResets = await readSavedResetsForLocalQuota(localDiagnostics, options);
    const measured = {
      ...mapped,
      attemptOutcome: "fresh" as const,
      quotaMeasuredAtMs: Date.now(),
    };
    return savedResets && measured.quota
      ? { ...measured, quota: { ...measured.quota, saved_resets: savedResets } }
      : measured;
  }

  if (localDiagnostics.authStatus !== "authenticated") {
    return mapLocalDiagnosticsToAnthropicDiagnostics(localDiagnostics);
  }

  const credentials = await readClaudeCliSubscriptionToken(localDiagnostics);
  if (credentials.state !== "configured") {
    return {
      installed: localDiagnostics.installed,
      version: localDiagnostics.version,
      authStatus: localDiagnostics.authStatus,
      quotaSupported: false,
      quotaSource: "none",
      binaryPath: localDiagnostics.binaryPath,
      checkedCommands: localDiagnostics.checkedCommands,
      message: buildAnthropicNoQuotaDiagnosticsMessage(credentials.detail),
    };
  }

  const credentialFingerprint = fingerprintAccessToken(credentials.accessToken);
  const fallbackQuota = await queryAnthropicQuotaFromOAuthAccessToken(
    credentials.accessToken,
    options.requestTimeoutMs,
    options.forceRefresh ? options.operationCache : undefined,
    localDiagnostics.version,
    options.pollIntervalMs,
  );
  if (fallbackQuota.state !== "success") {
    return {
      installed: localDiagnostics.installed,
      version: localDiagnostics.version,
      authStatus: localDiagnostics.authStatus,
      quotaSupported: false,
      quotaSource: "none",
      oauthCredentialSource: credentials.source,
      binaryPath: localDiagnostics.binaryPath,
      checkedCommands: localDiagnostics.checkedCommands,
      message: buildAnthropicNoQuotaDiagnosticsMessage(fallbackQuota.detail),
      credentialFingerprint,
      attemptOutcome: fallbackQuota.attempt,
      ...(fallbackQuota.failureCategory !== undefined
        ? { failureCategory: fallbackQuota.failureCategory }
        : {}),
      ...(fallbackQuota.retryAtMs !== undefined ? { retryAtMs: fallbackQuota.retryAtMs } : {}),
      // Evidence only: the CLI's own expiry says the token is stale; the request is still made.
      ...(fallbackQuota.httpStatus === 401 &&
      credentials.expiresAtMs !== undefined &&
      credentials.expiresAtMs <= Date.now()
        ? { storedAccessTokenExpired: true as const }
        : {}),
    };
  }

  return {
    installed: localDiagnostics.installed,
    version: localDiagnostics.version,
    authStatus: localDiagnostics.authStatus,
    quotaSupported: true,
    quotaSource: "claude-credentials-oauth-api",
    oauthCredentialSource: credentials.source,
    binaryPath: localDiagnostics.binaryPath,
    checkedCommands: localDiagnostics.checkedCommands,
    quota: fallbackQuota.quota,
    credentialFingerprint,
    attemptOutcome: fallbackQuota.attempt,
    quotaMeasuredAtMs: fallbackQuota.measuredAtMs,
    // The plan belongs to the CLI login only when this quota came from that login's own token.
    ...(credentials.source === "claude-credentials" && localDiagnostics.planLabel !== undefined
      ? { planLabel: localDiagnostics.planLabel }
      : {}),
  };
}

export async function hasAnthropicCredentialsConfigured(
  options: AnthropicProbeOptions = {},
  availability: { treatUnverifiedAsConfigured?: boolean } = {},
): Promise<boolean> {
  try {
    const diagnostics = await getAnthropicLocalDiagnostics(options);
    if (diagnostics.installed && diagnostics.authStatus === "authenticated") return true;
    // A probe that could not report a status (timeout, unreadable output) is not a sign-out; a
    // caller that shows the error row instead of hiding the provider treats it as still configured.
    return (
      availability.treatUnverifiedAsConfigured === true &&
      diagnostics.installed &&
      diagnostics.authStatus === "unknown"
    );
  } catch {
    return availability.treatUnverifiedAsConfigured === true;
  }
}

/**
 * Identity of the Claude Agent provider's single Claude CLI login. It is account-specific:
 * the readable first-party token keys it, otherwise the CLI's own user-specific account evidence
 * (email or account/user id) does. An organization id alone is shared by its members, so it never
 * keys a scope. Without user-specific evidence, null keeps another account's last-good from being
 * reused.
 */
export async function resolveClaudeAgentAccountIdentity(params: {
  binaryPath?: string;
  operationCache?: Map<symbol, unknown>;
  onlyCurrentModel: boolean;
  runtimeDetected: boolean;
}): Promise<ResolvedAuthIdentity | null> {
  let localDiagnostics: AnthropicLocalDiagnostics;
  try {
    localDiagnostics = await getAnthropicLocalDiagnostics({
      binaryPath: params.binaryPath,
      operationCache: params.operationCache,
    });
  } catch {
    return null;
  }

  const identity = await claudeCliAccountIdentity(localDiagnostics, params.runtimeDetected);
  if (!identity) return null;
  const composition = {
    providerId: "claude-agent",
    identities: [identity],
    qualifiers: [params.onlyCurrentModel ? "only-current-model" : "all-models"],
  };
  return (
    (await composeResolvedAuthIdentities(composition)) ??
    composeProcessLocalAuthIdentities(composition)
  );
}

/**
 * The Claude CLI row's identity. A readable first-party CLI token keys it, because its quota
 * depends on that token. Otherwise the CLI's own non-secret, user-specific account evidence keys
 * it; an organization id alone is shared by every member and is never used. Without user
 * evidence, a machine-only state would outlive an account switch. On platforms without protected
 * identity storage the token is never used and only the in-memory process-local identity applies.
 */
async function claudeCliAccountIdentity(
  localDiagnostics: AnthropicLocalDiagnostics,
  claudeCodeRuntimeDetected: boolean,
): Promise<ResolvedAuthIdentity | null> {
  // A transient probe failure carries no account evidence for this cycle. Reuse the last
  // successful identity only while its credentials source is provably unchanged; otherwise this
  // cycle deliberately has no scope, so another account's last-good can never be shown.
  if (
    localDiagnostics.authStatus === "unknown" &&
    isTransientProviderFailureCategory(localDiagnostics.failureCategory)
  ) {
    return await recallClaudeIdentitySuccess();
  }

  const accountQualifiers = [
    localDiagnostics.effectiveBinary ?? "",
    claudeConfigDirectoryQualifier(localDiagnostics.configDirectory),
    // Preserve the existing cache identity for the previously non-excluded CLI login.
    "distinct",
  ] as const;
  let credentials: AnthropicCredentialsAccess | undefined;
  let credentialSignature: ClaudeCredentialFileSignature | null = null;
  if (localDiagnostics.authStatus === "authenticated") {
    // Capture the source signature before the token is read: a file rewritten during the read
    // leaves a mismatch here, so a later recall cannot attribute a new login to the old identity.
    credentialSignature = await readClaudeCredentialFileSignature(localDiagnostics.configDirectory);
    credentials = await readClaudeCliSubscriptionToken(localDiagnostics);
    if (credentials.state === "configured") {
      const protectedIdentity = await deriveResolvedAuthIdentity({
        providerId: "anthropic:claude-cli-account",
        principal: { kind: "credential", value: credentials.accessToken },
        qualifiers: accountQualifiers,
      });
      if (protectedIdentity) {
        if (credentials.storage === "file") {
          rememberClaudeIdentitySuccess(
            localDiagnostics.configDirectory,
            protectedIdentity,
            credentialSignature,
          );
        }
        return protectedIdentity;
      }
    }
  }
  // An organization id alone is shared by every member, so it can neither key a scope nor
  // authorize reusing a previous member's last-good. A readable user token above still wins.
  if (localDiagnostics.orgOnlyAccountEvidence === true) {
    forgetClaudeIdentitySuccess(localDiagnostics.configDirectory);
    return null;
  }
  // Without protected identity storage (Windows) the non-secret CLI account evidence still gives
  // an account-specific, in-memory-only scope. The token is never used for it.
  if (localDiagnostics.accountHint !== undefined) {
    const processLocalIdentity = deriveProcessLocalAuthIdentity({
      providerId: "anthropic:claude-cli-account",
      principal: { kind: "stable-id", value: localDiagnostics.accountHint },
      qualifiers: accountQualifiers,
    });
    if (processLocalIdentity) {
      if (credentials?.state === "configured" && credentials.storage === "file") {
        rememberClaudeIdentitySuccess(
          localDiagnostics.configDirectory,
          processLocalIdentity,
          credentialSignature,
        );
      }
      return processLocalIdentity;
    }
  }
  // A signed-in CLI with no account evidence this cycle cannot be attributed. Reuse the last
  // success's scope only while its credentials source is provably unchanged.
  if (
    localDiagnostics.authStatus === "authenticated" &&
    localDiagnostics.accountHint === undefined
  ) {
    const recalled = await recallClaudeIdentitySuccess();
    if (recalled) return recalled;
  }
  if (localDiagnostics.localQuota && localDiagnostics.accountHint === undefined) return null;
  return await deriveResolvedAuthIdentity({
    providerId: "anthropic:claude-cli-state",
    principal: { kind: "stable-id", value: "claude-cli-state" },
    qualifiers: [
      localDiagnostics.installed ? "installed" : "missing",
      localDiagnostics.version ?? "",
      localDiagnostics.authStatus,
      localDiagnostics.effectiveBinary ?? "",
      claudeConfigDirectoryQualifier(localDiagnostics.configDirectory),
      localDiagnostics.claudeAiLoginVerified === true ? "verified" : "unverified",
      claudeCodeRuntimeDetected ? "detected" : "undetected",
      ...(localDiagnostics.accountHint === undefined
        ? []
        : [`account:${localDiagnostics.accountHint}`]),
    ],
  });
}

export { parseOAuthUsageResponse, parseUsageResponse };
