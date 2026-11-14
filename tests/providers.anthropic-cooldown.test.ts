import { execFile } from "child_process";
import { afterEach, expect, it, vi } from "vitest";
import { clearAnthropicDiagnosticsCacheForTests } from "../src/lib/anthropic.js";
import { readCredentialRows } from "../src/lib/opencode-auth.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: vi.fn(),
}));
vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readCredentialRows: vi.fn(),
}));

afterEach(() => {
  clearAnthropicDiagnosticsCacheForTests();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("cools down a rate-limited OpenCode login without spawning Claude CLI", async () => {
  vi.mocked(readCredentialRows).mockResolvedValue([
    {
      id: "personal",
      integrationId: "anthropic",
      label: "Personal",
      active: true,
      value: { type: "oauth", access: "cooldown-token" },
    },
  ] as never);
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } }),
    );
  vi.stubGlobal("fetch", fetch);
  const ctx = createProviderAvailabilityContext({ providerIds: ["anthropic"] });

  const first = await anthropicProvider.fetch(ctx);
  const second = await anthropicProvider.fetch(ctx);

  expect(first.errors[0]?.failureCategory).toBe("provider_api");
  expect(second.errors[0]?.failureCategory).toBe("provider_api");
  expect(fetch).toHaveBeenCalledOnce();
  expect(execFile).not.toHaveBeenCalled();
});
