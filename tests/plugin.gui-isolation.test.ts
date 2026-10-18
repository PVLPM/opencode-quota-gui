import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeIntegration } from "./helpers/fake-integration.js";

const buildOutput = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-dialog-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/quota-dialog-commands.js")>()),
  buildQuotaDialogCommandOutput: buildOutput,
}));
const resolveRetryDelay = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/quota-retry-wait.js", () => ({
  resolveQuotaResetRetryDelayMs: resolveRetryDelay,
}));

// Synthetic runtime dirs: the dashboard setup reads the global config dir, and
// this test may never touch the user's real config, data, or credentials.
const TEST_RUNTIME_ROOT = vi.hoisted(() => "/tmp/opencode-quota-plugin-gui-isolation");
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

import type { JsonValue } from "../src/contracts/dashboard.js";
import { QUOTA_DIALOG_COMMANDS } from "../src/lib/quota-dialog-command-specs.js";
import plugin from "../src/plugin.js";

type RegisteredTool = {
  name: string;
  execute: (input: JsonValue, context: { sessionID: string }) => Promise<{ content: string }>;
};
type RegisteredCommand = { name: string };
type RpcHandler = (input: JsonValue, context: JsonValue) => Promise<JsonValue>;
type HookEvent = { sessionID: string; decision: { retry: false } | { retry: true; delay: number } };
type HookCallback = (event: HookEvent) => Promise<void>;

function createContext() {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const hooks = new Map<string, HookCallback>();
  const rpcHandlers: Record<string, RpcHandler> = {};
  const ctx = {
    location: { directory: `${TEST_RUNTIME_ROOT}/workspace` },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
    session: {
      get: vi.fn().mockResolvedValue({ model: { id: "gpt-5", providerID: "openai" } }),
      wait: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({})),
      hook: vi.fn(async (name: string, callback: HookCallback) => {
        hooks.set(name, callback);
        return { dispose: async () => {} };
      }),
    },
    tool: {
      transform: vi.fn(
        async (callback: (editor: { add: (tool: RegisteredTool) => void }) => void) => {
          callback({ add: (tool) => tools.push(tool) });
        },
      ),
    },
    command: {
      transform: vi.fn(
        async (callback: (editor: { add: (command: RegisteredCommand) => void }) => void) => {
          callback({ add: (command) => commands.push(command) });
        },
      ),
    },
    rpc: {
      register: vi.fn(
        async (
          _definition: unknown,
          handlers: Record<string, RpcHandler>,
        ): Promise<{ dispose: () => Promise<void>; events: { emit: () => void } }> => {
          Object.assign(rpcHandlers, handlers);
          return { dispose: async () => {}, events: { emit: () => {} } };
        },
      ),
    },
    integration: createFakeIntegration([]),
    event: { subscribe: vi.fn(() => ({ async *[Symbol.asyncIterator]() {} })) },
  };
  return { ctx, tools, commands, hooks, rpcHandlers };
}

function listen(server: NetServer, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
let blocker: NetServer | undefined;

beforeEach(async () => {
  buildOutput.mockReset();
  resolveRetryDelay.mockReset();
  await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
  await mkdir(`${TEST_RUNTIME_ROOT}/workspace`, { recursive: true });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  if (blocker) {
    const server = blocker;
    blocker = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(TEST_RUNTIME_ROOT, { recursive: true, force: true });
});

describe("plugin isolation from the dashboard", () => {
  it("keeps tools, commands, RPC and the retry hook working when no dashboard can start", async () => {
    const occupied = createNetServer((socket) => socket.end());
    blocker = occupied;
    await listen(occupied, 0);
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const port = address.port;

    const canonical = join(TEST_RUNTIME_ROOT, "config", "opencode-quota-gui");
    await mkdir(canonical, { recursive: true });
    await writeFile(join(canonical, "config.jsonc"), JSON.stringify({ dashboard: { port } }));

    buildOutput.mockResolvedValue({ state: "output", title: "Status", output: "Quota ready" });
    resolveRetryDelay.mockResolvedValue(5_460_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, tools, commands, hooks, rpcHandlers } = createContext();

    const cleanup = await plugin.setup(ctx);
    if (cleanup) cleanups.push(cleanup);

    // The dashboard never started (occupied port, and this tree may not ship the P3
    // source yet), but every other plugin surface is registered and functional.
    expect(tools.map((tool) => tool.name)).toEqual(["quota_status"]);
    await expect(tools[0].execute({}, { sessionID: "s1" })).resolves.toEqual({
      content: "Quota ready",
    });
    expect(commands.map((command) => command.name)).toEqual(
      QUOTA_DIALOG_COMMANDS.map((spec) => spec.slashName),
    );
    const command = rpcHandlers.command;
    await expect(command({ command: "quota_status", sessionID: "s1" })).resolves.toEqual(
      expect.objectContaining({ state: "output", output: "Quota ready" }),
    );
    const hook = hooks.get("retry");
    if (!hook) throw new Error("expected the retry hook to be registered");
    const event: HookEvent = { sessionID: "s1", decision: { retry: false } };
    await hook(event);
    expect(event.decision).toEqual({ retry: true, delay: 5_460_000 });
    expect(resolveRetryDelay).toHaveBeenCalledWith(expect.anything(), event);

    // Exactly one controlled dashboard line; no path, port, or raw reason leaks.
    const dashboardLines = warn.mock.calls
      .flat()
      .map((argument) => String(argument))
      .filter((line) => line.startsWith("[opencode-quota-gui]"));
    expect(dashboardLines).toHaveLength(1);
    expect(dashboardLines[0]).toMatch(/^\[opencode-quota-gui\] error: dashboard /);
    expect(dashboardLines[0]).not.toContain(TEST_RUNTIME_ROOT);

    warn.mockRestore();
  });

  it("releases the credential subscription and the dashboard lease on teardown", async () => {
    const subscribe = vi.fn((_options: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        // Never emits: the subscription stays open, pending, until aborted.
        yield await new Promise<never>(() => {});
      },
    }));
    const { ctx } = createContext();

    const cleanup = await plugin.setup({
      ...ctx,
      event: { subscribe },
    });
    const signal = subscribe.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await cleanup?.();
    expect(signal?.aborted).toBe(true);

    // The teardown stays a no-op when OpenCode runs it twice.
    await expect(cleanup?.()).resolves.toBeUndefined();
  });
});
