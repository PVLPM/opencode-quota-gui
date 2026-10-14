import type {
  AccountingMetadata,
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import { scrubCredentialErrorText } from "../lib/opencode-auth.js";
import {
  consoleBaseUrl,
  type OpenCodeConsoleCredential,
  resolveOpenCodeConsoleAuth,
} from "../lib/opencode-console-auth.js";
import {
  OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR,
  queryOpenCodeZenQuota,
} from "../lib/opencode-zen.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_ZEN_GROUP = "OpenCode Zen";
const OPENCODE_ZEN_BALANCE_ACCOUNTING: AccountingMetadata = {
  resultType: "balance",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const OPENCODE_ZEN_BUDGET_ACCOUNTING: AccountingMetadata = {
  resultType: "budget",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "locally_derived",
};
const OPENCODE_ZEN_SPEND_ACCOUNTING: AccountingMetadata = {
  resultType: "spend",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const OPENCODE_ZEN_STATUS_ACCOUNTING: AccountingMetadata = {
  resultType: "status",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
};
const USD_UNIT = { kind: "currency", code: "USD" } as const;

const LOGIN_HINT = "Run `opencode auth login opencode`.";

/** True when the user listed `opencode` in `enabledProviders` instead of using auto mode. */
function isExplicitlyEnabled(ctx: QuotaProviderContext): boolean {
  return (
    Array.isArray(ctx.config.enabledProviders) && ctx.config.enabledProviders.includes("opencode")
  );
}

function signInFailedResult(state: "expired" | "invalid", detail: string): QuotaProviderResult {
  return withStatusDetails(
    attemptedErrorResult(
      OPENCODE_ZEN_GROUP,
      `OpenCode Console sign-in failed: ${detail}. ${LOGIN_HINT}`,
    ),
    [{ key: "console_auth_state", value: state }],
  );
}

/** Never includes the token. */
function consoleStatusDetails(credential: OpenCodeConsoleCredential): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    console_auth_state: "configured",
    console_server: consoleBaseUrl(credential),
    console_org: credential.orgName ?? credential.orgId ?? "(none)",
  });
}

function zenUsdDecimal(value: number): string {
  const fixed = value.toFixed(8);
  return fixed.replace(/0+$/u, "").replace(/\.$/u, "");
}

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const consoleAuth = await resolveOpenCodeConsoleAuth();
    // Without a Console sign-in, auto mode stays quiet; an explicit
    // enabledProviders entry keeps Zen so fetch() can show the sign-in hint.
    if (consoleAuth.state === "none") return isExplicitlyEnabled(ctx);
    // An expired or failed sign-in stays available so fetch() can show its hint.
    return true;
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const consoleAuth = await resolveOpenCodeConsoleAuth();

    if (consoleAuth.state === "none") {
      const noneStatusDetails = [{ key: "console_auth_state", value: "none" }];
      if (!isExplicitlyEnabled(ctx)) {
        return withStatusDetails(notAttemptedResult(), noneStatusDetails);
      }
      return withStatusDetails(
        attemptedErrorResult(
          OPENCODE_ZEN_GROUP,
          `No OpenCode Console sign-in found. ${LOGIN_HINT}`,
        ),
        noneStatusDetails,
      );
    }

    if (consoleAuth.state === "invalid") {
      return signInFailedResult("invalid", scrubCredentialErrorText(consoleAuth.error));
    }

    if (consoleAuth.state === "expired") {
      // OpenCode refreshes the Console token when it is read, so this is rare.
      return signInFailedResult("expired", "the sign-in expired");
    }

    const { credential } = consoleAuth;
    const statusDetails = consoleStatusDetails(credential);

    const result = await queryOpenCodeZenQuota(credential, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult(OPENCODE_ZEN_GROUP, result.error), [
        ...statusDetails,
        { key: "live_fetch_error", value: result.error },
      ]);
    }

    const balanceUsd = result.data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
    const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;
    const effectiveMonthlyLimit = configuredMonthlyLimit ?? result.data.monthlyLimit;
    const monthlyUsageUsd =
      result.data.monthlyUsage === null
        ? null
        : result.data.monthlyUsage / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;

    const hasMonthlyUsage =
      monthlyUsageUsd !== null && Number.isFinite(monthlyUsageUsd) && monthlyUsageUsd >= 0;
    // A member-budget limit of $0 is a real blocking limit, not an absence;
    // a $0 credit-limit fallback value still counts as no limit.
    const zeroBudgetActive =
      result.data.budgetSource === "member_budget" && effectiveMonthlyLimit === 0;
    const hasMonthlyBudget =
      effectiveMonthlyLimit !== null &&
      Number.isFinite(effectiveMonthlyLimit) &&
      (effectiveMonthlyLimit > 0 || zeroBudgetActive) &&
      hasMonthlyUsage;
    const entries: QuotaToastEntry[] = [];

    if (hasMonthlyBudget) {
      const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
      entries.push({
        accounting: OPENCODE_ZEN_BUDGET_ACCOUNTING,
        name: "zen-monthly-budget",
        group: OPENCODE_ZEN_GROUP,
        percentRemaining:
          effectiveMonthlyLimit > 0
            ? Math.min(100, (monthlyRemainingUsd / effectiveMonthlyLimit) * 100)
            : 0,
        ...(result.data.budgetResetIso ? { resetTimeIso: result.data.budgetResetIso } : {}),
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        basis: {
          used: {
            quantity: { decimal: zenUsdDecimal(monthlyUsageUsd), unit: USD_UNIT },
            authority: "provider_reported",
          },
          limit: {
            quantity: { decimal: zenUsdDecimal(effectiveMonthlyLimit), unit: USD_UNIT },
            authority:
              configuredMonthlyLimit === undefined ? "provider_reported" : "user_configured",
          },
          remaining: {
            quantity: { decimal: zenUsdDecimal(monthlyRemainingUsd), unit: USD_UNIT },
            authority: "locally_derived",
          },
        },
      });
    } else if (hasMonthlyUsage) {
      // No limit to measure against: still show this month's real spend.
      entries.push({
        accounting: OPENCODE_ZEN_SPEND_ACCOUNTING,
        kind: "quantity",
        name: "zen-monthly-spend",
        group: OPENCODE_ZEN_GROUP,
        semantic: {
          metric: { kind: "window", window: "month" },
          prominence: "primary",
        },
        quantity: { decimal: zenUsdDecimal(monthlyUsageUsd), unit: USD_UNIT },
      });
    }

    entries.push({
      accounting: OPENCODE_ZEN_BALANCE_ACCOUNTING,
      kind: "quantity",
      name: "zen-current-balance",
      group: OPENCODE_ZEN_GROUP,
      semantic: {
        metric: { kind: "component", component: "current_balance" },
        prominence: hasMonthlyBudget ? "supplementary" : "primary",
      },
      quantity: { decimal: zenUsdDecimal(balanceUsd), unit: USD_UNIT },
    });
    if (result.data.reload !== null) {
      entries.push({
        accounting: OPENCODE_ZEN_STATUS_ACCOUNTING,
        kind: "boolean",
        name: "zen-auto-reload",
        group: OPENCODE_ZEN_GROUP,
        semantic: {
          metric: { kind: "component", component: "auto_reload" },
          prominence: "supplementary",
        },
        value: result.data.reload,
      });
    }

    const errors = result.errors.map((message) => ({ label: OPENCODE_ZEN_GROUP, message }));

    return withStatusDetails(attemptedResult(entries, errors), [
      ...statusDetails,
      { key: "balance_usd", value: `USD ${zenUsdDecimal(balanceUsd)}` },
      {
        key: "monthly_limit_usd",
        value:
          result.data.monthlyLimit === null
            ? "(none)"
            : `USD ${zenUsdDecimal(result.data.monthlyLimit)}`,
      },
      {
        key: "monthly_usage_usd",
        value: monthlyUsageUsd === null ? "(unknown)" : `USD ${zenUsdDecimal(monthlyUsageUsd)}`,
      },
      { key: "budget_source", value: result.data.budgetSource },
      ...(result.data.memberBudgetsSkipped
        ? [
            {
              key: "member_budget_note",
              value:
                "member budgets found, but not all can be evaluated (model filters, per-model limits, or missing amounts); using the credit limit",
            },
          ]
        : []),
      {
        key: "auto_reload",
        value: result.data.reload === null ? "(unknown)" : String(result.data.reload),
      },
      {
        key: "auto_reload_amount_raw",
        value: result.data.reloadAmount === null ? "(none)" : String(result.data.reloadAmount),
      },
      {
        key: "auto_reload_trigger_raw",
        value: result.data.reloadTrigger === null ? "(none)" : String(result.data.reloadTrigger),
      },
      ...(result.errors.length > 0
        ? [{ key: "live_fetch_error", value: result.errors.join(" | ") }]
        : []),
    ]);
  },
};
