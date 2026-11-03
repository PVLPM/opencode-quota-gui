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
  return (
    typeof value === "string" && (PROVIDER_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export type ProviderHttpFailureCategory = Extract<
  ProviderFailureCategory,
  "credentials" | "provider_api"
>;

/**
 * HTTP 401/403 is an authentication/authorization outcome; every other failed
 * response is a provider API failure. Callers must only use this at an actual
 * request/response boundary.
 */
export function providerFailureCategoryForHttpStatus(status: number): ProviderHttpFailureCategory {
  return status === 401 || status === 403 ? "credentials" : "provider_api";
}
