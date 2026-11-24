import { rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderResult, QuotaToastEntry } from "../src/lib/entries.js";
import type { QuotaRetryEvent } from "../src/lib/quota-retry-wait.js";
import {
  createConfigModuleMock,
  createPluginRuntimePathsMockModule,
  createProvidersRegistryModuleMock,
  makeQuotaToastTestConfig,
} from "./helpers/plugin-test-harness.js";

const TEST_RUNTIME_ROOT = "/tmp/opencode-quota-lib-quota-retry-wait-tests";
const NOW_MS = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE_MS = 60_000;
const TEST_ACCOUNTING = {
  resultType: "quota",
  acquisitionMethod: "remote_api",
  ownership: "maintained",
  authority: "provider_reported",
} as const;

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  getProviders: vi.fn(),
}));

vi.mock("../src/lib/config.js", () => createConfigModuleMock(mocks.loadConfig));
vi.mock("../src/providers/registry.js", () =>
  createProvidersRegistryModuleMock(mocks.getProviders),
);
vi.mock("../src/lib/opencode-runtime-paths.js", () =>
  createPluginRuntimePathsMockModule(TEST_RUNTIME_ROOT),
);

// Loaded after the mocks above are set up.
const {
  getQuotaResetRetryDelayMs,
  isQuotaLimitError,
  QUOTA_RESET_RETRY_BUFFER_MS,
  QUOTA_RESET_RETRY_MAX_DELAY_MS,
} = await import("../src/lib/quota-retry-wait.js");

function at(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

function window(name: string, percentRemaining: number, resetTimeIso?: string): QuotaToastEntry {
  return {
    accounting: TEST_ACCOUNTING,
    name,
    percentRemaining,
    ...(resetTimeIso ? { resetTimeIso } : {}),
  };
}

function result(entries: QuotaToastEntry[]): QuotaProviderResult {
  return { attempted: true, entries, errors: [] };
}

describe("isQuotaLimitError", () => {
  it("accepts OpenCode's quota-shaped errors and any HTTP 429", () => {
    for (const type of [
      "provider.rate-limit",
      "provider.quota",
      "provider.free-limit",
      "provider.budget-limit",
      "provider.model-budget-limit",
      "provider.go-limit",
      "provider.chatgpt-limit",
      "provider.chatgpt-workspace-limit",
    ]) {
      expect(isQuotaLimitError({ type })).toBe(true);
    }
    expect(isQuotaLimitError({ type: "provider.unknown", status: 429 })).toBe(true);
  });

  it("rejects other errors", () => {
    for (const type of ["provider.auth", "provider.transport", "provider.internal", "unknown"]) {
      expect(isQuotaLimitError({ type, status: 500 })).toBe(false);
    }
  });
});

describe("getQuotaResetRetryDelayMs", () => {
  it("waits until a used-up window resets, plus the buffer", () => {
    const delay = getQuotaResetRetryDelayMs(
      [result([window("5h", 0, at(90 * MINUTE_MS)), window("Weekly", 40, at(MINUTE_MS))])],
      NOW_MS,
    );
    expect(delay).toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("waits for the latest exhausted window when entries have no model metadata", () => {
    const delay = getQuotaResetRetryDelayMs(
      [
        result([window("5h", 0, at(90 * MINUTE_MS))]),
        result([window("Hourly", 0, at(20 * MINUTE_MS))]),
      ],
      NOW_MS,
    );
    expect(delay).toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("does not guess when another exhausted window has a missing or stale reset", () => {
    for (const reset of [undefined, at(-MINUTE_MS), "invalid"]) {
      expect(
        getQuotaResetRetryDelayMs(
          [result([window("5h", 0, at(90 * MINUTE_MS)), window("Weekly", 0, reset)])],
          NOW_MS,
        ),
      ).toBeUndefined();
    }
  });

  it("uses only the marked active account and refuses ambiguous accounts", () => {
    const entries = [
      {
        ...window("5h", 0, at(90 * MINUTE_MS)),
        accounting: { ...TEST_ACCOUNTING, sourceId: "active" },
      },
      {
        ...window("5h", 0, at(20 * MINUTE_MS)),
        accounting: { ...TEST_ACCOUNTING, sourceId: "other" },
      },
    ];
    const accounts = [
      { sourceId: "active", active: true },
      { sourceId: "other", active: false },
    ];
    expect(getQuotaResetRetryDelayMs([{ ...result(entries), accounts }], NOW_MS)).toBe(
      90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS,
    );
    expect(
      getQuotaResetRetryDelayMs(
        [{ ...result(entries), accounts: accounts.map(({ sourceId }) => ({ sourceId })) }],
        NOW_MS,
      ),
    ).toBeUndefined();
  });

  it("refuses a failed refresh or unknown percentage", () => {
    const good = window("5h", 0, at(MINUTE_MS));
    expect(
      getQuotaResetRetryDelayMs(
        [{ ...result([good]), errors: [{ label: "failed", message: "failed" }] }],
        NOW_MS,
      ),
    ).toBeUndefined();
    expect(
      getQuotaResetRetryDelayMs([result([good, window("Weekly", Number.NaN)])], NOW_MS),
    ).toBeUndefined();
  });

  it("caps the reset wait and adds the buffer after the cap", () => {
    const delay = getQuotaResetRetryDelayMs(
      [result([window("Weekly", 0, at(3 * 24 * 60 * MINUTE_MS))])],
      NOW_MS,
    );
    expect(delay).toBe(QUOTA_RESET_RETRY_MAX_DELAY_MS + QUOTA_RESET_RETRY_BUFFER_MS);
    expect(QUOTA_RESET_RETRY_MAX_DELAY_MS).toBe(5 * 60 * MINUTE_MS);
  });

  it("never lands the capped retry just before the reset", () => {
    // The reset is 30 seconds inside the five-hour cap: the old cap landed before it.
    const delay = getQuotaResetRetryDelayMs(
      [result([window("Weekly", 0, at(QUOTA_RESET_RETRY_MAX_DELAY_MS - 30_000))])],
      NOW_MS,
    );
    expect(delay).toBe(QUOTA_RESET_RETRY_MAX_DELAY_MS - 30_000 + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("waits for weekly when both weekly and 5h are exhausted", () => {
    expect(
      getQuotaResetRetryDelayMs(
        [
          result([
            window("5h", 0, at(60 * MINUTE_MS)),
            window("Weekly", 0, at(4 * 60 * MINUTE_MS)),
          ]),
        ],
        NOW_MS,
      ),
    ).toBe(4 * 60 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("has no delay without a used-up window whose reset is still ahead", () => {
    expect(getQuotaResetRetryDelayMs([], NOW_MS)).toBeUndefined();
    expect(
      getQuotaResetRetryDelayMs([result([window("5h", 3, at(90 * MINUTE_MS))])], NOW_MS),
    ).toBeUndefined();
    expect(
      getQuotaResetRetryDelayMs([result([window("5h", 0, at(-MINUTE_MS))])], NOW_MS),
    ).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([result([window("5h", 0, at(0))])], NOW_MS)).toBeUndefined();
    expect(getQuotaResetRetryDelayMs([result([window("5h", 0)])], NOW_MS)).toBeUndefined();
    expect(
      getQuotaResetRetryDelayMs([result([window("5h", 0, "not a date")])], NOW_MS),
    ).toBeUndefined();
    expect(
      getQuotaResetRetryDelayMs(
        [
          result([
            {
              kind: "value",
              accounting: TEST_ACCOUNTING,
              name: "Balance",
              value: "USD 0.00",
              resetTimeIso: at(MINUTE_MS),
            },
          ]),
        ],
        NOW_MS,
      ),
    ).toBeUndefined();
  });
});

describe("resolveQuotaResetRetryDelayMs", () => {
  const limitEvent: QuotaRetryEvent = {
    model: { id: "glm-4.6", providerID: "zai-coding-plan" },
    error: { type: "provider.quota", status: 429 },
  };

  function makeProvider(
    id: string,
    entries: QuotaToastEntry[],
    matches: (model: string) => boolean,
  ) {
    return {
      id,
      isAvailable: vi.fn().mockResolvedValue(true),
      matchesCurrentModel: vi.fn(matches),
      fetch: vi.fn().mockResolvedValue(result(entries)),
    };
  }

  function createHost() {
    return {
      client: {
        config: {
          get: async () => ({ data: {} }),
          providers: async () => ({ data: { providers: [{ id: "zai-coding-plan" }] } }),
        },
      },
      roots: {
        workspaceRoot: process.cwd(),
        configRoot: process.cwd(),
        fallbackDirectory: process.cwd(),
      },
    };
  }

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  });

  async function resolve(event: QuotaRetryEvent) {
    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    return resolveQuotaResetRetryDelayMs(createHost(), event);
  }

  it("waits for the used-up window of the retried model's provider only", async () => {
    const zai = makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], (model) =>
      model.includes("glm"),
    );
    const copilot = makeProvider(
      "copilot",
      [window("Monthly", 0, at(10 * MINUTE_MS))],
      () => false,
    );
    mocks.getProviders.mockReturnValue([zai, copilot]);
    // waitForQuotaReset is on by default.
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig());

    await expect(resolve(limitEvent)).resolves.toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
    expect(zai.fetch).toHaveBeenCalledTimes(1);
    expect(copilot.fetch).not.toHaveBeenCalled();
  });

  it("uses OpenCode's active credential rather than another integration's marker", async () => {
    const { bindCredentialSource } = await import("../src/lib/opencode-auth.js");
    const release = bindCredentialSource({
      kind: "opencode-integration-api",
      readRows: async () => [
        {
          id: "current",
          integrationId: "zai-coding-plan",
          label: "",
          active: true,
          value: {},
        },
      ],
    });
    try {
      const entries = [
        {
          ...window("5h", 0, at(90 * MINUTE_MS)),
          accounting: { ...TEST_ACCOUNTING, sourceId: "current" },
        },
        {
          ...window("5h", 0, at(20 * MINUTE_MS)),
          accounting: { ...TEST_ACCOUNTING, sourceId: "other" },
        },
      ];
      const provider = makeProvider("zai", entries, () => true);
      provider.fetch.mockResolvedValue({
        ...result(entries),
        accounts: [
          { sourceId: "current", active: true },
          { sourceId: "other", active: true },
        ],
      });
      mocks.getProviders.mockReturnValue([provider]);
      mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig());
      await expect(resolve(limitEvent)).resolves.toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
    } finally {
      release();
    }
  });

  it("asks the provider for fresh quota on every limit error instead of reusing the cache", async () => {
    // A cacheable provider and a long minIntervalMs: a normal refresh would reuse the first result.
    const zai = {
      ...makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], () => true),
      cachePolicy: { kind: "account-neutral" },
    };
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ minIntervalMs: 60 * MINUTE_MS }));

    const { resolveQuotaResetRetryDelayMs } = await import("../src/lib/quota-retry-wait.js");
    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(resolveQuotaResetRetryDelayMs(createHost(), limitEvent)).resolves.toBe(
        90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS,
      );
      expect(zai.fetch).toHaveBeenCalledTimes(attempt);
    }
  });

  it("keeps OpenCode's decision when the setting is off", async () => {
    const zai = makeProvider("zai", [window("5h", 0, at(90 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ waitForQuotaReset: false }));

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
    expect(zai.fetch).not.toHaveBeenCalled();
  });

  it("keeps OpenCode's decision for errors that are not limits, without reading config", async () => {
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ waitForQuotaReset: true }));

    await expect(
      resolve({ ...limitEvent, error: { type: "provider.transport" } }),
    ).resolves.toBeUndefined();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("leaves an untyped Claude Agent five-hour limit error unchanged", async () => {
    const error = new Error(
      "You've hit your 5-hour limit · resets 4:10am (Europe/Istanbul)\nResets at 2026-11-23T01:10:00.000Z.",
    );
    await expect(
      resolve({
        model: { id: "claude-sonnet", providerID: "claude-agent" },
        error: error as unknown as QuotaRetryEvent["error"],
      }),
    ).resolves.toBeUndefined();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("keeps OpenCode's decision when the provider still has quota left", async () => {
    const zai = makeProvider("zai", [window("5h", 12, at(90 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ waitForQuotaReset: true }));

    await expect(resolve(limitEvent)).resolves.toBeUndefined();
  });

  it("waits at least as long as the provider's retryAfterMs", async () => {
    const zai = makeProvider("zai", [window("5h", 0, at(10 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([zai]);
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ waitForQuotaReset: true }));

    await expect(
      resolve({
        ...limitEvent,
        error: { type: "provider.rate-limit", status: 429, retryAfterMs: 20 * MINUTE_MS },
      }),
    ).resolves.toBe(20 * MINUTE_MS);
    // A shorter provider wait never shortens the observed reset wait.
    await expect(
      resolve({
        ...limitEvent,
        error: { type: "provider.rate-limit", status: 429, retryAfterMs: 5 * MINUTE_MS },
      }),
    ).resolves.toBe(10 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("recognizes ChatGPT subscription limits when a window is exhausted", async () => {
    const openai = makeProvider("openai", [window("Weekly", 0, at(90 * MINUTE_MS))], () => true);
    mocks.getProviders.mockReturnValue([openai]);
    mocks.loadConfig.mockResolvedValue(makeQuotaToastTestConfig({ waitForQuotaReset: true }));

    await expect(
      resolve({
        ...limitEvent,
        model: { id: "gpt-5", providerID: "openai" },
        error: { type: "provider.chatgpt-limit" },
      }),
    ).resolves.toBe(90 * MINUTE_MS + QUOTA_RESET_RETRY_BUFFER_MS);
  });

  it("bounds a hanging live probe by the configured request timeout", async () => {
    const hanging = makeProvider("zai", [], () => true);
    hanging.fetch.mockReturnValue(new Promise(() => {}));
    mocks.getProviders.mockReturnValue([hanging]);
    mocks.loadConfig.mockResolvedValue(
      makeQuotaToastTestConfig({ waitForQuotaReset: true, requestTimeoutMs: 25 }),
    );
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const pending = resolve(limitEvent);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
