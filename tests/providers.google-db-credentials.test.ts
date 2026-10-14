import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: vi.fn(),
  agyQuery: vi.fn(),
  geminiQuery: vi.fn(),
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: mocks.rows,
}));
vi.mock("../src/lib/google-agy.js", () => ({
  AGY_AUTH_KEYS: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
  hasAgyQuotaRuntimeAvailable: vi.fn(),
  inspectAgyAuthPresence: vi.fn(async () => ({
    state: "configured",
    sourceKey: "google-agy",
    accountCount: 2,
    validAccountCount: 2,
  })),
  queryGoogleAgyQuota: mocks.agyQuery,
}));
vi.mock("../src/lib/google-gemini-cli.js", () => ({
  GEMINI_CLI_AUTH_KEYS: [
    "google-gemini-cli",
    "gemini-cli",
    "opencode-gemini-auth",
    "gemini",
    "google",
  ],
  hasGeminiCliQuotaRuntimeAvailable: vi.fn(),
  inspectGeminiCliAuthPresence: vi.fn(async () => ({
    state: "configured",
    sourceKey: "google-gemini-cli",
    accountCount: 2,
    validAccountCount: 2,
  })),
  queryGeminiCliQuota: mocks.geminiQuery,
}));
vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: vi.fn(async () => ({ state: "present", resolvedPath: "/plugin" })),
}));
vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: vi.fn(async () => ({
    state: "present",
    resolvedPath: "/plugin",
  })),
}));

import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";

describe.each([
  {
    name: "Google AGY",
    integrationId: "google-agy",
    provider: googleAgyProvider,
    query: mocks.agyQuery,
    result: {
      success: true,
      buckets: [
        {
          family: "Gemini Models",
          window: "weekly",
          windowLabel: "Weekly",
          accountIndex: 0,
          percentRemaining: 70,
        },
        {
          family: "Claude and GPT models",
          window: "weekly",
          windowLabel: "Weekly",
          accountIndex: 0,
          percentRemaining: 50,
        },
      ],
    },
    expectedGroups: [
      ["[Google AGY Work: Gemini] (active)", "active-id"],
      ["[Google AGY Work: Claude/GPT] (active)", "active-id"],
      ["[Google AGY Work 2: Gemini]", "other-id"],
      ["[Google AGY Work 2: Claude/GPT]", "other-id"],
    ],
    expectedNames: [
      "[Google AGY Work: Gemini] (active) Weekly",
      "[Google AGY Work: Claude/GPT] (active) Weekly",
      "[Google AGY Work 2: Gemini] Weekly",
      "[Google AGY Work 2: Claude/GPT] Weekly",
    ],
  },
  {
    name: "Gemini CLI",
    integrationId: "google-gemini-cli",
    provider: googleGeminiCliProvider,
    query: mocks.geminiQuery,
    result: {
      success: true,
      buckets: [{ displayName: "Gemini 2.5", percentRemaining: 70 }],
    },
    expectedGroups: [
      ["[Gemini CLI Work] (active)", "active-id"],
      ["[Gemini CLI Work 2]", "other-id"],
    ],
    expectedNames: ["[Gemini CLI Work] (active) Gemini 2.5", "[Gemini CLI Work 2] Gemini 2.5"],
  },
])("$name DB credentials", ({
  integrationId,
  provider,
  query,
  result,
  expectedGroups,
  expectedNames,
}) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.mockResolvedValue([
      {
        id: "active-id",
        integrationId,
        label: "Work",
        active: true,
        value: { type: "oauth", refresh: "one|project" },
      },
      {
        id: "other-id",
        integrationId,
        label: "Work",
        active: false,
        value: { type: "oauth", refresh: "two|project" },
      },
    ]);
    query.mockResolvedValue(result);
  });

  it("queries every row without deduping duplicate aliases", async () => {
    const output = await provider.fetch({ client: {}, config: {} } as never);

    expect(query).toHaveBeenCalledTimes(2);
    expect(output.entries.map((entry) => [entry.group, entry.accounting.sourceId])).toEqual(
      expectedGroups,
    );
    expect(output.entries.map((entry) => entry.name)).toEqual(expectedNames);
  });
});
