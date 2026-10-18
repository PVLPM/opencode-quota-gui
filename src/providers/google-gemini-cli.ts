import { sanitizeDisplayText } from "../lib/display-sanitize.js";
import type {
  QuotaProvider,
  QuotaProviderAccount,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaToastEntry,
} from "../lib/entries.js";
import { deriveStableAccountIdentityKey } from "../lib/entries.js";
import {
  GEMINI_CLI_AUTH_KEYS,
  hasGeminiCliQuotaRuntimeAvailable,
  inspectGeminiCliAuthPresence,
  queryGeminiCliQuota,
} from "../lib/google-gemini-cli.js";
import { inspectGeminiCliCompanionPresence } from "../lib/google-gemini-cli-companion.js";
import { formatCredentialDisplayNames, readCredentialRows } from "../lib/opencode-auth.js";
import { parseProviderModelRef } from "../lib/provider-model-matching.js";
import type {
  AuthData,
  GeminiCliQuotaBucket,
  GeminiCliResult,
  GoogleAccountError,
} from "../lib/types.js";
import {
  createGoogleAccountLabelMap,
  formatGoogleAccountErrors,
  formatGoogleAccountLabel,
} from "./google-account-format.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

function isGeminiCliModel(model: string): boolean {
  const { providerId, modelId } = parseProviderModelRef(model);
  if (["google-gemini-cli", "gemini-cli", "gemini", "opencode-gemini-auth"].includes(providerId)) {
    return true;
  }
  return (
    providerId === "google" && !modelId.startsWith("antigravity-") && modelId.includes("gemini")
  );
}

async function isGeminiCliConfigured(): Promise<boolean> {
  try {
    return await hasGeminiCliQuotaRuntimeAvailable();
  } catch {
    return false;
  }
}

/** Stable explicit row key for one Gemini CLI bucket row (never the row label). */
export function geminiCliBucketRowKey(bucket: Pick<GeminiCliQuotaBucket, "displayName">): string {
  return `named:${bucket.displayName}`;
}

/**
 * Accounts of the legacy companion path (no `CredentialRow`). `sourceId` keeps
 * the historical raw email byte-identical for reset/cache compatibility while
 * `identityKey` carries a server-only email digest; a login OpenCode could not
 * return (error with no bucket) becomes a zero-entry failed account.
 */
export function buildGeminiCliLegacyAccounts(params: {
  buckets: readonly GeminiCliQuotaBucket[];
  errors?: readonly GoogleAccountError[];
  accountLabels: ReadonlyMap<string, string>;
}): QuotaProviderAccount[] {
  const accounts = new Map<string, QuotaProviderAccount>();
  const add = (email: string): void => {
    if (!email || accounts.has(email)) return;
    accounts.set(email, {
      sourceId: email,
      identityKey: deriveStableAccountIdentityKey(email),
      label: params.accountLabels.get(email) ?? formatGoogleAccountLabel(email, "domainHint"),
    });
  };
  for (const bucket of params.buckets) {
    if (bucket.accountEmail) add(bucket.accountEmail);
  }
  for (const error of params.errors ?? []) add(error.email);
  return [...accounts.values()];
}

export const googleGeminiCliProvider: QuotaProvider = {
  id: "google-gemini-cli",

  async isAvailable(): Promise<boolean> {
    return await isGeminiCliConfigured();
  },

  async isDiscovered(): Promise<boolean> {
    try {
      return (await inspectGeminiCliAuthPresence()).accountCount > 0;
    } catch {
      return false;
    }
  },

  matchesCurrentModel(model: string): boolean {
    return isGeminiCliModel(model);
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const [auth, companion] = await Promise.all([
      inspectGeminiCliAuthPresence(),
      inspectGeminiCliCompanionPresence(),
    ]);
    const statusDetails = statusDetailsFromRecord({
      auth_state: auth.state,
      auth_source: auth.sourceKey ?? "(none)",
      account_count: String(auth.accountCount),
      valid_account_count: String(auth.validAccountCount),
      companion_package_state: companion.state,
      companion_package_path:
        companion.state === "present" || companion.state === "invalid"
          ? (companion.resolvedPath ?? "(none)")
          : "(none)",
      auth_error: auth.state === "invalid" ? sanitizeDisplayText(auth.error) : undefined,
      companion_error:
        companion.state !== "present" ? sanitizeDisplayText(companion.error) : undefined,
    });
    const credentialRows = (
      await readCredentialRows(GEMINI_CLI_AUTH_KEYS, { methods: ["oauth"] })
    ).filter((row) =>
      ["google-gemini-cli", "gemini-cli", "opencode-gemini-auth", "gemini", "google"].includes(
        row.integrationId,
      ),
    );
    if (credentialRows.length > 0) {
      const results = await Promise.all(
        credentialRows.map(async (row) => ({
          row,
          result:
            row.resolveError !== undefined
              ? ({
                  success: false,
                  error: `Gemini CLI sign-in could not be refreshed: ${row.resolveError}. Run \`opencode auth login google\`.`,
                } satisfies GeminiCliResult)
              : await queryGeminiCliQuota({
                  requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
                    ? ctx.config.requestTimeoutMs
                    : undefined,
                  authData: { [row.integrationId]: row.value } as AuthData,
                }),
        })),
      );
      const names = formatCredentialDisplayNames(
        "Gemini CLI",
        results.map(({ row }) => ({ row, fallbackName: "Gemini CLI" })),
      );
      const accounts = results.map(({ row }, index) => ({
        sourceId: row.id,
        label: names[index] ?? "Gemini CLI",
        active: row.active,
      }));
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [];
      for (const [index, { row, result }] of results.entries()) {
        const group = names[index] ?? "Gemini CLI";
        if (!result) continue;
        if (!result.success) {
          errors.push({ label: group, message: result.error, sourceId: row.id });
          continue;
        }
        for (const bucket of result.buckets) {
          const parsedRemaining = bucket.remainingAmount
            ? Number.parseInt(bucket.remainingAmount, 10)
            : Number.NaN;
          const remainingAmount = bucket.remainingAmount
            ? `${Number.isFinite(parsedRemaining) ? parsedRemaining.toLocaleString("en-US") : bucket.remainingAmount} left`
            : undefined;
          const tokenType = bucket.tokenType?.trim().toUpperCase();
          const right = [
            remainingAmount,
            tokenType && tokenType !== "REQUESTS" ? tokenType : undefined,
          ]
            .filter(Boolean)
            .join(" ");
          entries.push({
            accounting: {
              resultType: "quota",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: row.id,
            },
            name: `${group} ${bucket.displayName}`,
            group,
            label: `${bucket.displayName}:`,
            rowKey: geminiCliBucketRowKey(bucket),
            ...(right ? { right } : {}),
            percentRemaining: bucket.percentRemaining,
            resetTimeIso: bucket.resetTimeIso,
          });
        }
        errors.push(
          ...(result.errors ?? []).map((error) => ({
            label: group,
            message: error.error,
            sourceId: row.id,
          })),
        );
      }
      return withStatusDetails(
        {
          ...attemptedResult(entries, errors, {
            singleWindowDisplayName: "Gemini CLI",
            singleWindowShowRight: true,
          }),
          accounts,
        },
        statusDetails,
      );
    }
    const result = await queryGeminiCliQuota({
      requestTimeoutMs: ctx.config?.requestTimeoutMsConfigured
        ? ctx.config.requestTimeoutMs
        : undefined,
    });

    if (!result) {
      return withStatusDetails(notAttemptedResult(), statusDetails);
    }

    if (!result.success) {
      return withStatusDetails(attemptedErrorResult("Gemini CLI", result.error), statusDetails);
    }

    const accountLabels = createGoogleAccountLabelMap(
      [
        ...result.buckets.map((bucket) => bucket.accountEmail),
        ...(result.errors ?? []).map((error) => error.email),
      ],
      "domainHint",
    );
    const entries: QuotaToastEntry[] = result.buckets.map((bucket) => {
      const emailLabel = bucket.accountEmail
        ? (accountLabels.get(bucket.accountEmail) ??
          formatGoogleAccountLabel(bucket.accountEmail, "domainHint"))
        : formatGoogleAccountLabel(undefined, "domainHint");
      const parsedRemaining = bucket.remainingAmount
        ? Number.parseInt(bucket.remainingAmount, 10)
        : Number.NaN;
      const remainingAmount = bucket.remainingAmount
        ? `${Number.isFinite(parsedRemaining) ? parsedRemaining.toLocaleString("en-US") : bucket.remainingAmount} left`
        : undefined;
      const tokenType = bucket.tokenType?.trim().toUpperCase();
      const right = [remainingAmount, tokenType && tokenType !== "REQUESTS" ? tokenType : undefined]
        .filter(Boolean)
        .join(" ");

      return {
        accounting: {
          resultType: "quota",
          acquisitionMethod: "remote_api",
          ownership: "maintained",
          authority: "provider_reported",
          ...(bucket.accountEmail ? { sourceId: bucket.accountEmail } : {}),
        },
        name: `${bucket.displayName} (${emailLabel})`,
        group: `Gemini CLI (${emailLabel})`,
        label: `${bucket.displayName}:`,
        rowKey: geminiCliBucketRowKey(bucket),
        ...(right ? { right } : {}),
        percentRemaining: bucket.percentRemaining,
        resetTimeIso: bucket.resetTimeIso,
      };
    });

    const legacyAccounts = buildGeminiCliLegacyAccounts({
      buckets: result.buckets,
      errors: result.errors,
      accountLabels,
    });
    const errors = formatGoogleAccountErrors(result.errors, "domainHint", accountLabels).map(
      (error, index) => {
        const email = result.errors?.[index]?.email;
        return email ? { ...error, sourceId: email } : error;
      },
    );

    return withStatusDetails(
      {
        ...attemptedResult(entries, errors, {
          singleWindowDisplayName: "Gemini CLI",
          singleWindowShowRight: true,
        }),
        ...(legacyAccounts.length > 0 ? { accounts: legacyAccounts } : {}),
      },
      statusDetails,
    );
  },
};
