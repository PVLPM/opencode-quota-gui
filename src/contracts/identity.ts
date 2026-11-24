import type { AccountingMetric, AccountingResultType } from "./dashboard.js";

/**
 * Identity seam (design spec §5, §8, R20).
 *
 * Browser-safe contracts: the opaque id types and the stable row-key builder.
 * The server-side card hash and entry-visibility helper live in
 * `./quota-identity.ts` so neither the lib nor the GUI layer imports the other,
 * and the browser bundle never pulls in `node:crypto`.
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

/** The minimal entry identity fields; real `QuotaToastEntry` values are assignable. */
export interface QuotaRowIdentityEntry {
  readonly semantic?: {
    readonly metric: AccountingMetric;
    readonly prominence: "primary" | "supplementary";
  };
  readonly rowKey?: string;
  readonly kind?: "percent" | "value" | "quantity" | "boolean";
  readonly accounting: { readonly resultType: AccountingResultType };
}

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

function baseRowKeyOf(entry: QuotaRowIdentityEntry): RowKey {
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
export function rowKeyForEntry(entry: QuotaRowIdentityEntry): RowKey {
  const base = baseRowKeyOf(entry);
  const kind = entry.kind === undefined || entry.kind === "percent" ? "percent" : entry.kind;
  return buildRowKey({ kind: "explicit", key: `${base}|${entry.accounting.resultType}:${kind}` });
}

/** `rowId = cardId + "#" + rowKey` (R20). */
export function rowIdForEntry(cardId: CardId, entry: QuotaRowIdentityEntry): RowId {
  return composeRowId(cardId, rowKeyForEntry(entry));
}

/**
 * Row id for a declared optional field. `kind` must match the live row's
 * render shape so hiding the Settings eye also hides the emitted row.
 */
export function optionalRowId(
  cardId: CardId,
  rowKey: string,
  resultType: AccountingResultType,
  kind: "percent" | "value" | "quantity" | "boolean" = "value",
): RowId {
  const entry =
    kind === "percent"
      ? { rowKey, accounting: { resultType } }
      : { rowKey, kind, accounting: { resultType } };
  return rowIdForEntry(cardId, entry);
}

/**
 * The typed field key inside a row id (`cardId#<field>|<resultType>:<kind>`).
 * Used only to keep one Settings entry per field when a provider emits the same
 * field in a different render shape than its declaration describes.
 */
export function rowFieldKey(rowId: string): string {
  const hash = rowId.indexOf("#");
  const key = hash >= 0 ? rowId.slice(hash + 1) : rowId;
  const discriminator = key.lastIndexOf("|");
  return discriminator >= 0 ? key.slice(0, discriminator) : key;
}
