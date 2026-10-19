import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  compareOpenCodeSourceIdentity,
  readAllSessionsIndex,
  readCompactionMarkers,
  readCompletedAssistantRows,
  readMessageRevisions,
  readOpenCodeSourceIdentity,
  readProjectsIndex,
  withOpenCodeStorageSnapshot,
} from "../src/lib/opencode-storage.js";
import {
  createGuiDatabaseRoot,
  type GuiDatabaseSchema,
  removeGuiDatabaseRoot,
  writeGuiDatabase,
} from "./helpers/gui-database.js";

interface SqliteTrace {
  opened: number;
  statements: string[];
  params: unknown[][];
}

const sqliteTrace = vi.hoisted((): SqliteTrace => ({ opened: 0, statements: [], params: [] }));

vi.mock("../src/lib/opencode-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode-sqlite.js")>();
  return {
    openOpenCodeSqliteReadOnly: async (dbPath: string) => {
      sqliteTrace.opened += 1;
      const conn = await actual.openOpenCodeSqliteReadOnly(dbPath);
      return {
        all<T = unknown>(sql: string, params?: unknown[]): T[] {
          sqliteTrace.statements.push(sql);
          sqliteTrace.params.push(params ?? []);
          return conn.all<T>(sql, params);
        },
        get<T = unknown>(sql: string, params?: unknown[]): T | null {
          sqliteTrace.statements.push(sql);
          sqliteTrace.params.push(params ?? []);
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
  sqliteTrace.params.length = 0;
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

  it("prefers the canonical project.worktree root and supports both linked strategies", async () => {
    stubDatabase({
      projects: [{ id: "prj_alpha", name: null, worktree: "/srv/canonical-root" }],
      projectDirectories: [
        { projectID: "prj_alpha", directory: "/srv/aaa-registered" },
        { projectID: "prj_alpha", directory: "/srv/canonical-root" },
      ],
      worktrees: [
        { projectID: "prj_alpha", directory: "/srv/aaa-linked", strategy: "git" },
        { projectID: "prj_alpha", directory: "/srv/zzz-linked", strategy: "git_worktree" },
        { projectID: "prj_alpha", directory: "/srv/canonical-root", strategy: null },
        { projectID: "prj_alpha", directory: "/srv/sandbox", strategy: "sandbox" },
      ],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha).toEqual({
      id: "prj_alpha",
      name: undefined,
      directories: ["/srv/canonical-root", "/srv/aaa-registered"],
      worktrees: ["/srv/aaa-linked", "/srv/zzz-linked"],
    });
  });

  it("keeps the canonical root when the project_directory table is absent", async () => {
    stubDatabase({
      projectDirectoryTable: false,
      projects: [{ id: "prj_alpha", worktree: "/srv/canonical-root" }],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha).toEqual({
      id: "prj_alpha",
      name: undefined,
      directories: ["/srv/canonical-root"],
      worktrees: [],
    });
  });

  it("degrades to registered directories when the canonical worktree column is absent", async () => {
    stubDatabase({
      projectWorktreeColumn: false,
      projects: [{ id: "prj_alpha", name: "Alpha" }],
      projectDirectories: [{ projectID: "prj_alpha", directory: "/srv/registered" }],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha).toEqual({
      id: "prj_alpha",
      name: "Alpha",
      directories: ["/srv/registered"],
      worktrees: [],
    });
  });

  it("degrades when the worktree table is absent", async () => {
    stubDatabase({
      worktreeTable: false,
      projects: [{ id: "prj_alpha", worktree: "/srv/canonical-root" }],
    });

    const projects = await readProjectsIndex();

    expect(projects.prj_alpha?.directories).toEqual(["/srv/canonical-root"]);
    expect(projects.prj_alpha?.worktrees).toEqual([]);
  });

  it("keeps the same project id while its canonical root moves", async () => {
    const dbPath = stubDatabase({
      projects: [{ id: "prj_alpha", worktree: "/srv/old-root" }],
    });
    const before = await readProjectsIndex();

    const writer = new DatabaseSync(dbPath);
    try {
      writer
        .prepare(`UPDATE "project" SET worktree = ? WHERE id = ?`)
        .run("/srv/new-root", "prj_alpha");
    } finally {
      writer.close();
    }

    const after = await readProjectsIndex();

    expect(before.prj_alpha).toMatchObject({
      id: "prj_alpha",
      directories: ["/srv/old-root"],
    });
    expect(after.prj_alpha).toMatchObject({
      id: "prj_alpha",
      directories: ["/srv/new-root"],
    });
  });
});

describe("scoped completed assistant reader", () => {
  it("scopes by sessionID, sessionIDs, and messageIDs", async () => {
    stubDatabase({
      sessions: [
        { id: "ses_a", createdMs: 1 },
        { id: "ses_b", createdMs: 1 },
      ],
      messages: [
        { id: "msg_a1", sessionID: "ses_a", createdMs: 10, completedMs: 100 },
        { id: "msg_a2", sessionID: "ses_a", createdMs: 20, completedMs: 200 },
        { id: "msg_b1", sessionID: "ses_b", createdMs: 30, completedMs: 300 },
      ],
    });

    await expect(
      readCompletedAssistantRows({ sessionID: "ses_a" }).then((rows) =>
        rows.map((row) => row.messageID),
      ),
    ).resolves.toEqual(["msg_a1", "msg_a2"]);
    await expect(
      readCompletedAssistantRows({ sessionIDs: ["ses_b"] }).then((rows) =>
        rows.map((row) => row.messageID),
      ),
    ).resolves.toEqual(["msg_b1"]);
    await expect(
      readCompletedAssistantRows({ messageIDs: ["msg_b1", "msg_a2"] }).then((rows) =>
        rows.map((row) => row.messageID),
      ),
    ).resolves.toEqual(["msg_a2", "msg_b1"]);
  });

  it("applies completion bounds together with a message scope", async () => {
    stubDatabase({
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [
        { id: "msg_early", sessionID: "ses_a", createdMs: 10, completedMs: 100 },
        { id: "msg_mid", sessionID: "ses_a", createdMs: 20, completedMs: 200 },
        { id: "msg_late", sessionID: "ses_a", createdMs: 30, completedMs: 300 },
      ],
    });

    const rows = await readCompletedAssistantRows({
      messageIDs: ["msg_early", "msg_mid", "msg_late"],
      completedSinceMs: 200,
      completedUntilMs: 300,
    });

    expect(rows.map((row) => row.messageID)).toEqual(["msg_mid", "msg_late"]);
  });

  it("treats empty message/session scopes as an empty read without opening the database", async () => {
    stubDatabase({ sessions: [{ id: "ses_a", createdMs: 1 }] });
    const opened = sqliteTrace.opened;

    await expect(readCompletedAssistantRows({ messageIDs: [] })).resolves.toEqual([]);
    await expect(readCompletedAssistantRows({ sessionIDs: [] })).resolves.toEqual([]);

    expect(sqliteTrace.opened).toBe(opened);
  });

  it("rejects mixing sessionID and sessionIDs and combines message with session scopes", async () => {
    stubDatabase({
      sessions: [
        { id: "ses_a", createdMs: 1 },
        { id: "ses_b", createdMs: 1 },
      ],
      messages: [
        { id: "msg_a1", sessionID: "ses_a", createdMs: 10, completedMs: 100 },
        { id: "msg_a2", sessionID: "ses_a", createdMs: 20, completedMs: 200 },
        { id: "msg_b1", sessionID: "ses_b", createdMs: 30, completedMs: 300 },
      ],
    });

    await expect(
      readCompletedAssistantRows({ sessionID: "ses_a", sessionIDs: ["ses_a"] }),
    ).rejects.toThrow(/sessionID/);

    // messageIDs and a session scope combine with AND semantics.
    await expect(
      readCompletedAssistantRows({
        sessionIDs: ["ses_a", "ses_b"],
        messageIDs: ["msg_a1", "msg_b1"],
      }).then((rows) => rows.map((row) => row.messageID)),
    ).resolves.toEqual(["msg_a1", "msg_b1"]);
  });

  it("chunks large message scopes under the bind bound and merges completion order", async () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `msg_${String(index).padStart(4, "0")}`,
      sessionID: "ses_a",
      createdMs: 1,
      // Reverse completion order so the merge must re-sort across chunks.
      completedMs: 10_000 - index,
    }));
    stubDatabase({ sessions: [{ id: "ses_a", createdMs: 1 }], messages });

    const rows = await readCompletedAssistantRows({
      messageIDs: messages.map((message) => message.id),
      completedSinceMs: 0,
    });

    expect(rows).toHaveLength(1_000);
    expect(rows[0]?.messageID).toBe("msg_0999");
    expect(rows[999]?.messageID).toBe("msg_0000");
    for (const params of sqliteTrace.params) {
      expect(params.length).toBeLessThanOrEqual(900);
    }
  });
});

describe("scoped compaction reader", () => {
  it("scopes markers by session and creation window", async () => {
    stubDatabase({
      sessions: [
        { id: "ses_a", createdMs: 1 },
        { id: "ses_b", createdMs: 1 },
      ],
      messages: [
        { id: "msg_c_a1", sessionID: "ses_a", type: "compaction", createdMs: 100 },
        { id: "msg_c_a2", sessionID: "ses_a", type: "compaction", createdMs: 300 },
        { id: "msg_c_b1", sessionID: "ses_b", type: "compaction", createdMs: 200 },
      ],
    });

    await expect(readCompactionMarkers({ sessionID: "ses_a" })).resolves.toEqual([
      { sessionId: "ses_a", atMs: 100, messageId: "msg_c_a1" },
      { sessionId: "ses_a", atMs: 300, messageId: "msg_c_a2" },
    ]);
    await expect(
      readCompactionMarkers({ sessionIDs: ["ses_a", "ses_b"], sinceMs: 200, untilMs: 300 }),
    ).resolves.toEqual([
      { sessionId: "ses_b", atMs: 200, messageId: "msg_c_b1" },
      { sessionId: "ses_a", atMs: 300, messageId: "msg_c_a2" },
    ]);
  });

  it("returns an empty read without opening the database for empty scopes", async () => {
    stubDatabase({ sessions: [{ id: "ses_a", createdMs: 1 }] });
    const opened = sqliteTrace.opened;

    await expect(readCompactionMarkers({ sessionIDs: [] })).resolves.toEqual([]);

    expect(sqliteTrace.opened).toBe(opened);
  });
});

describe("message revision snapshot", () => {
  it("returns every physical row identity with type, update and completion times", async () => {
    stubDatabase({
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [
        {
          id: "msg_done",
          sessionID: "ses_a",
          createdMs: 100,
          updatedMs: 150,
          completedMs: 140,
        },
        { id: "msg_open", sessionID: "ses_a", createdMs: 200, updatedMs: 210 },
        { id: "msg_user", sessionID: "ses_a", type: "user", createdMs: 300, updatedMs: 300 },
        { id: "msg_compact", sessionID: "ses_a", type: "compaction", createdMs: 400 },
      ],
    });

    const snapshot = await readMessageRevisions();

    expect(snapshot.available).toBe(true);
    expect(snapshot.updatedAtAvailable).toBe(true);
    expect(snapshot.completedAtAvailable).toBe(true);
    expect(snapshot.revisions.map((revision) => revision.messageID)).toEqual([
      "msg_compact",
      "msg_done",
      "msg_open",
      "msg_user",
    ]);
    expect(snapshot.revisions.find((revision) => revision.messageID === "msg_done")).toEqual({
      messageID: "msg_done",
      sessionID: "ses_a",
      type: "assistant",
      createdAtMs: 100,
      updatedAtMs: 150,
      completedAtMs: 140,
    });
    expect(
      snapshot.revisions.find((revision) => revision.messageID === "msg_open")?.completedAtMs,
    ).toBeNull();
  });

  it("chunks combined session and message scopes under the bind bound", async () => {
    const messages = Array.from({ length: 1_000 }, (_, index) => ({
      id: `msg_${String(index).padStart(4, "0")}`,
      sessionID: `ses_${index % 2}`,
      createdMs: 1,
      completedMs: 100 + index,
    }));
    stubDatabase({
      sessions: [
        { id: "ses_0", createdMs: 1 },
        { id: "ses_1", createdMs: 1 },
        { id: "ses_other", createdMs: 1 },
      ],
      messages,
    });

    const snapshot = await readMessageRevisions({
      sessionIDs: ["ses_0", "ses_1", "ses_other"],
      messageIDs: messages.map((message) => message.id),
    });

    expect(snapshot.revisions).toHaveLength(1_000);
    for (const params of sqliteTrace.params) {
      expect(params.length).toBeLessThanOrEqual(900);
    }
  });

  it("scopes revisions by session and message ids", async () => {
    stubDatabase({
      sessions: [
        { id: "ses_a", createdMs: 1 },
        { id: "ses_b", createdMs: 1 },
      ],
      messages: [
        { id: "msg_a", sessionID: "ses_a", createdMs: 10, completedMs: 20 },
        { id: "msg_b", sessionID: "ses_b", createdMs: 30, completedMs: 40 },
      ],
    });

    const bySession = await readMessageRevisions({ sessionID: "ses_b" });
    expect(bySession.revisions.map((revision) => revision.messageID)).toEqual(["msg_b"]);

    const byIds = await readMessageRevisions({ messageIDs: ["msg_a"] });
    expect(byIds.revisions.map((revision) => revision.messageID)).toEqual(["msg_a"]);
  });

  it("reports the time_updated column as unavailable without failing", async () => {
    stubDatabase({
      messageUpdatedColumn: false,
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_a", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });

    const snapshot = await readMessageRevisions();

    expect(snapshot).toMatchObject({ available: true, updatedAtAvailable: false });
    expect(snapshot.revisions).toHaveLength(1);
    expect(snapshot.revisions[0]).toMatchObject({
      messageID: "msg_a",
      updatedAtMs: null,
      completedAtMs: 20,
    });
  });

  it("degrades to an unavailable snapshot when the message table is absent", async () => {
    stubDatabase({
      messageTable: false,
      sessions: [{ id: "ses_a", createdMs: 1 }],
    });

    await expect(readMessageRevisions()).resolves.toMatchObject({
      available: false,
      updatedAtAvailable: false,
      revisions: [],
    });
  });

  it("returns an empty snapshot without opening the database for empty scopes", async () => {
    stubDatabase({ sessions: [{ id: "ses_a", createdMs: 1 }] });
    const opened = sqliteTrace.opened;

    await expect(readMessageRevisions({ messageIDs: [] })).resolves.toMatchObject({
      revisions: [],
    });
    await expect(readMessageRevisions({ sessionIDs: [] })).resolves.toMatchObject({
      revisions: [],
    });

    expect(sqliteTrace.opened).toBe(opened);
  });
});

describe("source identity", () => {
  it("reports stable file identity plus informational stat fields", async () => {
    const dbPath = stubDatabase({
      journalMode: "wal",
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_a", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });

    const identity = await readOpenCodeSourceIdentity();

    expect(identity).toMatchObject({ dbPath, exists: true, status: "ok" });
    expect(identity.device).toBeDefined();
    expect(identity.inode).toBeDefined();
    expect(identity.realPath).toBeTruthy();
    expect(identity.birthtimeMs).toBeGreaterThan(0);
    expect(identity.schemaToken).toContain("session_message(");
    expect(identity.sizeBytes).toBeGreaterThan(0);
    expect(identity.mtimeMs).toBeGreaterThan(0);
  });

  it("keeps the stable identity across content writes, checkpoints, and stat updates", async () => {
    const dbPath = stubDatabase({
      journalMode: "wal",
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_original", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });
    const before = await readOpenCodeSourceIdentity();

    const writer = new DatabaseSync(dbPath);
    try {
      writer
        .prepare(
          `INSERT INTO "session_message" (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "msg_added",
          "ses_a",
          "assistant",
          2,
          30,
          40,
          JSON.stringify({ time: { created: 30, completed: 40 } }),
        );
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      writer.close();
    }
    const touched = new Date(Date.now() - 60_000);
    utimesSync(dbPath, touched, touched);

    const after = await readOpenCodeSourceIdentity();

    expect(after.mtimeMs).not.toBe(before.mtimeMs);
    expect(after.device).toBe(before.device);
    expect(after.inode).toBe(before.inode);
    expect(after.schemaToken).toBe(before.schemaToken);
    expect(compareOpenCodeSourceIdentity(before, after)).toBe("same");
  });

  it("reports a changed identity when the database is replaced in place", async () => {
    const dbPath = stubDatabase({
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_a", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });
    const before = await readOpenCodeSourceIdentity();

    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    writeGuiDatabase(root, { sessions: [{ id: "ses_b", createdMs: 2 }] });

    const after = await readOpenCodeSourceIdentity();

    expect(after).toMatchObject({ dbPath, exists: true, status: "ok" });
    expect(compareOpenCodeSourceIdentity(before, after)).toBe("changed");
  });

  it("includes the readable schema layout in the identity token", async () => {
    stubDatabase({
      messageUpdatedColumn: false,
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_a", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });

    const identity = await readOpenCodeSourceIdentity();

    const sessionMessageSegment = identity.schemaToken
      ?.split("|")
      .find((segment) => segment.startsWith("session_message("));
    expect(sessionMessageSegment).toBeDefined();
    expect(sessionMessageSegment).not.toContain("time_updated");
  });

  it("distinguishes missing, unreadable, and successfully opened empty databases", async () => {
    vi.stubEnv("OPENCODE_DB", join(root, "missing", "opencode.db"));
    await expect(readOpenCodeSourceIdentity()).resolves.toMatchObject({
      status: "missing",
      exists: false,
    });

    const directoryPath = join(root, "not-a-database");
    mkdirSync(directoryPath, { recursive: true });
    vi.stubEnv("OPENCODE_DB", directoryPath);
    await expect(readOpenCodeSourceIdentity()).resolves.toMatchObject({
      status: "unreadable",
      exists: false,
    });

    stubDatabase({ sessions: [] });
    await expect(readOpenCodeSourceIdentity()).resolves.toMatchObject({
      status: "ok",
      exists: true,
    });
  });

  it("compares unavailable reads as unavailable, never as a reset", async () => {
    const dbPath = stubDatabase({ sessions: [{ id: "ses_a", createdMs: 1 }] });
    const good = await readOpenCodeSourceIdentity();

    rmSync(dbPath, { force: true });
    const missing = await readOpenCodeSourceIdentity();

    expect(compareOpenCodeSourceIdentity(good, missing)).toBe("unavailable");
  });

  it("documents identity comparison states without a stable file key", () => {
    const base = { dbPath: "/x/opencode.db", exists: true, status: "ok" as const };

    expect(compareOpenCodeSourceIdentity(undefined, base)).toBe("changed");
    expect(compareOpenCodeSourceIdentity(base, { ...base, status: "missing", exists: false })).toBe(
      "unavailable",
    );
    expect(compareOpenCodeSourceIdentity(base, { ...base })).toBe("unknown");
    expect(
      compareOpenCodeSourceIdentity({ ...base, birthtimeMs: 1 }, { ...base, birthtimeMs: 1 }),
    ).toBe("same");
    expect(
      compareOpenCodeSourceIdentity({ ...base, birthtimeMs: 1 }, { ...base, birthtimeMs: 2 }),
    ).toBe("changed");
    expect(
      compareOpenCodeSourceIdentity(
        { ...base, device: "1", inode: "2", schemaToken: "a" },
        { ...base, device: "1", inode: "2", schemaToken: "a" },
      ),
    ).toBe("same");
    expect(
      compareOpenCodeSourceIdentity(
        { ...base, device: "1", inode: "2", schemaToken: "a" },
        { ...base, device: "1", inode: "2", schemaToken: "b" },
      ),
    ).toBe("changed");
  });

  it("treats a file that is not a database as unreadable, not empty", async () => {
    const corruptPath = join(root, "corrupt.db");
    writeFileSync(corruptPath, "not a sqlite database");
    vi.stubEnv("OPENCODE_DB", corruptPath);

    await expect(readOpenCodeSourceIdentity()).resolves.toMatchObject({
      status: "unreadable",
      exists: true,
    });
    await expect(withOpenCodeStorageSnapshot(() => "never")).resolves.toEqual({
      status: "unreadable",
    });
  });
});

describe("consistent storage snapshot", () => {
  it("returns explicit missing/ok results for missing and successfully opened empty databases", async () => {
    vi.stubEnv("OPENCODE_DB", join(root, "missing", "opencode.db"));
    await expect(withOpenCodeStorageSnapshot(() => "never")).resolves.toEqual({
      status: "missing",
    });

    const directoryPath = join(root, "not-a-database");
    mkdirSync(directoryPath, { recursive: true });
    vi.stubEnv("OPENCODE_DB", directoryPath);
    await expect(withOpenCodeStorageSnapshot(() => "never")).resolves.toEqual({
      status: "unreadable",
    });

    stubDatabase({ sessions: [] });
    const empty = await withOpenCodeStorageSnapshot((snapshot) => ({
      sessions: snapshot.readAllSessionsIndex(),
      revisions: snapshot.readMessageRevisions(),
      compactions: snapshot.readCompactionMarkers(),
      rows: snapshot.readCompletedAssistantRows(),
      identityStatus: snapshot.identity.status,
    }));

    expect(empty.status).toBe("ok");
    if (empty.status !== "ok") return;
    expect(empty.value.sessions).toEqual({});
    expect(empty.value.revisions).toMatchObject({ available: true, revisions: [] });
    expect(empty.value.compactions).toEqual([]);
    expect(empty.value.rows).toEqual([]);
    expect(empty.value.identityStatus).toBe("ok");
  });

  it("serves one consistent snapshot while another connection commits (WAL)", async () => {
    const dbPath = stubDatabase({
      journalMode: "wal",
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_original", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });

    const result = await withOpenCodeStorageSnapshot((snapshot) => {
      const before = snapshot.readMessageRevisions();
      const beforeRows = snapshot.readCompletedAssistantRows();

      const writer = new DatabaseSync(dbPath);
      try {
        writer.exec("PRAGMA journal_mode=WAL;");
        writer
          .prepare(
            `INSERT INTO "session_message" (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "msg_concurrent",
            "ses_a",
            "assistant",
            2,
            30,
            40,
            JSON.stringify({ time: { created: 30, completed: 40 } }),
          );
      } finally {
        writer.close();
      }

      const after = snapshot.readMessageRevisions();
      const afterRows = snapshot.readCompletedAssistantRows();
      return { before, beforeRows, after, afterRows };
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const { before, beforeRows, after, afterRows } = result.value;
    // The transaction pins every read: the concurrently committed row never
    // appears in membership or payload reads made inside this snapshot.
    expect(before.revisions.map((revision) => revision.messageID)).toEqual(["msg_original"]);
    expect(after.revisions.map((revision) => revision.messageID)).toEqual(["msg_original"]);
    expect(beforeRows.map((row) => row.messageID)).toEqual(["msg_original"]);
    expect(afterRows.map((row) => row.messageID)).toEqual(["msg_original"]);

    // Outside the snapshot, the committed row is visible.
    await expect(readMessageRevisions()).resolves.toMatchObject({
      revisions: [{ messageID: "msg_concurrent" }, { messageID: "msg_original" }],
    });
  });

  it("detects completion transitions and deletions, then fetches only changed payloads", async () => {
    const dbPath = stubDatabase({
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [
        { id: "msg_open", sessionID: "ses_a", createdMs: 100 },
        { id: "msg_gone", sessionID: "ses_a", createdMs: 200, completedMs: 210 },
      ],
    });

    const before = await readMessageRevisions();
    expect(before.revisions.map((revision) => revision.messageID)).toEqual([
      "msg_gone",
      "msg_open",
    ]);
    expect(
      before.revisions.find((revision) => revision.messageID === "msg_open")?.completedAtMs,
    ).toBeNull();

    const writer = new DatabaseSync(dbPath);
    try {
      writer
        .prepare(`UPDATE "session_message" SET time_updated = ?, data = ? WHERE id = ?`)
        .run(150, JSON.stringify({ time: { created: 100, completed: 120 } }), "msg_open");
      writer.prepare(`DELETE FROM "session_message" WHERE id = ?`).run("msg_gone");
    } finally {
      writer.close();
    }

    const after = await readMessageRevisions();
    expect(after.revisions.map((revision) => revision.messageID)).toEqual(["msg_open"]);
    const transitioned = after.revisions.find((revision) => revision.messageID === "msg_open");
    expect(transitioned?.completedAtMs).toBe(120);
    expect(transitioned?.updatedAtMs).toBe(150);

    const beforeIds = new Set(before.revisions.map((revision) => revision.messageID));
    const afterIds = new Set(after.revisions.map((revision) => revision.messageID));
    expect([...beforeIds].filter((id) => !afterIds.has(id))).toEqual(["msg_gone"]);

    const changedRows = await readCompletedAssistantRows({ messageIDs: ["msg_open"] });
    expect(changedRows.map((row) => row.messageID)).toEqual(["msg_open"]);
    expect(changedRows[0]?.completedAtMs).toBe(120);
  });

  it("supports the absent time_updated fallback inside a snapshot", async () => {
    stubDatabase({
      messageUpdatedColumn: false,
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [{ id: "msg_a", sessionID: "ses_a", createdMs: 10, completedMs: 20 }],
    });

    const result = await withOpenCodeStorageSnapshot((snapshot) => ({
      revisions: snapshot.readMessageRevisions(),
      rows: snapshot.readCompletedAssistantRows({ messageIDs: ["msg_a"] }),
    }));

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.value.revisions).toMatchObject({
      available: true,
      updatedAtAvailable: false,
    });
    expect(result.value.revisions.revisions[0]).toMatchObject({
      messageID: "msg_a",
      updatedAtMs: null,
      completedAtMs: 20,
    });
    expect(result.value.rows.map((row) => row.messageID)).toEqual(["msg_a"]);
  });

  it("propagates callback errors after rollback and keeps later reads usable", async () => {
    stubDatabase({ sessions: [{ id: "ses_a", createdMs: 1 }] });

    await expect(
      withOpenCodeStorageSnapshot(() => {
        throw new Error("snapshot-callback-boom");
      }),
    ).rejects.toThrow("snapshot-callback-boom");

    expect(Object.keys(await readAllSessionsIndex())).toEqual(["ses_a"]);
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
