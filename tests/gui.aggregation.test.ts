import { describe, expect, it, vi } from "vitest";

/**
 * P3 analytics lane — home usage (spec §6, R29–R31, R48, R50).
 *
 * All fixtures are synthetic. Pricing runs against the bundled models.dev
 * snapshot, except one narrow delegated override that lets an unpriced
 * (mapped key without rates) model be classified, which the bundled snapshot
 * cannot express.
 */
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>();
  const FAKE_PROVIDER = "unpriced-labs";
  const FAKE_MODEL = "mystery-1";
  const PARTIAL_PROVIDER = "partial-labs";
  const PARTIAL_MODEL = "input-only";
  const FREE_PROVIDER = "free-labs";
  const FREE_MODEL = "zero-cost";
  return {
    ...actual,
    hasCost: (providerID: string, modelID: string) =>
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      (providerID === FREE_PROVIDER && modelID === FREE_MODEL) ||
      actual.hasCost(providerID, modelID),
    hasProvider: (providerID: string) =>
      providerID === FAKE_PROVIDER ||
      providerID === PARTIAL_PROVIDER ||
      providerID === FREE_PROVIDER ||
      actual.hasProvider(providerID),
    isModelsDevProviderId: (providerID: string) =>
      providerID === FAKE_PROVIDER ||
      providerID === PARTIAL_PROVIDER ||
      providerID === FREE_PROVIDER ||
      actual.isModelsDevProviderId(providerID),
    hasModel: (providerID: string, modelID: string) =>
      (providerID === FAKE_PROVIDER && modelID === FAKE_MODEL) ||
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      (providerID === FREE_PROVIDER && modelID === FREE_MODEL) ||
      actual.hasModel(providerID, modelID),
    lookupCost: (providerID: string, modelID: string) => {
      if (providerID === FAKE_PROVIDER) return null;
      if (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) return { input: 2 };
      if (providerID === FREE_PROVIDER && modelID === FREE_MODEL) return { input: 0, output: 0 };
      return actual.lookupCost(providerID, modelID);
    },
  };
});

import type { CostedTokens, ProjectActivityRow } from "../src/contracts/dashboard.js";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import type {
  OpenCodeCompactionMarker,
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";
import { formatCostText, isAuthoritativelyFree } from "../src/ui/model-analytics.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 0, 5, 12, 0, 0); // 2026-01-05T12:00:00Z, UTC-hour aligned

type RawTokenCounts = OpenCodeRawAssistantRow["tokens"];

function assistantRow(
  sessionID: string,
  messageID: string,
  createdAtMs: number,
  completedAtMs: number,
  tokens: Partial<RawTokenCounts> = {},
  opts: { providerID?: string; modelID?: string; cost?: number; agent?: string } = {},
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
  if (opts.cost !== undefined) row.cost = opts.cost;
  if (opts.agent !== undefined) row.agent = opts.agent;
  return row;
}

function sessionInfo(opts: {
  id: string;
  title?: string;
  parentID?: string;
  projectID?: string;
  directory?: string;
  createdMs?: number;
  updatedMs?: number;
}): OpenCodeSessionInfo {
  return {
    id: opts.id,
    title: opts.title,
    parentID: opts.parentID,
    projectID: opts.projectID,
    directory: opts.directory,
    time: { created: opts.createdMs, updated: opts.updatedMs ?? opts.createdMs },
  };
}

function projectInfo(
  id: string,
  opts: { name?: string; directories?: string[]; worktrees?: string[] } = {},
): OpenCodeProjectInfo {
  return {
    id,
    name: opts.name,
    directories: opts.directories ?? [],
    worktrees: opts.worktrees ?? [],
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

function zeroCosted(): CostedTokens {
  return {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function sumCosted(rows: readonly CostedTokens[]): CostedTokens {
  const out = zeroCosted();
  for (const row of rows) {
    out.input += row.input;
    out.cacheRead += row.cacheRead;
    out.cacheWrite += row.cacheWrite;
    out.output += row.output;
    out.reasoning += row.reasoning;
    out.total += row.total;
    if (row.apiEquivalentCostUsd !== null) {
      out.apiEquivalentCostUsd = (out.apiEquivalentCostUsd ?? 0) + row.apiEquivalentCostUsd;
    }
    out.unpricedTokens += row.unpricedTokens;
    out.unknownTokens += row.unknownTokens;
  }
  return out;
}

describe("home usage over ranges", () => {
  it("clips the 24h window to exact half-open boundaries and zero-fills every hourly bucket", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 3 * DAY_MS })],
      projects: [projectInfo("proj_p", { name: "P" })],
      messages: [
        assistantRow("ses_s", "msg_in", NOW - HOUR_MS, NOW - HOUR_MS + 1_000, { input: 10 }),
        assistantRow("ses_s", "msg_first", NOW - DAY_MS, NOW - DAY_MS + 500, { input: 1 }),
        assistantRow("ses_s", "msg_before", NOW - DAY_MS - 1, NOW - DAY_MS - 1, { input: 100 }),
        assistantRow("ses_s", "msg_now", NOW, NOW + 10, { input: 1_000 }),
      ],
    });

    const { usage, projects } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.range).toBe("24h");
    expect(usage.window).toEqual({ sinceMs: NOW - DAY_MS, untilMs: NOW });
    expect(usage.bucketUnit).toBe("hour");
    expect(usage.buckets).toHaveLength(24);
    expect(usage.buckets[0]).toMatchObject({
      startMs: NOW - DAY_MS,
      endMs: NOW - DAY_MS + HOUR_MS,
    });
    expect(usage.buckets[23]).toMatchObject({ startMs: NOW - HOUR_MS, endMs: NOW });
    // Completion-time boundaries: the step at `since` is inside; steps completed
    // before `since` or at/after `now` are outside.
    expect(usage.stepCount).toBe(2);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totals.input).toBe(11);
    expect(usage.buckets[0]?.tokens.input).toBe(1);
    expect(usage.buckets[23]?.tokens.input).toBe(10);
    expect(usage.buckets[5]?.tokens.total).toBe(0);
    expect(usage.buckets.reduce((sum, bucket) => sum + bucket.tokens.input, 0)).toBe(
      usage.totals.input,
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      projectId: "proj_p",
      name: "P",
      rootSessionCount: 1,
      latestActivityAtMs: NOW - HOUR_MS + 1_000,
    });
    expect(projects[0]?.tokens.input).toBe(11);
  });

  it("counts a step in the window containing its completion time, not its creation time", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 3 * DAY_MS })],
      messages: [
        // Created before the 24h window, completed inside it: counted.
        assistantRow("ses_s", "msg_cross", NOW - DAY_MS - 60_000, NOW - DAY_MS + 1_000, {
          input: 10,
        }),
        // Created inside the window, completed after `now`: not counted yet.
        assistantRow("ses_s", "msg_after", NOW - HOUR_MS, NOW + 1_000, { input: 1_000 }),
      ],
    });

    const { usage, projects } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.stepCount).toBe(1);
    expect(usage.totals.input).toBe(10);
    expect(usage.buckets[0]?.tokens.input).toBe(10);
    expect(projects[0]?.latestActivityAtMs).toBe(NOW - DAY_MS + 1_000);
  });

  it("renders 7d as 8 clipped daily buckets and 30d as 31 when now is not UTC midnight", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 40 * DAY_MS })],
      messages: [assistantRow("ses_s", "msg_a", NOW - DAY_MS, NOW - DAY_MS + 1_000, { input: 5 })],
    });

    const seven = createUsageAnalytics(dataset).home("7d", NOW);
    expect(seven.usage.bucketUnit).toBe("day");
    expect(seven.usage.buckets).toHaveLength(8);
    expect(seven.usage.buckets[0]).toMatchObject({
      startMs: NOW - 7 * DAY_MS,
      endMs: Date.UTC(2025, 11, 30),
    });
    expect(seven.usage.buckets[7]).toMatchObject({ startMs: Date.UTC(2026, 0, 5), endMs: NOW });
    expect(seven.usage.buckets[6]?.tokens.input).toBe(5);
    expect(seven.usage.buckets[3]?.tokens.total).toBe(0);

    const thirty = createUsageAnalytics(dataset).home("30d", NOW);
    expect(thirty.usage.buckets).toHaveLength(31);
    expect(thirty.usage.buckets[0]?.startMs).toBe(NOW - 30 * DAY_MS);
    expect(thirty.usage.buckets[30]).toMatchObject({ startMs: Date.UTC(2026, 0, 5), endMs: NOW });
  });

  it("spans lifetime from the earliest activity with daily buckets and no fixed cap", () => {
    const jan1 = Date.UTC(2026, 0, 1);
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: jan1 })],
      messages: [
        assistantRow("ses_s", "msg_1", jan1 + 10 * HOUR_MS, jan1 + 10 * HOUR_MS + 1_000, {
          input: 5,
        }),
        assistantRow("ses_s", "msg_2", Date.UTC(2026, 0, 3), Date.UTC(2026, 0, 3) + 1_000, {
          input: 7,
        }),
        assistantRow("ses_s", "msg_3", Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 5) + 1_000, {
          input: 9,
        }),
      ],
    });

    const { usage } = createUsageAnalytics(dataset).home("lifetime", NOW);

    expect(usage.window).toEqual({ untilMs: NOW });
    expect(usage.bucketUnit).toBe("day");
    expect(usage.buckets).toHaveLength(5);
    expect(usage.buckets[0]).toMatchObject({
      startMs: jan1,
      endMs: Date.UTC(2026, 0, 2),
    });
    expect(usage.buckets[4]).toMatchObject({ startMs: Date.UTC(2026, 0, 5), endMs: NOW });
    expect(usage.buckets[0]?.tokens.input).toBe(5);
    expect(usage.buckets[1]?.tokens.total).toBe(0);
    expect(usage.buckets[2]?.tokens.input).toBe(7);
    expect(usage.buckets[4]?.tokens.input).toBe(9);
    expect(usage.totals.input).toBe(21);
    expect(usage.stepCount).toBe(3);
  });

  it("returns an explicit zero snapshot for an empty dataset and one current-day lifetime bucket", () => {
    const analytics = createUsageAnalytics({
      sessions: {},
      projects: {},
      messages: [],
      compactions: [],
    });

    const lifetime = analytics.home("lifetime", NOW);
    expect(lifetime.usage.buckets).toHaveLength(1);
    expect(lifetime.usage.buckets[0]).toEqual({
      startMs: Date.UTC(2026, 0, 5),
      endMs: NOW,
      tokens: zeroCosted(),
    });
    expect(lifetime.usage.totals).toEqual(zeroCosted());
    expect(lifetime.usage.stepCount).toBe(0);
    expect(lifetime.usage.sessionCount).toBe(0);
    expect(lifetime.usage.stale).toBe(false);
    expect(lifetime.projects).toEqual([]);

    const day = analytics.home("24h", NOW);
    expect(day.usage.buckets).toHaveLength(24);
    expect(day.usage.buckets.every((bucket) => bucket.tokens.total === 0)).toBe(true);
    expect(day.projects).toEqual([]);
  });
});

describe("home usage token accounting and pricing", () => {
  it("preserves all five additive categories and computes API-equivalent cost with existing pricing", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS })],
      messages: [
        assistantRow(
          "ses_s",
          "msg_priced",
          NOW - HOUR_MS,
          NOW - HOUR_MS + 500,
          { input: 1_000, output: 100, reasoning: 50, cacheRead: 2_000, cacheWrite: 0 },
          { providerID: "openai", modelID: "gpt-5" },
        ),
      ],
    });

    const { usage } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.totals.input).toBe(1_000);
    expect(usage.totals.cacheRead).toBe(2_000);
    expect(usage.totals.cacheWrite).toBe(0);
    expect(usage.totals.output).toBe(100);
    expect(usage.totals.reasoning).toBe(50);
    expect(usage.totals.total).toBe(3_150);
    // gpt-5 bundled rates: input 1.25/M, output 10/M, cache_read 0.125/M; reasoning falls back to output.
    expect(usage.totals.apiEquivalentCostUsd).toBeCloseTo(0.003, 10);
    expect(usage.totals.unpricedTokens).toBe(0);
    expect(usage.totals.unknownTokens).toBe(0);
    expect(usage.buckets[23]?.tokens).toEqual(usage.totals);
  });

  it("reports unknown-priced tokens transparently without inventing a cost", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS })],
      messages: [
        assistantRow(
          "ses_s",
          "msg_unknown",
          NOW - HOUR_MS,
          NOW - HOUR_MS + 500,
          { input: 500, output: 100 },
          { providerID: "phantom-labs", modelID: "ghost-9" },
        ),
        assistantRow(
          "ses_s",
          "msg_priced",
          NOW - 2 * HOUR_MS,
          NOW - 2 * HOUR_MS + 500,
          { input: 1_000 },
          { providerID: "openai", modelID: "gpt-5" },
        ),
      ],
    });

    const { usage } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.totals.total).toBe(1_600);
    expect(usage.totals.unknownTokens).toBe(600);
    expect(usage.totals.unpricedTokens).toBe(0);
    expect(usage.totals.apiEquivalentCostUsd).toBeCloseTo(0.00125, 10);
  });

  it("classifies mapped-but-unpriced models as unpriced tokens", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS })],
      messages: [
        assistantRow(
          "ses_s",
          "msg_unpriced",
          NOW - HOUR_MS,
          NOW - HOUR_MS + 500,
          { input: 700, output: 300 },
          { providerID: "unpriced-labs", modelID: "mystery-1" },
        ),
      ],
    });

    const { usage } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.totals.total).toBe(1_000);
    expect(usage.totals.unpricedTokens).toBe(1_000);
    expect(usage.totals.unknownTokens).toBe(0);
    expect(usage.totals.apiEquivalentCostUsd).toBeNull();
    expect(isAuthoritativelyFree(usage.totals)).toBe(false);
    expect(formatCostText(usage.totals)).toBe("Unpriced");
  });

  it("keeps the known cost of a partially priced row and marks it partial", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS })],
      messages: [
        assistantRow(
          "ses_s",
          "msg_partial",
          NOW - HOUR_MS,
          NOW - HOUR_MS + 500,
          { input: 1_000_000, output: 500_000 },
          { providerID: "partial-labs", modelID: "input-only" },
        ),
      ],
    });

    const { usage } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.totals.total).toBe(1_500_000);
    expect(usage.totals.apiEquivalentCostUsd).toBe(2);
    expect(usage.totals.unpricedTokens).toBe(500_000);
    expect(usage.totals.unknownTokens).toBe(0);
    expect(isAuthoritativelyFree(usage.totals)).toBe(false);
    expect(formatCostText(usage.totals)).not.toBe("Free");
  });

  it("keeps explicit zero rates authoritatively free", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS })],
      messages: [
        assistantRow(
          "ses_s",
          "msg_free",
          NOW - HOUR_MS,
          NOW - HOUR_MS + 500,
          { input: 1_000_000, output: 1_000_000 },
          { providerID: "free-labs", modelID: "zero-cost" },
        ),
      ],
    });

    const { usage } = createUsageAnalytics(dataset).home("24h", NOW);

    expect(usage.totals.total).toBe(2_000_000);
    expect(usage.totals.apiEquivalentCostUsd).toBe(0);
    expect(usage.totals.unpricedTokens).toBe(0);
    expect(usage.totals.unknownTokens).toBe(0);
    expect(isAuthoritativelyFree(usage.totals)).toBe(true);
    expect(formatCostText(usage.totals)).toBe("Free");
  });

  it("shows the retired union-alpha routes as Free from positive usage", () => {
    for (const providerID of ["opencode", "opencode-go"] as const) {
      const dataset = makeDataset({
        sessions: [
          sessionInfo({
            id: `ses_${providerID}`,
            projectID: "proj_p",
            createdMs: NOW - 2 * HOUR_MS,
          }),
        ],
        messages: [
          assistantRow(
            `ses_${providerID}`,
            `msg_${providerID}`,
            NOW - HOUR_MS,
            NOW - HOUR_MS + 500,
            { input: 10, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50 },
            { providerID, modelID: "union-alpha" },
          ),
        ],
      });

      const { usage } = createUsageAnalytics(dataset).home("24h", NOW);

      expect(usage.totals.total).toBe(150);
      expect(usage.totals.apiEquivalentCostUsd).toBe(0);
      expect(usage.totals.unpricedTokens).toBe(0);
      expect(usage.totals.unknownTokens).toBe(0);
      expect(isAuthoritativelyFree(usage.totals)).toBe(true);
      expect(formatCostText(usage.totals)).toBe("Free");
    }
  });
});

describe("deterministic owner set (R50)", () => {
  it("preserves fingerprint multiplicity: a fingerprint repeated k times in one session contributes k owned rows", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_a", projectID: "proj_p", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_b", projectID: "proj_q", createdMs: NOW - 2 * HOUR_MS }),
      ],
      messages: [
        // One fingerprint, two occurrences in ses_a and one in ses_b.
        assistantRow("ses_a", "msg_a1", NOW - 3_000, NOW - 2_000, { input: 1 }),
        assistantRow("ses_a", "msg_a2", NOW - 3_000, NOW - 2_000, { input: 1 }),
        assistantRow("ses_b", "msg_b1", NOW - 3_000, NOW - 2_000, { input: 1 }),
      ],
    });

    const { usage, projects } = createUsageAnalytics(dataset).home("24h", NOW);

    // Occurrence index 0 and 1 both resolve to ses_a (message-id tie-break), so only one session owns rows.
    expect(usage.stepCount).toBe(2);
    expect(usage.sessionCount).toBe(1);
    expect(usage.totals.input).toBe(2);
    const byId = new Map(projects.map((row) => [row.projectId, row]));
    expect(byId.get("proj_p")?.tokens.total).toBe(2);
    // ses_b is active but owns no occurrence: visible with zero tokens (activity is not a token quantity).
    expect(byId.get("proj_q")?.tokens.total).toBe(0);
  });

  it("picks the earliest candidate across sessions: created, then message id, then session id", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_pa", projectID: "proj_a", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_pb", projectID: "proj_b", createdMs: NOW - 2 * HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_pa", "msg_aa", NOW - 5_000, NOW - 4_000, { input: 5 }),
        assistantRow("ses_pb", "msg_bb", NOW - 5_000, NOW - 4_000, { input: 5 }),
      ],
    });

    const { usage, projects } = createUsageAnalytics(dataset).home("24h", NOW);
    expect(usage.stepCount).toBe(1);
    expect(usage.totals.input).toBe(5);
    const byId = new Map(projects.map((row) => [row.projectId, row]));
    expect(byId.get("proj_a")?.tokens.input).toBe(5);
    expect(byId.get("proj_b")?.tokens.input).toBe(0);
  });

  it("gives the cross-project fork copy to the earlier message id and never doubles it", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_pa", projectID: "proj_a", createdMs: NOW - 2 * HOUR_MS }),
        sessionInfo({ id: "ses_pb", projectID: "proj_b", createdMs: NOW - 2 * HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_pa", "msg_zz", NOW - 5_000, NOW - 4_000, { input: 5 }),
        assistantRow("ses_pb", "msg_aa", NOW - 5_000, NOW - 4_000, { input: 5 }),
      ],
    });

    const { usage, projects } = createUsageAnalytics(dataset).home("24h", NOW);
    expect(usage.stepCount).toBe(1);
    const byId = new Map(projects.map((row) => [row.projectId, row]));
    expect(byId.get("proj_a")?.tokens.input).toBe(0);
    expect(byId.get("proj_b")?.tokens.input).toBe(5);
  });

  it("is independent of raw read order", () => {
    const parts = {
      sessions: [
        sessionInfo({ id: "ses_s1", projectID: "proj_p1", createdMs: NOW - 3 * HOUR_MS }),
        sessionInfo({ id: "ses_s2", projectID: "proj_p2", createdMs: NOW - 4 * HOUR_MS }),
        sessionInfo({ id: "ses_s3", projectID: "proj_p1", createdMs: NOW - 5 * HOUR_MS }),
      ],
      projects: [projectInfo("proj_p1", { name: "One" }), projectInfo("proj_p2", { name: "Two" })],
      messages: [
        assistantRow(
          "ses_s1",
          "msg_1",
          NOW - 2 * HOUR_MS,
          NOW - 2 * HOUR_MS + 1_000,
          { input: 10, output: 2 },
          { providerID: "openai", modelID: "gpt-5" },
        ),
        assistantRow("ses_s2", "msg_2", NOW - 5_000, NOW - 4_000, { input: 3 }),
        assistantRow("ses_s1", "msg_3", NOW - 3_000, NOW - 2_000, { input: 4 }),
        assistantRow("ses_s3", "msg_4", NOW - 1_000, NOW - 900, { input: 5 }),
        assistantRow("ses_s2", "msg_5", NOW - 4_000, NOW - 3_000, { input: 6 }),
      ],
    };
    const forward = makeDataset(parts);
    const shuffledParts = {
      sessions: [...parts.sessions].reverse(),
      projects: [...parts.projects].reverse(),
      messages: [...parts.messages].reverse(),
    };

    const expected = createUsageAnalytics(forward).home("7d", NOW);
    const actual = createUsageAnalytics(makeDataset(shuffledParts)).home("7d", NOW);

    expect(actual).toEqual(expected);
  });

  it("never depends on map insertion order for session and project records", () => {
    const parts = {
      sessions: [
        sessionInfo({ id: "ses_x", projectID: "proj_x", createdMs: NOW - HOUR_MS }),
        sessionInfo({ id: "ses_y", projectID: "proj_y", createdMs: NOW - HOUR_MS }),
      ],
      messages: [
        assistantRow("ses_x", "msg_x", NOW - 1_000, NOW - 900, { input: 1 }),
        assistantRow("ses_y", "msg_y", NOW - 2_000, NOW - 1_900, { input: 2 }),
      ],
    };
    const forward = makeDataset(parts);
    const reversed = makeDataset({
      ...parts,
      sessions: [...parts.sessions].reverse(),
      messages: [...parts.messages].reverse(),
    });

    expect(createUsageAnalytics(reversed).home("24h", NOW)).toEqual(
      createUsageAnalytics(forward).home("24h", NOW),
    );
  });
});

describe("home invariants", () => {
  it("keeps sum(project rows) === usage totals for the same range and owned set", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_1", projectID: "proj_p1", createdMs: NOW - 3 * HOUR_MS }),
        sessionInfo({ id: "ses_2", projectID: "proj_p2", createdMs: NOW - 3 * HOUR_MS }),
      ],
      projects: [projectInfo("proj_p1", { name: "One" }), projectInfo("proj_p2", { name: "Two" })],
      messages: [
        assistantRow(
          "ses_1",
          "msg_1",
          NOW - 2 * HOUR_MS,
          NOW - 2 * HOUR_MS + 1_000,
          { input: 1_000, output: 20, cacheRead: 50 },
          { providerID: "openai", modelID: "gpt-5" },
        ),
        assistantRow(
          "ses_2",
          "msg_2",
          NOW - HOUR_MS,
          NOW - HOUR_MS + 1_000,
          { input: 10, output: 2, reasoning: 1 },
          { providerID: "openai", modelID: "gpt-5" },
        ),
      ],
    });

    const { usage, projects } = createUsageAnalytics(dataset).home("24h", NOW);
    const summed = sumCosted(projects.map((row: ProjectActivityRow) => row.tokens));

    expect(summed).toEqual(usage.totals);
  });

  it("keeps zero-token-but-active projects visible in finite ranges (activity is a timestamp)", () => {
    const dataset = makeDataset({
      sessions: [
        sessionInfo({ id: "ses_idle", projectID: "proj_idle", createdMs: NOW - 40 * DAY_MS }),
        sessionInfo({
          id: "ses_zero",
          projectID: "proj_zero",
          createdMs: NOW - HOUR_MS,
          updatedMs: NOW - 30 * 60_000,
        }),
      ],
      projects: [
        projectInfo("proj_idle", { name: "Idle" }),
        projectInfo("proj_zero", { name: "Zero" }),
      ],
    });

    const finite = createUsageAnalytics(dataset).home("7d", NOW);
    expect(finite.projects.map((row) => row.projectId)).toEqual(["proj_zero"]);
    expect(finite.projects[0]?.tokens).toEqual(zeroCosted());
    expect(finite.projects[0]?.latestActivityAtMs).toBe(NOW - 30 * 60_000);
    expect(finite.projects[0]?.rootSessionCount).toBe(1);

    const lifetime = createUsageAnalytics(dataset).home("lifetime", NOW);
    expect(lifetime.projects.map((row) => row.projectId)).toEqual(["proj_zero", "proj_idle"]);
    expect(lifetime.projects[1]?.tokens).toEqual(zeroCosted());
    expect(lifetime.projects[1]?.latestActivityAtMs).toBe(NOW - 40 * DAY_MS);
  });

  it("shows every discovered project in lifetime, including record-only ones", () => {
    const dataset = makeDataset({
      sessions: [sessionInfo({ id: "ses_s", projectID: "proj_p", createdMs: NOW - HOUR_MS })],
      projects: [
        projectInfo("proj_p", { name: "P" }),
        projectInfo("proj_ghost", { name: "Ghost" }),
      ],
      messages: [
        assistantRow("ses_s", "msg_1", NOW - 30 * 60_000, NOW - 29 * 60_000, { input: 2 }),
      ],
    });

    const lifetime = createUsageAnalytics(dataset).home("lifetime", NOW);
    expect(lifetime.projects.map((row) => row.projectId)).toEqual(["proj_p", "proj_ghost"]);
    expect(lifetime.projects[1]?.tokens).toEqual(zeroCosted());
    expect(lifetime.projects[1]?.latestActivityAtMs).toBe(0);
    expect(lifetime.projects[1]?.rootSessionCount).toBe(0);
  });
});
