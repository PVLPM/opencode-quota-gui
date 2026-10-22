/**
 * OpenAI (Plus/Pro) provider wrapper.
 */

import {
  type BankedResetAvailability,
  OPENAI_CREDITS_ROW_KEY,
  OPENAI_CREDITS_ROW_LABEL,
  OPENAI_CREDITS_ROW_RESULT_TYPE,
  OPENAI_RESETS_ROW_KEY,
  OPENAI_RESETS_ROW_LABEL,
  OPENAI_RESETS_ROW_RESULT_TYPE,
} from "../contracts/openai-quota.js";
import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS,
  hasOpenAIOAuthCached,
  OPENAI_AUTH_SOURCE_KEYS,
  queryOpenAIQuota,
  resolveOpenAIOAuth,
} from "../lib/openai.js";
import {
  type CredentialRow,
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
} from "../lib/opencode-auth.js";
import { isCanonicalProviderAvailable } from "../lib/provider-availability.js";
import { modelProviderIncludesAny } from "../lib/provider-model-matching.js";
import { resolveQuotaProviderSessionModelIdentity } from "../lib/quota-providers.js";
import type { AuthData } from "../lib/types.js";
import {
  attemptedResult,
  groupedPercentWindowEntries,
  mapNullableProviderResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

/**
 * OpenCode 2's "Sign in with ChatGPT" login. Its token is scoped to
 * api.openai.com, and ChatGPT's usage endpoint rejects it with HTTP 401
 * `no_matching_rule` (#316), so it gets a status row instead of a request.
 */
const TOKEN_SHARING_METHOD_ID = "chatgpt-token-sharing";

function isTokenSharingLogin(row: CredentialRow): boolean {
  return row.value.methodID === TOKEN_SHARING_METHOD_ID;
}

const OPENAI_WINDOW_ROW_KEYS: Readonly<Record<string, string>> = {
  "5h:": "window:five_hour",
  "Weekly:": "window:week",
  "Monthly:": "window:month",
  "Code Review:": "window:code_review",
};

/**
 * Percent-only window rows carry no typed `semantic`, so they get stable
 * explicit `rowKey`s by window (the fallback aggregate row when no window
 * exists); labels themselves are never used as ids.
 */
function withOpenAiWindowRowKeys(
  entries: QuotaProviderResult["entries"],
): QuotaProviderResult["entries"] {
  return entries.map((entry) => ({
    ...entry,
    rowKey: (entry.label ? OPENAI_WINDOW_ROW_KEYS[entry.label] : undefined) ?? "aggregate",
  }));
}

const OPENAI_OPTIONAL_ACCOUNTING = {
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function hasPositiveCreditBalance(balance: string | null | undefined): boolean {
  if (typeof balance !== "string") return false;
  const parsed = Number(balance);
  return Number.isFinite(parsed) && parsed > 0;
}

/**
 * Existing value-row kind only: positive Resets and positive/unlimited Credits.
 * Zero, unavailable, malformed, and hidden values emit no row at all.
 */
function openAiOptionalValueEntries(params: {
  group: string;
  sourceId?: string;
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null };
  bankedResets?: BankedResetAvailability;
}): QuotaToastEntry[] {
  const entries: QuotaToastEntry[] = [];
  const baseAccounting = {
    ...OPENAI_OPTIONAL_ACCOUNTING,
    ...(params.sourceId ? { sourceId: params.sourceId } : {}),
  };

  const resets = params.bankedResets;
  if (resets && resets.availableCount > 0) {
    entries.push({
      kind: "value",
      accounting: { ...baseAccounting, resultType: OPENAI_RESETS_ROW_RESULT_TYPE },
      name: `${params.group} ${OPENAI_RESETS_ROW_LABEL}`,
      group: params.group,
      label: `${OPENAI_RESETS_ROW_LABEL}:`,
      rowKey: OPENAI_RESETS_ROW_KEY,
      value: `${resets.availableCount} available`,
      bankedResets: {
        availableCount: resets.availableCount,
        credits: resets.credits.map((credit) => ({
          ...(credit.title !== undefined ? { title: credit.title } : {}),
          ...(credit.expiresAtIso !== undefined ? { expiresAtIso: credit.expiresAtIso } : {}),
        })),
      },
    });
  }

  const credits = params.credits;
  const positiveCredits = credits?.unlimited === true || hasPositiveCreditBalance(credits?.balance);
  if (positiveCredits && credits) {
    entries.push({
      kind: "value",
      accounting: { ...baseAccounting, resultType: OPENAI_CREDITS_ROW_RESULT_TYPE },
      name: `${params.group} ${OPENAI_CREDITS_ROW_LABEL}`,
      group: params.group,
      label: `${OPENAI_CREDITS_ROW_LABEL}:`,
      rowKey: OPENAI_CREDITS_ROW_KEY,
      value: credits.unlimited ? "Unlimited" : (credits.balance ?? ""),
    });
  }

  return entries;
}

/** A row that says why a login has no ChatGPT quota number. */
function statusValueEntry(
  row: CredentialRow,
  name: string,
  value: string,
): QuotaProviderResult["entries"][number] {
  return {
    kind: "value",
    accounting: {
      resultType: "status",
      acquisitionMethod: "local_runtime_accounting",
      ownership: "maintained",
      authority: "locally_derived",
      sourceId: row.id,
    },
    name,
    group: name,
    rowKey: "named:status",
    value,
  };
}

export const openaiProvider: QuotaProvider = {
  id: "openai",

  async isAvailable(ctx: QuotaProviderContext): Promise<boolean> {
    // Best-effort: if provider lookup errors, preserve current permissive fallback.
    const availableByProviderId = await isCanonicalProviderAvailable({
      ctx,
      providerId: "openai",
      fallbackOnError: true,
    });

    if (availableByProviderId) {
      return true;
    }

    if (await hasOpenAIOAuthCached({ maxAgeMs: DEFAULT_OPENAI_AUTH_CACHE_MAX_AGE_MS })) {
      return true;
    }

    // Without an OpenAI alias or OAuth login, a stored API key still counts.
    const keyRows = await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, {
      methods: ["key"],
      firstOnly: true,
    });
    return keyRows.length > 0;
  },

  matchesCurrentModel(model: string): boolean {
    return modelProviderIncludesAny(model, ["openai", "chatgpt", "codex"]);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const currentIntegrationId =
      ctx.config?.currentProviderID ??
      resolveQuotaProviderSessionModelIdentity({ currentModel: ctx.config?.currentModel ?? "" })
        ?.providerId;
    const rows = (await readCredentialRows(OPENAI_AUTH_SOURCE_KEYS, { methods: ["oauth", "key"] }))
      .filter((row) => (OPENAI_AUTH_SOURCE_KEYS as readonly string[]).includes(row.integrationId))
      // Active is per integration: keep the session's active login first, then
      // other active logins, preserving source order within each set. Without
      // the session's login, an active OAuth login (which has quota numbers)
      // goes before an active API key (which only has a status).
      .sort((left, right) => {
        const activeOrder = Number(right.active) - Number(left.active);
        if (activeOrder !== 0 || !left.active) return activeOrder;
        const sessionOrder =
          Number(right.integrationId === currentIntegrationId) -
          Number(left.integrationId === currentIntegrationId);
        if (sessionOrder !== 0) return sessionOrder;
        return Number(left.value.type === "api") - Number(right.value.type === "api");
      });
    // A failed login stays in the list so it shows as its own error row.
    const credentials = rows.flatMap((row) => {
      if (row.value.type === "api") return [];
      const auth = resolveOpenAIOAuth({
        [row.integrationId]: credentialRowAuthEntry(row),
      } as AuthData);
      return auth.state === "none" ? [] : [{ row, auth }];
    });
    const entries: QuotaProviderResult["entries"] = [];
    const errors: QuotaProviderResult["errors"] = [];
    const mapResult = (
      result: Awaited<ReturnType<typeof queryOpenAIQuota>>,
      options: { group?: string; sourceId?: string } = {},
    ) =>
      mapNullableProviderResult(result, {
        errorLabel: options.group ?? "OpenAI",
        onSuccess: (result) => {
          const group = options.group ?? result.label;
          const optionalEntries = openAiOptionalValueEntries({
            group,
            ...(options.sourceId ? { sourceId: options.sourceId } : {}),
            credits: result.credits,
            bankedResets: result.bankedResets,
          });
          const windowEntries = withOpenAiWindowRowKeys(
            groupedPercentWindowEntries({
              group,
              accounting: {
                resultType: "rate_limit",
                acquisitionMethod: "remote_api",
                ownership: "maintained",
                authority: "provider_reported",
                ...(options.sourceId ? { sourceId: options.sourceId } : {}),
              },
              windows: [
                { window: result.windows.hourly, suffix: "5h", label: "5h:" },
                { window: result.windows.weekly, suffix: "Weekly", label: "Weekly:" },
                { window: result.windows.monthly, suffix: "Monthly", label: "Monthly:" },
                {
                  window: result.windows.codeReview,
                  suffix: "Code Review",
                  label: "Code Review:",
                },
              ],
              fallbackWhenEmpty: optionalEntries.length === 0,
            }),
          );
          return attemptedResult([...windowEntries, ...optionalEntries], [], {
            singleWindowDisplayName: group,
          });
        },
      });
    const results = await Promise.all(
      credentials
        .filter(({ row }) => !isTokenSharingLogin(row))
        .map(async ({ row, auth }) => ({
          row,
          result: await queryOpenAIQuota({
            requestTimeoutMs: ctx.config?.requestTimeoutMs,
            auth,
            loginLabel: row.label,
            ...(ctx.openaiResetDetailsVisible?.(row.id) === true
              ? { includeResetDetails: true }
              : {}),
          }),
        })),
    );
    const resultByRow = new Map(results.map(({ row, result }) => [row, result]));
    // Names span every stored account (OAuth and API key) so numbering and the
    // `(active)` marker match the accounts OpenCode actually holds.
    const names = formatCredentialDisplayNames(
      "OpenAI",
      rows.map((row) => {
        const result = resultByRow.get(row);
        return {
          row,
          fallbackName: result?.success ? result.label : "OpenAI",
          numberUnnamed: row.value.type === "api",
        };
      }),
    );
    const nameByRow = new Map(rows.map((row, index) => [row, names[index]]));
    const accounts = rows.map((row) => ({
      sourceId: row.id,
      label: nameByRow.get(row) ?? "OpenAI",
      active: row.active,
    }));

    for (const row of rows) {
      const name = nameByRow.get(row) ?? "OpenAI";
      if (isTokenSharingLogin(row)) {
        entries.push(
          statusValueEntry(row, name, "ChatGPT quota unavailable for Sign in with ChatGPT"),
        );
        continue;
      }
      if (row.value.type !== "api") {
        const providerResult = mapResult(resultByRow.get(row) ?? null, {
          group: name,
          sourceId: row.id,
        });
        entries.push(...providerResult.entries);
        errors.push(...providerResult.errors.map((error) => ({ ...error, sourceId: row.id })));
        continue;
      }

      // ChatGPT's usage endpoint only accepts OAuth credentials, so an API-key
      // account reports its lack of ChatGPT quota instead of a quota number.
      if (row.resolveError !== undefined) {
        errors.push({
          label: name,
          message: `OpenAI API key could not be read: ${row.resolveError}`,
          sourceId: row.id,
        });
        continue;
      }
      entries.push(statusValueEntry(row, name, "ChatGPT quota unavailable for API key"));
    }

    const providerResult =
      entries.length > 0 || errors.length > 0
        ? attemptedResult(entries, errors)
        : mapResult(await queryOpenAIQuota({ requestTimeoutMs: ctx.config?.requestTimeoutMs }));
    const resultWithAccounts: QuotaProviderResult =
      accounts.length > 0 ? { ...providerResult, accounts } : providerResult;

    // The active account describes the status; a row OpenCode did not mark
    // active (e.g. an env-selected connection or a failed active lookup) must
    // not be reported as the active one.
    const activeRow = rows.find((row) => row.active);
    let authConfigured = "false";
    let authSource = "(none)";
    // OpenCode 2's sign-in method, e.g. chatgpt-token-sharing ("Sign in with ChatGPT").
    let authMethod = "(none)";
    let tokenStatus = "(none)";
    let tokenExpiresAt = "(none)";
    if (activeRow) {
      if (typeof activeRow.value.methodID === "string") authMethod = activeRow.value.methodID;
      if (activeRow.value.type === "api") {
        authConfigured = "true";
        authSource = activeRow.integrationId;
        tokenStatus = activeRow.resolveError !== undefined ? "failed" : "api key";
      } else {
        const auth = credentials.find(({ row }) => row === activeRow)?.auth;
        if (auth) {
          const expiresAt = auth.state === "configured" ? auth.expiresAt : undefined;
          authConfigured = "true";
          authSource = auth.sourceKey;
          tokenStatus =
            auth.state === "failed"
              ? "failed"
              : expiresAt && expiresAt < Date.now()
                ? "expired"
                : "valid";
          tokenExpiresAt = expiresAt ? new Date(expiresAt).toISOString() : "(none)";
        }
      }
    } else if (rows.length > 0) {
      // Stored accounts exist, but which one is active is unknown.
      authConfigured = "true";
      authSource = "unknown";
      authMethod = "unknown";
      tokenStatus = "unknown";
      tokenExpiresAt = "unknown";
    }
    return withStatusDetails(
      resultWithAccounts,
      statusDetailsFromRecord({
        auth_configured: authConfigured,
        auth_source: authSource,
        auth_method: authMethod,
        token_status: tokenStatus,
        token_expires_at: tokenExpiresAt,
      }),
    );
  },
};
