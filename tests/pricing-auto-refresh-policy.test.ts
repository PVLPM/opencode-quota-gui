import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function createBootstrapSnapshot(generatedAt: number) {
  return {
    _meta: {
      source: "test-bootstrap",
      generatedAt,
      providers: ["openai"],
      units: "USD per 1M tokens",
    },
    providers: {
      openai: {
        "gpt-4o-mini": {
          input: 0.15,
          output: 0.6,
          cache_read: 0.03,
          cache_write: 0.2,
        },
      },
    },
  };
}

function createRuntimeSnapshot(generatedAt: number, input: number) {
  return {
    _meta: {
      source: "test-runtime",
      generatedAt,
      providers: ["openai"],
      units: "USD per 1M tokens",
    },
    providers: {
      openai: {
        "gpt-4o-mini": {
          input,
          output: input * 4,
          cache_read: input / 5,
          cache_write: input / 3,
        },
      },
    },
    catalog: {
      openai: ["gpt-4o-mini"],
    },
  };
}

function createRuntimeDirs(root: string): OpencodeRuntimeDirs {
  return {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const tempRoots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function createTempRuntimeDirs(): Promise<OpencodeRuntimeDirs> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-pricing-"));
  tempRoots.push(root);
  return createRuntimeDirs(root);
}

async function loadPricingModule() {
  vi.resetModules();
  return await import("../src/lib/modelsdev-pricing.js");
}

describe("pricing runtime refresh policy", () => {
  it("does not fetch when snapshot is fresh", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const fetchFn = vi.fn();

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("fetches and persists a runtime snapshot when stale", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": {
                cost: {
                  input: 0.123,
                  output: 0.456,
                  cache_read: 0.01,
                  cache_write: 0.02,
                  reasoning: 999,
                  ignored_key: 123,
                },
              },
            },
          },
        }),
        {
          status: 200,
          headers: {
            etag: "etag-1",
            "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT",
          },
        },
      ),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    expect(await exists(runtimeSnapshotPath)).toBe(true);

    const persistedSnapshot = JSON.parse(await readFile(runtimeSnapshotPath, "utf-8"));
    expect(persistedSnapshot._meta.generatedAt).toBe(nowMs);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"]).toEqual({
      input: 0.123,
      output: 0.456,
      cache_read: 0.01,
      cache_write: 0.02,
      reasoning: 999,
    });
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.reasoning).toBe(999);
  });

  it("preserves explicit reasoning rates for base and context-tier rates", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn: vi.fn(),
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: {
        _meta: {
          source: "test-bootstrap",
          generatedAt: nowMs,
          providers: ["openai"],
          units: "USD per 1M tokens",
        },
        providers: {
          openai: {
            "reasoning-model": {
              input: 1,
              output: 4,
              cache_write: 2,
              reasoning: 3,
              tiers: [
                {
                  input: 1.5,
                  output: 5,
                  reasoning: 4.5,
                  tier: { type: "context", size: 200_000 },
                },
              ],
            },
          },
        },
      },
    });

    expect(result.reason).toBe("selection_bundled");
    expect(pricing.lookupCost("openai", "reasoning-model")).toEqual({
      input: 1,
      output: 4,
      cache_write: 2,
      reasoning: 3,
      tiers: [
        {
          input: 1.5,
          output: 5,
          reasoning: 4.5,
          tier: { type: "context", size: 200_000 },
        },
      ],
    });
    expect(pricing.lookupCostAtContext("openai", "reasoning-model", 200_000)?.rates).toEqual({
      input: 1.5,
      output: 5,
      reasoning: 4.5,
    });
  });

  it("falls back to last local snapshot when fetch fails", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(false);
    expect(result.error).toContain("network down");

    const fallbackCost = pricing.lookupCost("openai", "gpt-4o-mini");
    expect(fallbackCost?.input).toBe(0.15);

    const state = await pricing.readPricingRefreshState(runtimeDirs);
    expect(state?.lastResult).toBe("failed");
    expect(state?.lastError).toContain("network down");
  });

  it("uses bundled bootstrap snapshot when no runtime snapshot exists", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn: vi.fn(),
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.output).toBe(0.6);

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    expect(await exists(runtimeSnapshotPath)).toBe(false);
  });

  it("refreshes local snapshot freshness when models.dev responds 304", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    // A current runtime snapshot carries its catalog, so a conditional 304 is a
    // valid freshness refresh.
    await mkdir(join(runtimeDirs.cacheDir, "opencode-quota-gui"), { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(staleGeneratedAt, 0.15)),
      "utf-8",
    );

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: {
          etag: "etag-304",
          "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT",
        },
      }),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.state.lastResult).toBe("not_modified");
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.getPricingSnapshotMeta().generatedAt).toBe(nowMs);

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    const persistedSnapshot = JSON.parse(await readFile(runtimeSnapshotPath, "utf-8"));
    expect(persistedSnapshot._meta.generatedAt).toBe(nowMs);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"].input).toBe(0.15);
  });

  it("forces an unconditional catalog refresh for a legacy runtime snapshot without catalog", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });

    const legacyRuntime = createRuntimeSnapshot(nowMs - 60_000, 0.5);
    delete legacyRuntime.catalog;
    Object.assign(legacyRuntime.providers.openai, {
      "present-unpriced": { input: 4, output: 8 },
    });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(legacyRuntime),
      "utf-8",
    );
    await writeFile(
      pricing.getRuntimePricingRefreshStatePath(runtimeDirs),
      JSON.stringify({
        version: 1,
        updatedAt: nowMs - 60_000,
        lastAttemptAt: nowMs - 7 * 60 * 60 * 1000,
        etag: "legacy-etag",
        lastModified: "Tue, 03 Mar 2026 00:00:00 GMT",
      }),
      "utf-8",
    );

    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("If-None-Match")).toBeNull();
      expect(headers.get("If-Modified-Since")).toBeNull();
      return new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": { cost: { input: 0.123, output: 0.456 } },
              "present-unpriced": { cost: {} },
            },
          },
        }),
        { status: 200, headers: { etag: "fresh-etag" } },
      );
    });

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(result).toMatchObject({ attempted: true, updated: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.lookupCost("openai", "present-unpriced")).toBeNull();
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toEqual({
      input: 0.123,
      output: 0.456,
    });

    const persisted = JSON.parse(
      await readFile(pricing.getRuntimePricingSnapshotPath(runtimeDirs), "utf-8"),
    );
    expect(persisted.providers.openai["present-unpriced"]).toBeUndefined();
    expect(persisted.catalog.openai).toEqual(["gpt-4o-mini", "present-unpriced"]);
    expect((await pricing.readPricingRefreshState(runtimeDirs))?.etag).toBe("fresh-etag");
  });

  it("treats a repeated 304 without an authoritative catalog as a failed refresh", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });

    const legacyRuntime = createRuntimeSnapshot(nowMs - 60_000, 0.5);
    delete legacyRuntime.catalog;
    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    await writeFile(snapshotPath, JSON.stringify(legacyRuntime), "utf-8");
    await writeFile(
      pricing.getRuntimePricingRefreshStatePath(runtimeDirs),
      JSON.stringify({
        version: 1,
        updatedAt: nowMs - 60_000,
        lastAttemptAt: nowMs - 7 * 60 * 60 * 1000,
        etag: "pinned-etag",
      }),
      "utf-8",
    );

    const before = await readFile(snapshotPath, "utf-8");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("If-None-Match")).toBeNull();
      return new Response(null, { status: 304 });
    });

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(result).toMatchObject({ attempted: true, updated: false });
    expect(result.state.lastResult).toBe("failed");
    expect(result.state.lastSuccessAt).toBeUndefined();
    expect(result.error).toMatch(/not modified/i);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(await readFile(snapshotPath, "utf-8")).toBe(before);
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.5);
  });

  it("keeps models that models.dev no longer lists, preferring the runtime price", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const bundledGeneratedAt = nowMs - 10 * DAY_MS;
    const runtimeGeneratedAt = nowMs - 4 * DAY_MS;

    const bundled = createBootstrapSnapshot(bundledGeneratedAt);
    Object.assign(bundled.providers.openai, {
      "retired-in-both": { input: 1, output: 2 },
      "retired-bundled-only": { input: 3, output: 4 },
    });
    const runtime = createRuntimeSnapshot(runtimeGeneratedAt, 0.5);
    Object.assign(runtime.providers.openai, {
      "retired-in-both": { input: 5, output: 6 },
    });
    await mkdir(join(runtimeDirs.cacheDir, "opencode-quota-gui"), { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(runtime),
      "utf-8",
    );

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: { models: { "gpt-4o-mini": { cost: { input: 0.123, output: 0.456 } } } },
        }),
        { status: 200 },
      ),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: bundled,
    });

    expect(result.updated).toBe(true);
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toEqual({ input: 0.123, output: 0.456 });
    expect(pricing.lookupCost("openai", "retired-in-both")).toEqual({ input: 5, output: 6 });
    expect(pricing.lookupCost("openai", "retired-bundled-only")).toEqual({ input: 3, output: 4 });

    const persistedSnapshot = JSON.parse(
      await readFile(pricing.getRuntimePricingSnapshotPath(runtimeDirs), "utf-8"),
    );
    expect(Object.keys(persistedSnapshot.providers.openai)).toEqual([
      "gpt-4o-mini",
      "retired-bundled-only",
      "retired-in-both",
    ]);
  });

  it("uses the authoritative catalog to keep absent, overwrite priced, and remove unpriced models", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const bundled = createBootstrapSnapshot(nowMs - 10 * DAY_MS);
    Object.assign(bundled.providers.openai, {
      "retired-model": { input: 3, output: 15 },
      "repriced-model": { input: 1, output: 2 },
      "removed-model": { input: 5, output: 6 },
    });

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "repriced-model": { cost: { input: 2, output: 4 } },
              "removed-model": { cost: {} },
              "new-unpriced-model": { cost: { input: "2" } },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const first = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: bundled,
    });

    expect(first).toMatchObject({ attempted: true, updated: true });
    expect(pricing.lookupCost("openai", "repriced-model")).toEqual({ input: 2, output: 4 });
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 3, output: 15 });
    expect(pricing.lookupCost("openai", "removed-model")).toBeNull();
    expect(pricing.lookupCost("openai", "new-unpriced-model")).toBeNull();

    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    const persisted = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted.providers.openai).toEqual({
      "gpt-4o-mini": { input: 0.15, output: 0.6, cache_read: 0.03, cache_write: 0.2 },
      "repriced-model": { input: 2, output: 4 },
      "retired-model": { input: 3, output: 15 },
    });
    expect(persisted.catalog.openai).toEqual([
      "new-unpriced-model",
      "removed-model",
      "repriced-model",
    ]);

    // A 304 refresh has no fresh catalog; the persisted catalog still prevents
    // the old bundled price for a present-but-unpriced model from returning.
    const notModifiedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const second = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 1,
      force: true,
      runtimeDirs,
      fetchFn: notModifiedFetch,
      bootstrapSnapshotOverride: bundled,
    });

    expect(second.state.lastResult).toBe("not_modified");
    expect(pricing.lookupCost("openai", "removed-model")).toBeNull();
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 3, output: 15 });
    const persisted304 = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted304.providers.openai["removed-model"]).toBeUndefined();
    expect(persisted304.catalog.openai).toEqual([
      "new-unpriced-model",
      "removed-model",
      "repriced-model",
    ]);

    // Offline failure leaves the last successful snapshot exactly as it was.
    const beforeFailure = await readFile(snapshotPath, "utf-8");
    const failed = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 2,
      force: true,
      runtimeDirs,
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      bootstrapSnapshotOverride: bundled,
    });

    expect(failed).toMatchObject({ attempted: true, updated: false, error: "offline" });
    expect(await readFile(snapshotPath, "utf-8")).toBe(beforeFailure);
    expect(pricing.lookupCost("openai", "removed-model")).toBeNull();
  });

  it("prefers the runtime price of a retired model even when the bundled file is newer", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    // Bundled file rewritten later, but its kept price is an older observation.
    const bundled = createBootstrapSnapshot(nowMs - 2 * DAY_MS);
    Object.assign(bundled.providers.openai, { "retired-model": { input: 1, output: 2 } });
    const runtime = createRuntimeSnapshot(nowMs - 20 * DAY_MS, 0.5);
    Object.assign(runtime.providers.openai, { "retired-model": { input: 7, output: 8 } });
    await mkdir(join(runtimeDirs.cacheDir, "opencode-quota-gui"), { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(runtime),
      "utf-8",
    );

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: { models: { "gpt-4o-mini": { cost: { input: 0.123, output: 0.456 } } } },
        }),
        { status: 200 },
      ),
    );

    await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      bootstrapSnapshotOverride: bundled,
    });

    const persistedSnapshot = JSON.parse(
      await readFile(pricing.getRuntimePricingSnapshotPath(runtimeDirs), "utf-8"),
    );
    expect(persistedSnapshot.providers.openai["retired-model"]).toEqual({ input: 7, output: 8 });
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 7, output: 8 });
  });

  it("fills retired models from the bundled file into a fresh runtime snapshot without refreshing", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const bundled = createBootstrapSnapshot(nowMs - 10 * DAY_MS);
    Object.assign(bundled.providers.openai, { "retired-model": { input: 3, output: 4 } });
    // Saved by an older version after models.dev dropped the model, and still fresh.
    await mkdir(join(runtimeDirs.cacheDir, "opencode-quota-gui"), { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(nowMs - DAY_MS, 0.5)),
      "utf-8",
    );

    const fetchFn = vi.fn();
    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 7 * DAY_MS,
      bootstrapSnapshotOverride: bundled,
    });

    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.5);
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 3, output: 4 });
  });

  it("fills newly bundled providers into an older runtime snapshot without network access", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const bundled = createBootstrapSnapshot(nowMs - 10 * DAY_MS);
    Object.assign(bundled.providers, {
      opencode: { "big-pickle": { input: 3, output: 15 } },
    });
    await mkdir(join(runtimeDirs.cacheDir, "opencode-quota-gui"), { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(nowMs - DAY_MS, 0.5)),
      "utf-8",
    );

    const fetchFn = vi.fn();
    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 7 * DAY_MS,
      bootstrapSnapshotOverride: bundled,
    });

    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.lookupCost("opencode", "big-pickle")).toEqual({ input: 3, output: 15 });
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.5);
  });

  it("retains kept models from providers outside the refresh allowlist", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const bundled = createBootstrapSnapshot(nowMs - 4 * DAY_MS);
    Object.assign(bundled.providers, { xai: { "grok-old": { input: 1, output: 2 } } });

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: { models: { "gpt-4o-mini": { cost: { input: 0.123, output: 0.456 } } } },
        }),
        { status: 200 },
      ),
    );

    await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: bundled,
    });

    const persistedSnapshot = JSON.parse(
      await readFile(pricing.getRuntimePricingSnapshotPath(runtimeDirs), "utf-8"),
    );
    expect(persistedSnapshot._meta.providers).toEqual(["openai", "xai"]);
    expect(persistedSnapshot.providers.xai["grok-old"]).toEqual({ input: 1, output: 2 });
    expect(persistedSnapshot.catalog.xai).toBeUndefined();
  });

  it("scopes replacement to allowlisted providers across a later 304 and offline failure", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });

    const runtime = createRuntimeSnapshot(nowMs - 4 * DAY_MS, 0.5);
    Object.assign(runtime.providers.openai, {
      "present-unpriced": { input: 4, output: 8 },
    });
    Object.assign(runtime.providers, {
      xai: { "grok-kept": { input: 7, output: 8 } },
    });
    runtime._meta.providers = ["openai", "xai"];
    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    await writeFile(snapshotPath, JSON.stringify(runtime), "utf-8");

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": { cost: { input: 0.123, output: 0.456 } },
              "present-unpriced": { cost: {} },
            },
          },
          xai: {
            models: {
              "grok-kept": { cost: { input: 99, output: 100 } },
            },
          },
        }),
        { status: 200, headers: { etag: "scoped-etag" } },
      ),
    );

    const first = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(first).toMatchObject({ attempted: true, updated: true });
    const persisted = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted.providers.openai).toEqual({
      "gpt-4o-mini": { input: 0.123, output: 0.456 },
    });
    expect(persisted.providers.xai["grok-kept"]).toEqual({ input: 7, output: 8 });
    expect(persisted.catalog.openai).toEqual(["gpt-4o-mini", "present-unpriced"]);
    expect(persisted.catalog.xai).toBeUndefined();
    expect(pricing.lookupCost("xai", "grok-kept")).toEqual({ input: 7, output: 8 });
    expect(pricing.lookupCost("openai", "present-unpriced")).toBeNull();

    // The scoped snapshot has an authoritative catalog for openai, so a
    // conditional 304 is a valid freshness refresh and still keeps xai.
    const notModifiedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const second = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 1,
      runtimeDirs,
      fetchFn: notModifiedFetch,
      force: true,
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(second).toMatchObject({ attempted: true, updated: true });
    expect(second.state.lastResult).toBe("not_modified");
    expect(pricing.lookupCost("xai", "grok-kept")).toEqual({ input: 7, output: 8 });
    expect(pricing.lookupCost("openai", "present-unpriced")).toBeNull();
    const persisted304 = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted304.providers.xai["grok-kept"]).toEqual({ input: 7, output: 8 });
    expect(persisted304.catalog.xai).toBeUndefined();

    // Offline failure preserves the scoped snapshot exactly as it was.
    const beforeFailure = await readFile(snapshotPath, "utf-8");
    const failed = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 2,
      runtimeDirs,
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      force: true,
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(failed).toMatchObject({ attempted: true, updated: false, error: "offline" });
    expect(await readFile(snapshotPath, "utf-8")).toBe(beforeFailure);
    expect(pricing.lookupCost("xai", "grok-kept")).toEqual({ input: 7, output: 8 });
  });

  it("preserves an unscoped provider's authoritative catalog across scoped refresh, 304, and offline", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);

    const bundled = createBootstrapSnapshot(nowMs - 10 * DAY_MS);
    Object.assign(bundled.providers, {
      "b-labs": {
        "b-priced": { input: 9, output: 9 },
        "b-priced-two": { input: 13, output: 14 },
        "b-unpriced": { input: 11, output: 12 },
      },
    });

    const fullFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          "a-labs": { models: { "a-priced": { cost: { input: 1, output: 2 } } } },
          "b-labs": {
            models: {
              "b-priced": { cost: { input: 3, output: 4 } },
              "b-priced-two": { cost: { input: 5, output: 6 } },
              "b-unpriced": { cost: {} },
            },
          },
        }),
        { status: 200, headers: { etag: "full-etag" } },
      ),
    );

    const first = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn: fullFetch,
      force: true,
      bootstrapSnapshotOverride: bundled,
    });

    expect(first).toMatchObject({ attempted: true, updated: true });
    expect(pricing.lookupCost("b-labs", "b-priced")).toEqual({ input: 3, output: 4 });
    expect(pricing.lookupCost("b-labs", "b-priced-two")).toEqual({ input: 5, output: 6 });
    expect(pricing.lookupCost("b-labs", "b-unpriced")).toBeNull();
    const fullPersisted = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(fullPersisted.catalog["b-labs"]).toEqual(["b-priced", "b-priced-two", "b-unpriced"]);

    // The scoped response also carries b-labs, but only a-labs is replaced.
    const scopedFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          "a-labs": { models: { "a-priced": { cost: { input: 7, output: 8 } } } },
          "b-labs": {
            models: {
              "b-priced": { cost: { input: 99, output: 100 } },
              "b-priced-two": { cost: { input: 101, output: 102 } },
              "b-unpriced": { cost: { input: 99 } },
            },
          },
        }),
        { status: 200, headers: { etag: "scoped-etag" } },
      ),
    );

    await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 1,
      runtimeDirs,
      fetchFn: scopedFetch,
      force: true,
      providerAllowlist: ["a-labs"],
      bootstrapSnapshotOverride: bundled,
    });

    expect(pricing.lookupCost("a-labs", "a-priced")).toEqual({ input: 7, output: 8 });
    expect(pricing.lookupCost("b-labs", "b-priced")).toEqual({ input: 3, output: 4 });
    expect(pricing.lookupCost("b-labs", "b-priced-two")).toEqual({ input: 5, output: 6 });
    expect(pricing.lookupCost("b-labs", "b-unpriced")).toBeNull();
    const scopedPersisted = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(scopedPersisted.providers["b-labs"]["b-unpriced"]).toBeUndefined();
    expect(scopedPersisted.catalog["b-labs"]).toEqual(["b-priced", "b-priced-two", "b-unpriced"]);

    const notModifiedFetch = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));
    const second = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 2,
      runtimeDirs,
      fetchFn: notModifiedFetch,
      force: true,
      providerAllowlist: ["a-labs"],
      bootstrapSnapshotOverride: bundled,
    });

    expect(second.state.lastResult).toBe("not_modified");
    expect(pricing.lookupCost("b-labs", "b-priced")).toEqual({ input: 3, output: 4 });
    expect(pricing.lookupCost("b-labs", "b-priced-two")).toEqual({ input: 5, output: 6 });
    expect(pricing.lookupCost("b-labs", "b-unpriced")).toBeNull();
    const persisted304 = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted304.catalog["b-labs"]).toEqual(["b-priced", "b-priced-two", "b-unpriced"]);

    const beforeFailure = await readFile(snapshotPath, "utf-8");
    const failed = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 3,
      runtimeDirs,
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      force: true,
      providerAllowlist: ["a-labs"],
      bootstrapSnapshotOverride: bundled,
    });

    expect(failed).toMatchObject({ attempted: true, updated: false, error: "offline" });
    expect(await readFile(snapshotPath, "utf-8")).toBe(beforeFailure);
    expect(pricing.lookupCost("b-labs", "b-priced")).toEqual({ input: 3, output: 4 });
    expect(pricing.lookupCost("b-labs", "b-priced-two")).toEqual({ input: 5, output: 6 });
    expect(pricing.lookupCost("b-labs", "b-unpriced")).toBeNull();
  });

  it("accepts a scoped all-unpriced catalog and clears stale scoped prices", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });

    const runtime = createRuntimeSnapshot(nowMs - 4 * DAY_MS, 0.5);
    Object.assign(runtime.providers.openai, {
      "present-unpriced": { input: 4, output: 8 },
    });
    Object.assign(runtime.providers, {
      xai: { "grok-kept": { input: 7, output: 8 } },
    });
    runtime._meta.providers = ["openai", "xai"];
    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    await writeFile(snapshotPath, JSON.stringify(runtime), "utf-8");

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": { cost: {} },
              "present-unpriced": { cost: {} },
            },
          },
          xai: {
            models: {
              "grok-kept": { cost: { input: 99, output: 100 } },
            },
          },
        }),
        { status: 200, headers: { etag: "all-unpriced-etag" } },
      ),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(result).toMatchObject({ attempted: true, updated: true });
    expect(result.state.lastResult).toBe("success");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toBeNull();
    expect(pricing.lookupCost("openai", "present-unpriced")).toBeNull();
    expect(pricing.lookupCost("xai", "grok-kept")).toEqual({ input: 7, output: 8 });

    const persisted = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted.providers.openai).toBeUndefined();
    expect(persisted.providers.xai["grok-kept"]).toEqual({ input: 7, output: 8 });
    expect(persisted.catalog.openai).toEqual(["gpt-4o-mini", "present-unpriced"]);
    expect(persisted.catalog.xai).toBeUndefined();
    expect(persisted._meta.providers).toEqual(["xai"]);

    // Offline after an accepted all-unpriced scope preserves the result.
    const beforeFailure = await readFile(snapshotPath, "utf-8");
    const failed = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 1,
      runtimeDirs,
      fetchFn: vi.fn().mockRejectedValue(new Error("offline")),
      force: true,
      providerAllowlist: ["openai"],
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(failed).toMatchObject({ attempted: true, updated: false, error: "offline" });
    expect(await readFile(snapshotPath, "utf-8")).toBe(beforeFailure);
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toBeNull();
    expect(pricing.lookupCost("xai", "grok-kept")).toEqual({ input: 7, output: 8 });
  });

  it("accepts a global all-unpriced catalog and clears all stale prices", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });

    const runtime = createRuntimeSnapshot(nowMs - 4 * DAY_MS, 0.5);
    Object.assign(runtime.providers, {
      xai: { "grok-kept": { input: 7, output: 8 } },
    });
    runtime._meta.providers = ["openai", "xai"];
    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    await writeFile(snapshotPath, JSON.stringify(runtime), "utf-8");

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: { models: { "gpt-4o-mini": { cost: {} } } },
          xai: { models: { "grok-kept": { cost: {} } } },
        }),
        { status: 200 },
      ),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
    });

    expect(result).toMatchObject({ attempted: true, updated: true });
    expect(pricing.lookupCost("openai", "gpt-4o-mini")).toBeNull();
    expect(pricing.lookupCost("xai", "grok-kept")).toBeNull();

    const persisted = JSON.parse(await readFile(snapshotPath, "utf-8"));
    expect(persisted.providers).toEqual({});
    expect(persisted.catalog.openai).toEqual(["gpt-4o-mini"]);
    expect(persisted.catalog.xai).toEqual(["grok-kept"]);
    expect(persisted._meta.providers).toEqual([]);
  });

  it("rejects upstream responses with neither prices nor catalog entries", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });

    const snapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    await writeFile(
      snapshotPath,
      JSON.stringify(createRuntimeSnapshot(nowMs - 4 * DAY_MS, 0.5)),
      "utf-8",
    );
    const before = await readFile(snapshotPath, "utf-8");

    for (const api of [{}, { openai: {} }, { openai: { models: {} } }]) {
      const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify(api), { status: 200 }));

      const result = await pricing.maybeRefreshPricingSnapshot({
        nowMs,
        runtimeDirs,
        fetchFn,
        force: true,
        bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs - 10 * DAY_MS),
      });

      expect(result, JSON.stringify(api)).toMatchObject({
        attempted: true,
        updated: false,
      });
      expect(result.state.lastResult).toBe("failed");
      expect(result.error).toMatch(/Refusing to persist empty pricing snapshot/);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(await readFile(snapshotPath, "utf-8")).toBe(before);
    }

    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.5);
  });

  it("keeps providers the central API dropped when no explicit allowlist is set", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const bundled = createBootstrapSnapshot(nowMs - 4 * DAY_MS);
    Object.assign(bundled.providers, { xai: { "grok-old": { input: 1, output: 2 } } });

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: { models: { "gpt-4o-mini": { cost: { input: 0.123, output: 0.456 } } } },
        }),
        { status: 200 },
      ),
    );

    await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: bundled,
    });

    const persistedSnapshot = JSON.parse(
      await readFile(pricing.getRuntimePricingSnapshotPath(runtimeDirs), "utf-8"),
    );
    expect(persistedSnapshot._meta.providers).toEqual(["openai", "xai"]);
    expect(persistedSnapshot.providers.xai["grok-old"]).toEqual({ input: 1, output: 2 });
  });

  it("restores bundled models missing from an older runtime snapshot on 304", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const bundled = createBootstrapSnapshot(nowMs - 10 * DAY_MS);
    Object.assign(bundled.providers.openai, { "retired-model": { input: 3, output: 4 } });
    await mkdir(join(runtimeDirs.cacheDir, "opencode-quota-gui"), { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(nowMs - 4 * DAY_MS, 0.5)),
      "utf-8",
    );

    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 304 }));

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: bundled,
    });

    expect(result.state.lastResult).toBe("not_modified");
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.5);
    expect(pricing.lookupCost("openai", "retired-model")).toEqual({ input: 3, output: 4 });
  });

  it("pins the bundled snapshot and skips runtime refresh attempts", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(nowMs + 60_000, 9.99)),
      "utf-8",
    );

    const fetchFn = vi.fn();
    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      snapshotSelection: "bundled",
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("selection_bundled");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);

    const refreshStatePath = pricing.getRuntimePricingRefreshStatePath(runtimeDirs);
    expect(await exists(refreshStatePath)).toBe(false);
  });

  it("allows manual refresh to update the runtime snapshot while bundled selection stays active", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": {
                cost: {
                  input: 0.222,
                  output: 0.888,
                },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    const persistedSnapshot = JSON.parse(await readFile(runtimeSnapshotPath, "utf-8"));
    expect(persistedSnapshot._meta.generatedAt).toBe(nowMs);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"].input).toBe(0.222);
  });

  it("preserves the prior runtime snapshot contents on 304 even when bundled selection is active", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(staleGeneratedAt - 60_000, 9.99)),
      "utf-8",
    );

    const fetchFn = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 304,
        headers: {
          etag: "etag-304-manual",
          "last-modified": "Tue, 02 Mar 2026 00:00:00 GMT",
        },
      }),
    );

    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      force: true,
      snapshotSelection: "bundled",
      allowRefreshWhenSelectionBundled: true,
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(true);
    expect(result.updated).toBe(true);
    expect(result.state.lastResult).toBe("not_modified");
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);

    const runtimeSnapshotPath = pricing.getRuntimePricingSnapshotPath(runtimeDirs);
    const persistedSnapshot = JSON.parse(await readFile(runtimeSnapshotPath, "utf-8"));
    expect(persistedSnapshot._meta.generatedAt).toBe(nowMs);
    expect(persistedSnapshot.providers.openai["gpt-4o-mini"].input).toBe(9.99);
  });

  it("pins the runtime snapshot even when the bundled snapshot is newer", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const runtimeGeneratedAt = nowMs - 60_000;
    const snapshotDir = join(runtimeDirs.cacheDir, "opencode-quota-gui");
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(
      pricing.getRuntimePricingSnapshotPath(runtimeDirs),
      JSON.stringify(createRuntimeSnapshot(runtimeGeneratedAt, 9.99)),
      "utf-8",
    );

    const fetchFn = vi.fn();
    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      snapshotSelection: "runtime",
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe("runtime");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(9.99);
  });

  it("falls back to the bundled snapshot when runtime pinning has no runtime snapshot", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;

    const fetchFn = vi.fn();
    const result = await pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      snapshotSelection: "runtime",
      bootstrapSnapshotOverride: createBootstrapSnapshot(nowMs),
    });

    expect(result.attempted).toBe(false);
    expect(result.reason).toBe("fresh");
    expect(fetchFn).not.toHaveBeenCalled();
    expect(pricing.getPricingSnapshotSource()).toBe("bundled");
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);
  });

  it("throttles refresh attempts using persisted lastAttemptAt state", async () => {
    const firstLoad = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    const failingFetch = vi.fn().mockRejectedValue(new Error("network down"));
    const firstResult = await firstLoad.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn: failingFetch,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(firstResult.attempted).toBe(true);
    expect(firstResult.updated).toBe(false);

    const secondLoad = await loadPricingModule();
    const throttledFetch = vi.fn();
    const secondResult = await secondLoad.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 60_000,
      runtimeDirs,
      fetchFn: throttledFetch,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(secondResult.attempted).toBe(false);
    expect(secondResult.reason).toBe("throttled");
    expect(throttledFetch).not.toHaveBeenCalled();
  });

  it("uses the shared timeout for an injected pre-header stall without retrying", async () => {
    vi.useFakeTimers();
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;
    let receivedSignal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      receivedSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });

    const pending = pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      timeoutMs: 1_000,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toMatchObject({
      attempted: true,
      updated: false,
      error: "Request timeout after 1s",
    });
    expect(receivedSignal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);
    const state = await pricing.readPricingRefreshState(runtimeDirs);
    expect(state).toMatchObject({ lastResult: "failed", lastError: "Request timeout after 1s" });
  });

  it("times out an injected stalled JSON body and preserves the selected snapshot", async () => {
    vi.useFakeTimers();
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => {
                controller.error(new Error("private body abort"));
              });
            },
          }),
        ),
    );

    const pending = pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      timeoutMs: 1_000,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(result).toMatchObject({
      attempted: true,
      updated: false,
      error: "Request timeout after 1s",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(pricing.lookupCost("openai", "gpt-4o-mini")?.input).toBe(0.15);
    const state = await pricing.readPricingRefreshState(runtimeDirs);
    expect(state).toMatchObject({ lastResult: "failed", lastError: "Request timeout after 1s" });
  });

  it("dedupes concurrent attempts and only checks once per process window", async () => {
    const pricing = await loadPricingModule();
    const runtimeDirs = await createTempRuntimeDirs();
    const nowMs = 1_800_000_000_000;
    const staleGeneratedAt = nowMs - 4 * DAY_MS;

    let resolveFetch: ((response: Response) => void) | null = null;
    const fetchFn = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const first = pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    const second = pricing.maybeRefreshPricingSnapshot({
      nowMs,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    resolveFetch?.(
      new Response(
        JSON.stringify({
          openai: {
            models: {
              "gpt-4o-mini": {
                cost: { input: 0.2, output: 0.8 },
              },
            },
          },
        }),
        { status: 200 },
      ),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.updated).toBe(true);
    expect(secondResult.updated).toBe(true);

    const thirdResult = await pricing.maybeRefreshPricingSnapshot({
      nowMs: nowMs + 30_000,
      runtimeDirs,
      fetchFn,
      maxAgeMs: 3 * DAY_MS,
      bootstrapSnapshotOverride: createBootstrapSnapshot(staleGeneratedAt),
    });

    expect(thirdResult.attempted).toBe(false);
    expect(thirdResult.reason).toBe("already_checked_this_process");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
