import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  /** Non-query statements such as `BEGIN`/`COMMIT`; never used for binding. */
  exec(sql: string): void;
  close(): void;
}

/** A read/write connection; every mutation is a prepared statement or `exec`. */
export interface WritableSqliteConn extends SqliteConn {
  run(sql: string, params?: unknown[]): void;
}

interface SqliteStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
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
      const stmt = db.prepare(sql);
      return stmt.all(...toParams(params)) as T[];
    },

    get<T = unknown>(sql: string, params?: unknown[]): T | null {
      const stmt = db.prepare(sql);
      const row = stmt.get(...toParams(params)) as T | undefined;
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

async function openWithNodeSqlite(dbPath: string): Promise<SqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new mod.DatabaseSync(dbPath, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    open: true,
  });

  // Keep reads deterministic and avoid accidental writes.
  runNodePragma(db, "PRAGMA query_only = ON;");

  // Avoid transient SQLITE_BUSY errors (WAL).
  runNodePragma(db, "PRAGMA busy_timeout = 5000;");

  return createConn(db);
}

async function openWithBunSqlite(dbPath: string): Promise<SqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new mod.Database(dbPath, { readonly: true });

  // Keep reads deterministic and avoid accidental writes.
  runBunPragma(db, "PRAGMA query_only = ON;");

  // Avoid transient SQLITE_BUSY errors (WAL).
  runBunPragma(db, "PRAGMA busy_timeout = 5000;");

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
 */
export async function openOpenCodeSqliteWritable(
  dbPath: string,
  options: { busyTimeoutMs?: number } = {},
): Promise<WritableSqliteConn> {
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  if ("Bun" in globalThis) {
    return openWritableWithBunSqlite(dbPath, busyTimeoutMs);
  }
  return openWritableWithNodeSqlite(dbPath, busyTimeoutMs);
}

async function restrictFileMode(dbPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(dbPath, 0o600);
  } catch {
    // best effort; the private 0700 directory is the real boundary
  }
}

function configureWritableDb(
  db: NodeSqliteDatabase | BunSqliteDatabase,
  busyTimeoutMs: number,
): void {
  // Order matters: a contended database must never block on the WAL switch
  // with the default timeout before the caller's short one applies.
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(busyTimeoutMs))};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}

function writableConn(db: NodeSqliteDatabase | BunSqliteDatabase): WritableSqliteConn {
  return {
    ...createConn(db),

    run(sql: string, params?: unknown[]): void {
      db.prepare(sql).run(...toParams(params));
    },
  };
}

async function finishWritableOpen(
  db: NodeSqliteDatabase | BunSqliteDatabase,
  dbPath: string,
  busyTimeoutMs: number,
): Promise<WritableSqliteConn> {
  try {
    configureWritableDb(db, busyTimeoutMs);
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
  busyTimeoutMs: number,
): Promise<WritableSqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new mod.DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    open: true,
  });
  return finishWritableOpen(db, dbPath, busyTimeoutMs);
}

async function openWritableWithBunSqlite(
  dbPath: string,
  busyTimeoutMs: number,
): Promise<WritableSqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new mod.Database(dbPath);
  return finishWritableOpen(db, dbPath, busyTimeoutMs);
}

/**
 * Open OpenCode's SQLite database read-only.
 * Inside OpenCode 2 (Bun) this uses bun:sqlite; the Node CLI uses node:sqlite.
 */
export async function openOpenCodeSqliteReadOnly(dbPath: string): Promise<SqliteConn> {
  if ("Bun" in globalThis) {
    return openWithBunSqlite(dbPath);
  }

  return openWithNodeSqlite(dbPath);
}
