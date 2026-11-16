/**
 * OpenAI timeout recovery through the real provider, registry cache policy,
 * quota-state cache, read source and snapshot poller.
 *
 * Faked: credentials, HTTP, timers, the runtime paths (temp dir) and
 * `deriveResolvedAuthIdentity`. Production derives identities from a POSIX-owned
 * secret file and returns null where that cannot be protected (Windows), so no
 * last-good retention exists there. The retention tests below therefore model
 * an environment WITH an identity scope and do NOT represent real Windows; the
 * "no identity scope" test models Windows' fail-closed null explicitly.
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setImmediate as realSetImmediate,
  setTimeout as realSetTimeout,
} from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QuotaSnapshot } from "../src/contracts/dashboard.js";
import { createSnapshotService } from "../src/gui/snapshot-service.js";
import { createDashboardReadSource } from "../src/gui/sources.js";
import { bindCredentialSource } from "../src/lib/opencode-auth.js";
import { __resetQuotaStateForTests } from "../src/lib/quota-state.js";
import { DEFAULT_CONFIG } from "../src/lib/types.js";
import { getProviders } from "../src/providers/registry.js";

// Quota-state files live under the runtime dirs; isolate them.
const testPaths = vi.hoisted(() => ({ root: "" }));
vi.mock("../src/lib/opencode-runtime-paths.js", () => ({
  getOpencodeRuntimeDirs: () => ({
    dataDir: `${testPaths.root}/data`,
    configDir: `${testPaths.root}/config`,
    cacheDir: `${testPaths.root}/cache`,
    stateDir: `${testPaths.root}/state`,
  }),
}));

// `available: false` returns the same null production returns when the identity
// key cannot be protected.
const identity = vi.hoisted(() => ({ available: true }));
vi.mock("../src/lib/resolved-auth-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/resolved-auth-identity.js")>()),
  deriveResolvedAuthIdentity: async (params: {
    providerId: string;
    principal: { kind: string; value: string };
  }) =>
    identity.available
      ? `rai1_${createHash("sha256")
          .update(
            JSON.stringify([params.providerId, params.principal.kind, params.principal.value]),
          )
          .digest("base64url")}`
      : null,
}));

const NOW = Date.parse("2026-10-18T10:30:00.000Z");
const TIMEOUT_MS = 1_000;

const usage = (usedPercent: number) =>
  new Response(
    JSON.stringify({
      plan_type: "plus",
      rate_limit: {
        limit_reached: false,
        primary_window: {
          limit_window_seconds: 18_000,
          used_percent: usedPercent,
          reset_at: Math.floor((NOW + 4 * 60 * 60_000) / 1000),
        },
      },
    }),
  );

/** A usage request that never answers and rejects when the bounded timeout aborts it. */
const stalled = (init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  });

// Quota-state persistence uses real file I/O, which fake timers do not advance,
// so waits use real timers and fail loudly instead of silently giving up.
async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i += 1) await realSetTimeout(5);
  expect(condition(), `timed out waiting for ${label}`).toBe(true);
}

let usageCalls = 0;
async function advance(ms: number, untilCalls = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  if (untilCalls > 0) await waitFor(() => usageCalls >= untilCalls, `${untilCalls} usage calls`);
  for (let i = 0; i < 25; i += 1) await realSetImmediate();
  await vi.advanceTimersByTimeAsync(0);
}

// Wait on the service's own change events: reading quota() could itself recompute.
let quotaChanges = 0;
const untilChanges = (count: number) =>
  waitFor(() => quotaChanges >= count, `${count} quota.changed events`);

let releaseHeld: () => void = () => {};
let heldReleased = false;
/** Whether the held response had been released when each later request started. */
let releasedAtRequest: boolean[] = [];

type Step = "success-90" | "success-70" | "stall" | "hold-40";

describe("OpenAI timeout recovery", () => {
  let steps: Step[];
  let account: { id: string; access: string };
  let unbind: () => void;

  beforeEach(async () => {
    testPaths.root = await mkdtemp(join(tmpdir(), "openai-timeout-recovery-"));
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetQuotaStateForTests();
    identity.available = true;
    usageCalls = 0;
    quotaChanges = 0;
    heldReleased = false;
    releasedAtRequest = [];
    steps = [];
    account = { id: "openai-timeout-a", access: "a.b.c" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        usageCalls += 1;
        releasedAtRequest.push(heldReleased);
        const step = steps.shift() ?? "stall";
        if (step === "stall") return stalled(init);
        if (step === "hold-40")
          return new Promise<Response>((resolve) => {
            releaseHeld = () => {
              heldReleased = true;
              resolve(usage(60)); // 60% used = 40% remaining
            };
          });
        return usage(step === "success-90" ? 10 : 30);
      }) as unknown as typeof fetch,
    );
    unbind = bindCredentialSource({
      kind: "opencode-integration-api",
      async readRows({ integrationIds }) {
        if (!integrationIds.includes("openai")) return [];
        return [
          {
            id: account.id,
            integrationId: "openai",
            label: "Primary",
            active: true,
            value: { type: "oauth", access: account.access, expires: NOW + 24 * 60 * 60_000 },
          },
        ];
      },
    });
  });

  afterEach(async () => {
    unbind();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    __resetQuotaStateForTests();
    await rm(testPaths.root, { recursive: true, force: true });
  });

  /** Runs `body` with a service that is always closed afterwards. */
  async function withService(
    body: (snapshots: ReturnType<typeof createSnapshotService>) => Promise<void>,
  ): Promise<void> {
    const source = createDashboardReadSource({
      client: {
        config: {
          providers: async () => ({ data: { providers: [{ id: "openai" }] } }),
          get: async () => ({ data: {} }),
        },
      },
      workspaceRoot: "C:/synthetic-workspace",
      configDir: "C:/synthetic-config",
      timeZone: "UTC",
      now: () => Date.now(),
      loadConfig: async () => ({
        ...DEFAULT_CONFIG,
        enabledProviders: ["openai"],
        requestTimeoutMs: TIMEOUT_MS,
      }),
      // Registry providers carry the production cache policy (identity scope).
      providers: getProviders().filter((provider) => provider.id === "openai"),
    });
    const snapshots = createSnapshotService({ source, quotaIntervalMs: 60_000 });
    snapshots.subscribe((event) => {
      if (event.topic === "quota.changed") quotaChanges += 1;
    });
    try {
      await body(snapshots);
    } finally {
      snapshots.close();
    }
  }

  const percent = (snapshot: QuotaSnapshot) =>
    snapshot.providers.cards
      .find((card) => card.providerId === "openai")
      ?.rows.find((row) => row.kind === "percent")?.percentRemaining;
  const errors = (snapshot: QuotaSnapshot) =>
    snapshot.providers.cards.flatMap((card) => card.errors);
  const TIMEOUT_MESSAGE = "Request timeout after 1s";

  async function loadFirst(snapshots: ReturnType<typeof createSnapshotService>): Promise<void> {
    const first = snapshots.quota();
    await advance(0, 1);
    expect(percent(await first)).toBe(90);
  }

  it("keeps the same login's last result through a timeout, then recovers on the early retry", async () => {
    steps = ["success-90", "stall", "success-70"];
    await withService(async (snapshots) => {
      await loadFirst(snapshots);
      const release = snapshots.addViewer();
      try {
        // Regular 60s poll: the request stalls and is aborted at the bounded timeout.
        await advance(60_000, 2);
        expect(usageCalls).toBe(2);
        await advance(TIMEOUT_MS);
        await untilChanges(1);
        const timedOut = await snapshots.quota();
        expect(timedOut.stale).toBe(true);
        expect(percent(timedOut)).toBe(90);
        expect(errors(timedOut).map((error) => error.message)).toEqual([TIMEOUT_MESSAGE]);

        // The early retry is 10s after the failed tick, not another 60s.
        await advance(9_999);
        expect(usageCalls).toBe(2);
        await advance(1, 3);
        await untilChanges(2);
        const recovered = await snapshots.quota();
        expect(recovered.stale).toBe(false);
        expect(percent(recovered)).toBe(70);

        // Recovery arms nothing early; no further upstream request before the next poll.
        await advance(48_000);
        expect(usageCalls).toBe(3);
      } finally {
        release();
      }
    });
  });

  it("does not show a previous login's result when a normal poll for another login times out", async () => {
    steps = ["success-90", "stall"];
    await withService(async (snapshots) => {
      await loadFirst(snapshots);
      const release = snapshots.addViewer();
      try {
        account = { id: "openai-timeout-b", access: "d.e.f" };
        // No forced refresh: the regular poll and a plain read see the new login.
        await advance(60_000, 2);
        await advance(TIMEOUT_MS);
        await untilChanges(1);
        const snapshot = await snapshots.quota();
        expect(usageCalls).toBe(2);
        expect(percent(snapshot)).toBeUndefined();
        expect(errors(snapshot).map((error) => error.message)).toEqual([TIMEOUT_MESSAGE]);
      } finally {
        release();
      }
    });
  });

  it("does not show a previous login's result when a manual refresh for another login times out", async () => {
    steps = ["success-90", "stall"];
    await withService(async (snapshots) => {
      await loadFirst(snapshots);
      account = { id: "openai-timeout-b", access: "d.e.f" };
      const next = snapshots.quota({ refresh: true });
      await advance(0, 2);
      await advance(TIMEOUT_MS);
      const snapshot = await next;
      expect(usageCalls).toBe(2);
      expect(percent(snapshot)).toBeUndefined();
      expect(errors(snapshot).map((error) => error.message)).toEqual([TIMEOUT_MESSAGE]);
    });
  });

  it("retains nothing when no identity scope exists (models Windows' fail-closed null)", async () => {
    identity.available = false;
    steps = ["success-90", "stall"];
    await withService(async (snapshots) => {
      await loadFirst(snapshots);
      const next = snapshots.quota({ refresh: true });
      await advance(0, 2);
      await advance(TIMEOUT_MS);
      const snapshot = await next;
      expect(usageCalls).toBe(2);
      expect(percent(snapshot)).toBeUndefined();
      expect(errors(snapshot).map((error) => error.message)).toEqual([TIMEOUT_MESSAGE]);
    });
  });

  it("runs a manual refresh after the in-flight poll so the newest result wins", async () => {
    steps = ["success-90", "hold-40", "success-70"];
    await withService(async (snapshots) => {
      await loadFirst(snapshots);
      const release = snapshots.addViewer();
      try {
        await advance(60_000, 2); // the poll's request is held open
        const manual = snapshots.quota({ refresh: true });
        await advance(0);
        expect(usageCalls).toBe(2);

        releaseHeld(); // older poll answers 40% remaining, then the refresh asks again
        expect(percent(await manual)).toBe(70);
        expect(usageCalls).toBe(3);
        // Request 3 started only after the held request was answered: no overlap.
        expect(releasedAtRequest).toEqual([false, false, true]);
        expect(percent(await snapshots.quota())).toBe(70);
      } finally {
        release();
      }
    });
  });
});
