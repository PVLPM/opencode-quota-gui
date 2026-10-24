/**
 * OpenCode Console credential reader
 *
 * OpenCode 2 keeps its OpenCode Console sign-in (`opencode auth login opencode`)
 * under the `opencode` integration as an OAuth connection created by the device
 * flow (`client_id: opencode-cli`, default server `https://opencode.ai/console`,
 * stored as `metadata.server`). Consumers call the console APIs with
 * `consoleBaseUrl` and `consoleHeaders`: the access token as
 * `Authorization: Bearer`, plus `metadata.orgID` as `x-org-id` when present.
 *
 * The login is read through OpenCode's plugin API, which refreshes a token that
 * is about to expire (and saves the new one) before returning it. A failed
 * refresh is reported as `invalid`.
 *
 * A user can keep several Console workspaces signed in. The multi-workspace
 * reader enumerates them; the original single reader still returns only the
 * active login for callers that need OpenCode's own precedence.
 */

import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import {
  type CredentialRow,
  readCredentialRows,
  scrubCredentialErrorText,
} from "./opencode-auth.js";

export const OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai/console";
export const OPENCODE_CONSOLE_INTEGRATION_ID = "opencode";

export interface OpenCodeConsoleCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
  orgId?: string;
  orgName?: string;
  email?: string;
  server?: string;
}

export type OpenCodeConsoleAuthState =
  | { state: "none"; reason?: "not_oauth" }
  | { state: "configured"; credential: OpenCodeConsoleCredential }
  | { state: "expired"; credential: OpenCodeConsoleCredential }
  | { state: "invalid"; error: string };

/** One stored Console login, with the stable connection id it came from. */
interface OpenCodeConsoleAccountBase {
  /** Stable OpenCode connection id; safe to use as an accounting source id. */
  sourceId: string;
  /** Workspace label: org name, then a safe connection alias, then `Account N`. */
  label: string;
  /** Whether OpenCode uses this connection as the integration's active login. */
  active: boolean;
}

export type OpenCodeConsoleAuthAccount =
  | (OpenCodeConsoleAccountBase & {
      state: "configured";
      credential: OpenCodeConsoleCredential;
    })
  | (OpenCodeConsoleAccountBase & {
      state: "expired";
      credential: OpenCodeConsoleCredential;
    })
  | (OpenCodeConsoleAccountBase & { state: "invalid"; error: string });

/**
 * Connection labels OpenCode assigns when the user never named the connection.
 * They identify no workspace, so they must not become an account label.
 */
const GENERIC_CONSOLE_ALIASES: ReadonlySet<string> = new Set([
  "default",
  "oauth",
  "api key",
  OPENCODE_CONSOLE_INTEGRATION_ID,
  "opencode console",
]);

function metadataRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  return value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? (value.metadata as Record<string, unknown>)
    : null;
}

function textValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = sanitizeSingleLineDisplayText(value);
  return text || undefined;
}

function credentialFromValue(value: Record<string, unknown>): OpenCodeConsoleCredential {
  const metadata = metadataRecord(value);
  return {
    accessToken: typeof value.access === "string" ? value.access.trim() : "",
    refreshToken:
      typeof value.refresh === "string" && value.refresh.trim() ? value.refresh : undefined,
    expiresAt: typeof value.expires === "number" ? value.expires : undefined,
    accountId: textValue(metadata?.accountID),
    orgId: textValue(metadata?.orgID),
    orgName: textValue(metadata?.orgName),
    email: textValue(metadata?.email),
    server: textValue(metadata?.server),
  };
}

/**
 * The workspace label for one login. The org name names the workspace; a
 * user-set connection alias is the next best stable, safe choice. Generic
 * OpenCode aliases carry no workspace meaning, so they use the row's generic
 * account number instead of repeating the provider name.
 */
function consoleAccountLabel(
  row: CredentialRow,
  accountNumber: number,
  credential?: OpenCodeConsoleCredential,
): string {
  const orgName = credential?.orgName;
  if (orgName) return orgName;

  const alias = sanitizeSingleLineDisplayText(row.label);
  if (alias && !GENERIC_CONSOLE_ALIASES.has(alias.toLowerCase())) return alias;

  return `Account ${accountNumber}`;
}

/**
 * The effective workspace credential a login belongs to. A workspace is its
 * org plus the member account inside it: member budgets and Console permissions
 * are account-specific, so two members of one org are two credentials. A login
 * without an account id can only prove itself by its token, which collapses
 * aliases of one stored credential without merging distinct members. The
 * Console URL qualifies the key so org ids from different servers never
 * collapse together.
 */
function effectiveWorkspaceKey(credential: OpenCodeConsoleCredential): string {
  const account = credential.accountId ?? `token:${credential.accessToken}`;
  return `${consoleBaseUrl(credential)}\u0000org:${credential.orgId ?? ""}\u0000${account}`;
}

/**
 * Read every OAuth login under the `opencode` integration, one entry per stored
 * connection, in OpenCode's order (active first). API-key rows are not Console
 * sign-ins and are skipped. Missing tokens, failed refreshes, and expired
 * logins stay in the list so each can be reported separately.
 *
 * Configured logins that resolve to the same effective workspace credential are
 * collapsed to one entry (the active row wins when it comes first). Distinct
 * orgs and distinct member accounts never collapse, even when only one of them
 * is active.
 */
export async function resolveOpenCodeConsoleAuthAccounts(params?: {
  nowMs?: number;
  /**
   * @deprecated Unnamed workspaces now use a per-row `Account N` label. Kept
   * only so existing callers compiled against the previous signature still type
   * check.
   */
  fallbackLabel?: string;
}): Promise<OpenCodeConsoleAuthAccount[]> {
  const nowMs = params?.nowMs ?? Date.now();
  const rows = await readCredentialRows([OPENCODE_CONSOLE_INTEGRATION_ID], {
    methods: ["oauth"],
  });

  const accounts: OpenCodeConsoleAuthAccount[] = [];
  const workspaceIndexes = new Map<string, number>();

  for (const row of rows) {
    if (row.value.type !== "oauth") continue;

    if (row.resolveError !== undefined) {
      accounts.push({
        state: "invalid",
        sourceId: row.id,
        label: consoleAccountLabel(row, accounts.length + 1),
        active: row.active,
        error: row.resolveError,
      });
      continue;
    }

    const credential = credentialFromValue(row.value);

    if (!credential.accessToken) {
      accounts.push({
        state: "invalid",
        sourceId: row.id,
        label: consoleAccountLabel(row, accounts.length + 1, credential),
        active: row.active,
        error: "OpenCode Console credential has no access token",
      });
      continue;
    }

    if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
      accounts.push({
        state: "expired",
        sourceId: row.id,
        label: consoleAccountLabel(row, accounts.length + 1, credential),
        active: row.active,
        credential,
      });
      continue;
    }

    const workspaceKey = effectiveWorkspaceKey(credential);
    const existingIndex = workspaceIndexes.get(workspaceKey);
    const accountNumber = existingIndex === undefined ? accounts.length + 1 : existingIndex + 1;
    const label = consoleAccountLabel(row, accountNumber, credential);
    if (existingIndex !== undefined) {
      const existing = accounts[existingIndex];
      // OpenCode lists the active row first, but keep the active credential if
      // a source ever returns it later. Distinct workspaces never collide.
      if (existing?.state === "configured" && !existing.active && row.active) {
        accounts[existingIndex] = {
          state: "configured",
          sourceId: row.id,
          label,
          active: row.active,
          credential,
        };
      }
      continue;
    }
    workspaceIndexes.set(workspaceKey, accounts.length);

    accounts.push({
      state: "configured",
      sourceId: row.id,
      label,
      active: row.active,
      credential,
    });
  }

  return accounts;
}

export async function resolveOpenCodeConsoleAuth(params?: {
  nowMs?: number;
}): Promise<OpenCodeConsoleAuthState> {
  // Only the active Console login counts, the way OpenCode itself picks it.
  const rows = await readCredentialRows([OPENCODE_CONSOLE_INTEGRATION_ID], { firstOnly: true });
  const row = rows[0];
  if (!row) return { state: "none" };
  if (row.resolveError !== undefined) return { state: "invalid", error: row.resolveError };

  const value = row.value;
  // An API key under `opencode` (service account or workspace key) is not a sign-in.
  if (value.type !== "oauth") return { state: "none", reason: "not_oauth" };

  const credential = credentialFromValue(value);
  if (!credential.accessToken) {
    return { state: "invalid", error: "OpenCode Console credential has no access token" };
  }

  const nowMs = params?.nowMs ?? Date.now();
  if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) {
    return { state: "expired", credential };
  }

  return { state: "configured", credential };
}

/** The Console server the login belongs to. */
export function consoleBaseUrl(credential: OpenCodeConsoleCredential): string {
  return credential.server ?? OPENCODE_CONSOLE_BASE_URL;
}

/**
 * Safe one-line text for a Console request that threw outside its API client's
 * own error handling. The login's access token is removed before scrubbing.
 */
export function consoleUnexpectedErrorText(
  error: unknown,
  credential: OpenCodeConsoleCredential,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const redacted = credential.accessToken
    ? raw.replaceAll(credential.accessToken, "[redacted]")
    : raw;
  return scrubCredentialErrorText(redacted) || "unknown error";
}

/** Console API request headers; `x-org-id` only when the login has an org. */
export function consoleHeaders(credential: OpenCodeConsoleCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    ...(typeof credential.orgId === "string" ? { "x-org-id": credential.orgId } : {}),
  };
}
