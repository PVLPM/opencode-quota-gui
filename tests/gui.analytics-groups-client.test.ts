import { describe, expect, it } from "vitest";

import {
  decodeAnalyticsEntityToken,
  encodeAnalyticsEntityToken,
} from "../src/contracts/analytics-entity.js";
import type { AnalyticsEntityIdentity, AnalyticsGroupQuery } from "../src/contracts/dashboard.js";
import {
  createHttpDashboardClient,
  DashboardError,
  parseGroupSnapshot,
} from "../src/ui/dashboard-client.js";
import { costed, DAY_MS, NOW } from "./fixtures/gui-ui-fixtures";

function groupPayload(
  options: {
    dimension?: "model" | "provider";
    filter?: AnalyticsGroupQuery["filter"];
    identity?: AnalyticsEntityIdentity;
  } = {},
): Record<string, unknown> {
  const dimension = options.dimension ?? "model";
  const filter = options.filter;
  return {
    dimension,
    range: "7d",
    window: { sinceMs: NOW - DAY_MS, untilMs: NOW },
    bucketUnit: "day",
    timeZone: "UTC",
    ...(filter === undefined ? {} : { filter }),
    buckets: [{ startMs: NOW - DAY_MS, endMs: NOW }],
    totals: costed({ input: 10, output: 4 }),
    sessionCount: 2,
    stepCount: 3,
    rows: [
      {
        identity: options.identity ?? { kind: "known", id: "gpt-5" },
        tokens: costed({ input: 10, output: 4 }),
        sessionCount: 2,
        stepCount: 3,
        children: [
          {
            identity: { kind: "unknown" },
            tokens: costed({ input: 10, output: 4 }),
            sessionCount: 2,
            stepCount: 3,
            children: [],
          },
        ],
      },
    ],
    series: [
      {
        kind: "entity",
        identity: options.identity ?? { kind: "known", id: "gpt-5" },
        tokens: costed({ input: 10, output: 4 }),
        buckets: [costed({ input: 10, output: 4 })],
      },
      {
        kind: "other",
        tokens: costed(),
        buckets: [costed()],
      },
    ],
    stale: false,
  };
}

describe("grouped analytics browser transport", () => {
  it("decodes grouped rows, series and an echoed exact filter", () => {
    const filter: AnalyticsGroupQuery["filter"] = {
      dimension: "model",
      identity: { kind: "known", id: "" },
    };
    const parsed = parseGroupSnapshot(
      groupPayload({ dimension: "provider", filter, identity: { kind: "known", id: "" } }) as never,
      "/api/v1/models/k.",
    );
    expect(parsed.dimension).toBe("provider");
    expect(parsed.filter).toEqual(filter);
    expect(parsed.rows[0]?.identity).toEqual({ kind: "known", id: "" });
    expect(parsed.rows[0]?.children[0]?.identity).toEqual({ kind: "unknown" });
    expect(parsed.series[0]).toMatchObject({ kind: "entity", identity: { kind: "known", id: "" } });
    expect(parsed.series[1]?.kind).toBe("other");
    expect(parsed.totals.total).toBe(14);
  });

  it("omits an absent filter rather than inventing one", () => {
    const parsed = parseGroupSnapshot(groupPayload() as never, "/api/v1/models");
    expect(parsed.filter).toBeUndefined();
    expect(Object.hasOwn(parsed, "filter")).toBe(false);
  });

  it("parses optional child buckets aligned with each series bucket", () => {
    const payload = groupPayload();
    const series = payload.series as Record<string, unknown>[];
    series[0] = {
      ...series[0],
      childBuckets: [
        [
          { identity: { kind: "known", id: "openai" }, tokens: costed({ input: 7, output: 3 }) },
          { identity: { kind: "unknown" }, tokens: costed({ input: 4 }) },
        ],
      ],
    };
    series[1] = {
      ...series[1],
      childBuckets: [
        [{ identity: { kind: "known", id: "gpt-5" }, tokens: costed({ input: 9, output: 1 }) }],
      ],
    };

    const parsed = parseGroupSnapshot(payload as never, "/api/v1/models");
    expect(parsed.series[0]?.childBuckets).toHaveLength(1);
    expect(parsed.series[0]?.childBuckets?.[0]?.map((child) => child.identity)).toEqual([
      { kind: "known", id: "openai" },
      { kind: "unknown" },
    ]);
    expect(parsed.series[0]?.childBuckets?.[0]?.[0]?.tokens.total).toBe(10);
    expect(parsed.series[1]?.childBuckets?.[0]?.[0]?.identity).toEqual({
      kind: "known",
      id: "gpt-5",
    });

    const plain = parseGroupSnapshot(groupPayload() as never, "/api/v1/models");
    expect(plain.series[0] === undefined || Object.hasOwn(plain.series[0], "childBuckets")).toBe(
      false,
    );
  });

  it.each([
    ["a misaligned bucket count", [[], []]],
    ["a non-array bucket", [{}]],
    ["a malformed child identity", [[{ identity: { kind: "x" }, tokens: costed({ input: 1 }) }]]],
    [
      "a malformed child token total",
      [[{ identity: { kind: "known", id: "openai" }, tokens: {} }]],
    ],
    [
      "a duplicate child identity",
      [
        [
          { identity: { kind: "known", id: "openai" }, tokens: costed({ input: 1 }) },
          { identity: { kind: "known", id: "openai" }, tokens: costed({ input: 2 }) },
        ],
      ],
    ],
  ])("rejects child buckets with %s", (_label, childBuckets) => {
    const payload = groupPayload();
    const series = payload.series as Record<string, unknown>[];
    series[0] = { ...series[0], childBuckets };
    expect(() => parseGroupSnapshot(payload as never, "/api/v1/models")).toThrow(DashboardError);
  });

  it.each([
    [
      "identity kind",
      { rows: [{ ...(groupPayload().rows as never[])[0], identity: { kind: "x" } }] },
    ],
    [
      "known id type",
      { rows: [{ ...(groupPayload().rows as never[])[0], identity: { kind: "known", id: 4 } }] },
    ],
    ["series kind", { series: [{ kind: "chart", tokens: costed(), buckets: [] }] }],
    ["dimension", { dimension: "session" }],
    ["filter dimension", { filter: { dimension: "tool", identity: { kind: "unknown" } } }],
    ["stale", { stale: "no" }],
    ["timeZone", { timeZone: 7 }],
    ["bucket boundary", { buckets: [{ startMs: "x", endMs: NOW }] }],
  ])("rejects a malformed payload field: %s", (_label, override) => {
    expect(() =>
      parseGroupSnapshot({ ...groupPayload(), ...override } as never, "/api/v1/models"),
    ).toThrow(DashboardError);
  });

  it("builds route-specific list and tagged detail endpoints", async () => {
    const requests: string[] = [];
    const identities = new Map<string, AnalyticsEntityIdentity>();
    const client = createHttpDashboardClient({
      fetchImpl: async (input) => {
        const url = String(input);
        requests.push(url);
        const detail = /\/api\/v1\/(models|providers)\/([^?]+)\?/.exec(url);
        if (detail) {
          const identity = decodeAnalyticsEntityToken(detail[2] ?? "");
          if (!identity) throw new Error("test request used a malformed token");
          identities.set(url, identity);
          const entityDimension = detail[1] === "models" ? "model" : "provider";
          const requestedGroup = new URL(url, "http://127.0.0.1").searchParams.get("group");
          const groupDimension =
            requestedGroup === "model" || requestedGroup === "provider"
              ? requestedGroup
              : entityDimension === "model"
                ? "provider"
                : "model";
          return Response.json(
            groupPayload({
              dimension: groupDimension,
              filter: { dimension: entityDimension, identity },
              identity,
            }),
          );
        }
        const collection = /\/api\/v1\/(models|providers)\?/.exec(url);
        return Response.json(
          groupPayload({ dimension: collection?.[1] === "providers" ? "provider" : "model" }),
        );
      },
    });

    expect(await client.groups({ range: "24h", dimension: "model" })).toMatchObject({
      dimension: "model",
    });
    expect(await client.groups({ range: "7d", dimension: "provider" })).toMatchObject({
      dimension: "provider",
    });

    const tricky: AnalyticsEntityIdentity = { kind: "known", id: "a/b #%|||unknown.js" };
    const modelDetail = await client.groups({
      range: "7d",
      dimension: "provider",
      filter: { dimension: "model", identity: tricky },
    });
    expect(modelDetail.filter).toEqual({ dimension: "model", identity: tricky });

    const providerDetail = await client.groups({
      range: "30d",
      dimension: "model",
      filter: { dimension: "provider", identity: { kind: "known", id: "" } },
    });
    expect(providerDetail.filter).toEqual({
      dimension: "provider",
      identity: { kind: "known", id: "" },
    });

    const unknownDetail = await client.groups({
      range: "24h",
      dimension: "model",
      filter: { dimension: "provider", identity: { kind: "unknown" } },
    });
    expect(unknownDetail.filter).toEqual({
      dimension: "provider",
      identity: { kind: "unknown" },
    });

    const sameAxis = await client.groups({
      range: "7d",
      dimension: "model",
      filter: { dimension: "model", identity: { kind: "known", id: "gpt-5" } },
    });
    expect(sameAxis).toMatchObject({ dimension: "model" });

    expect(requests).toEqual([
      "/api/v1/models?range=24h",
      "/api/v1/providers?range=7d",
      `/api/v1/models/${encodeAnalyticsEntityToken(tricky)}?range=7d`,
      `/api/v1/providers/${encodeAnalyticsEntityToken({ kind: "known", id: "" })}?range=30d`,
      `/api/v1/providers/${encodeAnalyticsEntityToken({ kind: "unknown" })}?range=24h`,
      `/api/v1/models/${encodeAnalyticsEntityToken({ kind: "known", id: "gpt-5" })}?range=7d&group=model`,
    ]);
    expect(identities.get(requests[2] ?? "")).toEqual(tricky);
  });

  it("maps controlled group route failures to DashboardError", async () => {
    const client = createHttpDashboardClient({
      fetchImpl: async () =>
        Response.json(
          { error: { code: "bad-request", message: "Malformed request" } },
          {
            status: 400,
          },
        ),
    });
    await expect(client.groups({ range: "24h", dimension: "model" })).rejects.toMatchObject({
      code: "bad-request",
      status: 400,
    });
  });
});
