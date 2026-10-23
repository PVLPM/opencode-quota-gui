import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Keep the plugin's runtime dirs synthetic: the dashboard setup reads the global
// config dir, and no test may touch the user's real config or state.
const TEST_RUNTIME_ROOT = vi.hoisted(() => "/tmp/opencode-quota-plugin-v2-tests");
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${TEST_RUNTIME_ROOT}/data`,
    configDir: `${TEST_RUNTIME_ROOT}/config`,
    cacheDir: `${TEST_RUNTIME_ROOT}/cache`,
    stateDir: `${TEST_RUNTIME_ROOT}/state`,
  }),
}));

// The credential lifecycle needs no real dashboard listener; gui-only tests cover startup.
vi.mock("../src/gui/lifecycle.js", () => ({
  startDashboard: vi.fn(async () => ({ dispose: async () => {} })),
}));

import {
  clearReadAuthFileCacheForTests,
  getCredentialSourceDiagnostics,
  readAuthFile,
  readAuthFileCached,
} from "../src/lib/opencode-auth.js";
import plugin from "../src/plugin.js";
import { createFakeIntegration } from "./helpers/fake-integration.js";

function createContext() {
  return {
    location: { directory: "/tmp/opencode/quota-plugin-v2" },
    provider: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai" }] }) },
    session: {
      hook: vi.fn(async () => ({ dispose: async () => {} })),
    },
    integration: createFakeIntegration([]),
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };
}

/**
 * Tracks every setup so a test that never disposes still releases the plugin's
 * dashboard lease (and its real listener) before the next test runs.
 */
const cleanups: Array<() => Promise<void> | void> = [];

async function setupPlugin(context: unknown): Promise<() => Promise<void> | void> {
  const cleanup = await plugin.setup(context as never);
  const tracked = async () => {
    await cleanup?.();
  };
  cleanups.push(tracked);
  return tracked;
}

beforeEach(() => {
  clearReadAuthFileCacheForTests();
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

describe("V2 server plugin credential lifecycle", () => {
  it("reads logins through ctx.integration from setup until cleanup", async () => {
    const ctx = createContext();
    const integration = createFakeIntegration([
      {
        integrationId: "deepseek",
        id: "cred_deepseek",
        label: "default",
        registered: true,
        method: "key",
        value: { type: "key", key: "deepseek-key" },
      },
    ]);
    const subscribe = vi.fn((_options: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {},
    }));

    const cleanup = await setupPlugin({ ...ctx, integration, event: { subscribe } });
    expect(getCredentialSourceDiagnostics()).toMatchObject({
      state: "bound",
      kind: "opencode-integration-api",
    });
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toEqual({
      deepseek: { type: "api", key: "deepseek-key" },
    });
    const signal = subscribe.mock.calls[0]?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await cleanup?.();
    expect(signal?.aborted).toBe(true);
    // Only this setup's binding is gone; earlier tests' empty fakes hold no deepseek login.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(readAuthFile({ integrationIds: ["deepseek"] })).resolves.toBeNull();
    warn.mockRestore();
    expect(integration.connection.active).toHaveBeenCalledOnce();
  });

  it.each([
    "credential.updated",
    "credential.switched",
  ])("drops cached logins when OpenCode reports %s", async (type) => {
    const ctx = createContext();
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
    const subscribe = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "session.idle", data: {} };
        yield await nextEvent;
      },
    }));
    const cleanup = await setupPlugin({ ...ctx, integration, event: { subscribe } });
    const read = () => readAuthFileCached({ maxAgeMs: 60_000, integrationIds: ["deepseek"] });

    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });
    deepseek.value = { type: "key", key: "new-key" };
    await expect(read()).resolves.toEqual({ deepseek: { type: "api", key: "old-key" } });

    emit({ type, data: { integrationID: "deepseek", credentialID: "cred_deepseek" } });
    await vi.waitFor(async () =>
      expect(await read()).toEqual({ deepseek: { type: "api", key: "new-key" } }),
    );
    await cleanup?.();
  });

  it("logs why the credential event subscription stopped, without tokens", async () => {
    const ctx = createContext();
    const token = `eyJ${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
    const subscribe = vi.fn(() => ({
      // biome-ignore lint/correctness/useYield: the stream fails before its first event
      async *[Symbol.asyncIterator]() {
        throw new Error(`event stream closed ${token}`);
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin({ ...ctx, event: { subscribe } });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        "[opencode-quota-gui] credential event subscription stopped: event stream closed [redacted]",
      ),
    );
    await cleanup?.();
    warn.mockRestore();
  });

  it("stops the credential event subscription silently on cleanup", async () => {
    const ctx = createContext();
    const subscribe = vi.fn(({ signal }: { signal: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        throw new DOMException("This operation was aborted", "AbortError");
      },
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin({ ...ctx, event: { subscribe } });
    await cleanup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn.mock.calls.flat().join("\n")).not.toContain("credential event subscription");
    warn.mockRestore();
  });
});
