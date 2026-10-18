import { existsSync } from "fs";

import { getOpenCodeDbPath } from "./opencode-db-path.js";
import { openOpenCodeSqliteReadOnly, type SqliteConn } from "./opencode-sqlite.js";

/**
 * Error thrown when a session is not found.
 *
 * OpenCode 2 stores sessions and messages in SQLite (`opencode.db`) under the
 * `session_v2` and `session_message` tables. This is thrown by
 * iterAssistantMessagesForSession when the database is missing/unreadable, the
 * session id is invalid, or the session row does not exist.
 */
export class SessionNotFoundError extends Error {
  constructor(
    public readonly sessionID: string,
    public readonly checkedPath: string,
  ) {
    super(`Session not found: ${sessionID}`);
    this.name = "SessionNotFoundError";
  }
}

export interface OpenCodeTokenCache {
  read: number;
  write: number;
}

export interface OpenCodeTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache: OpenCodeTokenCache;
}

export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | string;
  providerID?: string;
  modelID?: string;
  tokens?: OpenCodeTokens;
  cost?: number;
  time?: {
    created?: number;
    completed?: number;
  };
  agent?: string;
  mode?: string;
}

export interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  parentID?: string;
  /** `session_v2.project_id` when the shipped column exists (R46); absent on older schemas. */
  projectID?: string;
  /** `session_v2.directory` when the shipped column exists (R46); only basenames reach the browser. */
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

export type OpenCodeDbStats = {
  dbPath: string;
  sessionCount: number;
  messageCount: number;
  assistantMessageCount: number;
};

type ProjectedMessageRow = {
  id: string;
  session_id: string;
  time_created: number;
  role: unknown;
  provider_id: unknown;
  model_id: unknown;
  tokens_input: unknown;
  tokens_output: unknown;
  tokens_reasoning: unknown;
  tokens_cache_read: unknown;
  tokens_cache_write: unknown;
  cost: unknown;
  time_completed: unknown;
  agent: unknown;
  mode: unknown;
};

type SessionRow = {
  id: string;
  title: string | null;
  parent_id: string | null;
  project_id?: unknown;
  directory?: unknown;
  time_created: number;
  time_updated: number;
};

/** Row shape of `PRAGMA table_info(...)`, used for R46 feature detection. */
type TableInfoRow = { name: unknown };

// Stay comfortably below SQLite's default host-parameter cap once optional
// time filters are included in the query.
const SQLITE_MAX_MESSAGE_QUERY_ARGS = 900;

function normalizeNumber(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

function normalizeString(s: unknown): string | undefined {
  return typeof s === "string" ? s : undefined;
}

function mapRowToOpenCodeMessage(row: ProjectedMessageRow): OpenCodeMessage | null {
  if (!row || typeof row !== "object") return null;
  if (typeof row.id !== "string" || typeof row.session_id !== "string") return null;
  if (typeof row.time_created !== "number") return null;

  const input = normalizeNumber(row.tokens_input);
  const output = normalizeNumber(row.tokens_output);
  const reasoning = normalizeNumber(row.tokens_reasoning);
  const cacheRead = normalizeNumber(row.tokens_cache_read);
  const cacheWrite = normalizeNumber(row.tokens_cache_write);
  const hasTokens = [input, output, reasoning, cacheRead, cacheWrite].some(
    (value) => value !== undefined,
  );

  return {
    id: row.id,
    sessionID: row.session_id,
    role: normalizeString(row.role) ?? "unknown",
    providerID: normalizeString(row.provider_id),
    modelID: normalizeString(row.model_id),
    tokens: hasTokens
      ? {
          input: input ?? 0,
          output: output ?? 0,
          ...(reasoning === undefined ? {} : { reasoning }),
          cache: { read: cacheRead ?? 0, write: cacheWrite ?? 0 },
        }
      : undefined,
    cost: normalizeNumber(row.cost),
    time: {
      created: row.time_created,
      completed: normalizeNumber(row.time_completed),
    },
    agent: normalizeString(row.agent),
    mode: normalizeString(row.mode),
  };
}

function openDbOrNull(): {
  dbPath: string;
  open: () => ReturnType<typeof openOpenCodeSqliteReadOnly>;
} | null {
  const dbPath = getOpenCodeDbPath();
  if (dbPath === ":memory:" || !existsSync(dbPath)) return null;
  return {
    dbPath,
    open: () => openOpenCodeSqliteReadOnly(dbPath),
  };
}

function validateSessionIdOrThrow(sessionID: string): void {
  if (!sessionID.startsWith("ses_")) {
    throw new SessionNotFoundError(sessionID, "(invalid session ID format)");
  }
}

function normalizeSessionIdsOrThrow(sessionIDs: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const sessionID of sessionIDs) {
    validateSessionIdOrThrow(sessionID);
    if (seen.has(sessionID)) continue;
    seen.add(sessionID);
    unique.push(sessionID);
  }

  return unique;
}

function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function guardedJsonScalar(path: string): string {
  return `CASE WHEN json_valid(data) THEN json_extract(data, '${path}') END`;
}

const PROJECTED_MESSAGE_COLUMNS = [
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

const ASSISTANT_FILTER = `type = 'assistant'`;

function buildMessageQuery(params: {
  sessionID?: string;
  sessionIDs?: string[];
  sinceMs?: number;
  untilMs?: number;
}): { sql: string; args: unknown[] } {
  if (params.sessionID && params.sessionIDs?.length) {
    throw new Error("buildMessageQuery received both sessionID and sessionIDs");
  }

  const where: string[] = [];
  const args: unknown[] = [];

  if (params.sessionID) {
    where.push(`session_id = ?`);
    args.push(params.sessionID);
  } else if (params.sessionIDs) {
    if (params.sessionIDs.length === 0) {
      where.push(`1 = 0`);
    } else {
      where.push(`session_id IN (${params.sessionIDs.map(() => "?").join(", ")})`);
      args.push(...params.sessionIDs);
    }
  }

  if (typeof params.sinceMs === "number") {
    where.push(`time_created >= ?`);
    args.push(params.sinceMs);
  }

  if (typeof params.untilMs === "number") {
    where.push(`time_created <= ?`);
    args.push(params.untilMs);
  }

  where.push(ASSISTANT_FILTER);

  const sql =
    `SELECT ${PROJECTED_MESSAGE_COLUMNS} FROM "session_message"` +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    ` ORDER BY time_created ASC, id ASC`;

  return { sql, args };
}

async function hasJsonExtract(conn: {
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
}): Promise<boolean> {
  try {
    const row = conn.get<{ r: string }>(
      "SELECT json_extract('{\"role\":\"assistant\"}', '$.role') as r",
    );
    return row?.r === "assistant";
  } catch {
    return false;
  }
}

/**
 * The columns a table ships with, or `null` when the table is absent or
 * unreadable. R46 schema drift degrades to "unknown project" instead of
 * failing; table names here are fixed literals, never user input.
 */
function readTableColumns(conn: Pick<SqliteConn, "all">, table: string): Set<string> | null {
  try {
    const rows = conn.all<TableInfoRow>(`PRAGMA table_info("${table}")`);
    const columns = new Set<string>();
    for (const row of rows) {
      if (row && typeof row.name === "string") columns.add(row.name);
    }
    return columns.size > 0 ? columns : null;
  } catch {
    return null;
  }
}

function mapAssistantMessages(rows: ProjectedMessageRow[]): OpenCodeMessage[] {
  const out: OpenCodeMessage[] = [];
  for (const row of rows) {
    const msg = mapRowToOpenCodeMessage(row);
    if (!msg) continue;
    if (String(msg.role).toLowerCase() !== "assistant") continue;
    out.push(msg);
  }
  return out;
}

function completedAt(message: OpenCodeMessage): number | null {
  const value = message.time?.completed;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function mapCompletedAssistantMessages(rows: ProjectedMessageRow[]): OpenCodeMessage[] {
  return mapAssistantMessages(rows).filter((message) => completedAt(message) !== null);
}

function buildCompletedAssistantQuery(params: {
  completedSinceMs?: number;
  completedUntilMs?: number;
}): { sql: string; args: unknown[] } {
  const completedScalar = guardedJsonScalar("$.time.completed");
  const completedExpression = `CAST(${completedScalar} AS REAL)`;
  const where = [
    ASSISTANT_FILTER,
    `CASE WHEN json_valid(data) THEN json_type(data, '$.time.completed') END IN ('integer', 'real')`,
    `${completedExpression} > 0`,
  ];
  const args: unknown[] = [];

  if (typeof params.completedSinceMs === "number") {
    where.push(`${completedExpression} >= ?`);
    args.push(params.completedSinceMs);
  }
  if (typeof params.completedUntilMs === "number") {
    where.push(`${completedExpression} <= ?`);
    args.push(params.completedUntilMs);
  }

  return {
    sql:
      `SELECT ${PROJECTED_MESSAGE_COLUMNS} FROM "session_message"` +
      ` WHERE ${where.join(" AND ")}` +
      ` ORDER BY ${completedExpression} ASC, id ASC`,
    args,
  };
}

/**
 * Fingerprint shared by the upstream fork-copy dedup and the GUI owner set
 * (R50). Exported so P3 groups raw rows by the exact upstream formula.
 */
export function forkCopyFingerprint(message: OpenCodeMessage, completed: number): string {
  const tokens = message.tokens;
  return JSON.stringify([
    message.time?.created,
    completed,
    message.providerID,
    message.modelID,
    tokens?.input,
    tokens?.output,
    tokens?.reasoning,
    tokens?.cache.read,
    tokens?.cache.write,
    message.cost,
  ]);
}

/**
 * OpenCode copies a parent's finished messages into each fork with new ids but
 * identical times, model, tokens, and cost. Count each finished fingerprint as
 * many times as the session that has it most often, and drop the extra copies.
 * Unfinished rows are always kept.
 */
function dropForkCopies(messages: OpenCodeMessage[]): OpenCodeMessage[] {
  const countBySessionFingerprint = new Map<string, number>();
  const keptCountByFingerprint = new Map<string, number>();
  const out: OpenCodeMessage[] = [];
  for (const message of messages) {
    const completed = completedAt(message);
    if (completed === null) {
      out.push(message);
      continue;
    }
    const fingerprint = forkCopyFingerprint(message, completed);
    const sessionFingerprintKey = JSON.stringify([message.sessionID, fingerprint]);
    const sessionCount = (countBySessionFingerprint.get(sessionFingerprintKey) ?? 0) + 1;
    countBySessionFingerprint.set(sessionFingerprintKey, sessionCount);
    const keptCount = keptCountByFingerprint.get(fingerprint) ?? 0;
    if (sessionCount <= keptCount) {
      continue;
    }
    keptCountByFingerprint.set(fingerprint, sessionCount);
    out.push(message);
  }
  return out;
}

function compareMessageOrder(a: OpenCodeMessage, b: OpenCodeMessage): number {
  const aCreated = typeof a.time?.created === "number" ? a.time.created : Number.MAX_SAFE_INTEGER;
  const bCreated = typeof b.time?.created === "number" ? b.time.created : Number.MAX_SAFE_INTEGER;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return a.id.localeCompare(b.id);
}

export async function getOpenCodeDbStats(): Promise<OpenCodeDbStats> {
  const db = openDbOrNull();
  if (!db) {
    return {
      dbPath: getOpenCodeDbPath(),
      sessionCount: 0,
      messageCount: 0,
      assistantMessageCount: 0,
    };
  }

  const conn = await db.open();
  try {
    const sessionRow = conn.get<{ c: number }>(`SELECT count(*) as c FROM "session_v2"`);
    const messageRow = conn.get<{ c: number }>(`SELECT count(*) as c FROM "session_message"`);

    let assistantCount = 0;
    if (await hasJsonExtract(conn)) {
      const a = conn.get<{ c: number }>(
        `SELECT count(*) as c FROM "session_message" WHERE type = 'assistant'`,
      );
      assistantCount = typeof a?.c === "number" ? a.c : 0;
    }

    return {
      dbPath: db.dbPath,
      sessionCount: typeof sessionRow?.c === "number" ? sessionRow.c : 0,
      messageCount: typeof messageRow?.c === "number" ? messageRow.c : 0,
      assistantMessageCount: assistantCount,
    };
  } finally {
    conn.close();
  }
}

export async function iterAssistantMessages(params: {
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    if (!(await hasJsonExtract(conn))) return [];
    const q = buildMessageQuery({ sinceMs: params.sinceMs, untilMs: params.untilMs });
    const rows = conn.all<ProjectedMessageRow>(q.sql, q.args);
    return dropForkCopies(mapAssistantMessages(rows));
  } finally {
    conn.close();
  }
}

/**
 * Read authoritative completed assistant/model-loop rows by completion time.
 *
 * This path intentionally does not share the creation-time filters used by token
 * history. A request may be created before a window cutoff and complete inside it.
 */
export async function iterCompletedAssistantMessages(params: {
  completedSinceMs?: number;
  completedUntilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    if (await hasJsonExtract(conn)) {
      const query = buildCompletedAssistantQuery(params);
      return dropForkCopies(
        mapCompletedAssistantMessages(conn.all<ProjectedMessageRow>(query.sql, query.args)),
      );
    }

    return [];
  } finally {
    conn.close();
  }
}

/**
 * Read assistant messages for a specific session only.
 */
export async function iterAssistantMessagesForSession(params: {
  sessionID: string;
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const { sessionID, sinceMs, untilMs } = params;
  validateSessionIdOrThrow(sessionID);

  const db = openDbOrNull();
  if (!db) {
    throw new SessionNotFoundError(sessionID, getOpenCodeDbPath());
  }

  const conn = await db.open();
  try {
    const exists = conn.get<{ ok: number }>(
      `SELECT 1 as ok FROM "session_v2" WHERE id = ? LIMIT 1`,
      [sessionID],
    );
    if (!exists) {
      throw new SessionNotFoundError(sessionID, db.dbPath);
    }

    if (!(await hasJsonExtract(conn))) return [];

    const q = buildMessageQuery({ sessionID, sinceMs, untilMs });
    const rows = conn.all<ProjectedMessageRow>(q.sql, q.args);
    return mapAssistantMessages(rows);
  } finally {
    conn.close();
  }
}

/**
 * Read assistant messages for a specific set of sessions.
 */
export async function iterAssistantMessagesForSessions(params: {
  sessionIDs: string[];
  sinceMs?: number;
  untilMs?: number;
}): Promise<OpenCodeMessage[]> {
  const sessionIDs = normalizeSessionIdsOrThrow(params.sessionIDs);
  if (sessionIDs.length === 0) return [];

  const db = openDbOrNull();
  if (!db) {
    throw new SessionNotFoundError(sessionIDs[0]!, getOpenCodeDbPath());
  }

  const conn = await db.open();
  try {
    if (!(await hasJsonExtract(conn))) return [];
    const reservedArgs =
      (typeof params.sinceMs === "number" ? 1 : 0) + (typeof params.untilMs === "number" ? 1 : 0);
    const maxSessionIdsPerQuery = Math.max(1, SQLITE_MAX_MESSAGE_QUERY_ARGS - reservedArgs);
    const messages: OpenCodeMessage[] = [];

    for (const sessionIdChunk of chunkArray(sessionIDs, maxSessionIdsPerQuery)) {
      const q = buildMessageQuery({
        sessionIDs: sessionIdChunk,
        sinceMs: params.sinceMs,
        untilMs: params.untilMs,
      });
      const rows = conn.all<ProjectedMessageRow>(q.sql, q.args);
      messages.push(...mapAssistantMessages(rows));
    }

    messages.sort(compareMessageOrder);
    return dropForkCopies(messages);
  } finally {
    conn.close();
  }
}

export async function readAllSessionsIndex(): Promise<Record<string, OpenCodeSessionInfo>> {
  const db = openDbOrNull();
  const idx: Record<string, OpenCodeSessionInfo> = {};
  if (!db) return idx;

  const conn = await db.open();
  try {
    const columns = readTableColumns(conn, "session_v2");
    const metadataColumns = [
      columns?.has("project_id") ? "project_id" : null,
      columns?.has("directory") ? "directory" : null,
    ].filter((column): column is string => column !== null);
    const rows = conn.all<SessionRow>(
      `SELECT id, title, parent_id, time_created, time_updated${
        metadataColumns.length ? `, ${metadataColumns.join(", ")}` : ""
      } FROM "session_v2" ORDER BY time_created ASC, id ASC`,
    );

    for (const row of rows) {
      if (!row || typeof row.id !== "string" || !row.id.startsWith("ses_")) continue;
      idx[row.id] = {
        id: row.id,
        title: typeof row.title === "string" && row.title.trim() ? row.title : undefined,
        parentID: typeof row.parent_id === "string" ? row.parent_id : undefined,
        projectID: normalizeString(row.project_id),
        directory: normalizeString(row.directory),
        time: {
          created: typeof row.time_created === "number" ? row.time_created : undefined,
          updated: typeof row.time_updated === "number" ? row.time_updated : undefined,
        },
      };
    }

    return idx;
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// GUI read-only extension (R46/R47): raw physical rows, project/worktree
// metadata, and compaction markers. Additive only — the readers above keep
// their existing behavior, and nothing here writes, migrates, or indexes.
// ---------------------------------------------------------------------------

/** The five raw additive token categories of one physical assistant message. */
export interface OpenCodeRawTokenCounts {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One physical completed assistant message, as stored: no fork dedup, so a
 * fork copy is its own row; missing token categories read as zero.
 */
export interface OpenCodeRawAssistantRow {
  sessionID: string;
  messageID: string;
  createdAtMs: number;
  completedAtMs: number;
  tokens: OpenCodeRawTokenCounts;
  cost?: number;
  providerID?: string;
  modelID?: string;
  agent?: string;
}

/** `project` + `project_directory` + `worktree` metadata (R46). */
export interface OpenCodeProjectInfo {
  id: string;
  /** `project.name` when the column exists and holds text. */
  name?: string;
  /** Directories registered for the project; only basenames ever reach the browser. */
  directories: string[];
  /** Git-worktree directories, when the `worktree` table is readable. */
  worktrees: string[];
}

/** One compaction marker: a physical `session_message` row of type `compaction`. */
export interface OpenCodeCompactionMarker {
  sessionId: string;
  atMs: number;
  messageId: string;
}

type ProjectRow = { id: unknown; name?: unknown };
type ProjectDirectoryRow = { project_id: unknown; directory: unknown };
type WorktreeRow = { project_id: unknown; directory: unknown };
type CompactionRow = { id: unknown; session_id: unknown; time_created: unknown };

function mapRawCompletedAssistantRow(row: ProjectedMessageRow): OpenCodeRawAssistantRow | null {
  const message = mapRowToOpenCodeMessage(row);
  if (!message) return null;
  if (String(message.role).toLowerCase() !== "assistant") return null;
  const completed = completedAt(message);
  if (completed === null) return null;

  return {
    sessionID: message.sessionID,
    messageID: message.id,
    createdAtMs: message.time?.created ?? 0,
    completedAtMs: completed,
    tokens: {
      input: message.tokens?.input ?? 0,
      output: message.tokens?.output ?? 0,
      reasoning: message.tokens?.reasoning ?? 0,
      cacheRead: message.tokens?.cache.read ?? 0,
      cacheWrite: message.tokens?.cache.write ?? 0,
    },
    cost: message.cost,
    providerID: message.providerID,
    modelID: message.modelID,
    agent: message.agent,
  };
}

/**
 * Read every physical completed assistant row without fork dedup (R46, R50).
 *
 * Completed-only matches the dashboard step rule: an assistant row counts once
 * `$.time.completed` is a positive number. The optional completed window is
 * inclusive on both ends, so P3 aggregation can request a range directly.
 * Schema drift (no message table or no JSON support) degrades to an empty read.
 */
export async function readCompletedAssistantRows(params?: {
  completedSinceMs?: number;
  completedUntilMs?: number;
}): Promise<OpenCodeRawAssistantRow[]> {
  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    const columns = readTableColumns(conn, "session_message");
    if (!columns?.has("type") || !columns.has("data")) return [];
    if (!(await hasJsonExtract(conn))) return [];

    const query = buildCompletedAssistantQuery(params ?? {});
    const out: OpenCodeRawAssistantRow[] = [];
    for (const row of conn.all<ProjectedMessageRow>(query.sql, query.args)) {
      const mapped = mapRawCompletedAssistantRow(row);
      if (mapped) out.push(mapped);
    }
    return out;
  } finally {
    conn.close();
  }
}

/**
 * Read project/worktree display metadata: `project.name`, registered
 * `project_directory` directories, and `worktree` directories with
 * `strategy = 'git_worktree'` (R46). Missing tables or columns degrade to an
 * empty index, which P3 reports as the unknown project instead of failing.
 */
export async function readProjectsIndex(): Promise<Record<string, OpenCodeProjectInfo>> {
  const db = openDbOrNull();
  const index: Record<string, OpenCodeProjectInfo> = {};
  if (!db) return index;

  const conn = await db.open();
  try {
    const projectColumns = readTableColumns(conn, "project");
    if (!projectColumns?.has("id")) return index;
    const nameProjection = projectColumns.has("name") ? ", name" : "";
    const projectRows = conn.all<ProjectRow>(
      `SELECT id${nameProjection} FROM "project" ORDER BY id ASC`,
    );
    for (const row of projectRows) {
      if (typeof row.id !== "string" || !row.id) continue;
      const name = normalizeString(row.name);
      index[row.id] = {
        id: row.id,
        name: name?.trim() ? name : undefined,
        directories: [],
        worktrees: [],
      };
    }

    const directoryColumns = readTableColumns(conn, "project_directory");
    if (directoryColumns?.has("project_id") && directoryColumns.has("directory")) {
      const rows = conn.all<ProjectDirectoryRow>(
        `SELECT project_id, directory FROM "project_directory" ORDER BY project_id ASC, directory ASC`,
      );
      for (const row of rows) {
        const info = typeof row.project_id === "string" ? index[row.project_id] : undefined;
        if (info && typeof row.directory === "string" && row.directory) {
          info.directories.push(row.directory);
        }
      }
    }

    const worktreeColumns = readTableColumns(conn, "worktree");
    if (worktreeColumns?.has("project_id") && worktreeColumns.has("directory")) {
      const strategyFilter = worktreeColumns.has("strategy")
        ? ` WHERE strategy = 'git_worktree'`
        : "";
      const rows = conn.all<WorktreeRow>(
        `SELECT project_id, directory FROM "worktree"${strategyFilter} ORDER BY project_id ASC, directory ASC`,
      );
      for (const row of rows) {
        const info = typeof row.project_id === "string" ? index[row.project_id] : undefined;
        if (info && typeof row.directory === "string" && row.directory) {
          info.worktrees.push(row.directory);
        }
      }
    }

    return index;
  } finally {
    conn.close();
  }
}

/**
 * Read compaction message rows as ordered markers (R26, R46): ordered at the
 * source by timestamp, then message id. The assistant readers cannot return
 * these rows (`type = 'compaction'`), and this reader projects physical
 * columns only — it never touches the JSON payload. Missing tables degrade to
 * no markers.
 */
export async function readCompactionMarkers(): Promise<OpenCodeCompactionMarker[]> {
  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    const columns = readTableColumns(conn, "session_message");
    if (!columns?.has("type")) return [];

    const markers: OpenCodeCompactionMarker[] = [];
    const rows = conn.all<CompactionRow>(
      `SELECT id, session_id, time_created FROM "session_message" WHERE type = 'compaction' ORDER BY time_created ASC, id ASC`,
    );
    for (const row of rows) {
      if (typeof row.id !== "string" || typeof row.session_id !== "string") continue;
      if (typeof row.time_created !== "number" || !Number.isFinite(row.time_created)) continue;
      markers.push({ sessionId: row.session_id, atMs: row.time_created, messageId: row.id });
    }
    return markers;
  } finally {
    conn.close();
  }
}
