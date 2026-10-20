#!/usr/bin/env node
import { dirname, resolve } from "node:path";
/**
 * Read-only analytics query-plan diagnostic.
 *
 * Mirrors the representative SQL shapes built by
 * `src/lib/opencode-storage.ts` (`buildCompletedAssistantQuery`,
 * `readMessageRevisionsFrom`) and prints `EXPLAIN QUERY PLAN` output plus
 * aggregate table/page sizes. It exists so a reviewer can reproduce why cold
 * finite-range reads scan and why a session-scoped read can seek, without
 * printing any message/project/session identifier or payload.
 *
 * Usage:
 *   pnpm exec tsc
 *   node scripts/analytics-query-plan.mjs
 *   node scripts/analytics-query-plan.mjs --timings
 *   node scripts/analytics-query-plan.mjs --json
 *
 * The source is opened read-only with `PRAGMA query_only = ON`. Nothing is
 * written, indexed, or migrated. `--timings` executes each projection once and
 * is intentionally opt-in because a cold full scan can take tens of seconds.
 *
 * Keep the SQL below in sync with the production query builders. This file is
 * diagnostic only; production behavior is covered by the unit tests.
 */
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(
    [
      "Usage: node scripts/analytics-query-plan.mjs [--timings] [--json]",
      "",
      "Opens OpenCode's database read-only and prints representative analytics",
      "query plans. --timings executes each query once (may be slow when cold).",
    ].join("\n"),
  );
  process.exit(0);
}
const timings = args.has("--timings");
const json = args.has("--json");

const dbPathModule = await import(
  pathToFileURL(`${repoRoot}/dist/lib/opencode-db-path.js`).href
).catch(() => null);
if (!dbPathModule?.getOpenCodeDbPath) {
  console.error("dist is missing; run `pnpm exec tsc` first.");
  process.exit(2);
}
const dbPath = dbPathModule.getOpenCodeDbPath();

function guardedJsonScalar(path) {
  return `CASE WHEN json_valid(data) THEN json_extract(data, '${path}') END`;
}

const completedScalar = guardedJsonScalar("$.time.completed");
const completedExpression = `CAST(${completedScalar} AS REAL)`;
const projectedColumns = [
  "id",
  "session_id",
  "time_created",
  "type AS role",
  `${guardedJsonScalar("$.model.providerID")} AS provider_id`,
  `${guardedJsonScalar("$.model.id")} AS model_id`,
  `${guardedJsonScalar("$.tokens.input")} AS tokens_input`,
  `${guardedJsonScalar("$.tokens.output")} AS tokens_output`,
  `${guardedJsonScalar("$.tokens.reasoning")} AS tokens_reasoning`,
  `${guardedJsonScalar("$.tokens.cache.read")} AS tokens_cache_read`,
  `${guardedJsonScalar("$.tokens.cache.write")} AS tokens_cache_write`,
  `${guardedJsonScalar("$.cost")} AS cost`,
  `${guardedJsonScalar("$.time.completed")} AS time_completed`,
  `${guardedJsonScalar("$.agent")} AS agent`,
].join(", ");

const completedWhere = [
  "type = 'assistant'",
  "CASE WHEN json_valid(data) THEN json_type(data, '$.time.completed') END IN ('integer', 'real')",
  `${completedExpression} > 0`,
];

function completedQuery({ sinceMs, untilMs, exactTimes, sessionIDs, withUpdatedAt = false }) {
  const where = [...completedWhere];
  const queryArgs = [];
  if (sinceMs !== undefined) {
    where.push(`${completedExpression} >= ?`);
    queryArgs.push(sinceMs);
  }
  if (untilMs !== undefined) {
    where.push(`${completedExpression} <= ?`);
    queryArgs.push(untilMs);
  }
  if (exactTimes !== undefined) {
    where.push(`${completedExpression} IN (SELECT value FROM json_each(?))`);
    queryArgs.push(JSON.stringify([...new Set(exactTimes)].sort((a, b) => a - b)));
  }
  if (sessionIDs !== undefined) {
    where.push(`session_id IN (${sessionIDs.map(() => "?").join(", ")})`);
    queryArgs.push(...sessionIDs);
  }
  const projection = withUpdatedAt ? `${projectedColumns}, time_updated` : projectedColumns;
  return {
    sql: `SELECT ${projection} FROM "session_message" WHERE ${where.join(" AND ")}`,
    args: queryArgs,
  };
}

const now = Date.now();
const day = 86_400_000;
const sessionScope = ["ses_scope_a", "ses_scope_b"];
const exactTimes = [now - 3 * day, now - 5 * day, now - 9 * day];

const cases = [
  {
    name: "cold-7d-completed",
    note: "Global finite read: completion JSON cannot use an index.",
    ...completedQuery({ sinceMs: now - 7 * day, untilMs: now, withUpdatedAt: true }),
  },
  {
    name: "extend-30d-older-side",
    note: "30d extension reads only the older [30d, 7d] side.",
    ...completedQuery({ sinceMs: now - 30 * day, untilMs: now - 7 * day, withUpdatedAt: true }),
  },
  {
    name: "exact-completion-owner-candidates",
    note: "Fork-owner discovery by exact completion times.",
    ...completedQuery({ exactTimes, withUpdatedAt: true }),
  },
  {
    name: "scoped-session-completed",
    note: "A session tree read uses the session/type index.",
    ...completedQuery({ sessionIDs: sessionScope, withUpdatedAt: true }),
  },
  {
    name: "revision-delta",
    note: "Global revision delta: scans time_updated, projects completion lazily.",
    sql: `SELECT id, session_id, type, time_created, time_updated, ${completedScalar} AS completed FROM "session_message" WHERE (time_updated IS NULL OR time_updated >= ?)`,
    args: [now - 5 * 60_000],
  },
  {
    name: "created-index-reference",
    note: "Physical time_created index (not a completion substitute).",
    sql: `SELECT id, session_id, time_created, type AS role FROM "session_message" WHERE type = 'assistant' AND time_created >= ?`,
    args: [now - 7 * day],
  },
];

let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch {
  console.error("source is unavailable or unsupported");
  process.exit(2);
}

function planFor(query) {
  const statement = db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`);
  const rows = statement.all(...query.args);
  return rows.map((row) => String(row.detail));
}

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

try {
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  const queryOnly = db.prepare("PRAGMA query_only").get()?.query_only === 1;

  const columns = db.prepare(`PRAGMA table_info("session_message")`).all();
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_message' ORDER BY name`,
    )
    .all();

  let pages = [];
  try {
    pages = db
      .prepare(
        `SELECT name, pagetype, count(*) AS pages, sum(pgsize) AS bytes
         FROM dbstat
         WHERE name = 'session_message' OR name LIKE 'session_message%'
         GROUP BY name, pagetype
         ORDER BY bytes DESC`,
      )
      .all();
  } catch {
    pages = [];
  }

  const results = cases.map((query) => {
    const plan = planFor(query);
    let observedRows = null;
    let observedMs = null;
    if (timings) {
      const started = performance.now();
      try {
        observedRows = db.prepare(query.sql).all(...query.args).length;
      } catch {
        observedRows = null;
      }
      observedMs = Number((performance.now() - started).toFixed(1));
    }
    return {
      name: query.name,
      note: query.note,
      plan,
      fullScan: plan.some((detail) => /SCAN session_message/.test(detail)),
      tempBTree: plan.some((detail) => /TEMP B-TREE/.test(detail)),
      observedRows,
      observedMs,
    };
  });

  const tableBytes = pages
    .filter((row) => row.name === "session_message")
    .reduce((sum, row) => sum + (numberOrNull(row.bytes) ?? 0), 0);
  const overflowBytes = pages
    .filter((row) => row.name === "session_message" && row.pagetype === "overflow")
    .reduce((sum, row) => sum + (numberOrNull(row.bytes) ?? 0), 0);

  const report = {
    access: { mode: "read-only", queryOnly },
    schema: {
      columns: columns.map((row) => String(row.name)),
      indexes: indexes.map((row) => String(row.name)),
    },
    table: {
      pageSize: numberOrNull(db.prepare("PRAGMA page_size").get()?.page_size),
      databasePages: numberOrNull(db.prepare("PRAGMA page_count").get()?.page_count),
      sessionMessageBytes: tableBytes,
      sessionMessageOverflowBytes: overflowBytes,
      pageGroups: pages.map((row) => ({
        pagetype: String(row.pagetype),
        pages: numberOrNull(row.pages),
        bytes: numberOrNull(row.bytes),
      })),
    },
    queries: results,
    timings,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("Analytics query plans (read-only)");
    console.log(`query_only=${queryOnly ? 1 : 0} timings=${timings ? "on" : "off"}`);
    console.log(
      `session_message bytes=${tableBytes} overflow=${overflowBytes} page_count=${report.table.databasePages}`,
    );
    console.log("\n== indexes ==");
    for (const index of report.schema.indexes) console.log(`  ${index}`);
    for (const query of results) {
      console.log(`\n== ${query.name} ==`);
      console.log(`  ${query.note}`);
      for (const detail of query.plan) console.log(`  ${detail}`);
      console.log(`  fullScan=${query.fullScan} tempBTree=${query.tempBTree}`);
      if (timings) {
        console.log(`  rows=${query.observedRows ?? "n/a"} ms=${query.observedMs ?? "n/a"}`);
      }
    }
  }
} finally {
  try {
    db.close();
  } catch {
    // Best effort.
  }
}
