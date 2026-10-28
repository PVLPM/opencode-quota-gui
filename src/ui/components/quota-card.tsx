import type { JSX } from "solid-js";
import { createMemo, For, Show } from "solid-js";
import type { AccountingUnit, ProviderCard, QuotaCardRow } from "../../contracts/dashboard";
import type { BankedResetAvailability, BankedResetCredit } from "../../contracts/openai-quota";
import { formatPercent, formatRunway, formatTimestamp } from "../format";
import { Icon, Tooltip } from "../opencode-ui";
import { formatResetCountdown } from "../reset-format";
import { visibleRows } from "../view-model";
import { ProviderLogo } from "./provider-logo";

/**
 * One provider account card (design spec §10 "Home").
 *
 * Rows map the four entry kinds 1:1: label left, value right, a compact percent
 * bar for percent rows, a muted countdown, the runway sentence when the user
 * enabled it, and detail rows only when `accountingDetail` is `detailed`. Errors
 * stay card-local, and a card with no account label reports a provider-level
 * error rather than inventing an account.
 */

export interface DisplayPreferences {
  /** The frontend picks the shown percent; both numbers arrive in the row. */
  percentMode: "used" | "remaining";
  percentLabelStyle?: "full" | "bare";
  showRunway: boolean;
  detailed: boolean;
  /** Saved presentation order from `dashboard.cardOrder`; non-empty is authoritative. */
  cardOrder?: readonly string[];
  /** Legacy `dashboard.providerOrder`, used when `cardOrder` is empty. */
  providerOrder?: readonly string[];
}

export function unitSuffix(unit: AccountingUnit | undefined): string {
  if (!unit) return "";
  switch (unit.kind) {
    case "currency":
      return unit.code;
    case "custom":
      return unit.symbol;
    default:
      return unit.unit === "unit" ? "" : unit.unit;
  }
}

/** Currency rows show exactly two decimals; other units keep the exact server decimal. */
export function formatCurrencyDecimal(decimal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(decimal);
  if (!match) return decimal;
  const [, sign = "", integer = "0", fraction = ""] = match;
  const cents = Number(`${fraction}000`.slice(0, 2));
  const roundedCents = cents + (Number(fraction.charAt(2) || "0") >= 5 ? 1 : 0);
  let whole = BigInt(integer);
  let displayedCents = roundedCents;
  if (displayedCents === 100) {
    whole += 1n;
    displayedCents = 0;
  }
  const negative = sign === "-" && (whole !== 0n || displayedCents !== 0);
  return `${negative ? "-" : ""}${whole}.${String(displayedCents).padStart(2, "0")}`;
}

/** The value cell text for a row, by entry kind. */
export function rowValueText(row: QuotaCardRow, preferences: DisplayPreferences): string {
  switch (row.kind) {
    case "percent": {
      const value = formatPercent(rowPercent(row, preferences));
      return preferences.percentLabelStyle === "bare" || value === "—"
        ? value
        : `${value} ${preferences.percentMode}`;
    }
    case "quantity": {
      if (!row.quantity) return "—";
      const suffix = unitSuffix(row.quantity.unit);
      const amount =
        row.quantity.unit.kind === "currency"
          ? formatCurrencyDecimal(row.quantity.decimal)
          : row.quantity.decimal;
      return suffix ? `${amount} ${suffix}` : amount;
    }
    case "boolean":
      return row.booleanValue === undefined ? "—" : row.booleanValue ? "yes" : "no";
    default:
      return row.value ?? "—";
  }
}

/** Optional opposite-only values must be complemented, never relabelled unchanged. */
export function rowPercent(row: QuotaCardRow, preferences: DisplayPreferences): number | undefined {
  if (row.kind !== "percent") return undefined;
  const direct = preferences.percentMode === "used" ? row.percentUsed : row.percentRemaining;
  if (direct !== undefined) return direct;
  const opposite = preferences.percentMode === "used" ? row.percentRemaining : row.percentUsed;
  return opposite === undefined ? undefined : 100 - opposite;
}

/**
 * True used quota for severity; the bar itself paints the displayed percentage,
 * so the badge's used/remaining direction never moves the exhaustion boundary.
 */
export function quotaUsedPercent(row: QuotaCardRow): number | undefined {
  if (row.kind !== "percent") return undefined;
  return (
    row.percentUsed ?? (row.percentRemaining === undefined ? undefined : 100 - row.percentRemaining)
  );
}

/**
 * Severity band for a percent row, derived only from the true used quota so the
 * badge's used/remaining preference never moves the boundary. Critical is
 * used ≥ 90% (equivalently ≤ 10% remaining), warning is used 70–89.9%, and
 * everything below the warning band is healthy.
 */
export function quotaSeverity(usedPercent: number | undefined): "healthy" | "warning" | "critical" {
  if (usedPercent === undefined) return "healthy";
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 70) return "warning";
  return "healthy";
}

/**
 * Two independent segments: the displayed percentage fills the accent segment
 * and the complement is the neutral segment. The boundary gap is the original
 * 3 px notch capped to half of either side, so tiny values stay visible.
 */
export function QuotaBar(props: {
  label: string;
  displayPercent: number;
  displayMode: "used" | "remaining";
}): JSX.Element {
  const position = () => Math.min(Math.max(props.displayPercent, 0), 100);
  return (
    <span
      class="qg-row__bar"
      data-mode={props.displayMode}
      style={{ "--qg-used-position": `${position()}%` }}
    >
      <meter
        class="sr-only"
        aria-label={`${props.label} quota ${props.displayMode}`}
        min={0}
        max={100}
        value={position()}
        aria-valuetext={`${position()}% ${props.displayMode}`}
      />
      <Show when={position() > 0}>
        <span class="qg-row__bar-fill" aria-hidden="true" />
      </Show>
      <Show when={position() < 100}>
        <span class="qg-row__bar-remaining" aria-hidden="true" />
      </Show>
    </span>
  );
}

/** Only unwrap the exact generated `[provider] (label)` form; never infer identity. */
export function inlineAccountLabel(provider: string, account: string): string {
  const prefix = `[${provider}] (`;
  if (account.startsWith(prefix) && account.endsWith(")")) {
    const label = account.slice(prefix.length, -1);
    if (label.length > 0 && !/[()[\]\r\n]/.test(label)) return label;
  }
  return account;
}

type ResetSegmentKind = "known" | "none" | "unknown";

interface ResetSegment {
  kind: ResetSegmentKind;
  title?: string;
  expiresAtIso?: string;
  expiresAtMs?: number;
}

function resetTitle(segment: ResetSegment): string {
  return segment.title ?? "Full reset";
}

function resetExpiryLine(segment: ResetSegment, timeZone: string): string {
  if (segment.kind === "known" && segment.expiresAtMs !== undefined) {
    return `Expires ${formatTimestamp(segment.expiresAtMs, timeZone)}`;
  }
  return segment.kind === "none" ? "No expiry" : "Expiry unknown";
}

function resetRelativeLine(segment: ResetSegment): string | undefined {
  if (segment.kind !== "known" || segment.expiresAtIso === undefined) return undefined;
  const countdown = formatResetCountdown(segment.expiresAtIso);
  if (countdown === "reset") return "Expired";
  return countdown.length > 0 ? `In ${countdown}` : undefined;
}

function resetSummary(segments: readonly ResetSegment[]): string {
  const nearest = segments.find((segment) => segment.kind === "known");
  if (nearest) {
    const countdown =
      nearest.expiresAtIso === undefined ? "" : formatResetCountdown(nearest.expiresAtIso);
    if (countdown === "reset") return "Nearest expiry has passed";
    if (countdown.length > 0) return `Expires in ${countdown}`;
  }
  return segments.some((segment) => segment.kind === "unknown") ? "Expiry unknown" : "No expiry";
}

function resetAriaLabel(
  segment: ResetSegment,
  index: number,
  total: number,
  timeZone: string,
): string {
  const relative = resetRelativeLine(segment);
  return [
    `Reset ${index + 1} of ${total}`,
    resetTitle(segment),
    resetExpiryLine(segment, timeZone),
    ...(relative === undefined ? [] : [relative]),
  ].join(". ");
}

function segmentForCredit(credit: BankedResetCredit): ResetSegment {
  const title = credit.title?.trim();
  const base = title === undefined || title.length === 0 ? {} : { title };
  if (credit.expiresAtIso === null) return { kind: "none", ...base };
  if (credit.expiresAtIso === undefined) return { kind: "unknown", ...base };
  const expiresAtMs = Date.parse(credit.expiresAtIso);
  return Number.isFinite(expiresAtMs)
    ? { kind: "known", expiresAtIso: credit.expiresAtIso, expiresAtMs, ...base }
    : { kind: "unknown", ...base };
}

/**
 * The count is authoritative; detail records only supply expiry metadata. Known
 * expiries lead nearest-first, explicit no-expiry records follow, and missing or
 * invalid detail stays unknown rather than becoming an invented countdown.
 */
function resetSegments(availability: BankedResetAvailability | undefined): ResetSegment[] {
  const count = availability?.availableCount;
  if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return [];
  const total = Math.floor(count);
  const credits = Array.isArray(availability?.credits) ? availability.credits : [];
  const classified = credits.map(segmentForCredit);
  const known = classified
    .filter((segment) => segment.kind === "known")
    .sort((left, right) => (left.expiresAtMs ?? 0) - (right.expiresAtMs ?? 0));
  const none = classified.filter((segment) => segment.kind === "none");
  const unknown = classified.filter((segment) => segment.kind === "unknown");
  const supplied = [...known, ...none, ...unknown].slice(0, total);
  const placeholders = Array.from(
    { length: Math.max(0, total - supplied.length) },
    (): ResetSegment => ({ kind: "unknown" }),
  );
  return [...supplied, ...placeholders];
}

function isOpenAiProvider(providerId: string): boolean {
  return providerId === "openai";
}

/**
 * OpenAI reset rows carry explicit banked-reset metadata; a display label is
 * never an identity. Other providers may use the same wording for normal rows.
 */
function isOpenAiResetsRow(row: QuotaCardRow): boolean {
  return row.bankedResets !== undefined;
}

/**
 * The backend's balance result type is the stable OpenAI credit identity. A
 * malformed balance row with a percent/quantity shape is still credits, so it
 * is suppressed rather than drawing unrelated graphics.
 */
function isOpenAiCreditsRow(row: QuotaCardRow): boolean {
  return row.resultType === "balance";
}

function hasPositiveCreditsValue(value: string | undefined): boolean {
  if (value === "Unlimited") return true;
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

function isSuppressedOptionalRow(row: QuotaCardRow, providerId: string): boolean {
  if (!isOpenAiProvider(providerId)) return false;
  if (isOpenAiResetsRow(row)) return resetSegments(row.bankedResets).length === 0;
  if (isOpenAiCreditsRow(row)) return row.kind !== "value" || !hasPositiveCreditsValue(row.value);
  return false;
}

function RowInfo(props: { label: string; info: string }): JSX.Element {
  return (
    <Tooltip
      value={props.info}
      triggerTabIndex={0}
      appearance="large"
      contentClass="qg-row__tooltip"
    >
      <span class="sr-only">More information about {props.label}</span>
      <span class="qg-row__info" aria-hidden="true">
        <Icon name="info" size="small" />
      </span>
    </Tooltip>
  );
}

function ResetSegmentTooltip(props: { segment: ResetSegment; timeZone: string }): JSX.Element {
  const relative = () => resetRelativeLine(props.segment);
  return (
    <span class="qg-reset__tooltip-body">
      <span class="qg-reset__tooltip-title">{resetTitle(props.segment)}</span>
      <span>{resetExpiryLine(props.segment, props.timeZone)}</span>
      <Show when={relative()}>{(line) => <span>{line()}</span>}</Show>
    </span>
  );
}

function ResetRow(props: { row: QuotaCardRow; timeZone: string }): JSX.Element {
  const segments = createMemo(() => resetSegments(props.row.bankedResets));
  const summary = createMemo(() => resetSummary(segments()));
  return (
    <div class="qg-row qg-row--resets" data-kind="value">
      <span class="qg-row__labelgroup">
        <span class="qg-row__label">{props.row.label}</span>
        <Show when={props.row.info}>
          {(info) => <RowInfo label={props.row.label} info={info()} />}
        </Show>
        <span class="qg-reset__count">{segments().length} available</span>
      </span>
      <span class="qg-reset__summary">{summary()}</span>
      <fieldset
        class="qg-reset__segments"
        aria-label="Available reset expiries"
        data-count={segments().length}
        style={{ "--qg-reset-count": segments().length }}
      >
        <For each={segments()}>
          {(segment, index) => (
            <Tooltip
              class="qg-reset__tip"
              value={<ResetSegmentTooltip segment={segment} timeZone={props.timeZone} />}
              triggerTabIndex={0}
              appearance="large"
              contentClass="qg-reset__tooltip"
            >
              <span class="sr-only">
                {resetAriaLabel(segment, index(), segments().length, props.timeZone)}
              </span>
              <span class="qg-reset__segment" data-expiry={segment.kind} aria-hidden="true" />
            </Tooltip>
          )}
        </For>
      </fieldset>
    </div>
  );
}

export function QuotaCardView(props: {
  card: ProviderCard;
  preferences: DisplayPreferences;
  hiddenRows: string[];
  stale: boolean;
  timeZone: string;
}): JSX.Element {
  /**
   * Visibility is presentation-only and managed in Settings, never on Home.
   */
  const shownRows = () => visibleRows(props.card.rows, props.hiddenRows);
  const displayRows = () =>
    shownRows().filter((row) => !isSuppressedOptionalRow(row, props.card.providerId));

  return (
    <article class="qg-card" data-error={props.card.errors.length > 0 ? "true" : undefined}>
      <header class="qg-card__head">
        <div class="qg-card__identity">
          <ProviderLogo providerId={props.card.providerId} class="qg-card__logo" />
          <span class="qg-card__provider">{props.card.providerLabel}</span>
          <Show when={props.card.planLabel}>
            {(plan) => (
              <span class="qg-card__account">
                <span aria-hidden="true">· </span>
                {plan()}
              </span>
            )}
          </Show>
          <Show when={props.card.accountLabel}>
            {(account) => (
              <span class="qg-card__account">
                <span aria-hidden="true">· </span>
                {inlineAccountLabel(props.card.providerLabel, account())}
              </span>
            )}
          </Show>
        </div>
      </header>

      <Show when={props.card.errors.length > 0}>
        <div class="qg-card__errors">
          <For each={props.card.errors}>
            {(error) => (
              <p class="qg-error" data-level={props.card.accountLabel ? "account" : "provider"}>
                <span class="qg-error__label">
                  {props.card.accountLabel ? error.label : `Provider-level error · ${error.label}`}
                </span>
                <span class="qg-error__message">{error.message}</span>
              </p>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={displayRows().length > 0}
        fallback={
          <>
            <Show when={props.card.rows.length === 0}>
              <Show when={props.card.errors.length === 0}>
                <p class="qg-muted">No quota rows are reported for this account.</p>
              </Show>
            </Show>
            <Show when={props.card.rows.length > 0 && shownRows().length === 0}>
              <p class="qg-muted">
                Every row on this card is hidden — clear them in Settings → Visibility.
              </p>
            </Show>
            <Show when={props.card.rows.length > 0 && shownRows().length > 0}>
              <Show when={props.card.errors.length === 0}>
                <p class="qg-muted">No quota rows are reported for this account.</p>
              </Show>
            </Show>
          </>
        }
      >
        <div class="qg-card__rows">
          <For each={displayRows()}>
            {(row) =>
              isOpenAiProvider(props.card.providerId) && isOpenAiResetsRow(row) ? (
                <ResetRow row={row} timeZone={props.timeZone} />
              ) : (
                <div
                  class="qg-row"
                  data-kind={row.kind}
                  data-severity={
                    row.kind === "percent" ? quotaSeverity(quotaUsedPercent(row)) : undefined
                  }
                >
                  <span class="qg-row__labelgroup">
                    <span class="qg-row__label">{row.label}</span>
                    <Show when={row.info}>
                      {(info) => <RowInfo label={row.label} info={info()} />}
                    </Show>
                  </span>
                  <span class="qg-row__value">{rowValueText(row, props.preferences)}</span>
                  <Show when={row.countdown}>
                    <span class="qg-row__reset">Resets in {row.countdown}</span>
                  </Show>
                  <Show when={rowPercent(row, props.preferences) !== undefined}>
                    <QuotaBar
                      label={row.label}
                      displayPercent={rowPercent(row, props.preferences) ?? 0}
                      displayMode={props.preferences.percentMode}
                    />
                  </Show>
                  <Show
                    when={
                      props.preferences.showRunway
                        ? formatRunway(row.runway, props.timeZone)
                        : undefined
                    }
                  >
                    <span class="qg-row__meta">
                      <Show
                        when={
                          props.preferences.showRunway
                            ? formatRunway(row.runway, props.timeZone)
                            : undefined
                        }
                      >
                        {(runway) => <span>{runway()}</span>}
                      </Show>
                    </span>
                  </Show>
                  <Show when={props.preferences.detailed && (row.detailRows?.length ?? 0) > 0}>
                    <table class="qg-detail-rows">
                      <tbody>
                        <For each={row.detailRows ?? []}>
                          {(detail) => (
                            <tr>
                              <th scope="row">{detail.label}</th>
                              <td>{detail.value}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                </div>
              )
            }
          </For>
        </div>
      </Show>

      <Show when={(props.card.details?.length ?? 0) > 0}>
        <details class="qg-details">
          <summary>Details</summary>
          <table class="qg-detail-rows">
            <tbody>
              <For each={props.card.details ?? []}>
                {(detail) => (
                  <tr>
                    <th scope="row">{detail.label}</th>
                    <td>{detail.value}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </details>
      </Show>
    </article>
  );
}
