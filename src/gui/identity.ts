/**
 * Server-side card/row identity (design spec §8 R20, plan P3 step 1).
 *
 * The only place raw account identities are hashed: `CardId` is
 * `<providerId>:<sha256>` and `RowId` is `cardId + "#" + rowKey`. Raw source
 * ids, identity keys, and `rai1_` values are hash inputs and never outputs;
 * nothing here is imported by the browser (`src/contracts/identity.ts` holds
 * the opaque types only).
 */
import { createHash } from "node:crypto";

import type { CardId, RowId, RowKey } from "../contracts/identity.js";
import { buildRowKey, composeRowId } from "../contracts/identity.js";
import type { QuotaToastEntry } from "../lib/entries.js";
import { isPercentEntry } from "../lib/entries.js";

/**
 * Reserved identity key for the provider-scope card (entries/errors that no
 * discovered account owns). It is a scope marker, never an account id.
 */
export const PROVIDER_SCOPE_IDENTITY_KEY = "provider";

const CARD_HASH_DOMAIN = "ocq-card-v1";

/** Deterministic sha256 hex of the domain-separated (providerId, identityKey) pair. */
export function hashQuotaCardIdentity(providerId: string, identityKey: string): string {
  return createHash("sha256")
    .update(`${CARD_HASH_DOMAIN}\0${providerId}\0${identityKey}`, "utf8")
    .digest("hex");
}

/** Opaque card id: provider namespace + server-side hash; raw identities never appear. */
export function buildCardId(providerId: string, identityKey: string): CardId {
  // SAFETY: CardId is the opaque brand of exactly `<providerId>:<sha256>`; this
  // builder is its only producer and the hash covers both raw inputs.
  return `${providerId}:${hashQuotaCardIdentity(providerId, identityKey)}` as CardId;
}

/** The provider-scope card id (unscoped rows/errors, or no discovered accounts). */
export function buildProviderScopeCardId(providerId: string): CardId {
  return buildCardId(providerId, PROVIDER_SCOPE_IDENTITY_KEY);
}

function baseRowKeyOf(entry: QuotaToastEntry): RowKey {
  if (entry.semantic) return buildRowKey(entry.semantic.metric);
  if (entry.rowKey) return buildRowKey({ kind: "explicit", key: entry.rowKey });
  return buildRowKey({ kind: "aggregate" });
}

/**
 * Stable typed row key: the entry's semantic metric (window/component/named) or
 * its provider-supplied `rowKey`, plus the `resultType:kind` discriminator so
 * rows that share a metric but mean different things stay distinct. Never a
 * display label or an ordinal, so a rename cannot change a row id.
 */
export function rowKeyForEntry(entry: QuotaToastEntry): RowKey {
  const base = baseRowKeyOf(entry);
  const kind = isPercentEntry(entry) ? "percent" : entry.kind;
  return buildRowKey({ kind: "explicit", key: `${base}|${entry.accounting.resultType}:${kind}` });
}

/** `rowId = cardId + "#" + rowKey` (R20). */
export function rowIdForEntry(cardId: CardId, entry: QuotaToastEntry): RowId {
  return composeRowId(cardId, rowKeyForEntry(entry));
}
