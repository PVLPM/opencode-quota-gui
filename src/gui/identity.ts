/**
 * Compatibility re-export. The shared identity helpers live in
 * `src/contracts/identity.ts` (pure) and `src/contracts/quota-identity.ts`
 * (server-side hash + visibility) so the lib and GUI layers share one
 * implementation without importing each other.
 */

export { rowIdForEntry, rowKeyForEntry } from "../contracts/identity.js";
export {
  buildCardId,
  buildProviderScopeCardId,
  hashQuotaCardIdentity,
  PROVIDER_SCOPE_IDENTITY_KEY,
} from "../lib/quota-identity.js";
