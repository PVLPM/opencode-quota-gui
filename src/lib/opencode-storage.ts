import { existsSync, realpathSync, statSync } from "node:fs";

import { getOpenCodeDbPath } from "./opencode-db-path.js";
import { openOpenCodeSqliteReadOnly, type SqliteConn } from "./opencode-sqlite.js";
import { type ForkOwnerCandidate, selectForkOwners } from "./usage-ownership.js";

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
  time_updated?: unknown;
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

function hasJsonExtract(conn: {
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
}): boolean {
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

function buildCompletedAssistantQuery(
  params: {
    completedSinceMs?: number;
    completedUntilMs?: number;
    completedAtTimes?: readonly number[];
    sessionID?: string;
    sessionIDs?: readonly string[];
    messageIDs?: readonly string[];
  },
  includeUpdatedAt = false,
): { sql: string; args: unknown[] } {
  const completedScalar = guardedJsonScalar("$.time.completed");
  const completedExpression = `CAST(${completedScalar} AS REAL)`;
  const projectedColumns = includeUpdatedAt
    ? `${PROJECTED_MESSAGE_COLUMNS}, time_updated`
    : PROJECTED_MESSAGE_COLUMNS;
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
  if (params.completedAtTimes !== undefined) {
    const times = [...new Set(params.completedAtTimes)]
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b);
    if (times.length === 0) {
      where.push(`1 = 0`);
    } else {
      // One JSON-array bind keeps the exact-time candidate projection to a
      // single SQLite scan instead of one scan per completion timestamp.
      where.push(`${completedExpression} IN (SELECT value FROM json_each(?))`);
      args.push(JSON.stringify(times));
    }
  }
  if (params.sessionID !== undefined) {
    where.push(`session_id = ?`);
    args.push(params.sessionID);
  } else if (params.sessionIDs !== undefined) {
    if (params.sessionIDs.length === 0) {
      where.push(`1 = 0`);
    } else {
      where.push(`session_id IN (${params.sessionIDs.map(() => "?").join(", ")})`);
      args.push(...params.sessionIDs);
    }
  }
  if (params.messageIDs !== undefined) {
    if (params.messageIDs.length === 0) {
      where.push(`1 = 0`);
    } else {
      where.push(`id IN (${params.messageIDs.map(() => "?").join(", ")})`);
      args.push(...params.messageIDs);
    }
  }

  return {
    // `readCompletedAssistantRowsFrom` sorts the projected rows itself
    // (`completedAtMs ASC, messageID ASC`), so a SQL ORDER BY here only adds a
    // temp B-tree over every matched row. Keep the scan unsorted and let the
    // single deterministic in-memory sort define the result order.
    sql: `SELECT ${projectedColumns} FROM "session_message"` + ` WHERE ${where.join(" AND ")}`,
    args,
  };
}

/** Deterministic code-unit comparison used for raw message ids. */
function compareStringIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareRawCompletedRows(a: OpenCodeRawAssistantRow, b: OpenCodeRawAssistantRow): number {
  if (a.completedAtMs !== b.completedAtMs) return a.completedAtMs - b.completedAtMs;
  return compareStringIds(a.messageID, b.messageID);
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/** One session/message id scope shared by all scoped readers. */
interface StorageIdScope {
  sessionID?: string;
  sessionIDs?: string[];
  messageIDs?: string[];
}

type StorageScope = { kind: "all" } | { kind: "scope"; ids: StorageIdScope } | { kind: "empty" };

/**
 * Resolve the id scope shared by the raw completed reader, the compaction
 * reader, and the revision snapshot. `messageIDs` combines with a session
 * scope (AND); `sessionID` and `sessionIDs` are mutually exclusive. Any empty
 * id list resolves to `empty` so no SQLite connection is opened.
 */
function normalizeStorageScope(params: {
  sessionID?: string;
  sessionIDs?: readonly string[];
  messageIDs?: readonly string[];
}): StorageScope {
  if (params.sessionID !== undefined && params.sessionIDs !== undefined) {
    throw new Error("received both sessionID and sessionIDs");
  }
  if (params.sessionID === "") return { kind: "empty" };
  if (params.sessionIDs !== undefined && params.sessionIDs.length === 0) return { kind: "empty" };
  if (params.messageIDs !== undefined && params.messageIDs.length === 0) return { kind: "empty" };

  const ids: StorageIdScope = {};
  if (params.sessionID !== undefined) ids.sessionID = params.sessionID;
  if (params.sessionIDs !== undefined) ids.sessionIDs = dedupeStrings(params.sessionIDs);
  if (params.messageIDs !== undefined) ids.messageIDs = dedupeStrings(params.messageIDs);

  if (ids.sessionID === undefined && ids.sessionIDs === undefined && ids.messageIDs === undefined) {
    return { kind: "all" };
  }
  return { kind: "scope", ids };
}

/**
 * Chunk one scope into queries under a bind-argument budget. `messageIDs` and
 * session ids combine with AND semantics; when both lists are present they are
 * chunked together so every emitted query stays within the budget.
 */
function scopedIdQueries<T>(
  ids: StorageIdScope,
  budget: number,
  build: (clause: StorageIdScope) => T,
): T[] {
  const queries: T[] = [];
  const { sessionID, sessionIDs, messageIDs } = ids;

  if (messageIDs === undefined) {
    if (sessionID !== undefined) return [build({ sessionID })];
    if (sessionIDs !== undefined) {
      for (const chunk of chunkArray(sessionIDs, budget)) {
        queries.push(build({ sessionIDs: chunk }));
      }
    }
    return queries;
  }

  if (sessionID !== undefined) {
    for (const chunk of chunkArray(messageIDs, Math.max(1, budget - 1))) {
      queries.push(build({ sessionID, messageIDs: chunk }));
    }
    return queries;
  }

  if (sessionIDs === undefined) {
    for (const chunk of chunkArray(messageIDs, budget)) queries.push(build({ messageIDs: chunk }));
    return queries;
  }

  for (const messageChunk of chunkArray(messageIDs, Math.max(1, budget - 1))) {
    const remaining = Math.max(1, budget - messageChunk.length);
    for (const sessionChunk of chunkArray(sessionIDs, remaining)) {
      queries.push(build({ sessionIDs: sessionChunk, messageIDs: messageChunk }));
    }
  }
  return queries;
}

function countDefined(values: readonly unknown[]): number {
  let count = 0;
  for (const value of values) if (value !== undefined) count += 1;
  return count;
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
 * The same upstream fingerprint derived from a raw completed row, for the
 * shared deterministic ownership primitive. Exported so the GUI aggregation
 * and the analytics worker use one formula.
 */
export function rawAssistantRowFingerprint(row: OpenCodeRawAssistantRow): string {
  return forkCopyFingerprint(
    {
      id: row.messageID,
      sessionID: row.sessionID,
      role: "assistant",
      providerID: row.providerID,
      modelID: row.modelID,
      tokens: {
        input: row.tokens.input,
        output: row.tokens.output,
        reasoning: row.tokens.reasoning,
        cache: { read: row.tokens.cacheRead, write: row.tokens.cacheWrite },
      },
      cost: row.cost,
      time: { created: row.createdAtMs, completed: row.completedAtMs },
    },
    row.completedAtMs,
  );
}

/**
 * OpenCode copies a parent's finished messages into each fork with new ids but
 * identical times, model, tokens, and cost. Each finished fingerprint is owned
 * as many times as the session that has it most often; unfinished rows are
 * always kept. Shared deterministic selection lives in `usage-ownership.ts`.
 */
function dropForkCopies(messages: OpenCodeMessage[]): OpenCodeMessage[] {
  const candidates: Array<ForkOwnerCandidate<OpenCodeMessage>> = [];
  for (const message of messages) {
    const candidate: ForkOwnerCandidate<OpenCodeMessage> = {
      item: message,
      sessionID: message.sessionID,
      messageID: message.id,
    };
    const completed = completedAt(message);
    if (completed !== null) candidate.fingerprint = forkCopyFingerprint(message, completed);
    const created = message.time?.created;
    if (typeof created === "number" && Number.isFinite(created)) candidate.createdAtMs = created;
    candidates.push(candidate);
  }
  return selectForkOwners(candidates);
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
  const [firstSessionID] = sessionIDs;
  if (firstSessionID === undefined) return [];

  const db = openDbOrNull();
  if (!db) {
    throw new SessionNotFoundError(firstSessionID, getOpenCodeDbPath());
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

function readAllSessionsIndexFrom(
  conn: Pick<SqliteConn, "all">,
): Record<string, OpenCodeSessionInfo> {
  const idx: Record<string, OpenCodeSessionInfo> = {};
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
}

export async function readAllSessionsIndex(): Promise<Record<string, OpenCodeSessionInfo>> {
  const db = openDbOrNull();
  if (!db) return {};

  const conn = await db.open();
  try {
    return readAllSessionsIndexFrom(conn);
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
  /**
   * `session_message.time_updated` when the column was read; null when the
   * column exists but holds no number. Additive: fingerprints ignore it.
   */
  updatedAtMs?: number | null;
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

type ProjectRow = { id: unknown; name?: unknown; worktree?: unknown };
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

export interface ReadCompletedAssistantRowsParams {
  completedSinceMs?: number;
  completedUntilMs?: number;
  /**
   * Exact physical completion timestamps to project. Used by scoped ownership
   * discovery so a wide min/max span never stands in for the exact candidate
   * set. Emitted as one bound JSON numeric array through `json_each`.
   */
  completedAtTimes?: readonly number[];
  sessionID?: string;
  sessionIDs?: readonly string[];
  messageIDs?: readonly string[];
}

/**
 * Read physical completed assistant rows without fork dedup (R46, R50).
 *
 * Completed-only matches the dashboard step rule: an assistant row counts once
 * `$.time.completed` is a positive number. The optional completed window is
 * inclusive on both ends, so P3 aggregation can request a range directly.
 *
 * `sessionID`, `sessionIDs`, and `messageIDs` are mutually exclusive scopes;
 * empty `sessionIDs`/`messageIDs` resolve to an empty read without opening the
 * database. Large scopes are chunked under the SQLite bind-argument bound and
 * merged back into completion-time order. `messageIDs` is the incremental
 * reconciliation fetch after a `readMessageRevisions` diff. Schema drift (no
 * message table or no JSON support) degrades to an empty read.
 */
function readCompletedAssistantRowsFrom(
  conn: SqliteConn,
  params: ReadCompletedAssistantRowsParams,
): OpenCodeRawAssistantRow[] {
  const scope = normalizeStorageScope(params);
  if (scope.kind === "empty") return [];

  const columns = readTableColumns(conn, "session_message");
  if (!columns?.has("type") || !columns.has("data")) return [];
  if (!hasJsonExtract(conn)) return [];
  const hasUpdatedAt = columns.has("time_updated");

  const reservedArgs = countDefined([
    params.completedSinceMs,
    params.completedUntilMs,
    params.completedAtTimes,
  ]);
  const maxIdsPerQuery = Math.max(1, SQLITE_MAX_MESSAGE_QUERY_ARGS - reservedArgs);
  const out: OpenCodeRawAssistantRow[] = [];

  const collect = (query: { sql: string; args: unknown[] }): void => {
    for (const row of conn.all<ProjectedMessageRow>(query.sql, query.args)) {
      const mapped = mapRawCompletedAssistantRow(row);
      if (!mapped) continue;
      if (hasUpdatedAt) mapped.updatedAtMs = normalizeNumber(row.time_updated) ?? null;
      out.push(mapped);
    }
  };

  if (scope.kind === "all") {
    collect(buildCompletedAssistantQuery(params, hasUpdatedAt));
  } else {
    const queries = scopedIdQueries(scope.ids, maxIdsPerQuery, (clause) =>
      buildCompletedAssistantQuery(
        {
          completedSinceMs: params.completedSinceMs,
          completedUntilMs: params.completedUntilMs,
          completedAtTimes: params.completedAtTimes,
          ...clause,
        },
        hasUpdatedAt,
      ),
    );
    for (const query of queries) collect(query);
  }

  out.sort(compareRawCompletedRows);
  return out;
}

export async function readCompletedAssistantRows(
  params: ReadCompletedAssistantRowsParams = {},
): Promise<OpenCodeRawAssistantRow[]> {
  if (normalizeStorageScope(params).kind === "empty") return [];

  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    return readCompletedAssistantRowsFrom(conn, params);
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
function readProjectsIndexFrom(conn: SqliteConn): Record<string, OpenCodeProjectInfo> {
  const index: Record<string, OpenCodeProjectInfo> = {};
  const projectColumns = readTableColumns(conn, "project");
  if (!projectColumns?.has("id")) return index;
  const projectProjection = [
    "id",
    projectColumns.has("name") ? "name" : null,
    // `project.worktree` is the canonical root in the shipped schema. It takes
    // precedence over registered/linked directories for name/root display.
    projectColumns.has("worktree") ? "worktree" : null,
  ].filter((column): column is string => column !== null);
  const projectRows = conn.all<ProjectRow>(
    `SELECT ${projectProjection.join(", ")} FROM "project" ORDER BY id ASC`,
  );
  for (const row of projectRows) {
    if (typeof row.id !== "string" || !row.id) continue;
    const name = normalizeString(row.name);
    const canonicalRoot = normalizeString(row.worktree)?.trim();
    index[row.id] = {
      id: row.id,
      name: name?.trim() ? name : undefined,
      directories: canonicalRoot ? [canonicalRoot] : [],
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
      if (!info || typeof row.directory !== "string" || !row.directory) continue;
      // Canonical root first, then registered directories without duplicates.
      if (info.directories.includes(row.directory)) continue;
      info.directories.push(row.directory);
    }
  }

  const worktreeColumns = readTableColumns(conn, "worktree");
  if (worktreeColumns?.has("project_id") && worktreeColumns.has("directory")) {
    // Shipped rows use `'git'` for linked worktrees and may also carry the
    // historical `'git_worktree'`; NULL marks canonical roots, not linked ones.
    // Missing strategy column degrades to the previous include-all behavior.
    const strategyFilter = worktreeColumns.has("strategy")
      ? ` WHERE strategy IN ('git', 'git_worktree')`
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
}

export async function readProjectsIndex(): Promise<Record<string, OpenCodeProjectInfo>> {
  const db = openDbOrNull();
  if (!db) return {};

  const conn = await db.open();
  try {
    return readProjectsIndexFrom(conn);
  } finally {
    conn.close();
  }
}

export interface ReadCompactionMarkersParams {
  sessionID?: string;
  sessionIDs?: readonly string[];
  /** Inclusive lower bound on `time_created`. */
  sinceMs?: number;
  /** Inclusive upper bound on `time_created`. */
  untilMs?: number;
}

/**
 * Read compaction message rows as ordered markers (R26, R46): ordered at the
 * source by timestamp, then message id. The assistant readers cannot return
 * these rows (`type = 'compaction'`), and this reader projects physical
 * columns only — it never touches the JSON payload. `sessionID`/`sessionIDs`
 * scope the read; empty id lists return no markers without opening the
 * database. Missing tables degrade to no markers.
 */
function readCompactionMarkersFrom(
  conn: SqliteConn,
  params: ReadCompactionMarkersParams,
): OpenCodeCompactionMarker[] {
  const scope = normalizeStorageScope(params);
  if (scope.kind === "empty") return [];

  const columns = readTableColumns(conn, "session_message");
  if (!columns?.has("type")) return [];

  const markers: OpenCodeCompactionMarker[] = [];
  const maxIdsPerQuery = Math.max(
    1,
    SQLITE_MAX_MESSAGE_QUERY_ARGS - countDefined([params.sinceMs, params.untilMs]),
  );

  const collect = (query: { sql: string; args: unknown[] }): void => {
    for (const row of conn.all<CompactionRow>(query.sql, query.args)) {
      if (typeof row.id !== "string" || typeof row.session_id !== "string") continue;
      if (typeof row.time_created !== "number" || !Number.isFinite(row.time_created)) continue;
      markers.push({ sessionId: row.session_id, atMs: row.time_created, messageId: row.id });
    }
  };

  const build = (scopeClause?: StorageIdScope): { sql: string; args: unknown[] } => {
    const where = [`type = 'compaction'`];
    const args: unknown[] = [];
    if (scopeClause?.sessionID !== undefined) {
      where.push(`session_id = ?`);
      args.push(scopeClause.sessionID);
    } else if (scopeClause?.sessionIDs !== undefined) {
      where.push(`session_id IN (${scopeClause.sessionIDs.map(() => "?").join(", ")})`);
      args.push(...scopeClause.sessionIDs);
    }
    if (typeof params.sinceMs === "number") {
      where.push(`time_created >= ?`);
      args.push(params.sinceMs);
    }
    if (typeof params.untilMs === "number") {
      where.push(`time_created <= ?`);
      args.push(params.untilMs);
    }
    return {
      sql:
        `SELECT id, session_id, time_created FROM "session_message"` +
        ` WHERE ${where.join(" AND ")} ORDER BY time_created ASC, id ASC`,
      args,
    };
  };

  if (scope.kind === "all") {
    collect(build());
  } else {
    const queries = scopedIdQueries(scope.ids, maxIdsPerQuery, (clause) => build(clause));
    for (const query of queries) collect(query);
  }

  markers.sort((a, b) => a.atMs - b.atMs || compareStringIds(a.messageId, b.messageId));
  return markers;
}

export async function readCompactionMarkers(
  params: ReadCompactionMarkersParams = {},
): Promise<OpenCodeCompactionMarker[]> {
  if (normalizeStorageScope(params).kind === "empty") return [];

  const db = openDbOrNull();
  if (!db) return [];

  const conn = await db.open();
  try {
    return readCompactionMarkersFrom(conn, params);
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Incremental reconciliation seam (worker): message revisions + source
// identity. Identity snapshots are full for the requested scope so deletions,
// type changes, and completion transitions are all detectable by diffing.
// ---------------------------------------------------------------------------

/** One physical `session_message` identity, projected without the JSON payload. */
export interface OpenCodeMessageRevision {
  messageID: string;
  sessionID: string;
  type: string;
  createdAtMs: number;
  /** `session_message.time_updated`; null when the column is absent or non-numeric. */
  updatedAtMs: number | null;
  /** Positive parsed `$.time.completed`; null when unfinished or unavailable. */
  completedAtMs: number | null;
}

export interface OpenCodeMessageRevisionSnapshot {
  /** false when `session_message` is absent or unreadable. */
  available: boolean;
  /** false when the schema has no usable `time_updated` column. */
  updatedAtAvailable: boolean;
  /** false when SQLite JSON extraction is unavailable for `time.completed`. */
  completedAtAvailable: boolean;
  /** Full identity snapshot for the requested scope, ordered by messageID. */
  revisions: OpenCodeMessageRevision[];
}

export interface ReadMessageRevisionsParams {
  sessionID?: string;
  sessionIDs?: readonly string[];
  messageIDs?: readonly string[];
  /**
   * Inclusive lower bound on `session_message.time_updated` for an incremental
   * revision read. Rows with a NULL timestamp are always included so a legacy
   * row never becomes invisible to reconciliation. Installed OpenCode has no
   * `time_updated` index, so the query still scans SQLite; it avoids projecting
   * the JSON completion payload for rows outside the delta.
   */
  updatedSinceMs?: number;
}

/**
 * Cheap source frontier for first-baseline cursor establishment: the maximum
 * physical `time_updated`, without projecting any JSON completion payload.
 */
export interface OpenCodeMessageRevisionFrontier {
  /** false when `session_message` is absent or unreadable. */
  available: boolean;
  /** false when the schema has no usable `time_updated` column. */
  updatedAtAvailable: boolean;
  /** Maximum non-null `time_updated`, or null when the table is empty. */
  maxUpdatedAtMs: number | null;
}

type RevisionRow = {
  id: unknown;
  session_id: unknown;
  type: unknown;
  time_created: unknown;
  time_updated: unknown;
  completed: unknown;
};

const UNAVAILABLE_REVISION_SNAPSHOT: OpenCodeMessageRevisionSnapshot = {
  available: false,
  updatedAtAvailable: false,
  completedAtAvailable: false,
  revisions: [],
};

function revisionSnapshot(
  updatedAtAvailable: boolean,
  completedAtAvailable: boolean,
  revisions: OpenCodeMessageRevision[],
): OpenCodeMessageRevisionSnapshot {
  return { available: true, updatedAtAvailable, completedAtAvailable, revisions };
}

/**
 * Read every physical message identity in scope for worker reconciliation.
 *
 * The snapshot deliberately includes unfinished, non-assistant, and compaction
 * rows: diffing message-id sets detects deletions, and per-row `type`,
 * `updatedAtMs`, and `completedAtMs` detect edits, type transitions, and
 * completion/uncompletion. Fetch changed completed assistant rows with
 * `readCompletedAssistantRows({ messageIDs })`. Empty scopes return an empty
 * snapshot without opening the database.
 */
function readMessageRevisionsFrom(
  conn: SqliteConn,
  params: ReadMessageRevisionsParams,
): OpenCodeMessageRevisionSnapshot {
  const scope = normalizeStorageScope(params);
  if (scope.kind === "empty") return UNAVAILABLE_REVISION_SNAPSHOT;

  const columns = readTableColumns(conn, "session_message");
  if (!columns?.has("id") || !columns.has("session_id")) {
    return UNAVAILABLE_REVISION_SNAPSHOT;
  }

  const updatedAtAvailable = columns.has("time_updated");
  const completedAtAvailable = columns.has("data") && hasJsonExtract(conn);
  const projection = [
    "id",
    "session_id",
    columns.has("type") ? "type" : "NULL AS type",
    columns.has("time_created") ? "time_created" : "NULL AS time_created",
    updatedAtAvailable ? "time_updated" : "NULL AS time_updated",
    completedAtAvailable
      ? `${guardedJsonScalar("$.time.completed")} AS completed`
      : "NULL AS completed",
  ].join(", ");

  const revisions: OpenCodeMessageRevision[] = [];
  const updatedDelta =
    updatedAtAvailable && typeof params.updatedSinceMs === "number"
      ? params.updatedSinceMs
      : undefined;
  const maxIdsPerQuery = Math.max(
    1,
    SQLITE_MAX_MESSAGE_QUERY_ARGS - (updatedDelta === undefined ? 0 : 1),
  );

  const build = (scopeClause?: StorageIdScope): { sql: string; args: unknown[] } => {
    const where: string[] = [];
    const args: unknown[] = [];
    if (scopeClause?.sessionID !== undefined) {
      where.push(`session_id = ?`);
      args.push(scopeClause.sessionID);
    } else if (scopeClause?.sessionIDs !== undefined) {
      where.push(`session_id IN (${scopeClause.sessionIDs.map(() => "?").join(", ")})`);
      args.push(...scopeClause.sessionIDs);
    }
    if (scopeClause?.messageIDs !== undefined) {
      where.push(`id IN (${scopeClause.messageIDs.map(() => "?").join(", ")})`);
      args.push(...scopeClause.messageIDs);
    }
    if (updatedDelta !== undefined) {
      // NULL timestamps are replayed rather than silently skipped; a new legacy
      // row must remain visible even when it cannot advance the cursor.
      where.push(`(time_updated IS NULL OR time_updated >= ?)`);
      args.push(updatedDelta);
    }
    return {
      // The reader sorts the collected revisions by message id, and the
      // incremental engine re-sorts a delta by `(updatedAtMs, messageId)`
      // before replay. A SQL ORDER BY would add a second temp B-tree (notably
      // over a full identity projection) without changing the final order.
      sql:
        `SELECT ${projection} FROM "session_message"` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : ""),
      args,
    };
  };

  const collect = (query: { sql: string; args: unknown[] }): void => {
    for (const row of conn.all<RevisionRow>(query.sql, query.args)) {
      if (typeof row.id !== "string" || typeof row.session_id !== "string") continue;
      const createdAt = normalizeNumber(row.time_created);
      const updatedAt = normalizeNumber(row.time_updated);
      const completed = normalizeNumber(row.completed);
      revisions.push({
        messageID: row.id,
        sessionID: row.session_id,
        type: normalizeString(row.type) ?? "unknown",
        createdAtMs: createdAt ?? 0,
        updatedAtMs: updatedAt ?? null,
        completedAtMs: completed !== undefined && completed > 0 ? Math.trunc(completed) : null,
      });
    }
  };

  if (scope.kind === "all") {
    collect(build());
  } else {
    const queries = scopedIdQueries(scope.ids, maxIdsPerQuery, (clause) => build(clause));
    for (const query of queries) collect(query);
  }

  revisions.sort((a, b) => compareStringIds(a.messageID, b.messageID));
  return revisionSnapshot(updatedAtAvailable, completedAtAvailable, revisions);
}

/**
 * Read only the source `time_updated` frontier. This is the first-baseline
 * establishment path: it scans the physical column but never projects JSON, so
 * it cannot accidentally turn a cold start into a lifetime completion read.
 */
function readMessageRevisionFrontierFrom(conn: SqliteConn): OpenCodeMessageRevisionFrontier {
  const columns = readTableColumns(conn, "session_message");
  if (!columns?.has("id")) {
    return { available: false, updatedAtAvailable: false, maxUpdatedAtMs: null };
  }
  if (!columns.has("time_updated")) {
    return { available: true, updatedAtAvailable: false, maxUpdatedAtMs: null };
  }
  const row = conn.get<{ max_updated: unknown }>(
    `SELECT MAX(time_updated) AS max_updated FROM "session_message"`,
  );
  const maxUpdatedAtMs = normalizeNumber(row?.max_updated);
  return {
    available: true,
    updatedAtAvailable: true,
    maxUpdatedAtMs: maxUpdatedAtMs ?? null,
  };
}

export async function readMessageRevisionFrontier(): Promise<OpenCodeMessageRevisionFrontier> {
  const db = openDbOrNull();
  if (!db) return { available: false, updatedAtAvailable: false, maxUpdatedAtMs: null };

  const conn = await db.open();
  try {
    return readMessageRevisionFrontierFrom(conn);
  } finally {
    conn.close();
  }
}

export async function readMessageRevisions(
  params: ReadMessageRevisionsParams = {},
): Promise<OpenCodeMessageRevisionSnapshot> {
  if (normalizeStorageScope(params).kind === "empty") return UNAVAILABLE_REVISION_SNAPSHOT;

  const db = openDbOrNull();
  if (!db) return UNAVAILABLE_REVISION_SNAPSHOT;

  const conn = await db.open();
  try {
    return readMessageRevisionsFrom(conn, params);
  } finally {
    conn.close();
  }
}

/**
 * Local-only source identity for worker cache invalidation; never browser data.
 *
 * The stable comparison key is the file identity (`device` + `inode`, falling
 * back to `realPath` + `birthtimeMs`) plus the readable schema layout token —
 * never `sizeBytes`/`mtimeMs`, which change on ordinary writes and WAL
 * checkpoints and must not trigger a rebuild. `sizeBytes`/`mtimeMs` are kept
 * as informational metadata for existing consumers.
 */
export type OpenCodeSourceIdentityStatus = "ok" | "missing" | "unreadable";

export interface OpenCodeSourceIdentity {
  dbPath: string;
  /** True when the path names a file on disk, even if it cannot be opened. */
  exists: boolean;
  /** `ok` only when the file is present and the schema could be read. */
  status: OpenCodeSourceIdentityStatus;
  /** Informational only; never part of the identity comparison. */
  sizeBytes?: number;
  /** Informational only; never part of the identity comparison. */
  mtimeMs?: number;
  /** Canonical path when resolvable (symlink target). */
  realPath?: string;
  /** Stable `stat.dev`, decimal string, when available. */
  device?: string;
  /** Stable `stat.ino` (file id), decimal string, when available and non-zero. */
  inode?: string;
  /** Creation time in ms; stable fallback key when device/inode are unavailable. */
  birthtimeMs?: number;
  /** Sorted column layout of the OpenCode tables, read from the database. */
  schemaToken?: string;
}

/** Explicit comparison outcome for `compareOpenCodeSourceIdentity`. */
export type OpenCodeSourceIdentityComparison = "same" | "changed" | "unavailable" | "unknown";

function fileIdentityKey(identity: OpenCodeSourceIdentity): string | undefined {
  if (identity.device !== undefined && identity.inode !== undefined && identity.inode !== "0") {
    return `d:${identity.device}:${identity.inode}`;
  }
  if (identity.birthtimeMs !== undefined) {
    return `b:${identity.realPath ?? identity.dbPath}:${identity.birthtimeMs}`;
  }
  return undefined;
}

/**
 * Compare a previously accepted good identity with the latest read.
 *
 * - `unavailable`: the latest read could not reach a readable file. Keep the
 *   current good state (and the last good identity) untouched.
 * - `changed`: stable file identity or schema layout changed (reset,
 *   replacement, deletion+recreate). Rebuild from scratch.
 * - `unknown`: the platform did not expose a stable file key. Callers should
 *   treat this as unchanged to avoid rebuild churn on content writes.
 * - `same`: content may have changed; reconcile through the revision diff.
 */
export function compareOpenCodeSourceIdentity(
  previous: OpenCodeSourceIdentity | undefined,
  next: OpenCodeSourceIdentity,
): OpenCodeSourceIdentityComparison {
  if (next.status !== "ok") return "unavailable";
  if (previous === undefined || previous.status !== "ok") return "changed";
  if ((previous.realPath ?? previous.dbPath) !== (next.realPath ?? next.dbPath)) return "changed";

  const previousKey = fileIdentityKey(previous);
  const nextKey = fileIdentityKey(next);
  if (previousKey === undefined || nextKey === undefined) return "unknown";
  if (previousKey !== nextKey) return "changed";

  if (
    previous.schemaToken !== undefined &&
    next.schemaToken !== undefined &&
    previous.schemaToken !== next.schemaToken
  ) {
    return "changed";
  }
  return "same";
}

const SCHEMA_TOKEN_TABLES = [
  "session_v2",
  "session_message",
  "project",
  "project_directory",
  "worktree",
] as const;

function readSchemaToken(conn: Pick<SqliteConn, "all" | "get">): string {
  // Force a header read: a file that is not a database throws here, so the
  // identity/snapshot seams report "unreadable" instead of an empty DB.
  conn.get<{ c: number }>("SELECT count(*) AS c FROM sqlite_master");

  const parts: string[] = [];
  for (const table of SCHEMA_TOKEN_TABLES) {
    const columns = readTableColumns(conn, table);
    parts.push(columns ? `${table}(${[...columns].sort().join(",")})` : `${table}()`);
  }
  return parts.join("|");
}

function readSourceIdentityStat(): OpenCodeSourceIdentity {
  const dbPath = getOpenCodeDbPath();
  if (dbPath === ":memory:") return { dbPath, exists: false, status: "missing" };

  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(dbPath);
  } catch {
    return { dbPath, exists: false, status: "missing" };
  }

  if (!stat.isFile()) {
    return {
      dbPath,
      exists: false,
      status: "unreadable",
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      birthtimeMs: stat.birthtimeMs,
    };
  }

  const identity: OpenCodeSourceIdentity = {
    dbPath,
    exists: true,
    status: "ok",
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
  try {
    identity.realPath = realpathSync(dbPath);
  } catch {
    // Keep dbPath as the path component of the fallback key.
  }
  try {
    // BigInt stat keeps 64-bit file ids exact across platforms.
    const big = statSync(dbPath, { bigint: true });
    identity.device = big.dev.toString();
    identity.inode = big.ino.toString();
    identity.birthtimeMs = Number(big.birthtimeMs);
  } catch {
    // Fall back to the birthtime from the regular stat.
  }
  return identity;
}

/**
 * Read the local source identity. `status: "ok"` means the file exists and the
 * schema was readable (including a successfully opened, empty database);
 * `"missing"` and `"unreadable"` are explicit so callers can preserve the last
 * good state instead of replacing it with an empty generation.
 */
export async function readOpenCodeSourceIdentity(): Promise<OpenCodeSourceIdentity> {
  const identity = readSourceIdentityStat();
  if (identity.status !== "ok") return identity;

  let conn: SqliteConn;
  try {
    conn = await openOpenCodeSqliteReadOnly(identity.dbPath);
  } catch {
    return { ...identity, status: "unreadable", schemaToken: undefined };
  }
  try {
    return { ...identity, schemaToken: readSchemaToken(conn) };
  } catch {
    return { ...identity, status: "unreadable", schemaToken: undefined };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Consistent read snapshot seam (worker): one read-only connection with one
// read transaction. Every metadata/revision/payload read inside the callback
// observes the same database snapshot, and the transaction is committed on
// success, rolled back on error, and the connection closed in `finally`.
// ---------------------------------------------------------------------------

export interface OpenCodeStorageSnapshot {
  readonly dbPath: string;
  /** Identity captured for the transaction that backs every reader below. */
  readonly identity: OpenCodeSourceIdentity;
  readAllSessionsIndex(): Record<string, OpenCodeSessionInfo>;
  readProjectsIndex(): Record<string, OpenCodeProjectInfo>;
  readCompletedAssistantRows(params?: ReadCompletedAssistantRowsParams): OpenCodeRawAssistantRow[];
  readCompactionMarkers(params?: ReadCompactionMarkersParams): OpenCodeCompactionMarker[];
  readMessageRevisions(params?: ReadMessageRevisionsParams): OpenCodeMessageRevisionSnapshot;
  readMessageRevisionFrontier(): OpenCodeMessageRevisionFrontier;
}

/**
 * `missing`/`unreadable` are control results, not errors: the caller keeps its
 * last good state instead of publishing an empty or partial generation.
 */
export type OpenCodeStorageSnapshotResult<T> =
  | { status: "ok"; value: T }
  | { status: "missing" }
  | { status: "unreadable" };

function createStorageSnapshot(
  conn: SqliteConn,
  identity: OpenCodeSourceIdentity,
): OpenCodeStorageSnapshot {
  return {
    dbPath: identity.dbPath,
    identity,
    readAllSessionsIndex: () => readAllSessionsIndexFrom(conn),
    readProjectsIndex: () => readProjectsIndexFrom(conn),
    readCompletedAssistantRows: (params = {}) => readCompletedAssistantRowsFrom(conn, params),
    readCompactionMarkers: (params = {}) => readCompactionMarkersFrom(conn, params),
    readMessageRevisions: (params = {}) => readMessageRevisionsFrom(conn, params),
    readMessageRevisionFrontier: () => readMessageRevisionFrontierFrom(conn),
  };
}

/**
 * The stable path identity observed before opening must still describe the
 * path while the transaction runs. A replacement between `stat` and `open`
 * otherwise pairs one file's identity with another file's rows.
 */
function sameStablePathIdentity(
  before: OpenCodeSourceIdentity,
  after: OpenCodeSourceIdentity,
): boolean {
  if (before.status !== "ok" || after.status !== "ok") return false;
  if ((before.realPath ?? before.dbPath) !== (after.realPath ?? after.dbPath)) return false;
  if (
    before.birthtimeMs !== undefined &&
    after.birthtimeMs !== undefined &&
    before.birthtimeMs !== after.birthtimeMs
  ) {
    return false;
  }
  const beforeKey = fileIdentityKey(before);
  const afterKey = fileIdentityKey(after);
  if (beforeKey !== undefined && afterKey !== undefined) return beforeKey === afterKey;
  if (before.birthtimeMs !== undefined && after.birthtimeMs !== undefined) {
    return before.birthtimeMs === after.birthtimeMs;
  }
  // No stable key is exposed on this platform; keep the existing "unknown"
  // policy rather than inventing a stronger generation guarantee.
  return true;
}

/**
 * Run `read` against one transaction-bound snapshot of the OpenCode database.
 *
 * The first `SELECT` after `BEGIN` establishes the read snapshot, so changed
 * payload reads and the membership/revision read inside the callback cannot
 * observe a concurrently committed generation. The same stable path identity
 * is rechecked after opening and before commit; a path replacement maps to
 * `unreadable` so the caller keeps its last good state. Callback errors
 * propagate after a rollback; only opening/transaction/schema/path-identity
 * failures map to `missing` or `unreadable`.
 */
export async function withOpenCodeStorageSnapshot<T>(
  read: (snapshot: OpenCodeStorageSnapshot) => T | Promise<T>,
): Promise<OpenCodeStorageSnapshotResult<T>> {
  const statIdentity = readSourceIdentityStat();
  if (statIdentity.status === "missing") return { status: "missing" };
  if (statIdentity.status === "unreadable") return { status: "unreadable" };

  let conn: SqliteConn;
  try {
    conn = await openOpenCodeSqliteReadOnly(statIdentity.dbPath);
  } catch {
    return { status: "unreadable" };
  }

  let began = false;
  try {
    try {
      conn.get("BEGIN");
      began = true;
      conn.get("SELECT 1");
    } catch {
      return { status: "unreadable" };
    }

    if (!sameStablePathIdentity(statIdentity, readSourceIdentityStat())) {
      return { status: "unreadable" };
    }

    let identity: OpenCodeSourceIdentity;
    try {
      identity = { ...statIdentity, schemaToken: readSchemaToken(conn) };
    } catch {
      return { status: "unreadable" };
    }

    const value = await read(createStorageSnapshot(conn, identity));
    // Do not publish a generation if the path was replaced during the read;
    // the connection remains the old file while the path already points at a
    // different generation.
    if (!sameStablePathIdentity(statIdentity, readSourceIdentityStat())) {
      return { status: "unreadable" };
    }
    if (began) {
      try {
        conn.get("COMMIT");
      } catch {
        // A read-only transaction commit has no observable effect.
      }
      began = false;
    }
    return { status: "ok", value };
  } catch (error) {
    if (began) {
      try {
        conn.get("ROLLBACK");
      } catch {
        // The connection is closed in `finally` regardless.
      }
    }
    throw error;
  } finally {
    conn.close();
  }
}
