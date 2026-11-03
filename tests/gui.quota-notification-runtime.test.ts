/**
 * Host-runtime quota notification integration.
 *
 * The committed host monitor owns the one quota viewer and poller. The
 * notification observer is fed by the delegating source's quota cycle, so a
 * closed panel, slot and settings page still produce one observation per fresh
 * source cycle without a second poller. Delivery stays live-only over the
 * separate dashboard event.
 */
import { createServer as createNetServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AnalyticsGroupSnapshot,
  GuiSettingsStore,
  HomeSnapshot,
  ProjectSnapshot,
  QuotaSnapshot,
  SessionSnapshot,
  SettingsSnapshot,
} from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import { type StartDashboardOptions, startDashboard } from "../src/gui/lifecycle.js";
import { createGuiLogger } from "../src/gui/log.js";
import { registerDashboardRpc } from "../src/gui/rpc.js";
import type {
  SnapshotService,
  SnapshotServiceOptions,
  SnapshotSource,
} from "../src/gui/snapshot-service.js";
import {
  createGuiConfigWorkspace,
  type GuiConfigWorkspace,
  writeGuiCanonicalConfig,
} from "./helpers/config-loader-test-harness.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const RESET_AT = "2026-11-02T17:00:00.000Z";
const silent = createGuiLogger({ sink: () => {} });

const workspaces: GuiConfigWorkspace[] = [];
const leases: Array<Awaited<ReturnType<typeof startDashboard>>> = [];

afterEach(async () => {
  for (const lease of leases.splice(0)) {
    await lease.dispose().catch(() => undefined);
  }
  for (const workspace of workspaces.splice(0)) workspace.cleanup();
});

async function freePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function makeWorkspace(): GuiConfigWorkspace {
  const workspace = createGuiConfigWorkspace("ocq-quota-notification-runtime-");
  workspaces.push(workspace);
  return workspace;
}

function quotaSnapshot(percentRemaining: number): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: {
      cards: [
        {
          cardId: `openai:${"a".repeat(64)}` as CardId,
          providerId: "openai",
          providerLabel: "OpenAI",
          accountLabel: "work",
          labelSource: "account",
          rows: [
            {
              rowId: "row-1" as RowId,
              label: "5-hour window",
              kind: "percent",
              resultType: "quota",
              percentRemaining,
              resetAtIso: RESET_AT,
            },
          ],
          errors: [],
        },
      ],
      enabledProviders: "auto",
      polledAtMs: NOW,
    },
  };
}

function buildSource(percentages: readonly number[], gateFirst = false) {
  const calls = { home: 0, project: 0, session: 0, groups: 0, quota: 0 };
  let releaseFirst: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const source: SnapshotSource = {
    home: async () => {
      calls.home += 1;
      return { marker: "home" } as unknown as HomeSnapshot;
    },
    project: async () => {
      calls.project += 1;
      return { marker: "project" } as unknown as ProjectSnapshot;
    },
    session: async () => {
      calls.session += 1;
      return { marker: "session" } as unknown as SessionSnapshot;
    },
    groups: async () => {
      calls.groups += 1;
      return { marker: "groups" } as unknown as AnalyticsGroupSnapshot;
    },
    quota: async () => {
      const index = Math.min(calls.quota, percentages.length - 1);
      calls.quota += 1;
      if (gateFirst && index === 0) {
        markStarted?.();
        await firstGate;
      }
      return quotaSnapshot(percentages[index] ?? 0);
    },
  };
  return { source, calls, firstStarted, releaseFirst: () => releaseFirst?.() };
}

function optionsFor(
  workspace: GuiConfigWorkspace,
  source: SnapshotSource,
  statePath: string,
  overrides: Partial<StartDashboardOptions> = {},
): StartDashboardOptions {
  return {
    client: {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({ data: { providers: [] } }),
      },
    },
    workspaceRoot: workspace.workspaceRoot,
    configDir: workspace.configDir,
    createSource: () => source,
    quotaNotificationStatePath: statePath,
    logger: silent,
    ...overrides,
  };
}

async function open(options: StartDashboardOptions) {
  const lease = await startDashboard({
    // These fixtures exercise the runtime while Web is off; never spawn the
    // real `opencode --version` probe.
    detectHostVersion: async () => undefined,
    ...options,
  });
  leases.push(lease);
  return lease;
}

async function flush(lease: Awaited<ReturnType<typeof startDashboard>>): Promise<void> {
  await lease.runtime?.quotaNotifications?.flush();
}

function subscribe(lease: Awaited<ReturnType<typeof startDashboard>>) {
  const events: unknown[] = [];
  lease.runtime?.quotaNotifications?.subscribe((event) => events.push(event));
  return events;
}

/** Attaches the real RPC forwarding to the lease runtime, as `plugin.ts` does. */
async function attachRpc(lease: Awaited<ReturnType<typeof startDashboard>>) {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const registration = {
    events: {
      emit: async (name: string, data: unknown) => {
        emitted.push({ name, data });
      },
    },
    dispose: async () => undefined,
  };
  const register = async (_definition: unknown, _handlers: unknown) => registration;
  if (!lease.runtime) throw new Error("expected runtime");
  const attached = await registerDashboardRpc(
    { register } as unknown as Parameters<typeof registerDashboardRpc>[0],
    lease.runtime,
  );
  return { emitted, attached };
}

describe("host quota notification runtime", () => {
  it("observes the shared poller with no panel open and emits exactly once", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port }, minIntervalMs: 25 });
    const fixture = buildSource([50, 5, 5], true);
    const lease = await open(
      optionsFor(workspace, fixture.source, `${workspace.tempDir}/quota-notifications.json`),
    );
    const events = subscribe(lease);
    const forwarded = await attachRpc(lease);
    fixture.releaseFirst();

    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 2000, interval: 5 });
    expect(events[0]).toMatchObject({ kind: "low", title: "OpenAI quota low" });
    await vi.waitFor(
      () =>
        expect(
          forwarded.emitted.filter((entry) => entry.name === "quotaNotification"),
        ).toHaveLength(1),
      { timeout: 2000, interval: 5 },
    );
    expect(forwarded.emitted.find((entry) => entry.name === "quotaNotification")).toEqual({
      name: "quotaNotification",
      data: events[0],
    });
    await vi.waitFor(() => expect(fixture.calls.quota).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
      interval: 5,
    });
    await flush(lease);
    expect(events).toHaveLength(1);
    expect(fixture.calls.home).toBe(0);
    expect(fixture.calls.project).toBe(0);
    expect(fixture.calls.session).toBe(0);
    expect(fixture.calls.groups).toBe(0);
  });

  it("drops a deferred snapshot captured before a source handoff", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port } });
    const fixture = buildSource([5, 50, 5], true);
    const createSnapshots = (options: SnapshotServiceOptions): SnapshotService =>
      ({
        addScopedViewer: () => ({ release: () => undefined }),
        quota: async () => {
          if (!options.source.quota) throw new Error("Quota source unavailable");
          return options.source.quota();
        },
        subscribe: () => () => undefined,
        notifySettingsChanged: () => undefined,
        sourceChanged: () => undefined,
        close: () => undefined,
      }) as unknown as SnapshotService;

    const lease = await open(
      optionsFor(workspace, fixture.source, `${workspace.tempDir}/deferred-source.json`, {
        createSnapshots,
      }),
    );
    const events = subscribe(lease);

    // The first source cycle captured its epoch and is still waiting on the
    // provider read when the host hands the source off.
    await fixture.firstStarted;
    lease.runtime?.quotaNotifications?.sourceChanged();

    // The replacement generation establishes a high baseline first.
    await lease.runtime?.snapshots.quota();
    expect(fixture.calls.quota).toBe(2);
    await flush(lease);
    expect(events).toEqual([]);

    // The old low snapshot now settles. It must be discarded, not classified
    // against the replacement baseline as a false low transition.
    fixture.releaseFirst();
    // Let the deferred source continuation enqueue its observation before
    // flushing the observer chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flush(lease);
    expect(fixture.calls.quota).toBe(2);
    expect(events).toEqual([]);

    // The new generation still classifies its own later transition.
    await lease.runtime?.snapshots.quota();
    await flush(lease);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "low" });
  });

  it("stays silent on initialization and on a reload", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port }, minIntervalMs: 25 });
    const statePath = `${workspace.tempDir}/reload-notifications.json`;

    const firstFixture = buildSource([5, 5, 5]);
    const first = await open(optionsFor(workspace, firstFixture.source, statePath));
    const firstEvents = subscribe(first);
    await vi.waitFor(() => expect(firstFixture.calls.quota).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
      interval: 5,
    });
    await flush(first);
    expect(firstEvents).toEqual([]);
    await first.dispose();
    leases.splice(leases.indexOf(first), 1);

    const secondFixture = buildSource([5, 5, 5]);
    const second = await open(optionsFor(workspace, secondFixture.source, statePath));
    const secondEvents = subscribe(second);
    await vi.waitFor(() => expect(secondFixture.calls.quota).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
      interval: 5,
    });
    await flush(second);
    expect(secondEvents).toEqual([]);
  });

  it("uses canonical threshold, display mode and hidden-row settings", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, {
      dashboard: { port },
      minIntervalMs: 25,
      lowQuotaThresholdRemainingPercent: 20,
      percentDisplayMode: "used",
    });
    const fixture = buildSource([50, 15, 15], true);
    const lease = await open(
      optionsFor(workspace, fixture.source, `${workspace.tempDir}/threshold-notifications.json`),
    );
    const events = subscribe(lease);
    fixture.releaseFirst();
    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 2000, interval: 5 });
    expect((events[0] as { description?: string }).description).toContain("85% used");

    const hiddenWorkspace = makeWorkspace();
    const hiddenPort = await freePort();
    writeGuiCanonicalConfig(hiddenWorkspace, {
      dashboard: { port: hiddenPort, hiddenRows: ["row-1"] },
      minIntervalMs: 25,
    });
    const hiddenFixture = buildSource([50, 5, 5], true);
    const hiddenLease = await open(
      optionsFor(
        hiddenWorkspace,
        hiddenFixture.source,
        `${hiddenWorkspace.tempDir}/hidden-notifications.json`,
      ),
    );
    const hiddenEvents = subscribe(hiddenLease);
    hiddenFixture.releaseFirst();
    await vi.waitFor(() => expect(hiddenFixture.calls.quota).toBeGreaterThanOrEqual(3), {
      timeout: 2000,
      interval: 5,
    });
    await flush(hiddenLease);
    expect(hiddenEvents).toEqual([]);
  });

  it("shares one observer for every lease on the same host", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port }, minIntervalMs: 10000 });
    const fixture = buildSource([50]);
    const statePath = `${workspace.tempDir}/shared-notifications.json`;
    const first = await open(optionsFor(workspace, fixture.source, statePath));
    const second = await open(optionsFor(workspace, fixture.source, statePath));

    expect(first.runtime?.quotaNotifications).toBeDefined();
    expect(second.runtime?.quotaNotifications).toBe(first.runtime?.quotaNotifications);
  });

  it("does not start a second quota poll for notifications", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port }, minIntervalMs: 10000 });
    const fixture = buildSource([50]);
    const lease = await open(
      optionsFor(workspace, fixture.source, `${workspace.tempDir}/no-second-poller.json`),
    );

    await vi.waitFor(() => expect(fixture.calls.quota).toBe(1), { timeout: 2000, interval: 5 });
    subscribe(lease);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(fixture.calls.quota).toBe(1);
  });

  it("fails closed on a settings read failure and re-baselines after recovery", async () => {
    const workspace = makeWorkspace();
    const port = await freePort();
    writeGuiCanonicalConfig(workspace, { dashboard: { port }, minIntervalMs: 25 });
    const snapshotSettings = {
      values: {
        lowQuotaThresholdRemainingPercent: 10,
        duplicateCooldownMinutes: 30,
        percentDisplayMode: "remaining",
      },
      visibility: { hiddenCards: [], hiddenRows: [] },
    } as unknown as SettingsSnapshot;
    let reads = 0;
    const settings = {
      settings: vi.fn(async () => {
        reads += 1;
        if (reads === 1) throw new Error("config unavailable");
        return snapshotSettings;
      }),
    } as unknown as GuiSettingsStore;

    const fixture = buildSource([5, 5, 50, 5]);
    const lease = await open(
      optionsFor(workspace, fixture.source, `${workspace.tempDir}/failed-settings.json`, {
        createSettingsStore: () => settings,
      }),
    );
    const events = subscribe(lease);

    await vi.waitFor(() => expect(events).toHaveLength(1), { timeout: 3000, interval: 5 });
    expect(events[0]).toMatchObject({ kind: "low" });
    expect(reads).toBeGreaterThanOrEqual(4);
    await flush(lease);
    expect(events).toHaveLength(1);
  });
});
