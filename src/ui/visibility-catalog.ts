import type { QuotaSnapshot } from "../contracts/dashboard";

/** Bounded, untrusted browser-local memory of individual quota cards for Settings. */
export interface VisibilityRow {
  id: string;
  label: string;
  info?: string;
}

export interface VisibilityCard {
  /** Configuration identity only; never displayed. */
  cardId: string;
  providerId: string;
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;
  providerScopeId?: string;
  providerScopeHash?: string;
  rows: VisibilityRow[];
}

export interface VisibilityCatalog {
  cards: VisibilityCard[];
}

export interface VisibilityCatalogReader {
  getItem(key: string): string | null;
}

export interface VisibilityCatalogWriter {
  setItem(key: string, value: string): void;
}

// v1 grouped providers cannot be migrated reliably back to their original cards.
export const VISIBILITY_CATALOG_STORAGE_KEY = "opencode-quota-gui.visibility-catalog.v2";
const STORAGE_VERSION = 2;
export const VISIBILITY_CATALOG_LIMITS = { cards: 4_000, rows: 2_000, textLength: 256 } as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.slice(0, VISIBILITY_CATALOG_LIMITS.textLength)
    : undefined;
}

/** Identifiers are accepted verbatim or rejected, never shortened, repaired or inferred. */
function identifier(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= VISIBILITY_CATALOG_LIMITS.textLength &&
    value === value.trim()
    ? value
    : undefined;
}

function cardIdentifier(value: unknown, providerId: string): string | undefined {
  const id = identifier(value);
  const prefix = `${providerId}:`;
  return id?.startsWith(prefix) && /^[a-f0-9]{64}$/u.test(id.slice(prefix.length)) ? id : undefined;
}

function sanitizeCatalog(value: unknown): VisibilityCatalog {
  const cards: VisibilityCard[] = [];
  if (!record(value) || !Array.isArray(value.cards)) return { cards };
  const seenCards = new Set<string>();
  let rowBudget = VISIBILITY_CATALOG_LIMITS.rows as number;
  for (const candidate of value.cards) {
    if (cards.length >= VISIBILITY_CATALOG_LIMITS.cards) break;
    if (!record(candidate)) continue;
    const providerId = identifier(candidate.providerId);
    if (!providerId) continue;
    const cardId = cardIdentifier(candidate.cardId, providerId);
    const providerLabel = text(candidate.providerLabel);
    if (!cardId || !providerId || !providerLabel || seenCards.has(cardId)) continue;
    seenCards.add(cardId);
    const planLabel = text(candidate.planLabel);
    const accountLabel = text(candidate.accountLabel);
    const providerScopeId = cardIdentifier(candidate.providerScopeId, providerId);
    const scopeHash = identifier(candidate.providerScopeHash);
    const providerScopeHash =
      scopeHash &&
      /^[a-f0-9]{64}$/u.test(scopeHash) &&
      (providerScopeId === undefined || providerScopeId === `${providerId}:${scopeHash}`)
        ? scopeHash
        : undefined;
    const rows: VisibilityRow[] = [];
    const seenRows = new Set<string>();
    for (const row of Array.isArray(candidate.rows) ? candidate.rows : []) {
      if (rowBudget <= 0) break;
      if (!record(row)) continue;
      const id = identifier(row.id);
      const label = text(row.label);
      if (
        !id ||
        !id.startsWith(`${cardId}#`) ||
        id.length <= cardId.length + 1 ||
        !label ||
        seenRows.has(id)
      )
        continue;
      seenRows.add(id);
      rowBudget -= 1;
      const info = text(row.info);
      rows.push({ id, label, ...(info === undefined ? {} : { info }) });
    }
    cards.push({
      cardId,
      providerId,
      providerLabel,
      ...(planLabel === undefined ? {} : { planLabel }),
      ...(accountLabel === undefined ? {} : { accountLabel }),
      ...(providerScopeId === undefined ? {} : { providerScopeId }),
      ...(providerScopeHash === undefined ? {} : { providerScopeHash }),
      rows,
    });
  }
  return { cards };
}

export function readVisibilityCatalog(
  storage: VisibilityCatalogReader | undefined,
): VisibilityCatalog {
  try {
    const raw = storage?.getItem(VISIBILITY_CATALOG_STORAGE_KEY);
    if (!raw) return { cards: [] };
    const decoded: unknown = JSON.parse(raw);
    return record(decoded) && decoded.version === STORAGE_VERSION
      ? sanitizeCatalog(decoded)
      : { cards: [] };
  } catch {
    return { cards: [] };
  }
}

export function writeVisibilityCatalog(
  storage: VisibilityCatalogWriter | undefined,
  catalog: VisibilityCatalog,
): void {
  try {
    storage?.setItem(
      VISIBILITY_CATALOG_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...sanitizeCatalog(catalog) }),
    );
  } catch {
    // Storage failure loses persistence, never the current Settings session.
  }
}

export function visibilityCatalogEquals(
  left: VisibilityCatalog,
  right: VisibilityCatalog,
): boolean {
  return (
    left.cards.length === right.cards.length &&
    left.cards.every((card, index) => {
      const other = right.cards[index];
      return (
        other !== undefined &&
        card.cardId === other.cardId &&
        card.providerId === other.providerId &&
        card.providerLabel === other.providerLabel &&
        card.planLabel === other.planLabel &&
        card.accountLabel === other.accountLabel &&
        card.providerScopeId === other.providerScopeId &&
        card.providerScopeHash === other.providerScopeHash &&
        card.rows.length === other.rows.length &&
        card.rows.every((row, rowIndex) => {
          const next = other.rows[rowIndex];
          return (
            next !== undefined &&
            row.id === next.id &&
            row.label === next.label &&
            row.info === next.info
          );
        })
      );
    })
  );
}

/**
 * The quota payload's individual card identities, including cards hidden on
 * Quota, in the same order and with the same row ownership. Shared by the
 * browser Settings route and the native SettingsPage.
 */
export function catalogFromQuotaSnapshot(snapshot: QuotaSnapshot | undefined): VisibilityCatalog {
  if (snapshot === undefined) return { cards: [] };
  const cards: VisibilityCard[] = [];
  for (const card of snapshot.providers.cards) {
    if (cards.some((entry) => entry.cardId === card.cardId)) continue;
    const visibility: VisibilityCard = {
      cardId: card.cardId,
      providerId: card.providerId,
      providerLabel: card.providerLabel,
      ...(card.planLabel === undefined ? {} : { planLabel: card.planLabel }),
      ...(card.accountLabel === undefined ? {} : { accountLabel: card.accountLabel }),
      ...(card.providerScopeId === undefined ? {} : { providerScopeId: card.providerScopeId }),
      ...(card.providerScopeHash === undefined
        ? {}
        : { providerScopeHash: card.providerScopeHash }),
      rows: [],
    };
    const addRow = (id: string, label: string, info?: string): void => {
      const existing = visibility.rows.find((row) => row.id === id);
      if (existing) {
        if (existing.info === undefined && info !== undefined) existing.info = info;
        return;
      }
      visibility.rows.push({
        id,
        label,
        ...(info === undefined ? {} : { info }),
      });
    };
    for (const row of card.rows) addRow(row.rowId, row.label, row.info);
    for (const row of card.visibilityRows ?? []) addRow(row.rowId, row.label, row.info);
    cards.push(visibility);
  }
  return { cards };
}

/** Current identity wins, cached absent cards/rows survive, help fills transient gaps. */
export function mergeVisibilityCatalog(
  current: VisibilityCatalog,
  cached: VisibilityCatalog,
): VisibilityCatalog {
  const live = sanitizeCatalog(current);
  const remembered = sanitizeCatalog(cached);
  const cachedById = new Map(remembered.cards.map((card) => [card.cardId, card]));
  const cards = live.cards.map((card) => {
    const old = cachedById.get(card.cardId);
    if (!old) return card;
    const oldRows = new Map(old.rows.map((row) => [row.id, row]));
    const seen = new Set(card.rows.map((row) => row.id));
    return {
      ...card,
      ...(card.providerScopeId === undefined && old.providerScopeId !== undefined
        ? { providerScopeId: old.providerScopeId }
        : {}),
      ...(card.providerScopeHash === undefined && old.providerScopeHash !== undefined
        ? { providerScopeHash: old.providerScopeHash }
        : {}),
      rows: [
        ...card.rows.map((row) => {
          const info = row.info ?? oldRows.get(row.id)?.info;
          return info === undefined ? row : { ...row, info };
        }),
        ...old.rows.filter((row) => !seen.has(row.id)),
      ],
    };
  });
  const seen = new Set(cards.map((card) => card.cardId));
  return sanitizeCatalog({
    cards: [...cards, ...remembered.cards.filter((card) => !seen.has(card.cardId))],
  });
}
