import { orderCardsByPreference } from "../contracts/card-order.js";
import type {
  PrimaryQuotaWindowSlot,
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
} from "../contracts/dashboard.js";
import type { TemporalProviderStatus } from "../contracts/temporal.js";
import { formatPercent } from "../ui/format.js";
import {
  type DisplayPreferences,
  quotaSeverity,
  quotaUsedPercent,
  rowPercent,
  rowValueText,
} from "../ui/quota-semantics.js";
import {
  formatTemporalCountdown,
  temporalModelNextChange,
  temporalModelStateAt,
} from "../ui/temporal-format.js";
import { visibleCards, visibleRows } from "../ui/view-model.js";

/**
 * The `session.header` Slot's product model (Stage 6).
 *
 * The Slot is an additive, compact view of the same quota cards the Panel
 * renders. This module is deliberately pure: it turns one `QuotaSnapshot`, the
 * shared settings visibility/order and the existing temporal helpers into
 * header tokens and preview rows. No DOM, transport, timer or poller lives
 * here.
 *
 * Ring membership comes only from the server's additive
 * `ProviderCard.primaryQuotaWindows`: unique references to existing percent
 * rows, already capped at three and already stripped of budget/spend/auxiliary
 * percentages. Each reference carries the provider-defined stable `slot`
 * (0 outer, 1 middle, 2 inner), so a missing earlier window leaves later rings
 * on their original track. The Slot resolves the reference by `rowId` and never
 * infers a ring (or a slot) from a label, an ordinal, a result type or current
 * utilization. An absent field means the provider/card has no defensible
 * primary mapping; it is not an empty quota and produces no rings. The card is
 * still eligible: it keeps a zero-ring (logo-only) token and all of its
 * meaningful percent rows stay in the combined preview.
 */

/** Height/width of one ring token; mirrored by `session-header.css`. */
export const SLOT_TOKEN_SIZE = 28;
export const SLOT_TOKEN_GAP = 4;
/** Narrowest `+N` chip; wider counts grow by their extra digits. */
export const SLOT_OVERFLOW_MIN_WIDTH = 30;

/** Title room the Slot leaves before claiming header width. */
export const HEADER_TITLE_MIN_WIDTH = 96;
const HEADER_TITLE_MIN_SHARE = 0.25;
export const HEADER_ACTIONS_GAP = 8;
export const HEADER_ACTIONS_MARGIN = 6;

/** Peak is now, or begins within this window (inclusive). */
export const PEAK_SOON_WINDOW_MS = 60 * 60 * 1000;

export type HeaderRingSeverity = "healthy" | "warning" | "critical";
export type HeaderPeak = "now" | "soon";

export interface HeaderRing {
  rowId: string;
  /** Stable provider-defined ring position: 0 outer, 1 middle, 2 inner. */
  slot: PrimaryQuotaWindowSlot;
  label: string;
  /** Clamped displayed percentage, following the used/remaining preference. */
  percent: number;
  usedPercent?: number;
  severity: HeaderRingSeverity;
  /** Compact reset context already formatted by the shared card projection. */
  countdown?: string;
}

export interface HeaderPreviewRow {
  rowId: string;
  label: string;
  percent: number;
  usedPercent?: number;
  severity: HeaderRingSeverity;
  valueText: string;
  countdown?: string;
}

export interface HeaderCard {
  cardId: string;
  providerId: string;
  providerLabel: string;
  planLabel?: string;
  accountLabel?: string;
  /**
   * Zero to three concentric primary usage windows, sorted by their stable
   * slot. Empty means no classified primary window, never an empty or zero
   * quota; the card still has a token and its rows remain in the combined
   * preview. A hidden or missing window leaves its slot empty instead of
   * compacting later rings into an earlier track.
   */
  rings: HeaderRing[];
  /** Every meaningful visible percentage row, including auxiliary metrics. */
  previewRows: HeaderPreviewRow[];
  peak?: HeaderPeak;
  /** Earliest supported upcoming Peak, only when `peak === "soon"`. */
  peakAtMs?: number;
  ariaLabel: string;
}

export interface SessionHeaderView {
  /**
   * One token per visible card with a meaningful percentage row, in saved
   * card order. A card without a classified primary window keeps a token with
   * zero rings; eligibility and preview inclusion do not depend on the
   * optional primary metadata.
   */
  cards: HeaderCard[];
  /**
   * Timestamp this view was built with. It advances when the shared quota
   * snapshot or settings refresh, so the preview's Peak countdown can follow
   * the latest data without a timer or a second clock.
   */
  nowMs: number;
}

export interface SessionHeaderModelInput {
  snapshot: QuotaSnapshot | undefined;
  hiddenCards: readonly string[];
  hiddenRows: readonly string[];
  preferences: DisplayPreferences;
  temporalOverrides?: Readonly<Record<string, boolean>>;
  /** True when the payload, transport or host may no longer be fresh. */
  stale?: boolean;
  nowMs: number;
}

function isPercentValue(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

export function clampPercent(value: number): number {
  return Math.min(Math.max(value, 0), 100);
}

/**
 * Result types a primary reference may legitimately point at. The DTO guard
 * enforces this too; the pure model repeats it so a malformed reference can
 * never turn a budget or auxiliary percentage into a ring.
 */
const RING_RESULT_TYPES: ReadonlySet<QuotaCardRow["resultType"]> = new Set(["quota", "rate_limit"]);

function isPrimaryQuotaWindowSlot(value: number): value is PrimaryQuotaWindowSlot {
  return value === 0 || value === 1 || value === 2;
}

export interface PrimaryRingRow {
  row: QuotaCardRow;
  slot: PrimaryQuotaWindowSlot;
}

/**
 * Resolves the server's primary references against this card's visible rows.
 * The reference's `slot` is authoritative: a referenced row the user hid, or
 * one missing from the payload, contributes no ring and leaves that track
 * empty. Later windows never compact into an earlier slot, so the weekly ring
 * stays in the middle whether the 5h window is present, hidden or absent.
 *
 * Defensive checks repeat the DTO guard's rules: a reference pointing at a
 * non-percent row, an out-of-range slot, a repeated rowId or a repeated slot is
 * ignored, and the result is capped at three. Rings are returned in slot order
 * so the renderer can paint outside-in without trusting the payload's array
 * order.
 */
export function primaryRingRows(
  card: ProviderCard,
  hiddenRows: readonly string[],
  preferences: DisplayPreferences,
): PrimaryRingRow[] {
  const references = card.primaryQuotaWindows;
  if (references === undefined || references.length === 0) return [];
  const rowsById = new Map(
    visibleRows(card.rows, [...hiddenRows])
      .filter(
        (row) =>
          row.kind === "percent" &&
          RING_RESULT_TYPES.has(row.resultType) &&
          isPercentValue(rowPercent(row, preferences)),
      )
      .map((row) => [row.rowId, row] as const),
  );
  const rings: PrimaryRingRow[] = [];
  const seenRows = new Set<string>();
  const seenSlots = new Set<PrimaryQuotaWindowSlot>();
  for (const reference of references) {
    // Claim both identities before resolution: a hidden or missing row keeps
    // its slot reserved, and a malformed duplicate cannot steal another track.
    if (
      !isPrimaryQuotaWindowSlot(reference.slot) ||
      seenRows.has(reference.rowId) ||
      seenSlots.has(reference.slot)
    ) {
      continue;
    }
    seenRows.add(reference.rowId);
    seenSlots.add(reference.slot);
    const row = rowsById.get(reference.rowId);
    if (row === undefined) continue;
    rings.push({ row, slot: reference.slot });
    if (rings.length === 3) break;
  }
  return rings.sort((left, right) => left.slot - right.slot);
}

/** Every meaningful percent row, in full-card order; auxiliary rows have no ring but stay in preview. */
export function previewPercentRows(
  card: ProviderCard,
  hiddenRows: readonly string[],
  preferences: DisplayPreferences,
): QuotaCardRow[] {
  return visibleRows(card.rows, [...hiddenRows]).filter(
    (row) => row.kind === "percent" && isPercentValue(rowPercent(row, preferences)),
  );
}

function toRing(entry: PrimaryRingRow, preferences: DisplayPreferences): HeaderRing {
  const used = quotaUsedPercent(entry.row);
  const ring: HeaderRing = {
    rowId: entry.row.rowId,
    slot: entry.slot,
    label: entry.row.label,
    percent: clampPercent(rowPercent(entry.row, preferences) ?? 0),
    severity: quotaSeverity(used),
  };
  if (used !== undefined) ring.usedPercent = used;
  if (entry.row.countdown !== undefined) ring.countdown = entry.row.countdown;
  return ring;
}

function toPreviewRow(row: QuotaCardRow, preferences: DisplayPreferences): HeaderPreviewRow {
  const used = quotaUsedPercent(row);
  return {
    rowId: row.rowId,
    label: row.label,
    percent: clampPercent(rowPercent(row, preferences) ?? 0),
    ...(used === undefined ? {} : { usedPercent: used }),
    severity: quotaSeverity(used),
    valueText: rowValueText(row, preferences),
    ...(row.countdown === undefined ? {} : { countdown: row.countdown }),
  };
}

function providerTemporalStatus(
  snapshot: QuotaSnapshot,
  providerId: string,
): TemporalProviderStatus | undefined {
  return snapshot.temporal?.providers.find((provider) => provider.providerId === providerId);
}

/**
 * Red wins: any relevant model currently Peak makes the dot red. Otherwise the
 * earliest supported transition into Peak within the next 60 minutes makes it
 * yellow. An unknown destination or an unavailable provider yields no dot.
 */
export function peakForProvider(
  provider: TemporalProviderStatus | undefined,
  nowMs: number,
): { peak: HeaderPeak; atMs?: number } | undefined {
  if (provider === undefined) return undefined;
  let soonest: number | undefined;
  for (const model of provider.models) {
    if (temporalModelStateAt(model, nowMs).state === "peak") return { peak: "now" };
    const next = temporalModelNextChange(model, nowMs);
    if (next === undefined || next.phase !== "peak") continue;
    const delta = next.atMs - nowMs;
    if (delta <= 0 || delta > PEAK_SOON_WINDOW_MS) continue;
    if (soonest === undefined || next.atMs < soonest) soonest = next.atMs;
  }
  return soonest === undefined ? undefined : { peak: "soon", atMs: soonest };
}

function cardAriaLabel(
  card: ProviderCard,
  rings: readonly HeaderRing[],
  preferences: DisplayPreferences,
  peak: HeaderPeak | undefined,
): string {
  const identity = [card.providerLabel, card.planLabel, card.accountLabel]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join(", ");
  const ringText =
    rings.length === 0
      ? "Quota details in preview"
      : rings
          .map((ring) => {
            const severity =
              ring.severity === "healthy"
                ? ""
                : `, ${ring.severity === "critical" ? "critical" : "warning"}`;
            return `${ring.label} ${formatPercent(ring.percent)} ${preferences.percentMode}${severity}`;
          })
          .join("; ");
  const peakText = peak === "now" ? "Peak now" : peak === "soon" ? "Peak within an hour" : "";
  return [identity, ringText, peakText].filter(Boolean).join(". ");
}

/**
 * Builds one token's data for a visible card. A card with percent rows but no
 * defensible primary mapping still gets a token with zero rings; a card with
 * no meaningful percentage row belongs only in the full Panel.
 */
function toHeaderCard(
  snapshot: QuotaSnapshot,
  card: ProviderCard,
  input: SessionHeaderModelInput,
): HeaderCard | undefined {
  if (card.rows.length === 0) return undefined;
  const previewRows = previewPercentRows(card, input.hiddenRows, input.preferences).map((row) =>
    toPreviewRow(row, input.preferences),
  );
  if (previewRows.length === 0) return undefined;

  const temporal = providerTemporalStatus(snapshot, card.providerId);
  const overrides = input.temporalOverrides ?? input.preferences.temporalProviderOverrides;
  const peak =
    overrides?.[card.providerId] === false ? undefined : peakForProvider(temporal, input.nowMs);
  const rings = primaryRingRows(card, input.hiddenRows, input.preferences).map((entry) =>
    toRing(entry, input.preferences),
  );

  const header: HeaderCard = {
    cardId: card.cardId,
    providerId: card.providerId,
    providerLabel: card.providerLabel,
    rings,
    previewRows,
    ariaLabel: cardAriaLabel(card, rings, input.preferences, peak?.peak),
  };
  if (card.planLabel !== undefined) header.planLabel = card.planLabel;
  if (card.accountLabel !== undefined) header.accountLabel = card.accountLabel;
  if (peak !== undefined) {
    header.peak = peak.peak;
    if (peak.atMs !== undefined) header.peakAtMs = peak.atMs;
  }
  return header;
}

/**
 * Builds the Slot from one shared snapshot. A stale payload produces no
 * tokens: last-known values are never dressed as fresh, healthy or zero rings.
 * A loading/error card with no meaningful percentage row remains in the full
 * Panel only.
 */
export function buildSessionHeaderView(input: SessionHeaderModelInput): SessionHeaderView {
  const snapshot = input.snapshot;
  if (snapshot === undefined || input.stale === true || snapshot.stale === true) {
    return { cards: [], nowMs: input.nowMs };
  }
  const ordered = orderCardsByPreference(
    visibleCards(snapshot.providers.cards, [...input.hiddenCards]),
    input.preferences.cardOrder,
    input.preferences.providerOrder,
  );
  const cards: HeaderCard[] = [];
  for (const card of ordered) {
    const header = toHeaderCard(snapshot, card, input);
    if (header !== undefined) cards.push(header);
  }
  return { cards, nowMs: input.nowMs };
}

/** Peak copy for the combined preview: no Off-Peak commentary, ever. */
export function peakPreviewText(
  peak: HeaderPeak | undefined,
  peakAtMs: number | undefined,
  nowMs: number,
): string | undefined {
  if (peak === "now") return "Peak now";
  if (peak === "soon" && peakAtMs !== undefined) {
    // The snapshot can predate the transition by up to one poll interval; once
    // the stored target has passed, calling it Peak now is truer than "<1m".
    if (peakAtMs <= nowMs) return "Peak now";
    const countdown = formatTemporalCountdown(nowMs, peakAtMs);
    return countdown.length > 0 ? `Peak in ${countdown}` : "Peak now";
  }
  return undefined;
}

/* --------------------------------------------------------------- geometry */

export interface TokenFit {
  visibleCount: number;
  hiddenCount: number;
  overflowVisible: boolean;
}

export function overflowChipWidth(hiddenCount: number): number {
  return Math.max(SLOT_OVERFLOW_MIN_WIDTH, 14 + String(Math.max(0, hiddenCount)).length * 7);
}

/**
 * Fits complete tokens before one `+N`. The chip's own width is reserved in
 * the same calculation, so the strip never overflows and never oscillates:
 * it depends only on the width the host gives the header, not on the tokens it
 * has already rendered.
 */
export function fitHeaderTokens(params: {
  availableWidth: number;
  tokenCount: number;
  tokenWidth?: number;
  gap?: number;
}): TokenFit {
  const tokenCount = Math.max(0, Math.floor(params.tokenCount));
  if (tokenCount === 0) return { visibleCount: 0, hiddenCount: 0, overflowVisible: false };
  const tokenWidth = params.tokenWidth ?? SLOT_TOKEN_SIZE;
  const gap = params.gap ?? SLOT_TOKEN_GAP;
  const available = Number.isFinite(params.availableWidth) ? Math.max(0, params.availableWidth) : 0;
  const allWidth = tokenCount * tokenWidth + Math.max(0, tokenCount - 1) * gap;
  if (available >= allWidth) {
    return { visibleCount: tokenCount, hiddenCount: 0, overflowVisible: false };
  }

  for (let visible = tokenCount - 1; visible >= 0; visible -= 1) {
    const hidden = tokenCount - visible;
    const tokensWidth = visible === 0 ? 0 : visible * tokenWidth + (visible - 1) * gap + gap;
    if (tokensWidth + overflowChipWidth(hidden) <= available) {
      return { visibleCount: visible, hiddenCount: hidden, overflowVisible: true };
    }
  }
  return { visibleCount: 0, hiddenCount: tokenCount, overflowVisible: false };
}

/** Title space the Slot preserves before it claims the header's remaining width. */
export function headerTitleReserve(layoutWidth: number): number {
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return 0;
  return Math.min(HEADER_TITLE_MIN_WIDTH, Math.max(48, layoutWidth * HEADER_TITLE_MIN_SHARE));
}

/**
 * The width available to this Slot inside the host's `.session-header-actions`.
 * Location, title reserve, the actions' leading margin and every other action
 * (including the host's region-toggle spacer) are subtracted. The Slot's own
 * subtree is never an input, which is what prevents a resize loop.
 */
export function headerTokenBudget(input: {
  layoutWidth: number;
  locationWidth: number;
  otherActionsWidth: number;
  otherActionCount: number;
}): number {
  if (!Number.isFinite(input.layoutWidth) || input.layoutWidth <= 0) return 0;
  const otherGaps = input.otherActionCount > 0 ? input.otherActionCount * HEADER_ACTIONS_GAP : 0;
  return Math.max(
    0,
    Math.floor(
      input.layoutWidth -
        Math.max(0, input.locationWidth) -
        Math.max(0, input.otherActionsWidth) -
        otherGaps -
        HEADER_ACTIONS_MARGIN -
        headerTitleReserve(input.layoutWidth),
    ),
  );
}
