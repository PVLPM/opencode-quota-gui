/**
 * The terminal command's read-only login reader
 *
 * `opencode-quota-gui show` and `status` bind this source while one report runs, so they work
 * with OpenCode closed. It is the only code that queries OpenCode's `credential` table. It
 * never refreshes or writes a login: a sign-in whose token expired stays expired here until
 * OpenCode refreshes it. The server plugin and the TUI must never import this file
 * (`tests/tui-dist-import-graph.test.ts`).
 */

import { existsSync } from "fs";

import {
  type CredentialMethod,
  type CredentialRow,
  type CredentialSource,
  getCredentialDatabasePaths,
} from "./opencode-auth.js";
import { openOpenCodeSqliteReadOnly, type SqliteConn } from "./opencode-sqlite.js";

/** The OpenCode 2 method of a parsed credential value (the reader maps a stored `key` to `api`). */
function credentialMethod(value: Record<string, unknown>): CredentialMethod | undefined {
  if (value.type === "oauth") return "oauth";
  if (value.type === "api" || value.type === "key") return "key";
  return undefined;
}

async function readCredentialDatabase(path: string): Promise<CredentialRow[]> {
  if (!existsSync(path)) return [];

  let database: SqliteConn | undefined;
  try {
    database = await openOpenCodeSqliteReadOnly(path);
    const rows = database.all<Record<string, unknown>>(
      "SELECT id, integration_id, label, active, value FROM credential WHERE integration_id IS NOT NULL ORDER BY active DESC, time_updated DESC, id DESC",
    );
    const credentials: CredentialRow[] = [];

    for (const row of rows) {
      if (
        typeof row.id !== "string" ||
        typeof row.integration_id !== "string" ||
        typeof row.label !== "string" ||
        typeof row.value !== "string"
      )
        continue;
      const value = parseCredentialValue(row.value);
      if (value) {
        credentials.push({
          id: row.id,
          integrationId: row.integration_id,
          label: row.label,
          active: row.active === 1,
          value,
        });
      }
    }

    return credentials;
  } catch {
    return [];
  } finally {
    database?.close();
  }
}

function parseCredentialValue(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const credential = parsed as Record<string, unknown>;
    const metadata = credential.metadata;
    const authEntry = {
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      ...credential,
    };
    if (authEntry.type === "key" && typeof authEntry.key === "string") {
      authEntry.type = "api";
    }
    return authEntry;
  } catch {
    return null;
  }
}

/**
 * Logins from OpenCode's database, in database order (active first, then most recently
 * updated), not in request order. The database path is resolved on every read, so
 * `OPENCODE_DB` and `XDG_DATA_HOME` apply. Any read error means no logins.
 */
export function createSqliteCredentialSource(): CredentialSource {
  return {
    kind: "sqlite",
    async readRows(request) {
      const [path] = getCredentialDatabasePaths();
      const rows = (path ? await readCredentialDatabase(path) : []).filter((row) =>
        request.integrationIds.includes(row.integrationId),
      );
      const seenIntegrationIds = new Set<string>();
      const firstRows = request.firstOnly
        ? rows.filter((row) => {
            if (seenIntegrationIds.has(row.integrationId)) return false;
            seenIntegrationIds.add(row.integrationId);
            return true;
          })
        : rows;
      const methods = request.methods;
      if (!methods) return firstRows;
      return firstRows.filter((row) => {
        const method = credentialMethod(row.value);
        return method !== undefined && methods.includes(method);
      });
    },
  };
}
