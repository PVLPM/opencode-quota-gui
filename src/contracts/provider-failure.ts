/**
 * Safe, browser-shareable provider failure categories.
 *
 * Categories are assigned only where provider provenance is known. Absence means
 * unknown, and consumers must fail closed rather than infer a category from
 * labels, messages, or diagnostic text.
 */
export const PROVIDER_FAILURE_CATEGORIES = [
  "provider_api",
  "credentials",
  "discovery",
  "local",
] as const;

export type ProviderFailureCategory = (typeof PROVIDER_FAILURE_CATEGORIES)[number];

export function isProviderFailureCategory(value: unknown): value is ProviderFailureCategory {
  return PROVIDER_FAILURE_CATEGORIES.some((category) => category === value);
}

/**
 * Failures a later poll can recover from without re-authenticating. The account is unchanged, so
 * the last measured quota stays valid (marked stale) instead of being discarded.
 */
export function isTransientProviderFailureCategory(
  value: ProviderFailureCategory | undefined,
): boolean {
  return value === "provider_api" || value === "discovery" || value === "local";
}

export type ProviderHttpFailureCategory = Extract<
  ProviderFailureCategory,
  "credentials" | "provider_api"
>;

/**
 * The outcome of one provider attempt, separate from whether an older
 * measurement is still displayable:
 *
 * - `fresh`     the attempt completed and produced a new measurement;
 * - `reuse`     no request was made because a recent measurement is still
 *               within its reuse window; the measurement keeps its own time;
 * - `cooldown`  no request was made because this process is honoring an
 *               already-known rate-limit deadline; this is not a new failure;
 * - `transient` the request was made and failed in a way a later poll may
 *               recover from;
 * - `credentials` the request was rejected as unauthenticated/unauthorized.
 */
const QUOTA_ATTEMPT_OUTCOMES = ["fresh", "reuse", "cooldown", "transient", "credentials"] as const;

export type QuotaAttemptOutcome = (typeof QUOTA_ATTEMPT_OUTCOMES)[number];

export function isQuotaAttemptOutcome(value: unknown): value is QuotaAttemptOutcome {
  return QUOTA_ATTEMPT_OUTCOMES.some((outcome) => outcome === value);
}

/**
 * HTTP 401/403 is an authentication/authorization outcome; every other failed
 * response is a provider API failure. Callers must only use this at an actual
 * request/response boundary.
 */
export function providerFailureCategoryForHttpStatus(status: number): ProviderHttpFailureCategory {
  return status === 401 || status === 403 ? "credentials" : "provider_api";
}
