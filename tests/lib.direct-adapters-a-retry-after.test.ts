import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaProviderContext } from "../src/lib/entries.js";
import { queryKiloQuota } from "../src/lib/kilo.js";
import { resolveKiloApiKey } from "../src/lib/kilo-config.js";
import { queryKimiQuota } from "../src/lib/kimi.js";
import { queryNanoGptQuota } from "../src/lib/nanogpt.js";
import { resolveNanoGptApiKey } from "../src/lib/nanogpt-config.js";
import { queryOllamaCloudQuota } from "../src/lib/ollama-cloud.js";
import { resolveOllamaCloudApiKey } from "../src/lib/ollama-cloud-config.js";
import { kiloProvider } from "../src/providers/kilo.js";
import { nanoGptProvider } from "../src/providers/nanogpt.js";

vi.mock("../src/lib/kilo-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/kilo-config.js")>()),
  resolveKiloApiKey: vi.fn(),
}));
vi.mock("../src/lib/nanogpt-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/nanogpt-config.js")>()),
  resolveNanoGptApiKey: vi.fn(),
}));
vi.mock("../src/lib/ollama-cloud-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ollama-cloud-config.js")>()),
  resolveOllamaCloudApiKey: vi.fn(),
}));

const limited = (retryAfter?: string, status = 429) =>
  new Response("slow down", {
    status,
    ...(retryAfter !== undefined ? { headers: { "Retry-After": retryAfter } } : {}),
  });

const stalledLimited = (retryAfter: string, signal?: AbortSignal) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
          once: true,
        });
      },
    }),
    { status: 429, headers: { "Retry-After": retryAfter } },
  );

let currentKey = "";
const setKey = (key: string) => {
  currentKey = key;
};

type Adapter = {
  name: string;
  query: () => Promise<{ success: boolean; retryAtMs?: number } | null>;
};

const adapters: Adapter[] = [
  { name: "Kimi", query: () => queryKimiQuota({ apiKey: currentKey, endpoint: "global" }) },
  { name: "NanoGPT", query: () => queryNanoGptQuota() },
  { name: "Ollama Cloud", query: () => queryOllamaCloudQuota() },
  { name: "Kilo", query: () => queryKiloQuota() },
];

const usagePayload = {
  active: true,
  state: "active",
  limits: { daily: 100 },
  daily: { used: 10, remaining: 90 },
};
const balancePayload = { usd_balance: "1.50" };
const isBalance = (url: string | URL | Request) => String(url).includes("check-balance");

describe("direct adapter Retry-After cooldowns (lane a)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const resolved = async () => ({ key: currentKey, source: "env:TEST" }) as never;
    vi.mocked(resolveKiloApiKey).mockImplementation(resolved);
    vi.mocked(resolveNanoGptApiKey).mockImplementation(resolved);
    vi.mocked(resolveOllamaCloudApiKey).mockImplementation(resolved);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each(adapters)("$name blocks only the limited credential until the deadline", async ({
    name,
    query,
  }) => {
    const requestsPerCall = name === "NanoGPT" ? 2 : 1;
    setKey(`retry-${name}-a`);
    const fetcher = vi.fn(async () => limited("60"));
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;

    expect(await Promise.all([query(), query()])).toMatchObject([
      { success: false, retryAtMs },
      { success: false, retryAtMs },
    ]);
    expect(await query()).toMatchObject({ success: false, retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(requestsPerCall);

    setKey(`retry-${name}-b`);
    await query();
    expect(fetcher).toHaveBeenCalledTimes(requestsPerCall * 2);

    vi.setSystemTime(retryAtMs);
    setKey(`retry-${name}-a`);
    await query();
    expect(fetcher).toHaveBeenCalledTimes(requestsPerCall * 3);
  });

  it.each(adapters)("$name ignores invalid or non-429 Retry-After", async ({ name, query }) => {
    setKey(`invalid-${name}`);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const [header, status] of [
      ["-5", 429],
      ["soon", 429],
      ["0", 429],
      ["60", 503],
    ] as const) {
      fetcher.mockImplementation(async () => limited(header, status));
      const before = fetcher.mock.calls.length;
      const result = await query();
      expect(result).toMatchObject({ success: false });
      expect(result?.retryAtMs).toBeUndefined();
      await query();
      expect(fetcher.mock.calls.length - before).toBeGreaterThanOrEqual(2);
    }
  });

  it.each([
    {
      name: "Kimi",
      query: () =>
        queryKimiQuota({
          apiKey: "body-stall-kimi",
          endpoint: "global",
          requestTimeoutMs: 10,
        }),
    },
    {
      name: "Kilo",
      query: () => {
        setKey("body-stall-kilo");
        return queryKiloQuota({ requestTimeoutMs: 10 });
      },
    },
    {
      name: "Ollama Cloud",
      query: () => {
        setKey("body-stall-ollama");
        return queryOllamaCloudQuota({ requestTimeoutMs: 10 });
      },
    },
  ])("%s preserves Retry-After when the 429 body stalls", async ({ query }) => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      stalledLimited("60", init?.signal ?? undefined),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;

    const firstRequest = query();
    await vi.advanceTimersByTimeAsync(10);
    await expect(firstRequest).resolves.toMatchObject({ success: false, retryAtMs });

    await expect(query()).resolves.toMatchObject({ success: false, retryAtMs });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Kimi isolates the same key across endpoints", async () => {
    const fetcher = vi.fn(async () => limited("60"));
    vi.stubGlobal("fetch", fetcher);
    await queryKimiQuota({ apiKey: "same", endpoint: "global" });
    await queryKimiQuota({ apiKey: "same", endpoint: "cn" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("NanoGPT keeps the healthy endpoint live while the limited one is cooled down", async () => {
    setKey("nano-partial");
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      isBalance(url) ? new Response(JSON.stringify(balancePayload)) : limited("60"),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;

    const first = await queryNanoGptQuota();
    expect(first).toMatchObject({
      success: true,
      balance: { usdBalanceRaw: "1.50" },
      endpointErrors: [{ endpoint: "usage", retryAtMs }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // Usage is cooled down (no request); balance stays live.
    const second = await queryNanoGptQuota();
    expect(second).toMatchObject({
      success: true,
      balance: { usdBalanceRaw: "1.50" },
      endpointErrors: [{ endpoint: "usage", retryAtMs }],
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([url]) => !isBalance(url))).toHaveLength(1);

    // Another credential is unaffected.
    setKey("nano-other");
    await queryNanoGptQuota();
    expect(fetcher.mock.calls.filter(([url]) => !isBalance(url))).toHaveLength(2);

    // Deadline expiry re-enables usage for the limited credential.
    vi.setSystemTime(retryAtMs);
    setKey("nano-partial");
    await queryNanoGptQuota();
    expect(fetcher.mock.calls.filter(([url]) => !isBalance(url))).toHaveLength(3);
  });

  it("NanoGPT cools down the balance endpoint independently of usage", async () => {
    setKey("nano-balance-limited");
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      isBalance(url) ? limited("60") : new Response(JSON.stringify(usagePayload)),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    await queryNanoGptQuota();
    const second = await queryNanoGptQuota();
    expect(second).toMatchObject({
      success: true,
      subscription: { active: true },
      endpointErrors: [{ endpoint: "balance", retryAtMs }],
    });
    expect(fetcher.mock.calls.filter(([url]) => isBalance(url))).toHaveLength(1);
  });

  it("NanoGPT provider surfaces the endpoint deadline on its normalized error", async () => {
    setKey("nano-provider");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        isBalance(url) ? new Response(JSON.stringify(balancePayload)) : limited("60"),
      ),
    );
    const retryAtMs = Date.now() + 60_000;
    const result = await nanoGptProvider.fetch({} as QuotaProviderContext);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.errors).toMatchObject([{ label: "NanoGPT Usage", retryAtMs }]);
  });

  it("NanoGPT with both endpoints limited reports the later deadline", async () => {
    setKey("nano-both");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request) =>
        isBalance(url) ? limited("90") : limited("60"),
      ),
    );
    expect(await queryNanoGptQuota()).toMatchObject({
      success: false,
      retryAtMs: Date.now() + 90_000,
    });
  });

  it("Kilo balance fallback 429 propagates a deadline", async () => {
    setKey("kilo-fallback");
    const noPass = JSON.stringify([{ result: { data: { json: { subscription: null } } } }]);
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("getState") ? new Response(noPass) : limited("60"),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;
    expect(await queryKiloQuota()).toMatchObject({ success: false, retryAtMs });
    await queryKiloQuota();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("Kilo balance fallback preserves Retry-After when its 429 body stalls", async () => {
    setKey("kilo-fallback-body-stall");
    const noPass = JSON.stringify([{ result: { data: { json: { subscription: null } } } }]);
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("getState")
        ? new Response(noPass)
        : stalledLimited("60", init?.signal ?? undefined),
    );
    vi.stubGlobal("fetch", fetcher);
    const retryAtMs = Date.now() + 60_000;

    const firstRequest = queryKiloQuota({ requestTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(firstRequest).resolves.toMatchObject({ success: false, retryAtMs });

    await expect(queryKiloQuota({ requestTimeoutMs: 10 })).resolves.toMatchObject({
      success: false,
      retryAtMs,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("Kilo provider surfaces retryAtMs on its error", async () => {
    setKey("kilo-provider");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => limited("60")),
    );
    const retryAtMs = Date.now() + 60_000;
    const result = await kiloProvider.fetch({} as QuotaProviderContext);
    expect(result.errors).toMatchObject([{ retryAtMs }]);
  });
});
