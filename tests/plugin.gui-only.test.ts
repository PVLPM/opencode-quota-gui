/**
 * The shipped server plugin exposes the dashboard runtime, its typed RPC
 * transport, and the credential/retry lifecycle: no commands, tool or
 * quota-report hooks are registered.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
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
  const registeredTools = new Map<string, unknown>();
  const toolRegistration = { dispose: vi.fn(async () => undefined) };
  const rpcRegistration = {
    events: { emit: vi.fn(async () => undefined) },
    dispose: vi.fn(async () => undefined),
  };
  const rpc = { register: vi.fn(async () => rpcRegistration) };
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
    tool: {
      transform: vi.fn(
        async (transform: (editor: { add: (tool: { name: string }) => void }) => void) => {
          transform({ add: (tool) => registeredTools.set(tool.name, tool) });
          return toolRegistration;
        },
      ),
    },
    command: { transform: vi.fn() },
    rpc,
    integration: createFakeIntegration([]),
    event: { subscribe: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })) },
  };
  return { ctx, hooks, rpc, rpcRegistration, registeredTools, toolRegistration };
}

async function freePort(): Promise<number> {
  const reservation = await reservePort();
  await reservation.release();
  return reservation.port;
}

function assertNoDashboardListener(port: number, timeoutMs = 1_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };

    timeout = setTimeout(
      () => finish(new Error(`Timed out checking for a dashboard listener on port ${port}`)),
      timeoutMs,
    );
    socket.once("connect", () =>
      finish(new Error(`Unexpected dashboard listener on port ${port}`)),
    );
    socket.once("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ECONNREFUSED") finish();
      else finish(error);
    });
  });
}

async function reservePort(): Promise<{ port: number; release: () => Promise<void> }> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  let releasePromise: Promise<void> | undefined;
  return {
    port: address.port,
    release: () => {
      releasePromise ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return releasePromise;
    },
  };
}

async function writeCanonicalConfig(port: number): Promise<void> {
  const dir = join(TEST_RUNTIME_ROOT, "config", "opencode-quota-gui");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.jsonc"),
    JSON.stringify({ dashboard: { enabled: true, port } }),
    "utf8",
  );
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
  it("rejects a silent listener in the bounded no-listener probe", async () => {
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");

    try {
      await expect(assertNoDashboardListener(address.port)).rejects.toThrow(
        /unexpected dashboard listener/i,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("registers only disabled-provider agent tools, attaches dashboard RPC and starts the dashboard", async () => {
    const port = await freePort();
    await writeCanonicalConfig(port);
    const { ctx, hooks, rpc, rpcRegistration, registeredTools, toolRegistration } = createContext();

    const cleanup = await plugin.setup(ctx as never);
    if (cleanup) cleanups.push(cleanup);

    expect(ctx.tool.transform).toHaveBeenCalledOnce();
    expect([...registeredTools.keys()].sort()).toEqual([
      "quota_custom_provider_add",
      "quota_custom_provider_list",
      "quota_custom_provider_read",
      "quota_custom_provider_remove",
      "quota_custom_provider_test",
    ]);
    expect(ctx.command.transform).not.toHaveBeenCalled();
    expect(rpc.register).toHaveBeenCalledOnce();
    expect(rpc.register.mock.calls[0]?.[0]).toMatchObject({
      id: "opencode-quota-gui.dashboard",
    });
    expect([...hooks.keys()]).toEqual(["retry"]);
    expect(ctx.session.get).not.toHaveBeenCalled();
    expect(ctx.session.wait).not.toHaveBeenCalled();
    expect(ctx.session.prompt).not.toHaveBeenCalled();

    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ app: "opencode-quota-gui" });

    await cleanup?.();
    expect(rpcRegistration.dispose).toHaveBeenCalledOnce();
    expect(toolRegistration.dispose).toHaveBeenCalledOnce();
  });

  it("attaches dashboard RPC with web disabled and binds no listener", async () => {
    const reservation = await reservePort();
    const { port } = reservation;
    try {
      const dir = join(TEST_RUNTIME_ROOT, "config", "opencode-quota-gui");
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "config.jsonc"),
        JSON.stringify({ dashboard: { enabled: false, port } }),
        "utf8",
      );
    } finally {
      await reservation.release();
    }
    const { ctx, rpc } = createContext();

    const cleanup = await plugin.setup(ctx as never);
    if (cleanup) cleanups.push(cleanup);

    expect(rpc.register).toHaveBeenCalledOnce();
    expect(rpc.register.mock.calls[0]?.[0]).toMatchObject({
      id: "opencode-quota-gui.dashboard",
    });
    await assertNoDashboardListener(port);
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
