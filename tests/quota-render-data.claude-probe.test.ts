import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearAnthropicDiagnosticsCacheForTests } from "../src/lib/anthropic.js";
import { collectQuotaDashboardProviderResults } from "../src/lib/quota-render-data.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";

const mocks = vi.hoisted(() => ({ calls: [] as string[][], signedIn: true, dir: "" }));
vi.mock("../src/lib/private-state-paths.js", () => ({
  getGuiPrivateCacheDir: () => mocks.dir,
}));
vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  deriveResolvedAuthIdentity: async (value: unknown) => JSON.stringify(value),
  composeResolvedAuthIdentities: async (value: unknown) => JSON.stringify(value),
}));
vi.mock("child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    mocks.calls.push(args);
    callback(
      null,
      args.join(" ").includes("--version")
        ? "2.1.0"
        : JSON.stringify(
            mocks.signedIn
              ? { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }
              : { loggedIn: false },
          ),
      "",
    );
  },
}));
vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    _url: string,
    options: { consume: (response: Response, signal: AbortSignal) => Promise<unknown> },
  ) =>
    options.consume(
      new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }),
      new AbortController().signal,
    ),
}));

const provider = { ...claudeAgentProvider, cachePolicy: PROVIDER_CACHE_POLICIES["claude-agent"] };
const client = {
  config: { providers: async () => ({ data: { providers: [{ id: "claude-agent" }] } }) },
};
const cycle = (forceProviderRefresh = false) =>
  collectQuotaDashboardProviderResults({
    client: client as never,
    config: { ...DEFAULT_CONFIG, enabledProviders: ["claude-agent"], minIntervalMs: 60_000 },
    workspaceRoot: mocks.dir,
    providers: [provider],
    forceProviderRefresh,
  });
let previousConfigDir: string | undefined;

beforeEach(async () => {
  mocks.dir = await mkdtemp(join(tmpdir(), "claude-cycle-"));
  previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = mocks.dir;
  await writeFile(
    join(mocks.dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }),
  );
  mocks.calls = [];
  mocks.signedIn = true;
});
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
  clearAnthropicDiagnosticsCacheForTests();
  __resetQuotaStateForTests();
  await rm(mocks.dir, { recursive: true, force: true });
});

it("runs one Claude probe per OAuth cycle, including a fresh cache hit and Retry", async () => {
  const first = await cycle();
  expect(first[0]?.result.entries).not.toHaveLength(0);
  expect(mocks.calls).toHaveLength(2);
  mocks.calls = [];
  const cached = await cycle();
  expect(cached[0]?.result.entries).not.toHaveLength(0);
  expect(mocks.calls).toHaveLength(2);
  mocks.calls = [];
  const refreshed = await cycle(true);
  expect(first[0]?.cacheScope).toBeDefined();
  expect(refreshed[0]?.cacheScope).toBe(first[0]?.cacheScope);
  expect(mocks.calls).toHaveLength(2);
});

it("runs one Claude probe in an unauthenticated cycle", async () => {
  mocks.signedIn = false;
  await cycle();
  expect(mocks.calls).toHaveLength(2);
});
