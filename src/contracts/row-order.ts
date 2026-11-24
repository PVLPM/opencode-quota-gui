import { rankByIds, stableSortByRank } from "./card-order.js";
import { type RowVisibilityControl, rowControlId, rowOrderForControls } from "./row-visibility.js";

/**
 * Presentation-only row ordering shared by the backend card projection and the
 * Settings visibility list.
 *
 * Like `card-order`, this module is dependency-free and opaque-id-only: it never
 * interprets an id, never adds or removes a row, and never mutates its input.
 * The caller assembles the real rows first, then asks for a display order, so a
 * newly emitted row keeps its provider position after every listed row.
 */

const UNKNOWN_RANK = Number.POSITIVE_INFINITY;

/**
 * Returns a fresh row array ordered for presentation.
 *
 * - A non-empty saved order lists preferred rows first, in saved order; every
 *   other row (new, or never reordered) follows in stable input (emission)
 *   order. Unknown and duplicate preference ids are ignored.
 * - An absent or empty saved order keeps stable input order.
 * - With `controls`, a saved order saved under an alternate emitted shape and a
 *   row rendered in another shape resolve to the same stable control id.
 */
export function orderRowsByPreference<T>(
  rows: readonly T[],
  rowOrder?: readonly string[],
  // SAFETY: callers that omit idOf pass rows carrying a rowId field.
  idOf: (row: T) => string = (row) => (row as { rowId: string }).rowId,
  controls: readonly RowVisibilityControl[] = [],
): T[] {
  if (rowOrder === undefined || rowOrder.length === 0) return [...rows];

  const order = rowOrderForControls(rowOrder, controls);
  const ranks = rankByIds(order, new Set(rows.map((row) => rowControlId(idOf(row), controls))));
  if (ranks.size === 0) return [...rows];

  return stableSortByRank(
    rows,
    (row) => ranks.get(rowControlId(idOf(row), controls)) ?? UNKNOWN_RANK,
  );
}
