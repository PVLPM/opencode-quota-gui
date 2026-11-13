import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearAnthropicDiagnosticsCacheForTests,
  queryAnthropicQuotaWithOAuth,
} from "../src/lib/anthropic.js";
import { bindCredentialSource, notifyCredentialsChanged } from "../src/lib/opencode-auth.js";
import { __resetQuotaStateForTests, fetchQuotaProviderResult } from "../src/lib/quota-state.js";
import { anthropicProvider } from "../src/providers/anthropic.js";
import { PROVIDER_CACHE_POLICIES } from "../src/providers/cache-policies.js";
import { createProviderAvailabilityContext } from "./helpers/provider-test-harness.js";

const mocks = vi.hoisted(() => ({ cacheDir: "", request: vi.fn() }));

vi.mock("../src/lib/private-state-paths.js", () => ({
  getGuiPrivateCacheDir: () => mocks.cacheDir,
}));
vi.mock("child_process", () => ({
  execFile: (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error, stdout: string, stderr: string) => void,
  ) => {
    callback(Object.assign(new Error("missing"), { code: "ENOENT" }), "", "");
  },
}));
vi.mock("../src/lib/http.js", () => ({
  fetchWithTimeout: async (
    _url: string,
    options: { consume: (response: Response, signal: AbortSignal) => Promise<unknown> },
  ) => options.consume(await mocks.request(), new AbortController().signal),
}));

afterEach(() => {
  vi.restoreAllMocks();
  clearAnthropicDiagnosticsCacheForTests();
  __resetQuotaStateForTests();
  notifyCredentialsChanged();
  mocks.request.mockReset();
});

it("waits for an older normal probe then coalesces forced probes and reuses the forced result in the cycle", async () => {
  let release!: (response: Response) => void;
  mocks.request
    .mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ five_hour: { utilization: 40 } }), { status: 200 }),
    );
  const normal = queryAnthropicQuotaWithOAuth("overlap-token");
  const cycle = new Map<symbol, unknown>();
  const forced = queryAnthropicQuotaWithOAuth("overlap-token", undefined, cycle);
  const otherCycle = queryAnthropicQuotaWithOAuth("overlap-token", undefined, new Map());
  expect(mocks.request).toHaveBeenCalledTimes(1);
  release(new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }));
  expect(await normal).toMatchObject({ five_hour: { percentRemaining: 80 } });
  expect(await forced).toMatchObject({ five_hour: { percentRemaining: 60 } });
  expect(await otherCycle).toMatchObject({ five_hour: { percentRemaining: 60 } });
  expect(await queryAnthropicQuotaWithOAuth("overlap-token", undefined, cycle)).toMatchObject({
    five_hour: { percentRemaining: 60 },
  });
  expect(mocks.request).toHaveBeenCalledTimes(2);
});

it("does not issue a forced request when the preceding normal probe establishes cooldown", async () => {
  let release!: (response: Response) => void;
  mocks.request.mockReturnValueOnce(
    new Promise<Response>((resolve) => {
      release = resolve;
    }),
  );
  const normal = queryAnthropicQuotaWithOAuth("cooldown-overlap-token");
  const forced = queryAnthropicQuotaWithOAuth("cooldown-overlap-token", undefined, new Map());
  release(new Response("limited", { status: 429, headers: { "Retry-After": "45" } }));
  expect(await normal).toMatchObject({ success: false });
  expect(await forced).toMatchObject({ success: false });
  expect(mocks.request).toHaveBeenCalledTimes(1);
});

it("forced refresh fetches a new Anthropic OAuth result instead of recent quota", async () => {
  mocks.cacheDir = await mkdtemp(join(tmpdir(), "anthropic-refresh-"));
  const unbind = bindCredentialSource({
    kind: "opencode-integration-api",
    readRows: async () => [
      {
        id: "force-account",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth", access: "force-account-token" },
      },
    ],
  });
  mocks.request
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ five_hour: { utilization: 40 } }), { status: 200 }),
    );
  const provider = { ...anthropicProvider, cachePolicy: PROVIDER_CACHE_POLICIES.anthropic };
  const ctx = createProviderAvailabilityContext({
    providerIds: ["anthropic"],
    configOverrides: { onlyCurrentModel: true, currentProviderID: "anthropic" },
  });
  try {
    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000 });
    expect(first.entries[0]?.percentRemaining).toBe(80);
    const refreshed = await fetchQuotaProviderResult({
      provider,
      ctx,
      ttlMs: 60_000,
      forceRefresh: true,
    });
    expect(refreshed.entries[0]?.percentRemaining).toBe(60);
    expect(mocks.request).toHaveBeenCalledTimes(2);
  } finally {
    unbind();
    await rm(mocks.cacheDir, { recursive: true, force: true });
  }
});

it("invalidates only the rate-limited token's earlier quota after its cooldown", async () => {
  const start = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  const quota = (used: number) =>
    new Response(JSON.stringify({ five_hour: { utilization: used } }), { status: 200 });
  mocks.request
    .mockResolvedValueOnce(quota(10))
    .mockResolvedValueOnce(quota(20))
    .mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "45" } }),
    )
    .mockResolvedValueOnce(quota(30));
  expect(await queryAnthropicQuotaWithOAuth("account-a")).toMatchObject({
    five_hour: { percentRemaining: 90 },
  });
  expect(await queryAnthropicQuotaWithOAuth("account-b")).toMatchObject({
    five_hour: { percentRemaining: 80 },
  });
  // A backwards clock step bypasses the recent entry while leaving it within its later reuse window.
  now.mockReturnValue(start - 1);
  expect(await queryAnthropicQuotaWithOAuth("account-a")).toMatchObject({ success: false });
  now.mockReturnValue(start + 45_000);
  expect(await queryAnthropicQuotaWithOAuth("account-b")).toMatchObject({
    five_hour: { percentRemaining: 80 },
  });
  expect(await queryAnthropicQuotaWithOAuth("account-a")).toMatchObject({
    five_hour: { percentRemaining: 70 },
  });
  expect(mocks.request).toHaveBeenCalledTimes(4);
});

it("manual refresh respects Anthropic OAuth Retry-After until the cooldown expires", async () => {
  mocks.cacheDir = await mkdtemp(join(tmpdir(), "anthropic-refresh-"));
  const unbind = bindCredentialSource({
    kind: "opencode-integration-api",
    readRows: async () => [
      {
        id: "test-account",
        integrationId: "anthropic",
        label: "default",
        active: true,
        value: { type: "oauth", access: "test-refresh-token" },
      },
    ],
  });
  const start = Date.now();
  const now = vi.spyOn(Date, "now").mockReturnValue(start);
  mocks.request
    .mockResolvedValueOnce(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ five_hour: { utilization: 20 } }), { status: 200 }),
    );
  const provider = { ...anthropicProvider, cachePolicy: PROVIDER_CACHE_POLICIES.anthropic };
  const ctx = createProviderAvailabilityContext({
    providerIds: ["anthropic"],
    configOverrides: { onlyCurrentModel: true, currentProviderID: "anthropic" },
  });
  const read = (forceRefresh = false) =>
    fetchQuotaProviderResult({ provider, ctx, ttlMs: 60_000, forceRefresh });
  try {
    const initial = await read();
    expect(initial.errors).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 59_000);
    const forced = await read(true);
    expect(forced.errors).toHaveLength(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + 60_000);
    const recovered = await read(true);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(recovered.errors).toHaveLength(0);
    expect(recovered.entries).toHaveLength(1);
  } finally {
    unbind();
    await rm(mocks.cacheDir, { recursive: true, force: true });
  }
});
