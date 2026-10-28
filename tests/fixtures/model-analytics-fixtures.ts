import type {
  AnalyticsEntityIdentity,
  AnalyticsGroupRow,
  AnalyticsGroupSnapshot,
  AnalyticsSeries,
  CostedTokens,
} from "../../src/contracts/dashboard.js";
import { costed, DAY_MS, NOW } from "./gui-ui-fixtures.js";

/**
 * Synthetic grouped-analytics fixtures for the Models/model/provider UI.
 *
 * Every raw id, provider id and model id here is invented. The rows are built
 * from child specs, so parent totals always equal their children's totals and
 * priced/unpriced/unknown accounting stays internally honest.
 */

export function known(id: string): AnalyticsEntityIdentity {
  return { kind: "known", id };
}

export const unknownIdentity: AnalyticsEntityIdentity = { kind: "unknown" };

export interface RowSpec {
  identity: AnalyticsEntityIdentity;
  total: number;
  cost: number | null;
  unpriced?: number;
  unknown?: number;
  /** Input-side cache traffic, split out of `total`. */
  cacheRead?: number;
  cacheWrite?: number;
  /** Output tokens, split out of `total`; useful for a non-derivable cache rate. */
  output?: number;
  sessions?: number;
  steps?: number;
  children?: RowSpec[];
}

function tokensOf(spec: RowSpec): CostedTokens {
  const cacheRead = spec.cacheRead ?? 0;
  const cacheWrite = spec.cacheWrite ?? 0;
  const output = spec.output ?? 0;
  const input = spec.total - cacheRead - cacheWrite - output;
  if (input < 0) throw new Error(`fixture ${JSON.stringify(spec.identity)} exceeds its total`);
  return costed(
    { input, cacheRead, cacheWrite, output },
    {
      apiEquivalentCostUsd: spec.cost,
      unpricedTokens: spec.unpriced ?? 0,
      unknownTokens: spec.unknown ?? 0,
    },
  );
}

export function makeRow(spec: RowSpec): AnalyticsGroupRow {
  return {
    identity: spec.identity,
    tokens: tokensOf(spec),
    sessionCount: spec.sessions ?? 1,
    stepCount: spec.steps ?? 1,
    children: (spec.children ?? []).map(makeRow),
  };
}

function addCosted(left: CostedTokens, right: CostedTokens): CostedTokens {
  let cost = 0;
  let anyPriced = false;
  for (const tokens of [left, right]) {
    if (tokens.apiEquivalentCostUsd !== null) {
      anyPriced = true;
      cost += tokens.apiEquivalentCostUsd;
    }
  }
  const merged = costed(
    {
      input: left.input + right.input,
      cacheRead: left.cacheRead + right.cacheRead,
      cacheWrite: left.cacheWrite + right.cacheWrite,
      output: left.output + right.output,
      reasoning: left.reasoning + right.reasoning,
    },
    {
      apiEquivalentCostUsd: anyPriced ? cost : null,
      unpricedTokens: left.unpricedTokens + right.unpricedTokens,
      unknownTokens: left.unknownTokens + right.unknownTokens,
    },
  );
  return merged;
}

/** Builds a parent from its synthetic children, preserving the children's token mix. */
export function makeParentRow(
  identity: AnalyticsEntityIdentity,
  children: RowSpec[],
): AnalyticsGroupRow {
  const childRows = children.map(makeRow);
  let tokens = childRows[0]?.tokens;
  if (!tokens) throw new Error("a synthetic parent needs at least one child");
  for (const child of childRows.slice(1)) tokens = addCosted(tokens, child.tokens);
  return {
    identity,
    tokens,
    sessionCount: childRows.reduce((sum, child) => sum + child.sessionCount, 0),
    stepCount: childRows.reduce((sum, child) => sum + child.stepCount, 0),
    children: childRows,
  };
}

function ratio(value: number, share: number): number {
  return Math.round(value * share);
}

function splitCosted(tokens: CostedTokens): [CostedTokens, CostedTokens] {
  const share = 0.6;
  const first = costed(
    {
      input: ratio(tokens.input, share),
      cacheRead: ratio(tokens.cacheRead, share),
      cacheWrite: ratio(tokens.cacheWrite, share),
      output: ratio(tokens.output, share),
      reasoning: ratio(tokens.reasoning, share),
    },
    {
      apiEquivalentCostUsd:
        tokens.apiEquivalentCostUsd === null ? null : tokens.apiEquivalentCostUsd * share,
      unpricedTokens: ratio(tokens.unpricedTokens, share),
      unknownTokens: ratio(tokens.unknownTokens, share),
    },
  );
  const second = costed(
    {
      input: tokens.input - first.input,
      cacheRead: tokens.cacheRead - first.cacheRead,
      cacheWrite: tokens.cacheWrite - first.cacheWrite,
      output: tokens.output - first.output,
      reasoning: tokens.reasoning - first.reasoning,
    },
    {
      apiEquivalentCostUsd:
        tokens.apiEquivalentCostUsd === null
          ? null
          : tokens.apiEquivalentCostUsd - (first.apiEquivalentCostUsd ?? 0),
      unpricedTokens: tokens.unpricedTokens - first.unpricedTokens,
      unknownTokens: tokens.unknownTokens - first.unknownTokens,
    },
  );
  return [first, second];
}

function seriesFromRow(row: AnalyticsGroupRow): AnalyticsSeries {
  const [first, second] = splitCosted(row.tokens);
  return {
    kind: "entity",
    identity: row.identity,
    tokens: row.tokens,
    buckets: [first, second],
  };
}

function seriesFromRows(rows: AnalyticsGroupRow[]): AnalyticsSeries {
  let total = rows[0]?.tokens;
  if (!total) throw new Error("an Other series needs at least one row");
  let first = splitCosted(total)[0];
  let second = splitCosted(total)[1];
  for (const row of rows.slice(1)) {
    const [left, right] = splitCosted(row.tokens);
    total = addCosted(total, row.tokens);
    first = addCosted(first, left);
    second = addCosted(second, right);
  }
  return { kind: "other", tokens: total, buckets: [first, second] };
}

function identityKey(identity: AnalyticsEntityIdentity): string {
  return identity.kind === "unknown" ? "\uffff" : identity.id;
}

function rankRows(rows: AnalyticsGroupRow[]): AnalyticsGroupRow[] {
  return [...rows].sort((left, right) => {
    const byTokens = right.tokens.total - left.tokens.total;
    if (byTokens !== 0) return byTokens;
    const leftKey = identityKey(left.identity);
    const rightKey = identityKey(right.identity);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

export function snapshotOf(
  dimension: "model" | "provider",
  rows: AnalyticsGroupRow[],
  overrides: Partial<AnalyticsGroupSnapshot> = {},
): AnalyticsGroupSnapshot {
  const ranked = rankRows(rows);
  const top = ranked.slice(0, 5);
  const rest = ranked.slice(5);
  const series = top.map(seriesFromRow);
  if (rest.length > 0) series.push(seriesFromRows(rest));
  let totals = rows[0]?.tokens;
  if (!totals) {
    totals = costed({}, { apiEquivalentCostUsd: null });
  } else {
    for (const row of rows.slice(1)) totals = addCosted(totals, row.tokens);
  }
  return {
    dimension,
    range: "7d",
    window: { sinceMs: NOW - 2 * DAY_MS, untilMs: NOW },
    bucketUnit: "day",
    timeZone: "UTC",
    buckets: [
      { startMs: NOW - 2 * DAY_MS, endMs: NOW - DAY_MS },
      { startMs: NOW - DAY_MS, endMs: NOW },
    ],
    totals,
    sessionCount: rows.reduce((sum, row) => sum + row.sessionCount, 0),
    stepCount: rows.reduce((sum, row) => sum + row.stepCount, 0),
    rows,
    series,
    stale: false,
    ...overrides,
  };
}

function sameRowIdentity(left: AnalyticsEntityIdentity, right: AnalyticsEntityIdentity): boolean {
  if (left.kind === "unknown" || right.kind === "unknown") {
    return left.kind === right.kind;
  }
  return left.id === right.id;
}

/**
 * Adds the real per-child buckets the backend now emits, using the fixture's
 * own 60/40 bucket split. The top five entity series receive their children;
 * Other receives the true children of every row outside that top five,
 * aggregated by exact child identity rather than an invented remainder.
 */
export function withChildBuckets(snapshot: AnalyticsGroupSnapshot): AnalyticsGroupSnapshot {
  const topIdentities = snapshot.series.flatMap((entry) =>
    entry.kind === "entity" ? [entry.identity] : [],
  );
  const isContributingRow = (
    row: AnalyticsGroupRow,
    entry: AnalyticsGroupSnapshot["series"][number],
  ): boolean =>
    entry.kind === "entity"
      ? sameRowIdentity(row.identity, entry.identity)
      : !topIdentities.some((identity) => sameRowIdentity(row.identity, identity));

  return {
    ...snapshot,
    series: snapshot.series.map((entry) => {
      const childBuckets = snapshot.buckets.map((_, bucketIndex) => {
        const merged = new Map<
          string,
          { identity: AnalyticsEntityIdentity; tokens: CostedTokens }
        >();
        for (const row of snapshot.rows.filter((candidate) =>
          isContributingRow(candidate, entry),
        )) {
          for (const child of row.children) {
            const split = splitCosted(child.tokens);
            const tokens = split[bucketIndex];
            if (tokens === undefined || tokens.total <= 0) continue;
            const key = identityKey(child.identity);
            const current = merged.get(key);
            merged.set(
              key,
              current === undefined
                ? { identity: child.identity, tokens }
                : { identity: current.identity, tokens: addCosted(current.tokens, tokens) },
            );
          }
        }
        return [...merged.values()].sort((left, right) => {
          const byTokens = right.tokens.total - left.tokens.total;
          if (byTokens !== 0) return byTokens;
          return identityKey(left.identity) < identityKey(right.identity) ? -1 : 1;
        });
      });
      return { ...entry, childBuckets };
    }),
  };
}

/**
 * Adds Other's real hidden same-dimension parents, using the same 60/40 bucket
 * split as `withChildBuckets`. Each parent appears once per bucket and only
 * rows outside the chart's top five contribute, mirroring the backend DTO.
 */
export function withParentBuckets(snapshot: AnalyticsGroupSnapshot): AnalyticsGroupSnapshot {
  const topIdentities = snapshot.series.flatMap((entry) =>
    entry.kind === "entity" ? [entry.identity] : [],
  );
  const hiddenRows = snapshot.rows.filter(
    (row) => !topIdentities.some((identity) => sameRowIdentity(row.identity, identity)),
  );

  return {
    ...snapshot,
    series: snapshot.series.map((entry) => {
      if (entry.kind !== "other") return entry;
      const parentBuckets = snapshot.buckets.map((_, bucketIndex) => {
        const merged = new Map<
          string,
          { identity: AnalyticsEntityIdentity; tokens: CostedTokens }
        >();
        for (const row of hiddenRows) {
          const tokens = splitCosted(row.tokens)[bucketIndex];
          if (tokens === undefined || tokens.total <= 0) continue;
          const key = identityKey(row.identity);
          const current = merged.get(key);
          merged.set(
            key,
            current === undefined
              ? { identity: row.identity, tokens }
              : { identity: current.identity, tokens: addCosted(current.tokens, tokens) },
          );
        }
        return [...merged.values()].sort((left, right) => {
          const byTokens = right.tokens.total - left.tokens.total;
          if (byTokens !== 0) return byTokens;
          return identityKey(left.identity) < identityKey(right.identity) ? -1 : 1;
        });
      });
      return { ...entry, parentBuckets };
    }),
  };
}

const alphaChildren: RowSpec[] = [
  { identity: known("openai"), total: 300, cost: 3 },
  { identity: known("anthropic"), total: 150, cost: 1.5 },
  { identity: known("google"), total: 80, cost: 0.8 },
  { identity: known("mistral"), total: 45, cost: 0.45 },
  { identity: known("deepseek"), total: 20, cost: 0.2 },
  { identity: known("openrouter"), total: 5, cost: 0.05 },
];

const modelRows: AnalyticsGroupRow[] = [
  makeRow({
    identity: known("model-alpha"),
    total: 600,
    cost: 6,
    sessions: 3,
    steps: 5,
    children: alphaChildren,
  }),
  makeRow({
    identity: known("model-beta"),
    total: 500,
    cost: null,
    unpriced: 500,
    children: [{ identity: known("openai"), total: 500, cost: null, unpriced: 500 }],
  }),
  makeRow({
    identity: known("model-gamma"),
    total: 400,
    cost: 0,
    children: [{ identity: known("openai"), total: 400, cost: 0 }],
  }),
  makeRow({
    identity: known("model-delta"),
    total: 300,
    cost: 3,
    unpriced: 25,
    children: [{ identity: known("google"), total: 300, cost: 3, unpriced: 25 }],
  }),
  makeRow({
    identity: known("model-epsilon"),
    total: 200,
    cost: 2,
    children: [{ identity: known("openai"), total: 200, cost: 2 }],
  }),
  makeRow({
    identity: known("model-zeta"),
    total: 100,
    cost: 1,
    children: [{ identity: known("openai"), total: 100, cost: 1 }],
  }),
  makeRow({
    identity: unknownIdentity,
    total: 50,
    cost: null,
    unknown: 50,
    children: [{ identity: unknownIdentity, total: 50, cost: null, unknown: 50 }],
  }),
  makeRow({
    identity: known(""),
    total: 40,
    cost: null,
    unpriced: 40,
    children: [{ identity: known(""), total: 40, cost: null, unpriced: 40 }],
  }),
];

const providerRows: AnalyticsGroupRow[] = [
  makeParentRow(known("openai"), [
    { identity: known("model-alpha"), total: 300, cost: 3 },
    { identity: known("model-beta"), total: 500, cost: null, unpriced: 500 },
    { identity: known("model-gamma"), total: 400, cost: 0 },
    { identity: known("model-epsilon"), total: 200, cost: 2 },
    { identity: known("model-zeta"), total: 100, cost: 1 },
  ]),
  makeParentRow(known("google"), [
    { identity: known("model-alpha"), total: 80, cost: 0.8 },
    { identity: known("model-delta"), total: 300, cost: 3, unpriced: 25 },
  ]),
  makeParentRow(known("anthropic"), [{ identity: known("model-alpha"), total: 150, cost: 1.5 }]),
  makeParentRow(unknownIdentity, [
    { identity: unknownIdentity, total: 50, cost: null, unknown: 50 },
  ]),
  makeParentRow(known("mistral"), [{ identity: known("model-alpha"), total: 45, cost: 0.45 }]),
  makeParentRow(known(""), [{ identity: known(""), total: 40, cost: null, unpriced: 40 }]),
  makeParentRow(known("deepseek"), [{ identity: known("model-alpha"), total: 20, cost: 0.2 }]),
  makeParentRow(known("openrouter"), [{ identity: known("model-alpha"), total: 5, cost: 0.05 }]),
];

const alphaProviderRows: AnalyticsGroupRow[] = [
  makeParentRow(known("openai"), [
    {
      identity: known("model-alpha"),
      total: 300,
      cost: 3,
      cacheRead: 100,
      cacheWrite: 50,
    },
  ]),
  makeParentRow(known("anthropic"), [
    {
      identity: known("model-alpha"),
      total: 150,
      cost: 1.5,
      cacheRead: 50,
      cacheWrite: 25,
    },
  ]),
  makeParentRow(known("google"), [
    {
      identity: known("model-alpha"),
      total: 80,
      cost: 0.8,
      cacheRead: 27,
      cacheWrite: 13,
    },
  ]),
  makeParentRow(known("mistral"), [
    {
      identity: known("model-alpha"),
      total: 45,
      cost: 0.45,
      cacheRead: 15,
      cacheWrite: 7,
    },
  ]),
  makeParentRow(known("deepseek"), [
    {
      identity: known("model-alpha"),
      total: 20,
      cost: 0.2,
      cacheRead: 7,
      cacheWrite: 3,
    },
  ]),
  makeParentRow(known("openrouter"), [
    {
      identity: known("model-alpha"),
      total: 5,
      cost: 0.05,
      cacheRead: 2,
      cacheWrite: 1,
    },
  ]),
];

const openaiModelRows: AnalyticsGroupRow[] = [
  makeParentRow(known("model-beta"), [
    { identity: known("openai"), total: 500, cost: null, unpriced: 500 },
  ]),
  makeParentRow(known("model-gamma"), [{ identity: known("openai"), total: 400, cost: 0 }]),
  makeParentRow(known("model-alpha"), [{ identity: known("openai"), total: 300, cost: 3 }]),
  makeParentRow(known("model-epsilon"), [{ identity: known("openai"), total: 200, cost: 2 }]),
  makeParentRow(known("model-zeta"), [{ identity: known("openai"), total: 100, cost: 1 }]),
];

const noRateRows: AnalyticsGroupRow[] = [
  makeParentRow(known("openai"), [
    { identity: known("model-no-rate"), total: 120, cost: 1.2, output: 120 },
  ]),
];

export function modelSnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("model", modelRows);
}

/** One synthetic day bucket whose start and end format to the same date. */
export function sameDayModelSnapshot(): AnalyticsGroupSnapshot {
  const base = modelSnapshot();
  const startMs = Date.UTC(2026, 9, 27);
  const endMs = startMs + DAY_MS - 1;
  return {
    ...base,
    buckets: [{ startMs, endMs }],
    series: base.series.map((entry) => ({
      ...entry,
      buckets: [entry.buckets[0] as CostedTokens],
    })),
  };
}

export function providerSnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("provider", providerRows);
}

const fallbackProviderRows: AnalyticsGroupRow[] = [
  makeParentRow(known("openai"), [{ identity: known("model-alpha"), total: 300, cost: 3 }]),
  makeParentRow(unknownIdentity, [{ identity: known("model-alpha"), total: 200, cost: 2 }]),
  makeParentRow(known(""), [{ identity: known("model-alpha"), total: 100, cost: 1 }]),
  makeParentRow(known("deepseek"), [{ identity: known("model-alpha"), total: 50, cost: 0.5 }]),
  makeParentRow(known("mistral"), [{ identity: known("model-alpha"), total: 40, cost: 0.4 }]),
  makeParentRow(known("openrouter"), [{ identity: known("model-alpha"), total: 10, cost: 0.1 }]),
];

/** Unknown and empty provider ids are top-five series; openrouter is the Other series. */
export function providerFallbackSnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("provider", fallbackProviderRows);
}

const aliasProviderRows: AnalyticsGroupRow[] = [
  makeParentRow(known("zai"), [{ identity: known("model-alpha"), total: 120, cost: 1.2 }]),
  makeParentRow(known("glm"), [{ identity: known("model-alpha"), total: 90, cost: 0.9 }]),
  makeParentRow(known("zhipu"), [{ identity: known("model-alpha"), total: 80, cost: 0.8 }]),
];

/** Two catalog aliases share the visible label `Z.ai`; raw ids must stay distinct. */
export function providerAliasSnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("provider", aliasProviderRows);
}

export function modelAlphaSnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("provider", alphaProviderRows, {
    filter: { dimension: "model", identity: known("model-alpha") },
  });
}

export function modelNoRateSnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("provider", noRateRows, {
    filter: { dimension: "model", identity: known("model-no-rate") },
  });
}

export function providerOpenAISnapshot(): AnalyticsGroupSnapshot {
  return snapshotOf("model", openaiModelRows, {
    filter: { dimension: "provider", identity: known("openai") },
  });
}

export function zeroSnapshot(
  dimension: "model" | "provider",
  filter: AnalyticsGroupSnapshot["filter"],
): AnalyticsGroupSnapshot {
  const totals = costed({}, { apiEquivalentCostUsd: null });
  return {
    dimension,
    range: "7d",
    window: { sinceMs: NOW - 2 * DAY_MS, untilMs: NOW },
    bucketUnit: "day",
    timeZone: "UTC",
    ...(filter === undefined ? {} : { filter }),
    buckets: [
      { startMs: NOW - 2 * DAY_MS, endMs: NOW - DAY_MS },
      { startMs: NOW - DAY_MS, endMs: NOW },
    ],
    totals,
    sessionCount: 0,
    stepCount: 0,
    rows: [],
    series: [],
    stale: false,
  };
}

/** Re-tags a fixture's range so App-level range assertions see the requested window. */
export function withRange(
  snapshot: AnalyticsGroupSnapshot,
  range: AnalyticsGroupSnapshot["range"],
): AnalyticsGroupSnapshot {
  return { ...snapshot, range };
}
