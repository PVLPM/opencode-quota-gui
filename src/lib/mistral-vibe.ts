/**
 * Mistral Vibe subscription billing reads.
 *
 * Two documented platform endpoints describe one Mistral account:
 *
 * - `GET /v1/billing/budget` reports the Vibe budget (the subscription
 *   allowance) and, when the account has pay-as-you-go billing, the API budget;
 * - `GET /v1/billing/subscription` reports the plan label and PAYG flags.
 *
 * A budget object carries `usage_percentage`, `initial_budget`, `currency`,
 * `reset_at` and `payg_enabled`. It carries no absolute used value and no period
 * start, so `used` is derived locally from the two reported facts.
 *
 * This module performs no caching and starts no timer; the provider registry
 * collector owns the cadence. It never logs, returns or embeds the credential in
 * an error.
 */
import type { ProviderFailureCategory } from "../contracts/provider-failure.js";
import { providerFailureCategoryForHttpStatus } from "../contracts/provider-failure.js";
import { fetchWithTimeout } from "./http.js";
import { scrubCredentialErrorText } from "./opencode-auth.js";

export const MISTRAL_VIBE_API_BASE_URL = "https://api.mistral.ai";
export const MISTRAL_VIBE_BUDGET_URL = `${MISTRAL_VIBE_API_BASE_URL}/v1/billing/budget`;
export const MISTRAL_VIBE_SUBSCRIPTION_URL = `${MISTRAL_VIBE_API_BASE_URL}/v1/billing/subscription`;

/**
 * The official Vibe CLI allows 3 seconds for these billing reads; a longer
 * default would only delay the quota cycle when the platform is unreachable.
 */
export const MISTRAL_VIBE_REQUEST_TIMEOUT_MS = 3_000;

/** Highest accepted plan label length, so an unexpected body cannot flood a card. */
const PLAN_LABEL_MAX_LENGTH = 32;

const USER_AGENT = "opencode-quota-gui/1.0";

/** Credential kinds for the exact 401 reply. */
export const MISTRAL_VIBE_UNAUTHORIZED_MESSAGE =
  "Mistral rejected this credential (HTTP 401). Update MISTRAL_API_KEY.";

/**
 * The platform's exact authorization error: reading organisation inference
 * usage requires the `see_org_inference_usage` permission, which a personal
 * credential does not have by default.
 */
export const MISTRAL_VIBE_FORBIDDEN_MESSAGE =
  "Mistral denied access to this account usage (HTTP 403): the credential is missing the see_org_inference_usage permission.";

export const MISTRAL_VIBE_BILLING_UNAVAILABLE_MESSAGE =
  "Mistral has no billing API for this platform or account (HTTP 404).";

/** Plan names the platform reports, mapped to the label users see. */
const PLAN_LABELS: Readonly<Record<string, string>> = {
  FREE: "Free",
  INDIVIDUAL: "Pro",
  EDU: "Edu",
  TEAM: "Team",
};

/** One parsed budget object: the reported facts only. */
export interface MistralVibeBudget {
  /** Reported usage as a percentage of the budget. */
  usagePercentage: number;
  /** Reported allowance for the period. */
  initialBudget: number;
  /** Reported ISO 4217 code, or null when the platform reports none. */
  currency: string | null;
  /** Reported period reset (`reset_at`), when it is a valid timestamp. */
  resetTimeIso?: string;
  paygEnabled: boolean;
}

export interface MistralVibeSubscription {
  /** Display plan label ("Pro" for INDIVIDUAL); never an identity input. */
  planLabel?: string;
  /** Raw plan name as reported, kept only for safe diagnostics. */
  planName?: string;
  paygEnabled: boolean;
  vibePaygEnabled: boolean;
  enterprise: boolean;
}

export type MistralVibeQuotaResult =
  | {
      success: true;
      /** Source observation time; every row of this account uses it. */
      observedAtIso: string;
      /** The subscription allowance. Absent when the platform reports none. */
      vibeBudget?: MistralVibeBudget;
      /** The pay-as-you-go API budget. Absent unless PAYG is enabled. */
      apiBudget?: MistralVibeBudget;
      subscription?: MistralVibeSubscription;
    }
  | {
      success: false;
      error: string;
      failureCategory?: ProviderFailureCategory;
      httpStatus?: number;
    };

type JsonResponse =
  | { ok: true; body: unknown }
  | { ok: false; status: number }
  | { ok: false; invalidJson: true; status: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Normalize a reported timestamp to ISO-8601, or drop it when it is unparsable. */
function isoOrUndefined(value: unknown): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Read one budget object. `currency` may legitimately be null; `null` is kept as
 * a fact instead of defaulting to a currency the platform did not report.
 */
export function parseMistralVibeBudget(payload: unknown): MistralVibeBudget | undefined {
  if (!isRecord(payload)) return undefined;
  const usagePercentage = finiteNumber(payload.usage_percentage);
  const initialBudget = finiteNumber(payload.initial_budget);
  if (usagePercentage === undefined || initialBudget === undefined) return undefined;

  const currency = nonEmptyString(payload.currency);
  const resetTimeIso = isoOrUndefined(payload.reset_at);
  return {
    usagePercentage,
    initialBudget,
    currency: currency ?? null,
    ...(resetTimeIso ? { resetTimeIso } : {}),
    paygEnabled: payload.payg_enabled === true,
  };
}

export function parseMistralVibeSubscription(
  payload: unknown,
): MistralVibeSubscription | undefined {
  if (!isRecord(payload)) return undefined;
  const planName = nonEmptyString(payload.plan_name);
  const planLabel = planName ? PLAN_LABELS[planName] : undefined;
  return {
    ...(planLabel ? { planLabel } : {}),
    ...(planName ? { planName: planName.slice(0, PLAN_LABEL_MAX_LENGTH) } : {}),
    paygEnabled: payload.payg_enabled === true,
    vibePaygEnabled: payload.vibe_payg_enabled === true,
    enterprise: payload.enterprise === true,
  };
}

async function getJson(params: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn?: typeof fetch;
}): Promise<JsonResponse> {
  return await fetchWithTimeout(params.url, {
    request: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    timeoutMs: params.timeoutMs,
    ...(params.fetchFn ? { fetchFn: params.fetchFn } : {}),
    consume: async (response) => {
      if (!response.ok) return { ok: false as const, status: response.status };
      try {
        return { ok: true as const, body: await response.json() };
      } catch {
        return { invalidJson: true as const, ok: false as const, status: response.status };
      }
    },
  });
}

/** The exact user-facing failure for one rejected budget read. */
function budgetFailure(response: Exclude<JsonResponse, { ok: true }>): MistralVibeQuotaResult {
  if ("invalidJson" in response) {
    return {
      success: false,
      error: "Mistral budget response was not valid JSON.",
      failureCategory: "provider_api",
      httpStatus: response.status,
    };
  }
  if (response.status === 401) {
    return {
      success: false,
      error: MISTRAL_VIBE_UNAUTHORIZED_MESSAGE,
      failureCategory: "credentials",
      httpStatus: 401,
    };
  }
  if (response.status === 403) {
    return {
      success: false,
      error: MISTRAL_VIBE_FORBIDDEN_MESSAGE,
      failureCategory: "credentials",
      httpStatus: 403,
    };
  }
  if (response.status === 404) {
    return {
      success: false,
      error: MISTRAL_VIBE_BILLING_UNAVAILABLE_MESSAGE,
      failureCategory: "provider_api",
      httpStatus: 404,
    };
  }
  return {
    success: false,
    error: `Mistral API error ${response.status}`,
    failureCategory: providerFailureCategoryForHttpStatus(response.status),
    httpStatus: response.status,
  };
}

/**
 * Read the Vibe budget and plan for one credential.
 *
 * The budget read is the quota source: when it fails the account reports that
 * failure. The subscription read only adds a plan label, so its own failure
 * never hides a budget that was read successfully.
 */
export async function queryMistralVibeQuota(params: {
  apiKey: string;
  requestTimeoutMs?: number;
  fetchFn?: typeof fetch;
}): Promise<MistralVibeQuotaResult> {
  const observedAtMs = Date.now();
  const timeoutMs = params.requestTimeoutMs ?? MISTRAL_VIBE_REQUEST_TIMEOUT_MS;

  let budget: JsonResponse;
  let subscription: JsonResponse | { thrown: true };
  try {
    [budget, subscription] = await Promise.all([
      getJson({ ...params, url: MISTRAL_VIBE_BUDGET_URL, timeoutMs }),
      getJson({ ...params, url: MISTRAL_VIBE_SUBSCRIPTION_URL, timeoutMs }).catch(
        () => ({ thrown: true }) as const,
      ),
    ]);
  } catch (error) {
    return {
      success: false,
      error: scrubCredentialErrorText(
        error instanceof Error ? error.message : "Mistral request failed",
      ),
      failureCategory: "provider_api",
    };
  }

  if (!budget.ok) return budgetFailure(budget);

  const root = isRecord(budget.body) ? budget.body : {};
  const vibeBudget = parseMistralVibeBudget(root.vibe_budget);
  const rawApiBudget = parseMistralVibeBudget(root.api_budget);
  // The API budget describes pay-as-you-go spend. Without PAYG billing it is
  // not a limit the account is measured against, so it is never shown.
  const apiBudget = rawApiBudget?.paygEnabled ? rawApiBudget : undefined;
  const plan =
    subscription && "ok" in subscription && subscription.ok
      ? parseMistralVibeSubscription(subscription.body)
      : undefined;

  return {
    success: true,
    observedAtIso: new Date(observedAtMs).toISOString(),
    ...(vibeBudget ? { vibeBudget } : {}),
    ...(apiBudget ? { apiBudget } : {}),
    ...(plan ? { subscription: plan } : {}),
  };
}
