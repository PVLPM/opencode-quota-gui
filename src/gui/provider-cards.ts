/**
 * Provider card mapping (design spec §6 R17–R20, §8, §9 R38/R51; plan P3
 * step 1).
 *
 * One card per discovered account, plus a provider-scope card when a result
 * carries rows/errors that no account owns. Entries map 1:1 to the four row
 * kinds using the existing accounting formatters; errors are
 * credential-scrubbed before display sanitizing, and unredactable messages
 * become the generic controlled string. Raw `statusDetails`/`rawDetails`/
 * diagnostics are never copied into a payload.
 */
import type { ProviderCard, QuotaCardRow } from "../contracts/dashboard.js";
import type { CardId } from "../contracts/identity.js";
import {
  OPENAI_CREDITS_INFO,
  OPENAI_CREDITS_ROW_KEY,
  OPENAI_CREDITS_ROW_LABEL,
  OPENAI_CREDITS_ROW_RESULT_TYPE,
  OPENAI_RESETS_INFO,
  OPENAI_RESETS_ROW_KEY,
  OPENAI_RESETS_ROW_LABEL,
  OPENAI_RESETS_ROW_RESULT_TYPE,
} from "../contracts/openai-quota.js";
import {
  formatAccountingQuantity,
  interpretAccountingRow,
  isCanonicalAccountingDecimal,
} from "../lib/accounting-format.js";
import {
  sanitizeDisplayText,
  sanitizeQuotaToastEntry,
  sanitizeSingleLineDisplayText,
} from "../lib/display-sanitize.js";
import type {
  AccountingPercentageBasis,
  QuotaPercentEntry,
  QuotaProviderAccount,
  QuotaToastEntry,
  QuotaToastError,
} from "../lib/entries.js";
import {
  cloneBankedResetAvailability,
  isBooleanEntry,
  isPercentEntry,
  isQuantityEntry,
  isValueEntry,
} from "../lib/entries.js";
import { formatResetCountdown, isResetTimeDecimals } from "../lib/format-utils.js";
import { scrubCredentialErrorText } from "../lib/opencode-auth.js";
import { getQuotaProviderDisplayLabel } from "../lib/provider-metadata.js";
import { projectQuotaRunway } from "../lib/quota-exhaustion-projection.js";
import type { QuotaStatusLiveProbe } from "../lib/quota-render-data.js";
import type { QuotaToastConfig } from "../lib/types.js";
import { buildCardId, buildProviderScopeCardId, rowIdForEntry } from "./identity.js";

/** Controlled fallback for unknown/unsafe provider errors (spec §9 R38). */
export const PROVIDER_ERROR_GENERIC_MESSAGE =
  "Provider request failed; check upstream quota diagnostics.";

/** Controlled fallback label when an error label itself is unredactable. */
export const PROVIDER_ERROR_GENERIC_LABEL = "Provider error";

/**
 * Only presentation knobs a card needs. Deliberately not the whole config:
 * `formatStyle`, `onlyCurrentModel`, and the hidden-visibility lists can never
 * change which cards or rows are produced (spec §6 invariant 8).
 */
export interface ProviderCardPreferences {
  accountingDetail: QuotaToastConfig["accountingDetail"];
  quotaProjection?: QuotaToastConfig["quotaProjection"];
  resetTimeDecimals?: QuotaToastConfig["resetTimeDecimals"];
  resetTimeSpaced?: QuotaToastConfig["resetTimeSpaced"];
  /**
   * Preferred provider card display order (`dashboard.providerOrder`). Affects
   * only the sequence of provider cards: listed providers come first in saved
   * order, unlisted providers keep probe order afterward. Data, rows, and
   * visibility are untouched.
   */
  providerOrder?: readonly string[];
}

export interface BuildProviderCardsInput {
  probes: readonly QuotaStatusLiveProbe[];
  preferences: ProviderCardPreferences;
  nowMs: number;
  /** Provider display label resolver; defaults to the registration table. */
  providerLabel?: (providerId: string) => string;
}

// Raw identities shorter than this are not string-replaced (avoids gutting
// ordinary words); real OpenCode connection ids are longer.
const MIN_SECRET_LENGTH = 4;
const RAI1_RE = /\brai1_[A-Za-z0-9._-]*/gu;
// Drive-letter, UNC, and well-known POSIX roots — an outgoing error may never
// carry a filesystem path, and this text cannot be redacted locally.
const ABSOLUTE_PATH_RE =
  /(?:[A-Za-z]:[\\/]|\\\\[^\s\\/]|(?:^|[\s"'=(])\/(?:Users|home|root|var|etc|tmp|opt|mnt|srv|usr|proc|dev|sys)(?:\/|$))/u;

// ---------------------------------------------------------------------------
// Privacy pipeline: credential scrub -> raw-id redaction -> path guard -> controls
// ---------------------------------------------------------------------------

function collectRawIdentities(probe: QuotaStatusLiveProbe): string[] {
  const secrets: string[] = [];
  const push = (value: string | undefined): void => {
    if (value === undefined) return;
    const trimmed = value.trim();
    if (trimmed.length >= MIN_SECRET_LENGTH) secrets.push(trimmed);
  };
  for (const account of probe.result.accounts ?? []) {
    push(account.sourceId);
    push(account.identityKey);
  }
  for (const entry of probe.result.entries) push(entry.accounting.sourceId);
  for (const error of probe.result.errors) push(error.sourceId);
  return [...new Set(secrets)];
}

function redactRawIdentities(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    output = output.split(secret).join("[redacted]");
  }
  return output.replace(RAI1_RE, "[redacted]");
}

/** `undefined` means unredactable/unknown content; callers use the generic string. */
function safeProviderText(raw: string, secrets: readonly string[]): string | undefined {
  const scrubbed = scrubCredentialErrorText(raw);
  const redacted = redactRawIdentities(scrubbed, secrets);
  if (ABSOLUTE_PATH_RE.test(redacted)) return undefined;
  const display = sanitizeDisplayText(redacted).trim();
  return display ? display : undefined;
}

function mapProviderError(
  error: QuotaToastError,
  secrets: readonly string[],
): ProviderCard["errors"][number] {
  const mapped: ProviderCard["errors"][number] = {
    label: safeProviderText(error.label, secrets) ?? PROVIDER_ERROR_GENERIC_LABEL,
    message: safeProviderText(error.message, secrets) ?? PROVIDER_ERROR_GENERIC_MESSAGE,
  };
  if (error.retryable === true) mapped.retryable = true;
  return mapped;
}

// ---------------------------------------------------------------------------
// Entry -> row mapping
// ---------------------------------------------------------------------------

function applyResetFields(
  row: QuotaCardRow,
  entry: QuotaToastEntry,
  preferences: ProviderCardPreferences,
): void {
  if (!entry.resetTimeIso) return;
  row.resetAtIso = entry.resetTimeIso;
  row.countdown = formatResetCountdown(
    entry.resetTimeIso,
    isResetTimeDecimals(preferences.resetTimeDecimals)
      ? { compactRounded: true, decimals: preferences.resetTimeDecimals }
      : { spaced: preferences.resetTimeSpaced },
  );
}

function applyRunway(row: QuotaCardRow, entry: QuotaPercentEntry, nowMs: number): void {
  const runway =
    entry.runway ??
    projectQuotaRunway({
      percentRemaining: entry.percentRemaining,
      fixedWindow: entry.fixedWindow,
      resetTimeIso: entry.resetTimeIso,
      nowMs,
    });
  if (runway) row.runway = { ...runway };
}

function detailRowsFor(basis: AccountingPercentageBasis): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, fact: AccountingPercentageBasis["used"]): void => {
    if (!fact || !isCanonicalAccountingDecimal(fact.quantity.decimal)) return;
    rows.push({ label, value: formatAccountingQuantity(fact.quantity) });
  };
  add("Used", basis.used);
  add("Limit", basis.limit);
  add("Remaining", basis.remaining);
  return rows;
}

/**
 * The canonical label for an entry. `interpretAccountingRow` formats a
 * quantity eagerly, and a provider-supplied non-canonical decimal would throw;
 * fall back to the raw display name so one malformed row cannot fail a read.
 *
 * GUI cards drop a trailing colon (and the whitespace around it) because the
 * label renders before its value, not as a prompt. Provider/TUI labels and the
 * underlying accounting label are untouched.
 */
function normalizeRowLabel(label: string): string {
  return sanitizeSingleLineDisplayText(label)
    .replace(/\s*:\s*$/u, "")
    .trimEnd();
}

function labelForEntry(entry: QuotaToastEntry): string {
  try {
    return normalizeRowLabel(interpretAccountingRow(entry, { booleanWording: "semantic" }).label);
  } catch {
    const fallback = entry.metricLabel?.trim() || entry.label?.trim() || entry.name;
    return normalizeRowLabel(fallback);
  }
}

function mapEntryRow(params: {
  entry: QuotaToastEntry;
  cardId: CardId;
  preferences: ProviderCardPreferences;
  nowMs: number;
}): QuotaCardRow {
  const { cardId, preferences, nowMs } = params;
  const entry = sanitizeQuotaToastEntry(params.entry);
  const row: QuotaCardRow = {
    rowId: rowIdForEntry(cardId, entry),
    label: labelForEntry(entry),
    kind: "value",
    resultType: entry.accounting.resultType,
  };
  if (entry.semantic) row.metric = { ...entry.semantic.metric };
  if (entry.info !== undefined) row.info = entry.info;
  if (isValueEntry(entry) && entry.bankedResets) {
    row.bankedResets = cloneBankedResetAvailability(entry.bankedResets);
  }

  if (isPercentEntry(entry)) {
    row.kind = "percent";
    if (Number.isFinite(entry.percentRemaining)) {
      row.percentRemaining = entry.percentRemaining;
      row.percentUsed = 100 - entry.percentRemaining;
    }
    applyResetFields(row, entry, preferences);
    if (preferences.quotaProjection === "runway") applyRunway(row, entry, nowMs);
    if (preferences.accountingDetail === "detailed" && entry.basis) {
      const detailRows = detailRowsFor(entry.basis);
      if (detailRows.length > 0) row.detailRows = detailRows;
    }
    return row;
  }

  applyResetFields(row, entry, preferences);
  if (isValueEntry(entry)) {
    row.kind = "value";
    row.value = entry.value;
  } else if (isQuantityEntry(entry)) {
    row.kind = "quantity";
    row.quantity = { decimal: entry.quantity.decimal, unit: { ...entry.quantity.unit } };
  } else if (isBooleanEntry(entry)) {
    row.kind = "boolean";
    row.booleanValue = entry.value;
  }
  return row;
}

/**
 * Rows are deduplicated by `rowId`: two entries that resolve to the same typed
 * key (a provider metadata gap the provider must fix with `semantic`/`rowKey`)
 * never produce duplicate DOM ids. The first occurrence in emission order wins.
 */
function mapEntryRows(params: {
  entries: readonly QuotaToastEntry[];
  cardId: CardId;
  preferences: ProviderCardPreferences;
  nowMs: number;
}): QuotaCardRow[] {
  const rows: QuotaCardRow[] = [];
  const seen = new Set<string>();
  for (const entry of params.entries) {
    const row = mapEntryRow({
      entry,
      cardId: params.cardId,
      preferences: params.preferences,
      nowMs: params.nowMs,
    });
    if (seen.has(row.rowId)) continue;
    seen.add(row.rowId);
    rows.push(row);
  }
  return rows;
}

const OPENAI_OPTIONAL_ROW_ACCOUNTING = {
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function optionalValueRowId(
  cardId: CardId,
  rowKey: string,
  resultType: QuotaCardRow["resultType"],
): QuotaCardRow["rowId"] {
  return rowIdForEntry(cardId, {
    kind: "value",
    name: "",
    value: "",
    rowKey,
    accounting: { ...OPENAI_OPTIONAL_ROW_ACCOUNTING, resultType },
  });
}

/**
 * Persistent Resets/Credits choices for an OpenAI card. These are metadata for
 * the Settings eyes only; they never create a zero/empty Quota data row.
 */
export function openAiOptionalVisibilityRows(
  cardId: CardId,
): NonNullable<ProviderCard["visibilityRows"]> {
  return [
    {
      rowId: optionalValueRowId(cardId, OPENAI_RESETS_ROW_KEY, OPENAI_RESETS_ROW_RESULT_TYPE),
      label: OPENAI_RESETS_ROW_LABEL,
      info: OPENAI_RESETS_INFO,
    },
    {
      rowId: optionalValueRowId(cardId, OPENAI_CREDITS_ROW_KEY, OPENAI_CREDITS_ROW_RESULT_TYPE),
      label: OPENAI_CREDITS_ROW_LABEL,
      info: OPENAI_CREDITS_INFO,
    },
  ];
}

function latestObservedAtIso(entries: readonly QuotaToastEntry[]): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const entry of entries) {
    const iso = entry.accounting.observedAtIso;
    if (iso === undefined) continue;
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed) || parsed <= latestMs) continue;
    latestMs = parsed;
    latest = iso;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Card assembly
// ---------------------------------------------------------------------------

function dedupeAccounts(accounts: readonly QuotaProviderAccount[]): QuotaProviderAccount[] {
  const seen = new Set<string>();
  const output: QuotaProviderAccount[] = [];
  for (const account of accounts) {
    if (seen.has(account.sourceId)) continue;
    seen.add(account.sourceId);
    output.push(account);
  }
  return output;
}

function pushInto<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function buildProviderCard(params: {
  providerId: string;
  providerLabel: string;
  entries: readonly QuotaToastEntry[];
  errors: readonly QuotaToastError[];
  secrets: readonly string[];
  preferences: ProviderCardPreferences;
  nowMs: number;
}): ProviderCard {
  const cardId = buildProviderScopeCardId(params.providerId);
  const card: ProviderCard = {
    cardId,
    providerId: params.providerId,
    providerLabel: params.providerLabel,
    labelSource: "provider",
    rows: mapEntryRows({
      entries: params.entries,
      cardId,
      preferences: params.preferences,
      nowMs: params.nowMs,
    }),
    errors: params.errors.map((error) => mapProviderError(error, params.secrets)),
  };
  if (params.providerId === "openai") card.visibilityRows = openAiOptionalVisibilityRows(cardId);
  const observedAtIso = latestObservedAtIso(params.entries);
  if (observedAtIso) card.observedAtIso = observedAtIso;
  return card;
}

function buildAccountCard(params: {
  providerId: string;
  providerLabel: string;
  account: QuotaProviderAccount;
  accountIndex: number;
  entries: readonly QuotaToastEntry[];
  errors: readonly QuotaToastError[];
  secrets: readonly string[];
  preferences: ProviderCardPreferences;
  nowMs: number;
}): ProviderCard {
  const identityKey = params.account.identityKey?.trim()
    ? params.account.identityKey
    : params.account.sourceId;
  const cardId = buildCardId(params.providerId, identityKey);
  const rawLabel = params.account.label?.trim();
  const sanitizedLabel = rawLabel ? sanitizeSingleLineDisplayText(rawLabel) : "";
  const card: ProviderCard = {
    cardId,
    providerId: params.providerId,
    providerLabel: params.providerLabel,
    // Display-only fallback numbering; never an identity input.
    accountLabel: sanitizedLabel || `Account ${params.accountIndex + 1}`,
    labelSource: sanitizedLabel ? "connection" : "account",
    rows: mapEntryRows({
      entries: params.entries,
      cardId,
      preferences: params.preferences,
      nowMs: params.nowMs,
    }),
    errors: params.errors.map((error) => mapProviderError(error, params.secrets)),
  };
  if (params.providerId === "openai") card.visibilityRows = openAiOptionalVisibilityRows(cardId);
  const observedAtIso = latestObservedAtIso(params.entries);
  if (observedAtIso) card.observedAtIso = observedAtIso;
  return card;
}

/**
 * Stable probe ordering by saved provider preference: listed providers first
 * in saved order, unlisted providers after them in original probe order.
 * Original probe index is the tie-breaker (duplicate ids and unlisted ids).
 */
function orderProbesByProviderPreference(
  probes: readonly QuotaStatusLiveProbe[],
  providerOrder: readonly string[] | undefined,
): readonly QuotaStatusLiveProbe[] {
  if (providerOrder === undefined || providerOrder.length === 0) return probes;
  const rankByProviderId = new Map<string, number>();
  for (const [rank, providerId] of providerOrder.entries()) {
    if (!rankByProviderId.has(providerId)) rankByProviderId.set(providerId, rank);
  }
  return probes
    .map((probe, originalIndex) => ({
      probe,
      originalIndex,
      rank: rankByProviderId.get(probe.providerId) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => (a.rank === b.rank ? a.originalIndex - b.originalIndex : a.rank - b.rank))
    .map(({ probe }) => probe);
}

/**
 * One card per discovered account (zero-entry and failed ones included) plus a
 * provider-scope card for unscoped content or when no account was discovered.
 * Cards keep probe (provider-registration) order, optionally reordered by the
 * saved provider preference; a provider-scope card precedes its account cards.
 * Provider-level failures never invent an account.
 */
export function buildProviderCards(input: BuildProviderCardsInput): ProviderCard[] {
  const labelFor = input.providerLabel ?? getQuotaProviderDisplayLabel;
  const cards: ProviderCard[] = [];
  const seenCardIds = new Set<CardId>();
  const probes = orderProbesByProviderPreference(input.probes, input.preferences.providerOrder);

  for (const probe of probes) {
    const providerId = probe.providerId;
    const providerLabel = sanitizeSingleLineDisplayText(labelFor(providerId));
    const accounts = dedupeAccounts(probe.result.accounts ?? []);
    const accountSourceIds = new Set(accounts.map((account) => account.sourceId));
    const secrets = collectRawIdentities(probe);
    const preferences = input.preferences;
    const nowMs = input.nowMs;

    const entriesBySource = new Map<string, QuotaToastEntry[]>();
    const errorsBySource = new Map<string, QuotaToastError[]>();
    const unscopedEntries: QuotaToastEntry[] = [];
    const unscopedErrors: QuotaToastError[] = [];

    for (const entry of probe.result.entries) {
      const sourceId = entry.accounting.sourceId;
      if (sourceId !== undefined && accountSourceIds.has(sourceId)) {
        pushInto(entriesBySource, sourceId, entry);
      } else {
        unscopedEntries.push(entry);
      }
    }
    for (const error of probe.result.errors) {
      const sourceId = error.sourceId;
      if (sourceId !== undefined && accountSourceIds.has(sourceId)) {
        pushInto(errorsBySource, sourceId, error);
      } else {
        unscopedErrors.push(error);
      }
    }

    const hasUnscopedContent = unscopedEntries.length > 0 || unscopedErrors.length > 0;
    if (hasUnscopedContent || (accounts.length === 0 && probe.result.attempted)) {
      const card = buildProviderCard({
        providerId,
        providerLabel,
        entries: unscopedEntries,
        errors: unscopedErrors,
        secrets,
        preferences,
        nowMs,
      });
      if (!seenCardIds.has(card.cardId)) {
        seenCardIds.add(card.cardId);
        cards.push(card);
      }
    }

    for (const [accountIndex, account] of accounts.entries()) {
      const card = buildAccountCard({
        providerId,
        providerLabel,
        account,
        accountIndex,
        entries: entriesBySource.get(account.sourceId) ?? [],
        errors: errorsBySource.get(account.sourceId) ?? [],
        secrets,
        preferences,
        nowMs,
      });
      if (seenCardIds.has(card.cardId)) continue;
      seenCardIds.add(card.cardId);
      cards.push(card);
    }
  }

  return cards;
}
