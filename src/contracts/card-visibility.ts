/**
 * Authoritative normalized card-visibility semantics.
 *
 * Browser-safe and shared by the UI and the server-side quota notification
 * detector. A card is hidden when the effective hidden-card list contains its
 * exact `cardId`, its `providerId`, or its authoritative bare provider-scope
 * hash. Effective server settings normalize legacy full scope ids to
 * `providerId`; every full card id is now an exact hide. Row hiding is a
 * separate, exact `rowId` check and is not affected by this helper.
 */

export interface ProviderVisibilityIdentity {
  providerId: string;
  providerScopeHash?: string;
}

export interface CardVisibilityIdentity extends ProviderVisibilityIdentity {
  cardId: string;
}

/** Consume normalized settings; never guess old semantics from the current catalog. */
export function isLegacyProviderHidden(
  card: ProviderVisibilityIdentity,
  hidden: ReadonlySet<string>,
): boolean {
  return (
    hidden.has(card.providerId) ||
    (card.providerScopeHash !== undefined && hidden.has(card.providerScopeHash))
  );
}

export function isCardHidden(card: CardVisibilityIdentity, hidden: ReadonlySet<string>): boolean {
  return hidden.has(card.cardId) || isLegacyProviderHidden(card, hidden);
}
