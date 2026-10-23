/**
 * Independent private-state namespace: active GUI caches and state live under
 * `opencode-quota-gui`; upstream `opencode-quota` files are never read, migrated,
 * locked over, or deleted. Upstream sentinel bytes stay unchanged.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtimePaths = vi.hoisted(() => ({ root: "" }));

let TEST_RUNTIME_ROOT = "";
let CACHE_DIR = "";
let STATE_DIR = "";
let UPSTREAM_CACHE_DIR = "";
let UPSTREAM_STATE_DIR = "";
let PREVIOUS_GUI_CACHE_DIR = "";

vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${runtimePaths.root}/data`,
    configDir: `${runtimePaths.root}/config`,
    cacheDir: `${runtimePaths.root}/cache`,
    stateDir: `${runtimePaths.root}/state`,
  }),
}));

const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

function createProvider() {
  return {
    id: "synthetic",
    cachePolicy: { kind: "account-neutral" },
    isAvailable: vi.fn(),
    fetch: vi.fn().mockResolvedValue({
      attempted: true,
      entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
      errors: [],
    }),
  } as never;
}

function createTestContext() {
  return {
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    config: {
      anthropicBinaryPath: "claude",
      cursorPlan: "none",
      onlyCurrentModel: false,
    },
  } as never;
}

const sentinels = new Map<string, string>();

function sentinel(path: string, contents: string): void {
  sentinels.set(path, contents);
}

async function writeSentinels(): Promise<void> {
  for (const [path, contents] of sentinels) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
}

async function expectSentinelsUnchanged(): Promise<void> {
  for (const [path, contents] of sentinels) {
    await expect(readFile(path, "utf8")).resolves.toBe(contents);
  }
}

describe("GUI private-state namespace", () => {
  beforeEach(async () => {
    vi.resetModules();
    sentinels.clear();
    TEST_RUNTIME_ROOT = await mkdtemp(join(tmpdir(), "opencode-quota-gui-private-namespace-"));
    runtimePaths.root = TEST_RUNTIME_ROOT;
    CACHE_DIR = `${TEST_RUNTIME_ROOT}/cache`;
    STATE_DIR = `${TEST_RUNTIME_ROOT}/state`;
    UPSTREAM_CACHE_DIR = `${CACHE_DIR}/opencode-quota`;
    UPSTREAM_STATE_DIR = `${STATE_DIR}/opencode-quota`;
    PREVIOUS_GUI_CACHE_DIR = `${CACHE_DIR}/quota-provider-state`;

    sentinel(
      `${UPSTREAM_CACHE_DIR}/quota-provider-state/upstream.json`,
      '{"upstream":"provider-cache"}',
    );
    sentinel(
      `${UPSTREAM_CACHE_DIR}/modelsdev-pricing.runtime.min.json`,
      '{"upstream":"pricing-snapshot"}',
    );
    sentinel(
      `${UPSTREAM_CACHE_DIR}/modelsdev-pricing.refresh-state.json`,
      '{"upstream":"pricing-refresh"}',
    );
    sentinel(
      `${UPSTREAM_CACHE_DIR}/google-access-tokens.json`,
      '{"version":1,"entries":{"alice@example.com":"pii"}}',
    );
    sentinel(`${UPSTREAM_STATE_DIR}/quota-reset-notifications.json`, '{"upstream":"reset-state"}');
    sentinel(
      `${UPSTREAM_STATE_DIR}/alibaba-coding-plan-local-quota.json`,
      '{"upstream":"alibaba-state"}',
    );
    sentinel(`${UPSTREAM_STATE_DIR}/quota-providers/local.json`, '{"upstream":"local-estimate"}');
    sentinel(`${UPSTREAM_STATE_DIR}/resolved-auth-key-v1`, "v1:upstream-private-key\n");
    sentinel(
      `${UPSTREAM_STATE_DIR}/maintainer-announcements-home.json`,
      '{"upstream":"home-notice"}',
    );
    sentinel(`${PREVIOUS_GUI_CACHE_DIR}/previous-gui.json`, '{"previous":"gui-cache"}');

    await writeSentinels();
  });

  afterEach(async () => {
    if (TEST_RUNTIME_ROOT) {
      await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
    }
    runtimePaths.root = "";
  });

  it("points every active private path at opencode-quota-gui", async () => {
    const quotaState = await import("../src/lib/quota-state.js");
    const pricing = await import("../src/lib/modelsdev-pricing.js");
    const local = await import("../src/lib/quota-providers-local.js");
    const alibaba = await import("../src/lib/alibaba-coding-plan-local-quota.js");
    const identity = await import("../src/lib/resolved-auth-identity.js");
    const quotaExport = await import("../src/lib/quota-export.js");
    const privatePaths = await import("../src/lib/private-state-paths.js");

    expect(quotaState.getQuotaProviderStateCacheFilePath("synthetic", "key")).toMatch(
      /[\\/]cache[\\/]opencode-quota-gui[\\/]quota-provider-state[\\/]synthetic-[a-f0-9]{64}\.json$/u,
    );
    expect(pricing.getRuntimePricingSnapshotPath()).toMatch(
      /[\\/]cache[\\/]opencode-quota-gui[\\/]modelsdev-pricing\.runtime\.min\.json$/u,
    );
    expect(pricing.getRuntimePricingRefreshStatePath()).toMatch(
      /[\\/]cache[\\/]opencode-quota-gui[\\/]modelsdev-pricing\.refresh-state\.json$/u,
    );
    expect(local.getLocalQuotaProviderStatePath("custom")).toMatch(
      /[\\/]state[\\/]opencode-quota-gui[\\/]quota-providers[\\/]custom\.json$/u,
    );
    expect(alibaba.getAlibabaCodingPlanQuotaPath()).toMatch(
      /[\\/]state[\\/]opencode-quota-gui[\\/]alibaba-coding-plan-local-quota\.json$/u,
    );
    expect(identity.getResolvedAuthIdentityKeyPath()).toMatch(
      /[\\/]state[\\/]opencode-quota-gui[\\/]resolved-auth-key-v1$/u,
    );
    expect(quotaExport.resolveExportPath("")).toMatch(
      /[\\/]cache[\\/]opencode-quota-gui[\\/]quota-export\.json$/u,
    );
    expect(privatePaths.getMaintainerAnnouncementsHomeStatePath()).toMatch(
      /[\\/]state[\\/]opencode-quota-gui[\\/]maintainer-announcements-home\.json$/u,
    );
    expect(privatePaths.getQuotaResetNotificationsStatePath()).toMatch(
      /[\\/]state[\\/]opencode-quota-gui[\\/]quota-reset-notifications\.json$/u,
    );
  });

  it("writes active caches under the GUI namespace without touching upstream sentinels", async () => {
    const quotaState = await import("../src/lib/quota-state.js");
    quotaState.__resetQuotaStateForTests();
    const provider = createProvider();
    await quotaState.fetchQuotaProviderResult({
      provider,
      ctx: createTestContext(),
      ttlMs: 60_000,
    });
    await expect(access(`${CACHE_DIR}/opencode-quota-gui/quota-provider-state`)).resolves.toBe(
      undefined,
    );

    // Drop process memory, then re-open the persisted GUI cache from disk.
    quotaState.__resetQuotaStateForTests();
    await expect(
      quotaState.readCachedProviderResult({
        provider,
        ctx: createTestContext(),
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({
      hit: true,
      result: {
        entries: [{ accounting: TEST_ACCOUNTING, name: "Synthetic", percentRemaining: 55 }],
      },
    });

    const pricing = await import("../src/lib/modelsdev-pricing.js");
    const refresh = await pricing.maybeRefreshPricingSnapshot({
      nowMs: Date.now(),
      force: true,
      fetchFn: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            openai: { models: { "gui-model": { cost: { input: 1.25, output: 2.5 } } } },
          }),
          { status: 200 },
        ),
      ),
    });
    expect(refresh.updated).toBe(true);
    const pricingPath = pricing.getRuntimePricingSnapshotPath();
    await expect(access(pricingPath)).resolves.toBeUndefined();
    expect(dirname(pricingPath)).toBe(join(CACHE_DIR, "opencode-quota-gui"));

    // Drop process memory, then reload the persisted GUI pricing snapshot.
    pricing.__resetPricingSnapshotForTests();
    pricing.setPricingSnapshotSelection("runtime");
    expect(pricing.lookupCost("openai", "gui-model")).toEqual({ input: 1.25, output: 2.5 });

    const alibaba = await import("../src/lib/alibaba-coding-plan-local-quota.js");
    await alibaba.readAlibabaCodingPlanQuotaState({
      nowMs: Date.now(),
      readMessages: async () => [],
    });
    await expect(
      access(`${STATE_DIR}/opencode-quota-gui/alibaba-coding-plan-local-quota.json`),
    ).resolves.toBe(undefined);

    const local = await import("../src/lib/quota-providers-local.js");
    await local.syncLocalQuotaProviderState(
      {
        id: "local-test",
        providerId: "local-test",
        label: "Local test",
        mode: "local-estimate",
        windows: [{ id: "day", label: "Day", type: "utc-day", requestLimit: 10 }],
      },
      { nowMs: Date.now(), readMessages: async () => [] },
    );
    await expect(
      access(`${STATE_DIR}/opencode-quota-gui/quota-providers/local-test.json`),
    ).resolves.toBe(undefined);

    const reset = await import("../src/lib/quota-reset-notifications.js");
    await reset.observeQuotaResetNotifications({
      providers: [
        {
          providerId: "openai",
          result: {
            attempted: true,
            errors: [],
            entries: [
              {
                name: "OpenAI",
                label: "7d",
                percentRemaining: 12,
                resetTimeIso: new Date(Date.now() + 3_600_000).toISOString(),
                accounting: {
                  resultType: "quota",
                  acquisitionMethod: "remote_api",
                  ownership: "maintained",
                  authority: "provider_reported",
                },
              },
            ],
          },
        },
      ],
      windows: ["weekly"],
      nowMs: Date.now(),
    });
    await expect(
      access(`${STATE_DIR}/opencode-quota-gui/quota-reset-notifications.json`),
    ).resolves.toBe(undefined);

    // Process-memory only: the legacy upstream token cache is not read or deleted.
    const google = await import("../src/lib/google-token-cache.js");
    const key = google.makeAccountCacheKey({ refreshToken: "secret", projectId: "project" });
    await google.setCachedAccessToken({ key, entry: { accessToken: "token", expiresAt: 0 } });
    await expect(google.getCachedAccessToken({ key, skewMs: 0 })).resolves.toBeNull();
    await google.clearGoogleTokenCache();

    // A default export destination is GUI-owned as well.
    const quotaExport = await import("../src/lib/quota-export.js");
    const exportPath = quotaExport.resolveExportPath("");
    expect(exportPath).toContain("opencode-quota-gui");

    await expectSentinelsUnchanged();
  });
});
