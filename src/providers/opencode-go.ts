import { createHash } from "node:crypto";

import type {
  QuotaProvider,
  QuotaProviderContext,
  QuotaProviderResult,
  QuotaProviderStatusDetail,
  QuotaToastEntry,
} from "../lib/entries.js";
import {
  credentialRowAuthEntry,
  formatCredentialDisplayNames,
  readCredentialRows,
  scrubCredentialErrorText,
  selectConnectionCredentialRows,
} from "../lib/opencode-auth.js";
import {
  consoleBaseUrl,
  consoleUnexpectedErrorText,
  type OpenCodeConsoleAuthAccount,
  resolveOpenCodeConsoleAuthAccounts,
} from "../lib/opencode-console-auth.js";
import { queryOpenCodeGoConsoleStatus, queryOpenCodeGoQuota } from "../lib/opencode-go.js";
import {
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  getOpenCodeGoAuthDiagnostics,
  OPENCODE_GO_CREDENTIAL_INTEGRATION_IDS,
  type OpenCodeGoAuthDiagnostics,
  resolveOpenCodeGoAuth,
  resolveOpenCodeGoAuthCached,
} from "../lib/opencode-go-auth.js";
import { normalizeQuotaProviderId } from "../lib/provider-metadata.js";
import type { OpenCodeGoResult, OpenCodeGoWindowKey } from "../lib/types.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

const OPENCODE_GO_PROVIDER_LABEL = "OpenCode Go";
const CONSOLE_LOGIN_HINT = "Run `opencode auth login opencode`.";
const OPENCODE_GO_WINDOW_ORDER: OpenCodeGoWindowKey[] = ["rolling", "weekly", "monthly"];
const OPENCODE_GO_WINDOW_LABELS: Record<OpenCodeGoWindowKey, { name: string; label: string }> = {
  rolling: { name: `${OPENCODE_GO_PROVIDER_LABEL} 5h`, label: "5h:" },
  weekly: { name: `${OPENCODE_GO_PROVIDER_LABEL} Weekly`, label: "Weekly:" },
  monthly: { name: `${OPENCODE_GO_PROVIDER_LABEL} Monthly`, label: "Monthly:" },
};
/** Stable explicit row keys (metric + window) for the percent-only window rows. */
const OPENCODE_GO_WINDOW_ROW_KEYS: Record<OpenCodeGoWindowKey, string> = {
  rolling: "window:five_hour",
  weekly: "window:week",
  monthly: "window:month",
};

const notSubscribedCredentialFingerprints = new Set<string>();

export function __resetOpenCodeGoNotSubscribedForTests(): void {
  notSubscribedCredentialFingerprints.clear();
}

function fingerprintCredential(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

function retainCurrentCredentialFingerprints(current: ReadonlySet<string>): void {
  for (const fingerprint of notSubscribedCredentialFingerprints) {
    if (!current.has(fingerprint)) notSubscribedCredentialFingerprints.delete(fingerprint);
  }
}

function authStatusDetails(diagnostics: OpenCodeGoAuthDiagnostics): QuotaProviderStatusDetail[] {
  return statusDetailsFromRecord({
    auth_state: diagnostics.state,
    auth_source: diagnostics.source ?? "(none)",
    auth_checked_paths: diagnostics.checkedPaths.join(" | ") || "(none)",
    credential_database_paths: diagnostics.credentialDatabasePaths.join(" | ") || "(none)",
    auth_error: diagnostics.state === "invalid" ? diagnostics.error : undefined,
  });
}

function buildOpenCodeGoEntries(
  result: Extract<OpenCodeGoResult, { success: true }>,
  selectedWindows: OpenCodeGoWindowKey[],
  group = OPENCODE_GO_PROVIDER_LABEL,
  sourceId?: string,
): QuotaToastEntry[] {
  const selected = new Set(selectedWindows);
  const entries: QuotaToastEntry[] = [];

  for (const window of OPENCODE_GO_WINDOW_ORDER) {
    if (!selected.has(window)) continue;

    const usage = result[window];
    const labels = OPENCODE_GO_WINDOW_LABELS[window];
    entries.push({
      accounting: {
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
        ...(sourceId ? { sourceId } : {}),
      },
      name: `${group} ${labels.label.slice(0, -1)}`,
      group,
      label: labels.label,
      rowKey: OPENCODE_GO_WINDOW_ROW_KEYS[window],
      percentRemaining: usage.percentRemaining,
      ...(usage.resetTimeIso !== undefined ? { resetTimeIso: usage.resetTimeIso } : {}),
    });
  }

  return entries;
}

function consoleAccountDescriptor(account: OpenCodeConsoleAuthAccount): {
  sourceId: string;
  label: string;
  active: boolean;
} {
  return { sourceId: account.sourceId, label: account.label, active: account.active };
}

function consoleSignInFailure(account: OpenCodeConsoleAuthAccount): string {
  const detail =
    account.state === "invalid" ? scrubCredentialErrorText(account.error) : "the sign-in expired";
  return `OpenCode Console sign-in failed: ${detail}. ${CONSOLE_LOGIN_HINT}`;
}

/**
 * Query one workspace. The API client reports expected failures as a result,
 * but an unexpected throw must stay local to this workspace.
 */
async function queryConsoleStatus(
  account: Extract<OpenCodeConsoleAuthAccount, { state: "configured" }>,
  ctx: QuotaProviderContext,
): Promise<OpenCodeGoResult> {
  try {
    return await queryOpenCodeGoConsoleStatus(account.credential, {
      requestTimeoutMs: ctx.config.requestTimeoutMs,
    });
  } catch (error) {
    return {
      success: false,
      error: `OpenCode Console request failed: ${consoleUnexpectedErrorText(error, account.credential)}`,
      retryable: true,
    };
  }
}

function consoleAccountsState(accounts: readonly OpenCodeConsoleAuthAccount[]): string {
  const states = new Set(accounts.map((account) => account.state));
  if (states.size === 1) return [...states][0] ?? "none";
  return states.has("configured") ? "mixed" : "invalid";
}

/**
 * Safe diagnostics for the Console workspace set. The first workspace keeps
 * the old single-account keys; every workspace is also represented by a
 * source-id-keyed detail when it has a failure.
 */
function consoleAccountsStatusDetails(
  accounts: readonly OpenCodeConsoleAuthAccount[],
  errorsBySourceId: ReadonlyMap<string, string> = new Map(),
): QuotaProviderStatusDetail[] {
  const details: QuotaProviderStatusDetail[] = [
    { key: "console_accounts", value: String(accounts.length) },
    { key: "console_auth_state", value: consoleAccountsState(accounts) },
  ];
  const failureMessages: string[] = [];
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
  for (const account of accounts) {
    if (account.state === "invalid") {
      const message = scrubCredentialErrorText(account.error);
      failureMessages.push(message);
      details.push({
        key: `console_account_error:${account.sourceId}`,
        value: `${account.label}: ${message}`,
      });
    } else if (account.state === "expired") {
      failureMessages.push("the sign-in expired");
      details.push({
        key: `console_account_error:${account.sourceId}`,
        value: `${account.label}: the sign-in expired`,
      });
    }
    const fetchError = errorsBySourceId.get(account.sourceId);
    if (fetchError) {
      failureMessages.push(fetchError);
      details.push({
        key: `console_account_error:${account.sourceId}`,
        value: `${account.label}: ${fetchError}`,
      });
    }
  }
  // Keep the old single-account key when there is exactly one failure.
  if (failureMessages.length === 1) {
    details.push({ key: "console_error", value: failureMessages[0] ?? "(unknown)" });
  }
  return details;
}

/**
 * Query each stored Console workspace with its own credential. Entitled
 * workspaces produce entries and account descriptors; a workspace without Go
 * produces neither, and a failed workspace keeps its own error row.
 */
async function fetchOpenCodeGoConsoleAccounts(
  ctx: QuotaProviderContext,
  windows: OpenCodeGoWindowKey[],
  consoleAccounts: readonly OpenCodeConsoleAuthAccount[],
): Promise<QuotaProviderResult> {
  const outcomes = await Promise.all(
    consoleAccounts.map(async (account) => {
      if (account.state !== "configured") return { account, result: null };
      return { account, result: await queryConsoleStatus(account, ctx) };
    }),
  );

  const entries: QuotaToastEntry[] = [];
  const errors: QuotaProviderResult["errors"] = [];
  const accounts: Array<{ sourceId: string; label: string; active: boolean }> = [];
  const fetchErrorsBySourceId = new Map<string, string>();
  let notSubscribedCount = 0;

  for (const { account, result } of outcomes) {
    if (account.state !== "configured") {
      errors.push({
        label: account.label,
        message: consoleSignInFailure(account),
        sourceId: account.sourceId,
      });
      accounts.push(consoleAccountDescriptor(account));
      continue;
    }
    if (!result) continue;
    if (result.success) {
      entries.push(
        ...buildOpenCodeGoEntries(result, windows, OPENCODE_GO_PROVIDER_LABEL, account.sourceId),
      );
      accounts.push(consoleAccountDescriptor(account));
      continue;
    }
    if (result.notSubscribed === true) {
      // The sign-in works but this workspace has no Go entitlement: no card.
      notSubscribedCount += 1;
      continue;
    }
    errors.push({
      label: account.label,
      message: result.error,
      retryable: result.retryable,
      sourceId: account.sourceId,
    });
    fetchErrorsBySourceId.set(account.sourceId, result.error);
    accounts.push(consoleAccountDescriptor(account));
  }

  const statusDetails = consoleAccountsStatusDetails(consoleAccounts, fetchErrorsBySourceId);
  if (entries.length > 0) {
    return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, [
      ...statusDetails,
      { key: "go_source", value: "console" },
      { key: "selected_windows", value: windows.join(",") },
    ]);
  }

  if (errors.length === 0) {
    // No workspace produced rows. Report the attempt only in diagnostics: a
    // non-attempted result keeps an all-not-entitled workspace set from
    // becoming an empty provider card.
    const noGoDetails: QuotaProviderStatusDetail[] = [
      ...statusDetails,
      ...(notSubscribedCount > 0 ? [{ key: "opencode_go_state", value: "not_subscribed" }] : []),
      { key: "selected_windows", value: windows.join(",") },
    ];
    return withStatusDetails(notAttemptedResult(), noGoDetails);
  }

  // The Console sign-in is readable but its request failed. Keep the legacy
  // API-key path available, and keep each failed workspace visible.
  const diagnostics = await getOpenCodeGoAuthDiagnostics({
    maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  });
  const legacy = await fetchOpenCodeGoLegacy(ctx, diagnostics, [
    ...authStatusDetails(diagnostics),
    ...statusDetails,
    { key: "go_source", value: "legacy_key" },
    { key: "selected_windows", value: windows.join(",") },
  ]);
  if (!legacy.attempted) {
    return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, [
      ...statusDetails,
      { key: "selected_windows", value: windows.join(",") },
    ]);
  }
  return withStatusDetails(
    {
      ...legacy,
      errors: [...legacy.errors, ...errors],
      accounts: [...(legacy.accounts ?? []), ...accounts],
    },
    legacy.statusDetails ?? statusDetails,
  );
}

export const opencodeGoProvider: QuotaProvider = {
  id: "opencode-go",

  async isAvailable(_ctx: QuotaProviderContext): Promise<boolean> {
    const consoleAccounts = await resolveOpenCodeConsoleAuthAccounts({
      fallbackLabel: OPENCODE_GO_PROVIDER_LABEL,
      enrichOrgNames: false,
    });
    if (consoleAccounts.length > 0) return true;

    // So far no Go entitlement is known; a configured workspace API key is the
    // legacy path that can still answer.
    const auth = await resolveOpenCodeGoAuthCached({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });
    if (auth.state !== "configured") {
      notSubscribedCredentialFingerprints.clear();
      return false;
    }
    return true;
  },

  matchesCurrentModel(model: string): boolean {
    const [provider] = model.toLowerCase().split("/", 2);
    return normalizeQuotaProviderId(provider) === "opencode-go";
  },

  async fetch(ctx: QuotaProviderContext): Promise<QuotaProviderResult> {
    const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
    const consoleAccounts = await resolveOpenCodeConsoleAuthAccounts({
      fallbackLabel: OPENCODE_GO_PROVIDER_LABEL,
      enrichOrgNames: true,
    });
    if (consoleAccounts.length > 0) {
      return await fetchOpenCodeGoConsoleAccounts(ctx, windows, consoleAccounts);
    }

    // No Console login: the legacy workspace API key is the only Go path left.
    const diagnostics = await getOpenCodeGoAuthDiagnostics({
      maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
    });
    return await fetchOpenCodeGoLegacy(ctx, diagnostics, [
      ...authStatusDetails(diagnostics),
      { key: "selected_windows", value: windows.join(",") },
    ]);
  },
};

/**
 * The legacy workspace API-key path. Without any key it stays not attempted;
 * a failed Console sign-in is already represented by its account descriptor
 * and error row in the caller.
 */
async function fetchOpenCodeGoLegacy(
  ctx: QuotaProviderContext,
  diagnostics: OpenCodeGoAuthDiagnostics,
  statusDetails?: QuotaProviderResult["statusDetails"],
): Promise<QuotaProviderResult> {
  const windows = ctx.config.opencodeGoWindows ?? OPENCODE_GO_WINDOW_ORDER;
  const baseStatusDetails = statusDetails ?? [];
  const auth = await resolveOpenCodeGoAuthCached({
    maxAgeMs: DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS,
  });

  if (auth.state === "none") {
    notSubscribedCredentialFingerprints.clear();
    return withStatusDetails(notAttemptedResult(), baseStatusDetails);
  }

  if (diagnostics.source === "opencode.db") {
    // `opencode` is a legacy alias of the `opencode-go` integration in the
    // credential database (see resolveOpenCodeGoAuth). Alias rows must not
    // become additional connections: prefer native rows and collapse rows
    // holding the same credential (e.g. Zen + Go sharing a workspace key).
    // Console OAuth credentials cannot authorize this API and are skipped.
    const credentialRows = selectConnectionCredentialRows(
      (await readCredentialRows(OPENCODE_GO_CREDENTIAL_INTEGRATION_IDS, { methods: ["key"] }))
        .filter((row) => OPENCODE_GO_CREDENTIAL_INTEGRATION_IDS.includes(row.integrationId))
        .filter((row) => row.value.type !== "oauth"),
      "opencode-go",
    );
    const rowNames = formatCredentialDisplayNames(
      OPENCODE_GO_PROVIDER_LABEL,
      credentialRows.map((row) => ({ row, fallbackName: OPENCODE_GO_PROVIDER_LABEL })),
    );
    const displayNamesByRowId = new Map(
      credentialRows.map((row, index) => [row.id, rowNames[index] ?? OPENCODE_GO_PROVIDER_LABEL]),
    );
    const invalidErrors: QuotaProviderResult["errors"] = [];
    const credentials = credentialRows.flatMap((row) => {
      const rowAuth = resolveOpenCodeGoAuth({ [row.integrationId]: credentialRowAuthEntry(row) });
      if (rowAuth.state === "invalid") {
        invalidErrors.push({
          label: displayNamesByRowId.get(row.id) ?? OPENCODE_GO_PROVIDER_LABEL,
          message: rowAuth.error,
          sourceId: row.id,
        });
      }
      return rowAuth.state === "configured" ? [{ row, auth: rowAuth }] : [];
    });
    if (credentials.length > 0 || invalidErrors.length > 0) {
      const credentialFingerprints = new Set(
        credentials.map(({ auth: rowAuth }) => fingerprintCredential(rowAuth.apiKey)),
      );
      retainCurrentCredentialFingerprints(credentialFingerprints);
      const results = await Promise.all(
        credentials.map(async ({ row, auth: rowAuth }) => {
          const fingerprint = fingerprintCredential(rowAuth.apiKey);
          if (notSubscribedCredentialFingerprints.has(fingerprint)) {
            return { row, result: null };
          }
          const result = await queryOpenCodeGoQuota(rowAuth.apiKey, {
            requestTimeoutMs: ctx.config.requestTimeoutMs,
          });
          if (!result.success && result.notSubscribed === true) {
            notSubscribedCredentialFingerprints.add(fingerprint);
            return { row, result: null };
          }
          return { row, result };
        }),
      );
      const entries: QuotaToastEntry[] = [];
      const errors: QuotaProviderResult["errors"] = [...invalidErrors];
      for (const { row, result } of results) {
        if (!result) continue;
        const group = displayNamesByRowId.get(row.id) ?? OPENCODE_GO_PROVIDER_LABEL;
        if (result.success) entries.push(...buildOpenCodeGoEntries(result, windows, group, row.id));
        else
          errors.push({
            label: group,
            message: result.error,
            retryable: result.retryable,
            sourceId: row.id,
          });
      }
      const attemptedSourceIds = new Set([
        ...errors.flatMap((error) => (error.sourceId ? [error.sourceId] : [])),
        ...entries.flatMap((entry) =>
          entry.accounting.sourceId ? [entry.accounting.sourceId] : [],
        ),
      ]);
      const accounts = credentialRows
        .filter((row) => attemptedSourceIds.has(row.id))
        .map((row) => ({
          sourceId: row.id,
          label: displayNamesByRowId.get(row.id) ?? OPENCODE_GO_PROVIDER_LABEL,
          active: row.active,
        }));
      return withStatusDetails({ ...attemptedResult(entries, errors), accounts }, [
        ...baseStatusDetails,
        ...(entries.length === 0 && errors.length === 0 && credentials.length > 0
          ? [{ key: "opencode_go_state", value: "not_subscribed" }]
          : []),
      ]);
    }
  }

  if (auth.state === "invalid") {
    notSubscribedCredentialFingerprints.clear();
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, auth.error),
      baseStatusDetails,
    );
  }

  const credentialFingerprint = fingerprintCredential(auth.apiKey);
  retainCurrentCredentialFingerprints(new Set([credentialFingerprint]));

  if (notSubscribedCredentialFingerprints.has(credentialFingerprint)) {
    return withStatusDetails(attemptedResult([]), [
      ...baseStatusDetails,
      { key: "opencode_go_state", value: "not_subscribed" },
    ]);
  }

  const result = await queryOpenCodeGoQuota(auth.apiKey, {
    requestTimeoutMs: ctx.config.requestTimeoutMs,
  });

  if (!result.success) {
    if (result.notSubscribed === true) {
      notSubscribedCredentialFingerprints.add(credentialFingerprint);
      return withStatusDetails(attemptedResult([]), [
        ...baseStatusDetails,
        { key: "opencode_go_state", value: "not_subscribed" },
      ]);
    }
    return withStatusDetails(
      attemptedErrorResult(OPENCODE_GO_PROVIDER_LABEL, result.error, {
        retryable: result.retryable,
      }),
      [...baseStatusDetails, { key: "live_fetch_error", value: result.error }],
    );
  }

  const liveDetails = OPENCODE_GO_WINDOW_ORDER.map((window) => {
    const usage = result[window];
    return {
      key: `${window}_usage`,
      value: `status=${usage.status} percent_used=${usage.usagePercent} percent_remaining=${usage.percentRemaining} reset_at=${usage.resetTimeIso ?? "(none)"}`,
    };
  });

  return withStatusDetails(attemptedResult(buildOpenCodeGoEntries(result, windows)), [
    ...baseStatusDetails,
    ...liveDetails,
  ]);
}
