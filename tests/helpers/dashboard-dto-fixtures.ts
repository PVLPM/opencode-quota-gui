import type {
  AnalyticsGroupSnapshot,
  CostedTokens,
  DashboardHealth,
  HomeSnapshot,
  ImportPreview,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
  SettingsWriteResult,
  TokenStack,
  Usage,
} from "../../src/contracts/dashboard.js";
import type { RangeKey } from "../../src/contracts/ranges.js";

export function tokenStack(input = 0): TokenStack {
  return { input, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
}

export function costedTokens(input = 0): CostedTokens {
  return {
    ...tokenStack(input),
    total: input,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

export function validHealth(): DashboardHealth {
  return { app: "opencode-quota-gui", contractVersion: 2, version: "1.2.0", build: "abc1234" };
}

function providers(): QuotaSnapshot["providers"] {
  return { cards: [], enabledProviders: "auto", polledAtMs: 1 };
}

export function validUsage(range: RangeKey = "7d"): Usage {
  return {
    range,
    window: { untilMs: 1 },
    bucketUnit: range === "24h" ? "hour" : "day",
    timeZone: "UTC",
    buckets: [],
    totals: costedTokens(),
    stepCount: 0,
    sessionCount: 0,
    stale: false,
  };
}

export function validQuotaSnapshot(): QuotaSnapshot {
  return { generatedAtMs: 1, stale: false, timeZone: "UTC", providers: providers() };
}

export function validHomeSnapshot(): HomeSnapshot {
  return {
    generatedAtMs: 1,
    range: "7d",
    stale: false,
    providers: providers(),
    usage: validUsage(),
    projects: [],
  };
}

export function validGroupSnapshot(): AnalyticsGroupSnapshot {
  return {
    dimension: "model",
    range: "7d",
    window: { untilMs: 1 },
    bucketUnit: "day",
    timeZone: "UTC",
    buckets: [],
    totals: costedTokens(),
    sessionCount: 0,
    stepCount: 0,
    rows: [],
    series: [],
    stale: false,
  };
}

export function validProjectSnapshot(): ProjectSnapshot {
  return {
    projectId: "project-1",
    name: "Project",
    range: "7d",
    window: { untilMs: 1 },
    roots: [],
    totals: { ...costedTokens(), sessionCount: 0 },
    usage: validUsage(),
    stale: false,
  };
}

export function validSessionSnapshot(): SessionSnapshot {
  return {
    focusSessionId: "session-1",
    timeZone: "UTC",
    projectId: "project-1",
    projectName: "Project",
    breadcrumbs: [],
    nodes: [],
    steps: [],
    compactionMarkers: [],
    ownSummary: { ...costedTokens(), stepCount: 0 },
    treeTotals: costedTokens(),
    stepSemantics: "step",
  };
}

export function validSettingsSnapshot(): SettingsSnapshot {
  return {
    revision: "rev-1",
    pathLabel: "/config/opencode-quota-gui/config.jsonc",
    values: {},
    sources: {},
    writable: [],
    dashboard: { port: 4144, url: "http://127.0.0.1:4144" },
    visibility: { hiddenCards: [], hiddenRows: [] },
    import: { available: false, issues: [] },
    issues: [],
  };
}

export function validSettingsWriteResult(): SettingsWriteResult {
  return { revision: "rev-2", applied: {}, warnings: [] };
}

export function validImportPreview(): ImportPreview {
  return { from: "legacy", keys: [], issues: [], expectedRevision: "rev-1" };
}
