import { describe, expect, it, vi } from "vitest";

/**
 * Project bucket contributions (issue #5): every home project row carries one
 * `CostedTokens` per `usage.buckets` entry. Both rollups fill them from the
 * same owned steps they already sum, so bucket totals conserve the project and
 * the project buckets conserve the matching usage bucket.
 *
 * The delegated mock makes the bundled snapshot's unpriced/partial states
 * expressible for both engines without touching real pricing data.
 */
vi.mock("../src/lib/modelsdev-pricing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/modelsdev-pricing.js")>();
  const UNPRICED_PROVIDER = "unpriced-labs";
  const UNPRICED_MODEL = "mystery-1";
  const PARTIAL_PROVIDER = "partial-labs";
  const PARTIAL_MODEL = "input-only";
  const EXTRA_PROVIDERS: ReadonlySet<string> = new Set([UNPRICED_PROVIDER, PARTIAL_PROVIDER]);
  return {
    ...actual,
    hasProvider: (providerID: string) =>
      EXTRA_PROVIDERS.has(providerID) || actual.hasProvider(providerID),
    isModelsDevProviderId: (providerID: string) =>
      EXTRA_PROVIDERS.has(providerID) || actual.isModelsDevProviderId(providerID),
    hasModel: (providerID: string, modelID: string) =>
      (providerID === UNPRICED_PROVIDER && modelID === UNPRICED_MODEL) ||
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      actual.hasModel(providerID, modelID),
    hasCost: (providerID: string, modelID: string) =>
      (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) ||
      actual.hasCost(providerID, modelID),
    lookupCost: (providerID: string, modelID: string) => {
      if (providerID === UNPRICED_PROVIDER) return null;
      if (providerID === PARTIAL_PROVIDER && modelID === PARTIAL_MODEL) return { input: 2 };
      return actual.lookupCost(providerID, modelID);
    },
  };
});

import type { CostedTokens, ProjectActivityRow, Usage } from "../src/contracts/dashboard.js";
import type { RangeKey } from "../src/contracts/ranges.js";
import { createUsageAnalytics, type UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import { createAnalyticsModel } from "../src/gui/analytics-model.js";
import type {
  OpenCodeProjectInfo,
  OpenCodeRawAssistantRow,
  OpenCodeSessionInfo,
} from "../src/lib/opencode-storage.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

type HomeRollup = { usage: Usage; projects: ProjectActivityRow[] };
type HomeRunner = (dataset: UsageAnalyticsDataset, range: RangeKey) => HomeRollup;

/** The two home rollups that must agree on project bucket contributions. */
const ENGINES: Array<{ name: string; home: HomeRunner }> = [
  {
    name: "worker model",
    home: (dataset, range) => {
      const model = createAnalyticsModel();
      model.setMetadata(dataset.sessions, dataset.projects);
      model.apply(dataset.messages, []);
      return model.home(range, NOW);
    },
  },
  {
    name: "legacy aggregation",
    home: (dataset, range) => createUsageAnalytics(dataset).home(range, NOW),
  },
];

function sessionInfo(
  id: string,
  projectID: string | undefined,
  createdMs: number,
  updatedMs = createdMs,
): OpenCodeSessionInfo {
  return { id, projectID, title: id, time: { created: createdMs, updated: updatedMs } };
}

function assistantRow(
  sessionID: string,
  messageID: string,
  completedAtMs: number,
  tokens: Partial<OpenCodeRawAssistantRow["tokens"]>,
  providerID: string,
  modelID: string,
): OpenCodeRawAssistantRow {
  return {
    sessionID,
    messageID,
    createdAtMs: completedAtMs - 1_000,
    completedAtMs,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, ...tokens },
    providerID,
    modelID,
  };
}

function projectInfo(id: string): OpenCodeProjectInfo {
  return { id, name: id, directories: [`/tmp/${id}`], worktrees: [] };
}

/**
 * p1 and p2 both own a fork copy of one fingerprint (p1 wins ownership); the
 * session without a project id lands in the explicit `unknown` project; p3 has
 * metadata only and p4 has a record only.
 */
function makeDataset(): UsageAnalyticsDataset {
  const sessions = [
    sessionInfo("ses_p1", "p1", NOW - 3 * DAY, NOW - HOUR),
    sessionInfo("ses_p2", "p2", NOW - 3 * DAY, NOW - HOUR),
    sessionInfo("ses_unknown", undefined, NOW - 5 * DAY),
    sessionInfo("ses_idle", "p3", NOW - 40 * DAY),
  ];
  const messages: OpenCodeRawAssistantRow[] = [
    assistantRow(
      "ses_p1",
      "msg_priced",
      NOW - 2 * DAY,
      { input: 1_000, output: 20, cacheRead: 50 },
      "openai",
      "gpt-5",
    ),
    assistantRow("ses_p1", "msg_fork_a", NOW - DAY, { input: 200, output: 5 }, "openai", "gpt-5"),
    assistantRow("ses_p2", "msg_fork_b", NOW - DAY, { input: 200, output: 5 }, "openai", "gpt-5"),
    assistantRow(
      "ses_p2",
      "msg_p2_priced",
      NOW - 6 * DAY,
      { input: 400, output: 8 },
      "openai",
      "gpt-5",
    ),
    assistantRow(
      "ses_p2",
      "msg_partial",
      NOW - 3 * DAY,
      { input: 100, output: 40 },
      "partial-labs",
      "input-only",
    ),
    assistantRow(
      "ses_unknown",
      "msg_unpriced",
      NOW - 4 * DAY,
      { input: 30, reasoning: 5 },
      "unpriced-labs",
      "mystery-1",
    ),
    assistantRow(
      "ses_unknown",
      "msg_unknown",
      NOW - 5 * DAY,
      { input: 10 },
      "no-such-provider",
      "no-such-model",
    ),
  ];
  const projects: Record<string, OpenCodeProjectInfo> = {};
  for (const id of ["p1", "p2", "p3", "p4"]) projects[id] = projectInfo(id);
  const sessionRecords: Record<string, OpenCodeSessionInfo> = {};
  for (const session of sessions) sessionRecords[session.id] = session;
  return { sessions: sessionRecords, projects, messages, compactions: [] };
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

interface CostedSum {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  unpricedTokens: number;
  unknownTokens: number;
  costUsd: number;
  pricedAny: boolean;
  recordedCostUsd: number;
  recordedCostTokens: number;
}

function sumCosted(parts: readonly CostedTokens[]): CostedSum {
  const sum: CostedSum = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    unpricedTokens: 0,
    unknownTokens: 0,
    costUsd: 0,
    pricedAny: false,
    recordedCostUsd: 0,
    recordedCostTokens: 0,
  };
  for (const part of parts) {
    sum.input += part.input;
    sum.cacheRead += part.cacheRead;
    sum.cacheWrite += part.cacheWrite;
    sum.output += part.output;
    sum.reasoning += part.reasoning;
    sum.total += part.total;
    sum.unpricedTokens += part.unpricedTokens;
    sum.unknownTokens += part.unknownTokens;
    if (part.apiEquivalentCostUsd !== null) {
      sum.pricedAny = true;
      sum.costUsd += part.apiEquivalentCostUsd;
    }
    sum.recordedCostUsd += part.recordedCostUsd ?? 0;
    sum.recordedCostTokens += part.recordedCostTokens ?? 0;
  }
  return sum;
}

function expectCostedConserved(parts: readonly CostedTokens[], whole: CostedTokens): void {
  const sum = sumCosted(parts);
  expect({
    input: sum.input,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    output: sum.output,
    reasoning: sum.reasoning,
    total: sum.total,
    unpricedTokens: sum.unpricedTokens,
    unknownTokens: sum.unknownTokens,
  }).toEqual({
    input: whole.input,
    cacheRead: whole.cacheRead,
    cacheWrite: whole.cacheWrite,
    output: whole.output,
    reasoning: whole.reasoning,
    total: whole.total,
    unpricedTokens: whole.unpricedTokens,
    unknownTokens: whole.unknownTokens,
  });
  expect(sum.pricedAny).toBe(whole.apiEquivalentCostUsd !== null);
  if (whole.apiEquivalentCostUsd !== null) {
    expect(sum.costUsd).toBeCloseTo(whole.apiEquivalentCostUsd, 10);
  }
  expect(sum.recordedCostUsd).toBeCloseTo(whole.recordedCostUsd ?? 0, 10);
  expect(sum.recordedCostTokens).toBe(whole.recordedCostTokens ?? 0);
}

function projectRow(rollup: HomeRollup, projectId: string): ProjectActivityRow {
  const row = rollup.projects.find((entry) => entry.projectId === projectId);
  if (!row) throw new Error(`missing project row ${projectId}`);
  return row;
}

function bucketsOf(row: ProjectActivityRow): CostedTokens[] {
  const buckets = row.buckets;
  if (buckets === undefined) throw new Error(`project ${row.projectId} has no buckets`);
  return buckets;
}

describe.each(ENGINES)("project bucket rollups: $name", ({ home }) => {
  it("aligns every project's buckets and conserves its own totals", () => {
    const { usage, projects } = home(makeDataset(), "7d");
    expect(projects.map((row) => row.projectId).sort()).toEqual(["p1", "p2", "unknown"]);
    for (const row of projects) {
      const buckets = bucketsOf(row);
      expect(buckets).toHaveLength(usage.buckets.length);
      expectCostedConserved(buckets, row.tokens);
    }
  });

  it("conserves every usage bucket across all project contributions", () => {
    const { usage, projects } = home(makeDataset(), "7d");
    const contributions: CostedTokens[][] = usage.buckets.map(() => []);
    for (const row of projects) {
      const buckets = bucketsOf(row);
      for (let index = 0; index < buckets.length; index += 1) {
        const bucket = buckets[index];
        if (bucket !== undefined) contributions[index]?.push(bucket);
      }
    }
    usage.buckets.forEach((bucket, index) => {
      expectCostedConserved(contributions[index] ?? [], bucket.tokens);
    });
  });

  it("keeps a project whose only in-range step is hidden by a newer out-of-range step", () => {
    const dataset = makeDataset();
    dataset.sessions.ses_future = sessionInfo("ses_future", "p5", NOW - 10 * DAY, NOW + DAY);
    dataset.projects.p5 = projectInfo("p5");
    dataset.messages.push(
      assistantRow(
        "ses_future",
        "msg_future_in",
        NOW - 2 * DAY,
        { input: 120, output: 10 },
        "openai",
        "gpt-5",
      ),
      assistantRow("ses_future", "msg_future_out", NOW + HOUR, { input: 5 }, "openai", "gpt-5"),
    );

    const rollup = home(dataset, "7d");
    const row = projectRow(rollup, "p5");
    expect(row.tokens.total).toBe(130);
    expect(row.latestActivityAtMs).toBe(NOW - 2 * DAY);
    expectCostedConserved(bucketsOf(row), row.tokens);

    const contributions: CostedTokens[][] = rollup.usage.buckets.map(() => []);
    for (const project of rollup.projects) {
      bucketsOf(project).forEach((bucket, index) => {
        contributions[index]?.push(bucket);
      });
    }
    rollup.usage.buckets.forEach((bucket, index) => {
      expectCostedConserved(contributions[index] ?? [], bucket.tokens);
    });
  });

  it("zero-fills inactive buckets and keeps lifetime rows aligned", () => {
    const dataset = makeDataset();
    const finite = home(dataset, "7d");
    const lifetime = home(dataset, "lifetime");

    // p1 is active in exactly two daily buckets; earlier buckets stay explicit zeroes.
    const p1 = bucketsOf(projectRow(finite, "p1"));
    const active = p1.flatMap((bucket, index) => (bucket.total > 0 ? [index] : []));
    expect(active).toHaveLength(2);
    p1.forEach((bucket, index) => {
      if (!active.includes(index)) expect(bucket).toEqual(zeroCosted());
    });
    expect(p1[0]).toEqual(zeroCosted());
    expect(p1[active[0] ?? 0]?.total).toBe(1_070);
    expect(p1[active[1] ?? 0]?.total).toBe(205);

    // Lifetime includes the metadata-only and record-only projects with all zeroes.
    expect(lifetime.projects.map((row) => row.projectId).sort()).toEqual([
      "p1",
      "p2",
      "p3",
      "p4",
      "unknown",
    ]);
    expect(lifetime.usage.buckets.length).toBeGreaterThan(finite.usage.buckets.length);
    for (const row of lifetime.projects) {
      expect(bucketsOf(row)).toHaveLength(lifetime.usage.buckets.length);
    }
    for (const projectId of ["p3", "p4"]) {
      for (const bucket of bucketsOf(projectRow(lifetime, projectId))) {
        expect(bucket).toEqual(zeroCosted());
      }
    }
    expectCostedConserved(bucketsOf(projectRow(lifetime, "p1")), projectRow(lifetime, "p1").tokens);
  });

  it("keeps fully priced, partially priced, unpriced and unknown buckets distinct", () => {
    const rollup = home(makeDataset(), "7d");

    const p1Buckets = bucketsOf(projectRow(rollup, "p1"));
    const fullyPriced = p1Buckets.find((bucket) => bucket.total === 1_070);
    expect(fullyPriced).toMatchObject({
      apiEquivalentCostUsd: expect.any(Number),
      unpricedTokens: 0,
      unknownTokens: 0,
    });
    expect(fullyPriced?.apiEquivalentCostUsd).toBeGreaterThan(0);

    const p2Buckets = bucketsOf(projectRow(rollup, "p2"));
    // The fork copy is owned by p1; it must never appear in p2's buckets.
    expect(p2Buckets.some((bucket) => bucket.total === 205)).toBe(false);
    const partial = p2Buckets.find((bucket) => bucket.total === 140);
    expect(partial).toMatchObject({
      apiEquivalentCostUsd: expect.any(Number),
      unpricedTokens: 40,
      unknownTokens: 0,
    });
    expect(partial?.apiEquivalentCostUsd).toBeGreaterThan(0);

    const unknownBuckets = bucketsOf(projectRow(rollup, "unknown"));
    const unpriced = unknownBuckets.find((bucket) => bucket.total === 35);
    expect(unpriced).toMatchObject({
      apiEquivalentCostUsd: null,
      unpricedTokens: 35,
      unknownTokens: 0,
    });
    const unknown = unknownBuckets.find((bucket) => bucket.total === 10);
    expect(unknown).toMatchObject({
      apiEquivalentCostUsd: null,
      unpricedTokens: 0,
      unknownTokens: 10,
    });
  });
});
