import { describe, expect, it } from "vitest";
import {
  createHttpDashboardClient,
  DashboardError,
  parseQuotaSnapshot,
} from "../src/ui/dashboard-client";
import { homeSnapshot, NOW } from "./fixtures/gui-ui-fixtures";

describe("independent browser quota transport", () => {
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
