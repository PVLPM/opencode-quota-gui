/**
 * P3B — outgoing provider-error privacy (design spec §9 R38/R51, plan P3
 * step 6).
 *
 * Every assertion runs against the actual mapped home DTO produced by
 * `createDashboardReadSource` with synthetic malicious inputs: credential
 * shapes, absolute paths, raw account ids, `rai1_` values, and raw
 * `statusDetails`/`rawDetails`/diagnostics dumps. Human labels stay; internal
 * ids and unredactable messages never do.
 */
import { describe, expect, it } from "vitest";

import type { UsageAnalyticsDataset } from "../src/gui/aggregation.js";
import {
  PROVIDER_ERROR_GENERIC_LABEL,
  PROVIDER_ERROR_GENERIC_MESSAGE,
} from "../src/gui/provider-cards.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import type { QuotaPercentEntry, QuotaProviderResult } from "../src/lib/entries.js";
import type { QuotaStatusLiveProbe } from "../src/lib/quota-render-data.js";
import { DEFAULT_CONFIG, type QuotaToastConfig } from "../src/lib/types.js";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

const RAW_ACCOUNT_ID = "raw-account-9000";
const RAW_IDENTITY_KEY = "raw-identity-0001";
const HUMAN_LABEL = "alice@example.com (Work)";
// JWT-shaped and opaque long values; both must be redacted.
const FAKE_JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhY2NvdW50LTkwMDAifQ.c2VjcmV0LXRva2VuLXZhbHVlLTEyMzQ1Njc4OT";
const RAI1_VALUE = "rai1_2f8a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a";
const ABSOLUTE_PATH = "C:\\Users\\secret-user\\.config\\opencode\\auth.json";
const POSIX_PATH = "/home/secret-user/.local/share/opencode/state.json";

const EMPTY_DATASET: UsageAnalyticsDataset = {
  sessions: {},
  projects: {},
  messages: [],
  compactions: [],
};

function percentEntry(params: {
  sourceId: string;
  name?: string;
  percentRemaining?: number;
}): QuotaPercentEntry {
  return {
    kind: "percent",
    name: params.name ?? "Weekly",
    percentRemaining: params.percentRemaining ?? 42,
    accounting: {
      resultType: "quota",
      acquisitionMethod: "remote_api",
      ownership: "maintained",
      authority: "provider_reported",
      sourceId: params.sourceId,
    },
    semantic: { metric: { kind: "window", window: "week" }, prominence: "primary" },
  };
}

function maliciousProbe(): QuotaStatusLiveProbe {
  const result: QuotaProviderResult = {
    attempted: true,
    accounts: [
      { sourceId: RAW_ACCOUNT_ID, identityKey: RAW_IDENTITY_KEY, label: HUMAN_LABEL, active: true },
    ],
    entries: [percentEntry({ sourceId: RAW_ACCOUNT_ID, name: "Weekly quota row" })],
    errors: [
      { label: "Credentials", message: `invalid credential Bearer ${FAKE_JWT}` },
      { label: "Config", message: `failed reading ${ABSOLUTE_PATH}` },
      { label: "State", message: `failed reading ${POSIX_PATH}` },
      { label: "Account", message: `lookup failed for ${RAW_ACCOUNT_ID}` },
      { label: "Token", message: `upstream returned ${RAI1_VALUE}` },
      { label: "Empty", message: "\u0000\u0001" },
      { label: ABSOLUTE_PATH, message: "provider reported an error" },
    ],
    statusDetails: [{ key: "apiKey", value: RAI1_VALUE }],
    rawDetails: [{ key: "path", value: ABSOLUTE_PATH }],
    diagnostics: [
      {
        sourceId: RAW_ACCOUNT_ID,
        providerId: "anthropic",
        mode: "remote-api",
        modelIds: null,
        apiKeyEnv: "ANTHROPIC_API_KEY",
        selected: true,
        attempted: true,
        credentialSource: "opencode_db",
        outcome: "http_error",
        entryCount: 0,
        checkedPaths: [ABSOLUTE_PATH],
        credentialDatabasePaths: [POSIX_PATH],
        statePath: ABSOLUTE_PATH,
      },
    ],
  };
  return { providerId: "anthropic", result };
}

function config(): QuotaToastConfig {
  return { ...DEFAULT_CONFIG, dashboard: { ...DEFAULT_CONFIG.dashboard } };
}

async function mappedHome() {
  const source = createDashboardReadSource({
    client: {
      config: {
        providers: async () => ({ data: { providers: [] } }),
        get: async () => ({ data: {} }),
      },
    },
    workspaceRoot: "C:/synthetic-workspace",
    configDir: "C:/synthetic-config",
    now: () => NOW,
    loadConfig: async () => config(),
    loadDataset: async () => EMPTY_DATASET,
    collectProviderResults: async () => [maliciousProbe()],
  });
  return source.home({ range: "7d" });
}

describe("gui privacy — outgoing provider errors", () => {
  it("scrubs credentials, redacts internal ids, and falls back to the generic message", async () => {
    const home = await mappedHome();
    const errors = home.providers.cards.flatMap((card) => card.errors);

    const byLabel = new Map(errors.map((error) => [error.label, error.message]));
    expect(byLabel.get("Credentials")).toContain("[redacted]");
    expect(byLabel.get("Credentials")).not.toContain("eyJ");
    expect(byLabel.get("Config")).toBe(PROVIDER_ERROR_GENERIC_MESSAGE);
    expect(byLabel.get("State")).toBe(PROVIDER_ERROR_GENERIC_MESSAGE);
    expect(byLabel.get("Account")).toBe("lookup failed for [redacted]");
    expect(byLabel.get("Token")).not.toContain("rai1_");
    expect(byLabel.get("Empty")).toBe(PROVIDER_ERROR_GENERIC_MESSAGE);
    expect(byLabel.has(ABSOLUTE_PATH)).toBe(false);
    expect(errors.some((error) => error.label === PROVIDER_ERROR_GENERIC_LABEL)).toBe(true);
  });

  it("never serializes raw ids, tokens, paths, or diagnostics dumps", async () => {
    const home = await mappedHome();
    const serialized = JSON.stringify(home);

    expect(serialized).not.toContain(RAW_ACCOUNT_ID);
    expect(serialized).not.toContain(RAW_IDENTITY_KEY);
    expect(serialized).not.toContain("eyJ");
    expect(serialized).not.toContain("rai1_");
    expect(serialized).not.toContain(FAKE_JWT);
    expect(serialized).not.toContain("secret-user");
    expect(serialized).not.toContain("auth.json");
    expect(serialized).not.toContain("state.json");
    expect(serialized).not.toContain("statusDetails");
    expect(serialized).not.toContain("rawDetails");
    expect(serialized).not.toContain("credentialDatabasePaths");
    expect(serialized).not.toContain("checkedPaths");
    expect(serialized).not.toContain("statePath");
    expect(serialized).not.toContain("ANTHROPIC_API_KEY");
  });

  it("keeps human account labels and opaque hashed ids while dropping no card", async () => {
    const home = await mappedHome();
    // Provider-scope card (unscoped errors) + the discovered account card.
    expect(home.providers.cards).toHaveLength(2);
    const card = home.providers.cards.find((item) => item.accountLabel === HUMAN_LABEL);
    expect(card).toBeDefined();
    expect(card?.accountLabel).toBe(HUMAN_LABEL);
    expect(card?.providerLabel).toBe("Anthropic");
    expect(card?.rows.map((row) => row.label)).toEqual(["Weekly quota"]);
    expect(card?.details).toBeUndefined();
    expect(card?.cardId.startsWith("anthropic:")).toBe(true);
    expect(card?.cardId).not.toContain(RAW_ACCOUNT_ID);
    expect(card?.rows[0]?.rowId.startsWith(card?.cardId ?? "")).toBe(true);
    expect(JSON.stringify(home)).toContain(HUMAN_LABEL);
  });
});
