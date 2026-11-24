/**
 * Authoritative normalized row-visibility semantics.
 *
 * Browser-safe and shared by the UI, Settings, the native session header and
 * the server-side quota notification detector.
 *
 * Before per-window semantics, providers without a stable semantic metric
 * emitted every row under `aggregate|<resultType>:<kind>`. A saved hide for
 * that provider therefore matched whichever such row was emitted first. Those
 * providers now emit typed `window:*` / `component:*` / `named:*` row keys.
 *
 * A saved legacy aggregate id keeps its original meaning until the user makes
 * a new explicit choice: it resolves to the first current row on the same card
 * with the same `|<resultType>:<kind>` discriminator. `materialize...` rewrites
 * it to that row's typed id when Settings toggles a row of that card.
 */

interface LegacyAggregateRowId {
  cardId: string;
  discriminator: string;
}

/**
 * One persistent row control: the stable declared id plus every emitted row id
 * that renders the same field in another shape. Emitted ids never change; the
 * alias set is how a hide or saved order follows the field across shapes.
 */
export interface RowVisibilityControl {
  rowId: string;
  aliases?: readonly string[];
}

/** The stable control id that owns a row id (itself or one of its aliases). */
export function rowControlId(rowId: string, controls: readonly RowVisibilityControl[]): string {
  for (const control of controls) {
    if (control.rowId === rowId || control.aliases?.includes(rowId)) return control.rowId;
  }
  return rowId;
}

/**
 * Rewrites a saved row order to stable control ids, first occurrence wins.
 * Unknown ids stay untouched so a later emission can still use them.
 */
export function rowOrderForControls(
  rowOrder: readonly string[],
  controls: readonly RowVisibilityControl[],
): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const id of rowOrder) {
    const controlId = rowControlId(id, controls);
    if (seen.has(controlId)) continue;
    seen.add(controlId);
    next.push(controlId);
  }
  return next;
}

function parseLegacyAggregateRowId(id: string): LegacyAggregateRowId | undefined {
  const separator = id.indexOf("#");
  if (separator <= 0) return undefined;
  const match = /^aggregate\|(.+)$/u.exec(id.slice(separator + 1));
  const discriminator = match?.[1];
  if (!discriminator) return undefined;
  return { cardId: id.slice(0, separator), discriminator };
}

function belongsToCard(rowId: string, cardId: string): boolean {
  return rowId.startsWith(`${cardId}#`);
}

function matchesDiscriminator(rowId: string, discriminator: string): boolean {
  return rowId.endsWith(`|${discriminator}`);
}

function firstRowForLegacyId(
  rowIds: readonly string[],
  legacy: LegacyAggregateRowId,
): string | undefined {
  return rowIds.find(
    (rowId) =>
      belongsToCard(rowId, legacy.cardId) && matchesDiscriminator(rowId, legacy.discriminator),
  );
}

/**
 * Resolves configured row ids against the rows a card currently emits. Exact
 * typed ids pass through untouched. A legacy aggregate id resolves to the
 * first emitted row of that card with the same discriminator; when no such row
 * exists yet it stays inert so it can match a later emission.
 *
 * A configured id that belongs to a control (its stable declared id or any
 * alias) hides every id the control owns. That keeps one eye effective when the
 * provider renders the same field in another shape, and keeps a hide saved
 * under the previous shape working after the control gains a stable id.
 */
export function effectiveHiddenRowIds(
  rowIds: readonly string[],
  hiddenRows: readonly string[],
  controls: readonly RowVisibilityControl[] = [],
): Set<string> {
  const hidden = new Set(hiddenRows);
  if (hidden.size === 0) return hidden;
  for (const id of hiddenRows) {
    const legacy = parseLegacyAggregateRowId(id);
    if (!legacy) continue;
    // A provider that still emits aggregate rows keeps an exact hide.
    if (rowIds.includes(id)) continue;
    const first = firstRowForLegacyId(rowIds, legacy);
    if (first === undefined) continue;
    hidden.delete(id);
    hidden.add(first);
  }
  for (const control of controls) {
    const ids = [control.rowId, ...(control.aliases ?? [])];
    if (!ids.some((id) => hidden.has(id))) continue;
    for (const id of ids) hidden.add(id);
  }
  return hidden;
}

/**
 * Rewrites every legacy aggregate id for `cardId` to the current row it
 * resolves to, and drops ones that no longer resolve. Called only after an
 * explicit Settings row toggle, so an untouched legacy choice keeps following
 * whichever row is emitted first. Other cards and exact ids are preserved in
 * order.
 */
export function materializeLegacyHiddenRowsForCard(
  cardId: string,
  hiddenRows: readonly string[],
  rowIds: readonly string[],
): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    next.push(id);
  };

  for (const id of hiddenRows) {
    const legacy = parseLegacyAggregateRowId(id);
    if (!legacy || legacy.cardId !== cardId) {
      push(id);
      continue;
    }
    // Keep an aggregate row that still exists as its own exact id.
    if (rowIds.includes(id)) {
      push(id);
      continue;
    }
    const first = firstRowForLegacyId(rowIds, legacy);
    if (first !== undefined) push(first);
  }
  return next;
}
