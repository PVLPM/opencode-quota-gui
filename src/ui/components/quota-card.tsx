import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { AccountingUnit, ProviderCard, QuotaCardRow } from "../../contracts/dashboard";
import { formatPercent, formatRunway, formatTimestamp } from "../format";
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
      return suffix ? `${row.quantity.decimal} ${suffix}` : row.quantity.decimal;
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
    <article class="qg-card" data-stale={props.stale ? "true" : undefined}>
      <header class="qg-card__head">
        <div class="qg-card__identity">
          <span class="qg-card__provider">{props.card.providerLabel}</span>
          <Show when={props.card.accountLabel}>
            {(account) => <span class="qg-card__account">{account()}</span>}
          </Show>
          <span class="qg-card__observed">
            Observed{" "}
            {formatTimestamp(
              props.card.observedAtIso ? Date.parse(props.card.observedAtIso) : undefined,
            )}
          </span>
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
                Every row on this card is hidden — clear them in Settings → Visible cards and rows.
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
                data-warning={
                  row.kind === "percent" &&
                  (row.percentUsed ?? 100 - (row.percentRemaining ?? 100)) >= 80
                    ? "true"
                    : undefined
                }
              >
                <span class="qg-row__label">{row.label}</span>
                <span class="qg-row__value">{rowValueText(row, props.preferences)}</span>
                <Show when={row.countdown}>
                  <span class="qg-row__reset">Resets in {row.countdown}</span>
                </Show>
                <Show when={rowPercent(row, props.preferences) !== undefined}>
                  <span class="qg-row__bar" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(Math.max(rowPercent(row, props.preferences) ?? 0, 0), 100)}%`,
                      }}
                    />
                  </span>
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
