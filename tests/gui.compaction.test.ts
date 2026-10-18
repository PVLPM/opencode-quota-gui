import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  iterAssistantMessages,
  iterCompletedAssistantMessages,
  readCompactionMarkers,
  readCompletedAssistantRows,
} from "../src/lib/opencode-storage.js";
import {
  createGuiDatabaseRoot,
  removeGuiDatabaseRoot,
  writeGuiDatabase,
} from "./helpers/gui-database.js";

let root: string;

beforeEach(async () => {
  root = await createGuiDatabaseRoot();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeGuiDatabaseRoot(root);
});

describe("compaction marker reader", () => {
  it("reads compaction markers ordered by timestamp then message id", async () => {
    const dbPath = writeGuiDatabase(root, {
      sessions: [
        { id: "ses_a", createdMs: 1 },
        { id: "ses_b", createdMs: 2 },
      ],
      messages: [
        { id: "msg_late", sessionID: "ses_a", type: "compaction", createdMs: 300, seq: 4 },
        { id: "msg_early_b", sessionID: "ses_b", type: "compaction", createdMs: 100, seq: 3 },
        { id: "msg_early_a", sessionID: "ses_a", type: "compaction", createdMs: 100, seq: 2 },
        { id: "msg_assistant", sessionID: "ses_a", createdMs: 200, completedMs: 250 },
      ],
    });
    vi.stubEnv("OPENCODE_DB", dbPath);

    const markers = await readCompactionMarkers();

    expect(markers).toEqual([
      { sessionId: "ses_a", atMs: 100, messageId: "msg_early_a" },
      { sessionId: "ses_b", atMs: 100, messageId: "msg_early_b" },
      { sessionId: "ses_a", atMs: 300, messageId: "msg_late" },
    ]);
  });

  it("returns only markers, which the assistant readers cannot return", async () => {
    const dbPath = writeGuiDatabase(root, {
      sessions: [{ id: "ses_a", createdMs: 1 }],
      messages: [
        { id: "msg_done", sessionID: "ses_a", createdMs: 100, completedMs: 200 },
        { id: "msg_unfinished", sessionID: "ses_a", createdMs: 300 },
        { id: "msg_compact", sessionID: "ses_a", type: "compaction", createdMs: 400, seq: 9 },
      ],
    });
    vi.stubEnv("OPENCODE_DB", dbPath);

    const markers = await readCompactionMarkers();
    expect(markers).toEqual([{ sessionId: "ses_a", atMs: 400, messageId: "msg_compact" }]);

    const rawRows = await readCompletedAssistantRows();
    expect(rawRows.map((row) => row.messageID)).toEqual(["msg_done"]);

    const completed = await iterCompletedAssistantMessages({});
    expect(completed.map((message) => message.id)).toEqual(["msg_done"]);

    const all = await iterAssistantMessages({});
    expect(all.map((message) => message.id)).toEqual(["msg_done", "msg_unfinished"]);
  });

  it("degrades to no markers when the message table is absent", async () => {
    const dbPath = writeGuiDatabase(root, {
      messageTable: false,
      sessions: [{ id: "ses_a", createdMs: 1 }],
    });
    vi.stubEnv("OPENCODE_DB", dbPath);

    await expect(readCompactionMarkers()).resolves.toEqual([]);
  });

  it("returns no markers when the database file is missing", async () => {
    vi.stubEnv("OPENCODE_DB", `${root}/missing/opencode.db`);

    await expect(readCompactionMarkers()).resolves.toEqual([]);
  });
});
