import { afterEach, describe, expect, it } from "vitest";

import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  consoleBaseUrl,
  consoleHeaders,
  consoleUnexpectedErrorText,
  resolveOpenCodeConsoleAuth,
  resolveOpenCodeConsoleAuthAccounts,
} from "../src/lib/opencode-console-auth.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";

const unbinds: Array<() => void> = [];

afterEach(() => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  clearReadAuthFileCacheForTests();
});

function bindConsoleLogins(credentials: FakeCredential[]) {
  const integration = createFakeIntegration(credentials);
  unbinds.push(bindCredentialSource(createIntegrationCredentialSource(integration as never)));
  return integration;
}

function consoleLogin(
  value: Record<string, unknown>,
  overrides: Partial<FakeCredential> = {},
): FakeCredential {
  return {
    integrationId: "opencode",
    id: "cred_console",
    label: "default",
    registered: true,
    method: value.type === "key" ? "key" : "oauth",
    value,
    ...overrides,
  };
}

describe("OpenCode Console credential reader", () => {
  it("returns none without console credentials", async () => {
    bindConsoleLogins([]);
    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({ state: "none" });
  });

  it("resolves the configured console credential with org metadata", async () => {
    const expires = Date.now() + 60_000;
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "server",
        access: "console-access",
        refresh: "console-refresh",
        expires,
        metadata: {
          accountID: "acc_1",
          email: "ran@example.com",
          orgID: "wrk_1",
          orgName: "WSC Sports",
        },
      }),
    ]);

    const state = await resolveOpenCodeConsoleAuth();
    expect(state).toEqual({
      state: "configured",
      credential: {
        accessToken: "console-access",
        refreshToken: "console-refresh",
        expiresAt: expires,
        accountId: "acc_1",
        orgId: "wrk_1",
        orgName: "WSC Sports",
        email: "ran@example.com",
        server: undefined,
      },
    });
  });

  it("reports expired console credentials", async () => {
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "device",
        refresh: "console-refresh",
        access: "console-access",
        expires: Date.now() - 60_000,
        metadata: { orgID: "wrk_1" },
      }),
    ]);

    const state = await resolveOpenCodeConsoleAuth();
    expect(state.state).toBe("expired");
  });

  it("reports invalid credentials without an access token", async () => {
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "device",
        refresh: "console-refresh",
        access: "  ",
        expires: 0,
      }),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "invalid",
      error: "OpenCode Console credential has no access token",
    });
  });

  it("ignores key-shaped opencode rows", async () => {
    bindConsoleLogins([consoleLogin({ type: "key", key: "workspace-key" })]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "none",
      reason: "not_oauth",
    });
  });

  it("reads only the active opencode login", async () => {
    const integration = bindConsoleLogins([
      consoleLogin({ type: "key", key: "workspace-key" }, { id: "cred_workspace" }),
      consoleLogin(
        {
          type: "oauth",
          methodID: "device",
          refresh: "console-refresh",
          access: "console-access",
          expires: Date.now() + 60_000,
        },
        { id: "cred_console_inactive" },
      ),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "none",
      reason: "not_oauth",
    });
    expect(integration.list).not.toHaveBeenCalled();
    expect(integration.connection.active.mock.calls).toEqual([["opencode"]]);
    expect(integration.connection.resolve.mock.calls).toEqual([
      [{ type: "credential", id: "cred_workspace", label: "default", method: "key" }],
    ]);
  });

  it("reports a login OpenCode could not return as invalid", async () => {
    bindConsoleLogins([
      consoleLogin(
        {
          type: "oauth",
          methodID: "device",
          refresh: "console-refresh",
          access: "console-access",
          expires: 0,
        },
        { resolveError: "HTTP 401" },
      ),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toEqual({
      state: "invalid",
      error: "refresh_failed: HTTP 401",
    });
  });

  it("uses the active sign-in and resolves no other login", async () => {
    const signIn = (id: string, orgID: string) =>
      consoleLogin(
        {
          type: "oauth",
          methodID: "device",
          refresh: `${id}-refresh`,
          access: `${id}-access`,
          expires: Date.now() + 60_000,
          metadata: { orgID },
        },
        { id },
      );
    const integration = bindConsoleLogins([
      signIn("cred_active", "wrk_active"),
      signIn("cred_other", "wrk_other"),
    ]);

    await expect(resolveOpenCodeConsoleAuth()).resolves.toMatchObject({
      state: "configured",
      credential: { accessToken: "cred_active-access", orgId: "wrk_active" },
    });
    expect(integration.connection.resolve).toHaveBeenCalledOnce();
  });

  it("keeps the Console server the sign-in belongs to", async () => {
    bindConsoleLogins([
      consoleLogin({
        type: "oauth",
        methodID: "device",
        refresh: "console-refresh",
        access: "console-access",
        expires: Date.now() + 60_000,
        metadata: { server: "https://console.example.test" },
      }),
    ]);

    const state = await resolveOpenCodeConsoleAuth();
    if (state.state !== "configured") throw new Error(`unexpected state ${state.state}`);
    expect(consoleBaseUrl(state.credential)).toBe("https://console.example.test");
  });
});

describe("OpenCode Console multi-workspace reader", () => {
  function oauthLogin(
    id: string,
    metadata: Record<string, unknown>,
    overrides: Partial<FakeCredential> = {},
  ): FakeCredential {
    return consoleLogin(
      {
        type: "oauth",
        methodID: "device",
        refresh: `${id}-refresh`,
        access: `${id}-access`,
        expires: Date.now() + 60_000,
        metadata,
      },
      { id, ...overrides },
    );
  }

  it("enumerates every OAuth login with stable source ids, workspace labels, and active marks", async () => {
    bindConsoleLogins([
      oauthLogin("cred_work", { orgID: "wrk_work", orgName: "Acme" }, { label: "Work" }),
      oauthLogin("cred_personal", { orgID: "wrk_personal" }, { label: "Personal" }),
      consoleLogin({ type: "key", key: "workspace-key" }, { id: "cred_key" }),
    ]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts.map(({ sourceId, label, active }) => ({ sourceId, label, active }))).toEqual([
      { sourceId: "cred_work", label: "Acme", active: true },
      { sourceId: "cred_personal", label: "Personal", active: false },
    ]);
    expect(accounts[0]).toMatchObject({
      state: "configured",
      credential: { accessToken: "cred_work-access", orgId: "wrk_work", orgName: "Acme" },
    });
    expect(accounts[1]).toMatchObject({
      state: "configured",
      credential: { accessToken: "cred_personal-access", orgId: "wrk_personal" },
    });
  });

  it("labels a workspace by org name, then a safe alias, then a generic account number", async () => {
    bindConsoleLogins([
      oauthLogin(
        "cred_org_name",
        { orgID: "wrk_org", orgName: "  Acme\nWorkspace  " },
        { label: "Work" },
      ),
      oauthLogin("cred_default_alias", { orgID: "wrk_default" }, { label: "default" }),
      oauthLogin("cred_oauth_alias", { orgID: "wrk_oauth" }, { label: "OAuth" }),
      oauthLogin("cred_named", { orgID: "wrk_named" }, { label: " Research " }),
    ]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts({ fallbackLabel: "OpenCode Go" });

    expect(accounts.map(({ label }) => label)).toEqual([
      "Acme Workspace",
      "Account 2",
      "Account 3",
      "Research",
    ]);
  });

  it("preserves each invalid, missing-token, and expired login as its own failure", async () => {
    bindConsoleLogins([
      oauthLogin(
        "cred_refresh_failed",
        { orgID: "wrk_refresh" },
        { label: "Broken", resolveError: "HTTP 401" },
      ),
      {
        ...oauthLogin("cred_missing_token", { orgID: "wrk_missing" }, { label: "Missing" }),
        value: {
          type: "oauth",
          methodID: "device",
          refresh: "missing-refresh",
          expires: Date.now() + 60_000,
          metadata: { orgID: "wrk_missing", orgName: "Empty" },
        },
      },
      {
        ...oauthLogin("cred_expired", { orgID: "wrk_expired", orgName: "Old" }, { label: "Old" }),
        value: {
          type: "oauth",
          methodID: "device",
          refresh: "expired-refresh",
          access: "expired-access",
          expires: Date.now() - 60_000,
          metadata: { orgID: "wrk_expired", orgName: "Old" },
        },
      },
      oauthLogin("cred_live", { orgID: "wrk_live", orgName: "Live" }),
    ]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts();

    expect(accounts.map(({ sourceId, label, state }) => ({ sourceId, label, state }))).toEqual([
      { sourceId: "cred_refresh_failed", label: "Broken", state: "invalid" },
      { sourceId: "cred_missing_token", label: "Empty", state: "invalid" },
      { sourceId: "cred_expired", label: "Old", state: "expired" },
      { sourceId: "cred_live", label: "Live", state: "configured" },
    ]);
    expect(accounts[0]).toMatchObject({
      state: "invalid",
      error: "refresh_failed: HTTP 401",
    });
    expect(accounts[1]).toMatchObject({
      state: "invalid",
      error: "OpenCode Console credential has no access token",
    });
  });

  it("dedupes one effective workspace credential and keeps distinct orgs", async () => {
    const active = oauthLogin("cred_work_active", { orgID: "wrk_work", orgName: "Work" });
    bindConsoleLogins([
      active,
      {
        ...oauthLogin("cred_work_duplicate", { orgID: "wrk_work", orgName: "Work duplicate" }),
        // A second stored alias of the same credential, not a second login.
        value: active.value,
      },
      oauthLogin("cred_personal_inactive", { orgID: "wrk_personal", orgName: "Personal" }),
    ]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts();

    expect(accounts.map(({ sourceId, label, active }) => ({ sourceId, label, active }))).toEqual([
      { sourceId: "cred_work_active", label: "Work", active: true },
      { sourceId: "cred_personal_inactive", label: "Personal", active: false },
    ]);
    expect(accounts.some(({ sourceId }) => sourceId === "cred_work_duplicate")).toBe(false);
  });

  it("keeps distinct member accounts in the same org", async () => {
    bindConsoleLogins([
      oauthLogin(
        "cred_member_a",
        { orgID: "wrk_team", accountID: "acc_a", orgName: "Team" },
        { label: "Member A" },
      ),
      oauthLogin(
        "cred_member_b",
        { orgID: "wrk_team", accountID: "acc_b", orgName: "Team" },
        { label: "Member B" },
      ),
    ]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts();

    expect(accounts.map(({ sourceId, label, active }) => ({ sourceId, label, active }))).toEqual([
      { sourceId: "cred_member_a", label: "Team", active: true },
      { sourceId: "cred_member_b", label: "Team", active: false },
    ]);
    expect(accounts[1]).toMatchObject({
      state: "configured",
      credential: { accountId: "acc_b", accessToken: "cred_member_b-access" },
    });
  });

  it("keeps same-org rows without an account id distinct when their tokens differ", async () => {
    bindConsoleLogins([
      oauthLogin("cred_first", { orgID: "wrk_team", orgName: "Team" }),
      oauthLogin("cred_second", { orgID: "wrk_team", orgName: "Team" }),
    ]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts();

    expect(accounts.map(({ sourceId }) => sourceId)).toEqual(["cred_first", "cred_second"]);
  });

  it("does not dedupe failures that cannot prove the same workspace", async () => {
    const failed = (id: string, label: string): FakeCredential => ({
      integrationId: "opencode",
      id,
      label,
      registered: true,
      method: "oauth",
      value: { type: "oauth" },
      resolveError: "HTTP 401",
    });
    bindConsoleLogins([failed("cred_a", "Work"), failed("cred_b", "Work")]);

    const accounts = await resolveOpenCodeConsoleAuthAccounts();

    expect(accounts.map(({ sourceId }) => sourceId)).toEqual(["cred_a", "cred_b"]);
  });
});

describe("Console request helpers", () => {
  it("uses the login's server, else the default Console server", () => {
    expect(consoleBaseUrl({ accessToken: "a", server: "https://console.example.test" })).toBe(
      "https://console.example.test",
    );
    expect(consoleBaseUrl({ accessToken: "a" })).toBe("https://opencode.ai/console");
  });

  it("sends the bearer token, and the org only when the login has one", () => {
    expect(consoleHeaders({ accessToken: "console-access", orgId: "wrk_1" })).toEqual({
      Authorization: "Bearer console-access",
      Accept: "application/json",
      "x-org-id": "wrk_1",
    });
    expect(consoleHeaders({ accessToken: "console-access" })).toEqual({
      Authorization: "Bearer console-access",
      Accept: "application/json",
    });
    expect(Object.keys(consoleHeaders({ accessToken: "console-access" }))).not.toContain(
      "x-org-id",
    );
  });

  it("scrubs an unexpected request error without leaking the login token", () => {
    expect(
      consoleUnexpectedErrorText(new Error("request failed for st_secret-token"), {
        accessToken: "st_secret-token",
      }),
    ).toBe("request failed for [redacted]");
    expect(consoleUnexpectedErrorText("", { accessToken: "st_secret-token" })).toBe(
      "unknown error",
    );
  });
});
