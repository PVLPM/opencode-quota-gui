import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
  expectNotAttempted,
  visibleEntries,
} from "./helpers/provider-assertions.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({
  resolveOpenCodeGoAuthCached: vi.fn(),
  resolveOpenCodeGoAuth: vi.fn(),
  getOpenCodeGoAuthDiagnostics: vi.fn(),
  queryOpenCodeGoQuota: vi.fn(),
  queryOpenCodeGoConsoleStatus: vi.fn(),
  resolveOpenCodeConsoleAuthAccounts: vi.fn(),
}));

vi.mock("../src/lib/opencode-go-auth.js", () => ({
  DEFAULT_OPENCODE_GO_AUTH_CACHE_MAX_AGE_MS: 5_000,
  OPENCODE_GO_CREDENTIAL_INTEGRATION_IDS: ["opencode-go", "opencode"],
  resolveOpenCodeGoAuthCached: mocks.resolveOpenCodeGoAuthCached,
  getOpenCodeGoAuthDiagnostics: mocks.getOpenCodeGoAuthDiagnostics,
  resolveOpenCodeGoAuth: mocks.resolveOpenCodeGoAuth,
}));

vi.mock("../src/lib/opencode-go.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/opencode-go.js")>();
  return {
    ...original,
    queryOpenCodeGoQuota: mocks.queryOpenCodeGoQuota,
    queryOpenCodeGoConsoleStatus: mocks.queryOpenCodeGoConsoleStatus,
  };
});

vi.mock("../src/lib/opencode-console-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-console-auth.js")>()),
  resolveOpenCodeConsoleAuthAccounts: mocks.resolveOpenCodeConsoleAuthAccounts,
}));

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn().mockResolvedValue([]),
}));

import { buildProviderCards } from "../src/gui/provider-cards.js";
import {
  __resetOpenCodeGoNotSubscribedForTests,
  opencodeGoProvider,
} from "../src/providers/opencode-go.js";

function successfulResult() {
  return {
    success: true as const,
    rolling: {
      status: "ok" as const,
      usagePercent: 12.5,
      percentRemaining: 87.5,
      resetTimeIso: "2026-08-12T12:30:00.000Z",
    },
    weekly: {
      status: "ok" as const,
      usagePercent: 45,
      percentRemaining: 55,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    },
    monthly: {
      status: "ok" as const,
      usagePercent: 80,
      percentRemaining: 20,
      resetTimeIso: "2026-09-01T04:00:00.000Z",
    },
  };
}

function diagnostics(
  state: "none" | "configured" | "invalid" = "configured",
): Record<string, unknown> {
  return {
    state,
    source: state === "none" ? null : "opencode.db",
    checkedPaths: ["env:OPENCODE_API_KEY", "/tmp/opencode.json"],
    credentialDatabasePaths: ["/tmp/opencode.db"],
    ...(state === "invalid" ? { error: "OpenCode Go auth entry present but key is empty" } : {}),
  };
}

async function runFetch(
  opencodeGoWindows: Array<"rolling" | "weekly" | "monthly"> = ["rolling", "weekly", "monthly"],
  requestTimeoutMs = 5_000,
) {
  return opencodeGoProvider.fetch(
    createProviderAvailabilityContext({
      configOverrides: { opencodeGoWindows, requestTimeoutMs },
    }),
  );
}

describe("opencode-go provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValue(diagnostics());
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    mocks.queryOpenCodeGoQuota.mockResolvedValue(successfulResult());
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([]);
  });

  function consoleAccount(
    credential: Record<string, unknown> = { accessToken: "console-access", orgId: "wrk_1" },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      state: "configured" as const,
      sourceId: "cred_console",
      label: "Console workspace",
      active: true,
      credential,
      ...overrides,
    };
  }

  function consoleConfigured(
    credential: Record<string, unknown> = { accessToken: "console-access", orgId: "wrk_1" },
  ): void {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValueOnce([consoleAccount(credential)]);
  }

  function consoleInvalid(error: string): void {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValueOnce([
      consoleAccount(
        { accessToken: "console-access", orgId: "wrk_1" },
        { state: "invalid", error },
      ),
    ]);
  }

  function consoleSuccess(): void {
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: true,
      rolling: {
        status: "ok",
        usagePercent: 0,
        percentRemaining: 100,
        resetTimeIso: "2026-09-23T18:59:07.061Z",
      },
      weekly: {
        status: "ok",
        usagePercent: 27,
        percentRemaining: 73,
        resetTimeIso: "2026-09-28T00:00:00.000Z",
      },
      monthly: {
        status: "rate-limited",
        usagePercent: 100,
        percentRemaining: 0,
        resetTimeIso: "2026-10-02T12:48:59.000Z",
      },
    });
  }

  it("reads Go windows from the console API when a console credential exists", async () => {
    consoleConfigured();
    consoleSuccess();

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).toHaveBeenCalledWith(
      { accessToken: "console-access", orgId: "wrk_1" },
      { requestTimeoutMs: 5_000 },
    );
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "go_source", value: "console" },
        { key: "console_server", value: "https://opencode.ai/console" },
      ]),
    );
    const visible = visibleEntries(out.entries, "opencode-go");
    expect(visible.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Weekly",
      "OpenCode Go Monthly",
    ]);
  });

  it("reports a console not-subscribed state without errors", async () => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go subscription not found for this console account (404)",
      notSubscribed: true,
    });

    const out = await runFetch();

    expectNotAttempted(out);
    expect(out.entries).toEqual([]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([{ key: "opencode_go_state", value: "not_subscribed" }]),
    );
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("falls back to the legacy key path when the console request fails", async () => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Console API error 500 (/api/go/status)",
      retryable: true,
    });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).toHaveBeenCalledOnce();
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "go_source", value: "legacy_key" },
        { key: "console_error", value: "OpenCode Console API error 500 (/api/go/status)" },
      ]),
    );
  });

  it("falls back to the API key after a Console 403", async () => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Console API error 403 (/api/go/status)",
      retryable: false,
    });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(out.attempted).toBe(true);
    expect(visibleEntries(out.entries, "opencode-go")).toHaveLength(3);
    expect(out.errors).toEqual([
      {
        label: "Console workspace",
        message: "OpenCode Console API error 403 (/api/go/status)",
        retryable: false,
        sourceId: "cred_console",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "go_source", value: "legacy_key" },
        { key: "console_error", value: "OpenCode Console API error 403 (/api/go/status)" },
      ]),
    );
    expect(out.statusDetails).not.toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });
  });

  it("keeps a failed Console 403 visible when there is no API key", async () => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Console API error 403 (/api/go/status)",
      retryable: false,
    });
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "Console workspace",
        message: "OpenCode Console API error 403 (/api/go/status)",
        retryable: false,
        sourceId: "cred_console",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "console_auth_state", value: "configured" },
        { key: "console_error", value: "OpenCode Console API error 403 (/api/go/status)" },
      ]),
    );
  });

  it("reports the console server the sign-in belongs to", async () => {
    consoleConfigured({ accessToken: "console-access", server: "https://console.example.test" });
    consoleSuccess();

    const out = await runFetch();

    expect(out.statusDetails).toContainEqual({
      key: "console_server",
      value: "https://console.example.test",
    });
  });

  it("uses the legacy key path with the console error when the sign-in cannot be read", async () => {
    const jwt = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    consoleInvalid(`refresh_failed: HTTP 401 ${jwt}`);

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).not.toHaveBeenCalled();
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(out.attempted).toBe(true);
    expect(out.errors).toEqual([
      {
        label: "Console workspace",
        message:
          "OpenCode Console sign-in failed: refresh_failed: HTTP 401 [redacted]. Run `opencode auth login opencode`.",
        sourceId: "cred_console",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "configured" },
        { key: "console_auth_state", value: "invalid" },
        { key: "console_error", value: "refresh_failed: HTTP 401 [redacted]" },
        { key: "go_source", value: "legacy_key" },
        { key: "selected_windows", value: "rolling,weekly,monthly" },
      ]),
    );
    expect(JSON.stringify(out)).not.toContain(jwt);
  });

  it("shows the failed Console sign-in as Go's error when there is no API key", async () => {
    const jwt = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    consoleInvalid(`refresh_failed: HTTP 401 ${jwt}`);
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "Console workspace",
        message:
          "OpenCode Console sign-in failed: refresh_failed: HTTP 401 [redacted]. Run `opencode auth login opencode`.",
        sourceId: "cred_console",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([{ key: "console_auth_state", value: "invalid" }]),
    );
    expect(JSON.stringify(out)).not.toContain(jwt);
  });

  it.each([
    ["a 5xx answer", "OpenCode Console API error 500 (/api/go/status)"],
    ["a network failure", "fetch failed"],
    ["a timeout", "Request timeout after 5s"],
  ])("keeps %s from the Console visible when there is no API key", async (_case, error) => {
    consoleConfigured();
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: false,
      error,
      retryable: true,
    });
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await runFetch();

    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.attempted).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([
      {
        label: "Console workspace",
        message: error,
        retryable: true,
        sourceId: "cred_console",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "console_auth_state", value: "configured" },
        { key: "console_error", value: error },
      ]),
    );
  });

  it("stays quiet without a Console sign-in or an API key", async () => {
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await runFetch();

    expectNotAttempted(out);
    expect(out.errors).toEqual([]);
  });

  it("keeps the plain key path when the opencode login is an API key", async () => {
    const out = await runFetch();

    expect(mocks.queryOpenCodeGoConsoleStatus).not.toHaveBeenCalled();
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(out.statusDetails?.map((detail) => detail.key)).not.toContain("console_auth_state");
  });

  it("returns not attempted for absent auth without calling the API", async () => {
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("none"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    const out = await runFetch();

    expectNotAttempted(out);
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "auth_state", value: "none" },
        { key: "auth_source", value: "(none)" },
        { key: "selected_windows", value: "rolling,weekly,monthly" },
      ]),
    );
  });

  it("returns an attempted error for invalid canonical auth", async () => {
    const error = "OpenCode Go auth entry present but key is empty";
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("invalid"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "invalid", error });

    const out = await runFetch();

    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toBe(error);
    expect(out.statusDetails).toContainEqual({ key: "auth_error", value: error });
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("keeps a valid inactive duplicate-label database credential when the active row is invalid", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValueOnce(diagnostics("invalid"));
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({
      state: "invalid",
      error: "empty key",
    });
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "bad",
        integrationId: "opencode-go",
        label: "shared",
        active: true,
        value: { key: "" },
      },
      {
        id: "good",
        integrationId: "opencode-go",
        label: "shared",
        active: false,
        value: { key: "ok" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) =>
      auth["opencode-go"].key
        ? { state: "configured", apiKey: "row-token" }
        : { state: "invalid", error: "empty key" },
    );

    const out = await runFetch();
    expect(out.errors).toContainEqual({
      label: "[OpenCode Go shared] (active)",
      message: "empty key",
      sourceId: "bad",
    });
    expect(out.entries).toContainEqual(
      expect.objectContaining({
        group: "[OpenCode Go shared 2]",
        accounting: expect.objectContaining({ sourceId: "good" }),
      }),
    );
    expect(out.entries).toHaveLength(3);
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
  });

  it("keeps two failed database logins as two error rows", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const failed = (id: string, label: string, active: boolean) => ({
      id,
      integrationId: "opencode-go",
      label,
      active,
      value: { type: "api" },
      resolveError: "active_failed: database is locked",
    });
    (readCredentialRows as any).mockResolvedValueOnce([
      failed("cred_personal", "Personal", true),
      failed("cred_work", "Work", false),
    ]);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) => ({
      state: "invalid",
      error: `OpenCode could not read this login: ${auth["opencode-go"].resolveError}`,
    }));

    const out = await runFetch();

    const message = "OpenCode could not read this login: active_failed: database is locked";
    expect(out.errors).toEqual([
      { label: "[OpenCode Go Personal] (active)", message, sourceId: "cred_personal" },
      { label: "[OpenCode Go Work]", message, sourceId: "cred_work" },
    ]);
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("reports one Go connection when the same key is stored under both integrations", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const workspaceCredential = { type: "key", key: "workspace-key" };
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: workspaceCredential,
      },
      {
        id: "zen-row",
        integrationId: "opencode",
        label: "default",
        active: false,
        value: workspaceCredential,
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(visibleEntries(out.entries, "opencode-go").map((entry) => entry.group)).toEqual([
      "[OpenCode Go]",
      "[OpenCode Go]",
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "go-row" });
    }
  });

  it("does not report another integration's credential as a second Go connection", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: { type: "key", key: "go-key" },
      },
      {
        id: "zen-row",
        integrationId: "opencode",
        label: "default",
        active: false,
        value: { type: "key", key: "zen-key" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "go-row" });
    }
  });

  it("keeps separate connections for distinct native credentials", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: { type: "key", key: "first-key" },
      },
      {
        id: "second-go-row",
        integrationId: "opencode-go",
        label: "default",
        active: false,
        value: { type: "key", key: "second-key" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(2);
    const groups = visibleEntries(out.entries, "opencode-go").map((entry) => entry.group);
    expect(groups).toEqual(["[OpenCode Go]", "[OpenCode Go]", "[OpenCode Go]", "[OpenCode Go]"]);
  });

  it("suppresses non-entitled database connections independently", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    const credentialRows = [
      {
        id: "not-subscribed",
        integrationId: "opencode-go",
        label: "free",
        active: true,
        value: { type: "key", key: "free-key" },
      },
      {
        id: "subscribed",
        integrationId: "opencode-go",
        label: "paid",
        active: false,
        value: { type: "key", key: "paid-key" },
      },
    ];
    (readCredentialRows as any)
      .mockResolvedValueOnce(credentialRows)
      .mockResolvedValueOnce(credentialRows);
    mocks.resolveOpenCodeGoAuth.mockImplementation((auth: any) => ({
      state: "configured",
      apiKey: auth["opencode-go"].key,
    }));
    mocks.queryOpenCodeGoQuota.mockImplementation(async (apiKey: string) =>
      apiKey === "free-key"
        ? {
            success: false,
            error: "OpenCode Go not subscribed (403 EntitlementError)",
            notSubscribed: true,
            retryable: false,
          }
        : successfulResult(),
    );

    const first = await runFetch(["rolling"]);
    const second = await runFetch(["rolling"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(3);
    expect(mocks.queryOpenCodeGoQuota.mock.calls.map(([apiKey]) => apiKey)).toEqual([
      "free-key",
      "paid-key",
      "paid-key",
    ]);
    expect(first.entries).toEqual([
      expect.objectContaining({ accounting: expect.objectContaining({ sourceId: "subscribed" }) }),
    ]);
    expect(second.entries).toEqual([
      expect.objectContaining({ accounting: expect.objectContaining({ sourceId: "subscribed" }) }),
    ]);
    // Only the entitled login gets an account card; the suppressed login must
    // not leave an empty card behind.
    expect(first.accounts).toEqual([expect.objectContaining({ sourceId: "subscribed" })]);
    expect(second.accounts).toEqual([expect.objectContaining({ sourceId: "subscribed" })]);
  });

  it("falls back to legacy alias rows when no native opencode-go row exists", async () => {
    const { readCredentialRows } = await import("../src/lib/opencode-auth.js");
    (readCredentialRows as any).mockResolvedValueOnce([
      {
        id: "alias-row",
        integrationId: "opencode",
        label: "default",
        active: false,
        value: { type: "key", key: "legacy-key" },
      },
    ]);
    mocks.resolveOpenCodeGoAuth.mockReturnValue({ state: "configured", apiKey: "row-token" });

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledOnce();
    expect(visibleEntries(out.entries, "opencode-go").map((entry) => entry.group)).toEqual([
      "[OpenCode Go]",
      "[OpenCode Go]",
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toMatchObject({ sourceId: "alias-row" });
    }
  });

  it("passes the resolved token and effective timeout to the API client", async () => {
    await runFetch(["rolling", "weekly", "monthly"], 12_345);

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledWith("provider-test-token", {
      requestTimeoutMs: 12_345,
    });
  });

  it("returns canonical entries with remote_api accounting", async () => {
    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "opencode-go")).toEqual([
      {
        name: "OpenCode Go 5h",
        group: "OpenCode Go",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      {
        name: "OpenCode Go Weekly",
        group: "OpenCode Go",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 55,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      {
        name: "OpenCode Go Monthly",
        group: "OpenCode Go",
        label: "Monthly:",
        rowKey: "window:month",
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    ]);
    for (const entry of out.entries) {
      expect(entry.accounting).toEqual({
        resultType: "quota",
        acquisitionMethod: "remote_api",
        ownership: "maintained",
        authority: "provider_reported",
      });
    }
  });

  it("filters duplicates in canonical order after full-response diagnostics", async () => {
    const out = await runFetch(["monthly", "rolling", "monthly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Monthly",
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "selected_windows", value: "monthly,rolling,monthly" },
        {
          key: "rolling_usage",
          value:
            "status=ok percent_used=12.5 percent_remaining=87.5 reset_at=2026-08-12T12:30:00.000Z",
        },
        {
          key: "weekly_usage",
          value: "status=ok percent_used=45 percent_remaining=55 reset_at=2026-08-16T16:00:00.000Z",
        },
        {
          key: "monthly_usage",
          value: "status=ok percent_used=80 percent_remaining=20 reset_at=2026-09-01T04:00:00.000Z",
        },
      ]),
    );
  });

  it("uses only the standard auth diagnostic keys", async () => {
    const out = await runFetch(["weekly"]);
    const keys = out.statusDetails?.map((detail) => detail.key) ?? [];

    expect(keys).toEqual([
      "auth_state",
      "auth_source",
      "auth_checked_paths",
      "credential_database_paths",
      "selected_windows",
      "rolling_usage",
      "weekly_usage",
      "monthly_usage",
    ]);
    expect(keys.some((key) => key.startsWith("config_"))).toBe(false);
    expect(keys).not.toContain("reset_in_sec");
  });

  it("returns API failures as attempted errors with live_fetch_error", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go API error 503: unavailable",
    });

    const out = await runFetch();

    expectAttemptedWithErrorLabel(out, "OpenCode Go");
    expect(out.errors[0]?.message).toBe("OpenCode Go API error 503: unavailable");
    expect(out.statusDetails).toContainEqual({
      key: "live_fetch_error",
      value: "OpenCode Go API error 503: unavailable",
    });
  });

  it("surfaces a rate-limited monthly window as a valid result", async () => {
    const result = successfulResult();
    result.monthly = {
      status: "rate-limited" as const,
      usagePercent: 100,
      percentRemaining: 0,
      resetTimeIso: "2026-09-01T04:00:00.000Z",
    };
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(result);

    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.statusDetails).toContainEqual({
      key: "monthly_usage",
      value:
        "status=rate-limited percent_used=100 percent_remaining=0 reset_at=2026-09-01T04:00:00.000Z",
    });
    expect(
      out.entries.find((entry) => entry.name === "OpenCode Go Monthly")?.percentRemaining,
    ).toBe(0);
  });

  it("keeps healthy sibling rows when one window is exhausted", async () => {
    const result = successfulResult();
    result.weekly = {
      status: "rate-limited" as const,
      usagePercent: 100,
      percentRemaining: 0,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    };
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(result);

    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(visibleEntries(out.entries, "opencode-go")).toEqual([
      {
        name: "OpenCode Go 5h",
        group: "OpenCode Go",
        label: "5h:",
        rowKey: "window:five_hour",
        percentRemaining: 87.5,
        resetTimeIso: "2026-08-12T12:30:00.000Z",
      },
      {
        name: "OpenCode Go Weekly",
        group: "OpenCode Go",
        label: "Weekly:",
        rowKey: "window:week",
        percentRemaining: 0,
        resetTimeIso: "2026-08-16T16:00:00.000Z",
      },
      {
        name: "OpenCode Go Monthly",
        group: "OpenCode Go",
        label: "Monthly:",
        rowKey: "window:month",
        percentRemaining: 20,
        resetTimeIso: "2026-09-01T04:00:00.000Z",
      },
    ]);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        {
          key: "rolling_usage",
          value:
            "status=ok percent_used=12.5 percent_remaining=87.5 reset_at=2026-08-12T12:30:00.000Z",
        },
        {
          key: "weekly_usage",
          value:
            "status=rate-limited percent_used=100 percent_remaining=0 reset_at=2026-08-16T16:00:00.000Z",
        },
        {
          key: "monthly_usage",
          value: "status=ok percent_used=80 percent_remaining=20 reset_at=2026-09-01T04:00:00.000Z",
        },
      ]),
    );
  });

  it("omits an unselected exhausted window from entries while keeping live diagnostics", async () => {
    const result = successfulResult();
    result.weekly = {
      status: "rate-limited" as const,
      usagePercent: 100,
      percentRemaining: 0,
      resetTimeIso: "2026-08-16T16:00:00.000Z",
    };
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce(result);

    const out = await runFetch(["rolling", "monthly"]);

    expectAttemptedWithNoErrors(out);
    expect(out.entries.map((entry) => entry.name)).toEqual([
      "OpenCode Go 5h",
      "OpenCode Go Monthly",
    ]);
    expect(out.entries.some((entry) => entry.name === "OpenCode Go Weekly")).toBe(false);
    expect(out.statusDetails).toEqual(
      expect.arrayContaining([
        { key: "selected_windows", value: "rolling,monthly" },
        {
          key: "weekly_usage",
          value:
            "status=rate-limited percent_used=100 percent_remaining=0 reset_at=2026-08-16T16:00:00.000Z",
        },
      ]),
    );
  });

  it("suppresses repeat requests after a not-subscribed response", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValue({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });

    const first = await runFetch();
    const second = await runFetch();

    expectAttemptedWithNoErrors(first);
    expectAttemptedWithNoErrors(second);
    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([]);
    expect(first.statusDetails).toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });
    expect(second.statusDetails).toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(1);
  });

  it("queries again after the credential changes, including when the original returns", async () => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });
    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      true,
    );
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "new-provider-test-token",
    });
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(3);
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenNthCalledWith(2, "new-provider-test-token", {
      requestTimeoutMs: 5_000,
    });
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenLastCalledWith("provider-test-token", {
      requestTimeoutMs: 5_000,
    });
  });

  it.each([
    ["missing", { state: "none" }],
    ["invalid", { state: "invalid", error: "OpenCode Go auth entry present but key is empty" }],
  ])("queries again after production availability sees %s auth", async (_name, auth) => {
    mocks.queryOpenCodeGoQuota.mockResolvedValueOnce({
      success: false,
      error: "OpenCode Go not subscribed (403 EntitlementError)",
      notSubscribed: true,
      retryable: false,
    });
    await runFetch();

    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce(auth);
    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      false,
    );
    await runFetch();

    expect(mocks.queryOpenCodeGoQuota).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenCodeGoQuota).toHaveBeenLastCalledWith("provider-test-token", {
      requestTimeoutMs: 5_000,
    });
  });

  it("does not copy the resolved token into provider output", async () => {
    const out = await runFetch();
    expect(JSON.stringify(out)).not.toContain("provider-test-token");
  });
});

describe("opencode-go multi-workspace Console accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
    mocks.getOpenCodeGoAuthDiagnostics.mockResolvedValue(diagnostics());
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValue({
      state: "configured",
      apiKey: "provider-test-token",
    });
    mocks.queryOpenCodeGoQuota.mockResolvedValue(successfulResult());
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValue(successfulResult());
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([]);
  });

  function account(
    sourceId: string,
    label: string,
    accessToken: string,
    orgId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      state: "configured" as const,
      sourceId,
      label,
      active: false,
      credential: { accessToken, orgId },
      ...overrides,
    };
  }

  it("queries every Console workspace and scopes rows to stable source ids", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_work", "Acme", "work-access", "wrk_work", { active: true }),
      account("cred_personal", "Personal", "personal-access", "wrk_personal"),
    ]);

    const out = await runFetch(["rolling", "weekly"]);

    expect(mocks.queryOpenCodeGoConsoleStatus).toHaveBeenCalledTimes(2);
    expect(mocks.queryOpenCodeGoConsoleStatus.mock.calls.map(([credential]) => credential)).toEqual(
      [
        { accessToken: "work-access", orgId: "wrk_work" },
        { accessToken: "personal-access", orgId: "wrk_personal" },
      ],
    );
    expect(out.accounts).toEqual([
      { sourceId: "cred_work", label: "Acme", active: true },
      { sourceId: "cred_personal", label: "Personal", active: false },
    ]);
    expect(out.accounts?.[0]).not.toHaveProperty("planLabel");
    expect(out.entries).toHaveLength(4);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual([
      "cred_work",
      "cred_work",
      "cred_personal",
      "cred_personal",
    ]);
    expect(out.errors).toEqual([]);
    expect(out.statusDetails).toContainEqual({ key: "console_accounts", value: "2" });
  });

  it("keeps Console quota rows without a reset and leaves GUI rows without reset text", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_no_reset", "Account 1", "no-reset-access", "wrk_no_reset", { active: true }),
    ]);
    const noReset = { status: "ok" as const, usagePercent: 0, percentRemaining: 100 };
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce({
      success: true,
      rolling: noReset,
      weekly: noReset,
      monthly: noReset,
    });

    const out = await runFetch();

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toHaveLength(3);
    for (const entry of out.entries) {
      expect(entry).not.toHaveProperty("resetTimeIso");
    }

    const cards = buildProviderCards({
      probes: [{ providerId: "opencode-go", result: out }],
      preferences: { accountingDetail: "summary" },
      nowMs: Date.now(),
    });
    const rows = cards.flatMap((card) => card.rows);
    expect(rows).toHaveLength(3);
    expect(rows.some((row) => "resetAtIso" in row)).toBe(false);
  });

  it("omits a workspace without Go instead of emitting an empty account card", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_go", "Subscribed", "go-access", "wrk_go"),
      account("cred_free", "Free", "free-access", "wrk_free"),
    ]);
    mocks.queryOpenCodeGoConsoleStatus.mockImplementation(async (credential) =>
      credential.accessToken === "free-access"
        ? {
            success: false,
            error: "OpenCode Go subscription not found for this console account (404)",
            notSubscribed: true,
          }
        : successfulResult(),
    );

    const out = await runFetch(["rolling"]);

    expect(out.accounts).toEqual([{ sourceId: "cred_go", label: "Subscribed", active: false }]);
    expect(out.entries).toEqual([
      expect.objectContaining({ accounting: expect.objectContaining({ sourceId: "cred_go" }) }),
    ]);
    expect(out.errors).toEqual([]);
    expect(out.statusDetails).not.toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });
  });

  it("preserves a failed workspace next to successful workspaces", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_ok", "Healthy", "ok-access", "wrk_ok"),
      account("cred_bad", "Broken", "bad-access", "wrk_bad"),
    ]);
    mocks.queryOpenCodeGoConsoleStatus.mockImplementation(async (credential) =>
      credential.accessToken === "bad-access"
        ? {
            success: false,
            error: "OpenCode Console API error 503 (/api/go/status)",
            retryable: true,
          }
        : successfulResult(),
    );

    const out = await runFetch(["rolling"]);

    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(["cred_ok"]);
    expect(out.errors).toEqual([
      {
        label: "Broken",
        message: "OpenCode Console API error 503 (/api/go/status)",
        retryable: true,
        sourceId: "cred_bad",
      },
    ]);
    expect(out.accounts?.map(({ sourceId }) => sourceId)).toEqual(["cred_ok", "cred_bad"]);
  });

  it("does not add a redundant plan label to a normal Go account", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_unknown", "Unknown plan", "unknown-access", "wrk_unknown"),
    ]);
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValueOnce(successfulResult());

    const out = await runFetch(["rolling"]);

    expect(out.accounts).toEqual([
      { sourceId: "cred_unknown", label: "Unknown plan", active: false },
    ]);
    expect(out.accounts?.[0]).not.toHaveProperty("planLabel");
    expect(JSON.stringify(out)).not.toContain("Go Plus");
  });

  it("emits no account or provider card when every Console workspace lacks Go", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_free_a", "Free A", "free-a", "wrk_a"),
      account("cred_free_b", "Free B", "free-b", "wrk_b"),
    ]);
    mocks.queryOpenCodeGoConsoleStatus.mockResolvedValue({
      success: false,
      error: "OpenCode Go subscription not found for this console account (404)",
      notSubscribed: true,
    });

    const out = await runFetch();

    expect(out.attempted).toBe(false);
    expect(out.entries).toEqual([]);
    expect(out.errors).toEqual([]);
    expect(out.accounts).toBeUndefined();
    expect(out.statusDetails).toContainEqual({
      key: "opencode_go_state",
      value: "not_subscribed",
    });

    // The actual GUI mapper must not turn the all-not-entitled probe into an
    // empty provider-scope card.
    const cards = buildProviderCards({
      probes: [{ providerId: "opencode-go", result: out }],
      preferences: { accountingDetail: "summary" },
      nowMs: Date.now(),
    });
    expect(cards).toEqual([]);
  });

  it("keeps sibling workspaces when one workspace request throws", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([
      account("cred_ok", "Healthy", "ok-access", "wrk_ok"),
      account("cred_bad", "Broken", "bad-access", "wrk_bad"),
    ]);
    mocks.queryOpenCodeGoConsoleStatus.mockImplementation(async (credential) => {
      if (credential.accessToken === "bad-access") throw new Error("socket hang up");
      return successfulResult();
    });

    const out = await runFetch(["rolling"]);

    expect(mocks.queryOpenCodeGoConsoleStatus).toHaveBeenCalledTimes(2);
    expect(out.entries.map((entry) => entry.accounting.sourceId)).toEqual(["cred_ok"]);
    expect(out.errors).toEqual([
      {
        label: "Broken",
        message: "OpenCode Console request failed: socket hang up",
        retryable: true,
        sourceId: "cred_bad",
      },
    ]);
    expect(out.accounts?.map(({ sourceId }) => sourceId)).toEqual(["cred_ok", "cred_bad"]);
  });
});

describe("opencode-go availability and model matching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetOpenCodeGoNotSubscribedForTests();
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValue([]);
  });

  it.each([
    [{ state: "configured", apiKey: "key" }, true],
    [{ state: "invalid", error: "bad auth" }, false],
    [{ state: "none" }, false],
  ])("maps auth state %j to availability %s without a request", async (auth, expected) => {
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce(auth);

    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      expected,
    );
    expect(mocks.queryOpenCodeGoQuota).not.toHaveBeenCalled();
  });

  it("stays available for a failed Console sign-in without an API key", async () => {
    mocks.resolveOpenCodeConsoleAuthAccounts.mockResolvedValueOnce([
      {
        state: "invalid",
        sourceId: "cred_console",
        label: "Console workspace",
        active: true,
        error: "refresh_failed: HTTP 401",
      },
    ]);
    mocks.resolveOpenCodeGoAuthCached.mockResolvedValueOnce({ state: "none" });

    await expect(opencodeGoProvider.isAvailable(createProviderAvailabilityContext())).resolves.toBe(
      true,
    );
  });

  it.each([
    ["opencode-go/some-model", true],
    ["opencode-go-subscription/any", true],
    ["openai/gpt-4", false],
    ["copilot/gpt-4", false],
  ])("matchesCurrentModel(%s) -> %s", (model, expected) => {
    expect(opencodeGoProvider.matchesCurrentModel?.(model)).toBe(expected);
  });
});
