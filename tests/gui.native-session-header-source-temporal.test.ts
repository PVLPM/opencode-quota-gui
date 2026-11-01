import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  DashboardEvent,
  DashboardHealth,
  ProviderCard,
  QuotaCardRow,
  QuotaSnapshot,
} from "../src/contracts/dashboard.js";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard.js";
import type { CardId, RowId } from "../src/contracts/identity.js";
import type {
  TemporalModelStatus,
  TemporalProviderStatus,
  TemporalStatusSnapshot,
} from "../src/contracts/temporal.js";
import type {
  SessionHeaderClient,
  SessionHeaderSource,
} from "../src/native/session-header-source.js";
import { settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";
import { createIsolatedViteServer } from "./helpers/vite-test-harness.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOW = Date.parse("2026-11-01T11:59:00.000Z");
const MINUTE_MS = 60_000;

type CreateRoot = (callback: (dispose: () => void) => void) => () => void;
let server: ViteDevServer | undefined;
let createRoot: CreateRoot;
let createSessionHeaderSource: (options: {
  client: SessionHeaderClient;
  active: () => boolean;
  now?: () => number;
}) => SessionHeaderSource;

beforeAll(async () => {
  const created = await createIsolatedViteServer({
    configFile: false,
    root: repoRoot,
    resolve: {
      alias: [
        {
          find: /^solid-js$/,
          replacement: path.join(repoRoot, "node_modules/solid-js/dist/solid.js"),
        },
      ],
    },
    ssr: { noExternal: ["solid-js"] },
    logLevel: "silent",
    server: { middlewareMode: true },
    appType: "custom",
  });
  server = created;
  const core = (await created.ssrLoadModule("solid-js")) as { createRoot: CreateRoot };
  createRoot = core.createRoot;
  const sourceModule = (await created.ssrLoadModule(
    path.join(repoRoot, "src/native/session-header-source.ts"),
  )) as { createSessionHeaderSource: typeof createSessionHeaderSource };
  createSessionHeaderSource = sourceModule.createSessionHeaderSource;
}, 60_000);

afterAll(async () => {
  await server?.close();
});

function makeTemporalModel(startMs: number, endMs: number): TemporalModelStatus {
  return {
    modelId: "synthetic/model",
    state: "offpeak",
    intervals: [
      { startMs: NOW - MINUTE_MS, endMs: startMs, phase: "offpeak" },
      { startMs, endMs, phase: "peak" },
      { startMs: endMs, endMs: endMs + MINUTE_MS, phase: "offpeak" },
    ],
    nextChangeAtMs: startMs,
    nextState: "peak",
    weekly: {
      timeZone: "UTC",
      utcOffsetMinutes: 0,
      basePhase: "offpeak",
      windows: [{ days: ["sun"], startMinute: 13 * 60, endMinute: 14 * 60, phase: "peak" }],
    },
  };
}

function quotaSnapshot(startMs = Date.parse("2026-11-01T13:00:00.000Z")): QuotaSnapshot {
  const endMs = startMs + 60 * MINUTE_MS;
  const row: QuotaCardRow = {
    rowId: "card-1#five" as RowId,
    label: "5h",
    kind: "percent",
    resultType: "quota",
    percentUsed: 38,
    percentRemaining: 62,
  };
  const card: ProviderCard = {
    cardId: "card-1" as CardId,
    providerId: "synthetic",
    providerLabel: "Synthetic",
    rows: [row],
    errors: [],
  };
  const provider: TemporalProviderStatus = {
    providerId: "synthetic",
    providerLabel: "Synthetic",
    discovered: true,
    phase: "offpeak",
    models: [makeTemporalModel(startMs, endMs)],
    holidays: [],
  };
  const temporal: TemporalStatusSnapshot = {
    generatedAtMs: NOW,
    providers: [provider],
    snapshot: { revision: "test", generatedAtMs: NOW },
  };
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: { cards: [card], enabledProviders: "auto", polledAtMs: NOW },
    temporal,
  };
}

interface FakeClient {
  client: SessionHeaderClient;
  counts: { quota: number };
  emit(event: DashboardEvent): void;
  setQuota(read: () => Promise<QuotaSnapshot>): void;
}

function fakeClient(): FakeClient {
  const counts = { quota: 0 };
  const listeners = new Set<(event: DashboardEvent) => void>();
  let quotaRead = async () => quotaSnapshot();
  const client: SessionHeaderClient = {
    settings: async () => settingsSnapshot(),
    async quota() {
      counts.quota += 1;
      return quotaRead();
    },
    async health(): Promise<DashboardHealth> {
      return {
        app: "opencode-quota-gui",
        contractVersion: DASHBOARD_CONTRACT_VERSION,
        version: "1.2.0",
        build: "native-test",
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onConnectionChange: () => () => undefined,
    onReconnect: () => () => undefined,
    connection: () => "live",
    reconnect: async () => undefined,
  };
  return {
    client,
    counts,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    setQuota: (read) => {
      quotaRead = read;
    },
  };
}

const mounted: Array<() => void> = [];

async function mount(
  client: SessionHeaderClient,
  now: () => number = Date.now,
): Promise<SessionHeaderSource> {
  let source!: SessionHeaderSource;
  await new Promise<void>((resolve) => {
    createRoot((dispose) => {
      mounted.push(dispose);
      source = createSessionHeaderSource({ client, active: () => true, now });
      resolve();
    });
  });
  await vi.advanceTimersByTimeAsync(0);
  return source;
}

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native session header local Peak timer", () => {
  it("advances Peak at T-60, start and end without another quota read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fake = fakeClient();
    const source = await mount(fake.client);
    const startMs = Date.parse("2026-11-01T13:00:00.000Z");

    expect(source.view().cards[0]?.peak).toBeUndefined();
    expect(source.view().nextPeakUpdateAtMs).toBe(startMs - 60 * MINUTE_MS);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(source.view().nowMs).toBe(startMs - 60 * MINUTE_MS);
    expect(source.view().cards[0]?.peak).toBe("soon");

    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(source.view().nowMs).toBe(startMs);
    expect(source.view().cards[0]?.peak).toBe("now");

    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(source.view().nowMs).toBe(startMs + 60 * MINUTE_MS);
    expect(source.view().cards[0]?.peak).toBeUndefined();
    expect(fake.counts.quota).toBe(1);
  });

  it("replaces a timer when quota data changes and clears it on owner disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fake = fakeClient();
    const source = await mount(fake.client);
    const dispose = mounted.pop();
    const movedStartMs = Date.parse("2026-11-01T14:00:00.000Z");

    await vi.advanceTimersByTimeAsync(10_000);
    fake.setQuota(async () => quotaSnapshot(movedStartMs));
    fake.emit({ topic: "quota.changed", at: Date.now() });
    await vi.advanceTimersByTimeAsync(0);

    expect(fake.counts.quota).toBe(2);
    expect(source.view().nextPeakUpdateAtMs).toBe(movedStartMs - 60 * MINUTE_MS);
    const dataRefreshAtMs = Date.now();
    await vi.advanceTimersByTimeAsync(50_000);
    expect(source.view().nowMs).toBe(dataRefreshAtMs);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(source.view().nowMs).toBe(movedStartMs - 60 * MINUTE_MS);
    expect(source.view().cards[0]?.peak).toBe("soon");

    dispose?.();
    const disposedAtMs = source.view().nowMs;
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(source.view().nowMs).toBe(disposedAtMs);
    expect(fake.counts.quota).toBe(2);
  });

  it("refreshes local time on source changes and reschedules after a wall-clock rollback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fake = fakeClient();
    const source = await mount(fake.client);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(source.view().nowMs).toBe(NOW + MINUTE_MS);

    vi.setSystemTime(NOW + 20 * MINUTE_MS);
    fake.emit({ topic: "quota.changed", at: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(source.view().nowMs).toBe(NOW + 20 * MINUTE_MS);

    vi.setSystemTime(NOW);
    fake.emit({ topic: "quota.changed", at: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(source.view().nowMs).toBe(NOW);
    expect(source.view().nextPeakUpdateAtMs).toBe(NOW + MINUTE_MS);
    expect(fake.counts.quota).toBe(3);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(source.view().nowMs).toBe(NOW + MINUTE_MS);
    expect(source.view().cards[0]?.peak).toBe("soon");
    expect(fake.counts.quota).toBe(3);
  });

  it("refreshes and reschedules after a suspended host becomes visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget() as EventTarget & { visibilityState: string };
    Object.defineProperty(documentTarget, "visibilityState", {
      configurable: true,
      value: "hidden",
      writable: true,
    });
    vi.stubGlobal("window", windowTarget);
    vi.stubGlobal("document", documentTarget);

    const fake = fakeClient();
    const source = await mount(fake.client);
    const startMs = Date.parse("2026-11-01T13:00:00.000Z");

    vi.setSystemTime(startMs + 30 * MINUTE_MS);
    windowTarget.dispatchEvent(new Event("focus"));
    expect(source.view().nowMs).toBe(NOW);
    expect(source.view().cards[0]?.peak).toBeUndefined();

    documentTarget.visibilityState = "visible";
    documentTarget.dispatchEvent(new Event("visibilitychange"));
    expect(source.view().nowMs).toBe(startMs + 30 * MINUTE_MS);
    expect(source.view().cards[0]?.peak).toBe("now");
    expect(source.view().nextPeakUpdateAtMs).toBe(startMs + 60 * MINUTE_MS);

    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(source.view().nowMs).toBe(startMs + 60 * MINUTE_MS);
    expect(source.view().cards[0]?.peak).toBeUndefined();
    expect(fake.counts.quota).toBe(1);
  });
});
