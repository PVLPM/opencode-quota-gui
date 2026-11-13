import { describe, expect, it, vi } from "vitest";

import { copilotProvider } from "../src/providers/copilot.js";
import { googleAgyProvider } from "../src/providers/google-agy.js";
import { googleGeminiCliProvider } from "../src/providers/google-gemini-cli.js";

const retryAtMs = 1_800_000_000_000;

vi.mock("../src/lib/google-agy.js", () => ({
  AGY_AUTH_KEYS: ["google-agy", "opencode-agy-auth", "google-agy-auth"],
  hasAgyQuotaRuntimeAvailable: vi.fn(),
  inspectAgyAuthPresence: vi.fn(async () => ({ state: "missing", accountCount: 0 })),
  queryGoogleAgyQuota: vi.fn(async () => ({
    success: true,
    buckets: [],
    errors: [{ email: "a@example.com", error: "limited", retryAtMs }],
  })),
}));
vi.mock("../src/lib/google-agy-companion.js", () => ({
  inspectAgyCompanionPresence: vi.fn(async () => ({ state: "missing", error: "x" })),
}));
vi.mock("../src/lib/google-gemini-cli.js", () => ({
  GEMINI_CLI_AUTH_KEYS: ["google-gemini-cli"],
  hasGeminiCliQuotaRuntimeAvailable: vi.fn(),
  inspectGeminiCliAuthPresence: vi.fn(async () => ({ state: "missing", accountCount: 0 })),
  queryGeminiCliQuota: vi.fn(async () => ({
    success: true,
    buckets: [],
    errors: [{ email: "a@example.com", error: "limited", retryAtMs }],
  })),
}));
vi.mock("../src/lib/google-gemini-cli-companion.js", () => ({
  inspectGeminiCliCompanionPresence: vi.fn(async () => ({ state: "missing", error: "x" })),
}));
vi.mock("../src/lib/copilot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/copilot.js")>()),
  queryCopilotQuota: vi.fn(async () => ({ success: false, error: "limited", retryAtMs })),
}));

describe("direct adapter Retry-After provider forwarding", () => {
  it.each([
    ["Google AGY", googleAgyProvider],
    ["Gemini CLI", googleGeminiCliProvider],
  ])("%s keeps the per-account deadline on provider errors", async (_name, provider) => {
    const out = await provider.fetch({ client: {} } as never);
    expect(out.errors).toMatchObject([{ retryAtMs }]);
  });

  it("Copilot keeps the whole-result deadline on provider errors", async () => {
    const out = await copilotProvider.fetch({ client: {} } as never);
    expect(out.errors).toMatchObject([{ retryAtMs }]);
  });
});
