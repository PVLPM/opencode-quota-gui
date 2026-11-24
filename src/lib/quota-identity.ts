import { createHash } from "node:crypto";

import { isCardHidden } from "../contracts/card-visibility.js";
import type { ProviderCard } from "../contracts/dashboard.js";
import type { CardId, RowId } from "../contracts/identity.js";
import {
  optionalRowId,
  type QuotaRowIdentityEntry,
  rowFieldKey,
  rowIdForEntry,
} from "../contracts/identity.js";
import { effectiveHiddenRowIds } from "../contracts/row-visibility.js";
import { getQuotaProviderRegistration } from "./provider-metadata.js";

/**
 * Server-side card identity and entry visibility.
 *
 * The browser-safe row-key/id builders live in `src/contracts/identity.ts`;
 * this module adds the `node:crypto` card hash and the visibility predicate so
 * both `src/lib` and `src/gui` consume one implementation without importing
 * each other.
 */

/**
 * Reserved identity key for the provider-scope card (entries/errors that no
 * discovered account owns). It is a scope marker, never an account id.
 */
export const PROVIDER_SCOPE_IDENTITY_KEY = "provider";

const CARD_HASH_DOMAIN = "ocq-card-v1";

/** The minimal provider-result fields row visibility needs. */
export interface QuotaVisibilityProviderResult {
  readonly accounts?: readonly {
    readonly sourceId: string;
    readonly identityKey?: string;
  }[];
  /** Emitted entries, in emission order, for legacy aggregate-id resolution. */
  readonly entries?: readonly QuotaVisibilityEntry[];
}

/** An entry plus the account attribution row visibility needs. */
export type QuotaVisibilityEntry = QuotaRowIdentityEntry & {
  readonly accounting: {
    readonly resultType: QuotaRowIdentityEntry["accounting"]["resultType"];
    readonly sourceId?: string;
  };
};

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

/** The card a row belongs to: its account card, or the provider-scope card. */
function cardIdForEntry(
  providerId: string,
  result: QuotaVisibilityProviderResult,
  entry: QuotaVisibilityEntry,
): CardId {
  const account = (result.accounts ?? []).find(
    (candidate) => candidate.sourceId === entry.accounting.sourceId,
  );
  return account
    ? buildCardId(providerId, account.identityKey?.trim() ? account.identityKey : account.sourceId)
    : buildProviderScopeCardId(providerId);
}

/**
 * Persistent Settings controls from the provider registration table.
 *
 * The control id is always the declared field id, so it stays stable when the
 * provider renders the field in another shape. Every supported alternate shape
 * (declared explicitly, plus any live emitted shape when the rowKey has one
 * declaration) is an alias of that control. Emitted row ids never change.
 */
export function optionalVisibilityRowsFor(
  providerId: string,
  cardId: CardId,
  rows: readonly { rowId: string }[] = [],
): ProviderCard["visibilityRows"] {
  const declared = getQuotaProviderRegistration(providerId)?.optionalVisibilityRows;
  if (!declared || declared.length === 0) return undefined;
  const declarationsByField = new Map<string, number>();
  for (const row of declared) {
    declarationsByField.set(row.rowKey, (declarationsByField.get(row.rowKey) ?? 0) + 1);
  }
  return declared.map((row) => {
    const rowId = optionalRowId(cardId, row.rowKey, row.resultType, row.kind);
    const aliases = new Set<RowId>();
    for (const shape of row.alternateShapes ?? []) {
      const alias = optionalRowId(cardId, row.rowKey, shape.resultType, shape.kind);
      if (alias !== rowId) aliases.add(alias);
    }
    // A rowKey with one declaration names one field: keep any live emitted
    // shape of that field on the same control. Duplicate declarations are two
    // distinct fields (for example a budget and a spend month), so only their
    // exact ids may match.
    if (declarationsByField.get(row.rowKey) === 1) {
      for (const entry of rows) {
        if (entry.rowId !== rowId && rowFieldKey(entry.rowId) === row.rowKey) {
          aliases.add(entry.rowId as RowId);
        }
      }
    }
    return {
      rowId,
      label: row.label,
      info: row.info,
      ...(aliases.size > 0 ? { aliases: [...aliases] } : {}),
    };
  });
}

/**
 * Whether one entry's live row is hidden by the effective card/row settings
 * the browser and native surfaces use. Shared by dashboard cards and the
 * retained legacy reset notice path so a hidden field is silent everywhere.
 * A saved pre-window aggregate id resolves against the emitted entries to the
 * first row it used to match; a declared control resolves through its aliases.
 */
export function quotaEntryIsHidden(params: {
  providerId: string;
  result: QuotaVisibilityProviderResult;
  entry: QuotaVisibilityEntry;
  hiddenCards?: readonly string[];
  hiddenRows?: readonly string[];
}): boolean {
  const cardId = cardIdForEntry(params.providerId, params.result, params.entry);
  if (
    isCardHidden(
      {
        cardId,
        providerId: params.providerId,
        providerScopeHash: hashQuotaCardIdentity(params.providerId, PROVIDER_SCOPE_IDENTITY_KEY),
      },
      new Set(params.hiddenCards ?? []),
    )
  ) {
    return true;
  }
  const hiddenRows = params.hiddenRows ?? [];
  if (hiddenRows.length === 0) return false;
  const cardRowIds = (params.result.entries ?? [params.entry])
    .filter((entry) => cardIdForEntry(params.providerId, params.result, entry) === cardId)
    .map((entry) => rowIdForEntry(cardId, entry));
  const controls = optionalVisibilityRowsFor(
    params.providerId,
    cardId,
    cardRowIds.map((rowId) => ({ rowId })),
  );
  return effectiveHiddenRowIds(cardRowIds, hiddenRows, controls).has(
    rowIdForEntry(cardId, params.entry),
  );
}
