import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { alibabaCodingPlanProvider } from "../src/providers/alibaba-coding-plan.js";
import {
  expectAttemptedWithErrorLabel,
  expectAttemptedWithNoErrors,
} from "./helpers/provider-assertions.js";

const cliMocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../src/lib/alibaba-coding-plan-cli.js", () => ({
  queryAlibabaCodingPlanQuota: cliMocks.query,
}));

describe("Alibaba Coding Plan provider", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    cliMocks.query.mockReset();
    process.env = { ...originalEnv };
    delete process.env.ALIBABA_CODING_PLAN_API_KEY;
    delete process.env.ALIBABA_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("queries the CLI without requiring an unrelated OpenCode API key", async () => {
    cliMocks.query.mockResolvedValue({ state: "no-subscription" });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([]);
    expect(cliMocks.query).toHaveBeenCalledTimes(1);
  });

  it("is available from its configured runtime provider without API-key diagnostics", async () => {
    const context = {
      resolveRuntimeProviderIds: async () => new Set(["alibaba-coding-plan"]),
      config: {},
    };

    await expect(alibabaCodingPlanProvider.isAvailable(context as any)).resolves.toBe(true);
    expect(cliMocks.query).not.toHaveBeenCalled();
  });

  it("uses CLI-reported windows without attributing them to the OpenCode API-key tier", async () => {
    process.env.ALIBABA_API_KEY = "unrelated-model-api-key";
    cliMocks.query.mockResolvedValue({
      state: "success",
      usage: {
        instanceType: "lite",
        fiveHour: {
          used: 25,
          total: 200,
          percentage: 0.125,
          resetTimeIso: "2026-03-26T12:00:00.000Z",
        },
        weekly: { used: 40, total: 500, percentage: 0.08 },
        monthly: { used: 60, total: 900, percentage: 0.2 },
      },
    });

    const out = await alibabaCodingPlanProvider.fetch({
      workspaceRoot: "/workspace",
      config: {
        requestTimeoutMs: 7000,
        quotaProviders: [
          {
            id: "alibaba-coding-plan",
            mode: "local-estimate",
            windows: [{ id: "five-hour", type: "rolling", durationMinutes: 300, requestLimit: 1 }],
          },
        ],
      },
    } as any);

    expectAttemptedWithNoErrors(out);
    expect(cliMocks.query).toHaveBeenCalledWith({
      requestTimeoutMs: 7000,
      runtime: { cwd: "/workspace" },
    });
    expect(out.entries).toHaveLength(3);
    expect(out.entries[0]).toMatchObject({
      name: "Alibaba Coding Plan (lite) (CLI) 5h",
      group: "Alibaba Coding Plan (lite) (CLI)",
      label: "5h:",
      right: "25/200",
      percentRemaining: 87.5,
      resetTimeIso: "2026-03-26T12:00:00.000Z",
      accounting: {
        acquisitionMethod: "local_cli",
        authority: "provider_reported",
      },
    });
    expect(out.entries.map(({ group }) => group)).not.toContain("Alibaba Coding Plan (Pro)");
  });

  it("treats empty CLI output as no subscription rather than estimating usage", async () => {
    cliMocks.query.mockResolvedValue({ state: "no-subscription" });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithNoErrors(out);
    expect(out.entries).toEqual([]);
    expect(out.statusDetails).toContainEqual({
      key: "alibaba_coding_plan_cli_status",
      value: "no-subscription",
    });
  });

  it("reports missing Console authentication without invoking a login command", async () => {
    cliMocks.query.mockResolvedValue({
      state: "error",
      error: {
        kind: "not_authenticated",
        message:
          'Bailian CLI is not signed in to a Console account; run "bl auth login --console".',
      },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithErrorLabel(out, "Bailian CLI Coding Plan usage");
    expect(out.errors[0]?.failureCategory).toBe("credentials");
    expect(cliMocks.query).toHaveBeenCalledTimes(1);
  });

  it("reports successful CLI responses without usable windows instead of estimating", async () => {
    cliMocks.query.mockResolvedValue({
      state: "success",
      usage: { instanceType: "pro", fiveHour: {}, weekly: {}, monthly: {} },
    });

    const out = await alibabaCodingPlanProvider.fetch({ config: {} } as any);

    expectAttemptedWithErrorLabel(out, "Bailian CLI Coding Plan usage");
    expect(out.errors[0]?.message).toContain("no usable Coding Plan quota data");
  });
});
