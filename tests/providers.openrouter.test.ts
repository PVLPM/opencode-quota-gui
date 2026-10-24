import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenRouterAuthAccount, OpenRouterAuthResolution } from "../src/lib/openrouter.js";
import type { QuotaProviderAuthResolution } from "../src/lib/quota-providers-remote.js";
import { openRouterProvider } from "../src/providers/openrouter.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
} from "./helpers/provider-assertions.js";

vi.mock("../src/lib/openrouter.js", () => ({
  hasOpenRouterApiKeyConfigured: vi.fn(),
  queryOpenRouterQuota: vi.fn(),
  resolveOpenRouterAuth: vi.fn(),
  resolveOpenRouterApiKey: vi.fn(),
}));

const SECRET_CANARY = "sk-or-secret-canary";
const SECOND_SECRET = "sk-or-second-secret-canary";
const CHECKED_PATHS = ["env:OPENROUTER_API_KEY", "/tmp/opencode.jsonc"];
const DATABASE_PATHS = ["/tmp/opencode.db"];

function resolvedAuth(
  key: string,
  source: QuotaProviderAuthResolution["source"] = "opencode.db",
): QuotaProviderAuthResolution {
  return {
    key,
    source,
    checkedPaths: CHECKED_PATHS,
    credentialDatabasePaths: DATABASE_PATHS,
  };
}

function authResolution(
  accounts: OpenRouterAuthAccount[],
  overrides: Partial<OpenRouterAuthResolution> = {},
): OpenRouterAuthResolution {
  return {
    accounts,
    checkedPaths: CHECKED_PATHS,
    credentialDatabasePaths: DATABASE_PATHS,
    source: accounts.some((account) => account.resolved?.key) ? "opencode.db" : null,
    ...overrides,
  };
}

function expectedStatusDetails(
  configured: boolean,
  source: QuotaProviderAuthResolution["source"],
  paths: {
    checkedPaths?: readonly string[];
    credentialDatabasePaths?: readonly string[];
  } = {},
) {
  const checkedPaths = paths.checkedPaths ?? CHECKED_PATHS;
  const credentialDatabasePaths = paths.credentialDatabasePaths ?? DATABASE_PATHS;
  return [
    { key: "api_key_configured", value: configured ? "true" : "false" },
    { key: "api_key_source", value: source ?? "(none)" },
    {
      key: "api_key_checked_paths",
      value: checkedPaths.join(" | ") || "(none)",
    },
    {
      key: "api_key_credential_database_paths",
      value: credentialDatabasePaths.join(" | ") || "(none)",
    },
  ];
}

async function mockAuth(auth: OpenRouterAuthResolution): Promise<void> {
  const { resolveOpenRouterAuth } = await import("../src/lib/openrouter.js");
  vi.mocked(resolveOpenRouterAuth).mockResolvedValue(auth);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("OpenRouter provider", () => {
  it("returns attempted:false when no effective account is configured", async () => {
    await mockAuth(authResolution([]));
    const { queryOpenRouterQuota, resolveOpenRouterApiKey } = await import(
      "../src/lib/openrouter.js"
    );

    const out = await openRouterProvider.fetch({} as any);

    expectNotAttempted(out);
    expect(out.statusDetails).toEqual(expectedStatusDetails(false, null));
    expect(queryOpenRouterQuota).not.toHaveBeenCalled();
    expect(resolveOpenRouterApiKey).not.toHaveBeenCalled();
  });

  it("queries each stored key independently with plain aliases and legacy group labels", async () => {
    const work = resolvedAuth(SECRET_CANARY);
    const personal = resolvedAuth(SECOND_SECRET);
    await mockAuth(
      authResolution([
        {
          sourceId: "row_work",
          label: "Work",
          groupLabel: "[OpenRouter Work]",
          active: true,
          resolved: work,
        },
        {
          sourceId: "row_personal",
          label: "Personal",
          groupLabel: "[OpenRouter Personal]",
          active: false,
          resolved: personal,
        },
      ]),
    );
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockImplementation(async ({ resolved, label, sourceId }) => ({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
            ...(sourceId ? { sourceId } : {}),
          },
          kind: "percent",
          name: `${label} key limit`,
          group: label,
          label: "Key limit:",
          metricLabel: "Key limit",
          right: "$2.00/$10.00",
          percentRemaining: resolved.key === SECRET_CANARY ? 80 : 40,
        },
        {
          accounting: {
            resultType: "spend",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
            ...(sourceId ? { sourceId } : {}),
          },
          kind: "value",
          name: `${label} spend`,
          group: label,
          label: "Spend:",
          value: resolved.key === SECRET_CANARY ? "$2.00" : "$6.00",
        },
      ],
    }));

    const out = await openRouterProvider.fetch({
      config: { requestTimeoutMs: 3210 },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(4);
    expect(out.entries.map((entry) => entry.group)).toEqual([
      "[OpenRouter Work]",
      "[OpenRouter Work]",
      "[OpenRouter Personal]",
      "[OpenRouter Personal]",
    ]);
    expect(out.entries.map((entry) => entry.label)).toEqual([
      "Key limit:",
      "Spend:",
      "Key limit:",
      "Spend:",
    ]);
    expect(out.entries.map((entry) => entry.accounting.resultType)).toEqual([
      "budget",
      "spend",
      "budget",
      "spend",
    ]);
    expect(out.accounts).toEqual([
      { sourceId: "row_work", label: "Work", active: true },
      { sourceId: "row_personal", label: "Personal", active: false },
    ]);
    expect(out.presentation).toEqual({ singleWindowShowRight: true });
    expect(out.statusDetails).toEqual(expectedStatusDetails(true, "opencode.db"));
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(2);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: 3210,
      resolved: work,
      label: "[OpenRouter Work]",
      sourceId: "row_work",
    });
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: 3210,
      resolved: personal,
      label: "[OpenRouter Personal]",
      sourceId: "row_personal",
    });
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(JSON.stringify(out)).not.toContain(SECOND_SECRET);
  });

  it("keeps a failing stored account's error local to that account", async () => {
    const work = resolvedAuth(SECRET_CANARY);
    const personal = resolvedAuth(SECOND_SECRET);
    await mockAuth(
      authResolution([
        {
          sourceId: "row_work",
          label: "Work",
          groupLabel: "[OpenRouter Work]",
          active: true,
          resolved: work,
        },
        {
          sourceId: "row_personal",
          label: "Personal",
          groupLabel: "[OpenRouter Personal]",
          active: false,
          resolved: personal,
        },
      ]),
    );
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota)
      .mockResolvedValueOnce({
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
            kind: "percent",
            name: "[OpenRouter Work] key limit",
            group: "[OpenRouter Work]",
            label: "Key limit:",
            percentRemaining: 80,
          },
          {
            accounting: {
              resultType: "spend",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: "row_work",
            },
            kind: "value",
            name: "[OpenRouter Work] spend",
            group: "[OpenRouter Work]",
            label: "Spend:",
            value: "$2.00",
          },
        ],
      })
      .mockResolvedValueOnce({ success: false, error: "HTTP 401" });

    const out = await openRouterProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(2);
    expect(out.entries.map((entry) => entry.label)).toEqual(["Key limit:", "Spend:"]);
    expect(out.accounts).toEqual([
      { sourceId: "row_work", label: "Work", active: true },
      { sourceId: "row_personal", label: "Personal", active: false },
    ]);
    expect(out.errors).toEqual([
      { label: "Personal", message: "HTTP 401", sourceId: "row_personal" },
    ]);
    expect(out.statusDetails).toEqual(expectedStatusDetails(true, "opencode.db"));
  });

  it("keeps an unexpected per-key query throw local to that account", async () => {
    const work = resolvedAuth(SECRET_CANARY);
    const personal = resolvedAuth(SECOND_SECRET);
    await mockAuth(
      authResolution([
        {
          sourceId: "row_work",
          label: "Work",
          groupLabel: "[OpenRouter Work]",
          active: true,
          resolved: work,
        },
        {
          sourceId: "row_personal",
          label: "Personal",
          groupLabel: "[OpenRouter Personal]",
          active: false,
          resolved: personal,
        },
      ]),
    );
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota)
      .mockRejectedValueOnce(new Error(`unexpected failure ${SECRET_CANARY}`))
      .mockResolvedValueOnce({
        success: true,
        entries: [
          {
            accounting: {
              resultType: "spend",
              acquisitionMethod: "remote_api",
              ownership: "maintained",
              authority: "provider_reported",
              sourceId: "row_personal",
            },
            kind: "value",
            name: "[OpenRouter Personal] spend",
            group: "[OpenRouter Personal]",
            label: "Spend:",
            value: "$6.00",
          },
        ],
      });

    const out = await openRouterProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors).toEqual([
      { label: "Work", message: "OpenRouter request failed", sourceId: "row_work" },
    ]);
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(out.statusDetails).toEqual(expectedStatusDetails(true, "opencode.db"));
  });

  it("reports a failed stored login and queries the env/config fallback", async () => {
    await mockAuth(
      authResolution(
        [
          {
            sourceId: "row_failed",
            label: "Broken",
            groupLabel: "[OpenRouter Broken]",
            active: false,
            error: "OpenCode could not read this login: refresh_failed: denied",
          },
          {
            label: "OpenRouter",
            resolved: resolvedAuth("env-secret", "env"),
          },
        ],
        { source: "env" },
      ),
    );
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "spend",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          kind: "value",
          name: "OpenRouter spend",
          group: "OpenRouter",
          label: "Spend:",
          value: "$2.00",
        },
      ],
    });

    const out = await openRouterProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.entries).toHaveLength(1);
    expect(out.errors).toEqual([
      {
        label: "Broken",
        message: "OpenCode could not read this login: refresh_failed: denied",
        sourceId: "row_failed",
      },
    ]);
    expect(out.accounts).toEqual([{ sourceId: "row_failed", label: "Broken", active: false }]);
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: undefined,
      resolved: resolvedAuth("env-secret", "env"),
      label: "OpenRouter",
      sourceId: undefined,
    });
    expect(out.statusDetails).toEqual(expectedStatusDetails(true, "env"));
  });

  it.each([
    ["env", "env:OPENROUTER_API_KEY"],
    ["opencode.json", "/tmp/opencode.json"],
    ["opencode.jsonc", "/tmp/opencode.jsonc"],
    ["opencode.db", "/tmp/opencode.db"],
  ] as const)("attaches safe %s key diagnostics and forwards that resolution", async (source, path) => {
    const resolved = {
      ...resolvedAuth(SECRET_CANARY, source),
      checkedPaths: [path],
    };
    await mockAuth(
      authResolution([{ label: "OpenRouter", resolved }], {
        checkedPaths: [path],
        source,
      }),
    );
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: true,
      entries: [
        {
          accounting: {
            resultType: "budget",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          name: "OpenRouter key limit",
          group: "OpenRouter",
          label: "Key limit:",
          metricLabel: "Key limit",
          percentRemaining: 80,
          right: "$2.00/$10.00",
        },
        {
          accounting: {
            resultType: "spend",
            acquisitionMethod: "remote_api",
            ownership: "maintained",
            authority: "provider_reported",
          },
          kind: "value",
          name: "OpenRouter spend",
          group: "OpenRouter",
          label: "Spend:",
          value: "$2.00",
        },
      ],
    });

    const out = await openRouterProvider.fetch({
      config: { requestTimeoutMs: 3210 },
    } as any);
    expectAttemptedWithNoErrors(out);
    expect(out.entries[0]).toEqual(expect.objectContaining({ percentRemaining: 80 }));
    expect(out.entries.map((entry) => entry.label)).toEqual(["Key limit:", "Spend:"]);
    expect(out.presentation).toEqual({ singleWindowShowRight: true });
    expect(out.statusDetails).toEqual(
      expectedStatusDetails(true, source, { checkedPaths: [path] }),
    );
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: 3210,
      resolved,
      label: "OpenRouter",
      sourceId: undefined,
    });
  });

  it.each([
    ["HTTP", "HTTP 401"],
    ["malformed", "Invalid openrouter-key-v1 response"],
    ["timeout", "Request timeout after 0s"],
    ["redirect", "Redirect rejected"],
    ["body-limit", "Response exceeded 262144 bytes"],
  ] as const)("maps %s failures to a safe provider error", async (_name, error) => {
    const resolved = resolvedAuth(SECRET_CANARY, "opencode.db");
    await mockAuth(authResolution([{ label: "OpenRouter", resolved }], { source: "opencode.db" }));
    const { queryOpenRouterQuota } = await import("../src/lib/openrouter.js");
    vi.mocked(queryOpenRouterQuota).mockResolvedValueOnce({
      success: false,
      error,
    });

    const out = await openRouterProvider.fetch({} as any);
    expectAttemptedWithErrorLabel(out, "OpenRouter");
    expect(out.errors[0]?.message).toBe(error);
    expect(out.statusDetails).toEqual(expectedStatusDetails(true, "opencode.db"));
    expect(JSON.stringify(out)).not.toContain(SECRET_CANARY);
    expect(queryOpenRouterQuota).toHaveBeenCalledTimes(1);
    expect(queryOpenRouterQuota).toHaveBeenCalledWith({
      requestTimeoutMs: undefined,
      resolved,
      label: "OpenRouter",
      sourceId: undefined,
    });
  });

  it("scrubs credential-shaped text from a stored-login error", async () => {
    const token = "a".repeat(40);
    await mockAuth(
      authResolution(
        [
          {
            sourceId: "row_failed",
            label: "Broken",
            groupLabel: "[OpenRouter Broken]",
            active: false,
            error: `OpenCode could not read this login: refresh_failed: ${token}`,
          },
        ],
        { source: null },
      ),
    );

    const out = await openRouterProvider.fetch({} as any);

    expect(out.attempted).toBe(true);
    expect(out.errors[0]?.label).toBe("Broken");
    expect(out.errors[0]?.message).toContain("[redacted]");
    expect(JSON.stringify(out)).not.toContain(token);
  });

  it("auto-detects a trusted key and matches OpenRouter models", async () => {
    const { hasOpenRouterApiKeyConfigured } = await import("../src/lib/openrouter.js");
    vi.mocked(hasOpenRouterApiKeyConfigured).mockResolvedValueOnce(true);

    await expect(openRouterProvider.isAvailable({} as any)).resolves.toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openrouter/anthropic/claude")).toBe(true);
    expect(openRouterProvider.matchesCurrentModel?.("openai/gpt-5")).toBe(false);
  });
});
