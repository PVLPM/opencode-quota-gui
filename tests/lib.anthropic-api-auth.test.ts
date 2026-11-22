import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readAuthFile = vi.hoisted(() => vi.fn());

vi.mock("../src/lib/opencode-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/opencode-auth.js")>()),
  readAuthFile,
}));
// Never read the developer's real OpenCode config.
vi.mock("../src/lib/api-key-resolver.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api-key-resolver.js")>()),
  getGlobalOpencodeConfigCandidatePaths: () => [],
}));

import { resolveAnthropicApiKey } from "../src/lib/anthropic-api-auth.js";

describe("resolveAnthropicApiKey", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    readAuthFile.mockReset().mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("finds an OpenCode API-key login", async () => {
    readAuthFile.mockResolvedValue({ anthropic: { type: "api", key: " sk-stored " } });
    await expect(resolveAnthropicApiKey()).resolves.toBe("sk-stored");
  });

  it("finds ANTHROPIC_API_KEY", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-env");
    await expect(resolveAnthropicApiKey()).resolves.toBe("sk-env");
  });

  it("never counts an OAuth login or nothing at all as an API key", async () => {
    readAuthFile.mockResolvedValue({ anthropic: { type: "oauth", access: "subscription-token" } });
    await expect(resolveAnthropicApiKey()).resolves.toBeNull();
    readAuthFile.mockResolvedValue(null);
    await expect(resolveAnthropicApiKey()).resolves.toBeNull();
  });
});
