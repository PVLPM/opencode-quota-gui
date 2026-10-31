import { describe, expect, it } from "vitest";
import {
  createHttpDashboardClient,
  DashboardError,
  parseQuotaSnapshot,
} from "../src/ui/dashboard-client";
import { groupTemporalModels } from "../src/ui/temporal-format";
import { homeSnapshot, NOW } from "./fixtures/gui-ui-fixtures";

describe("independent browser quota transport", () => {
  it("preserves the next temporal destination for far transitions and grouping", () => {
    const source = homeSnapshot();
    const interval = { startMs: NOW - 60_000, endMs: NOW + 60_000, phase: "peak" as const };
    const model = {
      modelId: "far-model",
      state: "peak" as const,
      nextChangeAtMs: NOW + 4 * 24 * 60 * 60 * 1000,
      nextState: "offpeak" as const,
      intervals: [interval],
    };
    const temporalProvider = {
      providerId: "deepseek",
      providerLabel: "DeepSeek",
      discovered: true,
      phase: "peak" as const,
      models: [
        model,
        { ...model, modelId: "far-model-2", nextState: "peak" as const },
        // The server states `unknown` when the destination is unresolved; that
        // is a real value to preserve, not something to omit or guess past.
        { ...model, modelId: "far-model-3", nextState: "unknown" as const },
      ],
      holidays: [],
    };
    const temporal = {
      generatedAtMs: NOW,
      providers: [temporalProvider],
      snapshot: { revision: "parser-test", generatedAtMs: NOW },
    };
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: source.providers,
      temporal,
    };
    const parsed = parseQuotaSnapshot(payload);
    const models = parsed.temporal?.providers[0]?.models ?? [];
    expect(models[0]?.nextState).toBe("offpeak");
    expect(models[1]?.nextState).toBe("peak");
    expect(models[2]?.nextState).toBe("unknown");
    // The destination is policy data: routes with different next states must
    // never collapse into one schedule row.
    expect(groupTemporalModels(models)).toHaveLength(3);

    expect(() =>
      parseQuotaSnapshot({
        ...payload,
        temporal: {
          ...temporal,
          providers: [
            {
              ...temporalProvider,
              models: [{ ...model, nextState: "sideways" }],
            },
          ],
        },
      }),
    ).toThrow(DashboardError);
  });

  it("preserves the explicit scalar classification and rejects a non-boolean", () => {
    const source = homeSnapshot();
    const effect = {
      factor: 0.5,
      direction: "offpeak" as const,
      unit: "api_price" as const,
      scalar: false,
    };
    const model = {
      modelId: "partial-model",
      state: "offpeak" as const,
      effect,
      intervals: [
        {
          startMs: NOW - 60_000,
          endMs: NOW + 60_000,
          phase: "offpeak" as const,
          effect,
        },
      ],
    };
    const temporalProvider = {
      providerId: "scalar",
      providerLabel: "Scalar",
      discovered: true,
      phase: "offpeak" as const,
      models: [model],
      holidays: [],
    };
    const temporal = {
      generatedAtMs: NOW,
      providers: [temporalProvider],
      snapshot: { revision: "parser-test", generatedAtMs: NOW },
    };
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: source.providers,
      temporal,
    };

    const parsed = parseQuotaSnapshot(payload);
    expect(parsed.temporal?.providers[0]?.models[0]?.effect?.scalar).toBe(false);
    expect(parsed.temporal?.providers[0]?.models[0]?.intervals[0]?.effect?.scalar).toBe(false);

    const uniform = parseQuotaSnapshot({
      ...payload,
      temporal: {
        ...temporal,
        providers: [
          {
            ...temporalProvider,
            models: [
              {
                ...model,
                effect: { ...effect, scalar: true },
                intervals: [{ ...model.intervals[0], effect: { ...effect, scalar: true } }],
              },
            ],
          },
        ],
      },
    });
    expect(uniform.temporal?.providers[0]?.models[0]?.effect?.scalar).toBe(true);
    expect(uniform.temporal?.providers[0]?.models[0]?.intervals[0]?.effect?.scalar).toBe(true);

    // Old wire omits the additive field entirely and still decodes.
    const { scalar: _scalar, ...legacyEffect } = effect;
    const legacy = parseQuotaSnapshot({
      ...payload,
      temporal: {
        ...temporal,
        providers: [
          {
            ...temporalProvider,
            models: [
              {
                ...model,
                effect: legacyEffect,
                intervals: [{ ...model.intervals[0], effect: legacyEffect }],
              },
            ],
          },
        ],
      },
    });
    expect(legacy.temporal?.providers[0]?.models[0]?.effect).toMatchObject({
      factor: 0.5,
      direction: "offpeak",
      unit: "api_price",
    });
    expect(legacy.temporal?.providers[0]?.models[0]?.effect?.scalar).toBeUndefined();

    expect(() =>
      parseQuotaSnapshot({
        ...payload,
        temporal: {
          ...temporal,
          providers: [
            {
              ...temporalProvider,
              models: [{ ...model, effect: { ...effect, scalar: "no" } }],
            },
          ],
        },
      }),
    ).toThrow(DashboardError);
  });

  it("rejects scalar on quota-point effects and decodes mixed scalar data", () => {
    const source = homeSnapshot();
    const quotaEffect = {
      factor: 0.5,
      direction: "offpeak" as const,
      unit: "quota_points" as const,
    };
    const apiEffect = {
      factor: 2,
      direction: "peak" as const,
      unit: "api_price" as const,
      scalar: true,
    };
    const modelFor = (modelId: string, state: "peak" | "offpeak", effect: object) => ({
      modelId,
      state,
      effect,
      intervals: [{ startMs: NOW - 60_000, endMs: NOW + 60_000, phase: state, effect }],
    });
    const temporalProvider = {
      providerId: "mixed-scalar",
      providerLabel: "Mixed scalar",
      discovered: true,
      phase: "mixed" as const,
      models: [
        modelFor("quota-model", "offpeak", quotaEffect),
        modelFor("api-model", "peak", apiEffect),
      ],
      holidays: [],
    };
    const temporal = {
      generatedAtMs: NOW,
      providers: [temporalProvider],
      snapshot: { revision: "parser-test", generatedAtMs: NOW },
    };
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: source.providers,
      temporal,
    };

    // A quota-point effect without the field and an API-price effect with it
    // coexist in one snapshot; only the contradictory combination is rejected.
    const parsed = parseQuotaSnapshot(payload);
    expect(parsed.temporal?.providers[0]?.models[0]?.effect).toMatchObject(quotaEffect);
    expect(parsed.temporal?.providers[0]?.models[1]?.effect).toMatchObject(apiEffect);

    for (const scalar of [false, true]) {
      expect(() =>
        parseQuotaSnapshot({
          ...payload,
          temporal: {
            ...temporal,
            providers: [
              {
                ...temporalProvider,
                models: [modelFor("quota-model", "offpeak", { ...quotaEffect, scalar })],
              },
            ],
          },
        }),
      ).toThrow(DashboardError);
    }

    // Interval effects share the same parser and must reject the field too.
    expect(() =>
      parseQuotaSnapshot({
        ...payload,
        temporal: {
          ...temporal,
          providers: [
            {
              ...temporalProvider,
              models: [
                {
                  ...modelFor("quota-model", "offpeak", quotaEffect),
                  intervals: [
                    {
                      startMs: NOW - 60_000,
                      endMs: NOW + 60_000,
                      phase: "offpeak" as const,
                      effect: { ...quotaEffect, scalar: false },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(DashboardError);
  });

  it("decodes the weekly descriptor and keeps differing schedules apart", () => {
    const source = homeSnapshot();
    const effect = { factor: 1, direction: "unchanged" as const, unit: "api_price" as const };
    const peak = { factor: 2, direction: "peak" as const, unit: "api_price" as const };
    const interval = {
      startMs: NOW - 60_000,
      endMs: NOW + 60_000,
      phase: "peak" as const,
      effect: peak,
    };
    const weekly = {
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      basePhase: "offpeak" as const,
      baseEffect: effect,
      windows: [
        {
          days: ["tue", "mon"] as const,
          startMinute: 60,
          endMinute: 240,
          phase: "peak" as const,
          effect: peak,
        },
      ],
      exceptHolidays: ["CN"] as const,
    };
    const base = {
      modelId: "weekly-a",
      state: "offpeak" as const,
      effect,
      intervals: [interval],
      weekly,
    };
    const same = { ...base, modelId: "weekly-b" };
    const changed = {
      ...base,
      modelId: "weekly-c",
      weekly: {
        ...weekly,
        windows: [{ ...weekly.windows[0], startMinute: 90 }],
      },
    };
    const temporal = {
      generatedAtMs: NOW,
      providers: [
        {
          providerId: "deepseek",
          providerLabel: "DeepSeek",
          discovered: true,
          phase: "offpeak" as const,
          models: [base, same, changed],
          holidays: [],
        },
      ],
      snapshot: { revision: "weekly-parser", generatedAtMs: NOW },
    };
    const payload = {
      generatedAtMs: NOW,
      stale: false,
      timeZone: "UTC",
      providers: source.providers,
      temporal,
    };
    const models = parseQuotaSnapshot(payload).temporal?.providers[0]?.models ?? [];
    expect(models[0]?.weekly).toEqual({
      ...weekly,
      windows: [{ ...weekly.windows[0], days: ["mon", "tue"] }],
    });
    expect(models[0]?.weekly?.exceptHolidays).toEqual(["CN"]);
    expect(groupTemporalModels(models)).toHaveLength(2);

    expect(() =>
      parseQuotaSnapshot({
        ...payload,
        temporal: {
          ...temporal,
          providers: [
            {
              ...temporal.providers[0],
              models: [
                {
                  ...base,
                  weekly: {
                    ...weekly,
                    windows: [{ ...weekly.windows[0], endMinute: 60 }],
                  },
                },
              ],
            },
          ],
        },
      }),
    ).toThrow(DashboardError);
  });

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
