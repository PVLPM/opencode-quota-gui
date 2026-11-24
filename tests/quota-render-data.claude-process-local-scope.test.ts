import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDashboardReadSource } from "../src/gui/sources.js";
import { clearAnthropicDiagnosticsCacheForTests } from "../src/lib/anthropic.js";
import { collectQuotaDashboardProviderResults } from "../src/lib/quota-render-data.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { claudeAgentProvider } from "../src/providers/claude-agent.js";

const mocks = vi.hoisted(() => ({
  calls: [] as string[][],
  dir: "",
  email: "first@example.com",
  orgId: "org-first",
  authMode: "success" as "success" | "timeout",
}));

vi.mock("../src/lib/private-state-paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/private-state-paths.js")>()),
  getGuiPrivateCacheDir: () => join(mocks.dir, "cache"),
  getGuiPrivateStateDir: () => join(mocks.dir, "state"),
  getGuiPrivateStatePath: (...segments: string[]) => join(mocks.dir, "state", ...segments),
}));
vi.mock("child_process", () => ({
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    mocks.calls.push(args);
    if (args.join(" ").includes("--version")) {
      callback(null, "2.1.0", "");
      return;
    }
    if (mocks.authMode === "timeout") {
      callback(
        Object.assign(new Error("Command failed: claude auth status --json (timed out)"), {
          code: "ETIMEDOUT",
          killed: true,
        }),
        "",
        "",
      );
      return;
    }
    callback(
      null,
      JSON.stringify({
        authenticated: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: mocks.email,
        orgId: mocks.orgId,
        configDirectory: mocks.dir,
        quota: {
          five_hour: { used_percentage: 20 },
          seven_day: { used_percentage: 30 },
        },
      }),
      "",
    );
  },
}));

const provider = { ...claudeAgentProvider, cachePolicy: PROVIDER_CACHE_POLICIES["claude-agent"] };
const client = {
  config: { providers: async () => ({ data: { providers: [{ id: "claude-agent" }] } }) },
};
const config = (): typeof DEFAULT_CONFIG => ({
  ...DEFAULT_CONFIG,
  enabledProviders: ["claude-agent"],
  // Every cycle must fetch: a timeout cycle proves retention, not the TTL cache.
  minIntervalMs: 0,
});
const cycle = () =>
  collectQuotaDashboardProviderResults({
    client: client as never,
    config: config(),
    workspaceRoot: mocks.dir,
    providers: [provider],
  });
const createSource = () => {
  const sourceConfig = config();
  return createDashboardReadSource({
    client: client as never,
    workspaceRoot: mocks.dir,
    configDir: join(mocks.dir, "config"),
    providers: [provider],
    loadConfig: async () => sourceConfig,
    collectProviderResults: async ({ config: cycleConfig, providers }) =>
      await collectQuotaDashboardProviderResults({
        client: client as never,
        config: cycleConfig,
        workspaceRoot: mocks.dir,
        providers,
      }),
  });
};

let previousConfigDir: string | undefined;

beforeEach(async () => {
  mocks.dir = await mkdtemp(join(tmpdir(), "claude-process-local-scope-"));
  previousConfigDir = process.env["CLAUDE_CONFIG_DIR"];
  process.env["CLAUDE_CONFIG_DIR"] = mocks.dir;
  mocks.calls = [];
  mocks.email = "first@example.com";
  mocks.orgId = "org-first";
  mocks.authMode = "success";
  await writeFile(
    join(mocks.dir, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "token-first-account" } }),
  );
});
afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = previousConfigDir;
  clearAnthropicDiagnosticsCacheForTests();
  __resetQuotaStateForTests();
  await rm(mocks.dir, { recursive: true, force: true });
});

describe.runIf(process.platform === "win32")("Claude Agent process-local scope", () => {
  it("scopes last-good per CLI account without persisting anything", async () => {
    const { resolveClaudeAgentAccountIdentity } = await import("../src/lib/anthropic.js");
    const identity = await resolveClaudeAgentAccountIdentity({
      onlyCurrentModel: false,
      runtimeDetected: false,
    });
    expect(identity).toMatch(/^rai1p_[A-Za-z0-9_-]{43}$/u);

    const first = await cycle();
    expect(first[0]?.result.entries).not.toHaveLength(0);
    expect(first[0]?.cacheScope).toMatch(/^[a-f0-9]{64}$/u);

    const second = await cycle();
    expect(second[0]?.cacheScope).toBe(first[0]?.cacheScope);

    mocks.email = "second@example.com";
    mocks.orgId = "org-second";
    const changed = await cycle();
    expect(changed[0]?.cacheScope).toBeDefined();
    expect(changed[0]?.cacheScope).not.toBe(first[0]?.cacheScope);

    const files = await readdir(join(mocks.dir, "cache", "quota-provider-state")).catch(() => []);
    expect(files.filter((name) => name.startsWith("claude-agent-"))).toEqual([]);
  });

  it("reuses the last scope through a timed-out probe only while the credential file is unchanged", async () => {
    const first = await cycle();
    expect(first[0]?.result.entries).not.toHaveLength(0);
    const firstScope = first[0]?.cacheScope;
    expect(firstScope).toMatch(/^[a-f0-9]{64}$/u);

    mocks.authMode = "timeout";
    const retained = await cycle();
    expect(retained[0]?.cacheScope).toBe(firstScope);
    expect(retained[0]?.result.entries).not.toHaveLength(0);
    expect(retained[0]?.result.errors.map((error) => error.failureCategory)).toContain(
      "provider_api",
    );

    // A changed credential source is no proof that the same login is still present.
    await writeFile(
      join(mocks.dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "token-second-account-longer" } }),
    );
    const dropped = await cycle();
    expect(dropped[0]?.cacheScope).toBeUndefined();
    expect(dropped[0]?.result.entries).toEqual([]);
    expect(dropped[0]?.result.errors).not.toHaveLength(0);
  });

  it("marks retained Claude rows stale after a timeout and drops them when the credential file changes", async () => {
    const source = createSource();

    const fresh = await source.quota();
    const freshCard = fresh.providers.cards.find((card) => card.providerId === "claude-agent");
    expect(freshCard?.rows.length).toBeGreaterThan(0);
    expect(freshCard?.stale).toBeUndefined();

    mocks.authMode = "timeout";
    const retained = await source.quota();
    const retainedCard = retained.providers.cards.find(
      (card) => card.providerId === "claude-agent",
    );
    expect(retained.stale).toBe(true);
    expect(retainedCard?.stale).toBe(true);
    expect(retainedCard?.rows.length).toBeGreaterThan(0);

    await writeFile(
      join(mocks.dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "token-second-account-longer" } }),
    );
    const dropped = await source.quota();
    const droppedCard = dropped.providers.cards.find((card) => card.providerId === "claude-agent");
    expect(droppedCard?.rows).toEqual([]);
  });
});
