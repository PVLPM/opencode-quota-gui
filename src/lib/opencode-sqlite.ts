import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SqliteConn {
  all<T = unknown>(sql: string, params?: unknown[]): T[];
  get<T = unknown>(sql: string, params?: unknown[]): T | null;
  close(): void;
}

/** A read/write connection; every mutation is a prepared statement or `exec`. */
export interface WritableSqliteConn extends SqliteConn {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string): void;
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
 */
export async function openOpenCodeSqliteWritable(dbPath: string): Promise<WritableSqliteConn> {
  await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
  if ("Bun" in globalThis) {
    return openWritableWithBunSqlite(dbPath);
  }
  return openWritableWithNodeSqlite(dbPath);
}

async function restrictFileMode(dbPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(dbPath, 0o600);
  } catch {
    // best effort; the private 0700 directory is the real boundary
  }
}

function configureWritableDb(db: NodeSqliteDatabase | BunSqliteDatabase): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
}

function writableConn(db: NodeSqliteDatabase | BunSqliteDatabase): WritableSqliteConn {
  return {
    ...createConn(db),

    run(sql: string, params?: unknown[]): void {
      db.prepare(sql).run(...toParams(params));
    },

    exec(sql: string): void {
      db.exec(sql);
    },
  };
}

async function openWritableWithNodeSqlite(dbPath: string): Promise<WritableSqliteConn> {
  const mod = (await import("node:sqlite")) as unknown as NodeSqliteModule;
  const db = new mod.DatabaseSync(dbPath, {
    enableForeignKeyConstraints: true,
    open: true,
  });
  configureWritableDb(db);
  await restrictFileMode(dbPath);
  return writableConn(db);
}

async function openWritableWithBunSqlite(dbPath: string): Promise<WritableSqliteConn> {
  const mod = (await import("bun:sqlite")) as unknown as BunSqliteModule;
  const db = new mod.Database(dbPath);
  configureWritableDb(db);
  await restrictFileMode(dbPath);
  return writableConn(db);
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
