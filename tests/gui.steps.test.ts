import { describe, expect, it } from "vitest";

/**
 * P3 analytics lane — step semantics (spec §6, R26–R27, R31).
 *
 * One step = one completed assistant message row; tool calls and stream chunks
 * are not stored as rows and therefore never steps; compaction rows are markers.
 */
import {
  createUsageAnalytics,
  STEP_SEMANTICS,
  type UsageAnalyticsDataset,
} from "../src/gui/aggregation.js";
import type {
  OpenCodeCompactionMarker,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";

const HOUR_MS = 3_600_000;
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0);

type RawTokenCounts = OpenCodeRawAssistantRow["tokens"];

function assistantRow(
  sessionID: string,
  messageID: string,
  createdAtMs: number,
  completedAtMs: number,
  tokens: Partial<RawTokenCounts> = {},
  opts: { providerID?: string; modelID?: string; agent?: string } = {},
): OpenCodeRawAssistantRow {
  const row: OpenCodeRawAssistantRow = {
    sessionID,
    messageID,
    createdAtMs,
    completedAtMs,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
  };
  if (opts.providerID !== undefined) row.providerID = opts.providerID;
  if (opts.modelID !== undefined) row.modelID = opts.modelID;
  if (opts.agent !== undefined) row.agent = opts.agent;
  return row;
}

function sessionInfo(opts: {
  id: string;
  title?: string;
  parentID?: string;
  projectID?: string;
  createdMs?: number;
}): OpenCodeSessionInfo {
  return {
    id: opts.id,
    title: opts.title,
    parentID: opts.parentID,
    projectID: opts.projectID,
    time: { created: opts.createdMs, updated: opts.createdMs },
  };
}

function makeDataset(parts: {
  sessions?: OpenCodeSessionInfo[];
  projects?: OpenCodeProjectInfo[];
  messages?: OpenCodeRawAssistantRow[];
  compactions?: OpenCodeCompactionMarker[];
}): UsageAnalyticsDataset {
  const sessions: Record<string, OpenCodeSessionInfo> = {};
  for (const session of parts.sessions ?? []) sessions[session.id] = session;
  const projects: Record<string, OpenCodeProjectInfo> = {};
  for (const project of parts.projects ?? []) projects[project.id] = project;
  return {
    sessions,
    projects,
    messages: parts.messages ?? [],
    compactions: parts.compactions ?? [],
  };
}

describe("step semantics", () => {
  it("preserves the raw five categories with context and total formulas per step", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_f", title: "F", createdMs: NOW - 10 * HOUR_MS })],
      messages: [
        assistantRow(
          "ses_f",
          "msg_1",
          NOW - 2 * HOUR_MS,
          NOW - HOUR_MS,
          { input: 100, cacheRead: 20, cacheWrite: 30, output: 40, reasoning: 5 },
          { providerID: "openai", modelID: "gpt-5", agent: "build" },
        ),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    expect(snapshot.steps).toHaveLength(1);
    const step = snapshot.steps[0]!;
    expect(step).toMatchObject({
      sessionId: "ses_f",
      messageId: "msg_1",
      // Steps count at their start time, not their completion time.
      atMs: NOW - 2 * HOUR_MS,
      branch: 0,
      stack: { input: 100, cacheRead: 20, cacheWrite: 30, output: 40, reasoning: 5 },
      contextTokens: 150,
      totalTokens: 195,
      model: { providerId: "openai", modelId: "gpt-5" },
      agent: "build",
    });
    expect(snapshot.ownSummary).toMatchObject({
      input: 100,
      cacheRead: 20,
      cacheWrite: 30,
      output: 40,
      reasoning: 5,
      total: 195,
      stepCount: 1,
    });
    expect(snapshot.stepSemantics).toContain("completed assistant");
    expect(snapshot.stepSemantics).toContain("input + cacheRead + cacheWrite");
  });

  it("excludes unfinished rows until they complete, and compaction rows are never steps", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_f", title: "F", createdMs: NOW - 10 * HOUR_MS })],
      messages: [
        assistantRow("ses_f", "msg_done", NOW - 2 * HOUR_MS, NOW - HOUR_MS, { input: 10 }),
        assistantRow("ses_f", "msg_unfinished", NOW - HOUR_MS, 0, { input: 1_000 }),
      ],
      compactions: [{ sessionId: "ses_f", atMs: NOW - 90 * 60_000, messageId: "msg_compacted" }],
    });
    const analytics = createUsageAnalytics(dataset);

    const snapshot = analytics.session("ses_f");
    expect(snapshot.steps.map((step) => step.messageId)).toEqual(["msg_done"]);
    expect(snapshot.treeTotals.input).toBe(10);
    expect(snapshot.ownSummary.stepCount).toBe(1);
    expect(snapshot.compactionMarkers).toEqual([
      { sessionId: "ses_f", atMs: NOW - 90 * 60_000, messageId: "msg_compacted" },
    ]);

    // The unfinished row is excluded from the global aggregates too.
    const home = analytics.home("24h", NOW);
    expect(home.usage.stepCount).toBe(1);
    expect(home.usage.totals.input).toBe(10);
  });

  it("orders steps chronologically across the tree and numbers branches per session", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_f", title: "F", createdMs: NOW - 10 * HOUR_MS }),
        sessionInfo({ id: "ses_c", title: "C", parentID: "ses_f", createdMs: NOW - 9 * HOUR_MS }),
        sessionInfo({ id: "ses_g", title: "G", parentID: "ses_c", createdMs: NOW - 8 * HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_f", "msg_f", NOW - HOUR_MS, NOW - HOUR_MS + 100, { input: 1 }),
        assistantRow("ses_c", "msg_c", NOW - 3 * HOUR_MS, NOW - 3 * HOUR_MS + 100, { input: 2 }),
        assistantRow("ses_g", "msg_g", NOW - 2 * HOUR_MS, NOW - 2 * HOUR_MS + 100, { input: 3 }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    expect(snapshot.steps.map((step) => [step.messageId, step.branch])).toEqual([
      ["msg_c", 1],
      ["msg_g", 2],
      ["msg_f", 0],
    ]);
    // Branch numbers separate context lines: focus is 0, DFS descendants follow.
    expect(new Set(snapshot.steps.map((step) => step.branch))).toEqual(new Set([0, 1, 2]));
  });

  it("plots only owned steps and attributes a copied row to its owning session", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_p", title: "P", createdMs: NOW - 10 * HOUR_MS }),
        sessionInfo({ id: "ses_c", title: "C", parentID: "ses_p", createdMs: NOW - 9 * HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_p", "msg_a_original", NOW - 2 * HOUR_MS, NOW - HOUR_MS, { input: 6 }),
        // Same fingerprint as msg_a_original, physically stored in the child.
        assistantRow("ses_c", "msg_z_copy", NOW - 2 * HOUR_MS, NOW - HOUR_MS, { input: 6 }),
        assistantRow("ses_c", "msg_child_new", NOW - 30 * 60_000, NOW - 20 * 60_000, {
          input: 2,
        }),
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_p");
    expect(snapshot.steps.map((step) => [step.messageId, step.branch])).toEqual([
      ["msg_a_original", 0],
      ["msg_child_new", 1],
    ]);
    expect(snapshot.ownSummary.stepCount).toBe(1);
    expect(snapshot.treeTotals.input).toBe(8);
    expect(snapshot.stepSemantics).toContain("fork copies are counted once");
  });

  it("keeps compaction markers separate and ordered by timestamp then message id", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_f", title: "F", createdMs: NOW - 10 * HOUR_MS }),
        sessionInfo({ id: "ses_c", title: "C", parentID: "ses_f", createdMs: NOW - 9 * HOUR_MS }),
        sessionInfo({ id: "ses_out", title: "Out", createdMs: NOW - 10 * HOUR_MS }),
      ],
      messages: [assistantRow("ses_f", "msg_f", NOW - HOUR_MS, NOW - HOUR_MS + 100, { input: 1 })],
      compactions: [
        { sessionId: "ses_f", atMs: 200, messageId: "msg_z" },
        { sessionId: "ses_f", atMs: 200, messageId: "msg_a" },
        { sessionId: "ses_c", atMs: 150, messageId: "msg_c" },
        { sessionId: "ses_out", atMs: 10, messageId: "msg_x" },
      ],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    expect(snapshot.compactionMarkers).toEqual([
      { sessionId: "ses_c", atMs: 150, messageId: "msg_c" },
      { sessionId: "ses_f", atMs: 200, messageId: "msg_a" },
      { sessionId: "ses_f", atMs: 200, messageId: "msg_z" },
    ]);
    expect(snapshot.steps.map((step) => step.messageId)).toEqual(["msg_f"]);
  });

  it("keeps zero-token steps and their formulas explicit", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_f", title: "F", createdMs: NOW - 10 * HOUR_MS })],
      messages: [assistantRow("ses_f", "msg_empty", NOW - HOUR_MS, NOW - HOUR_MS + 100)],
    });

    const snapshot = createUsageAnalytics(dataset).session("ses_f");
    expect(snapshot.steps[0]).toMatchObject({
      stack: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      contextTokens: 0,
      totalTokens: 0,
    });
    expect(snapshot.steps[0]).not.toHaveProperty("model");
    expect(snapshot.steps[0]).not.toHaveProperty("agent");
    expect(snapshot.stepSemantics).toBe(STEP_SEMANTICS);
    expect(snapshot.stepSemantics).toContain("Tool calls and stream chunks are not steps");
  });
});
