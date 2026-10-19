/**
 * Browser-local cache for the Settings visibility catalog.
 *
 * The server filters provider-level hidden ids before probing, so a hidden
 * provider is absent from the next quota snapshot. Settings still needs a card
 * to offer the eye that shows it again: this module remembers the last-seen
 * labels, stable card ids and row ids in `localStorage`. Ids are configuration
 * keys only and never reach the DOM.
 *
 * Storage is untrusted: every read validates the version, shapes and text, and
 * clamps the catalog to fixed budgets. A malformed, oversized or unavailable
 * store degrades to an empty catalog and never breaks the dashboard.
 */

/** One quota row a visibility eye can hide; the id is stored, never displayed. */
export interface VisibilityRow {
  id: string;
  label: string;
  accountLabel?: string;
}

/** One provider's remembered cards and rows, grouped for the visibility cards. */
export interface VisibilityProvider {
  providerId: string;
  providerLabel: string;
  /** Unique, for identification only; generated `[Provider] (Plan)` forms are unwrapped. */
  accountLabels: string[];
  /** Stable card ids, never displayed. */
  cardIds: string[];
  /** Unique by row id across the provider's cards. */
  rows: VisibilityRow[];
}

/** Last-seen providers with their cards and rows, so an eye can name what it hides. */
export interface VisibilityCatalog {
  providers: VisibilityProvider[];
}

export interface VisibilityCatalogReader {
  getItem(key: string): string | null;
}

export interface VisibilityCatalogWriter {
  setItem(key: string, value: string): void;
}

export const VISIBILITY_CATALOG_STORAGE_KEY = "opencode-quota-gui.visibility-catalog.v1";

const STORAGE_VERSION = 1;
const MAX_PROVIDERS = 200;
const MAX_ROWS = 2_000;
const MAX_CARD_IDS = 4_000;
const MAX_ACCOUNT_LABELS = 2_000;
const MAX_TEXT_LENGTH = 256;

export const VISIBILITY_CATALOG_LIMITS = {
  providers: MAX_PROVIDERS,
  rows: MAX_ROWS,
  cardIds: MAX_CARD_IDS,
  accountLabels: MAX_ACCOUNT_LABELS,
  textLength: MAX_TEXT_LENGTH,
} as const;

interface Budget {
  remaining: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value.slice(0, MAX_TEXT_LENGTH);
}

function boundedAccountLabel(value: unknown): string | undefined {
  return value === undefined ? undefined : boundedText(value);
}

function arrayOrEmpty(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function takeText(value: unknown, budget: Budget, seen: Set<string>): string | undefined {
  if (budget.remaining <= 0) return undefined;
  const text = boundedText(value);
  if (text === undefined || seen.has(text)) return undefined;
  seen.add(text);
  budget.remaining -= 1;
  return text;
}

function sanitizeRow(value: unknown, budget: Budget): VisibilityRow | undefined {
  if (budget.remaining <= 0 || !isRecord(value)) return undefined;
  const id = boundedText(value.id);
  const label = boundedText(value.label);
  if (id === undefined || label === undefined) return undefined;
  budget.remaining -= 1;
  const accountLabel = boundedAccountLabel(value.accountLabel);
  return accountLabel === undefined ? { id, label } : { id, label, accountLabel };
}

function sanitizeProvider(
  value: unknown,
  rowBudget: Budget,
  cardBudget: Budget,
  accountBudget: Budget,
): VisibilityProvider | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = boundedText(value.providerId);
  const providerLabel = boundedText(value.providerLabel);
  if (providerId === undefined || providerLabel === undefined) return undefined;

  const accountLabels: string[] = [];
  const seenAccounts = new Set<string>();
  for (const entry of arrayOrEmpty(value.accountLabels)) {
    const label = takeText(entry, accountBudget, seenAccounts);
    if (label !== undefined) accountLabels.push(label);
  }

  const cardIds: string[] = [];
  const seenCards = new Set<string>();
  for (const entry of arrayOrEmpty(value.cardIds)) {
    const cardId = takeText(entry, cardBudget, seenCards);
    if (cardId !== undefined) cardIds.push(cardId);
  }

  const rows: VisibilityRow[] = [];
  const seenRows = new Set<string>();
  for (const entry of arrayOrEmpty(value.rows)) {
    const row = sanitizeRow(entry, rowBudget);
    if (row === undefined || seenRows.has(row.id)) continue;
    seenRows.add(row.id);
    rows.push(row);
  }

  return { providerId, providerLabel, accountLabels, cardIds, rows };
}

function sanitizeProviders(value: unknown): VisibilityProvider[] {
  const rowBudget: Budget = { remaining: MAX_ROWS };
  const cardBudget: Budget = { remaining: MAX_CARD_IDS };
  const accountBudget: Budget = { remaining: MAX_ACCOUNT_LABELS };
  const providers: VisibilityProvider[] = [];
  const seenProviders = new Set<string>();
  for (const entry of arrayOrEmpty(value)) {
    if (providers.length >= MAX_PROVIDERS) break;
    const provider = sanitizeProvider(entry, rowBudget, cardBudget, accountBudget);
    if (provider === undefined || seenProviders.has(provider.providerId)) continue;
    seenProviders.add(provider.providerId);
    providers.push(provider);
  }
  return providers;
}

function sanitizeCatalog(value: unknown): VisibilityCatalog {
  if (!isRecord(value)) return { providers: [] };
  return { providers: sanitizeProviders(value.providers) };
}

/**
 * Reads the last-seen catalog. A malformed payload, a future version, a wrong
 * shape or a blocked storage area yields an empty catalog: Settings falls back
 * to its plain empty state instead of showing an invented provider.
 */
export function readVisibilityCatalog(
  storage: VisibilityCatalogReader | undefined,
): VisibilityCatalog {
  if (storage === undefined) return { providers: [] };
  try {
    const raw = storage.getItem(VISIBILITY_CATALOG_STORAGE_KEY);
    if (raw === null) return { providers: [] };
    const decoded: unknown = JSON.parse(raw);
    if (!isRecord(decoded) || decoded.version !== STORAGE_VERSION) return { providers: [] };
    return sanitizeCatalog(decoded);
  } catch {
    return { providers: [] };
  }
}

/**
 * Persists the bounded catalog. Storage failures cost persistence, never the
 * session, so a blocked or full store is ignored.
 */
export function writeVisibilityCatalog(
  storage: VisibilityCatalogWriter | undefined,
  catalog: VisibilityCatalog,
): void {
  if (storage === undefined) return;
  try {
    storage.setItem(
      VISIBILITY_CATALOG_STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...sanitizeCatalog(catalog) }),
    );
  } catch {
    // A blocked storage area or a quota error is not a dashboard failure.
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRows(left: readonly VisibilityRow[], right: readonly VisibilityRow[]): boolean {
  return (
    left.length === right.length &&
    left.every((row, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        row.id === other.id &&
        row.label === other.label &&
        row.accountLabel === other.accountLabel
      );
    })
  );
}

function sameProvider(left: VisibilityProvider, right: VisibilityProvider): boolean {
  return (
    left.providerId === right.providerId &&
    left.providerLabel === right.providerLabel &&
    sameStrings(left.accountLabels, right.accountLabels) &&
    sameStrings(left.cardIds, right.cardIds) &&
    sameRows(left.rows, right.rows)
  );
}

/** Structural equality, used to persist only when a merged catalog really changed. */
export function visibilityCatalogEquals(
  left: VisibilityCatalog,
  right: VisibilityCatalog,
): boolean {
  return (
    left.providers.length === right.providers.length &&
    left.providers.every((provider, index) => {
      const other = right.providers[index];
      return other !== undefined && sameProvider(provider, other);
    })
  );
}

function mergeRows(
  current: readonly VisibilityRow[],
  cached: readonly VisibilityRow[],
): VisibilityRow[] {
  const cachedById = new Map(cached.map((row) => [row.id, row]));
  const rows = current.map((row) => {
    const cachedRow = cachedById.get(row.id);
    if (row.accountLabel !== undefined || cachedRow?.accountLabel === undefined) return row;
    return { id: row.id, label: row.label, accountLabel: cachedRow.accountLabel };
  });
  const seen = new Set(current.map((row) => row.id));
  for (const row of cached) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return rows;
}

function mergeProvider(
  current: VisibilityProvider,
  cached: VisibilityProvider,
): VisibilityProvider {
  return {
    providerId: current.providerId,
    providerLabel: current.providerLabel,
    accountLabels: [...new Set([...current.accountLabels, ...cached.accountLabels])],
    cardIds: [...new Set([...current.cardIds, ...cached.cardIds])],
    rows: mergeRows(current.rows, cached.rows),
  };
}

/**
 * Merges the providers in the current (possibly filtered) quota snapshot with
 * the cached catalog. Cached providers missing from the current result survive,
 * current fields win when both know a provider, and cached card ids, rows and
 * account labels are retained so their eyes keep working. The result is bounded.
 */
export function mergeVisibilityCatalog(
  current: VisibilityCatalog,
  cached: VisibilityCatalog,
): VisibilityCatalog {
  const currentCatalog = sanitizeCatalog(current);
  const cachedCatalog = sanitizeCatalog(cached);
  const cachedById = new Map(
    cachedCatalog.providers.map((provider) => [provider.providerId, provider]),
  );
  const merged: VisibilityProvider[] = [];
  const seen = new Set<string>();

  for (const provider of currentCatalog.providers) {
    const cachedProvider = cachedById.get(provider.providerId);
    merged.push(cachedProvider === undefined ? provider : mergeProvider(provider, cachedProvider));
    seen.add(provider.providerId);
  }
  for (const provider of cachedCatalog.providers) {
    if (seen.has(provider.providerId)) continue;
    seen.add(provider.providerId);
    merged.push(provider);
  }

  return sanitizeCatalog({ providers: merged });
}
