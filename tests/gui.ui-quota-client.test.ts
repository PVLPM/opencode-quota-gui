import { describe, expect, it } from "vitest";
import {
  createHttpDashboardClient,
  DashboardError,
  parseQuotaSnapshot,
} from "../src/ui/dashboard-client";
import { homeSnapshot, NOW } from "./fixtures/gui-ui-fixtures";

describe("independent browser quota transport", () => {
  it("decodes authoritative legacy provider hide metadata and rejects wrong types", () => {
    const source = homeSnapshot();
    const card = {
      ...source.providers.cards[0],
      rows: [],
      providerScopeId: "anthropic:scope",
      providerScopeHash: "bare-scope",
    };
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: { ...source.providers, cards: [card] },
    };
    expect(parseQuotaSnapshot(payload).providers.cards[0]).toMatchObject({
      providerScopeId: card.providerScopeId,
      providerScopeHash: card.providerScopeHash,
    });
    for (const field of ["providerScopeId", "providerScopeHash"]) {
      expect(() =>
        parseQuotaSnapshot({
          ...payload,
          providers: { ...payload.providers, cards: [{ ...card, [field]: 7 }] },
        }),
      ).toThrow(DashboardError);
    }
  });
  it.each([
    { planLabel: "Plus", accountLabel: "Personal" },
    { accountLabel: "Personal" },
    { planLabel: "Plus" },
    {},
  ])("decodes independent optional plan and account labels: %j", (identity) => {
    const snapshot = homeSnapshot();
    const { accountLabel: _account, ...base } = snapshot.providers.cards[0];
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: { ...snapshot.providers, cards: [{ ...base, rows: [], ...identity }] },
    };
    expect(parseQuotaSnapshot(payload).providers.cards[0]).toEqual(payload.providers.cards[0]);
    expect(() =>
      parseQuotaSnapshot({
        ...payload,
        providers: { ...payload.providers, cards: [{ ...base, planLabel: 7 }] },
      }),
    ).toThrow(DashboardError);
  });

  it("sends an explicit active surface without requesting analytics or quota", async () => {
    const requests: {
      url: string;
      method: string | undefined;
      body: BodyInit | null | undefined;
    }[] = [];
    const client = createHttpDashboardClient({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method, body: init?.body });
        return Response.json({ scope: JSON.parse(String(init?.body)).scope });
      },
    });
    await client.setActiveView?.("analytics");
    await client.setActiveView?.("quota");
    expect(requests).toEqual([
      { url: "/api/v1/view", method: "PUT", body: JSON.stringify({ scope: "analytics" }) },
      { url: "/api/v1/view", method: "PUT", body: JSON.stringify({ scope: "quota" }) },
    ]);
  });

  it("does not retry the optional signal when an older server rejects it", async () => {
    let calls = 0;
    const client = createHttpDashboardClient({
      fetchImpl: async () => {
        calls += 1;
        return Response.json(
          { error: { code: "not-found", message: "Unsupported endpoint." } },
          { status: 404 },
        );
      },
    });
    await expect(client.setActiveView?.("quota")).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
    expect(calls).toBe(1);
  });

  it("decodes quota without requiring analytics fields", () => {
    const providers = {
      cards: [
        {
          cardId: "synthetic:card",
          providerId: "synthetic",
          providerLabel: "Synthetic",
          labelSource: "provider",
          rows: [],
          errors: [],
        },
      ],
      enabledProviders: "auto",
      polledAtMs: NOW,
    };
    const snapshot = parseQuotaSnapshot({
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers,
    });
    expect(snapshot).toEqual({
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers,
    });
    expect(snapshot).not.toHaveProperty("usage");
    expect(snapshot).not.toHaveProperty("projects");
  });

  it("keeps the optional row info sentence through the quota read", () => {
    const snapshot = homeSnapshot();
    const info = "Workspace monthly spend (includes Go API equivalent)";
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: {
        ...snapshot.providers,
        cards: snapshot.providers.cards.map((card) => ({
          ...card,
          rows: [{ ...card.rows[0], info }],
        })),
      },
    };
    const parsed = parseQuotaSnapshot(payload);
    expect(parsed.providers.cards[0]?.rows[0]?.info).toBe(info);
    // A wrong-typed info is rejected like every other row field, never coerced.
    const wrong = JSON.parse(JSON.stringify(payload)) as {
      providers: { cards: { rows: { info?: unknown }[] }[] };
    };
    wrong.providers.cards[0].rows[0].info = 7;
    expect(() => parseQuotaSnapshot(wrong)).toThrow(DashboardError);
  });

  it("rejects malformed provider data instead of inventing a successful empty read", () => {
    expect(() =>
      parseQuotaSnapshot({ generatedAtMs: NOW, stale: false, providers: { cards: null } }),
    ).toThrow(DashboardError);
  });

  it("decodes additive banked reset metadata and persistent visibility rows", () => {
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: {
        enabledProviders: "auto" as const,
        polledAtMs: NOW,
        cards: [
          {
            cardId: "openai:synthetic",
            providerId: "openai",
            providerLabel: "OpenAI",
            labelSource: "provider" as const,
            rows: [
              {
                rowId: "openai:synthetic#openai:resets|status:value",
                label: "Resets",
                kind: "value" as const,
                resultType: "status" as const,
                value: "3 available",
                bankedResets: {
                  availableCount: 3,
                  credits: [
                    { title: "Full reset", expiresAtIso: "2026-10-23T00:00:00.000Z" },
                    { expiresAtIso: null },
                    {},
                  ],
                },
              },
            ],
            errors: [],
            visibilityRows: [
              {
                rowId: "openai:synthetic#openai:resets|status:value",
                label: "Resets",
                info: "Resets info",
              },
              {
                rowId: "openai:synthetic#openai:credits|balance:value",
                label: "Credits",
              },
            ],
          },
        ],
      },
    };

    const parsed = parseQuotaSnapshot(payload);
    expect(parsed.providers.cards[0]?.rows[0]?.bankedResets).toEqual({
      availableCount: 3,
      credits: [
        { title: "Full reset", expiresAtIso: "2026-10-23T00:00:00.000Z" },
        { expiresAtIso: null },
        {},
      ],
    });
    expect(parsed.providers.cards[0]?.visibilityRows).toEqual(
      payload.providers.cards[0]?.visibilityRows,
    );

    for (const mutate of [
      (row: { bankedResets: { availableCount: unknown } }) => {
        row.bankedResets.availableCount = "3";
      },
      (row: { bankedResets: { credits: unknown } }) => {
        row.bankedResets.credits = [{ expiresAtIso: 7 }];
      },
      (row: { bankedResets: { credits: unknown } }) => {
        row.bankedResets.credits = [{ title: 7 }];
      },
    ]) {
      const wrong = JSON.parse(JSON.stringify(payload)) as typeof payload;
      mutate(wrong.providers.cards[0]!.rows[0] as never);
      expect(() => parseQuotaSnapshot(wrong)).toThrow(DashboardError);
    }

    const wrongVisibility = JSON.parse(JSON.stringify(payload)) as typeof payload & {
      providers: { cards: Array<{ visibilityRows: Array<{ rowId?: unknown }> }> };
    };
    wrongVisibility.providers.cards[0]!.visibilityRows[0]!.rowId = 7;
    expect(() => parseQuotaSnapshot(wrongVisibility)).toThrow(DashboardError);
  });

  it("requests only the range-free quota endpoint", async () => {
    const requests: string[] = [];
    const client = createHttpDashboardClient({
      fetchImpl: async (input) => {
        requests.push(String(input));
        return Response.json({
          generatedAtMs: NOW,
          stale: true,
          timeZone: "UTC",
          providers: homeSnapshot().providers,
        });
      },
    });
    expect((await client.quota()).stale).toBe(true);
    expect(requests).toEqual(["/api/v1/quota"]);
  });

  it("preserves controlled quota error envelopes", async () => {
    const client = createHttpDashboardClient({
      fetchImpl: async () =>
        Response.json(
          { error: { code: "internal", message: "Quota is unavailable." } },
          { status: 500 },
        ),
    });
    await expect(client.quota()).rejects.toMatchObject({
      code: "internal",
      status: 500,
      message: "Quota is unavailable.",
    });
  });
});
