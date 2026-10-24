/**
 * Persisted semantics for `dashboard.hiddenCards` (backend-only helpers).
 *
 * Version 1 (implicit, no marker) treated a provider-scope card id as a
 * provider-wide hide. Version 2 treats every hiddenCards entry as an exact card
 * id, while a plain provider id and the legacy bare provider-scope hash remain
 * provider-wide forms. The domain and identity-key literals below are pinned to
 * `src/gui/identity.ts` by the backend tests; importing GUI identity (and its
 * node:crypto hash) from this layer would couple config loading to the GUI.
 */
import { createHash } from "node:crypto";

export const DASHBOARD_HIDDEN_CARDS_VERSION = 2;

const CARD_HASH_DOMAIN = "ocq-card-v1";
const PROVIDER_SCOPE_IDENTITY_KEY = "provider";
const CARD_HASH_RE = /^[0-9a-f]{64}$/u;

/** The provider-scope hash exactly as `buildProviderScopeCardId` derives it. */
export function dashboardProviderScopeHash(providerId: string): string {
  return createHash("sha256")
    .update(`${CARD_HASH_DOMAIN}\0${providerId}\0${PROVIDER_SCOPE_IDENTITY_KEY}`, "utf8")
    .digest("hex");
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
