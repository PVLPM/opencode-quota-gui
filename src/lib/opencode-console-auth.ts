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
import { fetchWithTimeout } from "./http.js";
import {
  type CredentialRow,
  readCredentialRows,
  scrubCredentialErrorText,
} from "./opencode-auth.js";

export const OPENCODE_CONSOLE_BASE_URL = "https://opencode.ai/console";
export const OPENCODE_CONSOLE_INTEGRATION_ID = "opencode";

/** How long a Console org name (including a failed lookup) is reused. */
export const OPENCODE_CONSOLE_ORG_CACHE_MAX_AGE_MS = 10 * 60 * 1000;
/** Upper bound on remembered server + org name lookups. */
export const OPENCODE_CONSOLE_ORG_CACHE_MAX_ENTRIES = 64;
/** Bounds one org-name request so a slow Console cannot stall a quota read. */
export const OPENCODE_CONSOLE_ORG_REQUEST_TIMEOUT_MS = 5_000;
/** Largest `/api/orgs` body read; a larger chunked stream is cancelled. */
export const OPENCODE_CONSOLE_ORG_RESPONSE_MAX_BYTES = 256 * 1024;

type ConsoleOrgNameCacheEntry = {
  name: string | null;
  expiresAt: number;
};

/**
 * Shared across callers and provider surfaces: the name belongs to the Console
 * org, not to whichever provider path asked. Failures are cached too so a
 * transient Console outage cannot turn every quota poll into a request.
 */
const consoleOrgNameCache = new Map<string, ConsoleOrgNameCacheEntry>();
const consoleOrgNameRequests = new Map<string, Promise<string | null>>();

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

/** A server URL reduced to the parts that identify one Console instance. */
function normalizedConsoleServer(server: string): string {
  const trimmed = server.trim();
  try {
    const url = new URL(trimmed);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * The org name cache is keyed by the Console instance and the org id. It is
 * deliberately not keyed by a display label or token: aliases are user-editable
 * and tokens rotate, while the name belongs to the org.
 */
function consoleOrgNameCacheKey(credential: OpenCodeConsoleCredential): string | null {
  if (!credential.orgId) return null;
  return `${normalizedConsoleServer(consoleBaseUrl(credential))}\u0000${credential.orgId}`;
}

function orgRecordsFromPayload(payload: unknown): readonly unknown[] | null {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return null;

  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return record.data;
  if (Array.isArray(record.orgs)) return record.orgs;

  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    if (Array.isArray(nested.orgs)) return nested.orgs;
    if (Array.isArray(nested.data)) return nested.data;
  }
  return null;
}

/**
 * Pick the exact org id from the account's `/api/orgs` response. A missing
 * match, a non-string id, an empty name, or a name that is just the id all
 * leave the stored fallback in place.
 */
function orgNameFromPayload(payload: unknown, orgId: string): string | null {
  const records = orgRecordsFromPayload(payload);
  if (!records) return null;

  for (const value of records) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.id !== orgId) continue;

    const name = textValue(record.name);
    return name && name !== orgId ? name : null;
  }
  return null;
}

function concatByteChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best effort; body size limits are already enforced.
  }
}

/**
 * Read a JSON body without ever buffering more than the shared org-response
 * bound. A chunked response has no content-length, so the stream is cancelled
 * as soon as its accumulated bytes exceed the limit.
 */
async function readBoundedJsonBody(response: Response): Promise<unknown | null> {
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > OPENCODE_CONSOLE_ORG_RESPONSE_MAX_BYTES) {
        await reader.cancel("org response too large").catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(concatByteChunks(chunks, total)));
  } catch {
    return null;
  }
}

async function requestConsoleOrgName(
  credential: OpenCodeConsoleCredential,
  orgId: string,
): Promise<string | null> {
  const server = consoleBaseUrl(credential).trim().replace(/\/+$/, "");
  return await fetchWithTimeout(`${server}/api/orgs`, {
    timeoutMs: OPENCODE_CONSOLE_ORG_REQUEST_TIMEOUT_MS,
    request: {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      redirect: "error",
    },
    consume: async (response) => {
      if (!response.ok) {
        await cancelResponseBody(response);
        return null;
      }

      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > OPENCODE_CONSOLE_ORG_RESPONSE_MAX_BYTES
      ) {
        await cancelResponseBody(response);
        return null;
      }

      const payload = await readBoundedJsonBody(response);
      return payload === null ? null : orgNameFromPayload(payload, orgId);
    },
  });
}

function readCachedConsoleOrgName(
  key: string,
  nowMs: number,
): { hit: boolean; name: string | null } {
  const cached = consoleOrgNameCache.get(key);
  if (!cached) return { hit: false, name: null };
  if (nowMs >= cached.expiresAt) {
    consoleOrgNameCache.delete(key);
    return { hit: false, name: null };
  }
  return { hit: true, name: cached.name };
}

function writeCachedConsoleOrgName(key: string, name: string | null, nowMs: number): void {
  // Re-insert so eviction stays oldest-first without growing on a refresh.
  consoleOrgNameCache.delete(key);
  consoleOrgNameCache.set(key, {
    name,
    expiresAt: nowMs + OPENCODE_CONSOLE_ORG_CACHE_MAX_AGE_MS,
  });
  while (consoleOrgNameCache.size > OPENCODE_CONSOLE_ORG_CACHE_MAX_ENTRIES) {
    const oldestKey = consoleOrgNameCache.keys().next().value;
    if (oldestKey === undefined) break;
    consoleOrgNameCache.delete(oldestKey);
  }
}

/**
 * Best-effort org name lookup. Every failure (network, timeout, malformed
 * response, missing match) resolves to null so the caller keeps metadata
 * `orgName`, then the connection alias, then `Account N`.
 */
async function lookupConsoleOrgName(
  credential: OpenCodeConsoleCredential,
  nowMs: number,
): Promise<string | null> {
  try {
    const key = consoleOrgNameCacheKey(credential);
    if (!key || !credential.orgId) return null;

    const cached = readCachedConsoleOrgName(key, nowMs);
    if (cached.hit) return cached.name;

    const pending = consoleOrgNameRequests.get(key);
    if (pending) return await pending;

    const request = requestConsoleOrgName(credential, credential.orgId)
      .catch(() => null)
      .then((name) => {
        writeCachedConsoleOrgName(key, name, nowMs);
        return name;
      })
      .finally(() => {
        if (consoleOrgNameRequests.get(key) === request) consoleOrgNameRequests.delete(key);
      });
    consoleOrgNameRequests.set(key, request);
    return await request;
  } catch {
    return null;
  }
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
   * Opt in to refreshing display names from Console `/api/orgs`. Defaults to
   * false so cache identity, availability checks, and cache-only exports stay
   * network-free and use their original deterministic stored labels. Ordinary
   * provider quota fetches should pass true.
   */
  enrichOrgNames?: boolean;
  /**
   * @deprecated Unnamed workspaces now use a per-row `Account N` label. Kept
   * only so existing callers compiled against the previous signature still type
   * check.
   */
  fallbackLabel?: string;
}): Promise<OpenCodeConsoleAuthAccount[]> {
  const nowMs = params?.nowMs ?? Date.now();
  const enrichOrgNames = params?.enrichOrgNames === true;
  const rows = await readCredentialRows([OPENCODE_CONSOLE_INTEGRATION_ID], {
    methods: ["oauth"],
  });

  // Warm every distinct server + org concurrently only when the caller wants
  // enriched display names. The shared cache and in-flight map dedupe aliases,
  // duplicates, and provider overlap, so this adds at most one bounded request
  // per org per TTL window.
  const refreshableCredentials = enrichOrgNames
    ? rows.flatMap((row) => {
        if (row.value.type !== "oauth" || row.resolveError !== undefined) return [];
        const credential = credentialFromValue(row.value);
        if (!credential.accessToken) return [];
        if (credential.expiresAt !== undefined && credential.expiresAt <= nowMs) return [];
        return credential.orgId ? [credential] : [];
      })
    : [];
  const prefetchedOrgNames = new Map<string, string | null>();
  await Promise.all(
    refreshableCredentials.map(async (credential) => {
      const key = consoleOrgNameCacheKey(credential);
      if (!key) return;
      prefetchedOrgNames.set(key, await lookupConsoleOrgName(credential, nowMs));
    }),
  );

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

    const orgNameKey = enrichOrgNames ? consoleOrgNameCacheKey(credential) : null;
    const refreshedOrgName = orgNameKey
      ? prefetchedOrgNames.has(orgNameKey)
        ? prefetchedOrgNames.get(orgNameKey)
        : await lookupConsoleOrgName(credential, nowMs)
      : null;
    const displayCredential = refreshedOrgName
      ? { ...credential, orgName: refreshedOrgName }
      : credential;
    const workspaceKey = effectiveWorkspaceKey(credential);
    const existingIndex = workspaceIndexes.get(workspaceKey);
    const accountNumber = existingIndex === undefined ? accounts.length + 1 : existingIndex + 1;
    const label = consoleAccountLabel(row, accountNumber, displayCredential);
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
          credential: displayCredential,
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
      credential: displayCredential,
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

/** Drops shared org-name state between tests. */
export function clearOpenCodeConsoleOrgNameCacheForTests(): void {
  consoleOrgNameCache.clear();
  consoleOrgNameRequests.clear();
}

/** Current bounded org-name cache size, for eviction regression tests. */
export function getOpenCodeConsoleOrgNameCacheSizeForTests(): number {
  return consoleOrgNameCache.size;
}
