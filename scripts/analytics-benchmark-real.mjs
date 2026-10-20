/**
 * Read-only local-source selection for `--real-local`.
 *
 * The source path is resolved exactly as production resolves `OPENCODE_DB`,
 * then opened read-only with `PRAGMA query_only = ON`. This module only issues
 * SELECT/PRAGMA statements. It never creates a writer connection, never
 * executes a source write statement, and never returns a path or identifier to
 * the caller's output.
 */
import { existsSync } from "node:fs";

import {
  analyzeSessionGraph,
  DAY_MS,
  openDatabase,
  round,
  selectFromGraph,
} from "./analytics-benchmark-fixtures.mjs";
import { BenchError } from "./analytics-benchmark-harness.mjs";

export function resolveRealSource(getOpenCodeDbPath) {
  const dbPath = getOpenCodeDbPath();
  if (dbPath === ":memory:" || !existsSync(dbPath)) throw new BenchError("real-source-missing");
  return dbPath;
}

function tableColumns(conn, table) {
  const rows = conn.all(`PRAGMA table_info("${table}")`);
  const columns = new Set();
  for (const row of rows) {
    if (row && typeof row.name === "string") columns.add(row.name);
  }
  return columns;
}

/**
 * Open a source with the read-only role and verify SQLite's query_only guard.
 * This is the only opener used by `--real-local`; it never creates a writer.
 * The returned `queryOnly` value is read back from SQLite, not assumed.
 */
export async function openRealSourceReadOnly(dbPath) {
  let conn;
  try {
    conn = await openDatabase(dbPath, { readOnly: true });
  } catch {
    throw new BenchError("real-source-unsupported");
  }
  try {
    conn.get("PRAGMA query_only = ON");
    conn.get("PRAGMA busy_timeout = 5000");
    const readonly = conn.get("PRAGMA query_only");
    const queryOnly = readonly?.query_only === 1;
    if (!queryOnly) throw new BenchError("real-source-unsupported");
    return { conn, queryOnly };
  } catch (error) {
    try {
      conn.close();
    } catch {
      // Best effort.
    }
    if (error instanceof BenchError) throw error;
    throw new BenchError("real-source-unsupported");
  }
}

/**
 * Choose anonymous workload targets without reading titles, directories, or
 * message payloads. Density is an assistant-row proxy (completed-vs-unfinished
 * is not needed for workload selection), measured over the last 30 days when
 * the source has recent activity.
 */
export async function selectRealSource(dbPath, anchorMs) {
  let conn;
  let access = null;
  try {
    const opened = await openRealSourceReadOnly(dbPath);
    conn = opened.conn;
    access = { mode: "read-only", queryOnly: opened.queryOnly };

    const sessionColumns = tableColumns(conn, "session_v2");
    const messageColumns = tableColumns(conn, "session_message");
    if (
      !sessionColumns.has("id") ||
      !sessionColumns.has("time_created") ||
      !messageColumns.has("session_id") ||
      !messageColumns.has("type")
    ) {
      throw new BenchError("real-source-unsupported");
    }

    const parentProjection = sessionColumns.has("parent_id") ? "parent_id" : "NULL";
    const projectProjection = sessionColumns.has("project_id") ? "project_id" : "NULL";
    const updatedProjection = sessionColumns.has("time_updated") ? "time_updated" : "time_created";
    const sessionRows = conn.all(
      `SELECT id, ${parentProjection} AS parentID, ${projectProjection} AS projectID,
              time_created AS createdMs, ${updatedProjection} AS updatedMs
       FROM "session_v2"
       WHERE substr(id, 1, 4) = 'ses_'
       ORDER BY time_created ASC, id ASC`,
    );

    const recentCutoff = anchorMs - 30 * DAY_MS;
    const timeProjection = messageColumns.has("time_created") ? "time_created" : "0";
    const messageRows = conn.all(
      `SELECT session_id AS id, COUNT(*) AS rows,
              SUM(CASE WHEN ${timeProjection} >= ? THEN 1 ELSE 0 END) AS recentRows
       FROM "session_message"
       WHERE type = 'assistant'
       GROUP BY session_id`,
      [recentCutoff],
    );

    const rowsBySession = new Map();
    const recentBySession = new Map();
    for (const row of messageRows) {
      if (typeof row.id !== "string") continue;
      rowsBySession.set(row.id, Number(row.rows) || 0);
      recentBySession.set(row.id, Number(row.recentRows) || 0);
    }

    const graph = analyzeSessionGraph(sessionRows, rowsBySession, recentBySession);
    if (graph.totalSessions === 0 || graph.totalRows === 0) {
      throw new BenchError("real-source-empty");
    }
    const selection = selectFromGraph(graph, rowsBySession);
    const created = sessionRows
      .map((row) => Number(row.createdMs))
      .filter((value) => Number.isFinite(value));
    const updated = sessionRows
      .map((row) => Number(row.updatedMs))
      .filter((value) => Number.isFinite(value));
    const spanDays =
      created.length > 0 && updated.length > 0
        ? round((Math.max(...updated) - Math.min(...created)) / DAY_MS, 1)
        : 0;

    return {
      selection,
      counts: {
        sessions: graph.totalSessions,
        assistantRows: graph.totalRows,
        projects: graph.projects.length,
        spanDays,
      },
      access,
    };
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError("real-source-unsupported");
  } finally {
    try {
      conn?.close();
    } catch {
      // Best effort.
    }
  }
}
