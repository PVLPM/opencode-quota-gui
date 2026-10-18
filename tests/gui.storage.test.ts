import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readAllSessionsIndex,
  readCompactionMarkers,
  readCompletedAssistantRows,
  readProjectsIndex,
} from "../src/lib/opencode-storage.js";
import {
  createGuiDatabaseRoot,
  type GuiDatabaseSchema,
  removeGuiDatabaseRoot,
  writeGuiDatabase,
} from "./helpers/gui-database.js";

const sqliteTrace = vi.hoisted(() => ({ opened: 0, statements: [] as string[] }));

vi.mock("../src/lib/opencode-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode-sqlite.js")>();
  return {
    openOpenCodeSqliteReadOnly: async (dbPath: string) => {
      sqliteTrace.opened += 1;
      const conn = await actual.openOpenCodeSqliteReadOnly(dbPath);
      return {
        all<T = unknown>(sql: string, params?: unknown[]): T[] {
          sqliteTrace.statements.push(sql);
          return conn.all<T>(sql, params);
        },
        get<T = unknown>(sql: string, params?: unknown[]): T | null {
          sqliteTrace.statements.push(sql);
          return conn.get<T>(sql, params);
        },
        close(): void {
          conn.close();
        },
      };
    },
  };
});

let root: string;

beforeEach(async () => {
  sqliteTrace.opened = 0;
  sqliteTrace.statements.length = 0;
  root = await createGuiDatabaseRoot();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeGuiDatabaseRoot(root);
});

function stubDatabase(schema?: GuiDatabaseSchema): string {
  const dbPath = writeGuiDatabase(root, schema);
  vi.stubEnv("OPENCODE_DB", dbPath);
  return dbPath;
}

describe("raw completed assistant reader", () => {
  it("returns every physical completed assistant row without fork dedup", async () => {
    stubDatabase({
      sessions: [
        { id: "ses_parent", createdMs: 1_000 },
        { id: "ses_fork", parentID: "ses_parent", createdMs: 1_100 },
      ],
      messages: [
        {
          id: "msg_original",
          sessionID: "ses_parent",
          createdMs: 1_000,
          completedMs: 1_500,
          model: { providerID: "openai", id: "gpt-5" },
          tokens: { input: 1_000, output: 500, reasoning: 10, cacheRead: 20, cacheWrite: 30 },
          cost: 10,
          agent: "build",
        },
        // A fork copy: same fingerprint, different physical row.
        {
          id: "msg_forkcopy",
          sessionID: "ses_fork",
          createdMs: 1_000,
          completedMs: 1_500,
          model: { providerID: "openai", id: "gpt-5" },
          tokens: { input: 1_000, output: 500, reasoning: 10, cacheRead: 20, cacheWrite: 30 },
          cost: 10,
        },
      ],
    });

    const rows = await readCompletedAssistantRows();

    expect(rows.map((row) => row.messageID)).toEqual(["msg_forkcopy", "msg_original"]);
    expect(rows.map((row) => row.sessionID)).toEqual(["ses_fork", "ses_parent"]);
    expect(rows.find((row) => row.messageID === "msg_original")).toEqual({
      sessionID: "ses_parent",
      messageID: "msg_original",
      createdAtMs: 1_000,
      completedAtMs: 1_500,
      tokens: { input: 1_000, output: 500, reasoning: 10, cacheRead: 20, cacheWrite: 30 },
      cost: 10,
      providerID: "openai",
      modelID: "gpt-5",
      agent: "build",
    });
  });

  it("keeps completed-only rows and never returns unfinished or non-assistant rows", async () => {
    stubDatabase({
      sessions: [{ id: "ses_one", createdMs: 1 }],
      messages: [
        { id: "msg_done", sessionID: "ses_one", createdMs: 100, completedMs: 200 },
        { id: "msg_unfinished", sessionID: "ses_one", createdMs: 300 },
        { id: "msg_user", sessionID: "ses_one", type: "user", createdMs: 400, completedMs: 500 },
        {
          id: "msg_system",
          sessionID: "ses_one",
          type: "system",
          createdMs: 600,
          completedMs: 700,
        },
      ],
    });

    const rows = await readCompletedAssistantRows();

    expect(rows.map((row) => row.messageID)).toEqual(["msg_done"]);
    expect(rows[0]?.completedAtMs).toBe(200);
  });

  it("defaults missing token categories to zero and leaves absent cost and model unset", async () => {
    stubDatabase({
      sessions: [{ id: "ses_one", createdMs: 1 }],
      messages: [{ id: "msg_bare", sessionID: "ses_one", createdMs: 5, completedMs: 6 }],
    });

    const rows = await readCompletedAssistantRows();

    expect(rows[0]?.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(rows[0]?.cost).toBeUndefined();
    expect(rows[0]?.providerID).toBeUndefined();
    expect(rows[0]?.modelID).toBeUndefined();
  });

  it("bounds rows by the inclusive completed window", async () => {
    stubDatabase({
      sessions: [{ id: "ses_one", createdMs: 1 }],
      messages: [
        { id: "msg_before", sessionID: "ses_one", createdMs: 50, completedMs: 100 },
        { id: "msg_inside", sessionID: "ses_one", createdMs: 150, completedMs: 200 },
        { id: "msg_after", sessionID: "ses_one", createdMs: 250, completedMs: 300 },
      ],
    });

    const rows = await readCompletedAssistantRows({
      completedSinceMs: 200,
      completedUntilMs: 300,
    });

    expect(rows.map((row) => row.messageID)).toEqual(["msg_inside", "msg_after"]);
  });

  it("orders rows by completion time then message id", async () => {
    stubDatabase({
      sessions: [{ id: "ses_one", createdMs: 1 }],
      messages: [
        { id: "msg_b", sessionID: "ses_one", createdMs: 10, completedMs: 200 },
        { id: "msg_c", sessionID: "ses_one", createdMs: 10, completedMs: 100 },
        { id: "msg_a", sessionID: "ses_one", createdMs: 10, completedMs: 200 },
      ],
    });

    const rows = await readCompletedAssistantRows();

    expect(rows.map((row) => row.messageID)).toEqual(["msg_c", "msg_a", "msg_b"]);
  });

  it("degrades to an empty read when the message table is absent", async () => {
    stubDatabase({
      messageTable: false,
      sessions: [{ id: "ses_one", createdMs: 1 }],
    });

    await expect(readCompletedAssistantRows()).resolves.toEqual([]);
  });
});

describe("session project metadata", () => {
  it("reads project id and directory when the columns exist", async () => {
    stubDatabase({
      sessions: [
        {
          id: "ses_root",
          title: "Root session",
          projectID: "prj_alpha",
          directory: "/repo/alpha",
          createdMs: 10,
          updatedMs: 20,
        },
        { id: "ses_child", parentID: "ses_root", createdMs: 30, updatedMs: 40 },
      ],
    });

    const index = await readAllSessionsIndex();

    expect(index.ses_root).toEqual({
      id: "ses_root",
      title: "Root session",
      parentID: undefined,
      projectID: "prj_alpha",
      directory: "/repo/alpha",
      time: { created: 10, updated: 20 },
    });
    expect(index.ses_child?.parentID).toBe("ses_root");
    expect(index.ses_child?.projectID).toBeUndefined();
    expect(index.ses_child?.directory).toBeUndefined();
  });

  it("keeps the existing session shape when the project columns are missing", async () => {
    stubDatabase({
      sessionProjectColumns: false,
      sessions: [{ id: "ses_one", title: "One", createdMs: 10, updatedMs: 20 }],
    });

    const index = await readAllSessionsIndex();

    expect(index.ses_one).toEqual({
      id: "ses_one",
      title: "One",
      parentID: undefined,
      time: { created: 10, updated: 20 },
    });
  });
});

describe("project and worktree metadata reader", () => {
  it("reads project names, directories, and git worktrees", async () => {
    stubDatabase({
      projects: [
        { id: "prj_alpha", name: "Alpha" },
        { id: "prj_beta", name: null },
      ],
      projectDirectories: [
        { projectID: "prj_alpha", directory: "/repo/alpha" },
        { projectID: "prj_beta", directory: "/repo/beta" },
      ],
      worktrees: [
        { projectID: "prj_alpha", directory: "/repo/alpha-worktree" },
        { projectID: "prj_alpha", directory: "/repo/alpha-sandbox", strategy: "sandbox" },
      ],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha).toEqual({
      id: "prj_alpha",
      name: "Alpha",
      directories: ["/repo/alpha"],
      worktrees: ["/repo/alpha-worktree"],
    });
    expect(projects.prj_beta?.name).toBeUndefined();
    expect(projects.prj_beta?.directories).toEqual(["/repo/beta"]);
  });

  it("degrades to an unknown-project index when the project tables are absent", async () => {
    stubDatabase({
      projectTables: false,
      sessions: [{ id: "ses_one", createdMs: 1 }],
    });

    await expect(readProjectsIndex()).resolves.toEqual({});
  });

  it("reads projects without a name column", async () => {
    stubDatabase({
      projectNameColumn: false,
      projects: [{ id: "prj_alpha" }],
      projectDirectories: [{ projectID: "prj_alpha", directory: "/repo/alpha" }],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha).toEqual({
      id: "prj_alpha",
      name: undefined,
      directories: ["/repo/alpha"],
      worktrees: [],
    });
  });

  it("keeps worktree rows when the strategy column is absent", async () => {
    stubDatabase({
      worktreeStrategyColumn: false,
      projects: [{ id: "prj_alpha", name: "Alpha" }],
      worktrees: [{ projectID: "prj_alpha", directory: "/repo/alpha-worktree" }],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha?.worktrees).toEqual(["/repo/alpha-worktree"]);
  });
});

describe("read-only guarantees", () => {
  it("opens through the read-only adapter and issues only SELECT or PRAGMA statements", async () => {
    stubDatabase({
      sessions: [{ id: "ses_one", projectID: "prj_alpha", createdMs: 1 }],
      messages: [
        { id: "msg_done", sessionID: "ses_one", createdMs: 100, completedMs: 200 },
        { id: "msg_compact", sessionID: "ses_one", type: "compaction", createdMs: 300 },
      ],
      projects: [{ id: "prj_alpha", name: "Alpha" }],
    });

    await readAllSessionsIndex();
    await readCompletedAssistantRows();
    await readCompactionMarkers();
    await readProjectsIndex();

    expect(sqliteTrace.opened).toBe(4);
    expect(sqliteTrace.statements.length).toBeGreaterThan(0);
    for (const statement of sqliteTrace.statements) {
      expect(statement.trim().toUpperCase()).toMatch(/^(SELECT|PRAGMA)\b/);
    }
  });

  it("returns empty results when the database file does not exist", async () => {
    vi.stubEnv("OPENCODE_DB", `${root}/missing/opencode.db`);

    await expect(readCompletedAssistantRows()).resolves.toEqual([]);
    await expect(readAllSessionsIndex()).resolves.toEqual({});
    await expect(readProjectsIndex()).resolves.toEqual({});
  });
});
