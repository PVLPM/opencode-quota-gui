import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Synthetic OpenCode 2 database for the GUI storage tests.
 *
 * Every value here is invented in this file: no real user database, schema
 * sample, path, credential, or project is ever read (R38/R51). The schema
 * mirrors the columns the GUI readers feature-detect, so drift cases
 * (missing project columns, missing tables) can be built explicitly.
 */

/** One `session_v2` row. */
export type GuiDatabaseSessionRow = {
  id: string;
  title?: string | null;
  parentID?: string | null;
  projectID?: string | null;
  directory?: string | null;
  createdMs: number;
  updatedMs?: number;
};

/** One `session_message` row; `data` JSON is built from these fields. */
export type GuiDatabaseMessageRow = {
  id: string;
  sessionID: string;
  /** Defaults to `assistant`; `compaction` builds a marker row. */
  type?: string;
  seq?: number;
  createdMs: number;
  /** `session_message.time_updated`; defaults to `completedMs ?? createdMs`. */
  updatedMs?: number;
  completedMs?: number | null;
  model?: { providerID: string; id: string } | null;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  } | null;
  cost?: number | null;
  agent?: string | null;
};

export type GuiDatabaseProjectRow = {
  id: string;
  name?: string | null;
  /** Canonical project root (`project.worktree`); absent/null when unknown. */
  worktree?: string | null;
};
export type GuiDatabaseProjectDirectoryRow = { projectID: string; directory: string };
export type GuiDatabaseWorktreeRow = {
  projectID: string;
  directory: string;
  /**
   * Linked-worktree strategy. Live OpenCode rows use `'git'`, `'git_worktree'`,
   * or NULL (canonical roots); defaults to `'git'`.
   */
  strategy?: string | null;
};

export type GuiDatabaseSchema = {
  /** Create `session_v2.project_id`/`directory`. Defaults to `true`. */
  sessionProjectColumns?: boolean;
  /** Create the `session_message` table. Defaults to `true`. */
  messageTable?: boolean;
  /** Create the `session_message.time_updated` column. Defaults to `true`. */
  messageUpdatedColumn?: boolean;
  /** Journal mode to set before closing; e.g. `"wal"` for concurrent-reader tests. */
  journalMode?: string;
  /** Create `project`, `project_directory`, and `worktree`. Defaults to `true`. */
  projectTables?: boolean;
  /** Create the `project.name` column. Defaults to `true`. */
  projectNameColumn?: boolean;
  /** Create the `project.worktree` canonical-root column. Defaults to `true`. */
  projectWorktreeColumn?: boolean;
  /** Create the `project_directory` table. Defaults to `true`. */
  projectDirectoryTable?: boolean;
  /** Create the `worktree` table. Defaults to `true`. */
  worktreeTable?: boolean;
  /** Create the `worktree.strategy` column. Defaults to `true`. */
  worktreeStrategyColumn?: boolean;
  sessions?: readonly GuiDatabaseSessionRow[];
  messages?: readonly GuiDatabaseMessageRow[];
  projects?: readonly GuiDatabaseProjectRow[];
  projectDirectories?: readonly GuiDatabaseProjectDirectoryRow[];
  worktrees?: readonly GuiDatabaseWorktreeRow[];
};

/** Creates a fresh temp directory for one synthetic GUI database. */
export async function createGuiDatabaseRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "opencode-quota-gui-db-"));
}

/** Removes a directory from `createGuiDatabaseRoot`. */
export async function removeGuiDatabaseRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function buildMessageData(row: GuiDatabaseMessageRow): Record<string, unknown> {
  const data: Record<string, unknown> = {
    time: {
      created: row.createdMs,
      ...(row.completedMs === undefined || row.completedMs === null
        ? {}
        : { completed: row.completedMs }),
    },
  };
  if (row.model) data.model = { providerID: row.model.providerID, id: row.model.id };
  if (row.tokens) {
    const tokens: Record<string, unknown> = {};
    if (row.tokens.input !== undefined) tokens.input = row.tokens.input;
    if (row.tokens.output !== undefined) tokens.output = row.tokens.output;
    if (row.tokens.reasoning !== undefined) tokens.reasoning = row.tokens.reasoning;
    if (row.tokens.cacheRead !== undefined || row.tokens.cacheWrite !== undefined) {
      tokens.cache = {
        ...(row.tokens.cacheRead === undefined ? {} : { read: row.tokens.cacheRead }),
        ...(row.tokens.cacheWrite === undefined ? {} : { write: row.tokens.cacheWrite }),
      };
    }
    data.tokens = tokens;
  }
  if (row.cost !== undefined && row.cost !== null) data.cost = row.cost;
  if (row.agent !== undefined && row.agent !== null) data.agent = row.agent;
  return data;
}

/**
 * Writes a synthetic OpenCode 2 database (`opencode.db`) under `root` and
 * returns its path.
 */
export function writeGuiDatabase(root: string, schema: GuiDatabaseSchema = {}): string {
  const dbPath = join(root, "opencode.db");
  const database = new DatabaseSync(dbPath);
  try {
    const sessionProjectColumns = schema.sessionProjectColumns ?? true;
    database.exec(`
      CREATE TABLE "session_v2" (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent_id TEXT,
        ${sessionProjectColumns ? "project_id TEXT," : ""}
        ${sessionProjectColumns ? "directory TEXT," : ""}
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
    `);

    const insertSession = database.prepare(
      `INSERT INTO "session_v2" (
        id, title, parent_id${sessionProjectColumns ? ", project_id, directory" : ""},
        time_created, time_updated
      ) VALUES (?, ?, ?${sessionProjectColumns ? ", ?, ?" : ""}, ?, ?)`,
    );
    for (const row of schema.sessions ?? []) {
      const args: unknown[] = [row.id, row.title ?? null, row.parentID ?? null];
      if (sessionProjectColumns) args.push(row.projectID ?? null, row.directory ?? null);
      args.push(row.createdMs, row.updatedMs ?? row.createdMs);
      insertSession.run(...args);
    }

    if (schema.messageTable ?? true) {
      const messageUpdatedColumn = schema.messageUpdatedColumn ?? true;
      database.exec(`
        CREATE TABLE "session_message" (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          type TEXT NOT NULL,
          seq INTEGER NOT NULL,
          time_created INTEGER NOT NULL,
          ${messageUpdatedColumn ? "time_updated INTEGER NOT NULL," : ""}
          data TEXT NOT NULL
        );
      `);
      const insertMessage = database.prepare(
        `INSERT INTO "session_message" (
          id, session_id, type, seq, time_created${messageUpdatedColumn ? ", time_updated" : ""}, data
        ) VALUES (?, ?, ?, ?, ?${messageUpdatedColumn ? ", ?" : ""}, ?)`,
      );
      (schema.messages ?? []).forEach((row, index) => {
        const args: unknown[] = [
          row.id,
          row.sessionID,
          row.type ?? "assistant",
          row.seq ?? index + 1,
          row.createdMs,
        ];
        if (messageUpdatedColumn) args.push(row.updatedMs ?? row.completedMs ?? row.createdMs);
        args.push(JSON.stringify(buildMessageData(row)));
        insertMessage.run(...args);
      });
    }

    if (schema.projectTables ?? true) {
      const projectNameColumn = schema.projectNameColumn ?? true;
      const projectWorktreeColumn = schema.projectWorktreeColumn ?? true;
      database.exec(
        `CREATE TABLE "project" (id TEXT PRIMARY KEY${projectNameColumn ? ", name TEXT" : ""}${
          projectWorktreeColumn ? ", worktree TEXT" : ""
        });`,
      );
      const projectColumns = [
        "id",
        ...(projectNameColumn ? ["name"] : []),
        ...(projectWorktreeColumn ? ["worktree"] : []),
      ];
      const insertProject = database.prepare(
        `INSERT INTO "project" (${projectColumns.join(", ")}) VALUES (${projectColumns
          .map(() => "?")
          .join(", ")})`,
      );
      for (const row of schema.projects ?? []) {
        const args: unknown[] = [row.id];
        if (projectNameColumn) args.push(row.name ?? null);
        if (projectWorktreeColumn) args.push(row.worktree ?? null);
        insertProject.run(...args);
      }

      if (schema.projectDirectoryTable ?? true) {
        database.exec(
          `CREATE TABLE "project_directory" (project_id TEXT NOT NULL, directory TEXT NOT NULL);`,
        );
        const insertProjectDirectory = database.prepare(
          `INSERT INTO "project_directory" (project_id, directory) VALUES (?, ?)`,
        );
        for (const row of schema.projectDirectories ?? []) {
          insertProjectDirectory.run(row.projectID, row.directory);
        }
      }

      if (schema.worktreeTable ?? true) {
        const worktreeStrategyColumn = schema.worktreeStrategyColumn ?? true;
        database.exec(
          `CREATE TABLE "worktree" (
            project_id TEXT NOT NULL,
            directory TEXT NOT NULL${worktreeStrategyColumn ? ", strategy TEXT" : ""}
          );`,
        );
        const insertWorktree = database.prepare(
          `INSERT INTO "worktree" (project_id, directory${
            worktreeStrategyColumn ? ", strategy" : ""
          }) VALUES (?, ?${worktreeStrategyColumn ? ", ?" : ""})`,
        );
        for (const row of schema.worktrees ?? []) {
          if (worktreeStrategyColumn) {
            const strategy = row.strategy === undefined ? "git" : row.strategy;
            insertWorktree.run(row.projectID, row.directory, strategy);
          } else {
            insertWorktree.run(row.projectID, row.directory);
          }
        }
      }
    }
  } finally {
    if (schema.journalMode) {
      database.exec(`PRAGMA journal_mode=${schema.journalMode};`);
    }
    database.close();
  }
  return dbPath;
}
