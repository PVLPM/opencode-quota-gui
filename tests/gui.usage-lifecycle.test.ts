/**
 * Delegating-source forwarding and owner-handoff usage epoch (v1.4.0 D11/D2).
 * A Usage read must reach the active owner without starting provider polling,
 * and a capture queued under the previous owner must never be recorded.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
} from "../src/contracts/dashboard.js";
import type { RowId } from "../src/contracts/identity.js";
import type { UsageSnapshot } from "../src/contracts/usage.js";
import {
  type DashboardLease,
  type DashboardReadSource,
  notifyRuntimeSourceChanged,
  startDashboard,
} from "../src/gui/lifecycle.js";
import { createGuiLogger } from "../src/gui/log.js";
import {
  markQuotaObservationCycle,
  markQuotaObservationLive,
} from "../src/gui/quota-observation.js";
import type { SnapshotService } from "../src/gui/snapshot-service.js";
import { createUsageRecorder } from "../src/gui/usage-recorder.js";
import { openUsageStore, type UsageStore } from "../src/lib/usage-store.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

const BASE = Date.parse("2026-06-01T00:00:00.000Z");
const MINUTE = 60_000;
const silent = createGuiLogger({ sink: () => {} });

const leases: DashboardLease[] = [];
const workspaces: GuiConfigWorkspace[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) await lease.dispose();
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fakeSource() {
  const calls = { usage: 0, activity: 0, quota: 0 };
  const source: DashboardReadSource = {
    home: async () => ({}) as HomeSnapshot,
    project: async () => ({}) as ProjectSnapshot,
    session: async () => ({}) as SessionSnapshot,
    groups: async (query) => ({ dimension: query.dimension }) as never,
    quota: async () => {
      calls.quota += 1;
      return {} as QuotaSnapshot;
    },
    activity: async (query) => {
      calls.activity += 1;
      return { intervals: query.intervals.map((interval) => ({ ...interval, entries: [] })) };
    },
    usage: async () => {
      calls.usage += 1;
      return {} as UsageSnapshot;
    },
  };
  return { source, calls };
}

function fakeSnapshots() {
  const sourceChanged = vi.fn();
  const service = {
    subscribe: () => () => {},
    addViewer: () => () => {},
    addScopedViewer: () => ({ release: () => {} }),
    notifySettingsChanged: () => {},
    setViewScope: () => {},
    sourceChanged,
    close: () => {},
  } as unknown as SnapshotService;
  return { service, sourceChanged };
}

function liveSnapshot(): QuotaSnapshot {
  const value: QuotaSnapshot = {
    generatedAtMs: BASE,
    stale: false,
    timeZone: "UTC",
    providers: {
      cards: [
        {
          cardId: "anthropic:aaaaaa" as never,
          providerId: "anthropic",
          providerLabel: "Anthropic",
          labelSource: "provider",
          rows: [
            {
              rowId: "anthropic:aaaaaa#window:five_hour|quota:percent" as RowId,
              label: "5h",
              kind: "percent",
              resultType: "quota",
              percentRemaining: 80,
              metric: { kind: "window", window: "five_hour" },
            },
          ],
          errors: [],
        },
      ],
      enabledProviders: "auto",
      polledAtMs: BASE,
    },
  };
  markQuotaObservationCycle(value, {
    measuredAtByCard: new Map([["anthropic:aaaaaa", BASE]]),
    intervalMs: MINUTE,
    providerIds: ["anthropic"],
  });
  return markQuotaObservationLive(value);
}

describe("usage lifecycle wiring", () => {
  it("exposes usage and activity on the delegating source without polling providers", async () => {
    const workspace = createGuiConfigWorkspace("ocq-usage-lifecycle-");
    workspaces.push(workspace);
    writeGuiCanonicalConfig(workspace, { dashboard: { port: 0 } });
    const fixture = fakeSource();
    const snapshots = fakeSnapshots();
    let captured: DashboardReadSource | undefined;

    const lease = await startDashboard({
      client: {} as never,
      workspaceRoot: workspace.workspaceRoot,
      configDir: workspace.configDir,
      detectHostVersion: async () => undefined,
      quotaNotificationStatePath: join(workspace.tempDir, "notifications.json"),
      usageStorePath: join(workspace.tempDir, "usage-history.sqlite"),
      createSource: () => fixture.source,
      createSnapshots: (options) => {
        captured = options.source as DashboardReadSource;
        return snapshots.service;
      },
      logger: silent,
    });
    leases.push(lease);

    expect(captured?.usage).toBeTypeOf("function");
    expect(captured?.activity).toBeTypeOf("function");
    const before = fixture.calls.quota;
    await captured?.usage?.({ range: "24h" });
    expect(fixture.calls.usage).toBe(1);
    expect(fixture.calls.quota).toBe(before);
    await captured?.activity({ intervals: [], providerIds: [] });
    expect(fixture.calls.activity).toBe(1);
  });

  it("bumps the usage recorder epoch on an owner handoff", () => {
    const snapshots = { sourceChanged: vi.fn() };
    const quotaNotifications = { sourceChanged: vi.fn() };
    const usage = { sourceChanged: vi.fn() };
    notifyRuntimeSourceChanged({ snapshots, quotaNotifications, usage });
    expect(snapshots.sourceChanged).toHaveBeenCalledTimes(1);
    expect(quotaNotifications.sourceChanged).toHaveBeenCalledTimes(1);
    expect(usage.sourceChanged).toHaveBeenCalledTimes(1);
  });

  it("drops a capture queued before the source changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocq-usage-epoch-"));
    roots.push(root);
    const db: UsageStore = await openUsageStore(join(root, "usage-history.sqlite"));
    try {
      const recorder = createUsageRecorder({ store: db, now: () => BASE });
      recorder.observe(liveSnapshot(), recorder.epoch());
      recorder.sourceChanged();
      await recorder.flush();
      expect(db.query({ startMs: 0, endMs: BASE + MINUTE }).runs).toHaveLength(0);

      recorder.observe(liveSnapshot(), recorder.epoch());
      await recorder.flush();
      expect(db.query({ startMs: 0, endMs: BASE + MINUTE }).runs).toHaveLength(1);
      await recorder.close();
    } finally {
      db.close();
    }
  });
});
