/**
 * OpenRouter key usage fetcher.
 *
 * Reuses the custom-provider OpenRouter mapping so built-in and custom
 * OpenRouter sources interpret the API response identically.
 */

import {
  getApiKeyCheckedPaths,
  getGlobalOpencodeConfigCandidatePaths,
} from "./api-key-resolver.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import {
  type CredentialRow,
  formatCredentialDisplayNames,
  getCredentialDatabasePaths,
  readCredentialRows,
  scrubCredentialErrorText,
} from "./opencode-auth.js";
import type { RemoteApiQuotaProviderDefinition } from "./quota-providers.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthResolution,
  type QuotaProviderAuthSource,
  type RemoteQuotaProviderResult,
  resolveQuotaProviderApiKey,
} from "./quota-providers-remote.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";

const OPENROUTER_ID = "openrouter";
const OPENROUTER_LABEL = "OpenRouter";
const OPENROUTER_KEY_SOURCE = {
  id: OPENROUTER_ID,
  providerId: OPENROUTER_ID,
  label: OPENROUTER_LABEL,
  mode: "remote-api",
  url: "https://openrouter.ai/api/v1/key",
  apiKeyEnv: "OPENROUTER_API_KEY",
  format: "openrouter-key-v1",
} satisfies RemoteApiQuotaProviderDefinition;

const GENERIC_CREDENTIAL_ALIASES: ReadonlySet<string> = new Set(["default", "oauth", "api key"]);

function plainAccountLabel(row: CredentialRow, index: number): string {
  const alias = sanitizeSingleLineDisplayText(row.label).trim();
  if (
    !alias ||
    GENERIC_CREDENTIAL_ALIASES.has(alias.toLowerCase()) ||
    alias.toLowerCase() === OPENROUTER_LABEL.toLowerCase()
  ) {
    return `Account ${index + 1}`;
  }
  return alias;
}

export interface OpenRouterAuthAccount {
  /** Stable OpenCode connection id for a stored API-key login. */
  sourceId?: string;
  /** Plain display alias used as the card's account label. */
  label: string;
  /** Legacy bracketed group header for provider-entry rows. */
  groupLabel?: string;
  /** Whether OpenCode marks this stored login as the active one. */
  active?: boolean;
  /** Present when the account can be queried. */
  resolved?: QuotaProviderAuthResolution;
  /** Present when OpenCode could not return a usable API key for the login. */
  error?: string;
}

export interface OpenRouterAuthResolution {
  accounts: OpenRouterAuthAccount[];
  checkedPaths: string[];
  credentialDatabasePaths: string[];
  /** The source backing the effective accounts, or null when none exists. */
  source: QuotaProviderAuthSource | null;
}

function openRouterCheckedPaths(): string[] {
  return getApiKeyCheckedPaths({
    envVarNames: OPENROUTER_KEY_SOURCE.apiKeyEnv ? [OPENROUTER_KEY_SOURCE.apiKeyEnv] : [],
    getConfigCandidates: getGlobalOpencodeConfigCandidatePaths,
  });
}

function extractStoredKey(
  row: CredentialRow,
): { key: string; error?: never } | { key?: never; error: string } {
  if (row.resolveError !== undefined) {
    return {
      error: `OpenCode could not read this login: ${scrubCredentialErrorText(row.resolveError)}`,
    };
  }
  if (row.value.type !== "api") {
    return { error: "OpenRouter login is not an API key" };
  }
  const key = typeof row.value.key === "string" ? row.value.key.trim() : "";
  return key.length > 0 ? { key } : { error: "OpenRouter API key is empty" };
}

function storedAccount(
  row: CredentialRow,
  label: string,
  groupLabel: string,
  checkedPaths: string[],
  credentialDatabasePaths: string[],
): OpenRouterAuthAccount {
  const extracted = extractStoredKey(row);
  return {
    sourceId: row.id,
    label,
    groupLabel,
    active: row.active,
    ...(extracted.key
      ? {
          resolved: {
            key: extracted.key,
            source: "opencode.db",
            checkedPaths,
            credentialDatabasePaths,
          } satisfies QuotaProviderAuthResolution,
        }
      : { error: extracted.error }),
  };
}

/**
 * Resolves every effective OpenRouter API key.
 *
 * Stored OpenCode API-key rows win over env/config and are queried
 * independently, one account per row. Their aliases are display descriptors
 * only. Failed stored rows stay visible account-locally; env/config is used
 * only when no stored row yields a usable key.
 */
export async function resolveOpenRouterAuth(): Promise<OpenRouterAuthResolution> {
  const storedRows = await readCredentialRows([OPENROUTER_ID], { methods: ["key"] });
  const checkedPaths = openRouterCheckedPaths();
  const credentialDatabasePaths = getCredentialDatabasePaths();
  const displayNames = formatCredentialDisplayNames(
    OPENROUTER_LABEL,
    storedRows.map((row) => ({ row, fallbackName: OPENROUTER_LABEL })),
  );
  const accounts = storedRows.map((row, index) =>
    storedAccount(
      row,
      plainAccountLabel(row, index),
      displayNames[index] ?? OPENROUTER_LABEL,
      checkedPaths,
      credentialDatabasePaths,
    ),
  );

  const hasStoredKey = accounts.some((account) => account.resolved?.key);
  if (hasStoredKey) {
    return {
      accounts,
      checkedPaths,
      credentialDatabasePaths,
      source: "opencode.db",
    };
  }

  const fallback = await resolveQuotaProviderApiKey(OPENROUTER_KEY_SOURCE);
  if (fallback.key) {
    accounts.push({ label: OPENROUTER_LABEL, groupLabel: OPENROUTER_LABEL, resolved: fallback });
    return {
      accounts,
      checkedPaths: fallback.checkedPaths,
      credentialDatabasePaths: fallback.credentialDatabasePaths,
      source: fallback.source,
    };
  }

  return {
    accounts,
    checkedPaths: fallback.checkedPaths,
    credentialDatabasePaths: fallback.credentialDatabasePaths,
    source: null,
  };
}

/**
 * Compatibility view of the winning key for callers that still need one
 * resolution. Multi-account callers use `resolveOpenRouterAuth` instead.
 */
export async function resolveOpenRouterApiKey(): Promise<QuotaProviderAuthResolution> {
  const auth = await resolveOpenRouterAuth();
  const account =
    auth.accounts.find((candidate) => candidate.resolved?.key && candidate.active) ??
    auth.accounts.find((candidate) => candidate.resolved?.key);
  if (account?.resolved) return account.resolved;

  return {
    source: null,
    checkedPaths: auth.checkedPaths,
    credentialDatabasePaths: auth.credentialDatabasePaths,
  };
}

export async function hasOpenRouterApiKeyConfigured(): Promise<boolean> {
  return (await resolveOpenRouterAuth()).accounts.some((account) => Boolean(account.resolved?.key));
}

function accountIdentityDescriptor(account: OpenRouterAuthAccount): string {
  return JSON.stringify({
    sourceId: account.sourceId ?? null,
    label: account.label,
    groupLabel: account.groupLabel ?? null,
    active: account.active ?? null,
    source: account.resolved?.source ?? null,
    state: account.resolved?.key ? "usable" : "failed",
    error: account.error ?? null,
  });
}

async function accountIdentity(
  account: OpenRouterAuthAccount,
): Promise<ResolvedAuthIdentity | null> {
  const qualifiers = [accountIdentityDescriptor(account)];
  return account.resolved?.key
    ? deriveResolvedAuthIdentity({
        providerId: OPENROUTER_ID,
        principal: { kind: "credential", value: account.resolved.key },
        qualifiers,
      })
    : deriveResolvedAuthIdentity({
        providerId: OPENROUTER_ID,
        principal: { kind: "stable-id", value: `account:${account.sourceId ?? "unknown"}` },
        qualifiers,
      });
}

/**
 * Cache identity covering every effective stored key, or the env/config
 * fallback when no stored key is usable. Stored account descriptors, source
 * ids, and failure state are hashed alongside keys so alias/source/error
 * changes invalidate cached cards. The result never contains a raw key.
 */
export async function resolveOpenRouterAuthIdentity(): Promise<ResolvedAuthIdentity | null> {
  const auth = await resolveOpenRouterAuth();
  if (auth.accounts.length === 0) return null;

  // A lone env/config fallback keeps the historical key-only identity.
  if (auth.accounts.length === 1 && auth.accounts[0].sourceId === undefined) {
    const key = auth.accounts[0].resolved?.key;
    if (!key) return null;
    return await deriveResolvedAuthIdentity({
      providerId: OPENROUTER_ID,
      principal: { kind: "credential", value: key },
    });
  }

  const ordered = [...auth.accounts].sort((left, right) => {
    const leftKey = left.sourceId ?? "\uffff";
    const rightKey = right.sourceId ?? "\uffff";
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const identities = await Promise.all(ordered.map(accountIdentity));
  // A failed derivation would make the composition cover fewer accounts than
  // the provider reports, so fail closed to uncached instead of under-identifying.
  if (identities.some((identity) => identity === null)) return null;
  const onlyIdentity = identities[0];
  if (onlyIdentity === undefined) return null;
  if (identities.length === 1) return onlyIdentity;

  return await composeResolvedAuthIdentities({
    providerId: OPENROUTER_ID,
    identities: identities as ResolvedAuthIdentity[],
  });
}

export async function queryOpenRouterQuota(options: {
  requestTimeoutMs?: number;
  resolved: QuotaProviderAuthResolution;
  /** Account alias used for this key's independent row group. */
  label?: string;
  /** Stable stored-connection id attached to this key's rows. */
  sourceId?: string;
}): Promise<RemoteQuotaProviderResult | null> {
  if (!options.resolved.key) return null;

  const source = options.label
    ? { ...OPENROUTER_KEY_SOURCE, label: options.label }
    : OPENROUTER_KEY_SOURCE;
  const result = await fetchRemoteQuotaProvider(
    source,
    options.resolved.key,
    options.requestTimeoutMs,
  );
  if (!result.success) return result;

  return {
    ...result,
    entries: result.entries.map((entry) => ({
      ...entry,
      accounting: {
        ...entry.accounting,
        ownership: "maintained",
        ...(options.sourceId ? { sourceId: options.sourceId } : {}),
      },
    })),
  };
}
