import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialRow } from "../src/lib/opencode-auth.js";
import { getCredentialDatabasePaths, readCredentialRows } from "../src/lib/opencode-auth.js";
import {
  hasOpenRouterApiKeyConfigured,
  queryOpenRouterQuota,
  resolveOpenRouterApiKey,
  resolveOpenRouterAuth,
  resolveOpenRouterAuthIdentity,
} from "../src/lib/openrouter.js";
import {
  fetchRemoteQuotaProvider,
  type QuotaProviderAuthResolution,
  type QuotaProviderAuthSource,
  resolveQuotaProviderApiKey,
} from "../src/lib/quota-providers-remote.js";
import {
  composeResolvedAuthIdentities,
  deriveResolvedAuthIdentity,
} from "../src/lib/resolved-auth-identity.js";

vi.mock("../src/lib/quota-providers-remote.js", () => ({
  fetchRemoteQuotaProvider: vi.fn(),
  resolveQuotaProviderApiKey: vi.fn(),
}));

vi.mock("../src/lib/resolved-auth-identity.js", () => ({
  deriveResolvedAuthIdentity: vi.fn(async () => `rai1_${"a".repeat(43)}`),
  composeResolvedAuthIdentities: vi.fn(async () => `rai1_${"b".repeat(43)}`),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/opencode-auth.js")>();
  return {
    ...actual,
    readCredentialRows: vi.fn(),
    getCredentialDatabasePaths: vi.fn(() => ["/tmp/opencode.db"]),
  };
});

vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api-key-resolver.js")>();
  return {
    ...actual,
    getApiKeyCheckedPaths: vi.fn(() => ["env:OPENROUTER_API_KEY", "/tmp/opencode.jsonc"]),
    getGlobalOpencodeConfigCandidatePaths: vi.fn(() => [
      { path: "/tmp/opencode.jsonc", isJsonc: true },
    ]),
  };
});

const OPENROUTER_KEY_SOURCE = {
  id: "openrouter",
  providerId: "openrouter",
  label: "OpenRouter",
  mode: "remote-api",
  url: "https://openrouter.ai/api/v1/key",
  apiKeyEnv: "OPENROUTER_API_KEY",
  format: "openrouter-key-v1",
} as const;

const SECRET_CANARY = "openrouter-secret-canary";
const SECOND_SECRET = "openrouter-second-secret-canary";
const CHECKED_PATHS = ["env:OPENROUTER_API_KEY", "/tmp/opencode.jsonc"];
const DATABASE_PATHS = ["/tmp/opencode.db"];
const CREDENTIAL_SOURCES: QuotaProviderAuthSource[] = [
  "env",
  "opencode.json",
  "opencode.jsonc",
  "opencode.db",
];

function resolvedAuth(
  overrides: Partial<QuotaProviderAuthResolution> = {},
): QuotaProviderAuthResolution {
  return {
    source: null,
    checkedPaths: [],
    credentialDatabasePaths: [],
    ...overrides,
  };
}

function fallbackResolution(
  overrides: Partial<QuotaProviderAuthResolution> = {},
): QuotaProviderAuthResolution {
  return resolvedAuth({
    checkedPaths: CHECKED_PATHS,
    credentialDatabasePaths: DATABASE_PATHS,
    ...overrides,
  });
}

function storedResolution(key: string): QuotaProviderAuthResolution {
  return resolvedAuth({
    key,
    source: "opencode.db",
    checkedPaths: CHECKED_PATHS,
    credentialDatabasePaths: DATABASE_PATHS,
  });
}

function keyRow(id: string, label: string, key: string, active = false): CredentialRow {
  return {
    id,
    integrationId: "openrouter",
    label,
    active,
    value: { type: "api", key },
  };
}

function failedRow(id: string, label: string, resolveError: string): CredentialRow {
  return {
    id,
    integrationId: "openrouter",
    label,
    active: false,
    value: { type: "api" },
    resolveError,
  };
}

beforeEach(() => {
  vi.mocked(readCredentialRows).mockResolvedValue([]);
  vi.mocked(getCredentialDatabasePaths).mockReturnValue(DATABASE_PATHS);
  vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(fallbackResolution());
  vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({ success: true, entries: [] });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter auth resolution", () => {
  it("prefers all suitable stored API-key rows over env/config and keeps aliases account-local", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      keyRow("row_work", "Work", SECRET_CANARY, true),
      keyRow("row_personal", "Personal", SECOND_SECRET),
    ]);
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(
      fallbackResolution({ key: "env-secret", source: "env" }),
    );

    const auth = await resolveOpenRouterAuth();

    expect(readCredentialRows).toHaveBeenCalledWith(["openrouter"], { methods: ["key"] });
    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(auth).toEqual({
      accounts: [
        {
          sourceId: "row_work",
          label: "Work",
          groupLabel: "[OpenRouter Work] (active)",
          active: true,
          resolved: storedResolution(SECRET_CANARY),
        },
        {
          sourceId: "row_personal",
          label: "Personal",
          groupLabel: "[OpenRouter Personal]",
          active: false,
          resolved: storedResolution(SECOND_SECRET),
        },
      ],
      checkedPaths: CHECKED_PATHS,
      credentialDatabasePaths: DATABASE_PATHS,
      source: "opencode.db",
    });
  });

  it("falls back to env/config only when no stored API-key row can be used", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(
      fallbackResolution({ key: "env-secret", source: "env" }),
    );

    const auth = await resolveOpenRouterAuth();

    expect(resolveQuotaProviderApiKey).toHaveBeenCalledWith(OPENROUTER_KEY_SOURCE);
    expect(auth).toEqual({
      accounts: [
        {
          label: "OpenRouter",
          groupLabel: "OpenRouter",
          resolved: fallbackResolution({ key: "env-secret", source: "env" }),
        },
      ],
      checkedPaths: CHECKED_PATHS,
      credentialDatabasePaths: DATABASE_PATHS,
      source: "env",
    });
  });

  it("uses plain Account N labels for generic or unnamed stored aliases", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      keyRow("row_a", "default", SECRET_CANARY),
      keyRow("row_b", "  ", SECOND_SECRET),
      keyRow("row_c", "openrouter", "third-secret-canary"),
    ]);

    const auth = await resolveOpenRouterAuth();

    expect(auth.accounts.map((account) => account.label)).toEqual([
      "Account 1",
      "Account 2",
      "Account 3",
    ]);
    expect(auth.accounts.map((account) => account.groupLabel)).toEqual([
      "[OpenRouter]",
      "[OpenRouter]",
      "[OpenRouter]",
    ]);
  });

  it("keeps a failed stored login account-local and still uses the env fallback", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      failedRow("row_failed", "Broken", "refresh_failed: denied"),
    ]);
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(
      fallbackResolution({ key: "env-secret", source: "opencode.jsonc" }),
    );

    const auth = await resolveOpenRouterAuth();

    expect(auth.accounts).toEqual([
      {
        sourceId: "row_failed",
        label: "Broken",
        groupLabel: "[OpenRouter Broken]",
        active: false,
        error: "OpenCode could not read this login: refresh_failed: denied",
      },
      {
        label: "OpenRouter",
        groupLabel: "OpenRouter",
        resolved: fallbackResolution({ key: "env-secret", source: "opencode.jsonc" }),
      },
    ]);
    expect(auth.source).toBe("opencode.jsonc");
  });

  it("keeps a failed stored login visible next to a usable stored key without reading env/config", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      keyRow("row_work", "Work", SECRET_CANARY, true),
      failedRow("row_failed", "Broken", "resolve_empty: no value"),
    ]);

    const auth = await resolveOpenRouterAuth();

    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(auth.accounts).toHaveLength(2);
    expect(auth.accounts[0]).toEqual(
      expect.objectContaining({
        sourceId: "row_work",
        label: "Work",
        groupLabel: "[OpenRouter Work] (active)",
      }),
    );
    expect(auth.accounts[1]).toEqual(
      expect.objectContaining({
        sourceId: "row_failed",
        label: "Broken",
        groupLabel: "[OpenRouter Broken]",
        error: "OpenCode could not read this login: resolve_empty: no value",
      }),
    );
    expect(auth.source).toBe("opencode.db");
  });

  it("returns no accounts or key when neither stored nor env/config credentials exist", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(fallbackResolution());

    const auth = await resolveOpenRouterAuth();

    expect(auth).toEqual({
      accounts: [],
      checkedPaths: CHECKED_PATHS,
      credentialDatabasePaths: DATABASE_PATHS,
      source: null,
    });
    await expect(hasOpenRouterApiKeyConfigured()).resolves.toBe(false);
    await expect(resolveOpenRouterApiKey()).resolves.toEqual(fallbackResolution());
  });

  it("keeps resolveOpenRouterApiKey compatibility by returning one effective stored key", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      keyRow("row_personal", "Personal", SECOND_SECRET),
      keyRow("row_work", "Work", SECRET_CANARY, true),
    ]);

    await expect(resolveOpenRouterApiKey()).resolves.toEqual(storedResolution(SECRET_CANARY));
    await expect(hasOpenRouterApiKeyConfigured()).resolves.toBe(true);
  });

  it("uses the standard OpenRouter credential sources and key endpoint for the fallback", async () => {
    await resolveOpenRouterApiKey();

    expect(resolveQuotaProviderApiKey).toHaveBeenCalledWith(OPENROUTER_KEY_SOURCE);
  });
});

function storedAccountDescriptor(overrides: {
  sourceId: string;
  label: string;
  groupLabel: string;
  active?: boolean;
}): string {
  return JSON.stringify({
    sourceId: overrides.sourceId,
    label: overrides.label,
    groupLabel: overrides.groupLabel,
    active: overrides.active ?? false,
    source: "opencode.db",
    state: "usable",
    error: null,
  });
}

describe("OpenRouter cache identity", () => {
  it("derives one identity from the single effective stored key with its account descriptor", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      keyRow("row_work", "Work", SECRET_CANARY, true),
    ]);

    const identity = await resolveOpenRouterAuthIdentity();

    expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECRET_CANARY },
      qualifiers: [
        storedAccountDescriptor({
          sourceId: "row_work",
          label: "Work",
          groupLabel: "[OpenRouter Work]",
          active: true,
        }),
      ],
    });
    expect(composeResolvedAuthIdentities).not.toHaveBeenCalled();
    expect(identity).not.toContain(SECRET_CANARY);
  });

  it("keeps the key-only identity for a single env/config fallback", async () => {
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(
      fallbackResolution({ key: SECRET_CANARY, source: "env" }),
    );

    const identity = await resolveOpenRouterAuthIdentity();

    expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECRET_CANARY },
    });
    expect(composeResolvedAuthIdentities).not.toHaveBeenCalled();
    expect(identity).not.toContain(SECRET_CANARY);
  });

  it("composes every effective stored key identity with its account descriptor", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      keyRow("row_work", "Work", SECRET_CANARY),
      keyRow("row_personal", "Personal", SECOND_SECRET),
    ]);

    const identity = await resolveOpenRouterAuthIdentity();

    // Source ids order the identities, so row_personal is hashed first.
    expect(deriveResolvedAuthIdentity).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deriveResolvedAuthIdentity).mock.calls[0]?.[0]).toEqual({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECOND_SECRET },
      qualifiers: [
        storedAccountDescriptor({
          sourceId: "row_personal",
          label: "Personal",
          groupLabel: "[OpenRouter Personal]",
        }),
      ],
    });
    expect(vi.mocked(deriveResolvedAuthIdentity).mock.calls[1]?.[0]).toEqual({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECRET_CANARY },
      qualifiers: [
        storedAccountDescriptor({
          sourceId: "row_work",
          label: "Work",
          groupLabel: "[OpenRouter Work]",
        }),
      ],
    });
    expect(composeResolvedAuthIdentities).toHaveBeenCalledWith({
      providerId: "openrouter",
      identities: [`rai1_${"a".repeat(43)}`, `rai1_${"a".repeat(43)}`],
    });
    expect(identity).toBe(`rai1_${"b".repeat(43)}`);
    expect(identity).not.toContain(SECRET_CANARY);
    expect(identity).not.toContain(SECOND_SECRET);
  });

  it("describes a failed stored login with its stable id, alias, and error", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      failedRow("row_failed", "Broken", "refresh_failed: denied"),
    ]);

    const identity = await resolveOpenRouterAuthIdentity();

    expect(identity).toBe(`rai1_${"a".repeat(43)}`);
    expect(deriveResolvedAuthIdentity).toHaveBeenCalledWith({
      providerId: "openrouter",
      principal: { kind: "stable-id", value: "account:row_failed" },
      qualifiers: [
        JSON.stringify({
          sourceId: "row_failed",
          label: "Broken",
          groupLabel: "[OpenRouter Broken]",
          active: false,
          source: null,
          state: "failed",
          error: "OpenCode could not read this login: refresh_failed: denied",
        }),
      ],
    });
  });

  it("changes the failed-account identity evidence when alias, source id, or error changes", async () => {
    const qualify = async (row: CredentialRow): Promise<string> => {
      vi.mocked(readCredentialRows).mockResolvedValue([row]);
      await resolveOpenRouterAuthIdentity();
      const call = vi.mocked(deriveResolvedAuthIdentity).mock.lastCall?.[0];
      return JSON.stringify(call);
    };

    const baseline = await qualify(failedRow("row_failed", "Broken", "refresh_failed: denied"));
    vi.mocked(deriveResolvedAuthIdentity).mockClear();
    const renamed = await qualify(failedRow("row_failed", "Renamed", "refresh_failed: denied"));
    vi.mocked(deriveResolvedAuthIdentity).mockClear();
    const reidentified = await qualify(failedRow("row_other", "Broken", "refresh_failed: denied"));
    vi.mocked(deriveResolvedAuthIdentity).mockClear();
    const failedDifferently = await qualify(
      failedRow("row_failed", "Broken", "refresh_failed: expired"),
    );

    expect(renamed).not.toBe(baseline);
    expect(reidentified).not.toBe(baseline);
    expect(failedDifferently).not.toBe(baseline);
  });

  it("composes the failed stored login with the env fallback identity", async () => {
    vi.mocked(readCredentialRows).mockResolvedValue([
      failedRow("row_failed", "Broken", "refresh_failed: denied"),
    ]);
    vi.mocked(resolveQuotaProviderApiKey).mockResolvedValue(
      fallbackResolution({ key: SECRET_CANARY, source: "env" }),
    );

    await resolveOpenRouterAuthIdentity();

    expect(deriveResolvedAuthIdentity).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deriveResolvedAuthIdentity).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        principal: { kind: "stable-id", value: "account:row_failed" },
      }),
    );
    expect(vi.mocked(deriveResolvedAuthIdentity).mock.calls[1]?.[0]).toEqual({
      providerId: "openrouter",
      principal: { kind: "credential", value: SECRET_CANARY },
      qualifiers: [
        JSON.stringify({
          sourceId: null,
          label: "OpenRouter",
          groupLabel: "OpenRouter",
          active: null,
          source: "env",
          state: "usable",
          error: null,
        }),
      ],
    });
    expect(composeResolvedAuthIdentities).toHaveBeenCalledTimes(1);
  });

  it("returns null when no credential exists", async () => {
    await expect(resolveOpenRouterAuthIdentity()).resolves.toBeNull();
    expect(deriveResolvedAuthIdentity).not.toHaveBeenCalled();
  });
});

describe("OpenRouter quota", () => {
  it.each(
    CREDENTIAL_SOURCES,
  )("queries with the exact %s resolution and does not look up credentials again", async (source) => {
    const resolved = resolvedAuth({
      key: SECRET_CANARY,
      source,
      checkedPaths: [`source:${source}`],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValueOnce({
      success: true,
      entries: [],
    });

    await queryOpenRouterQuota({ requestTimeoutMs: 1234, resolved });

    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledWith(
      OPENROUTER_KEY_SOURCE,
      SECRET_CANARY,
      1234,
    );
  });

  it("queries one stored account with its own label and source id", async () => {
    const resolved = storedResolution(SECRET_CANARY);
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValueOnce({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          name: "[OpenRouter Work] key limit",
          group: "[OpenRouter Work]",
          percentRemaining: 80,
        },
      ],
    });

    const result = await queryOpenRouterQuota({
      requestTimeoutMs: 1234,
      resolved,
      label: "[OpenRouter Work]",
      sourceId: "row_work",
    });

    expect(fetchRemoteQuotaProvider).toHaveBeenCalledWith(
      { ...OPENROUTER_KEY_SOURCE, label: "[OpenRouter Work]" },
      SECRET_CANARY,
      1234,
    );
    expect(result).toEqual({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
            sourceId: "row_work",
          },
          name: "[OpenRouter Work] key limit",
          group: "[OpenRouter Work]",
          percentRemaining: 80,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
  });

  it("does not make a request when the passed resolution has no key", async () => {
    const resolved = resolvedAuth({
      source: null,
      checkedPaths: ["env:OPENROUTER_API_KEY", "/tmp/opencode.json"],
      credentialDatabasePaths: ["/tmp/opencode.db"],
    });

    await expect(queryOpenRouterQuota({ resolved })).resolves.toBeNull();
    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
    expect(fetchRemoteQuotaProvider).not.toHaveBeenCalled();
  });

  it("marks reused OpenRouter mapping entries as maintained", async () => {
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "user_configured",
            authority: "provider_reported",
          },
          name: "OpenRouter key limit",
          percentRemaining: 80,
        },
      ],
    });

    await expect(
      queryOpenRouterQuota({
        resolved: resolvedAuth({ key: "secret", source: "env" }),
      }),
    ).resolves.toEqual({
      success: true,
      entries: [
        expect.objectContaining({
          accounting: expect.objectContaining({ ownership: "maintained" }),
        }),
      ],
    });
  });

  it.each([
    ["HTTP", "HTTP 401"],
    ["malformed", "Invalid openrouter-key-v1 response"],
    ["timeout", "Request timeout after 0s"],
    ["redirect", "Redirect rejected"],
    ["body-limit", "Response exceeded 262144 bytes"],
  ] as const)("returns the safe %s remote error unchanged", async (_name, error) => {
    vi.mocked(fetchRemoteQuotaProvider).mockResolvedValue({
      success: false,
      error,
    });

    const result = await queryOpenRouterQuota({
      resolved: resolvedAuth({ key: SECRET_CANARY, source: "env" }),
    });
    expect(result).toEqual({ success: false, error });
    expect(JSON.stringify(result)).not.toContain(SECRET_CANARY);
    expect(fetchRemoteQuotaProvider).toHaveBeenCalledTimes(1);
    expect(resolveQuotaProviderApiKey).not.toHaveBeenCalled();
  });
});
