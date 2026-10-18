import type { AccountingMetric } from "./dashboard.js";

/**
 * Identity seam (design spec §5, §8, R20).
 *
 * Contracts only carry the opaque id types and the stable row-key builder.
 * The server-side hash of (`providerId`, `identityKey`) lives in
 * `src/gui/identity.ts`: nothing here hashes, and raw ids never reach the
 * browser.
 */

declare const cardIdBrand: unique symbol;
declare const rowIdBrand: unique symbol;
declare const rowKeyBrand: unique symbol;

/** Opaque provider-card id: provider namespace + server-side hash. */
export type CardId = string & { readonly [cardIdBrand]: true };

/** Opaque quota-row id: `cardId + "#" + rowKey`. */
export type RowId = string & { readonly [rowIdBrand]: true };

/** Stable typed row key; never a display label or an ordinal. */
export type RowKey = string & { readonly [rowKeyBrand]: true };

/**
 * Input for a stable row key: the row's typed semantic metric, or the
 * optional stable `rowKey` a provider mapping supplies when no semantic key
 * exists (P1b `GroupedQuotaEntryMeta.rowKey`).
 */
export type RowKeyInput = AccountingMetric | { readonly kind: "explicit"; readonly key: string };

/** Stable-`rowKey` builder type (no hashing; the card hash is server-side). */
export type RowKeyBuilder = (input: RowKeyInput) => RowKey;

function requireKeyText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError("row key text must not be empty");
  return trimmed;
}

/** Builds a deterministic row key from a typed semantic key. */
export function buildRowKey(input: RowKeyInput): RowKey {
  const key =
    input.kind === "aggregate"
      ? "aggregate"
      : input.kind === "window"
        ? `window:${input.window}`
        : input.kind === "component"
          ? `component:${input.component}`
          : input.kind === "named"
            ? `named:${requireKeyText(input.name)}`
            : requireKeyText(input.key);
  // SAFETY: RowKey is the opaque brand of this exact deterministic construction;
  // this builder is its only producer, and the text above is the whole key.
  return key as RowKey;
}

/** Composes `rowId = cardId + "#" + rowKey` (R20). */
export function composeRowId(cardId: CardId, rowKey: RowKey): RowId {
  // SAFETY: RowId is the opaque brand of exactly `cardId + "#" + rowKey`.
  return `${cardId}#${rowKey}` as RowId;
}
