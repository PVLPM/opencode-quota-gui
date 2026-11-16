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

it("does not query OpenCode OAuth quota or spawn Claude CLI on repeated refresh", async () => {
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

  expect(first.entries).toEqual([]);
  expect(second.entries).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();
  expect(execFile).not.toHaveBeenCalled();
});
