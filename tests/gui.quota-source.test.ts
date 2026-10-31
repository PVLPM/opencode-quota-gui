/**
 * Quota transport source: independent analytics/quota lifecycles, provider
 * selection, last-good preservation, cycle coalescing and stale fallback.
 *
 * All seams are synthetic: no provider query, database, credentials or worker.
 */
import { describe, expect, it } from "vitest";

import type { CostedTokens, HomeSnapshot } from "../src/contracts/dashboard.js";
import { planRangeBuckets, rangeBucketUnit, rangeWindow } from "../src/contracts/ranges.js";
import { AnalyticsNotFoundError } from "../src/gui/aggregation.js";
import {
  buildCardId,
  buildProviderScopeCardId,
  hashQuotaCardIdentity,
  PROVIDER_SCOPE_IDENTITY_KEY,
} from "../src/gui/identity.js";
import { openAiOptionalVisibilityRows } from "../src/gui/provider-cards.js";
import {
  createDashboardReadSource,
  type DashboardAnalyticsService,
  type DashboardReadSourceOptions,
} from "../src/gui/sources.js";
import type { QuotaPercentEntry, QuotaProvider, QuotaProviderResult } from "../src/lib/entries.js";
import type { QuotaStatusLiveProbe } from "../src/lib/quota-render-data.js";
import { DEFAULT_CONFIG, type QuotaToastConfig } from "../src/lib/types.js";

const NOW = Date.parse("2026-10-18T10:30:00.000Z");

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function costed(total: number): CostedTokens {
  return {
    input: total,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total,
    apiEquivalentCostUsd: null,
    unpricedTokens: 0,
    unknownTokens: 0,
  };
}

function homeSnapshot(): HomeSnapshot {
  return {
    generatedAtMs: NOW,
    range: "7d",
    stale: false,
    providers: { cards: [], enabledProviders: [], polledAtMs: NOW },
    usage: {
      range: "7d",
      window: rangeWindow("7d", NOW),
      bucketUnit: rangeBucketUnit("7d"),
      timeZone: "UTC",
      buckets: planRangeBuckets("7d", NOW).map((bucket) => ({ ...bucket, tokens: costed(0) })),
      totals: costed(7),
      stepCount: 1,
      sessionCount: 1,
      stale: false,
    },
    projects: [],
  };
}

function percentEntry(
  percentRemaining: number,
  name = "Weekly",
  sourceId?: string,
): QuotaPercentEntry {
  const accounting: QuotaPercentEntry["accounting"] = { ...TEST_ACCOUNTING };
  if (sourceId !== undefined) accounting.sourceId = sourceId;
  return {
    kind: "percent",
    name,
    percentRemaining,
    accounting,
    semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
  };
}

function result(overrides: Partial<QuotaProviderResult> = {}): QuotaProviderResult {
  return { attempted: true, entries: [], errors: [], ...overrides };
}

function probe(providerId: string, value: QuotaProviderResult): QuotaStatusLiveProbe {
  return { providerId, result: value };
}

function baseConfig(overrides: Partial<QuotaToastConfig> = {}): QuotaToastConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    dashboard: { ...DEFAULT_CONFIG.dashboard, ...overrides.dashboard },
  };
}

const CLIENT: DashboardReadSourceOptions["client"] = {
  config: {
    providers: async () => ({ data: { providers: [] } }),
    get: async () => ({ data: {} }),
  },
};

interface QuotaHarness {
  source: ReturnType<typeof createDashboardReadSource>;
  collectorCalls: Array<{ config: QuotaToastConfig; nowMs: number; providers: QuotaProvider[] }>;
  config: QuotaToastConfig;
}

function harness(
  options: {
    config?: QuotaToastConfig;
    collect?: (input: {
      config: QuotaToastConfig;
      nowMs: number;
      providers: QuotaProvider[];
    }) => Promise<QuotaStatusLiveProbe[]>;
    analytics?: DashboardAnalyticsService;
    createAnalyticsService?: () => DashboardAnalyticsService;
    now?: () => number;
  } = {},
): QuotaHarness {
  const config = options.config ?? baseConfig();
  const collectorCalls: QuotaHarness["collectorCalls"] = [];
  const source = createDashboardReadSource({
    client: CLIENT,
    workspaceRoot: "C:/synthetic-workspace",
    configDir: "C:/synthetic-config",
    now: options.now ?? (() => NOW),
    loadConfig: async () => config,
    collectProviderResults: async (input) => {
      collectorCalls.push(input);
      if (options.collect) return options.collect(input);
      return [probe("anthropic", result({ entries: [percentEntry(50)] }))];
    },
    ...(options.analytics ? { analyticsService: options.analytics } : {}),
    ...(options.createAnalyticsService
      ? { createAnalyticsService: options.createAnalyticsService }
      : {}),
  });
  return { source, collectorCalls, config };
}

describe("quota read source", () => {
  it("queries every enabled provider even when a provider-level card is hidden and keeps its cards for the browser", async () => {
    const hiddenAccount = buildCardId("anthropic", "acct-1");
    const config = baseConfig({
      enabledProviders: ["anthropic", "copilot", "cursor"],
      dashboard: {
        ...DEFAULT_CONFIG.dashboard,
        // Account-level card ids must never remove the whole provider. No
        // hidden-card id filters the collected snapshot: the browser hides it.
        hiddenCards: [
          hiddenAccount,
          hashQuotaCardIdentity("copilot", PROVIDER_SCOPE_IDENTITY_KEY),
          "cursor",
          "unknown-hidden-card",
        ],
      },
    });
    const test = harness({
      config,
      collect: async ({ providers }) =>
        providers.map((provider) => probe(provider.id, result({ entries: [percentEntry(50)] }))),
    });
    const snapshot = await test.source.quota();

    expect(test.collectorCalls).toHaveLength(1);
    const selected = test.collectorCalls[0]?.providers.map((provider) => provider.id);
    expect(selected).toEqual(expect.arrayContaining(["anthropic", "copilot", "cursor"]));
    expect(selected).not.toContain("openai");

    const cardProviders = snapshot.providers.cards.map((card) => card.providerId);
    // Hidden cards remain in the collected snapshot; the browser applies visibility.
    expect(cardProviders).toEqual(expect.arrayContaining(["anthropic", "copilot", "cursor"]));
    // Unknown hidden ids are retained untouched and never affect polling.
    expect(config.dashboard.hiddenCards).toEqual([
      hiddenAccount,
      hashQuotaCardIdentity("copilot", PROVIDER_SCOPE_IDENTITY_KEY),
      "cursor",
      "unknown-hidden-card",
    ]);
  });

  it("attaches temporal rows for every capable provider, including undiscovered ones", async () => {
    const config = baseConfig({ enabledProviders: ["deepseek"] });
    const test = harness({
      config,
      collect: async ({ providers }) =>
        providers.map((provider) => probe(provider.id, result({ entries: [percentEntry(50)] }))),
    });
    const snapshot = await test.source.quota();
    const temporal = snapshot.temporal;
    expect(temporal).toBeDefined();
    expect(temporal?.providers.length).toBeGreaterThan(5);
    expect(
      temporal?.providers.find((provider) => provider.providerId === "deepseek"),
    ).toMatchObject({ discovered: true });
    expect(temporal?.providers.find((provider) => provider.providerId === "zai")).toMatchObject({
      discovered: false,
      source: { label: "Z.ai current credits-plan usage" },
    });
    expect(
      temporal?.providers.every(
        (provider) => provider.providerId === "deepseek" || provider.discovered === false,
      ),
    ).toBe(true);
  });

  it("polls a provider hidden by its provider-scope card id and keeps its cards", async () => {
    const config = baseConfig({
      enabledProviders: ["anthropic", "copilot"],
      dashboard: {
        ...DEFAULT_CONFIG.dashboard,
        hiddenCards: [buildProviderScopeCardId("copilot")],
      },
    });
    const test = harness({
      config,
      collect: async ({ providers }) =>
        providers.map((provider) => probe(provider.id, result({ entries: [percentEntry(50)] }))),
    });
    const snapshot = await test.source.quota();
    expect(test.collectorCalls[0]?.providers.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["anthropic", "copilot"]),
    );
    expect(snapshot.providers.cards.map((card) => card.providerId)).toEqual(
      expect.arrayContaining(["anthropic", "copilot"]),
    );
  });

  it("uses the current selected set on the next cycle after a settings change", async () => {
    const test = harness();
    test.config.enabledProviders = ["anthropic"];
    await test.source.quota();
    expect(test.collectorCalls[0]?.providers.map((provider) => provider.id)).toEqual(["anthropic"]);

    test.config.enabledProviders = ["copilot"];
    await test.source.quota();
    expect(test.collectorCalls[1]?.providers.map((provider) => provider.id)).toEqual(["copilot"]);
  });

  it("keeps last-good measurements, surfaces current errors, and marks stale without advancing polledAt", async () => {
    let cycle = 0;
    let clock = NOW;
    const test = harness({
      now: () => clock,
      collect: async () => {
        cycle += 1;
        if (cycle === 1) {
          return [probe("anthropic", result({ entries: [percentEntry(62.5)] }))];
        }
        if (cycle === 2) {
          return [
            probe(
              "anthropic",
              result({ errors: [{ label: "Sync", message: "temporary failure" }] }),
            ),
          ];
        }
        return [];
      },
    });

    const first = await test.source.quota();
    expect(first.stale).toBe(false);
    expect(first.providers.polledAtMs).toBe(NOW);
    expect(first.providers.cards[0]?.rows[0]?.percentRemaining).toBe(62.5);
    expect(first.providers.cards[0]?.errors).toEqual([]);

    // A provider without new measurements falls back to the last measurement
    // snapshot, keeps the current cycle's error, and cannot look fresh.
    clock = NOW + 60_000;
    const second = await test.source.quota();
    expect(second.stale).toBe(true);
    expect(second.providers.polledAtMs).toBe(NOW);
    expect(second.providers.cards[0]?.rows[0]?.percentRemaining).toBe(62.5);
    expect(second.providers.cards[0]?.errors.map((error) => error.label)).toEqual(["Sync"]);

    // A selected provider missing from the cycle (slow/unavailable) also keeps
    // its last good probe and stays stale.
    clock = NOW + 120_000;
    const third = await test.source.quota();
    expect(third.stale).toBe(true);
    expect(third.providers.polledAtMs).toBe(NOW);
    expect(third.providers.cards[0]?.rows[0]?.percentRemaining).toBe(62.5);
  });

  it("treats account descriptors without entries as fallback, not as a measurement", async () => {
    let cycle = 0;
    let clock = NOW;
    const accounts = [{ sourceId: "acct-a" }, { sourceId: "acct-b" }];
    const test = harness({
      now: () => clock,
      collect: async () => {
        cycle += 1;
        if (cycle === 1) {
          return [
            probe(
              "anthropic",
              result({
                accounts,
                entries: [percentEntry(70, "A", "acct-a"), percentEntry(40, "B", "acct-b")],
              }),
            ),
          ];
        }
        return [
          probe(
            "anthropic",
            result({
              accounts,
              entries: [],
              errors: [
                { label: "Account B", message: "temporarily unavailable", sourceId: "acct-b" },
              ],
            }),
          ),
        ];
      },
    });

    const first = await test.source.quota();
    expect(first.stale).toBe(false);
    expect(first.providers.cards.map((card) => card.rows.length)).toEqual([1, 1]);

    clock = NOW + 60_000;
    const second = await test.source.quota();
    expect(second.stale).toBe(true);
    expect(second.providers.polledAtMs).toBe(NOW);
    // Both measurements survive; the fresh accounts descriptor did not replace
    // the measured account set.
    expect(second.providers.cards.map((card) => card.accountLabel)).toEqual([
      "Account 1",
      "Account 2",
    ]);
    expect(second.providers.cards.map((card) => card.rows[0]?.percentRemaining)).toEqual([70, 40]);
    const failed = second.providers.cards.find((card) => card.accountLabel === "Account 2");
    expect(failed?.errors.map((error) => error.label)).toEqual(["Account B"]);
    const healthy = second.providers.cards.find((card) => card.accountLabel === "Account 1");
    expect(healthy?.errors).toEqual([]);
  });

  it("keeps OpenCode Go last-good through a failure but clears it when entitlement is revoked", async () => {
    let cycle = 0;
    let clock = NOW;
    const account = { sourceId: "go-account", label: "Account 1", active: true };
    const test = harness({
      config: baseConfig({ enabledProviders: ["opencode-go"] }),
      now: () => clock,
      collect: async () => {
        cycle += 1;
        if (cycle === 1) {
          return [
            probe(
              "opencode-go",
              result({
                entries: [percentEntry(63, "OpenCode Go 5h", "go-account")],
                accounts: [account],
                statusDetails: [{ key: "go_source", value: "console" }],
              }),
            ),
          ];
        }
        if (cycle === 2) {
          return [
            probe(
              "opencode-go",
              result({
                accounts: [account],
                errors: [
                  { label: "Account 1", message: "temporary failure", sourceId: "go-account" },
                ],
                statusDetails: [{ key: "go_source", value: "console" }],
              }),
            ),
          ];
        }
        return [
          probe(
            "opencode-go",
            result({
              attempted: false,
              accounts: [account],
              statusDetails: [{ key: "opencode_go_state", value: "not_subscribed" }],
            }),
          ),
        ];
      },
    });

    const first = await test.source.quota();
    expect(first.stale).toBe(false);
    expect(
      first.providers.cards.find((card) => card.providerId === "opencode-go")?.rows[0]
        ?.percentRemaining,
    ).toBe(63);

    // A real request failure still preserves the last good Go measurement.
    clock = NOW + 60_000;
    const second = await test.source.quota();
    expect(second.stale).toBe(true);
    expect(second.providers.polledAtMs).toBe(NOW);
    const failed = second.providers.cards.find((card) => card.providerId === "opencode-go");
    expect(failed?.rows[0]?.percentRemaining).toBe(63);
    expect(failed?.errors.map((error) => error.label)).toEqual(["Account 1"]);

    // Revoked entitlement is a fresh current result, not a transient failure:
    // the old Go rows must not survive as a stale card.
    clock = NOW + 120_000;
    const third = await test.source.quota();
    expect(third.stale).toBe(false);
    expect(third.providers.polledAtMs).toBe(NOW + 120_000);
    const goCards = third.providers.cards.filter((card) => card.providerId === "opencode-go");
    expect(goCards.every((card) => card.rows.length === 0)).toBe(true);
    expect(
      third.providers.cards.flatMap((card) => card.rows.map((row) => row.percentRemaining)),
    ).not.toContain(63);
  });

  it("treats a partially measured account set as fresh and surfaces the failed account error", async () => {
    let cycle = 0;
    let clock = NOW;
    const accounts = [{ sourceId: "acct-a" }, { sourceId: "acct-b" }];
    const test = harness({
      now: () => clock,
      collect: async () => {
        cycle += 1;
        if (cycle === 1) {
          return [
            probe(
              "anthropic",
              result({
                accounts,
                entries: [percentEntry(70, "A", "acct-a"), percentEntry(40, "B", "acct-b")],
              }),
            ),
          ];
        }
        return [
          probe(
            "anthropic",
            result({
              accounts,
              entries: [percentEntry(55, "A", "acct-a")],
              errors: [{ label: "Account B", message: "unavailable", sourceId: "acct-b" }],
            }),
          ),
        ];
      },
    });

    await test.source.quota();
    clock = NOW + 60_000;
    const second = await test.source.quota();
    expect(second.stale).toBe(false);
    expect(second.providers.polledAtMs).toBe(NOW + 60_000);
    const accountA = second.providers.cards.find((card) => card.accountLabel === "Account 1");
    const accountB = second.providers.cards.find((card) => card.accountLabel === "Account 2");
    expect(accountA?.rows.map((row) => row.percentRemaining)).toEqual([55]);
    expect(accountB?.errors.map((error) => error.label)).toEqual(["Account B"]);
  });

  it("updates measured providers while preserving a failed provider in the same cycle", async () => {
    let cycle = 0;
    let clock = NOW;
    const test = harness({
      now: () => clock,
      collect: async () => {
        cycle += 1;
        if (cycle === 1) {
          return [
            probe("anthropic", result({ entries: [percentEntry(20, "Anthropic")] })),
            probe("copilot", result({ entries: [percentEntry(90, "Copilot")] })),
          ];
        }
        return [
          probe("anthropic", result({ entries: [percentEntry(35, "Anthropic")] })),
          probe("copilot", result({ errors: [{ label: "Copilot", message: "sync failed" }] })),
        ];
      },
    });

    const first = await test.source.quota();
    expect(first.stale).toBe(false);

    clock = NOW + 60_000;
    const second = await test.source.quota();
    expect(second.stale).toBe(true);
    expect(second.providers.polledAtMs).toBe(NOW);
    const anthropic = second.providers.cards.find((card) => card.providerId === "anthropic");
    const copilot = second.providers.cards.find((card) => card.providerId === "copilot");
    expect(anthropic?.rows[0]?.percentRemaining).toBe(35);
    expect(copilot?.rows[0]?.percentRemaining).toBe(90);
    expect(copilot?.errors.map((error) => error.label)).toEqual(["Copilot"]);
  });

  it("replaces the preserved provider result with a fresh good one and clears stale", async () => {
    let cycle = 0;
    let clock = NOW;
    const test = harness({
      now: () => clock,
      collect: async () => {
        cycle += 1;
        if (cycle === 1) {
          return [probe("anthropic", result({ entries: [percentEntry(62.5)] }))];
        }
        if (cycle === 2) {
          return [probe("anthropic", result({ errors: [{ label: "Sync", message: "boom" }] }))];
        }
        return [probe("anthropic", result({ entries: [percentEntry(10)] }))];
      },
    });
    await test.source.quota();
    clock = NOW + 60_000;
    const second = await test.source.quota();
    expect(second.stale).toBe(true);

    clock = NOW + 120_000;
    const third = await test.source.quota();
    expect(third.stale).toBe(false);
    expect(third.providers.polledAtMs).toBe(NOW + 120_000);
    expect(third.providers.cards[0]?.rows[0]?.percentRemaining).toBe(10);
    expect(third.providers.cards[0]?.errors).toEqual([]);
  });

  it("drops a deselected provider's last-good card and stays fresh", async () => {
    const test = harness({
      collect: async ({ providers }) => {
        const selected = new Set(providers.map((provider) => provider.id));
        return [
          probe("anthropic", result({ entries: [percentEntry(20)] })),
          probe("copilot", result({ entries: [percentEntry(90)] })),
        ].filter((entry) => selected.has(entry.providerId));
      },
    });

    const first = await test.source.quota();
    expect(first.providers.cards).toHaveLength(2);

    test.config.enabledProviders = ["anthropic"];
    const second = await test.source.quota();
    expect(second.stale).toBe(false);
    expect(second.providers.cards.map((card) => card.providerId)).toEqual(["anthropic"]);
  });

  it("serves the previous quota snapshot as stale when the whole cycle fails", async () => {
    let failing = false;
    const test = harness({
      collect: async () => {
        if (failing) throw new Error("provider cycle failed");
        return [probe("anthropic", result({ entries: [percentEntry(42)] }))];
      },
    });

    const fresh = await test.source.quota();
    expect(fresh.stale).toBe(false);

    failing = true;
    const stale = await test.source.quota();
    expect(stale.stale).toBe(true);
    expect(stale.providers.cards[0]?.rows[0]?.percentRemaining).toBe(42);
  });

  it("rejects when the first cycle fails and no previous snapshot exists", async () => {
    const test = harness({
      collect: async () => {
        throw new Error("provider cycle failed");
      },
    });
    await expect(test.source.quota()).rejects.toThrow("provider cycle failed");
  });

  it("shares one coordinated cycle across concurrent readers", async () => {
    let calls = 0;
    let release!: (probes: QuotaStatusLiveProbe[]) => void;
    const test = harness({
      collect: () => {
        calls += 1;
        return new Promise<QuotaStatusLiveProbe[]>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = test.source.quota();
    const second = test.source.quota();
    // The cycle awaits config before probing; let its microtasks run.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);

    release([probe("anthropic", result({ entries: [percentEntry(33)] }))]);
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(a.providers.cards[0]?.rows[0]?.percentRemaining).toBe(33);
    expect(calls).toBe(1);
  });

  it("keeps home analytics independent of a slow or failing quota cycle", async () => {
    const test = harness({
      collect: async () => {
        throw new Error("provider cycle failed");
      },
      analytics: {
        home: async () => homeSnapshot(),
        project: async () => {
          throw new Error("not used");
        },
        session: async () => {
          throw new Error("not used");
        },
      },
    });

    const home = await test.source.home({ range: "7d" });
    expect(home.usage.totals.total).toBe(7);
    await expect(test.source.quota()).rejects.toThrow("provider cycle failed");
  });

  it("does not block home on a slow quota cycle", async () => {
    let release!: (probes: QuotaStatusLiveProbe[]) => void;
    const test = harness({
      collect: () =>
        new Promise<QuotaStatusLiveProbe[]>((resolve) => {
          release = resolve;
        }),
      analytics: {
        home: async () => homeSnapshot(),
        project: async () => {
          throw new Error("not used");
        },
        session: async () => {
          throw new Error("not used");
        },
      },
    });

    const pendingQuota = test.source.quota();
    const home = await test.source.home({ range: "7d" });
    expect(home.usage.totals.total).toBe(7);

    let settled = false;
    void pendingQuota.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release([probe("anthropic", result({ entries: [percentEntry(10)] }))]);
    const snapshot = await pendingQuota;
    expect(snapshot.providers.cards).toHaveLength(1);
  });

  it("does not block quota on a slow analytics read", async () => {
    let releaseHome!: (snapshot: HomeSnapshot) => void;
    const test = harness({
      analytics: {
        home: () =>
          new Promise<HomeSnapshot>((resolve) => {
            releaseHome = resolve;
          }),
        project: async () => {
          throw new Error("not used");
        },
        session: async () => {
          throw new Error("not used");
        },
      },
    });

    const pendingHome = test.source.home({ range: "7d" });
    const quota = await test.source.quota();
    expect(quota.providers.cards).toHaveLength(1);

    releaseHome(homeSnapshot());
    await expect(pendingHome).resolves.toMatchObject({ usage: { totals: { total: 7 } } });
  });

  it("does not start the analytics service for quota-only reads", async () => {
    let factories = 0;
    const test = harness({
      createAnalyticsService: () => {
        factories += 1;
        throw new Error("must not be created");
      },
    });

    await test.source.quota();
    await test.source.refreshAnalytics?.();
    expect(factories).toBe(0);
  });

  it("closes the analytics service only when it was created", async () => {
    let closes = 0;
    let created = 0;
    const service: DashboardAnalyticsService = {
      home: async () => homeSnapshot(),
      project: async () => {
        throw new Error("not used");
      },
      session: async () => {
        throw new Error("not used");
      },
      close: async () => {
        closes += 1;
      },
    };
    const test = harness({
      createAnalyticsService: () => {
        created += 1;
        return service;
      },
    });

    await test.source.close?.();
    expect(created).toBe(0);
    expect(closes).toBe(0);

    await test.source.home({ range: "7d" });
    await test.source.close?.();
    expect(created).toBe(1);
    expect(closes).toBe(1);
  });

  it("maps analytics not-found errors through the source seam", async () => {
    const test = harness({
      analytics: {
        home: async () => homeSnapshot(),
        project: async () => {
          throw new AnalyticsNotFoundError("project", "missing");
        },
        session: async () => {
          throw new AnalyticsNotFoundError("session", "missing");
        },
      },
    });

    await expect(test.source.project({ projectId: "missing", range: "7d" })).rejects.toMatchObject({
      code: "project-not-found",
      message: "Project not found",
    });
    await expect(test.source.session({ sessionId: "missing" })).rejects.toMatchObject({
      code: "session-not-found",
      message: "Session not found",
    });
  });

  it("evaluates OpenAI reset details against hidden account cards and rows per source", async () => {
    const hiddenAccount = buildCardId("openai", "raw-hidden-account");
    const hiddenRowAccount = buildCardId("openai", "raw-hidden-row");
    const visibleAccount = buildCardId("openai", "raw-visible-account");
    const hiddenResetsRow = openAiOptionalVisibilityRows(hiddenRowAccount)[0]!.rowId;
    let visibility: ((sourceId?: string) => boolean) | undefined;
    const test = harness({
      config: baseConfig({
        dashboard: {
          ...DEFAULT_CONFIG.dashboard,
          hiddenCards: [hiddenAccount],
          hiddenRows: [hiddenResetsRow],
        },
      }),
      collect: async (input) => {
        visibility = input.openaiResetDetailsVisible;
        return [];
      },
    });

    await test.source.quota();

    expect(visibility).toBeTypeOf("function");
    expect(visibility!("raw-hidden-account")).toBe(false);
    expect(visibility!("raw-hidden-row")).toBe(false);
    expect(visibility!("raw-visible-account")).toBe(true);
    expect(visibility!(undefined)).toBe(false);
    expect(visibleAccount).not.toBe(hiddenAccount);
  });
});
