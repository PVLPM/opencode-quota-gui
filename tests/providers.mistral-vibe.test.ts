/**
 * Mistral Vibe provider: account identity, row contract, visibility and
 * notification policy.
 *
 * The transport and credential discovery are mocked; every request path is
 * asserted through the provider result, and no credential value or private path
 * is ever reported.
 */
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const credentialMock = vi.hoisted(() => ({
  resolveMistralVibeCredentials: vi.fn(),
  hasMistralVibeCredential: vi.fn(),
}));

const queryMock = vi.hoisted(() => ({ queryMistralVibeQuota: vi.fn() }));

vi.mock("../src/lib/mistral-vibe-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mistral-vibe-auth.js")>()),
  resolveMistralVibeCredentials: credentialMock.resolveMistralVibeCredentials,
  hasMistralVibeCredential: credentialMock.hasMistralVibeCredential,
}));

vi.mock("../src/lib/mistral-vibe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mistral-vibe.js")>()),
  queryMistralVibeQuota: queryMock.queryMistralVibeQuota,
}));

import { optionalRowId } from "../src/contracts/identity.js";
import {
  MISTRAL_VIBE_API_BUDGET_ROW_KEY,
  MISTRAL_VIBE_BUDGET_ROW_KEY,
} from "../src/contracts/mistral-vibe-quota.js";
import { buildProviderCards } from "../src/gui/provider-cards.js";
import type { QuotaProviderContext, QuotaProviderResult } from "../src/lib/entries.js";
import type { MistralVibeCredential } from "../src/lib/mistral-vibe-auth.js";
import { mistralVibeIdentityKey } from "../src/lib/mistral-vibe-auth.js";
import { getQuotaProviderRegistration } from "../src/lib/provider-metadata.js";
import { mistralVibeProvider } from "../src/providers/mistral-vibe.js";

const NOW = Date.UTC(2026, 11, 2, 12, 0, 0);
const OBSERVED_AT_ISO = "2026-12-02T12:00:00.000Z";
const RESET_AT_ISO = "2027-01-01T00:00:00.000Z";

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

function credential(overrides: Partial<MistralVibeCredential> = {}): MistralVibeCredential {
  const key = overrides.key ?? "key-one";
  return {
    key,
    source: "vibe_dotenv",
    sourceId: "vibe-dotenv",
    identityKey: mistralVibeIdentityKey(key),
    label: "Mistral Vibe",
    ...overrides,
  };
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true as const,
    observedAtIso: OBSERVED_AT_ISO,
    vibeBudget: {
      usagePercentage: 42.5,
      initialBudget: 300,
      currency: "EUR",
      resetTimeIso: RESET_AT_ISO,
      paygEnabled: false,
    },
    subscription: {
      planLabel: "Pro",
      planName: "INDIVIDUAL",
      paygEnabled: false,
      vibePaygEnabled: false,
      enterprise: false,
    },
    ...overrides,
  };
}

async function fetchWith(params: {
  credentials: MistralVibeCredential[];
  results: Array<unknown>;
  checkedPaths?: string[];
  credentialDatabasePaths?: string[];
}): Promise<QuotaProviderResult> {
  credentialMock.resolveMistralVibeCredentials.mockResolvedValue({
    credentials: params.credentials,
    checkedPaths: params.checkedPaths ?? ["/tmp/vibe/.env"],
    credentialDatabasePaths: params.credentialDatabasePaths ?? [],
  });
  for (const [index, value] of params.results.entries()) {
    queryMock.queryMistralVibeQuota.mockResolvedValueOnce(value);
  }
  return await mistralVibeProvider.fetch(context());
}

describe("Mistral Vibe provider availability", () => {
  it("is available only when a credential resolves", async () => {
    credentialMock.hasMistralVibeCredential.mockResolvedValueOnce(false);
    expect(await mistralVibeProvider.isAvailable(context())).toBe(false);
    credentialMock.hasMistralVibeCredential.mockResolvedValueOnce(true);
    expect(await mistralVibeProvider.isAvailable(context())).toBe(true);
  });

  it("matches only Mistral models", () => {
    expect(mistralVibeProvider.matchesCurrentModel?.("mistral/mistral-large-latest")).toBe(true);
    expect(mistralVibeProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});

describe("Mistral Vibe rows", () => {
  it("emits the subscription budget with exact reset, currency basis and observation time", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [successResult()],
    });

    expect(result.attempted).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry).toMatchObject({
      name: "Mistral Vibe Vibe budget",
      label: "Vibe budget:",
      percentRemaining: 57.5,
      resetTimeIso: RESET_AT_ISO,
      resetPrecision: "exact",
      semantic: { metric: { kind: "named", name: "Vibe budget" }, prominence: "primary" },
      accounting: {
        resultType: "budget",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
        sourceId: "vibe-dotenv",
        observedAtIso: OBSERVED_AT_ISO,
      },
    });
    if (!("basis" in entry) || !entry.basis) throw new Error("expected a basis");
    expect(entry.basis.limit).toEqual({
      quantity: { decimal: "300", unit: { kind: "currency", code: "EUR" } },
      authority: "provider_reported",
    });
    expect(entry.basis.used?.quantity.decimal).toBe("127.5");
    expect(entry.basis.used?.authority).toBe("locally_derived");
    expect(entry.basis.remaining?.quantity.decimal).toBe("172.5");
  });

  it("shows the API budget as a supplementary row only when it is reported", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [
        successResult({
          apiBudget: {
            usagePercentage: 10,
            initialBudget: 50,
            currency: "EUR",
            resetTimeIso: RESET_AT_ISO,
            paygEnabled: true,
          },
        }),
      ],
    });

    expect(result.entries.map((entry) => entry.semantic)).toEqual([
      { metric: { kind: "named", name: "Vibe budget" }, prominence: "primary" },
      { metric: { kind: "named", name: "API budget" }, prominence: "supplementary" },
    ]);
  });

  it("omits the basis when the platform reports no currency", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [
        successResult({
          vibeBudget: {
            usagePercentage: 0,
            initialBudget: 0,
            currency: null,
            resetTimeIso: RESET_AT_ISO,
            paygEnabled: false,
          },
        }),
      ],
    });

    const [entry] = result.entries;
    expect(entry).toBeDefined();
    expect(entry && "basis" in entry ? entry.basis : undefined).toBeUndefined();
    expect(entry?.resetPrecision).toBe("exact");
  });

  it("omits the reset when the platform reports none", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [
        successResult({
          vibeBudget: {
            usagePercentage: 1,
            initialBudget: 10,
            currency: "EUR",
            paygEnabled: false,
          },
        }),
      ],
    });

    const [entry] = result.entries;
    expect(entry?.resetTimeIso).toBeUndefined();
    expect(entry?.resetPrecision).toBeUndefined();
  });
});

describe("Mistral Vibe accounts and identity", () => {
  it("keeps the plan label off identity and lists one account per credential", async () => {
    const first = credential({ key: "key-one", sourceId: "vibe-env", label: "Personal" });
    const second = credential({
      key: "key-two",
      sourceId: "row-2",
      label: "Work",
      source: "opencode.db",
      active: false,
    });

    const result = await fetchWith({
      credentials: [first, second],
      results: [successResult(), successResult({ subscription: undefined })],
    });

    expect(result.accounts).toEqual([
      {
        sourceId: "vibe-env",
        identityKey: first.identityKey,
        label: "Personal",
        planLabel: "Pro",
      },
      { sourceId: "row-2", identityKey: second.identityKey, label: "Work", active: false },
    ]);
    // The plan is display-only: it never changes the account identity.
    expect(result.accounts?.[0]?.identityKey).toBe(mistralVibeIdentityKey("key-one"));
    expect(result.entries.map((entry) => entry.accounting.sourceId)).toEqual(["vibe-env", "row-2"]);
  });

  it("keeps a failed account visible as its own card and error row", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [
        {
          success: false,
          error:
            "Mistral denied access to this account usage (HTTP 403): the credential is missing the see_org_inference_usage permission.",
          failureCategory: "credentials",
          httpStatus: 403,
        },
      ],
    });

    expect(result.entries).toEqual([]);
    expect(result.accounts).toHaveLength(1);
    expect(result.errors).toEqual([
      {
        label: "Mistral Vibe",
        message:
          "Mistral denied access to this account usage (HTTP 403): the credential is missing the see_org_inference_usage permission.",
        sourceId: "vibe-dotenv",
        failureCategory: "credentials",
      },
    ]);
  });

  it("reports a successful read with no budget as an unclassified state", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [successResult({ vibeBudget: undefined, subscription: undefined })],
    });

    expect(result.entries).toEqual([]);
    expect(result.errors).toEqual([
      {
        label: "Mistral Vibe",
        message: "Mistral reported no Vibe or API budget for this account.",
        sourceId: "vibe-dotenv",
      },
    ]);
    expect(result.errors[0]?.failureCategory).toBeUndefined();
  });

  it("attempts nothing without a credential", async () => {
    const result = await fetchWith({ credentials: [], results: [] });
    expect(result.attempted).toBe(false);
    expect(result.entries).toEqual([]);
  });
});

describe("Mistral Vibe diagnostics", () => {
  it("reports credential source kinds and counts without any absolute path", async () => {
    const home = path.join(os.tmpdir(), "fixture-home");
    const envPath = path.join(home, ".vibe", ".env");
    const databasePath = path.join(home, ".local", "share", "opencode", "opencode.db");

    const result = await fetchWith({
      credentials: [
        credential({ source: "env", sourceId: "vibe-env" }),
        credential({
          key: "key-two",
          source: "opencode.db",
          sourceId: "credential-row-1",
          label: "Mistral Vibe 2",
        }),
      ],
      results: [successResult(), successResult()],
      checkedPaths: [envPath],
      credentialDatabasePaths: [databasePath],
    });

    expect(result.statusDetails).toEqual([
      { key: "credential_count", value: "2" },
      { key: "credential_sources", value: "env | opencode.db" },
      { key: "credential_source_counts", value: "env=1 | vibe_dotenv=0 | opencode.db=1" },
    ]);

    // The cache and the JSON export persist every status detail, so neither the
    // fixture home directory nor a path separator may appear anywhere.
    const serialized = JSON.stringify(result.statusDetails);
    expect(serialized).not.toContain(home);
    expect(serialized).not.toContain(os.tmpdir());
    expect(serialized).not.toContain(path.sep);
    expect(serialized).not.toContain("vibe_env_path");
    expect(serialized).not.toContain("credential_database_paths");
    expect(JSON.stringify(result)).not.toContain(envPath);
    expect(JSON.stringify(result)).not.toContain(databasePath);
  });

  it("enumerates every source kind with zero counts when nothing resolves", async () => {
    const result = await fetchWith({ credentials: [], results: [] });

    expect(result.statusDetails).toEqual([
      { key: "credential_count", value: "0" },
      { key: "credential_sources", value: "(none)" },
      { key: "credential_source_counts", value: "env=0 | vibe_dotenv=0 | opencode.db=0" },
    ]);
  });
});

describe("Mistral Vibe visibility and notification policy", () => {
  it("emits exactly the declared optional Visibility rows", async () => {
    const result = await fetchWith({
      credentials: [credential()],
      results: [
        successResult({
          apiBudget: {
            usagePercentage: 10,
            initialBudget: 50,
            currency: "EUR",
            resetTimeIso: RESET_AT_ISO,
            paygEnabled: true,
          },
        }),
      ],
    });
    const cards = buildProviderCards({
      probes: [{ providerId: "mistral", result }],
      preferences: { accountingDetail: "detailed" },
      nowMs: NOW,
    });
    const card = cards[0];
    expect(card).toBeDefined();
    const rowIds = new Set(card?.rows.map((row) => row.rowId) ?? []);

    const declared = getQuotaProviderRegistration("mistral")?.optionalVisibilityRows ?? [];
    expect(declared.map((row) => row.rowKey)).toEqual([
      MISTRAL_VIBE_BUDGET_ROW_KEY,
      MISTRAL_VIBE_API_BUDGET_ROW_KEY,
    ]);
    for (const row of declared) {
      expect(row.rowKey.startsWith("named:")).toBe(true);
      const declaredId = optionalRowId(card!.cardId, row.rowKey, row.resultType, row.kind);
      expect(rowIds.has(declaredId), `${row.rowKey} -> ${declaredId}`).toBe(true);
    }
  });

  it("keeps budget rows outside the low/exhausted notification policy", async () => {
    // Same policy outcome as OpenCode Zen's budget meter: only `quota` and
    // `rate_limit` percent rows alarm, so a budget row never does.
    const result = await fetchWith({
      credentials: [credential()],
      results: [
        successResult({
          vibeBudget: {
            usagePercentage: 99.5,
            initialBudget: 300,
            currency: "EUR",
            resetTimeIso: RESET_AT_ISO,
            paygEnabled: false,
          },
        }),
      ],
    });
    const card = buildProviderCards({
      probes: [{ providerId: "mistral", result }],
      preferences: { accountingDetail: "summary" },
      nowMs: NOW,
    })[0];
    expect(card?.rows[0]?.resultType).toBe("budget");
    expect(card?.rows[0]?.kind).toBe("percent");
  });
});
