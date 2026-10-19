import { describe, expect, it } from "vitest";
import { createHttpDashboardClient } from "../src/ui/dashboard-client";

describe("explicit settings-file open transport", () => {
  it("posts only an empty object to the fixed endpoint after explicit invocation", async () => {
    const requests: { url: string; method?: string; body?: BodyInit | null }[] = [];
    const client = createHttpDashboardClient({
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), method: init?.method, body: init?.body });
        return Response.json({ opened: true });
      },
    });
    expect(requests).toEqual([]);
    await client.openSettingsFile?.();
    expect(requests).toEqual([{ url: "/api/v1/settings/open", method: "POST", body: "{}" }]);
  });

  it.each([
    { status: 409, code: "config-target-error", message: "The settings file does not exist." },
    {
      status: 500,
      code: "config-write-error",
      message: "The default application could not be started.",
    },
  ])("preserves the controlled $code failure without retry or success", async ({
    status,
    code,
    message,
  }) => {
    let requests = 0;
    const client = createHttpDashboardClient({
      fetchImpl: async () => {
        requests += 1;
        return Response.json({ error: { code, message } }, { status });
      },
    });
    await expect(client.openSettingsFile?.()).rejects.toMatchObject({ code, status, message });
    expect(requests).toBe(1);
  });

  it("rejects a response that does not acknowledge an open", async () => {
    const client = createHttpDashboardClient({
      fetchImpl: async () => Response.json({ opened: false }),
    });
    await expect(client.openSettingsFile?.()).rejects.toMatchObject({ code: "invalid-response" });
  });
});
