import { afterEach, describe, expect, it, vi } from "vitest";
import { createSnapshotService } from "../src/gui/snapshot-service.js";
import { fetchQuotaProviderResult } from "../src/lib/quota-state.js";
import { openRouterProvider } from "../src/providers/openrouter.js";

const auth = vi.hoisted(() => ({ keys: ["private-key-one", "private-key-two"] }));
vi.mock("../src/lib/openrouter.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/openrouter.js")>();
  return {
    ...original,
    resolveOpenRouterAuth: async () => ({
      accounts: auth.keys.map((key, index) => ({
        sourceId: `account-${index}`,
        label: `Account ${index}`,
        resolved: { key, source: "opencode.db", checkedPaths: [], credentialDatabasePaths: [] },
      })),
      checkedPaths: [],
      credentialDatabasePaths: [],
      source: "opencode.db",
    }),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("real remote 429 through OpenRouter provider state", () => {
  it("does not issue a duplicate request when a forced refresh overlaps a scheduled quota poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00Z"));
    auth.keys = ["scheduler-private-key"];
    let release!: (value: Response) => void;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(async () => Response.json({ data: { usage: 1, limit: null } }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetcher);
    const provider = {
      ...openRouterProvider,
      cachePolicy: { kind: "resolved-auth" as const, resolveIdentity: async () => null },
    };
    const ctx = { config: {}, client: {} } as never;
    const source = {
      quota: async (input?: { refresh?: boolean }) => {
        const result = await fetchQuotaProviderResult({
          provider,
          ctx,
          ttlMs: 0,
          forceRefresh: input?.refresh,
        });
        return {
          generatedAtMs: Date.now(),
          stale: result.errors.length > 0,
          timeZone: "UTC",
          providers: { cards: [], enabledProviders: "auto", polledAtMs: Date.now() },
        };
      },
    } as never;
    const service = createSnapshotService({ source, quotaIntervalMs: 1000 });
    const dispose = service.addViewer();
    await service.quota();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const forced = service.quota({ refresh: true });
    release(new Response(null, { status: 429, headers: { "Retry-After": "10" } }));
    expect((await forced).stale).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    dispose();
    service.close();
    auth.keys = ["private-key-one", "private-key-two"];
  });
  it("never reuses a previous credential's rows when identity is unknown", async () => {
    auth.keys = ["prior-private-key"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const header = (init?.headers as Record<string, string>).Authorization;
        return header.endsWith("prior-private-key")
          ? Response.json({ data: { usage: 3, limit: null } })
          : new Response(null, { status: 429, headers: { "Retry-After": "30" } });
      }),
    );
    const provider = {
      ...openRouterProvider,
      cachePolicy: { kind: "resolved-auth" as const, resolveIdentity: async () => null },
    };
    const ctx = { config: {}, client: {} } as never;
    const first = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
    expect(first.entries).toHaveLength(1);
    auth.keys = ["replacement-private-key"];
    const failed = await fetchQuotaProviderResult({ provider, ctx, ttlMs: 0, forceRefresh: true });
    expect(failed.entries).toEqual([]);
    expect(failed.errors[0]).toMatchObject({ message: "HTTP 429" });
    expect(JSON.stringify(failed)).not.toContain("private-key");
    auth.keys = ["private-key-one", "private-key-two"];
  });
  it("fails closed without an auth scope while retry and polling honor each actual key", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    const calls: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const key = (init?.headers as Record<string, string>).Authorization;
      calls.push(key);
      if (key === "Bearer private-key-one")
        return new Response(null, { status: 429, headers: { "Retry-After": "20" } });
      return Response.json({ data: { usage: 1, limit: null } });
    });
    vi.stubGlobal("fetch", fetcher);
    const provider = {
      ...openRouterProvider,
      cachePolicy: { kind: "resolved-auth" as const, resolveIdentity: async () => null },
    };
    const ctx = { config: {}, client: {} } as never;
    const poll = () => fetchQuotaProviderResult({ provider, ctx, ttlMs: 0 });
    const retry = () => fetchQuotaProviderResult({ provider, ctx, ttlMs: 0, forceRefresh: true });
    const first = await poll();
    expect(first.errors).toEqual([
      expect.objectContaining({
        sourceId: "account-0",
        message: "HTTP 429",
        retryAtMs: Date.now() + 20_000,
      }),
    ]);
    expect(first.entries).toHaveLength(1);
    const forced = await retry();
    const next = await poll();
    expect(calls.filter((value) => value.endsWith("private-key-one"))).toHaveLength(1);
    expect(calls.filter((value) => value.endsWith("private-key-two"))).toHaveLength(3);
    expect(forced.errors).toHaveLength(1);
    expect(next.entries).toHaveLength(1);
    expect(JSON.stringify([first, forced, next])).not.toContain("private-key");
    vi.advanceTimersByTime(20_000);
    await retry();
    expect(calls.filter((value) => value.endsWith("private-key-one"))).toHaveLength(2);
  });
});
