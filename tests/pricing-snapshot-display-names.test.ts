import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetPricingSnapshotForTests,
  getPricingSnapshotHealth,
  getPricingSnapshotMeta,
  getPricingSnapshotNames,
  getRuntimePricingRefreshStatePath,
  getRuntimePricingSnapshotPath,
  hasPricingNameCoverage,
  listModelDisplayNames,
  lookupCost,
  maybeRefreshPricingSnapshot,
} from "../src/lib/modelsdev-pricing.js";
import type { OpencodeRuntimeDirs } from "../src/lib/opencode-runtime-paths.js";

const NOW = 1_800_000_000_000;
const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  __resetPricingSnapshotForTests();
  for (const root of TEMP_ROOTS.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function runtimeSnapshot(input: {
  generatedAt: number;
  providers: Record<string, Record<string, { input?: number; output?: number }>>;
  catalog: Record<string, string[]>;
  names: Record<string, Record<string, string>>;
  namesVersion?: number;
}): unknown {
  return {
    _meta: {
      source: "test-runtime",
      generatedAt: input.generatedAt,
      providers: Object.keys(input.providers),
      units: "USD per 1M tokens",
      ...(input.namesVersion === 0 ? {} : { namesVersion: input.namesVersion ?? 1 }),
    },
    providers: input.providers,
    catalog: input.catalog,
    names: input.names,
  };
}

async function createRuntimeDirs(): Promise<OpencodeRuntimeDirs> {
  const root = await mkdtemp(join(tmpdir(), "opencode-quota-names-"));
  TEMP_ROOTS.push(root);
  return {
    dataDir: join(root, "data"),
    configDir: join(root, "config"),
    cacheDir: join(root, "cache"),
    stateDir: join(root, "state"),
  };
}

async function writeRuntimeSnapshot(dirs: OpencodeRuntimeDirs, snapshot: unknown): Promise<string> {
  const path = getRuntimePricingSnapshotPath(dirs);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot), "utf8");
  return path;
}

async function loadSnapshot(names: unknown, options?: { namesVersion?: number }): Promise<void> {
  await maybeRefreshPricingSnapshot({
    nowMs: NOW,
    fetchFn: vi.fn(),
    snapshotSelection: "bundled",
    bootstrapSnapshotOverride: {
      _meta: {
        source: "test-bootstrap",
        generatedAt: NOW,
        providers: ["anthropic"],
        units: "USD per 1M tokens",
        ...(options?.namesVersion === 0 ? {} : { namesVersion: options?.namesVersion ?? 1 }),
      },
      providers: {
        anthropic: { "claude-opus-5-5": { input: 1, output: 2 } },
      },
      catalog: { anthropic: ["claude-opus-5-5", "claude-opus-5-6"] },
      names,
    },
  });
}

describe("pricing snapshot display names", () => {
  it("normalizes, trims, and sorts optional names", async () => {
    await loadSnapshot({
      anthropic: {
        "claude-opus-5-6": "  Claude Opus 5.6  ",
        "claude-opus-5-5": "Claude Opus 5.5",
        invalid: 42,
        blank: "   ",
      },
    });

    expect(getPricingSnapshotNames()).toEqual({
      anthropic: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });
    expect(getPricingSnapshotMeta().namesVersion).toBe(1);
    expect(getPricingSnapshotHealth({ nowMs: NOW }).namesVersion).toBe(1);
    expect(listModelDisplayNames("anthropic")).toEqual([
      { modelID: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { modelID: "claude-opus-5-6", name: "Claude Opus 5.6" },
    ]);
  });

  it("keeps older snapshots without names loading unchanged", async () => {
    await loadSnapshot(undefined);

    expect(getPricingSnapshotNames()).toBeUndefined();
    expect(listModelDisplayNames("anthropic")).toEqual([]);
  });

  it("distinguishes missing name coverage from a covered catalog without names", async () => {
    await loadSnapshot(undefined, { namesVersion: 0 });

    expect(getPricingSnapshotMeta().namesVersion).toBeUndefined();
    expect(getPricingSnapshotHealth({ nowMs: NOW }).namesVersion).toBeUndefined();
    expect(hasPricingNameCoverage()).toBe(false);

    await loadSnapshot(undefined);

    expect(getPricingSnapshotHealth({ nowMs: NOW }).namesVersion).toBe(1);
    expect(hasPricingNameCoverage()).toBe(true);
  });

  it("drops malformed name maps rather than inventing display names", async () => {
    await loadSnapshot({ anthropic: "not-a-map" });

    expect(getPricingSnapshotNames()).toBeUndefined();
  });

  it("retains out-of-scope names across an in-process scoped refresh", async () => {
    const dirs = await createRuntimeDirs();
    const path = await writeRuntimeSnapshot(
      dirs,
      runtimeSnapshot({
        generatedAt: NOW - 1_000,
        providers: { anthropic: { "claude-opus-5-5": { input: 1, output: 2 } } },
        catalog: { anthropic: ["claude-opus-5-5"] },
        names: { anthropic: { "claude-opus-5-5": "Claude Opus 5.5" } },
      }),
    );
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          openai: {
            models: { "gpt-new": { name: "GPT New", cost: { input: 3, output: 4 } } },
          },
        }),
        { status: 200 },
      ),
    );

    const result = await maybeRefreshPricingSnapshot({
      force: true,
      nowMs: NOW,
      runtimeDirs: dirs,
      fetchFn,
      providerAllowlist: ["openai"],
      snapshotSelection: "runtime",
    });

    expect(result).toMatchObject({ attempted: true, updated: true });
    expect(getPricingSnapshotNames()).toEqual({
      anthropic: { "claude-opus-5-5": "Claude Opus 5.5" },
      openai: { "gpt-new": "GPT New" },
    });
    expect(JSON.parse(await readFile(path, "utf8")).names).toEqual({
      anthropic: { "claude-opus-5-5": "Claude Opus 5.5" },
      openai: { "gpt-new": "GPT New" },
    });
  });

  it("keeps a retired model's price but not its display name across a refresh", async () => {
    const dirs = await createRuntimeDirs();
    await writeRuntimeSnapshot(
      dirs,
      runtimeSnapshot({
        generatedAt: NOW - 1_000,
        providers: {
          anthropic: {
            "claude-opus-5-4": { input: 9, output: 10 },
            "claude-opus-5-5": { input: 1, output: 2 },
          },
        },
        catalog: { anthropic: ["claude-opus-5-4", "claude-opus-5-5"] },
        names: {
          anthropic: {
            "claude-opus-5-4": "Claude Opus 5.4",
            "claude-opus-5-5": "Claude Opus 5.5",
          },
        },
      }),
    );
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          anthropic: {
            models: {
              "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: 1, output: 2 } },
            },
          },
        }),
        { status: 200 },
      ),
    );

    await maybeRefreshPricingSnapshot({
      force: true,
      nowMs: NOW,
      runtimeDirs: dirs,
      fetchFn,
      snapshotSelection: "runtime",
    });

    expect(lookupCost("anthropic", "claude-opus-5-4")).toEqual({ input: 9, output: 10 });
    expect(getPricingSnapshotNames()).toEqual({
      anthropic: { "claude-opus-5-5": "Claude Opus 5.5" },
    });
  });

  it("forces one full name-coverage refresh for a legacy snapshot, then allows 304", async () => {
    const dirs = await createRuntimeDirs();
    await writeRuntimeSnapshot(
      dirs,
      runtimeSnapshot({
        generatedAt: NOW - 1_000,
        providers: { anthropic: { "claude-opus-5-5": { input: 1, output: 2 } } },
        catalog: { anthropic: ["claude-opus-5-5"] },
        names: { anthropic: { "claude-opus-5-5": "Claude Opus 5.5" } },
        namesVersion: 0,
      }),
    );
    await writeFile(
      getRuntimePricingRefreshStatePath(dirs),
      JSON.stringify({
        version: 1,
        updatedAt: NOW - 1_000,
        lastAttemptAt: NOW - 1_000,
        etag: "legacy-etag",
        lastModified: "legacy-last-modified",
      }),
      "utf8",
    );

    const fetchFn = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const headers = new Headers(init?.headers);
        expect(headers.get("If-None-Match")).toBeNull();
        expect(headers.get("If-Modified-Since")).toBeNull();
        return new Response(
          JSON.stringify({
            anthropic: {
              models: {
                "claude-opus-5-5": { name: "Claude Opus 5.5", cost: { input: 1, output: 2 } },
                "claude-opus-5-6": { name: "Claude Opus 5.6", cost: { input: 10, output: 20 } },
              },
            },
          }),
          { status: 200, headers: { etag: "fresh-etag" } },
        );
      },
    );

    const upgraded = await maybeRefreshPricingSnapshot({
      nowMs: NOW,
      runtimeDirs: dirs,
      fetchFn,
      snapshotSelection: "runtime",
      maxAgeMs: 3 * 24 * 60 * 60 * 1000,
      minAttemptIntervalMs: 0,
    });

    expect(upgraded).toMatchObject({ attempted: true, updated: true });
    expect(getPricingSnapshotMeta().namesVersion).toBe(1);
    expect(getPricingSnapshotNames()).toEqual({
      anthropic: {
        "claude-opus-5-5": "Claude Opus 5.5",
        "claude-opus-5-6": "Claude Opus 5.6",
      },
    });

    const notModifiedFetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        expect(new Headers(init?.headers).get("If-None-Match")).toBe("fresh-etag");
        return new Response(null, { status: 304 });
      },
    );
    const notModified = await maybeRefreshPricingSnapshot({
      nowMs: NOW + 60_000,
      force: true,
      runtimeDirs: dirs,
      fetchFn: notModifiedFetch,
      snapshotSelection: "runtime",
    });

    expect(notModified).toMatchObject({ attempted: true, updated: true });
    expect(notModified.state.lastResult).toBe("not_modified");
    expect(getPricingSnapshotMeta().namesVersion).toBe(1);
    expect(getPricingSnapshotNames()?.anthropic?.["claude-opus-5-6"]).toBe("Claude Opus 5.6");
  });
});
