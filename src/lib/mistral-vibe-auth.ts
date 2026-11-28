/**
 * Mistral Vibe subscription credential discovery.
 *
 * The official Vibe CLI stores its platform key as `MISTRAL_API_KEY` in the
 * dotenv file at `<VIBE_HOME>/.env` (`VIBE_HOME` defaults to `~/.vibe`). The
 * key is also honoured from the process environment and from OpenCode's own
 * auth store, so a Vibe subscription can be read without installing or logging
 * into anything here.
 *
 * A key value is only ever held in memory to build one request header. No
 * value is returned in diagnostics, errors, status details or test fixtures;
 * account identity is a domain-separated sha256 fingerprint of the key, which
 * gives the same `identityKey` for the same account regardless of which source
 * supplied it.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type CredentialRow,
  formatCredentialDisplayNames,
  getCredentialDatabasePaths,
  readCredentialRows,
} from "./opencode-auth.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
  type ResolvedAuthIdentity,
} from "./resolved-auth-identity.js";

/** Canonical quota provider id owning these credentials. */
export const MISTRAL_VIBE_PROVIDER_ID = "mistral";

/** Environment variable the Vibe CLI reads and that we honour first. */
export const MISTRAL_API_KEY_ENV_VAR = "MISTRAL_API_KEY";

/** OpenCode's integration id for Mistral. */
export const MISTRAL_OPENCODE_INTEGRATION_IDS = ["mistral"] as const;

export const MISTRAL_VIBE_DEFAULT_LABEL = "Mistral Vibe";

/** Where a discovered credential came from. Never a value. */
export type MistralVibeCredentialSource = "env" | "vibe_dotenv" | "opencode.db";

export interface MistralVibeCredential {
  /** In-memory only; never logged, exported, diagnosed or asserted. */
  key: string;
  source: MistralVibeCredentialSource;
  /** Stable non-secret account identity derived only from the key. */
  identityKey: string;
  /** Stable account source id for row grouping and failure attribution. */
  sourceId: string;
  label: string;
  active?: boolean;
}

export interface MistralVibeCredentialResolution {
  credentials: MistralVibeCredential[];
  /** Paths inspected for the dotenv file; never file contents. */
  checkedPaths: string[];
  credentialDatabasePaths: string[];
}

/**
 * `VIBE_HOME` when set, otherwise the documented default `~/.vibe`.
 *
 * The installed `agy`/Vibe location is never hardcoded: another application may
 * install Vibe anywhere, and its own home directory is the only contract.
 * `homeDir` is injectable so tests resolve the default under a temporary home
 * and never inspect the real one.
 */
export function getVibeHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const configured = env.VIBE_HOME?.trim();
  return configured ? configured : join(homeDir, ".vibe");
}

export function getVibeEnvFilePath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  return join(getVibeHomeDir(env, homeDir), ".env");
}

/**
 * Non-secret, deterministic account identity for one key.
 *
 * Two sources that hold the same key resolve to the same identity (one card);
 * different keys never collapse into one account. The digest is domain
 * separated so it cannot be compared with another hash of the same value.
 */
export function mistralVibeIdentityKey(apiKey: string): string {
  return createHash("sha256")
    .update(`ocq-mistral-vibe-key-v1\u0000${apiKey.trim()}`, "utf8")
    .digest("hex");
}

/**
 * Read one dotenv value.
 *
 * A quoted value is exactly what sits between its matching quotes: an inline
 * ` # comment` after the closing quote is not part of it, while a `#` inside the
 * quotes is. An unquoted value ends at an unescaped inline comment.
 */
function unquoteDotenvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    // The closing quote is the first unescaped one, so `"a\"b"` keeps `a"b`.
    const match = /^"((?:\\.|[^"\\])*)"/u.exec(trimmed);
    // An unterminated quote keeps the remainder; it can never be a real key.
    if (!match) return trimmed.slice(1);
    return (match[1] ?? "").replace(/\\n/gu, "\n").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
  }
  if (trimmed.startsWith("'")) {
    const match = /^'([^']*)'/u.exec(trimmed);
    if (!match) return trimmed.slice(1);
    return match[1] ?? "";
  }
  // An unquoted value ends at an inline comment: a `#` that starts the value or
  // follows whitespace. A `#` glued to the value stays part of it.
  if (trimmed.startsWith("#")) return "";
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

/**
 * Read one variable from dotenv text.
 *
 * Implements the subset the Vibe CLI writes: comments, an optional `export`
 * prefix, `KEY=VALUE`, and single/double quoting. Unknown lines are ignored so a
 * malformed neighbour cannot hide a valid key.
 *
 * The last assignment of a name wins, and an empty assignment never stops the
 * scan, which is what python-dotenv's `dotenv_values` does for the Vibe CLI: it
 * merges every parsed line, so a later line overwrites an earlier one and an
 * empty first line cannot hide a value set further down. A trailing empty
 * assignment therefore leaves no key at all, exactly as Vibe would read it.
 */
export function parseDotenvValue(content: string, name: string): string | undefined {
  let resolved: string | undefined;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    if (withoutExport.slice(0, separator).trim() !== name) continue;
    resolved = unquoteDotenvValue(withoutExport.slice(separator + 1));
  }
  return resolved || undefined;
}

async function readEnvFileContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    // A missing, unreadable or non-file path is the same outcome: no value.
    return null;
  }
}

function pushCredential(
  credentials: MistralVibeCredential[],
  seenKeys: Set<string>,
  candidate: Omit<MistralVibeCredential, "identityKey">,
): void {
  const key = candidate.key.trim();
  if (!key || seenKeys.has(key)) return;
  seenKeys.add(key);
  credentials.push({ ...candidate, key, identityKey: mistralVibeIdentityKey(key) });
}

/**
 * Resolve every distinct Mistral credential, in source priority order:
 * `MISTRAL_API_KEY`, `<VIBE_HOME>/.env`, then OpenCode's stored Mistral logins.
 *
 * Identical keys from several sources produce one credential, so one account is
 * one card. Distinct keys stay separate accounts rather than being claimed as
 * the same account.
 */
export async function resolveMistralVibeCredentials(params: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readEnvFile?: (path: string) => Promise<string | null>;
  readStoredRows?: () => Promise<CredentialRow[]>;
}): Promise<MistralVibeCredentialResolution> {
  const env = params.env ?? process.env;
  const readEnvFile = params.readEnvFile ?? readEnvFileContent;
  const storedRows = await (
    params.readStoredRows ??
    (() => readCredentialRows(MISTRAL_OPENCODE_INTEGRATION_IDS, { methods: ["key"] }))
  )();

  const envPath = getVibeEnvFilePath(env, params.homeDir);
  const content = await readEnvFile(envPath);
  const credentials: MistralVibeCredential[] = [];
  const seenKeys = new Set<string>();

  const fromEnv = env[MISTRAL_API_KEY_ENV_VAR]?.trim();
  if (fromEnv) {
    pushCredential(credentials, seenKeys, {
      key: fromEnv,
      source: "env",
      sourceId: "vibe-env",
      label: MISTRAL_VIBE_DEFAULT_LABEL,
    });
  }

  const fromDotenv =
    content === null ? undefined : parseDotenvValue(content, MISTRAL_API_KEY_ENV_VAR);
  if (fromDotenv) {
    pushCredential(credentials, seenKeys, {
      key: fromDotenv,
      source: "vibe_dotenv",
      sourceId: "vibe-dotenv",
      label: MISTRAL_VIBE_DEFAULT_LABEL,
    });
  }

  const stored = storedRows.filter((row) =>
    MISTRAL_OPENCODE_INTEGRATION_IDS.includes(
      row.integrationId as (typeof MISTRAL_OPENCODE_INTEGRATION_IDS)[number],
    ),
  );
  const names = formatCredentialDisplayNames(
    MISTRAL_VIBE_DEFAULT_LABEL,
    stored.map((row) => ({ row, fallbackName: MISTRAL_VIBE_DEFAULT_LABEL })),
  );
  for (const [index, row] of stored.entries()) {
    const key = row.value.key;
    if (typeof key !== "string" || !key.trim()) continue;
    pushCredential(credentials, seenKeys, {
      key,
      source: "opencode.db",
      sourceId: row.id,
      label: names[index] ?? MISTRAL_VIBE_DEFAULT_LABEL,
      active: row.active,
    });
  }

  return {
    credentials,
    checkedPaths: [envPath],
    credentialDatabasePaths: getCredentialDatabasePaths(),
  };
}

export async function hasMistralVibeCredential(): Promise<boolean> {
  return (await resolveMistralVibeCredentials({})).credentials.length > 0;
}

/**
 * Cache identity covering every resolved credential.
 *
 * The account descriptors are hashed alongside the keys, so adding, removing or
 * relabelling one account invalidates a cached result built from the previous
 * account set. The returned token never contains a raw key.
 */
export async function resolveMistralVibeAuthIdentity(): Promise<ResolvedAuthIdentity | null> {
  const { credentials } = await resolveMistralVibeCredentials({});
  if (credentials.length === 0) return null;

  const identities = await Promise.all(
    credentials.map((credential) =>
      deriveResolvedAuthIdentity({
        providerId: MISTRAL_VIBE_PROVIDER_ID,
        principal: { kind: "credential", value: credential.key },
        qualifiers: [credential.sourceId, credential.label],
      }),
    ),
  );
  if (identities.some((identity) => identity === null)) return null;
  const resolved = identities as ResolvedAuthIdentity[];
  return resolved.length === 1
    ? (resolved[0] ?? null)
    : await composeResolvedAuthIdentities({
        providerId: MISTRAL_VIBE_PROVIDER_ID,
        identities: resolved,
      });
}
