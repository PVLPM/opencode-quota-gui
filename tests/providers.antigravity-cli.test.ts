/**
 * Antigravity CLI provider: row identity, failure states, notification
 * eligibility and compatibility with the existing Google AGY companion.
 *
 * The CLI reader is mocked; no test starts the real `agy` binary.
 */
import { describe, expect, it, vi } from "vitest";

const cliMock = vi.hoisted(() => ({
  readAgyUsage: vi.fn(),
  resolveAgyBinaryPath: vi.fn(),
}));

vi.mock("../src/lib/antigravity-cli.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/antigravity-cli.js")>()),
  readAgyUsage: cliMock.readAgyUsage,
  resolveAgyBinaryPath: cliMock.resolveAgyBinaryPath,
}));

import { buildProviderCards } from "../src/gui/provider-cards.js";
import {
  type DetectQuotaNotificationsInput,
  detectQuotaNotifications,
} from "../src/gui/quota-notification-detector.js";
import type { QuotaProviderContext, QuotaProviderResult } from "../src/lib/entries.js";
import { DEFAULT_NATIVE_QUOTA_NOTIFICATION_POLICY } from "../src/lib/types.js";
import {
  ANTIGRAVITY_CLI_PROVIDER_ID,
  antigravityCliProvider,
  antigravityCliRowKey,
} from "../src/providers/antigravity-cli.js";

const NOW = Date.UTC(2026, 11, 2, 12, 0, 0);
const OBSERVED_AT_ISO = "2026-12-02T12:00:00.000Z";
const RESET_AT_ISO = "2026-12-04T21:40:30.000Z";

const POLICY = { ...DEFAULT_NATIVE_QUOTA_NOTIFICATION_POLICY, duplicateCooldownMinutes: 0 };

function context(): QuotaProviderContext {
  return {
    workspaceRoot: "/workspace",
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    resolveRuntimeProviderIds: async () => new Set<string>(),
    config: { enabledProviders: "auto", cursorPlan: "pro" },
  } as QuotaProviderContext;
}

function bucket(overrides: Record<string, unknown> = {}) {
  return {
    groupName: "Gemini Models",
    bucketId: "gemini-weekly",
    label: "Weekly",
    window: "weekly",
    percentRemaining: 100,
    resetTimeIso: RESET_AT_ISO,
    ...overrides,
  };
}

async function fetchWith(read: unknown): Promise<QuotaProviderResult> {
  cliMock.readAgyUsage.mockResolvedValueOnce(read);
  return await antigravityCliProvider.fetch(context());
}

/** Cards for one provider result, structurally accepted by the pure detector. */
function cardsFor(result: QuotaProviderResult, percentRemaining?: number) {
  const probes = [
    {
      providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
      result:
        percentRemaining === undefined
          ? result
          : {
              ...result,
              entries: result.entries.map((entry) => ({ ...entry, percentRemaining })),
            },
    },
  ];
  return buildProviderCards({
    probes,
    preferences: { accountingDetail: "summary" },
    nowMs: NOW,
  });
}

function detect(input: Partial<DetectQuotaNotificationsInput> & { nowMs: number }) {
  return detectQuotaNotifications({
    cards: [],
    policy: POLICY,
    ...input,
  });
}

describe("Antigravity CLI availability", () => {
  it("is available when the binary resolves and not otherwise", async () => {
    cliMock.resolveAgyBinaryPath.mockResolvedValueOnce("/usr/local/bin/agy");
    expect(await antigravityCliProvider.isAvailable(context())).toBe(true);
    cliMock.resolveAgyBinaryPath.mockResolvedValueOnce(null);
    expect(await antigravityCliProvider.isAvailable(context())).toBe(false);
    cliMock.resolveAgyBinaryPath.mockRejectedValueOnce(new Error("fs failure"));
    expect(await antigravityCliProvider.isAvailable(context())).toBe(false);
  });

  it("never claims the current OpenCode model selection", () => {
    expect(antigravityCliProvider.matchesCurrentModel?.("google/gemini-3-pro")).toBe(false);
    expect(antigravityCliProvider.matchesCurrentModel?.("anthropic/claude-opus-4-5")).toBe(false);
  });
});

describe("Antigravity CLI rows", () => {
  it("keys every row by its provider bucket id and keeps exact resets", async () => {
    const result = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [
        bucket(),
        bucket({
          groupName: "Claude and GPT models",
          bucketId: "3p-5h",
          label: "5h",
          window: "5h",
          percentRemaining: 80,
          resetTimeIso: undefined,
        }),
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(2);
    const [weekly, fiveHour] = result.entries;
    expect(weekly).toMatchObject({
      name: "Gemini Models Weekly",
      group: "Gemini Models",
      label: "Weekly:",
      rowKey: "named:gemini-weekly",
      percentRemaining: 100,
      resetTimeIso: RESET_AT_ISO,
      resetPrecision: "exact",
      accounting: {
        resultType: "quota",
        acquisitionMethod: "local_cli",
        ownership: "maintained",
        authority: "provider_reported",
        observedAtIso: OBSERVED_AT_ISO,
      },
    });
    expect(fiveHour?.rowKey).toBe("named:3p-5h");
    // Epoch-zero resets are absent, so no precision claim is made for them.
    expect(fiveHour?.resetTimeIso).toBeUndefined();
    expect(fiveHour?.resetPrecision).toBeUndefined();
  });

  it("derives the row key from the bucket id only", () => {
    expect(antigravityCliRowKey({ bucketId: "gemini-weekly" })).toBe("named:gemini-weekly");
    expect(antigravityCliRowKey({ bucketId: "3p-weekly" })).not.toBe(
      antigravityCliRowKey({ bucketId: "3p-5h" }),
    );
  });
});

describe("Antigravity CLI states", () => {
  it("reports the unsupported-version state with the required minimum", async () => {
    const result = await fetchWith({ state: "unsupported-version", version: "1.1.10" });

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([
      {
        label: "Antigravity CLI",
        message:
          "Antigravity CLI 1.1.10 is older than the required 1.1.11. Update agy to read quota.",
        failureCategory: "local",
      },
    ]);
  });

  it("reports exit 2 as a visible no-quota state, not a crash and not a notifiable failure", async () => {
    const result = await fetchWith({ state: "no-quota" });

    expect(result.attempted).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("reports no account quota");
    expect(result.errors[0]?.failureCategory).toBeUndefined();
  });

  it("passes a provider API failure through with its category", async () => {
    const result = await fetchWith({
      state: "error",
      message: "Antigravity CLI error: model not available",
      failureCategory: "provider_api",
      exitCode: 1,
    });

    expect(result.errors).toEqual([
      {
        label: "Antigravity CLI",
        message: "Antigravity CLI error: model not available",
        failureCategory: "provider_api",
      },
    ]);
    expect(result.statusDetails).toContainEqual({ key: "cli_exit_code", value: "1" });
  });

  it("attempts nothing when the binary is not installed", async () => {
    const result = await fetchWith({ state: "not-installed" });
    expect(result.attempted).toBe(false);
    expect(result.entries).toEqual([]);
  });
});

describe("Antigravity CLI notifications and companion compatibility", () => {
  it("raises low and exhausted notifications for its quota rows", async () => {
    const healthy = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [bucket({ percentRemaining: 100 })],
    });
    const low = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [bucket({ percentRemaining: 5 })],
    });
    const empty = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [bucket({ percentRemaining: 0 })],
    });

    const first = detect({ cards: cardsFor(healthy), nowMs: NOW });
    expect(first.notifications).toEqual([]);

    const second = detect({
      cards: cardsFor(low),
      state: first.state,
      cooldowns: first.cooldowns,
      nowMs: NOW + 60_000,
    });
    expect(second.notifications.map((notification) => notification.kind)).toEqual(["low"]);
    expect(second.notifications[0]).toMatchObject({
      providerId: ANTIGRAVITY_CLI_PROVIDER_ID,
      rowLabel: "Weekly",
      thresholdPercent: 10,
      percentRemaining: 5,
    });

    const third = detect({
      cards: cardsFor(empty),
      state: second.state,
      cooldowns: second.cooldowns,
      nowMs: NOW + 120_000,
    });
    expect(third.notifications.map((notification) => notification.kind)).toEqual(["exhausted"]);
  });

  it("does not claim a reset notification without a typed window", async () => {
    // AGY bucket rows carry an explicit row key, not a window metric, so the
    // reset policy cannot prove a boundary and stays silent (same as the
    // existing google-agy companion rows).
    const before = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [bucket({ percentRemaining: 20, resetTimeIso: "2026-12-03T00:00:00.000Z" })],
    });
    const after = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [bucket({ percentRemaining: 100, resetTimeIso: "2026-12-10T00:00:00.000Z" })],
    });

    const first = detect({ cards: cardsFor(before), nowMs: NOW });
    const second = detect({
      cards: cardsFor(after),
      state: first.state,
      cooldowns: first.cooldowns,
      nowMs: NOW + 60_000,
    });
    expect(second.notifications).toEqual([]);
  });

  it("stays a separate card from the Google AGY companion", async () => {
    const cliResult = await fetchWith({
      state: "ok",
      observedAtIso: OBSERVED_AT_ISO,
      buckets: [bucket()],
    });
    const companionResult: QuotaProviderResult = {
      attempted: true,
      entries: [
        {
          accounting: {
            resultType: "quota",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
            sourceId: "account-1",
          },
          name: "Gemini Models (Google account)",
          group: "AGY (Google account): Gemini",
          label: "Weekly:",
          rowKey: "named:Gemini Models weekly",
          percentRemaining: 100,
        },
      ],
      errors: [],
      accounts: [{ sourceId: "account-1", label: "Google account" }],
    };

    const cards = buildProviderCards({
      probes: [
        { providerId: "google-agy", result: companionResult },
        { providerId: ANTIGRAVITY_CLI_PROVIDER_ID, result: cliResult },
      ],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    });

    expect(cards.map((card) => card.providerId)).toEqual([
      "google-agy",
      ANTIGRAVITY_CLI_PROVIDER_ID,
    ]);
    const companionCardIds = cards
      .find((card) => card.providerId === "google-agy")
      ?.rows.map((row) => row.rowId);
    // The companion row keeps its own byte-identical id.
    expect(companionCardIds?.[0]?.endsWith("#named:Gemini Models weekly|quota:percent")).toBe(true);
    const cliCardIds = cards
      .find((card) => card.providerId === ANTIGRAVITY_CLI_PROVIDER_ID)
      ?.rows.map((row) => row.rowId);
    expect(cliCardIds?.[0]?.endsWith("#named:gemini-weekly|quota:percent")).toBe(true);
    expect(cliCardIds?.[0]).not.toBe(companionCardIds?.[0]);
  });
});
