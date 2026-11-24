import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { ProviderCard, QuotaCardRow } from "../../contracts/dashboard";
import type { BankedResetAvailability, BankedResetCredit } from "../../contracts/openai-quota";
import { isTransientProviderFailureCategory } from "../../contracts/provider-failure";
import { orderRowsByPreference } from "../../contracts/row-order";
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

/**
 * A reset row carries explicit banked-reset metadata; a display label is never
 * an identity. Any provider that declares the same optional field gets the same
 * reset rendering.
 */
function isResetsRow(row: QuotaCardRow): boolean {
  return row.bankedResets !== undefined;
}

/**
 * The backend's balance result type is the stable credit identity. A malformed
 * balance row with a percent/quantity shape is still credits, so it is
 * suppressed rather than drawing unrelated graphics.
 */
function isCreditsRow(row: QuotaCardRow): boolean {
  return row.resultType === "balance";
}

function hasPositiveCreditsValue(value: string | undefined): boolean {
  if (value === "Unlimited") return true;
  if (value === undefined) return false;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0;
}

/** A row the provider declared as an optional field in its registration metadata. */
function isDeclaredOptionalRow(row: QuotaCardRow, card: ProviderCard): boolean {
  return (card.visibilityRows ?? []).some(
    (declared) => declared.rowId === row.rowId || declared.aliases?.includes(row.rowId),
  );
}

function isSuppressedOptionalRow(row: QuotaCardRow, card: ProviderCard): boolean {
  if (!isDeclaredOptionalRow(row, card)) return false;
  if (isResetsRow(row)) return resetSegments(row.bankedResets).length === 0;
  if (!isCreditsRow(row)) return false;
  // A structured quantity is a real declared balance (DeepSeek, Zen, ...);
  // only malformed percent shapes and empty/zero value rows are suppressed.
  if (row.kind === "quantity") return false;
  return row.kind !== "value" || !hasPositiveCreditsValue(row.value);
}

/** A reset row is rendered as resets only when the provider declared that optional field. */
function isDeclaredResetsRow(row: QuotaCardRow, card: ProviderCard): boolean {
  return isResetsRow(row) && isDeclaredOptionalRow(row, card);
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

function resetBoundaryPassed(row: QuotaCardRow, nowMs: number): boolean {
  if (row.resetAtIso === undefined) return false;
  const resetAtMs = Date.parse(row.resetAtIso);
  return Number.isFinite(resetAtMs) && resetAtMs <= nowMs;
}

/** A cooldown/transient outcome made no fresh request or may recover on its own. */
function isMutedPollError(error: ProviderCard["errors"][number]): boolean {
  return (
    error.attemptOutcome === "cooldown" ||
    error.attemptOutcome === "transient" ||
    isTransientProviderFailureCategory(error.failureCategory)
  );
}

function formatShortDuration(ms: number, roundUp: boolean): string {
  const seconds = roundUp
    ? Math.max(1, Math.ceil(Math.max(0, ms) / 1_000))
    : Math.max(0, Math.floor(Math.max(0, ms) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatUpdatedAge(observedAtIso: string | undefined, nowMs: number): string | undefined {
  if (observedAtIso === undefined) return undefined;
  const observedAtMs = Date.parse(observedAtIso);
  if (!Number.isFinite(observedAtMs) || observedAtMs > nowMs) return undefined;
  return `Updated ${formatShortDuration(nowMs - observedAtMs, false)} ago`;
}

export function QuotaCardView(props: {
  card: ProviderCard;
  preferences: DisplayPreferences;
  hiddenRows: string[];
  stale: boolean;
  timeZone: string;
  /** Render time supplied by the snapshot; tests pass a fixed clock. */
  nowMs?: number;
}): JSX.Element {
  type CardError = ProviderCard["errors"][number];
  /**
   * A mounted card advances its own clock once a minute, so the retained age,
   * retry text and per-row reset expiry do not freeze between snapshot polls.
   * A new snapshot rebases the offset instead of double-counting time.
   */
  const CARD_NOW_TICK_MS = 60_000;
  const [tickOffsetMs, setTickOffsetMs] = createSignal(0);
  onMount(() => {
    const timer = setInterval(
      () => setTickOffsetMs((offset) => offset + CARD_NOW_TICK_MS),
      CARD_NOW_TICK_MS,
    );
    onCleanup(() => clearInterval(timer));
  });
  createEffect(
    on(
      () => props.nowMs,
      () => setTickOffsetMs(0),
      { defer: true },
    ),
  );
  const cardNowMs = () => {
    const offset = tickOffsetMs();
    return props.nowMs === undefined ? Date.now() : props.nowMs + offset;
  };

  /** Visibility is presentation-only and managed in Settings, never on Home. */
  const visibilityRows = () => {
    const controls = props.card.visibilityRows ?? [];
    return orderRowsByPreference(
      visibleRows(props.card.rows, props.hiddenRows, controls),
      props.preferences.rowOrder?.[props.card.cardId],
      (row) => row.rowId,
      controls,
    );
  };
  /**
   * A retained row whose reset boundary passed is dropped instead of showing 0%.
   * Fresh provider rows are authoritative and are never dropped by our clock.
   */
  const shownRows = () =>
    props.stale
      ? visibilityRows().filter((row) => !resetBoundaryPassed(row, cardNowMs()))
      : visibilityRows();
  const displayRows = () => shownRows().filter((row) => !isSuppressedOptionalRow(row, props.card));
  const [copyStatus, setCopyStatus] = createSignal("");

  /**
   * A retained measurement plus a polling/cooldown skip is not a provider
   * failure. Keep the rows visible with a muted age/retry notice; credential
   * rejections and unknown categories stay red.
   */
  const mutedErrors = createMemo<CardError[]>(() =>
    props.card.stale === true && displayRows().length > 0
      ? props.card.errors.filter(isMutedPollError)
      : [],
  );
  const visibleErrors = createMemo<CardError[]>(() =>
    props.card.errors.filter((error) => !mutedErrors().includes(error)),
  );
  const mutedNotice = createMemo<string | undefined>(() => {
    if (mutedErrors().length === 0) return undefined;
    const nowMs = cardNowMs();
    const updated = formatUpdatedAge(props.card.observedAtIso, nowMs);
    const retryAtMs = mutedErrors()
      .map((error) => error.retryAtMs)
      .filter((value): value is number => value !== undefined && value > nowMs)
      .sort((left, right) => left - right)[0];
    const retry =
      retryAtMs === undefined
        ? undefined
        : `retrying in ${formatShortDuration(retryAtMs - nowMs, true)}`;
    return [updated, retry].filter((part) => part !== undefined).join(" · ") || undefined;
  });

  function runwayText(row: QuotaCardRow): string | undefined {
    if (props.stale) return undefined;
    const now = cardNowMs();
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

  const errorLabel = (label: string) =>
    props.card.accountLabel ? label : `Provider-level error · ${label}`;

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
      if (isDeclaredResetsRow(row, props.card)) {
        const segments = resetSegments(row.bankedResets);
        return `${row.label}: ${segments.length} available · ${resetSummary(segments)}`;
      }
      const countdown = row.countdown ? ` · Resets in ${row.countdown}` : "";
      // Same gate and text as the value tooltip, so the copy never invents runway.
      const runway = row.kind === "percent" ? runwayText(row) : undefined;
      const runwayPart = runway ? ` · ${runway}` : "";
      return `${row.label}: ${rowValueText(row, props.preferences)}${countdown}${runwayPart}`;
    });
    // Same already-sanitized projection and labels the card renders, in display order.
    // Suppressed polling errors are replaced by the same muted notice the card shows.
    const notice = mutedNotice();
    const errorLines = visibleErrors().flatMap((error) => [errorLabel(error.label), error.message]);
    try {
      await navigator.clipboard.writeText(
        [
          identity,
          ...(props.stale ? [notice ?? "Data may be stale"] : []),
          ...errorLines,
          ...lines,
        ].join("\n"),
      );
      setCopyStatus("Quota summary copied.");
    } catch {
      setCopyStatus("Could not copy quota summary.");
    }
  }

  return (
    <article class="qg-card" data-error={visibleErrors().length > 0 ? "true" : undefined}>
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

      <Show when={props.card.stale === true}>
        <p class="qg-stale">{mutedNotice() ?? "Data may be stale"}</p>
      </Show>

      <Show when={visibleErrors().length > 0}>
        <div class="qg-card__errors">
          <For each={visibleErrors()}>
            {(error) => (
              <p class="qg-error" data-level={props.card.accountLabel ? "account" : "provider"}>
                <span class="qg-error__label">{errorLabel(error.label)}</span>
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
              <Show when={visibleErrors().length === 0}>
                <p class="qg-muted">No quota rows are reported for this account.</p>
              </Show>
            </Show>
            <Show when={props.card.rows.length > 0 && visibilityRows().length === 0}>
              <p class="qg-muted">
                Every row on this card is hidden — clear them in Settings → Visibility.
              </p>
            </Show>
            <Show when={props.card.rows.length > 0 && visibilityRows().length > 0}>
              <Show when={visibleErrors().length === 0}>
                <p class="qg-muted">No quota rows are reported for this account.</p>
              </Show>
            </Show>
          </>
        }
      >
        <div class="qg-card__rows">
          <For each={displayRows()}>
            {(row) =>
              isDeclaredResetsRow(row, props.card) ? (
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
