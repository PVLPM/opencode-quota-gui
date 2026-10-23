/**
 * The shipped server plugin exposes only the dashboard, credential and retry
 * lifecycle: no commands, tool, RPC or quota-report hooks are registered.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIntegration } from "./helpers/fake-integration.js";

const resolveRetryDelay = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-retry-wait.js", () => ({
  resolveQuotaResetRetryDelayMs: resolveRetryDelay,
}));

// Synthetic runtime dirs: no test may read or write the user's real config/state.
const TEST_RUNTIME_ROOT = vi.hoisted(() => "/tmp/opencode-quota-gui-only-plugin-tests");
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

import {
  clearReadAuthFileCacheForTests,
  getCredentialSourceDiagnostics,
  readAuthFile,
  readAuthFileCached,
} from "../src/lib/opencode-auth.js";
import plugin from "../src/plugin.js";

type RetryEvent = {
  sessionID: string;
  decision: { retry: false } | { retry: true; delay: number };
};

function createContext() {
  const hooks = new Map<string, (event: RetryEvent) => Promise<void>>();
  const ctx = {
    location: { directory: `${TEST_RUNTIME_ROOT}/workspace` },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
    session: {
      get: vi.fn(),
      wait: vi.fn(),
      prompt: vi.fn(),
      hook: vi.fn(async (name: string, callback: (event: RetryEvent) => Promise<void>) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: { transform: vi.fn() },
    command: { transform: vi.fn() },
    rpc: { register: vi.fn() },
    integration: createFakeIntegration([]),
    event: { subscribe: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })) },
  };
  return { ctx, hooks };
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function writeCanonicalConfig(port: number): Promise<void> {
  const dir = join(TEST_RUNTIME_ROOT, "config", "opencode-quota-gui");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.jsonc"), JSON.stringify({ dashboard: { port } }), "utf8");
}

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(async () => {
  resolveRetryDelay.mockReset();
  clearReadAuthFileCacheForTests();
  await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(`${TEST_RUNTIME_ROOT}/workspace`, { recursive: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
});

describe("GUI-only server plugin", () => {
  it("registers no commands, tool, RPC or report hooks and starts the dashboard", async () => {
    const port = await freePort();
    await writeCanonicalConfig(port);
    const { ctx, hooks } = createContext();

    const cleanup = await plugin.setup(ctx as never);
    if (cleanup) cleanups.push(cleanup);

    expect(ctx.tool.transform).not.toHaveBeenCalled();
    expect(ctx.command.transform).not.toHaveBeenCalled();
    expect(ctx.rpc.register).not.toHaveBeenCalled();
    expect([...hooks.keys()]).toEqual(["retry"]);
    expect(ctx.session.get).not.toHaveBeenCalled();
    expect(ctx.session.wait).not.toHaveBeenCalled();
    expect(ctx.session.prompt).not.toHaveBeenCalled();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ app: "opencode-quota-gui" });
  });

  it("retries at the quota reset through the retained retry hook", async () => {
    const port = await freePort();
    await writeCanonicalConfig(port);
    const { ctx, hooks } = createContext();
    const cleanup = await plugin.setup(ctx as never);
    if (cleanup) cleanups.push(cleanup);
    const retry = hooks.get("retry");
    if (!retry) throw new Error("expected the retry hook");

    resolveRetryDelay.mockResolvedValueOnce(5_460_000);
    const waiting: RetryEvent = { sessionID: "s1", decision: { retry: false } };
    await retry(waiting);
    expect(waiting.decision).toEqual({ retry: true, delay: 5_460_000 });
    expect(resolveRetryDelay).toHaveBeenCalledWith(expect.anything(), waiting);

    resolveRetryDelay.mockResolvedValueOnce(undefined);
    const unchanged: RetryEvent = { sessionID: "s1", decision: { retry: true, delay: 2_000 } };
    await retry(unchanged);
    expect(unchanged.decision).toEqual({ retry: true, delay: 2_000 });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveRetryDelay.mockRejectedValueOnce(new Error("quota read failed"));
    const failed: RetryEvent = { sessionID: "s1", decision: { retry: false } };
    await expect(retry(failed)).resolves.toBeUndefined();
    expect(failed.decision).toEqual({ retry: false });
    expect(warn).toHaveBeenCalledWith("[opencode-quota-gui] retry hook failed: quota read failed");
    warn.mockRestore();
  });

  it("binds credentials, drops cached logins on credential events, and cleans up", async () => {
    const port = await freePort();
    await writeCanonicalConfig(port);
    const deepseek = {
      integrationId: "deepseek",
      id: "cred_deepseek",
      label: "default",
      registered: true,
      method: "key" as const,
      value: { type: "key", key: "old-key" } as Record<string, unknown>,
    };
    const integration = createFakeIntegration([deepseek]);
    let emit!: (event: { type: string; data: Record<string, unknown> }) => void;
    const nextEvent = new Promise<{ type: string; data: Record<string, unknown> }>((resolve) => {
      emit = resolve;
    });
    const subscribe = vi.fn((_options: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        yield await nextEvent;
      },
    }));
    const { ctx } = createContext();

    const cleanup = await plugin.setup({ ...ctx, integration, event: { subscribe } } as never);
    if (cleanup) cleanups.push(cleanup);

    expect(getCredentialSourceDiagnostics()).toMatchObject({
      state: "bound",
      kind: "opencode-integration-api",
    });
    const read = () => readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek"] });
    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });

    deepseek.value = { type: "key", key: "new-key" };
    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });
    emit({ type: "credential.switched", data: { integrationID: "deepseek" } });
    await vi.waitFor(async () =>
      expect(await read()).toEqual({ deepseek: { type: "api", key: "new-key" } }),
    );

    const signal = subscribe.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);
    await cleanup?.();
    expect(signal?.aborted).toBe(true);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toBeNull();
    warn.mockRestore();
  });
});
