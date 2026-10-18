import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import type { AccountingUnit, ProviderCard, QuotaCardRow } from "../../contracts/dashboard";
import { formatPercent, formatRunway, formatTimestamp } from "../format";
import { visibleRows } from "../view-model";
import { EyeToggle } from "./eye-toggle";

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
      const percent =
        preferences.percentMode === "used"
          ? (row.percentUsed ?? row.percentRemaining)
          : (row.percentRemaining ?? row.percentUsed);
      return formatPercent(percent);
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

/** The shown percent, or `undefined` when the row has none (no bar is drawn then). */
export function rowPercent(row: QuotaCardRow, preferences: DisplayPreferences): number | undefined {
  if (row.kind !== "percent") return undefined;
  return preferences.percentMode === "used"
    ? (row.percentUsed ?? row.percentRemaining)
    : (row.percentRemaining ?? row.percentUsed);
}

export function QuotaCardView(props: {
  card: ProviderCard;
  preferences: DisplayPreferences;
  hiddenRows: string[];
  cardHidden: boolean;
  stale: boolean;
  onToggleRow: (rowId: string) => Promise<void>;
  onToggleCard: (cardId: string) => Promise<void>;
}): JSX.Element {
  const hidden = () => new Set(props.hiddenRows);
  /**
   * Rows hide by stable id, exactly like cards: a hidden row is not rendered at
   * all, so the row eye only ever hides. Un-hiding lives in Settings → Visible
   * cards and rows, which owns the list (invariant 8: hiding changes no payload
   * and no polling).
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
        <EyeToggle
          pressed={props.cardHidden}
          label={`${props.cardHidden ? "Show" : "Hide"} the ${props.card.providerLabel} card`}
          title="Hide this card"
          onToggle={() => props.onToggleCard(props.card.cardId)}
        />
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
              <div class="qg-row">
                <span class="qg-row__label">{row.label}</span>
                <span class="qg-row__value">{rowValueText(row, props.preferences)}</span>
                <Show when={rowPercent(row, props.preferences) !== undefined}>
                  <span class="qg-row__bar" aria-hidden="true">
                    <span
                      style={{
                        width: `${Math.min(Math.max(rowPercent(row, props.preferences) ?? 0, 0), 100)}%`,
                      }}
                    />
                  </span>
                </Show>
                <Show when={row.countdown ?? formatRunway(row.runway)}>
                  <span class="qg-row__meta">
                    <Show when={row.countdown}>{(countdown) => <span>{countdown()}</span>}</Show>
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
                <span class="qg-row__toggle">
                  <EyeToggle
                    pressed={hidden().has(row.rowId)}
                    label={`${hidden().has(row.rowId) ? "Show" : "Hide"} the ${row.label} row`}
                    title="Hide this row"
                    onToggle={() => props.onToggleRow(row.rowId)}
                  />
                </span>
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
