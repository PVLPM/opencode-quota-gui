import type { JSX } from "solid-js";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { ProviderCard, QuotaCardRow } from "../../contracts/dashboard";
import type { BankedResetAvailability, BankedResetCredit } from "../../contracts/openai-quota";
import { formatRunway, formatTimestamp } from "../format";
import { Icon, Tooltip } from "../opencode-ui";
import {
  type DisplayPreferences,
  inlineAccountLabel,
  quotaSeverity,
  quotaUsedPercent,
  rowPercent,
  rowValueText,
} from "../quota-semantics";
import { formatResetCountdown } from "../reset-format";
import { visibleRows } from "../view-model";
import { ProviderLogo } from "./provider-logo";

export {
  type DisplayPreferences,
  formatCurrencyDecimal,
  formatVisibleUsd,
  inlineAccountLabel,
  quotaSeverity,
  quotaUsedPercent,
  rowPercent,
  rowValueText,
  unitSuffix,
} from "../quota-semantics";

/**
 * One provider account card (design spec §10 "Home").
 *
 * Rows map the four entry kinds 1:1: label left, value right, a compact percent
 * bar for percent rows, a muted countdown, and optional detail rows. Errors
 * stay card-local, and a card with no account label reports a provider-level
 * error rather than inventing an account.
 *
 * Pure used/remaining, severity, value-text and identity rules live in
 * `../quota-semantics` and are re-exported here so existing imports and the
 * native `session.header` Slot share one implementation.
 */

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
  const [copyStatus, setCopyStatus] = createSignal("");

  function runwayText(row: QuotaCardRow): string | undefined {
    if (props.stale) return undefined;
    const now = Date.now();
    if (row.runway?.kind === "lasts_past_reset") {
      const reset = row.resetAtIso;
      if (
        !reset ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(reset) ||
        !(Date.parse(reset) > now)
      )
        return undefined;
    }
    return formatRunway(row.runway, now);
  }

  async function copySummary(): Promise<void> {
    const identity = [
      props.card.providerLabel,
      props.card.planLabel,
      props.card.accountLabel
        ? inlineAccountLabel(props.card.providerLabel, props.card.accountLabel)
        : undefined,
    ]
      .filter((part) => part !== undefined && part.length > 0)
      .join(" · ");
    const lines = displayRows().map((row) => {
      if (isOpenAiProvider(props.card.providerId) && isOpenAiResetsRow(row)) {
        const segments = resetSegments(row.bankedResets);
        return `${row.label}: ${segments.length} available · ${resetSummary(segments)}`;
      }
      const countdown = row.countdown ? ` · Resets in ${row.countdown}` : "";
      // Same gate and text as the value tooltip, so the copy never invents runway.
      const runway = row.kind === "percent" ? runwayText(row) : undefined;
      const runwayPart = runway ? ` · ${runway}` : "";
      return `${row.label}: ${rowValueText(row, props.preferences)}${countdown}${runwayPart}`;
    });
    try {
      await navigator.clipboard.writeText([identity, ...lines].join("\n"));
      setCopyStatus("Quota summary copied.");
    } catch {
      setCopyStatus("Could not copy quota summary.");
    }
  }

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
        <button
          type="button"
          class="qg-card__copy"
          aria-label={`Copy quota summary for ${props.card.providerLabel}${props.card.accountLabel ? `, ${inlineAccountLabel(props.card.providerLabel, props.card.accountLabel)}` : ""}`}
          title="Copy quota summary"
          onClick={() => void copySummary()}
        >
          <svg
            data-copy-icon={copyStatus() === "Quota summary copied." ? "check" : "copy"}
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <Show
              when={copyStatus() === "Quota summary copied."}
              fallback={
                <>
                  <rect x="8" y="8" width="11" height="12" rx="2" />
                  <path d="M16 8V6a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h1" />
                </>
              }
            >
              <path d="m5 12 4 4L19 6" />
            </Show>
          </svg>
        </button>
        <output class="sr-only">{copyStatus()}</output>
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
                  <Show
                    when={row.kind === "percent" && runwayText(row)}
                    fallback={
                      <span class="qg-row__value">{rowValueText(row, props.preferences)}</span>
                    }
                  >
                    {(runway) => (
                      <Tooltip
                        class="qg-row__value-tip"
                        value={runway()}
                        triggerTabIndex={0}
                        contentClass="qg-row__tooltip"
                      >
                        <span class="qg-row__value">{rowValueText(row, props.preferences)}</span>
                      </Tooltip>
                    )}
                  </Show>
                  <Show when={row.countdown}>
                    <span class="qg-row__reset">Resets in {row.countdown}</span>
                  </Show>
                  <Show when={rowPercent(row, props.preferences) !== undefined}>
                    <Show
                      when={runwayText(row)}
                      fallback={
                        <QuotaBar
                          label={row.label}
                          displayPercent={rowPercent(row, props.preferences) ?? 0}
                          displayMode={props.preferences.percentMode}
                        />
                      }
                    >
                      {(runway) => (
                        <Tooltip
                          class="qg-row__bar-tip"
                          value={runway()}
                          triggerTabIndex={0}
                          contentClass="qg-row__tooltip"
                        >
                          <QuotaBar
                            label={row.label}
                            displayPercent={rowPercent(row, props.preferences) ?? 0}
                            displayMode={props.preferences.percentMode}
                          />
                        </Tooltip>
                      )}
                    </Show>
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
