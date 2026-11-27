import { describe, expect, it } from "vitest";
import { buildSyntheticUsageSnapshot } from "../scripts/fixtures/synthetic-usage.mjs";
import {
  createHttpDashboardClient,
  DashboardError,
  parseUsageSnapshot,
} from "../src/ui/dashboard-client.js";

/** The browser Usage read is a plain same-origin GET with its own range key. */
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

describe("usage HTTP client", () => {
  it("requests the usage route with the requested Usage range", async () => {
    const requests: string[] = [];
    const payload = buildSyntheticUsageSnapshot({ range: "7d", nowMs: NOW });
    const client = createHttpDashboardClient({
      fetchImpl: async (input) => {
        requests.push(String(input));
        return Response.json(payload);
      },
    });

    await expect(client.usage({ range: "7d" })).resolves.toEqual(payload);
    expect(requests).toEqual(["/api/v1/usage?range=7d"]);
  });

  it("rejects a malformed usage payload instead of trusting it", () => {
    const payload = buildSyntheticUsageSnapshot({ range: "7d", nowMs: NOW });
    const account = payload.accounts[0];
    const window = account.windows[0];

    expect(() => parseUsageSnapshot(payload)).not.toThrow();
    expect(() =>
      parseUsageSnapshot({
        ...payload,
        accounts: [{ ...account, windows: [{ ...window, links: [] }] }],
      }),
    ).toThrow(DashboardError);
    expect(() =>
      parseUsageSnapshot({
        ...payload,
        accounts: [
          {
            ...account,
            windows: [
              {
                ...window,
                intervals: [{ ...window.intervals[0], activity: [{ model: 99 }] }],
              },
            ],
          },
        ],
      }),
    ).toThrow(DashboardError);
  });
});
