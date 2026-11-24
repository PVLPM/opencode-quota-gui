/**
 * Persisted semantics for `dashboard.hiddenCards` and `dashboard.hiddenRows`
 * (backend-only helpers).
 *
 * Version 1 (implicit, no marker) treated a provider-scope card id as a
 * provider-wide hide. Version 2 treats every hiddenCards entry as an exact card
 * id, while a plain provider id and the legacy bare provider-scope hash remain
 * provider-wide forms. The card/row identity helpers live in
 * `src/contracts/identity.ts` so this layer and the GUI share one hash.
 */
import { hashQuotaCardIdentity, PROVIDER_SCOPE_IDENTITY_KEY } from "./quota-identity.js";

export const DASHBOARD_HIDDEN_CARDS_VERSION = 2;

const CARD_HASH_RE = /^[0-9a-f]{64}$/u;

/** The provider-scope hash exactly as `buildProviderScopeCardId` derives it. */
export function dashboardProviderScopeHash(providerId: string): string {
  return hashQuotaCardIdentity(providerId, PROVIDER_SCOPE_IDENTITY_KEY);
}

/**
 * Converts one legacy provider-scope card id to its provider id. Only a full
 * `${providerId}:${sha256}` whose hash matches the actual provider-scope hash
 * qualifies; account card ids, bare hashes, and arbitrary unknown ids are left
 * untouched.
 */
export function legacyProviderIdForScopeCardId(id: string): string | undefined {
  const separator = id.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const providerId = id.slice(0, separator);
  const hash = id.slice(separator + 1);
  if (!CARD_HASH_RE.test(hash)) return undefined;
  return hash === dashboardProviderScopeHash(providerId) ? providerId : undefined;
}

/** Deterministic legacy (v1) hiddenCards normalization, preserving first-seen order. */
export function normalizeLegacyDashboardHiddenCards(ids: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const next = legacyProviderIdForScopeCardId(id) ?? id;
    if (seen.has(next)) continue;
    seen.add(next);
    normalized.push(next);
  }
  return normalized;
}

/**
 * Row ids saved before per-window semantics are resolved against the live card
 * at render/notification time in `src/contracts/row-visibility.ts`. They are
 * intentionally preserved verbatim here until an explicit Settings toggle.
 */
