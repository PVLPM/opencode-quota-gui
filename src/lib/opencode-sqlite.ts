import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  /** Non-query statements such as `BEGIN`/`COMMIT`; never used for binding. */
  exec(sql: string): void;
  close(): void;
}

/** A reusable prepared statement (bulk writes must not re-prepare per row). */
export interface PreparedSqliteStatement {
  all<T = unknown>(params?: unknown[]): T[];
  get<T = unknown>(params?: unknown[]): T | null;
  /** Streams rows without materializing the whole result set. */
  iterate<T = unknown>(params?: unknown[]): IterableIterator<T>;
  run(params?: unknown[]): void;
}

/** A read/write connection; every mutation is a prepared statement or `exec`. */
export interface WritableSqliteConn extends SqliteConn {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): PreparedSqliteStatement;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  iterate(...params: unknown[]): IterableIterator<unknown>;
  /**
   * bun:sqlite only. An unfinalized statement keeps the database handle (and,
   * on Windows, the file) open after `close()`; node:sqlite finalizes on close.
   */
  finalize?(): void;
}

/** Runs one statement and releases it, so `close()` really releases the file. */
function withStatement<T>(
  db: NodeSqliteDatabase | BunSqliteDatabase,
  sql: string,
  use: (stmt: SqliteStatement) => T,
): T {
  const stmt = db.prepare(sql);
  try {
    return use(stmt);
  } finally {
    stmt.finalize?.();
  }
}

interface BunSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

interface BunSqliteModule {
  Database: new (path: string, options?: { readonly?: boolean }) => BunSqliteDatabase;
}

interface NodeSqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): unknown;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (
    path: string,
    options?: {
      readOnly?: boolean;
      enableForeignKeyConstraints?: boolean;
      open?: boolean;
    },
  ) => NodeSqliteDatabase;
}

function toParams(params?: unknown[]): unknown[] {
  return Array.isArray(params) ? params : [];
}

function runBunPragma(db: BunSqliteDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // ignore
  }
}

function runNodePragma(db: NodeSqliteDatabase, sql: string): void {
  try {
    db.exec(sql);
  } catch {
    // ignore
  }
}

function createConn(db: NodeSqliteDatabase | BunSqliteDatabase): SqliteConn {
  return {
    all<T = unknown>(sql: string, params?: unknown[]): T[] {
      return withStatement(db, sql, (stmt) => stmt.all(...toParams(params)) as T[]);
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const row = withStatement(db, sql, (stmt) => stmt.get(...toParams(params))) as T | undefined;
      return row ?? null;
    },

    exec(sql: string): void {
      db.exec(sql);
    },

    close(): void {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}

async function openWithNodeSqlite(dbPath: string, busyTimeoutMs: number): Promise<SqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new mod.DatabaseSync(dbPath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    open: true,
  });

  // Keep reads deterministic and avoid accidental writes.
  runNodePragma(db, "PRAGMA query_only = ON;");

  // Avoid transient SQLITE_BUSY errors (WAL); bounded by the caller.
  runNodePragma(db, `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);

  return createConn(db);
}

async function openWithBunSqlite(dbPath: string, busyTimeoutMs: number): Promise<SqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new mod.Database(dbPath, { readonly: true });

  // Keep reads deterministic and avoid accidental writes.
  runBunPragma(db, "PRAGMA query_only = ON;");

  // Avoid transient SQLITE_BUSY errors (WAL); bounded by the caller.
  runBunPragma(db, `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);

  return createConn(db);
}

/**
 * Open a plugin-owned SQLite database read/write.
 *
 * WAL keeps readers (the dashboard query path) and the single writer from
 * blocking each other; `synchronous = NORMAL` is durable across an application
 * crash and loses at most the last committed poll on sudden power loss, which
 * is acceptable for local quota history and avoids an fsync per cycle. The
 * caller owns the schema and every transaction.
 *
 * `busyTimeoutMs` is set before WAL is enabled so opening a database another
 * process is writing cannot block for the default multi-second timeout. The
 * recorder uses a short timeout and carries a cycle over instead of stalling
 * the host event loop.
 *
 * `deferJournalMode` leaves the journal mode alone, for a caller that must
 * check who owns the file before changing it, then enables WAL itself.
 */
export async function openOpenCodeSqliteWritable(
  dbPath: string,
  options: { busyTimeoutMs?: number; deferJournalMode?: boolean } = {},
): Promise<WritableSqliteConn> {
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  const setup = {
    busyTimeoutMs: options.busyTimeoutMs ?? 5000,
    wal: options.deferJournalMode !== true,
  };
  if ("Bun" in globalThis) {
    return openWritableWithBunSqlite(dbPath, setup);
  }
  return openWritableWithNodeSqlite(dbPath, setup);
}

async function restrictFileMode(dbPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(dbPath, 0o600);
  } catch {
    // best effort; the private 0700 directory is the real boundary
  }
}

interface WritableSetup {
  busyTimeoutMs: number;
  wal: boolean;
}

function configureWritableDb(
  db: NodeSqliteDatabase | BunSqliteDatabase,
  { busyTimeoutMs, wal }: WritableSetup,
): void {
  // Order matters: a contended database must never block on the WAL switch
  // with the default timeout before the caller's short one applies.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
  if (wal) db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

function writableConn(db: NodeSqliteDatabase | BunSqliteDatabase): WritableSqliteConn {
  const base = createConn(db);
  const prepared = new Set<SqliteStatement>();
  return {
    ...base,

    run(sql: string, params?: unknown[]): void {
      withStatement(db, sql, (stmt) => stmt.run(...toParams(params)));
    },

    prepare(sql: string): PreparedSqliteStatement {
      const stmt = db.prepare(sql);
      prepared.add(stmt);
      return {
        all<T = unknown>(params?: unknown[]): T[] {
          return stmt.all(...toParams(params)) as T[];
        },
        get<T = unknown>(params?: unknown[]): T | null {
          return (stmt.get(...toParams(params)) as T | undefined) ?? null;
        },
        iterate<T = unknown>(params?: unknown[]): IterableIterator<T> {
          return stmt.iterate(...toParams(params)) as IterableIterator<T>;
        },
        run(params?: unknown[]): void {
          stmt.run(...toParams(params));
        },
      };
    },

    close(): void {
      for (const stmt of prepared) {
        try {
          stmt.finalize?.();
        } catch {
          // closing must still release the handle
        }
      }
      prepared.clear();
      base.close();
    },
  };
}

async function finishWritableOpen(
  db: NodeSqliteDatabase | BunSqliteDatabase,
  dbPath: string,
  setup: WritableSetup,
): Promise<WritableSqliteConn> {
  try {
    configureWritableDb(db, setup);
    await restrictFileMode(dbPath);
  } catch (error) {
    // A half-configured handle must not leak.
    try {
      db.close();
    } catch {
      // the setup failure is the one worth reporting
    }
    throw error;
  }
  return writableConn(db);
}

async function openWritableWithNodeSqlite(
  dbPath: string,
  setup: WritableSetup,
): Promise<WritableSqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new mod.DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    open: true,
  });
  return finishWritableOpen(db, dbPath, setup);
}

async function openWritableWithBunSqlite(
  dbPath: string,
  setup: WritableSetup,
): Promise<WritableSqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new mod.Database(dbPath);
  return finishWritableOpen(db, dbPath, setup);
}

/**
 * Open OpenCode's SQLite database read-only.
 * Inside OpenCode 2 (Bun) this uses bun:sqlite; the Node CLI uses node:sqlite.
 * Callers that must stay responsive pass a short busy timeout.
 */
export async function openOpenCodeSqliteReadOnly(
  dbPath: string,
  options: { busyTimeoutMs?: number } = {},
): Promise<SqliteConn> {
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if ("Bun" in globalThis) {
    return openWithBunSqlite(dbPath, busyTimeoutMs);
  }

  return openWithNodeSqlite(dbPath, busyTimeoutMs);
}
