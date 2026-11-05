/**
 * Anthropic Claude quota probing.
 *
 * Uses the local Claude CLI/runtime to detect install/auth state first. When
 * Claude auth is confirmed but local quota windows are missing, it falls back
 * to Anthropic's OAuth usage endpoint using the first usable OAuth access
 * token: OpenCode's own Anthropic login, then Claude OAuth credentials (macOS
 * Keychain first, then the local credentials file).
 */

import { execFile } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import type { ProviderFailureCategory } from "../contracts/provider-failure.js";

import { resolveAnthropicOAuthCached } from "./anthropic-auth.js";
import { sanitizeDisplaySnippet, sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";

const DEFAULT_CLAUDE_BINARY = "claude";
/** How `binaryPath` reads when the default `claude` ran from PATH. */
const CLAUDE_ON_PATH_DISPLAY = "claude (PATH)";
const CLAUDE_COMMAND_TIMEOUT_MS = 3_000;
const ANTHROPIC_OAUTH_BACKOFF_BASE_MS = 30_000;
const ANTHROPIC_OAUTH_COOLDOWN_MAX_MS = 15 * 60_000;
const ANTHROPIC_OAUTH_COOLDOWN_MAX_ENTRIES = 16;
const ANTHROPIC_OAUTH_REUSE_MS = 60_000;
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";
const CLAUDE_CODE_CREDENTIALS_SERVICE = "Claude Code-credentials";
const CLAUDE_NO_LOCAL_QUOTA_MESSAGE =
  "Claude CLI auth detected, but local quota windows were not exposed.";
const ANTHROPIC_NO_QUOTA_MESSAGE =
  "Claude CLI auth detected, but quota was unavailable from the local CLI and OAuth credential sources.";

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
  five_hour?: { percentRemaining: number; resetTimeIso?: string };
  seven_day?: { percentRemaining: number; resetTimeIso?: string };
  extra_usage?: { percentRemaining: number };
  fable_weekly?: { percentRemaining: number; resetTimeIso?: string };
}

export interface AnthropicUsageParseOptions {
  includeExtraUsage?: boolean;
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
  | "opencode-auth-oauth-api"
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
  quota?: AnthropicQuotaResult;
}

export interface AnthropicProbeOptions {
  binaryPath?: string;
  requestTimeoutMs?: number;
  /** Use the local Claude Code/Agent OAuth account, not OpenCode's Anthropic login. */
  useClaudeCodeCredentials?: boolean;
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
};

type AnthropicLocalDiagnostics = {
  installed: boolean;
  version: string | null;
  authStatus: AnthropicAuthStatus;
  binaryPath: string | null;
  checkedCommands: string[];
  message?: string;
  localQuota?: AnthropicQuotaResult;
};

type AnthropicOAuthCooldown = {
  failureCount: number;
  blockedUntilMs: number;
};

/** Which credential store provided the OAuth access token used for the usage probe. */
export type AnthropicCredentialSource = "opencode-auth" | "claude-credentials";

type AnthropicCredentialsAccess =
  | {
      state: "configured";
      accessToken: string;
      source: AnthropicCredentialSource;
    }
  | {
      state: "unavailable";
      detail?: string;
    };

type ClaudeCredentialSourceResult =
  | {
      state: "configured";
      accessToken: string;
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
    }
  | {
      state: "unavailable";
      detail?: string;
      failureKind?: "authentication";
      failureCategory?: ProviderFailureCategory;
    };

type ParsedAuthProbe = {
  authStatus: AnthropicAuthStatus;
  message?: string;
  jsonPayload?: unknown;
  unsupportedCommand?: boolean;
};

type AnthropicOAuthSharedState = {
  cooldowns: Map<string, AnthropicOAuthCooldown>;
  inFlight: Map<string, Promise<AnthropicFallbackQuota>>;
  recent: Map<string, { quota: AnthropicQuotaResult; checkedAtMs: number }>;
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
    cooldowns: new Map<string, AnthropicOAuthCooldown>(),
    inFlight: new Map<string, Promise<AnthropicFallbackQuota>>(),
    recent: new Map<string, { quota: AnthropicQuotaResult; checkedAtMs: number }>(),
  };
  Object.defineProperty(anthropicOAuthGlobal, ANTHROPIC_OAUTH_SHARED_STATE_KEY, {
    value: anthropicOAuthSharedState,
    configurable: true,
    writable: true,
  });
}

const anthropicOAuthCooldowns = anthropicOAuthSharedState.cooldowns;
const anthropicOAuthInFlight = anthropicOAuthSharedState.inFlight;
const anthropicOAuthRecent = anthropicOAuthSharedState.recent;

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

function quoteWindowsCmdArg(value: string): string {
  const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1");
  return `"${escaped}"`;
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
    return {
      file: runtime.comspec?.trim() || process.env["ComSpec"]?.trim() || "cmd.exe",
      args: ["/d", "/s", "/c", [resolvedBinaryPath, ...args].map(quoteWindowsCmdArg).join(" ")],
      display,
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

function parseUsageResponse(
  data: unknown,
  options: AnthropicUsageParseOptions = {},
): AnthropicQuotaResult | null {
  const windows = findUsageWindows(data);
  if (!windows?.fiveHour || !windows.sevenDay) return null;

  const extraUsage = options.includeExtraUsage
    ? parseExtraUsageQuota(windows.root["extra_usage"])
    : undefined;

  return {
    success: true,
    five_hour: windows.fiveHour,
    seven_day: windows.sevenDay,
    ...(extraUsage ? { extra_usage: extraUsage } : {}),
  };
}

function parseOAuthUsageResponse(data: unknown): AnthropicQuotaResult | null {
  const windows = findUsageWindows(data, { allowSupplementalOnly: true });
  if (!windows) return null;

  const extraUsage = parseExtraUsageQuota(windows.root["extra_usage"]);
  const fableWeekly = parseFableWeeklyWindow(windows.root["limits"]);
  return {
    success: true,
    ...(windows.fiveHour ? { five_hour: windows.fiveHour } : {}),
    ...(windows.sevenDay ? { seven_day: windows.sevenDay } : {}),
    ...(extraUsage ? { extra_usage: extraUsage } : {}),
    ...(fableWeekly ? { fable_weekly: fableWeekly } : {}),
  };
}

function getClaudeCredentialsPath(): string {
  return join(homedir(), ".claude", ".credentials.json");
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

function extractClaudeCredentialsAccessToken(data: unknown): string {
  const root = asRecord(data);
  if (!root) {
    return "";
  }

  for (const candidate of [asRecord(root["claudeAiOauth"]), asRecord(root["oauth"]), root]) {
    if (!candidate) {
      continue;
    }

    for (const key of ["accessToken", "access_token", "token"]) {
      const token = candidate[key];
      if (typeof token === "string" && token.trim()) {
        return token.trim();
      }
    }
  }

  return "";
}

function parseClaudeCredentialsAccessToken(
  content: string,
  options: { allowPlainText: boolean },
): { accessToken?: string; error?: string } {
  const trimmed = content.trim();
  if (!trimmed) {
    return { error: "missing" };
  }

  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return options.allowPlainText ? { accessToken: trimmed } : { error: "missing" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const accessToken = extractClaudeCredentialsAccessToken(parsed);
    return accessToken ? { accessToken } : { error: "missing" };
  } catch (error) {
    return {
      error: sanitizeDisplayText(error instanceof Error ? error.message : String(error)),
    };
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

async function readClaudeCredentialsAccessTokenFromFile(): Promise<ClaudeCredentialSourceResult> {
  const credentialsPath = getClaudeCredentialsPath();

  try {
    const content = await readFile(credentialsPath, "utf8");
    const parsed = parseClaudeCredentialsAccessToken(content, { allowPlainText: false });
    const accessToken = parsed.accessToken?.trim() ?? "";

    if (!accessToken) {
      return {
        state: "unavailable",
        detail:
          parsed.error && parsed.error !== "missing"
            ? `Could not parse Claude credentials file ${sanitizeDisplayText(credentialsPath)}: ${parsed.error}.`
            : `Claude OAuth access token missing in ${sanitizeDisplayText(credentialsPath)}.`,
      };
    }

    return {
      state: "configured",
      accessToken,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: string | number }).code
        : undefined;

    if (code === "ENOENT") {
      return {
        state: "not-found",
        location: sanitizeDisplayText(credentialsPath),
      };
    }

    return {
      state: "unavailable",
      detail: `Could not read Claude credentials file: ${sanitizeDisplayText(
        error instanceof Error ? error.message : String(error),
      )}`,
    };
  }
}

async function readClaudeOAuthAccessToken(): Promise<AnthropicCredentialsAccess> {
  const locationsChecked: string[] = [];
  const unavailableDetails: string[] = [];
  const keychainCredentials = await readClaudeCredentialsAccessTokenFromMacOSKeychain();
  if (keychainCredentials?.state === "configured") {
    return { ...keychainCredentials, source: "claude-credentials" };
  }
  if (keychainCredentials?.state === "unavailable") {
    unavailableDetails.push(keychainCredentials.detail);
  }
  if (keychainCredentials?.state === "not-found") {
    locationsChecked.push(keychainCredentials.location);
  }

  const fileCredentials = await readClaudeCredentialsAccessTokenFromFile();
  if (fileCredentials.state === "configured") {
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

async function readAnthropicOAuthAccessToken(options: {
  includeClaudeCredentials: boolean;
}): Promise<AnthropicCredentialsAccess> {
  const opencodeCredentials = await resolveAnthropicOAuthCached();
  if (opencodeCredentials.state === "configured") {
    return {
      state: "configured",
      accessToken: opencodeCredentials.accessToken,
      source: "opencode-auth",
    };
  }

  return options.includeClaudeCredentials
    ? await readClaudeOAuthAccessToken()
    : { state: "unavailable" };
}

function fingerprintAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
  }

  const retryAtMs = Date.parse(trimmed);
  const durationMs = retryAtMs - nowMs;
  return Number.isFinite(durationMs) && durationMs > 0 ? durationMs : undefined;
}

function getAnthropicOAuthCooldownDurationMs(
  failureCount: number,
  retryAfter: string | null,
  nowMs: number,
): number {
  const exponentialMs = Math.min(
    ANTHROPIC_OAUTH_COOLDOWN_MAX_MS,
    ANTHROPIC_OAUTH_BACKOFF_BASE_MS * 2 ** Math.min(failureCount, 30),
  );
  const retryAfterMs = Math.min(
    ANTHROPIC_OAUTH_COOLDOWN_MAX_MS,
    parseRetryAfterMs(retryAfter, nowMs) ?? 0,
  );
  return Math.max(exponentialMs, retryAfterMs);
}

function getAnthropicOAuthCooldownMessage(remainingMs: number): string {
  const boundedRemainingMs = Math.min(ANTHROPIC_OAUTH_COOLDOWN_MAX_MS, Math.max(0, remainingMs));
  return `Anthropic OAuth usage probe paused after HTTP 429; retry in ${Math.ceil(
    boundedRemainingMs / 1_000,
  )}s.`;
}

function retainAnthropicOAuthCooldownForToken(tokenFingerprint: string): void {
  const targetSize = anthropicOAuthCooldowns.has(tokenFingerprint)
    ? ANTHROPIC_OAUTH_COOLDOWN_MAX_ENTRIES
    : ANTHROPIC_OAUTH_COOLDOWN_MAX_ENTRIES - 1;
  const oldestFirst = [...anthropicOAuthCooldowns.entries()].sort(
    ([, left], [, right]) => left.blockedUntilMs - right.blockedUntilMs,
  );
  for (const [fingerprint] of oldestFirst) {
    if (anthropicOAuthCooldowns.size <= targetSize) break;
    if (fingerprint !== tokenFingerprint) anthropicOAuthCooldowns.delete(fingerprint);
  }
}

function rememberAnthropicOAuthQuota(tokenFingerprint: string, quota: AnthropicQuotaResult): void {
  const nowMs = Date.now();
  for (const [fingerprint, entry] of anthropicOAuthRecent) {
    if (nowMs - entry.checkedAtMs >= ANTHROPIC_OAUTH_REUSE_MS) {
      anthropicOAuthRecent.delete(fingerprint);
    }
  }
  anthropicOAuthRecent.set(tokenFingerprint, { quota, checkedAtMs: nowMs });
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

async function performAnthropicOAuthUsageRequest(
  accessToken: string,
  tokenFingerprint: string,
  requestTimeoutMs?: number,
): Promise<AnthropicFallbackQuota> {
  try {
    return await fetchWithTimeout(ANTHROPIC_USAGE_URL, {
      request: {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": ANTHROPIC_BETA_HEADER,
        },
      },
      timeoutMs: requestTimeoutMs,
      consume: async (response, timeoutSignal): Promise<AnthropicFallbackQuota> => {
        if (response.status === 429) {
          const nowMs = Date.now();
          const previousFailureCount =
            anthropicOAuthCooldowns.get(tokenFingerprint)?.failureCount ?? 0;
          const durationMs = getAnthropicOAuthCooldownDurationMs(
            previousFailureCount,
            response.headers?.get?.("Retry-After") ?? null,
            nowMs,
          );
          anthropicOAuthCooldowns.set(tokenFingerprint, {
            failureCount: previousFailureCount + 1,
            blockedUntilMs: nowMs + durationMs,
          });

          let detail = "";
          try {
            detail = sanitizeAnthropicApiDetail(await response.text(), accessToken);
          } catch (error) {
            if (timeoutSignal.aborted) throw error;
            detail = "";
          }

          const errorDetail = detail
            ? `Anthropic API error ${response.status}: ${detail}`
            : `Anthropic API returned ${response.status}`;
          return {
            state: "unavailable",
            detail: `${errorDetail} ${getAnthropicOAuthCooldownMessage(durationMs)}`,
            failureCategory: "provider_api",
          };
        }

        anthropicOAuthCooldowns.delete(tokenFingerprint);

        if (!response.ok) {
          const authenticationFailure = response.status === 401 || response.status === 403;
          let detail = "";
          try {
            detail = sanitizeAnthropicApiDetail(await response.text(), accessToken);
          } catch (error) {
            if (timeoutSignal.aborted && !authenticationFailure) throw error;
            detail = "";
          }

          return {
            state: "unavailable",
            detail: detail
              ? `Anthropic API error ${response.status}: ${detail}`
              : `Anthropic API returned ${response.status}`,
            ...(authenticationFailure ? { failureKind: "authentication" as const } : {}),
            failureCategory: authenticationFailure ? "credentials" : "provider_api",
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
          };
        }

        const quota = parseOAuthUsageResponse(data);
        if (!quota) {
          return {
            state: "unavailable",
            detail: "Unexpected Anthropic quota response shape",
            failureCategory: "provider_api",
          };
        }

        return {
          state: "success",
          quota,
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
    };
  }
}

async function queryAnthropicQuotaFromOAuthAccessToken(
  accessToken: string,
  requestTimeoutMs?: number,
): Promise<AnthropicFallbackQuota> {
  const tokenFingerprint = fingerprintAccessToken(accessToken);
  retainAnthropicOAuthCooldownForToken(tokenFingerprint);

  const nowMs = Date.now();
  const cooldown = anthropicOAuthCooldowns.get(tokenFingerprint);
  if (cooldown && cooldown.blockedUntilMs > nowMs) {
    return {
      state: "unavailable",
      detail: getAnthropicOAuthCooldownMessage(cooldown.blockedUntilMs - nowMs),
      failureCategory: "provider_api",
    };
  }

  const recent = anthropicOAuthRecent.get(tokenFingerprint);
  if (
    recent &&
    nowMs >= recent.checkedAtMs &&
    nowMs - recent.checkedAtMs < ANTHROPIC_OAUTH_REUSE_MS
  ) {
    return { state: "success", quota: recent.quota };
  }

  const existingInFlight = anthropicOAuthInFlight.get(tokenFingerprint);
  if (existingInFlight) {
    return await existingInFlight;
  }

  const inFlight = performAnthropicOAuthUsageRequest(
    accessToken,
    tokenFingerprint,
    requestTimeoutMs,
  ).then((result) => {
    if (result.state === "success") {
      rememberAnthropicOAuthQuota(tokenFingerprint, result.quota);
    }
    return result;
  });
  anthropicOAuthInFlight.set(tokenFingerprint, inFlight);

  try {
    return await inFlight;
  } finally {
    if (anthropicOAuthInFlight.get(tokenFingerprint) === inFlight) {
      anthropicOAuthInFlight.delete(tokenFingerprint);
    }
  }
}

export async function queryAnthropicQuotaWithOAuth(
  accessToken: string,
  requestTimeoutMs?: number,
): Promise<AnthropicResult> {
  const result = await queryAnthropicQuotaFromOAuthAccessToken(accessToken, requestTimeoutMs);
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

  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const payload = JSON.parse(trimmed) as unknown;
      const auth = extractAuthBoolean(payload);

      if (auth === true) {
        return {
          authStatus: "authenticated",
          jsonPayload: payload,
        };
      }

      if (auth === false) {
        return {
          authStatus: "unauthenticated",
          message: "Claude is not authenticated. Run `claude auth login` and try again.",
          jsonPayload: payload,
        };
      }

      return {
        authStatus: "unknown",
        message: "Could not verify Claude authentication status from JSON output.",
        jsonPayload: payload,
      };
    } catch {
      // Fall through to exit-code-based handling.
    }
  }

  if (result.code === 0) {
    return { authStatus: "authenticated" };
  }

  if (result.timedOut) {
    return {
      authStatus: "unknown",
      message: "Timed out while running Claude CLI auth status.",
    };
  }

  const detail = detailFromCommandResult(result);
  return {
    authStatus: "unknown",
    message: detail
      ? `Could not verify Claude authentication status. ${detail}`
      : "Could not verify Claude authentication status.",
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
    };
  }

  const quota = parsedAuth.jsonPayload ? parseUsageResponse(parsedAuth.jsonPayload) : null;
  if (quota) {
    return {
      installed: true,
      version,
      authStatus: "authenticated",
      binaryPath: binaryPathDisplay,
      checkedCommands,
      localQuota: quota,
    };
  }

  return {
    installed: true,
    version,
    authStatus: "authenticated",
    binaryPath: binaryPathDisplay,
    checkedCommands,
    message: CLAUDE_NO_LOCAL_QUOTA_MESSAGE,
  };
}

export function clearAnthropicDiagnosticsCacheForTests(): void {
  anthropicOAuthCooldowns.clear();
  anthropicOAuthInFlight.clear();
  anthropicOAuthRecent.clear();
}

async function getAnthropicLocalDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicLocalDiagnostics> {
  return await probeAnthropicLocalDiagnostics(options);
}

export async function getAnthropicDiagnostics(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicDiagnostics> {
  const localDiagnostics = await getAnthropicLocalDiagnostics(options);
  if (localDiagnostics.localQuota) {
    return mapLocalDiagnosticsToAnthropicDiagnostics(localDiagnostics);
  }

  if (options.useClaudeCodeCredentials && localDiagnostics.authStatus !== "authenticated") {
    return mapLocalDiagnosticsToAnthropicDiagnostics(localDiagnostics);
  }

  let credentials = options.useClaudeCodeCredentials
    ? await readClaudeOAuthAccessToken()
    : await readAnthropicOAuthAccessToken({
        includeClaudeCredentials: localDiagnostics.authStatus === "authenticated",
      });
  if (credentials.state !== "configured") {
    if (localDiagnostics.authStatus !== "authenticated") {
      return mapLocalDiagnosticsToAnthropicDiagnostics(localDiagnostics);
    }

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

  let fallbackQuota = await queryAnthropicQuotaFromOAuthAccessToken(
    credentials.accessToken,
    options.requestTimeoutMs,
  );
  if (
    fallbackQuota.state === "unavailable" &&
    fallbackQuota.failureKind === "authentication" &&
    credentials.source === "opencode-auth" &&
    localDiagnostics.authStatus === "authenticated"
  ) {
    const claudeCredentials = await readClaudeOAuthAccessToken();
    if (claudeCredentials.state === "configured") {
      credentials = claudeCredentials;
      fallbackQuota = await queryAnthropicQuotaFromOAuthAccessToken(
        claudeCredentials.accessToken,
        options.requestTimeoutMs,
      );
    }
  }
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
      ...(fallbackQuota.failureCategory !== undefined
        ? { failureCategory: fallbackQuota.failureCategory }
        : {}),
    };
  }

  return {
    installed: localDiagnostics.installed,
    version: localDiagnostics.version,
    authStatus: localDiagnostics.authStatus,
    quotaSupported: true,
    quotaSource:
      credentials.source === "opencode-auth"
        ? "opencode-auth-oauth-api"
        : "claude-credentials-oauth-api",
    oauthCredentialSource: credentials.source,
    binaryPath: localDiagnostics.binaryPath,
    checkedCommands: localDiagnostics.checkedCommands,
    quota: fallbackQuota.quota,
  };
}

export async function hasAnthropicCredentialsConfigured(
  options: AnthropicProbeOptions = {},
): Promise<boolean> {
  if (!options.useClaudeCodeCredentials) {
    try {
      const opencodeCredentials = await resolveAnthropicOAuthCached();
      // A login OpenCode could not return still counts, so it shows as an error.
      if (opencodeCredentials.state === "configured" || opencodeCredentials.state === "failed") {
        return true;
      }
    } catch {
      // Fall back to the existing local Claude CLI probe.
    }
  }

  try {
    const diagnostics = await getAnthropicLocalDiagnostics(options);
    return diagnostics.installed && diagnostics.authStatus === "authenticated";
  } catch {
    return false;
  }
}

export async function resolveAnthropicAuthIdentity(
  options: AnthropicProbeOptions = {},
): Promise<ResolvedAuthIdentity | null> {
  let localDiagnostics: AnthropicLocalDiagnostics;
  try {
    localDiagnostics = await getAnthropicLocalDiagnostics(options);
  } catch {
    return null;
  }

  // Claude CLI quota does not expose an account identity. Keep that winning
  // path process-local rather than risking reuse after a CLI account switch.
  if (localDiagnostics.localQuota) return null;

  const opencodeCredentials = await resolveAnthropicOAuthCached();
  const opencodeIdentity =
    opencodeCredentials.state === "configured"
      ? await deriveResolvedAuthIdentity({
          providerId: "anthropic:opencode-auth",
          principal: { kind: "credential", value: opencodeCredentials.accessToken },
        })
      : null;

  if (localDiagnostics.authStatus !== "authenticated") {
    return opencodeIdentity;
  }

  const claudeCredentials = await readClaudeOAuthAccessToken();
  const claudeIdentity =
    claudeCredentials.state === "configured"
      ? await deriveResolvedAuthIdentity({
          providerId: "anthropic:claude-credentials",
          principal: { kind: "credential", value: claudeCredentials.accessToken },
        })
      : null;

  if (opencodeIdentity && claudeIdentity) {
    return composeResolvedAuthIdentities({
      providerId: "anthropic",
      identities: [opencodeIdentity, claudeIdentity],
    });
  }

  return opencodeIdentity ?? claudeIdentity;
}

export async function queryAnthropicQuota(
  options: AnthropicProbeOptions = {},
): Promise<AnthropicResult> {
  try {
    const diagnostics = await getAnthropicDiagnostics(options);
    if (diagnostics.quotaSupported) {
      return diagnostics.quota ?? null;
    }

    if (
      (diagnostics.authStatus === "authenticated" ||
        diagnostics.oauthCredentialSource !== undefined) &&
      diagnostics.message
    ) {
      return {
        success: false,
        error: diagnostics.message,
        ...(diagnostics.failureCategory !== undefined
          ? { failureCategory: diagnostics.failureCategory }
          : {}),
      };
    }

    return null;
  } catch (err) {
    return {
      success: false,
      error: `Claude CLI probe failed: ${sanitizeDisplayText(
        err instanceof Error ? err.message : String(err),
      )}`,
    };
  }
}

export { parseOAuthUsageResponse, parseUsageResponse };
