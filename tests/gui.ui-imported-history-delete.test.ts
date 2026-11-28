import { describe, expect, it } from "vitest";
import { createHttpDashboardClient } from "../src/ui/dashboard-client";

/**
 * Imported-history deletion transport (v1.4.0 D10).
 *
 * One fixed endpoint, one POST, one harness per call, counts back. The browser
 * never composes a path, id or row filter of its own.
 */
describe("imported-history deletion transport", () => {
  it("posts only the harness to the fixed endpoint and returns counts", async () => {
    const requests: { url: string; method?: string; body?: BodyInit | null }[] = [];
    const client = createHttpDashboardClient({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method, body: init?.body });
        return Response.json({ invocations: 3, rateLimitSeries: 1 });
      },
    });

    expect(requests).toEqual([]);
    await expect(client.deleteImportedHistory?.("claude-code")).resolves.toEqual({
      invocations: 3,
      rateLimitSeries: 1,
    });
    expect(requests).toEqual([
      {
        url: "/api/v1/imported-history/delete",
        method: "POST",
        body: JSON.stringify({ harness: "claude-code" }),
      },
    ]);
  });

  it("preserves the controlled host refusal without retry", async () => {
    let requests = 0;
    const client = createHttpDashboardClient({
      fetchImpl: async () => {
        requests += 1;
        return Response.json(
          {
            error: {
              code: "config-target-error",
              message: "Deleting imported history is not available",
            },
          },
          { status: 409 },
        );
      },
    });

    await expect(client.deleteImportedHistory?.("codex")).rejects.toMatchObject({
      code: "config-target-error",
      status: 409,
    });
    expect(requests).toBe(1);
  });

  it.each([
    { payload: { invocations: 3 }, detail: "a missing series count" },
    { payload: { invocations: -1, rateLimitSeries: 0 }, detail: "a negative count" },
    { payload: { invocations: 1.5, rateLimitSeries: 0 }, detail: "a fractional count" },
    { payload: { invocations: "3", rateLimitSeries: 0 }, detail: "a text count" },
  ])("rejects a response carrying $detail", async ({ payload }) => {
    const client = createHttpDashboardClient({
      fetchImpl: async () => Response.json(payload),
    });
    await expect(client.deleteImportedHistory?.("codex")).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
});
