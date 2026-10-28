import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildProviderCards } from "../src/gui/provider-cards.js";
import type { QuotaProviderResult } from "../src/lib/entries.js";
import {
  bindCredentialSource,
  clearReadAuthFileCacheForTests,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
} from "../src/lib/opencode-auth.js";
import {
  __resetOpenCodeGoNotSubscribedForTests,
  opencodeGoProvider,
} from "../src/providers/opencode-go.js";
import { opencodeZenProvider } from "../src/providers/opencode-zen.js";
import { createFakeIntegration, type FakeCredential } from "./helpers/fake-integration.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

/**
 * Integration coverage for the shared Console workspace-name lookup used by
 * both OpenCode Go and OpenCode Zen.
 *
 * The credential store is the public fake integration (fake OAuth credentials),
 * the Console is a fake global fetch, and time is fake so the 10-minute TTL is
 * exercised without waiting. No provider is contacted and no production module
 * is mocked, so Go and Zen both go through their real provider and auth paths.
 */

const CONSOLE_ORIGIN = "https://opencode.ai/console";
const ORGS_URL = `${CONSOLE_ORIGIN}/api/orgs`;
const CREDENTIAL_ID = "cred_console_workspace";
const ACCOUNT_ID = "acc_workspace_owner";
const ACCESS_TOKEN = "fake-console-access-token";
const TTL_MS = 10 * 60 * 1000;
const BASE_NOW = Date.parse("2026-10-28T12:00:00.000Z");
const EXPIRES_AT = BASE_NOW + 24 * 60 * 60 * 1000;

const unbinds: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers({ now: BASE_NOW });
  clearReadAuthFileCacheForTests();
  notifyCredentialsChanged();
  __resetOpenCodeGoNotSubscribedForTests();
});

afterEach(() => {
  for (const unbind of unbinds.splice(0)) unbind();
  notifyCredentialsChanged();
  clearReadAuthFileCacheForTests();
  __resetOpenCodeGoNotSubscribedForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type OrgCall = {
  url: string;
  init?: RequestInit;
};

type WorkspaceHarness = {
  orgCalls: OrgCall[];
  setOrgName: (name: string) => void;
  fetchBoth: () => Promise<{ go: QuotaProviderResult; zen: QuotaProviderResult }>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const goStatusPayload = {
  access: {
    meters: {
      fiveHour: {
        limitMicroCents: 1_000_000_000,
        usedMicroCents: 100_000_000,
        resetsAt: "2026-10-28T17:00:00.000Z",
      },
      week: {
        limitMicroCents: 5_000_000_000,
        usedMicroCents: 500_000_000,
        resetsAt: "2026-11-02T00:00:00.000Z",
      },
      month: {
        limitMicroCents: 10_000_000_000,
        usedMicroCents: 1_000_000_000,
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    },
  },
};

/**
 * One Console workspace backed by the real fake credential source, with a
 * router for the Console routes Go and Zen actually request.
 */
function createWorkspaceHarness(params: { orgId: string; initialName?: string }): WorkspaceHarness {
  let orgName = params.initialName ?? "Acme";
  const orgCalls: OrgCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === ORGS_URL) {
      orgCalls.push({ url, init });
      return jsonResponse({ data: [{ id: params.orgId, name: orgName }] });
    }
    if (url === `${CONSOLE_ORIGIN}/api/go/status`) return jsonResponse(goStatusPayload);
    if (url === `${CONSOLE_ORIGIN}/api/billing/status`) {
      return jsonResponse({ balanceMicroCents: "4250000000" });
    }
    if (url === `${CONSOLE_ORIGIN}/api/billing/account`) {
      return jsonResponse({ creditLimitMicroCents: null });
    }
    if (url === `${CONSOLE_ORIGIN}/api/billing/auto-recharge`) {
      return jsonResponse({
        enabled: false,
        rechargeAmountDollars: null,
        thresholdDollars: null,
      });
    }
    if (url === `${CONSOLE_ORIGIN}/api/policies/members/${ACCOUNT_ID}`) {
      return jsonResponse({ userID: ACCOUNT_ID, budgets: [], policies: [] });
    }
    if (url === `${CONSOLE_ORIGIN}/api/usage/cost-by-day`) return jsonResponse([]);

    throw new Error(`unexpected fake Console request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const credential: FakeCredential = {
    integrationId: "opencode",
    id: CREDENTIAL_ID,
    label: "default",
    registered: true,
    method: "oauth",
    value: {
      type: "oauth",
      methodID: "device",
      refresh: "fake-console-refresh-token",
      access: ACCESS_TOKEN,
      expires: EXPIRES_AT,
      metadata: {
        accountID: ACCOUNT_ID,
        orgID: params.orgId,
        // Stale stored metadata; the Console is the current name source.
        orgName: "Stale Metadata Name",
      },
    },
  };
  const integration = createFakeIntegration([credential]);
  unbinds.push(bindCredentialSource(createIntegrationCredentialSource(integration as never)));
  notifyCredentialsChanged();

  const context = createProviderAvailabilityContext({
    configOverrides: {
      opencodeGoWindows: ["rolling", "weekly", "monthly"],
      requestTimeoutMs: 5_000,
    },
  });

  return {
    orgCalls,
    setOrgName(name: string): void {
      orgName = name;
    },
    async fetchBoth() {
      const go = await opencodeGoProvider.fetch(context);
      const zen = await opencodeZenProvider.fetch(context);
      return { go, zen };
    },
  };
}

function cardsFor(results: { go: QuotaProviderResult; zen: QuotaProviderResult }) {
  return buildProviderCards({
    probes: [
      { providerId: "opencode-go", result: results.go },
      { providerId: "opencode", result: results.zen },
    ],
    preferences: { accountingDetail: "summary" },
    nowMs: Date.now(),
  });
}

function accountLabels(results: { go: QuotaProviderResult; zen: QuotaProviderResult }) {
  return [results.go.accounts?.[0]?.label, results.zen.accounts?.[0]?.label];
}

function accountSourceIds(results: { go: QuotaProviderResult; zen: QuotaProviderResult }) {
  return [results.go.accounts?.[0]?.sourceId, results.zen.accounts?.[0]?.sourceId];
}

function entrySourceIds(result: QuotaProviderResult): Array<string | undefined> {
  return [...new Set(result.entries.map((entry) => entry.accounting.sourceId))];
}

describe("Console workspace label integration", () => {
  it("shares one /api/orgs lookup between Go and Zen, and refreshes it after 10 minutes", async () => {
    const harness = createWorkspaceHarness({ orgId: "wrk_shared_ttl", initialName: "Acme" });

    const first = await harness.fetchBoth();

    // Initial rename: the Console name replaces the stale stored metadata name.
    expect(accountLabels(first)).toEqual(["Acme", "Acme"]);
    expect(accountSourceIds(first)).toEqual([CREDENTIAL_ID, CREDENTIAL_ID]);
    expect(entrySourceIds(first.go)).toEqual([CREDENTIAL_ID]);
    expect(entrySourceIds(first.zen)).toEqual([CREDENTIAL_ID]);

    // Both providers are served by the one shared org lookup.
    expect(harness.orgCalls).toHaveLength(1);
    expect(harness.orgCalls[0]?.url).toBe(ORGS_URL);
    expect(harness.orgCalls[0]?.init).toMatchObject({
      method: "GET",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        Accept: "application/json",
      },
    });

    // A later Console rename stays invisible while the 10-minute cache is fresh.
    harness.setOrgName("Acme Renamed");
    vi.setSystemTime(BASE_NOW + TTL_MS - 1);
    const cached = await harness.fetchBoth();
    expect(accountLabels(cached)).toEqual(["Acme", "Acme"]);
    expect(harness.orgCalls).toHaveLength(1);

    // At the TTL boundary the next read refreshes once for both providers.
    vi.setSystemTime(BASE_NOW + TTL_MS);
    const refreshed = await harness.fetchBoth();
    expect(accountLabels(refreshed)).toEqual(["Acme Renamed", "Acme Renamed"]);
    expect(entrySourceIds(refreshed.go)).toEqual([CREDENTIAL_ID]);
    expect(entrySourceIds(refreshed.zen)).toEqual([CREDENTIAL_ID]);
    expect(harness.orgCalls).toHaveLength(2);
  });

  it("keeps Go and Zen card and source identities stable across a Console rename", async () => {
    const harness = createWorkspaceHarness({ orgId: "wrk_shared_rename", initialName: "Acme" });

    const first = await harness.fetchBoth();
    const firstCards = cardsFor(first);
    expect(firstCards.map((card) => card.providerId)).toEqual(["opencode-go", "opencode"]);
    expect(firstCards.map((card) => card.accountLabel)).toEqual(["Acme", "Acme"]);
    expect(firstCards.map((card) => card.labelSource)).toEqual(["connection", "connection"]);
    expect(firstCards.every((card) => card.rows.length > 0)).toBe(true);

    const firstCardIds = firstCards.map((card) => card.cardId);
    const firstRowIds = firstCards.map((card) => card.rows.map((row) => row.rowId));
    const firstSourceIds = {
      goAccounts: first.go.accounts?.map((account) => account.sourceId),
      zenAccounts: first.zen.accounts?.map((account) => account.sourceId),
      goEntries: entrySourceIds(first.go),
      zenEntries: entrySourceIds(first.zen),
    };

    harness.setOrgName("Acme Renamed");
    vi.setSystemTime(BASE_NOW + TTL_MS);
    const renamed = await harness.fetchBoth();
    const renamedCards = cardsFor(renamed);

    // The display label follows the Console rename on both surfaces.
    expect(renamedCards.map((card) => card.accountLabel)).toEqual(["Acme Renamed", "Acme Renamed"]);
    expect(accountLabels(renamed)).toEqual(["Acme Renamed", "Acme Renamed"]);

    // Card, row, and source identity do not move with the label.
    expect(renamedCards.map((card) => card.cardId)).toEqual(firstCardIds);
    expect(renamedCards.map((card) => card.rows.map((row) => row.rowId))).toEqual(firstRowIds);
    expect({
      goAccounts: renamed.go.accounts?.map((account) => account.sourceId),
      zenAccounts: renamed.zen.accounts?.map((account) => account.sourceId),
      goEntries: entrySourceIds(renamed.go),
      zenEntries: entrySourceIds(renamed.zen),
    }).toEqual(firstSourceIds);
  });
});
