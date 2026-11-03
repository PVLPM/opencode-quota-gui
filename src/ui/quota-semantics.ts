import type { AccountingUnit, QuotaCardRow } from "../contracts/dashboard";
import { formatPercent } from "./format";

/**
 * Browser-safe quota row semantics shared by every quota surface (design spec
 * §10). This module deliberately carries no JSX and imports no UI library, so
 * the native `session.header` Slot can reuse the exact used/remaining,
 * severity, value-text and identity rules the full cards paint without pulling
 * the card component (and its tooltip/portal runtime) into a pure model.
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
  /** Sparse explicit provider visibility overrides for live temporal chips. */
  temporalProviderOverrides?: Readonly<Record<string, boolean>>;
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

/** Visible USD uses the symbol; other currencies keep their ISO code unchanged. */
export function formatVisibleUsd(amount: string): string {
  return amount.startsWith("-") ? `-$${amount.slice(1)}` : `$${amount}`;
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
      if (row.quantity.unit.kind === "currency" && row.quantity.unit.code === "USD") {
        return formatVisibleUsd(amount);
      }
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

/** Only unwrap the exact generated `[provider] (label)` form; never infer identity. */
export function inlineAccountLabel(provider: string, account: string): string {
  const prefix = `[${provider}] (`;
  if (account.startsWith(prefix) && account.endsWith(")")) {
    const label = account.slice(prefix.length, -1);
    if (label.length > 0 && !/[()[\]\r\n]/.test(label)) return label;
  }
  return account;
}
