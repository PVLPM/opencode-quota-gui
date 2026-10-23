/**
 * OpenAI (ChatGPT) quota fetcher
 *
 * Uses OpenCode's opencode.db native OpenCode OAuth entries and queries:
 * https://chatgpt.com/backend-api/wham/usage
 */

import type { BankedResetAvailability, BankedResetCredit } from "../contracts/openai-quota.js";
import { sanitizeDisplayText, sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import type { FixedWindowProjectionEvidence } from "./entries.js";
import { clampPercent } from "./format-utils.js";
import { fetchWithTimeout } from "./http.js";
import { readAuthFileCached } from "./opencode-auth.js";
import { deriveResolvedAuthIdentity, type ResolvedAuthIdentity } from "./resolved-auth-identity.js";
import type { AuthData, OpenAIOAuthData, QuotaError } from "./types.js";

interface OpenAIUsageResponse {
  plan_type: string;
  rate_limit: {
    limit_reached: boolean;
    primary_window?: unknown;
    secondary_window?: unknown;
  } | null;
  code_review_rate_limit?: {
    primary_window?: unknown;
  } | null;
  spend_control?: {
    individual_limit?: unknown;
  } | null;
  credits?: {
    has_credits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  rate_limit_reset_credits?: {
    available_count?: unknown;
  } | null;
}

interface JwtPayload {
  "https://api.openai.com/profile"?: {
    email?: string;
  };
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

function base64UrlDecode(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(padLen);
  return Buffer.from(padded, "base64").toString("utf8");
}

function parseJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(base64UrlDecode(parts[1])) as JwtPayload;
  } catch {
    return null;
  }
}

function getEmailFromJwt(token: string): string | null {
  return parseJwt(token)?.["https://api.openai.com/profile"]?.email ?? null;
}

function getAccountIdFromJwt(token: string): string | null {
  return parseJwt(token)?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
}

type OpenAIWindowKind = "hourly" | "weekly" | "monthly";

type OpenAIWindowValue = {
  percentRemaining: number;
  resetTimeIso?: string;
  fixedWindow?: FixedWindowProjectionEvidence;
};

const WINDOW_KIND_BY_DURATION: Readonly<Record<number, OpenAIWindowKind>> = {
  18000: "hourly",
  604800: "weekly",
  2628000: "monthly",
};

function isoFromMilliseconds(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;

  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function resetIsoFromNowSeconds(seconds: unknown, observedAtMs: number): string | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined;
  }
  return isoFromMilliseconds(observedAtMs + Math.round(seconds * 1000));
}

function resetIsoFromResetAt(resetAt: unknown): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) {
    return undefined;
  }
  return isoFromMilliseconds(Math.round(resetAt * 1000));
}

function parseWindowValue(window: unknown, observedAtMs: number): OpenAIWindowValue | null {
  if (!window || typeof window !== "object") return null;

  const value = window as Record<string, unknown>;
  if (typeof value.used_percent !== "number" || !Number.isFinite(value.used_percent)) {
    return null;
  }

  return {
    percentRemaining: clampPercent(100 - value.used_percent),
    resetTimeIso:
      resetIsoFromResetAt(value.reset_at) ??
      resetIsoFromNowSeconds(value.reset_after_seconds, observedAtMs),
  };
}

function parseRemainingWindowValue(
  window: unknown,
  observedAtMs: number,
): OpenAIWindowValue | null {
  if (!window || typeof window !== "object") return null;

  const value = window as Record<string, unknown>;
  if (typeof value.remaining_percent !== "number" || !Number.isFinite(value.remaining_percent)) {
    return null;
  }

  return {
    percentRemaining: clampPercent(value.remaining_percent),
    resetTimeIso:
      resetIsoFromResetAt(value.reset_at) ??
      resetIsoFromNowSeconds(value.reset_after_seconds, observedAtMs),
  };
}

function parseRateLimitWindow(
  window: unknown,
  observedAtMs: number,
): { kind: OpenAIWindowKind; value: OpenAIWindowValue } | null {
  if (!window || typeof window !== "object") return null;

  const raw = window as Record<string, unknown>;
  if (typeof raw.limit_window_seconds !== "number" || !Number.isFinite(raw.limit_window_seconds)) {
    return null;
  }

  const kind = WINDOW_KIND_BY_DURATION[raw.limit_window_seconds];
  if (!kind) return null;

  const value = parseWindowValue(window, observedAtMs);
  if (!value) return null;

  const endsAtMs = value.resetTimeIso ? Date.parse(value.resetTimeIso) : Number.NaN;
  const startedAtMs = endsAtMs - raw.limit_window_seconds * 1000;
  if (Number.isFinite(startedAtMs) && startedAtMs < observedAtMs && observedAtMs < endsAtMs) {
    value.fixedWindow = {
      kind: "fixed_window",
      startedAtIso: new Date(startedAtMs).toISOString(),
      observedAtIso: new Date(observedAtMs).toISOString(),
      endsAtIso: new Date(endsAtMs).toISOString(),
      fullReset: true,
    };
  }
  return { kind, value };
}

function derivePlanLabel(planType: string | undefined): string {
  const normalized = (planType ?? "").trim().toLowerCase();
  if (normalized === "team" || normalized === "business") return "OpenAI (Business)";
  if (normalized.includes("pro")) return "OpenAI (Pro)";
  if (normalized.includes("plus")) return "OpenAI (Plus)";
  if (planType) return `OpenAI (${planType})`;
  return "OpenAI";
}

const OPENAI_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS = 5_000;
// Not `opencode`: in OpenCode 2 its OAuth entry is the Console login, which
// authorizes Console APIs, not OpenAI.
export const OPENAI_AUTH_SOURCE_KEYS = ["openai", "codex", "chatgpt"] as const;

export type OpenAIAuthSourceKey = (typeof OPENAI_AUTH_SOURCE_KEYS)[number];

export type OpenAIResult =
  | {
      success: true;
      label: string;
      email?: string;
      windows: {
        hourly?: OpenAIWindowValue;
        weekly?: OpenAIWindowValue;
        monthly?: OpenAIWindowValue;
        codeReview?: OpenAIWindowValue;
      };
      credits?: {
        hasCredits: boolean;
        unlimited: boolean;
        balance: string | null;
      };
      /** Summary count is always authoritative; expiry records are best-effort. */
      bankedResets?: BankedResetAvailability;
    }
  | QuotaError
  | null;

export type ResolvedOpenAIOAuth =
  | { state: "none" }
  | { state: "failed"; sourceKey: OpenAIAuthSourceKey; error: string }
  | {
      state: "configured";
      sourceKey: OpenAIAuthSourceKey;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      email?: string;
      accountId?: string;
    };

function getOpenAIOAuthEntry(
  auth: AuthData | null | undefined,
): { sourceKey: OpenAIAuthSourceKey; entry: OpenAIOAuthData; accessToken: string } | null {
  for (const sourceKey of OPENAI_AUTH_SOURCE_KEYS) {
    const entry = auth?.[sourceKey];
    if (!entry || entry.type !== "oauth") {
      continue;
    }

    const accessToken = typeof entry.access === "string" ? entry.access.trim() : "";
    if (accessToken || entry.resolveError !== undefined) {
      return { sourceKey, entry, accessToken };
    }
  }

  return null;
}

export function resolveOpenAIOAuth(auth: AuthData | null | undefined): ResolvedOpenAIOAuth {
  const resolved = getOpenAIOAuthEntry(auth);
  if (!resolved) {
    return { state: "none" };
  }
  if (resolved.entry.resolveError !== undefined) {
    return { state: "failed", sourceKey: resolved.sourceKey, error: resolved.entry.resolveError };
  }

  const email = getEmailFromJwt(resolved.accessToken) ?? undefined;
  const accountId =
    getAccountIdFromJwt(resolved.accessToken) ?? resolved.entry.accountId ?? undefined;

  return {
    state: "configured",
    sourceKey: resolved.sourceKey,
    accessToken: resolved.accessToken,
    refreshToken:
      typeof resolved.entry.refresh === "string" && resolved.entry.refresh.trim()
        ? resolved.entry.refresh
        : undefined,
    expiresAt: typeof resolved.entry.expires === "number" ? resolved.entry.expires : undefined,
    email,
    accountId,
  };
}

export function hasOpenAIOAuth(auth: AuthData | null | undefined): boolean {
  return resolveOpenAIOAuth(auth).state !== "none";
}

export async function resolveOpenAIAuthIdentity(params?: {
  maxAgeMs?: number;
}): Promise<ResolvedAuthIdentity | null> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS),
    integrationIds: OPENAI_AUTH_SOURCE_KEYS,
  });
  const resolved = resolveOpenAIOAuth(auth);
  if (resolved.state !== "configured") return null;

  if (resolved.accountId) {
    return deriveResolvedAuthIdentity({
      providerId: "openai",
      principal: { kind: "stable-id", value: resolved.accountId },
    });
  }
  const credential = resolved.refreshToken ?? resolved.accessToken;
  return deriveResolvedAuthIdentity({
    providerId: "openai",
    principal: { kind: "credential", value: credential },
  });
}

export async function hasOpenAIOAuthCached(params?: { maxAgeMs?: number }): Promise<boolean> {
  const auth = await readAuthFileCached({
    maxAgeMs: Math.max(0, params?.maxAgeMs ?? DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS),
    integrationIds: OPENAI_AUTH_SOURCE_KEYS,
  });
  return hasOpenAIOAuth(auth);
}

/** A login label that can go into a shell command unquoted and is not read as an option. */
const SHELL_SAFE_LOGIN_LABEL = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/u;
/** OpenAI's error codes are short snake_case words, e.g. `no_matching_rule`. */
const OPENAI_ERROR_CODE = /^[A-Za-z0-9_.-]{1,64}$/u;

/**
 * Only OpenAI's short error code, never the free-text body, which can echo
 * account details.
 */
async function readOpenAIErrorCode(resp: Response): Promise<string | undefined> {
  try {
    const body = (await resp.json()) as { error?: { code?: unknown } } | null;
    const code = body?.error?.code;
    return typeof code === "string" && OPENAI_ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function parseAvailableResetCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** `null` is an explicit no-expiry; any invalid/missing value stays unknown. */
function parseResetCreditExpiry(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parsedMs = Date.parse(value);
  return Number.isFinite(parsedMs) ? new Date(parsedMs).toISOString() : undefined;
}

/**
 * Only `status === "available"` records establish availability, and every
 * record is reduced to presentation-safe title/expiry data. Unknown/redeeming/
 * redeemed statuses and provider ids/descriptions never reach the DTO.
 */
function parseAvailableResetCredits(payload: unknown): BankedResetCredit[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rawCredits = (payload as Record<string, unknown>).credits;
  if (!Array.isArray(rawCredits)) return [];

  const credits: BankedResetCredit[] = [];
  for (const raw of rawCredits) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    if (record.status !== "available") continue;

    const credit: BankedResetCredit = {};
    if (typeof record.title === "string") {
      const title = sanitizeSingleLineDisplayText(record.title);
      if (title) credit.title = title;
    }
    const expiresAtIso = parseResetCreditExpiry(record.expires_at);
    if (expiresAtIso !== undefined) credit.expiresAtIso = expiresAtIso;
    credits.push(credit);
  }

  const rank = (credit: BankedResetCredit): number =>
    credit.expiresAtIso === undefined
      ? Number.POSITIVE_INFINITY
      : credit.expiresAtIso === null
        ? Number.MAX_SAFE_INTEGER
        : Date.parse(credit.expiresAtIso);
  return credits.sort((left, right) => rank(left) - rank(right));
}

/** Detail failures degrade to no known expiry metadata; ordinary data stays. */
async function fetchOpenAIResetCredits(
  headers: Record<string, string>,
  timeoutMs: number | undefined,
): Promise<BankedResetCredit[]> {
  try {
    return await fetchWithTimeout(OPENAI_RESET_CREDITS_URL, {
      request: { headers },
      timeoutMs,
      consume: async (resp) => {
        if (!resp.ok) return [];
        try {
          return parseAvailableResetCredits(await resp.json());
        } catch {
          return [];
        }
      },
    });
  } catch {
    return [];
  }
}

export async function queryOpenAIQuota(
  options: {
    requestTimeoutMs?: number;
    auth?: ResolvedOpenAIOAuth;
    loginLabel?: string;
    /** Dashboard-only: request optional expiry details when visibility is ON. */
    includeResetDetails?: boolean;
  } = {},
): Promise<OpenAIResult> {
  const resolvedAuth =
    options.auth ??
    resolveOpenAIOAuth(
      await readAuthFileCached({
        maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
        integrationIds: OPENAI_AUTH_SOURCE_KEYS,
      }),
    );
  if (resolvedAuth.state === "failed") {
    // Signing in again leaves a broken login with another label in place
    // (#316), so name the command that removes it when the label is known.
    // Not trimmed: " Work " is a different login than "Work".
    const label = options.loginLabel;
    const fix =
      label && SHELL_SAFE_LOGIN_LABEL.test(label)
        ? `Run \`opencode auth logout ${resolvedAuth.sourceKey} ${label}\`, then \`opencode auth login openai\`.`
        : "Run `opencode auth login openai`.";
    return {
      success: false,
      error: `OpenAI sign-in could not be refreshed: ${resolvedAuth.error}. ${fix}`,
    };
  }
  if (resolvedAuth.state !== "configured") return null;

  if (resolvedAuth.expiresAt && resolvedAuth.expiresAt < Date.now()) {
    return { success: false, error: "Token expired" };
  }

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${resolvedAuth.accessToken}`,
      "User-Agent": "opencode-quota-gui/1.0",
    };

    const accountId = resolvedAuth.accountId;
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    const result = await fetchWithTimeout(OPENAI_USAGE_URL, {
      request: { headers },
      timeoutMs: options.requestTimeoutMs,
      consume: async (resp): Promise<OpenAIResult> => {
        if (!resp.ok) {
          const code = await readOpenAIErrorCode(resp);
          return {
            success: false,
            error: `OpenAI API error ${resp.status}${code ? ` (${code})` : ""}`,
          };
        }

        const data = (await resp.json()) as OpenAIUsageResponse;
        const observedAtMs = Date.now();
        const primary = parseRateLimitWindow(data.rate_limit?.primary_window, observedAtMs);
        const secondary = parseRateLimitWindow(data.rate_limit?.secondary_window, observedAtMs);
        const individualLimit = parseRemainingWindowValue(
          data.spend_control?.individual_limit,
          observedAtMs,
        );
        const codeReview = parseWindowValue(
          data.code_review_rate_limit?.primary_window,
          observedAtMs,
        );
        const credits = data.credits ?? null;
        const windows: {
          hourly?: OpenAIWindowValue;
          weekly?: OpenAIWindowValue;
          monthly?: OpenAIWindowValue;
          codeReview?: OpenAIWindowValue;
        } = {};

        const conflictingKinds = new Set<OpenAIWindowKind>();
        for (const parsed of [primary, secondary]) {
          if (!parsed || conflictingKinds.has(parsed.kind)) continue;

          const existing = windows[parsed.kind];
          if (!existing) {
            windows[parsed.kind] = parsed.value;
          } else if (
            existing.percentRemaining !== parsed.value.percentRemaining ||
            existing.resetTimeIso !== parsed.value.resetTimeIso
          ) {
            delete windows[parsed.kind];
            conflictingKinds.add(parsed.kind);
          }
        }
        if (!windows.monthly && individualLimit) windows.monthly = individualLimit;
        if (codeReview) windows.codeReview = codeReview;

        const availableResetCount = parseAvailableResetCount(
          data.rate_limit_reset_credits?.available_count,
        );
        const mappedCredits = credits
          ? {
              hasCredits: Boolean(credits.has_credits),
              unlimited: Boolean(credits.unlimited),
              balance: credits.balance ?? null,
            }
          : undefined;
        const positiveCredits =
          mappedCredits !== undefined &&
          (mappedCredits.unlimited ||
            (typeof mappedCredits.balance === "string" &&
              Number.isFinite(Number(mappedCredits.balance)) &&
              Number(mappedCredits.balance) > 0));

        // Empty bodies stay invalid; a useful Credits-only/reset-count-only
        // payload is a real measurement even without a percent window.
        if (Object.keys(windows).length === 0 && !positiveCredits && availableResetCount === null) {
          return { success: false, error: "No quota data" };
        }

        return {
          success: true,
          label: derivePlanLabel(data.plan_type),
          email: resolvedAuth.email,
          windows,
          credits: mappedCredits,
          ...(availableResetCount !== null
            ? { bankedResets: { availableCount: availableResetCount, credits: [] } }
            : {}),
        };
      },
    });

    if (!result || !result.success || !result.bankedResets || !options.includeResetDetails) {
      return result;
    }
    result.bankedResets.credits = await fetchOpenAIResetCredits(headers, options.requestTimeoutMs);
    return result;
  } catch (err) {
    return {
      success: false,
      error: sanitizeDisplayText(err instanceof Error ? err.message : String(err)),
    };
  }
}
