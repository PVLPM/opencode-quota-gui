import type {
  CostedTokens,
  HomeSnapshot,
  JsonValue,
  ProjectSnapshot,
  ProviderCard,
  QuotaCardRow,
  SessionSnapshot,
  SettingsSnapshot,
  TokenStack,
} from "../../src/contracts/dashboard.js";
import type { CardId, RowId } from "../../src/contracts/identity.js";
import type { RangeWindow } from "../../src/contracts/ranges.js";

/**
 * Synthetic UI fixtures.
 *
 * Everything here is invented: stable-looking opaque ids, small token numbers,
 * and symbolic config labels. No real workspace, account, or credential value
 * appears, and nothing outside this file reads user data.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const NOW = Date.parse("2026-10-18T12:00:00.000Z");

export function stack(overrides: Partial<TokenStack> = {}): TokenStack {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, ...overrides };
}

export function sumStack(value: TokenStack): number {
  return value.input + value.cacheRead + value.cacheWrite + value.output + value.reasoning;
}

export function costed(
  overrides: Partial<TokenStack> = {},
  extra: Partial<CostedTokens> = {},
): CostedTokens {
  const tokens = stack(overrides);
  return {
    ...tokens,
    total: sumStack(tokens),
    apiEquivalentCostUsd: extra.apiEquivalentCostUsd ?? null,
    unpricedTokens: extra.unpricedTokens ?? 0,
    unknownTokens: extra.unknownTokens ?? 0,
  };
}

export function usage(
  range: HomeSnapshot["usage"]["range"],
  buckets: { startMs: number; endMs: number; tokens: CostedTokens }[],
  window: RangeWindow = { sinceMs: NOW - 7 * DAY_MS, untilMs: NOW },
): HomeSnapshot["usage"] {
  const totals = buckets.reduce(
    (accumulator, bucket) => {
      accumulator.input += bucket.tokens.input;
      accumulator.cacheRead += bucket.tokens.cacheRead;
      accumulator.cacheWrite += bucket.tokens.cacheWrite;
      accumulator.output += bucket.tokens.output;
      accumulator.reasoning += bucket.tokens.reasoning;
      accumulator.apiEquivalentCostUsd =
        (accumulator.apiEquivalentCostUsd ?? 0) + (bucket.tokens.apiEquivalentCostUsd ?? 0);
      accumulator.unpricedTokens += bucket.tokens.unpricedTokens;
      accumulator.unknownTokens += bucket.tokens.unknownTokens;
      return accumulator;
    },
    { ...stack(), apiEquivalentCostUsd: 0, unpricedTokens: 0, unknownTokens: 0 } as CostedTokens,
  );
  totals.total = sumStack(totals);
  return {
    range,
    window,
    bucketUnit: range === "24h" ? "hour" : "day",
    buckets,
    totals,
    stepCount: buckets.length,
    sessionCount: buckets.length > 0 ? 1 : 0,
    stale: false,
  };
}

export function providerCard(overrides: Partial<ProviderCard> = {}): ProviderCard {
  return {
    cardId: "provider-1#cardhash" as CardId,
    providerId: "synthetic-provider",
    providerLabel: "Synthetic Provider",
    accountLabel: "Main account",
    labelSource: "connection",
    rows: [percentRow()],
    errors: [],
    observedAtIso: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  };
}

export function percentRow(overrides: Partial<QuotaCardRow> = {}): QuotaCardRow {
  return {
    rowId: "provider-1#cardhash#window:five_hour" as RowId,
    label: "Five hour window",
    kind: "percent",
    resultType: "quota",
    metric: { kind: "window", window: "five_hour" },
    percentRemaining: 62,
    percentUsed: 38,
    resetAtIso: new Date(NOW + 3 * HOUR_MS).toISOString(),
    countdown: "2h 59m",
    runway: { kind: "before_reset", projectedAtIso: new Date(NOW + 2 * HOUR_MS).toISOString() },
    ...overrides,
  };
}

export function homeSnapshot(overrides: Partial<HomeSnapshot> = {}): HomeSnapshot {
  const buckets = [
    {
      startMs: NOW - 2 * DAY_MS,
      endMs: NOW - DAY_MS,
      tokens: costed({ input: 1000, cacheRead: 2000, output: 500 }, { apiEquivalentCostUsd: 0.42 }),
    },
    {
      startMs: NOW - DAY_MS,
      endMs: NOW,
      tokens: costed(
        { input: 3000, cacheRead: 4000, cacheWrite: 500, output: 1500, reasoning: 250 },
        { apiEquivalentCostUsd: 1.28, unpricedTokens: 12 },
      ),
    },
  ];
  return {
    generatedAtMs: NOW,
    range: "7d",
    stale: false,
    providers: { cards: [providerCard()], enabledProviders: "auto", polledAtMs: NOW - 60_000 },
    usage: usage("7d", buckets),
    projects: [
      {
        projectId: "project-alpha",
        name: "alpha",
        tokens: costed({ input: 5000 }, { apiEquivalentCostUsd: 1.1 }),
        rootSessionCount: 2,
        latestActivityAtMs: NOW - 1000,
      },
      {
        projectId: "project-beta",
        name: "beta",
        tokens: costed({ input: 40 }),
        rootSessionCount: 1,
        latestActivityAtMs: NOW - 5 * HOUR_MS,
      },
    ],
    ...overrides,
  };
}

export function projectSnapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    projectId: "project-alpha",
    name: "alpha",
    range: "7d",
    window: { sinceMs: NOW - 7 * DAY_MS, untilMs: NOW },
    roots: [
      {
        sessionId: "session-root-1",
        title: "Refactor the quota aggregation",
        worktreeLabel: "alpha-main",
        tokens: costed({ input: 2500, output: 700 }, { apiEquivalentCostUsd: 0.6 }),
        latestActivityAtMs: NOW - 1000,
      },
      {
        sessionId: "session-root-2",
        title: "Investigate the reset countdown",
        worktreeLabel: "alpha-main",
        tokens: costed({ input: 800 }),
        latestActivityAtMs: NOW - 3 * HOUR_MS,
      },
    ],
    totals: {
      ...costed({ input: 3300, output: 700 }, { apiEquivalentCostUsd: 0.6 }),
      sessionCount: 4,
    },
    usage: usage("7d", [
      { startMs: NOW - DAY_MS, endMs: NOW, tokens: costed({ input: 3300, output: 700 }) },
    ]),
    stale: false,
    ...overrides,
  };
}

export function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    focusSessionId: "session-root-1",
    breadcrumbs: [
      { sessionId: "session-ancestor", title: "Earlier exploration", isFocus: false },
      { sessionId: "session-root-1", title: "Refactor the quota aggregation", isFocus: true },
    ],
    nodes: [
      {
        sessionId: "session-root-1",
        title: "Refactor the quota aggregation",
        depth: 0,
        childIds: ["session-child-1"],
        ownTokens: costed({ input: 1200, cacheRead: 300 }),
        subtreeTokens: costed({ input: 2400, cacheRead: 300, output: 200 }),
        stepCount: 3,
        subtreeNodeCount: 2,
        latestActivityAtMs: NOW - 1000,
      },
      {
        sessionId: "session-child-1",
        parentId: "session-root-1",
        title: "Sub-agent: verify the bucket edges",
        depth: 1,
        worktreeLabel: "alpha-feature",
        childIds: [],
        ownTokens: costed({ input: 1200, output: 200 }),
        subtreeTokens: costed({ input: 1200, output: 200 }),
        stepCount: 2,
        subtreeNodeCount: 1,
        latestActivityAtMs: NOW - 2000,
      },
    ],
    steps: [
      {
        sessionId: "session-root-1",
        messageId: "msg-1",
        atMs: NOW - 3 * HOUR_MS,
        branch: 0,
        stack: stack({ input: 400, cacheRead: 100 }),
        contextTokens: 500,
        totalTokens: 500,
      },
      {
        sessionId: "session-root-1",
        messageId: "msg-2",
        atMs: NOW - 2 * HOUR_MS,
        branch: 0,
        stack: stack({ input: 800, output: 200 }),
        contextTokens: 800,
        totalTokens: 1000,
      },
      {
        sessionId: "session-child-1",
        messageId: "msg-3",
        atMs: NOW - 1 * HOUR_MS,
        branch: 1,
        stack: stack({ input: 1200, output: 200 }),
        contextTokens: 1200,
        totalTokens: 1400,
      },
    ],
    compactionMarkers: [
      {
        sessionId: "session-root-1",
        atMs: NOW - 2 * HOUR_MS - 60_000,
        messageId: "msg-compaction",
      },
    ],
    ownSummary: { ...costed({ input: 1200, cacheRead: 300 }), stepCount: 2 },
    treeTotals: costed({ input: 2400, cacheRead: 300, output: 200 }),
    stepSemantics:
      "One step is one completed assistant message; context is input plus cache read plus cache write.",
    ...overrides,
  };
}

export function settingsSnapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
  const values: Record<string, JsonValue> = {
    formatStyle: "singleWindow",
    percentDisplayMode: "remaining",
    percentLabelStyle: "full",
    waitForQuotaReset: false,
    resetTimeSpaced: true,
    enabledProviders: "auto",
    minIntervalMs: 300000,
    requestTimeoutMs: 20000,
    accountingDetail: "summary",
    opencodeGoWindows: ["rolling", "weekly", "monthly"],
    "dashboard.hiddenCards": [],
    "dashboard.hiddenRows": [],
    "dashboard.port": 4144,
  };
  return {
    revision: "revision-1",
    pathLabel: "opencode-quota-gui/config.jsonc",
    values,
    sources: { formatStyle: "opencode-quota/quota-toast.jsonc" },
    writable: Object.keys(values),
    dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
    visibility: { hiddenCards: [], hiddenRows: [] },
    import: {
      available: true,
      from: "workspace: synthetic",
      keyCount: 2,
      issues: [],
    },
    issues: [],
    ...overrides,
  };
}
