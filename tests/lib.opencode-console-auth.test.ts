import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  clearOpenCodeConsoleOrgNameCacheForTests,
  consoleBaseUrl,
  consoleHeaders,
  consoleUnexpectedErrorText,
  getOpenCodeConsoleOrgNameCacheSizeForTests,
  OPENCODE_CONSOLE_ORG_CACHE_MAX_AGE_MS,
  OPENCODE_CONSOLE_ORG_CACHE_MAX_ENTRIES,
  OPENCODE_CONSOLE_ORG_REQUEST_TIMEOUT_MS,
  OPENCODE_CONSOLE_ORG_RESPONSE_MAX_BYTES,
  resolveOpenCodeConsoleAuth,
  resolveOpenCodeConsoleAuthAccounts,
} from "../src/lib/opencode-console-auth.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";

const unbinds: Array<() => void> = [];

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  // Existing reader tests do not assert org-name refresh; an empty workspace
  // list keeps their fallback labels deterministic without live network.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ data: [] })),
  );
});

afterEach(() => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  clearReadAuthFileCacheForTests();
  clearOpenCodeConsoleOrgNameCacheForTests();
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

describe("OpenCode Console org name refresh", () => {
  const baseNow = Date.now();
  const longExpiry = baseNow + 24 * 60 * 60 * 1000;
  const defaultOrgsUrl = "https://opencode.ai/console/api/orgs";

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
        expires: longExpiry,
        metadata,
      },
      { id, ...overrides },
    );
  }

  function authorization(call: unknown[] | undefined): string | undefined {
    const init = call?.[1] as RequestInit | undefined;
    return (init?.headers as Record<string, string> | undefined)?.Authorization;
  }

  function chunkedResponse(chunks: readonly string[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  it("refreshes a renamed org through the shared Console /api/orgs request", async () => {
    const login = oauthLogin("cred_work", { orgID: "wrk_work", orgName: "Old Name" });
    const integration = bindConsoleLogins([login]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        data: [
          { id: "wrk_work_extra", name: "Wrong Workspace" },
          { id: "wrk_work", name: "  Acme\nWorkspace  " },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      state: "configured",
      sourceId: "cred_work",
      label: "Acme Workspace",
      active: true,
      credential: {
        accessToken: "cred_work-access",
        orgId: "wrk_work",
        orgName: "Acme Workspace",
      },
    });
    // The stored login is read-only; refresh only affects the returned view.
    expect(login.value).toMatchObject({
      metadata: { orgID: "wrk_work", orgName: "Old Name" },
    });
    expect(integration.connection.resolve).toHaveBeenCalledOnce();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(defaultOrgsUrl);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        Authorization: "Bearer cred_work-access",
        Accept: "application/json",
        "Cache-Control": "no-store",
      },
      redirect: "error",
    });
  });

  it("reuses a fetched org name for the shared TTL and refreshes it afterwards", async () => {
    bindConsoleLogins([oauthLogin("cred_work", { orgID: "wrk_work" }, { label: "Work" })]);
    let name = "First Name";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: [{ id: "wrk_work", name }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });
    expect(first[0]?.label).toBe("First Name");

    const cached = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow + OPENCODE_CONSOLE_ORG_CACHE_MAX_AGE_MS - 1,
      enrichOrgNames: true,
    });
    expect(cached[0]?.label).toBe("First Name");
    expect(fetchMock).toHaveBeenCalledOnce();

    name = "Second Name";
    const refreshed = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow + OPENCODE_CONSOLE_ORG_CACHE_MAX_AGE_MS,
      enrichOrgNames: true,
    });
    expect(refreshed[0]).toMatchObject({
      sourceId: "cred_work",
      active: true,
      label: "Second Name",
      credential: {
        accessToken: "cred_work-access",
        orgId: "wrk_work",
        orgName: "Second Name",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent org name lookups for one server and org", async () => {
    bindConsoleLogins([oauthLogin("cred_work", { orgID: "wrk_work" }, { label: "Work" })]);
    let release: ((response: Response) => void) | undefined;
    const gate = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => gate);
    vi.stubGlobal("fetch", fetchMock);

    const first = resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow, enrichOrgNames: true });
    const second = resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow, enrichOrgNames: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    release?.(jsonResponse({ data: [{ id: "wrk_work", name: "Acme" }] }));
    const [firstAccounts, secondAccounts] = await Promise.all([first, second]);

    expect(firstAccounts[0]?.label).toBe("Acme");
    expect(secondAccounts[0]?.label).toBe("Acme");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keys the name cache by normalized server and org id, not by label", async () => {
    bindConsoleLogins([
      oauthLogin("cred_default_shared", { orgID: "wrk_shared" }, { label: "Work" }),
      oauthLogin("cred_default_other", { orgID: "wrk_other" }, { label: "Other" }),
      oauthLogin(
        "cred_default_shared_slash",
        { orgID: "wrk_shared", server: "https://opencode.ai/console/" },
        { label: "Work Alias" },
      ),
      oauthLogin(
        "cred_self_hosted",
        { orgID: "wrk_shared", server: "https://console.self-hosted.example/" },
        { label: "Work" },
      ),
    ]);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "https://console.self-hosted.example/api/orgs") {
        return jsonResponse({ data: [{ id: "wrk_shared", name: "Self Hosted" }] });
      }
      if (url === defaultOrgsUrl) {
        return jsonResponse({
          data: [
            { id: "wrk_shared", name: "Default Shared" },
            { id: "wrk_other", name: "Other Workspace" },
          ],
        });
      }
      throw new Error(`unexpected org URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts.map(({ sourceId, label }) => ({ sourceId, label }))).toEqual([
      { sourceId: "cred_default_shared", label: "Default Shared" },
      { sourceId: "cred_default_other", label: "Other Workspace" },
      { sourceId: "cred_default_shared_slash", label: "Default Shared" },
      { sourceId: "cred_self_hosted", label: "Self Hosted" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === defaultOrgsUrl)).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(
        ([url]) => url === "https://console.self-hosted.example/api/orgs",
      ),
    ).toHaveLength(1);
  });

  it("falls back to metadata, alias, and account number when refresh fails", async () => {
    bindConsoleLogins([
      oauthLogin("cred_http", { orgID: "wrk_http", orgName: "Metadata Name" }, { label: "HTTP" }),
      oauthLogin("cred_json", { orgID: "wrk_json" }, { label: "Research" }),
      oauthLogin("cred_network", { orgID: "wrk_network" }, { label: "default" }),
      oauthLogin(
        "cred_missing",
        { orgID: "wrk_missing", orgName: "Missing Name" },
        { label: "Missing" },
      ),
      oauthLogin("cred_invalid_name", { orgID: "wrk_invalid_name" }, { label: "Invalid" }),
      oauthLogin("cred_id_name", { orgID: "wrk_id_name" }, { label: "ID Name" }),
    ]);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = authorization([_url, init]) ?? "";
      if (bearer.includes("cred_http")) return new Response("boom", { status: 500 });
      if (bearer.includes("cred_json")) return new Response("not json", { status: 200 });
      if (bearer.includes("cred_network")) throw new Error("network down");
      if (bearer.includes("cred_missing")) {
        return jsonResponse({ data: [{ id: "wrk_other", name: "Other" }] });
      }
      if (bearer.includes("cred_invalid_name")) {
        return jsonResponse({ data: [{ id: "wrk_invalid_name", name: "   " }] });
      }
      return jsonResponse({ data: [{ id: "wrk_id_name", name: "wrk_id_name" }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts.map(({ sourceId, label, state }) => ({ sourceId, label, state }))).toEqual([
      { sourceId: "cred_http", label: "Metadata Name", state: "configured" },
      { sourceId: "cred_json", label: "Research", state: "configured" },
      { sourceId: "cred_network", label: "Account 3", state: "configured" },
      { sourceId: "cred_missing", label: "Missing Name", state: "configured" },
      { sourceId: "cred_invalid_name", label: "Invalid", state: "configured" },
      { sourceId: "cred_id_name", label: "ID Name", state: "configured" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("does not request org names without an org id and keeps stable labels", async () => {
    bindConsoleLogins([
      oauthLogin("cred_named", { orgName: "Metadata Only" }, { label: "Named" }),
      oauthLogin("cred_alias", {}, { label: "Personal" }),
      oauthLogin("cred_generic", {}, { label: "oauth" }),
    ]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts.map(({ sourceId, label }) => ({ sourceId, label }))).toEqual([
      { sourceId: "cred_named", label: "Metadata Only" },
      { sourceId: "cred_alias", label: "Personal" },
      { sourceId: "cred_generic", label: "Account 3" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps stored labels without enrichment and only fetches when explicitly requested", async () => {
    bindConsoleLogins([
      oauthLogin("cred_stored", { orgID: "wrk_stored", orgName: "Stored Name" }, { label: "Work" }),
    ]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: [{ id: "wrk_stored", name: "Console Name" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const defaultRead = await resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow });
    expect(defaultRead[0]).toMatchObject({
      sourceId: "cred_stored",
      label: "Stored Name",
      credential: { orgId: "wrk_stored", orgName: "Stored Name" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const explicitlyOff = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: false,
    });
    expect(explicitlyOff[0]).toMatchObject({
      sourceId: "cred_stored",
      label: "Stored Name",
      credential: { orgName: "Stored Name" },
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const enriched = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });
    expect(enriched[0]).toMatchObject({
      sourceId: "cred_stored",
      label: "Console Name",
      credential: { orgId: "wrk_stored", orgName: "Console Name" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not let an enriched cached name leak into a no-enrichment read", async () => {
    bindConsoleLogins([
      oauthLogin("cred_stored", { orgID: "wrk_stored", orgName: "Stored Name" }, { label: "Work" }),
    ]);
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ data: [{ id: "wrk_stored", name: "Console Name" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const enriched = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });
    expect(enriched[0]?.label).toBe("Console Name");
    expect(fetchMock).toHaveBeenCalledOnce();

    const stored = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: false,
    });
    expect(stored[0]).toMatchObject({
      sourceId: "cred_stored",
      label: "Stored Name",
      credential: { orgName: "Stored Name" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("parses a chunked org response without a content-length header", async () => {
    bindConsoleLogins([oauthLogin("cred_chunked", { orgID: "wrk_chunked" }, { label: "Chunked" })]);
    const body = JSON.stringify({
      data: [{ id: "wrk_chunked", name: "Chunked Name" }],
    });
    const response = chunkedResponse([body.slice(0, 11), body.slice(11, 33), body.slice(33)]);
    expect(response.headers.has("content-length")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => response),
    );

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts[0]).toMatchObject({
      sourceId: "cred_chunked",
      label: "Chunked Name",
      credential: { orgName: "Chunked Name" },
    });
  });

  it("cancels an oversized chunked org response without a content-length header", async () => {
    bindConsoleLogins([
      oauthLogin(
        "cred_oversized",
        { orgID: "wrk_oversized", orgName: "Fallback" },
        { label: "Big" },
      ),
    ]);
    const chunk = new Uint8Array(Math.ceil(OPENCODE_CONSOLE_ORG_RESPONSE_MAX_BYTES / 4));
    chunk.fill(120);
    let reads = 0;
    let cancelled = false;
    const body = {
      getReader() {
        return {
          async read() {
            if (reads >= 6) return { done: true, value: undefined };
            reads += 1;
            return { done: false, value: chunk };
          },
          async cancel() {
            cancelled = true;
          },
          releaseLock() {},
        };
      },
    };
    const response = { ok: true, headers: new Headers(), body } as unknown as Response;
    expect(response.headers.has("content-length")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, _init?: RequestInit) => response),
    );

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts[0]).toMatchObject({
      sourceId: "cred_oversized",
      label: "Fallback",
      credential: { orgId: "wrk_oversized", orgName: "Fallback" },
    });
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(6);
  });

  it("bounds a hung org lookup and falls back without changing identity fields", async () => {
    vi.useFakeTimers();
    bindConsoleLogins([
      oauthLogin("cred_hung", { orgID: "wrk_hung", orgName: "Fallback" }, { label: "Hung" }),
    ]);
    let markStarted: (() => void) | undefined;
    const fetchStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => {
      markStarted?.();
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow, enrichOrgNames: true });
    await fetchStarted;
    await vi.advanceTimersByTimeAsync(OPENCODE_CONSOLE_ORG_REQUEST_TIMEOUT_MS);
    const accounts = await pending;

    expect(accounts[0]).toMatchObject({
      state: "configured",
      sourceId: "cred_hung",
      label: "Fallback",
      active: true,
      credential: {
        accessToken: "cred_hung-access",
        orgId: "wrk_hung",
        orgName: "Fallback",
      },
    });

    // The failed lookup is cached, so the next read does not hang again.
    await expect(
      resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow + 1, enrichOrgNames: true }),
    ).resolves.toMatchObject([{ sourceId: "cred_hung", label: "Fallback" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the shared org name cache bounded and evicts its oldest entry", async () => {
    const count = OPENCODE_CONSOLE_ORG_CACHE_MAX_ENTRIES + 1;
    const logins = Array.from({ length: count }, (_, index) =>
      oauthLogin(`cred_${index}`, { orgID: `wrk_${index}` }, { label: `Org ${index}` }),
    );
    bindConsoleLogins(logins);
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const bearer = authorization([_url, init]) ?? "";
      const index = Number(/cred_(\d+)-access/.exec(bearer)?.[1] ?? Number.NaN);
      return jsonResponse({ data: [{ id: `wrk_${index}`, name: `Name ${index}` }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const accounts = await resolveOpenCodeConsoleAuthAccounts({
      nowMs: baseNow,
      enrichOrgNames: true,
    });

    expect(accounts).toHaveLength(count);
    expect(fetchMock).toHaveBeenCalledTimes(count);
    expect(getOpenCodeConsoleOrgNameCacheSizeForTests()).toBe(
      OPENCODE_CONSOLE_ORG_CACHE_MAX_ENTRIES,
    );

    const firstLogin = logins[0];
    const lastLogin = logins[count - 1];
    if (!firstLogin || !lastLogin) throw new Error("expected generated logins");

    bindConsoleLogins([firstLogin]);
    notifyCredentialsChanged();
    await resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow + 1, enrichOrgNames: true });
    expect(fetchMock).toHaveBeenCalledTimes(count + 1);

    bindConsoleLogins([lastLogin]);
    notifyCredentialsChanged();
    await resolveOpenCodeConsoleAuthAccounts({ nowMs: baseNow + 1, enrichOrgNames: true });
    expect(fetchMock).toHaveBeenCalledTimes(count + 1);
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
