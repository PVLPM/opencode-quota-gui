/**
 * Presentation-only card ordering shared by the backend card projection and the
 * Settings/Home surfaces (design spec dashboard visibility).
 *
 * This module is deliberately dependency-free and opaque-id-only: it never
 * interprets an id, never adds or removes a card, and never mutates its input.
 * The caller assembles the real cards first, then asks for a display order, so
 * same-provider siblings are ordered independently.
 */

const UNKNOWN_RANK = Number.POSITIVE_INFINITY;

function rankByIds(
  preference: readonly string[] | undefined,
  knownIds: ReadonlySet<string>,
): Map<string, number> {
  const ranks = new Map<string, number>();
  if (preference === undefined) return ranks;

  for (const [index, id] of preference.entries()) {
    if (!knownIds.has(id) || ranks.has(id)) continue;
    ranks.set(id, index);
  }
  return ranks;
}

function stableSortByRank<T>(cards: readonly T[], rankOf: (card: T) => number): T[] {
  return cards
    .map((card, index) => ({ card, index, rank: rankOf(card) }))
    .sort((left, right) =>
      left.rank === right.rank ? left.index - right.index : left.rank - right.rank,
    )
    .map(({ card }) => card);
}

/**
 * Returns a fresh card array ordered for presentation.
 *
 * - A non-empty `cardOrder` is authoritative: known listed cards come first in
 *   saved order, then every other card in stable input (backend) order. Unknown
 *   and duplicate preference ids are ignored.
 * - An absent or empty `cardOrder` falls back to the legacy provider order:
 *   providers listed in `providerOrder` come first in saved order, and their
 *   cards keep stable input order; unlisted providers keep input order after
 *   them. Unknown providers are ignored.
 */
export function orderCardsByPreference<T extends { cardId: string; providerId: string }>(
  cards: readonly T[],
  cardOrder?: readonly string[],
  providerOrder?: readonly string[],
): T[] {
  const input = [...cards];

  if (cardOrder !== undefined && cardOrder.length > 0) {
    const cardRanks = rankByIds(cardOrder, new Set(input.map((card) => card.cardId)));
    return stableSortByRank(input, (card) => cardRanks.get(card.cardId) ?? UNKNOWN_RANK);
  }

  const providerRanks = rankByIds(providerOrder, new Set(input.map((card) => card.providerId)));
  if (providerRanks.size === 0) return input;

  return stableSortByRank(input, (card) => providerRanks.get(card.providerId) ?? UNKNOWN_RANK);
}
