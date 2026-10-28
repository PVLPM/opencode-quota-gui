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
  consoleUnexpectedErrorText,
  type OpenCodeConsoleAuthAccount,
  resolveOpenCodeConsoleAuthAccounts,
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
const MEMBER_BUDGET_NOTE =
  "member budgets found, but not all can be evaluated (model filters, per-model limits, or missing amounts); using the credit limit";

/** True when the user listed `opencode` in `enabledProviders` instead of using auto mode. */
function isExplicitlyEnabled(ctx: QuotaProviderContext): boolean {
  return (
    Array.isArray(ctx.config.enabledProviders) && ctx.config.enabledProviders.includes("opencode")
  );
}

function zenUsdDecimal(value: number): string {
  const fixed = value.toFixed(8);
  return fixed.replace(/0+$/u, "").replace(/\.$/u, "");
}

function zenAccounting(
  accounting: AccountingMetadata,
  sourceId: string | undefined,
): AccountingMetadata {
  return sourceId ? { ...accounting, sourceId } : accounting;
}

type ZenConsoleResult = Extract<
  Awaited<ReturnType<typeof queryOpenCodeZenQuota>>,
  { success: true }
>;

function buildZenEntries(params: {
  result: ZenConsoleResult;
  sourceId?: string;
  configuredMonthlyLimit: number | undefined;
}): {
  entries: QuotaToastEntry[];
  balanceUsd: number;
  monthlyUsageUsd: number | null;
  effectiveMonthlyLimit: number | null;
  hasMonthlyBudget: boolean;
} {
  const { result, sourceId, configuredMonthlyLimit } = params;
  const balanceUsd = result.data.balance / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
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

  if (hasMonthlyBudget && effectiveMonthlyLimit !== null && monthlyUsageUsd !== null) {
    const monthlyRemainingUsd = Math.max(0, effectiveMonthlyLimit - monthlyUsageUsd);
    entries.push({
      accounting: zenAccounting(OPENCODE_ZEN_BUDGET_ACCOUNTING, sourceId),
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
          authority: configuredMonthlyLimit === undefined ? "provider_reported" : "user_configured",
        },
        remaining: {
          quantity: { decimal: zenUsdDecimal(monthlyRemainingUsd), unit: USD_UNIT },
          authority: "locally_derived",
        },
      },
    });
  } else if (hasMonthlyUsage && monthlyUsageUsd !== null) {
    // No limit to measure against: still show this month's real spend.
    entries.push({
      accounting: zenAccounting(OPENCODE_ZEN_SPEND_ACCOUNTING, sourceId),
      kind: "quantity",
      name: "zen-monthly-spend",
      group: OPENCODE_ZEN_GROUP,
      info: "Workspace monthly spend (includes Go API equivalent)",
      semantic: {
        metric: { kind: "window", window: "month" },
        prominence: "primary",
      },
      quantity: { decimal: zenUsdDecimal(monthlyUsageUsd), unit: USD_UNIT },
    });
  }

  entries.push({
    accounting: zenAccounting(OPENCODE_ZEN_BALANCE_ACCOUNTING, sourceId),
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
      accounting: zenAccounting(OPENCODE_ZEN_STATUS_ACCOUNTING, sourceId),
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

  return { entries, balanceUsd, monthlyUsageUsd, effectiveMonthlyLimit, hasMonthlyBudget };
}

function zenAccountDescriptor(account: OpenCodeConsoleAuthAccount): {
  sourceId: string;
  label: string;
  active: boolean;
} {
  return { sourceId: account.sourceId, label: account.label, active: account.active };
}

function zenAccountsState(accounts: readonly OpenCodeConsoleAuthAccount[]): string {
  const states = new Set(accounts.map((account) => account.state));
  if (states.size === 1) return [...states][0] ?? "none";
  return states.has("configured") ? "mixed" : "invalid";
}

function zenAccountsStatusDetails(
  accounts: readonly OpenCodeConsoleAuthAccount[],
): QuotaProviderStatusDetail[] {
  const details: QuotaProviderStatusDetail[] = [
    { key: "console_accounts", value: String(accounts.length) },
    { key: "console_auth_state", value: zenAccountsState(accounts) },
  ];
  const first = accounts.find((account) => "credential" in account) ?? accounts[0];
  if (first && "credential" in first) {
    details.push(
      { key: "console_server", value: consoleBaseUrl(first.credential) },
      {
        key: "console_org",
        value: first.credential.orgName ?? first.credential.orgId ?? "(none)",
      },
    );
  }
  return details;
}

function zenSignInFailure(account: OpenCodeConsoleAuthAccount): string {
  const detail =
    account.state === "invalid" ? scrubCredentialErrorText(account.error) : "the sign-in expired";
  return `OpenCode Console sign-in failed: ${detail}. ${LOGIN_HINT}`;
}

/**
 * Query one workspace. The API client reports expected failures as a result,
 * but an unexpected throw must stay local to this workspace.
 */
async function queryZenConsoleStatus(
  account: Extract<OpenCodeConsoleAuthAccount, { state: "configured" }>,
  ctx: QuotaProviderContext,
): Promise<Awaited<ReturnType<typeof queryOpenCodeZenQuota>>> {
  try {
    return await queryOpenCodeZenQuota(account.credential, {
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });
  } catch (error) {
    return {
      success: false,
      error: `OpenCode Console request failed: ${consoleUnexpectedErrorText(error, account.credential)}`,
    };
  }
}

/**
 * Query each stored Console workspace with its own credential. Balance,
 * monthly budget, spend, and reload rows stay scoped to that workspace's
 * stable connection id, and one workspace's failure never hides another's
 * rows.
 */
async function fetchOpenCodeZenConsoleAccounts(
  ctx: QuotaProviderContext,
  consoleAccounts: readonly OpenCodeConsoleAuthAccount[],
): Promise<QuotaProviderResult> {
  const entries: QuotaToastEntry[] = [];
  const errors: QuotaProviderResult["errors"] = [];
  const accounts: Array<{ sourceId: string; label: string; active: boolean }> = [];
  const statusDetails = zenAccountsStatusDetails(consoleAccounts);
  const configuredMonthlyLimit = ctx.config?.opencodeMonthlyLimit;

  for (const account of consoleAccounts) {
    if (account.state !== "configured") {
      errors.push({
        label: account.label,
        message: zenSignInFailure(account),
        sourceId: account.sourceId,
      });
      accounts.push(zenAccountDescriptor(account));
      continue;
    }

    const result = await queryZenConsoleStatus(account, ctx);
    accounts.push(zenAccountDescriptor(account));

    if (!result.success) {
      errors.push({
        label: account.label,
        message: result.error,
        sourceId: account.sourceId,
      });
      statusDetails.push({
        key: `live_fetch_error:${account.sourceId}`,
        value: result.error,
      });
      continue;
    }

    const built = buildZenEntries({
      result,
      sourceId: account.sourceId,
      configuredMonthlyLimit,
    });
    entries.push(...built.entries);
    for (const message of result.errors) {
      errors.push({ label: account.label, message, sourceId: account.sourceId });
    }
    statusDetails.push(
      {
        key: `balance_usd:${account.sourceId}`,
        value: `USD ${zenUsdDecimal(built.balanceUsd)}`,
      },
      {
        key: `monthly_limit_usd:${account.sourceId}`,
        value:
          built.effectiveMonthlyLimit === null
            ? "(none)"
            : `USD ${zenUsdDecimal(built.effectiveMonthlyLimit)}`,
      },
      {
        key: `monthly_usage_usd:${account.sourceId}`,
        value:
          built.monthlyUsageUsd === null
            ? "(unknown)"
            : `USD ${zenUsdDecimal(built.monthlyUsageUsd)}`,
      },
      { key: `budget_source:${account.sourceId}`, value: result.data.budgetSource },
      ...(result.data.memberBudgetsSkipped
        ? [{ key: `member_budget_note:${account.sourceId}`, value: MEMBER_BUDGET_NOTE }]
        : []),
      {
        key: `auto_reload:${account.sourceId}`,
        value: result.data.reload === null ? "(unknown)" : String(result.data.reload),
      },
      {
        key: `auto_reload_amount_raw:${account.sourceId}`,
        value: result.data.reloadAmount === null ? "(none)" : String(result.data.reloadAmount),
      },
      {
        key: `auto_reload_trigger_raw:${account.sourceId}`,
        value: result.data.reloadTrigger === null ? "(none)" : String(result.data.reloadTrigger),
      },
      ...(result.errors.length > 0
        ? [
            {
              key: `live_fetch_error:${account.sourceId}`,
              value: result.errors.join(" | "),
            },
          ]
        : []),
    );
  }

  return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, statusDetails);
}

export const opencodeZenProvider: QuotaProvider = {
  id: "opencode",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    const consoleAccounts = await resolveOpenCodeConsoleAuthAccounts({
      fallbackLabel: OPENCODE_ZEN_GROUP,
      enrichOrgNames: false,
    });
    if (consoleAccounts.length > 0) return true;

    // Without a Console sign-in, auto mode stays quiet; an explicit
    // enabledProviders entry keeps Zen so fetch() can show the sign-in hint.
    return isExplicitlyEnabled(ctx);
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const consoleAccounts = await resolveOpenCodeConsoleAuthAccounts({
      fallbackLabel: OPENCODE_ZEN_GROUP,
      enrichOrgNames: true,
    });
    if (consoleAccounts.length > 0) {
      return await fetchOpenCodeZenConsoleAccounts(ctx, consoleAccounts);
    }

    const noneStatusDetails = [{ key: "console_auth_state", value: "none" }];
    if (!isExplicitlyEnabled(ctx)) {
      return withStatusDetails(notAttemptedResult(), noneStatusDetails);
    }
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_ZEN_GROUP, `No OpenCode Console sign-in found. ${LOGIN_HINT}`),
      noneStatusDetails,
    );
  },
};
