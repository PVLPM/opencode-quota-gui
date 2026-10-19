import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { AccountingUnit, ProviderCard, QuotaCardRow } from "../../contracts/dashboard";
import { formatPercent, formatRunway } from "../format";
import { Icon, Tooltip } from "../opencode-ui";
import { visibleRows } from "../view-model";

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
 * The bar measures used quota even when the badge displays remaining quota.
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

export function QuotaBar(props: { label: string; used: number }): JSX.Element {
  const position = () => Math.min(Math.max(props.used, 0), 100);
  return (
    <span class="qg-row__bar" style={{ "--qg-used-position": `${position()}%` }}>
      <meter
        class="sr-only"
        aria-label={`${props.label} quota used`}
        min={Math.min(0, props.used)}
        max={Math.max(100, props.used)}
        value={props.used}
        aria-valuetext={`${props.used}% used`}
      />
      <span class="qg-row__bar-used" aria-hidden="true" />
      <Show when={position() > 0 && position() < 100}>
        <span class="qg-row__bar-gap" aria-hidden="true" />
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

export function QuotaCardView(props: {
  card: ProviderCard;
  preferences: DisplayPreferences;
  hiddenRows: string[];
  stale: boolean;
}): JSX.Element {
  /**
   * Visibility is presentation-only and managed in Settings, never on Home.
   */
  const shownRows = () => visibleRows(props.card.rows, props.hiddenRows);

  return (
    <article class="qg-card" data-error={props.card.errors.length > 0 ? "true" : undefined}>
      <header class="qg-card__head">
        <div class="qg-card__identity">
          <span class="qg-card__provider">{props.card.providerLabel}</span>
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
        when={shownRows().length > 0}
        fallback={
          <>
            <Show when={props.card.rows.length === 0}>
              <Show when={props.card.errors.length === 0}>
                <p class="qg-muted">No quota rows are reported for this account.</p>
              </Show>
            </Show>
            <Show when={props.card.rows.length > 0}>
              <p class="qg-muted">
                Every row on this card is hidden — clear them in Settings → Visibility.
              </p>
            </Show>
          </>
        }
      >
        <div class="qg-card__rows">
          <For each={shownRows()}>
            {(row) => (
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
                    {(info) => (
                      <Tooltip
                        value={info()}
                        triggerTabIndex={0}
                        appearance="large"
                        contentClass="qg-row__tooltip"
                      >
                        <span class="sr-only">More information about {row.label}</span>
                        <span class="qg-row__info" aria-hidden="true">
                          <Icon name="info" size="small" />
                        </span>
                      </Tooltip>
                    )}
                  </Show>
                </span>
                <span class="qg-row__value">{rowValueText(row, props.preferences)}</span>
                <Show when={row.countdown}>
                  <span class="qg-row__reset">Resets in {row.countdown}</span>
                </Show>
                <Show when={quotaUsedPercent(row) !== undefined}>
                  <QuotaBar label={row.label} used={quotaUsedPercent(row) ?? 0} />
                </Show>
                <Show when={props.preferences.showRunway ? formatRunway(row.runway) : undefined}>
                  <span class="qg-row__meta">
                    <Show
                      when={props.preferences.showRunway ? formatRunway(row.runway) : undefined}
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
            )}
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
