import { sanitizeDisplayText } from "./display-sanitize.js";
import { fetchWithTimeout } from "./http.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  type OpenCodeConsoleCredential,
} from "./opencode-console-auth.js";

const CONSOLE_TIMEOUT_MS = 10_000;
const SESSION_ERROR =
  "OpenCode Console session expired or invalid. Run `opencode auth login opencode` to sign in again.";

/**
 * The OpenCode Console reports amounts in micro-cents:
 * one US dollar is 100,000,000 micro-cents (billing units).
 */
export const OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR = 100_000_000;

/**
 * Where the monthly limit and usage come from: a member budget
 * (policies/members/{account id}), or the credit limit (billing/account) plus
 * this month's usage costs (usage/cost-by-day).
 */
export type OpenCodeZenBudgetSource = "member_budget" | "credit_limit";

export interface OpenCodeZenBillingData {
  balance: number;
  /**
   * Monthly limit in USD from `budgetSource`: null when there is no limit or its
   * route failed. A member budget of $0 is a real blocking limit, not an absence.
   */
  monthlyLimit: number | null;
  /** Current-month usage in billing units from `budgetSource`; null when its route failed. */
  monthlyUsage: number | null;
  lastPayment: number | null;
  /** Auto-reload state; null (unknown) when billing/auto-recharge failed. */
  reload: boolean | null;
  reloadAmount: number | null;
  reloadTrigger: number | null;
  /**
   * Member-budget reset ISO timestamp: the start of the next UTC month, because
   * Console monthly budgets run per UTC calendar month. Null for the credit limit.
   */
  budgetResetIso: string | null;
  budgetSource: OpenCodeZenBudgetSource;
  /**
   * True when the member has budgets but not all of them can be safely
   * evaluated (model filter, per-model limit, unmatched rule, missing amount).
   * No member budget is used then, and the credit-limit fallback applies.
   */
  memberBudgetsSkipped: boolean;
}

/**
 * billing/status (balance) is required. The other routes are optional: when one fails,
 * its fields are null and its error is listed in `errors`.
 */
export type OpenCodeZenResult =
  | { success: true; data: OpenCodeZenBillingData; errors: string[] }
  | { success: false; error: string };

type ConsoleRoute =
  | "billing/status"
  | "billing/account"
  | "billing/auto-recharge"
  | "policies/members"
  | "usage/cost-by-day";

type ConsoleRouteResult<T> = { success: true; data: T } | { success: false; error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Console micro-cent amounts arrive as decimal strings; numbers are accepted too. */
function parseMicroCents(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function invalidResponse(): never {
  throw new Error("Unexpected OpenCode Console response");
}

/** A budget's dollar amounts converted to the internal billing-unit scale. */
type MemberBudget = {
  limitMicroCents: number | null;
  spentMicroCents: number | null;
  /** Total budget candidates seen, 0 for a member response with no budgets. */
  budgetCount: number;
};

// Caps dollar amounts so the ×100,000,000 conversion cannot overflow Number precision.
const MAX_BUDGET_DOLLARS = 90_000_000;

function parseDollars(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return invalidResponse();
}

/** Member budget dollar fields may be absent/null or a non-negative finite number. */
function parseBudgetDollars(value: unknown): number | null {
  if (value === undefined) return null;
  const dollars = parseDollars(value);
  if (dollars === null) return null;
  if (dollars < 0 || dollars > MAX_BUDGET_DOLLARS) return invalidResponse();
  return dollars;
}

function toMicroCents(dollars: number): number {
  return Math.round(dollars * OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR);
}

/**
 * Selects the binding monthly budget from the member detail that
 * `policies/members/{userID}` returns for the signed-in account: the minimum
 * absolute remaining USD among the budget rules that provably apply.
 *
 * A budget counts only when its `policyID` matches a policy, its `ruleID`
 * matches a `kind: "budget"` monthly rule inside that policy, the rule's
 * `scope`/`per` align, and the rule's `selector` does not restrict models
 * (`includeUnknownPrice` alone does not). `scope` is `combined` (shared
 * accounting over the rule's audience — not necessarily the whole org) or
 * `each` (per member); `per` defaults to `set`, and a `per: "model"` budget has
 * no per-model spend here, so only a $0 limit counts: it blocks every model
 * outright. A skipped candidate makes the whole selection untrustworthy — it
 * could be the binding cap — so nothing is selected unless every candidate
 * evaluates; the count is returned either way so the caller can tell an empty
 * member from one with budgets it cannot evaluate (both keep the credit-limit
 * fallback; the latter is noted in diagnostics).
 */
function parseMemberBudgets(json: unknown, accountId: string): MemberBudget {
  const member = asRecord(json);
  if (!member || member.userID !== accountId) return invalidResponse();
  if (!Array.isArray(member.budgets) || !Array.isArray(member.policies)) {
    return invalidResponse();
  }

  let selected: { limit: number; spent: number } | null = null;
  let skipped = false;
  let budgetCount = 0;
  for (const item of member.budgets) {
    const budget = asRecord(item);
    if (!budget) return invalidResponse();
    const policyId = budget.policyID;
    const ruleId = budget.ruleID;
    if (typeof policyId !== "string" || typeof ruleId !== "string") return invalidResponse();
    if (budget.scope !== "each" && budget.scope !== "combined") return invalidResponse();
    const per = budget.per ?? "set";
    if (per !== "set" && per !== "model") return invalidResponse();
    budgetCount += 1;

    const limitDollars = parseBudgetDollars(budget.limitDollars);
    const spentDollars = parseBudgetDollars(budget.spentDollars);
    if (limitDollars === null || spentDollars === null) {
      skipped = true;
      continue;
    }

    const policy = member.policies.map(asRecord).find((p) => p?.id === policyId);
    const rule =
      policy && Array.isArray(policy.rules)
        ? policy.rules.map(asRecord).find((r) => r?.id === ruleId)
        : undefined;
    if (
      !rule ||
      rule.kind !== "budget" ||
      rule.period !== "month" ||
      rule.scope !== budget.scope ||
      (rule.per ?? "set") !== per ||
      !ruleSelectorUnfiltered(rule.selector) ||
      (per === "model" && limitDollars !== 0)
    ) {
      skipped = true;
      continue;
    }

    const candidate = { limit: limitDollars, spent: spentDollars };
    if (selected === null || candidate.limit - candidate.spent < selected.limit - selected.spent) {
      selected = candidate;
    }
  }

  // One unevaluable candidate hides which cap truly binds, so nothing is used.
  if (skipped) selected = null;
  return {
    limitMicroCents: selected === null ? null : toMicroCents(selected.limit),
    spentMicroCents: selected === null ? null : toMicroCents(selected.spent),
    budgetCount,
  };
}

/**
 * True only for `undefined` (no selector) or a selector object built solely
 * from verified Console keys that does not restrict models: `models`/`vendors`
 * must be string arrays (empty = no filter), `inputPriceAtLeast` filters as soon
 * as it is present, and `includeUnknownPrice` alone does not. Anything else —
 * null, malformed, wrong types, unknown keys — fails closed.
 */
function ruleSelectorUnfiltered(selector: unknown): boolean {
  if (selector === undefined) return true;
  const spec = asRecord(selector);
  if (!spec) return false;
  const known = new Set(["models", "vendors", "inputPriceAtLeast", "includeUnknownPrice"]);
  for (const key of Object.keys(spec)) {
    if (!known.has(key)) return false;
  }
  for (const key of ["models", "vendors"] as const) {
    const filter = spec[key];
    if (filter === undefined) continue;
    if (!Array.isArray(filter) || filter.some((entry) => typeof entry !== "string")) {
      return false;
    }
    if (filter.length > 0) return false;
  }
  if (spec.inputPriceAtLeast !== undefined && typeof spec.inputPriceAtLeast !== "number") {
    return false;
  }
  // Any price-threshold key present (even $0) means the rule filters models.
  if (spec.inputPriceAtLeast !== undefined) return false;
  if (spec.includeUnknownPrice !== undefined && typeof spec.includeUnknownPrice !== "boolean") {
    return false;
  }
  return true;
}

function parseBalance(json: unknown): number {
  const balance = parseMicroCents(asRecord(json)?.balanceMicroCents);
  return balance === null ? invalidResponse() : Math.max(0, balance);
}

/** Returns the credit limit in USD, or null when the account has no limit. */
function parseCreditLimit(json: unknown): number | null {
  const value = asRecord(json)?.creditLimitMicroCents;
  if (value === null) return null;

  const limit = parseMicroCents(value);
  return limit === null ? invalidResponse() : limit / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
}

function parseAutoRecharge(
  json: unknown,
): Pick<OpenCodeZenBillingData, "reload" | "reloadAmount" | "reloadTrigger"> {
  const autoRecharge = asRecord(json);
  if (!autoRecharge || typeof autoRecharge.enabled !== "boolean") return invalidResponse();

  return {
    reload: autoRecharge.enabled,
    reloadAmount: parseDollars(autoRecharge.rechargeAmountDollars),
    reloadTrigger: parseDollars(autoRecharge.thresholdDollars),
  };
}

function currentUtcMonth(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** 00:00 UTC on the 1st of the month after `now`. */
function nextUtcMonthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** Sums the current UTC month's daily costs in micro-cents; an empty list means no usage. */
function parseMonthlyUsage(json: unknown, now: Date): number {
  if (!Array.isArray(json)) return invalidResponse();

  const month = currentUtcMonth(now);
  let total = 0;
  for (const item of json) {
    const day = asRecord(item);
    const cost = parseMicroCents(day?.totalCostMicroCents);
    if (typeof day?.date !== "string" || cost === null) return invalidResponse();
    if (day.date.slice(0, 7) === month) total += cost;
  }
  return Number.isFinite(total) ? total : invalidResponse();
}

function sanitizeMessage(
  text: string,
  secrets: Array<string | undefined> = [],
  maxLength = 120,
): string {
  let sanitized = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return (sanitized || "unknown").slice(0, maxLength);
}

async function fetchConsoleRoute<T>(params: {
  /** Names the route in error text. */
  route: ConsoleRoute;
  /** URL path after `/api/` when it adds an id to `route`; the id stays out of error text. */
  path?: string;
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
  parse: (json: unknown) => T;
}): Promise<ConsoleRouteResult<T>> {
  const path = params.path ?? params.route;
  try {
    return await fetchWithTimeout(`${consoleBaseUrl(params.credential)}/api/${path}`, {
      request: {
        method: "GET",
        redirect: "manual",
        headers: consoleHeaders(params.credential),
      },
      timeoutMs: params.timeoutMs,
      consume: async (response): Promise<ConsoleRouteResult<T>> => {
        // Redirects and 401 mean the whole session is gone; a 403 is treated as
        // a per-route failure so optional routes can fall back gracefully.
        if ((response.status >= 300 && response.status < 400) || response.status === 401) {
          return { success: false, error: SESSION_ERROR };
        }
        if (!response.ok) {
          return {
            success: false,
            error: `OpenCode Console ${params.route} error ${response.status}`,
          };
        }
        if (response.headers.get("content-type")?.includes("text/html")) {
          return { success: false, error: SESSION_ERROR };
        }

        const text = await response.text();
        try {
          // An empty body carries no value, so the route parser sees it as JSON null.
          const json: unknown = text.trim() === "" ? null : JSON.parse(text);
          return { success: true, data: params.parse(json) };
        } catch {
          return {
            success: false,
            error: `Could not parse OpenCode Console ${params.route} response`,
          };
        }
      },
    });
  } catch (error) {
    const accountId = params.credential.accountId?.trim();
    const message = sanitizeMessage(error instanceof Error ? error.message : String(error), [
      params.credential.accessToken,
      params.credential.orgId,
      accountId,
      accountId && encodeURIComponent(accountId),
    ]);
    return { success: false, error: `OpenCode Console ${params.route} request failed: ${message}` };
  }
}

/** The member detail route key, or an error explaining why it cannot be fetched. */
function memberBudgetRequest(request: {
  credential: OpenCodeConsoleCredential;
  timeoutMs: number;
}): ConsoleRouteResult<MemberBudget> | Promise<ConsoleRouteResult<MemberBudget>> {
  const accountId = request.credential.accountId?.trim();
  if (!accountId) {
    return {
      success: false,
      error: "OpenCode Console member budgets unavailable: the Console sign-in has no account id",
    };
  }
  return fetchConsoleRoute({
    ...request,
    route: "policies/members",
    path: `policies/members/${encodeURIComponent(accountId)}`,
    parse: (json) => parseMemberBudgets(json, accountId),
  });
}

export async function queryOpenCodeZenQuota(
  credential: OpenCodeConsoleCredential,
  options: { requestTimeoutMs?: number } = {},
): Promise<OpenCodeZenResult> {
  const request = {
    credential,
    timeoutMs: options.requestTimeoutMs ?? CONSOLE_TIMEOUT_MS,
  };
  const now = new Date();
  const [balance, creditLimit, autoRecharge, member, monthlyUsage] = await Promise.all([
    fetchConsoleRoute({ ...request, route: "billing/status", parse: parseBalance }),
    fetchConsoleRoute({ ...request, route: "billing/account", parse: parseCreditLimit }),
    fetchConsoleRoute({ ...request, route: "billing/auto-recharge", parse: parseAutoRecharge }),
    memberBudgetRequest(request),
    fetchConsoleRoute({
      ...request,
      route: "usage/cost-by-day",
      parse: (json) => parseMonthlyUsage(json, now),
    }),
  ]);

  const optional = [creditLimit, autoRecharge, member, monthlyUsage];
  if ([balance, ...optional].some((result) => !result.success && result.error === SESSION_ERROR)) {
    return { success: false, error: SESSION_ERROR };
  }
  if (!balance.success) return balance;

  // Prefer a member budget whenever the member route confirms the account and a
  // budget rule applies ($0 included: a binding limit). Otherwise (no member
  // budgets, or budgets that cannot all be safely evaluated) fall back to the
  // credit limit plus this month's usage costs.
  let monthlyLimit = creditLimit.success ? creditLimit.data : null;
  let usage = monthlyUsage.success ? monthlyUsage.data : null;
  let budgetResetIso: string | null = null;
  let budgetSource: OpenCodeZenBudgetSource = "credit_limit";
  let memberBudgetsSkipped = false;
  if (member.success) {
    const { limitMicroCents, spentMicroCents, budgetCount } = member.data;
    if (limitMicroCents !== null && spentMicroCents !== null) {
      monthlyLimit = limitMicroCents / OPENCODE_ZEN_BILLING_UNITS_PER_DOLLAR;
      usage = spentMicroCents;
      budgetResetIso = nextUtcMonthStartIso(now);
      budgetSource = "member_budget";
    } else if (budgetCount > 0) {
      memberBudgetsSkipped = true;
    }
  }

  return {
    success: true,
    data: {
      balance: balance.data,
      monthlyLimit,
      monthlyUsage: usage,
      lastPayment: null,
      ...(autoRecharge.success
        ? autoRecharge.data
        : { reload: null, reloadAmount: null, reloadTrigger: null }),
      budgetResetIso,
      budgetSource,
      memberBudgetsSkipped,
    },
    errors: optional.flatMap((result) => (result.success ? [] : [result.error])),
  };
}
