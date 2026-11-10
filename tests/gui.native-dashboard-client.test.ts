import { describe, expect, it, vi } from "vitest";

import type { DashboardEvent } from "../src/contracts/dashboard.js";
import {
  createNativeDashboardClient,
  type DashboardRpcCaller,
} from "../src/native/dashboard-client.js";

type EventItem = { kind: "event"; value: { data: unknown } } | { kind: "error"; error: unknown };

function createEventStream(signal: AbortSignal) {
  const items: EventItem[] = [];
  let wake: (() => void) | undefined;
  let ended = false;

  function push(item: EventItem): void {
    if (ended) return;
    items.push(item);
    wake?.();
    wake = undefined;
  }

  function finish(): void {
    if (ended) return;
    ended = true;
    wake?.();
    wake = undefined;
  }

  signal.addEventListener("abort", finish, { once: true });

  return {
    signal,
    stream: {
      async *[Symbol.asyncIterator]() {
        while (!ended) {
          if (items.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          const item = items.shift();
          if (!item) return;
          if (item.kind === "error") throw item.error;
          yield item.value;
        }
      },
    },
    pushEvent: (data: unknown) => push({ kind: "event", value: { data } }),
    fail: (error: unknown) => push({ kind: "error", error }),
    finish,
  };
}

interface ActiveWatch {
  scope: string;
  signal: AbortSignal;
  resolve: (value: { active: boolean }) => void;
  reject: (error: unknown) => void;
}

function createFakeCaller() {
  const activeWatches: ActiveWatch[] = [];
  const streams: Array<ReturnType<typeof createEventStream>> = [];
  let pendingWatches = 0;
  let maxPendingWatches = 0;
  const caller = {
    health: vi.fn(async (_input?: Record<string, never>, _options?: { signal?: AbortSignal }) => ({
      app: "opencode-quota-gui",
      contractVersion: 2,
    })),
    quota: vi.fn(async () => ({ marker: "quota" })),
    home: vi.fn(async () => ({ marker: "home" })),
    groups: vi.fn(async () => ({ marker: "groups" })),
    project: vi.fn(async () => ({ marker: "project" })),
    session: vi.fn(async () => ({ marker: "session" })),
    settings: vi.fn(async () => ({ marker: "settings" })),
    saveSettings: vi.fn(async () => ({ marker: "saveSettings" })),
    saveVisibility: vi.fn(async () => ({ marker: "saveVisibility" })),
    importPreview: vi.fn(async () => ({ marker: "importPreview" })),
    importApply: vi.fn(async () => ({ marker: "importApply" })),
    openSettingsFile: vi.fn(async () => ({ opened: true as const })),
    watch: vi.fn(
      (input: { scope: string }, options?: { signal?: AbortSignal }) =>
        new Promise<{ active: boolean }>((resolve, reject) => {
          const signal = options?.signal ?? new AbortController().signal;
          pendingWatches += 1;
          maxPendingWatches = Math.max(maxPendingWatches, pendingWatches);
          let settled = false;
          const settle = (finish: () => void) => {
            if (settled) return;
            settled = true;
            pendingWatches -= 1;
            finish();
          };
          activeWatches.push({
            scope: input.scope,
            signal,
            resolve: (value) => settle(() => resolve(value)),
            reject: (error) => settle(() => reject(error)),
          });
          signal.addEventListener("abort", () => settle(() => resolve({ active: false })), {
            once: true,
          });
        }),
    ),
    events: {
      subscribe: vi.fn((_name: "invalidated", options?: { signal?: AbortSignal }) => {
        const stream = createEventStream(options?.signal ?? new AbortController().signal);
        streams.push(stream);
        return stream.stream;
      }),
    },
  };
  return {
    caller: caller as unknown as DashboardRpcCaller,
    raw: caller,
    activeWatches,
    streams,
    watchActivity: () => ({ active: pendingWatches, max: maxPendingWatches }),
  };
}

function hostWatchTimeout(): Error {
  return Object.assign(new Error("The watch request timed out"), {
    name: "ClientError",
    reason: "Transport",
    cause: new DOMException("The operation timed out", "TimeoutError"),
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(check()).toBe(true);
    },
    { timeout: 1000, interval: 5 },
  );
  if (!check()) throw new Error(`timed out waiting for ${label}`);
}

describe("native dashboard RPC client", () => {
  it("connects on the first subscriber, reacquires the viewer and validates live events", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller, scope: "quota" });
    const seen: DashboardEvent[] = [];

    expect(client.connection()).toBe("connecting");
    const unsubscribe = client.subscribe((event) => seen.push(event));
    await waitFor(() => client.connection() === "live", "live connection");

    expect(fake.raw.health).toHaveBeenCalledOnce();
    expect(fake.raw.watch).toHaveBeenCalledWith(
      { scope: "quota" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();

    fake.streams[0]?.pushEvent({ topic: "quota.changed", at: 1 });
    fake.streams[0]?.pushEvent({ topic: "not-a-topic", at: 2 });
    await waitFor(() => seen.length === 1, "one valid event");
    expect(seen).toEqual([{ topic: "quota.changed", at: 1 }]);

    unsubscribe();
    expect(client.connection()).toBe("reconnecting");
    await waitFor(() => fake.activeWatches.every((watch) => watch.signal.aborted), "watch abort");
    client.dispose();
    expect(client.connection()).toBe("closed");
  });

  it("delivers isolated cache observations through the existing Native event stream", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller, scope: "quota" });
    const observed: unknown[] = [];
    const dashboardEvents: DashboardEvent[] = [];

    const releaseCache = client.subscribeCacheObserverEvent((event) => observed.push(event));
    expect(fake.raw.health).not.toHaveBeenCalled();
    expect(fake.raw.events.subscribe).not.toHaveBeenCalled();

    const releaseDashboard = client.subscribe((event) => dashboardEvents.push(event));
    await waitFor(() => client.connection() === "live", "live connection");
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();

    fake.streams[0]?.pushEvent({
      topic: "cache.observer",
      at: 1_700_000_000_000,
      cacheObserverEvent: {
        type: "session.step.ended",
        created: 1_700_000_000_000,
        data: {
          sessionID: "ses-1",
          assistantMessageID: "msg-1",
          tokens: { cache: { read: 8 } },
        },
      },
    });
    await waitFor(() => observed.length === 1, "cache observation");

    expect(observed[0]).toEqual({
      type: "session.step.ended",
      created: 1_700_000_000_000,
      data: {
        sessionID: "ses-1",
        assistantMessageID: "msg-1",
        tokens: { cache: { read: 8 } },
      },
    });
    expect(dashboardEvents).toEqual([]);
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();

    releaseCache();
    releaseDashboard();
    client.dispose();
  });

  it("does not start a Native transport for a cache-only listener", () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller });
    const releaseCache = client.subscribeCacheObserverEvent(() => {});

    expect(fake.raw.health).not.toHaveBeenCalled();
    expect(fake.raw.watch).not.toHaveBeenCalled();
    expect(fake.raw.events.subscribe).not.toHaveBeenCalled();

    releaseCache();
    client.dispose();
  });

  it("supersedes an immediate startup with an immutable latest scope", async () => {
    const fake = createFakeCaller();
    let resolveFirstHealth!: (value: { app: string; contractVersion: number }) => void;
    fake.raw.health.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstHealth = resolve;
        }),
    );
    const client = createNativeDashboardClient({ rpc: fake.caller, scope: "quota" });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => resolveFirstHealth !== undefined, "initial health request");
    const firstHealthSignal = fake.raw.health.mock.calls[0]?.[1]?.signal;

    await client.setActiveView("analytics");
    expect(firstHealthSignal?.aborted).toBe(true);
    expect(fake.raw.health).toHaveBeenCalledTimes(2);

    resolveFirstHealth({ app: "opencode-quota-gui", contractVersion: 2 });
    await waitFor(
      () => client.connection() === "live" && fake.activeWatches.length === 1,
      "latest startup attempt",
    );
    expect(fake.activeWatches[0]?.scope).toBe("analytics");
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();

    unsubscribe();
    client.dispose();
  });

  it("marks a broken stream as reconnecting, then explicitly re-subscribes, reacquires and refetches", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller });
    const refetch = vi.fn();
    client.onReconnect(refetch);
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    expect(fake.activeWatches).toHaveLength(1);

    fake.streams[0]?.fail(new Error("socket closed"));
    await waitFor(() => client.connection() === "reconnecting", "reconnecting state");
    await waitFor(() => fake.activeWatches[0]?.signal.aborted === true, "old watch abort");

    await client.reconnect();
    expect(fake.raw.health).toHaveBeenCalledTimes(2);
    expect(fake.raw.events.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.raw.watch).toHaveBeenCalledTimes(2);
    expect(fake.raw.watch.mock.calls[1]?.[0]).toEqual({ scope: "analytics" });
    expect(fake.activeWatches[1]?.scope).toBe("analytics");
    expect(client.connection()).toBe("live");
    expect(refetch).toHaveBeenCalledOnce();

    unsubscribe();
    client.dispose();
  });

  it("does not claim a live connection when the reconnect health check fails", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller });
    const refetch = vi.fn();
    client.onReconnect(refetch);
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");

    fake.raw.health.mockRejectedValueOnce(new Error("offline"));
    await client.reconnect();
    expect(client.connection()).toBe("reconnecting");
    expect(refetch).not.toHaveBeenCalled();
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();

    unsubscribe();
    client.dispose();
  });

  it("restarts the complete attempt with the active surface scope", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller, scope: "quota" });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    const firstWatch = fake.activeWatches[0];

    await client.setActiveView("analytics");
    await waitFor(() => fake.raw.watch.mock.calls.length === 2, "second watch");
    expect(firstWatch?.signal.aborted).toBe(true);
    expect(fake.activeWatches[1]?.scope).toBe("analytics");
    expect(fake.raw.health).toHaveBeenCalledTimes(2);
    expect(fake.raw.events.subscribe).toHaveBeenCalledTimes(2);
    expect(fake.streams[0]?.signal.aborted).toBe(true);
    expect(client.connection()).toBe("live");

    unsubscribe();
    client.dispose();
  });

  it("delegates every explicit method to the typed RPC caller", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller });

    await expect(client.health()).resolves.toMatchObject({ app: "opencode-quota-gui" });
    await expect(client.quota()).resolves.toEqual({ marker: "quota" });
    await expect(client.home({ range: "7d" })).resolves.toEqual({ marker: "home" });
    await expect(client.groups({ range: "7d", dimension: "model" })).resolves.toEqual({
      marker: "groups",
    });
    await expect(client.project({ projectId: "p1", range: "7d" })).resolves.toEqual({
      marker: "project",
    });
    await expect(client.session({ sessionId: "s1" })).resolves.toEqual({ marker: "session" });
    await expect(client.settings()).resolves.toEqual({ marker: "settings" });
    await expect(client.saveSettings({ patch: {}, expectedRevision: "r" })).resolves.toEqual({
      marker: "saveSettings",
    });
    await expect(
      client.saveVisibility({ hiddenCards: [], hiddenRows: [], expectedRevision: "r" }),
    ).resolves.toEqual({ marker: "saveVisibility" });
    await expect(client.importPreview()).resolves.toEqual({ marker: "importPreview" });
    await expect(client.importApply({ expectedRevision: "r" })).resolves.toEqual({
      marker: "importApply",
    });
    await expect(client.openSettingsFile()).resolves.toBeUndefined();
    expect(fake.raw.openSettingsFile).toHaveBeenCalledOnce();
    client.dispose();
  });

  it("calls the constructor onReconnect option exactly once per successful explicit reconnect", async () => {
    const fake = createFakeCaller();
    const refetch = vi.fn();
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: refetch });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    expect(refetch).not.toHaveBeenCalled();

    fake.streams[0]?.fail(new Error("socket closed"));
    await waitFor(() => client.connection() === "reconnecting", "reconnecting state");
    await client.reconnect();
    expect(client.connection()).toBe("live");
    expect(refetch).toHaveBeenCalledOnce();

    unsubscribe();
    client.dispose();
  });

  it("does not notify an older reconnect after a newer reconnect wins", async () => {
    const fake = createFakeCaller();
    const refetch = vi.fn();
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: refetch });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");

    fake.streams[0]?.fail(new Error("socket closed"));
    await waitFor(() => client.connection() === "reconnecting", "reconnecting state");

    let releaseOlder:
      | ((value: { app: "opencode-quota-gui"; contractVersion: number }) => void)
      | undefined;
    fake.raw.health.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseOlder = resolve;
        }),
    );
    const older = client.reconnect();
    const newer = client.reconnect();
    await newer;
    expect(client.connection()).toBe("live");
    expect(refetch).toHaveBeenCalledOnce();

    releaseOlder?.({ app: "opencode-quota-gui", contractVersion: 2 });
    await older;
    expect(refetch).toHaveBeenCalledOnce();

    unsubscribe();
    client.dispose();
  });

  it("contains throwing connection observers during reconnect and unsubscribe", async () => {
    const fake = createFakeCaller();
    let throwNow = false;
    const client = createNativeDashboardClient({
      rpc: fake.caller,
      onConnectionChange: () => {
        if (throwNow) throw new Error("observer failed");
      },
    });
    const observed: string[] = [];
    client.onConnectionChange((state) => observed.push(state));
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");

    throwNow = true;
    await expect(client.reconnect()).resolves.toBeUndefined();
    expect(client.connection()).toBe("live");
    expect(observed).toContain("reconnecting");
    expect(observed).toContain("live");

    expect(() => unsubscribe()).not.toThrow();
    expect(client.connection()).toBe("reconnecting");
    client.dispose();
  });

  it.each([
    "events",
    "watch",
  ] as const)("does not notify after an immediate %s failure during reconnect", async (failure) => {
    const fake = createFakeCaller();
    const refetch = vi.fn();
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: refetch });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");

    fake.streams[0]?.fail(new Error("socket closed"));
    await waitFor(() => client.connection() === "reconnecting", "reconnecting state");

    if (failure === "events") {
      fake.raw.events.subscribe.mockImplementationOnce(() => {
        // A failure already queued when the stream is handed over rejects on
        // the first iteration, before the reconnect can resume.
        const immediate = createEventStream(new AbortController().signal);
        immediate.fail(new Error("immediate stream failure"));
        return immediate.stream;
      });
    } else {
      // A timeout reported while opening is not eligible to recursively
      // recover; only a timeout from an established live attempt is.
      fake.raw.watch.mockRejectedValueOnce(hostWatchTimeout());
    }

    await client.reconnect();
    expect(client.connection()).toBe("reconnecting");
    expect(refetch).not.toHaveBeenCalled();

    unsubscribe();
    client.dispose();
  });

  it("releases the held viewer on the last unsubscribe without waiting for a heartbeat", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");

    unsubscribe();
    await waitFor(() => fake.activeWatches[0]?.signal.aborted === true, "viewer release");
    expect(client.connection()).toBe("reconnecting");
    client.dispose();
  });

  it("renews repeated Desktop watch timeouts without reconnecting or replacing events", async () => {
    const fake = createFakeCaller();
    const reconnect = vi.fn();
    const seen: DashboardEvent[] = [];
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: reconnect });
    client.onReconnect(reconnect);
    const unsubscribe = client.subscribe((event) => seen.push(event));
    await waitFor(() => client.connection() === "live", "live connection");

    const firstWatch = fake.activeWatches[0];
    const attemptSignal = firstWatch?.signal;
    await client.home({ range: "7d" });
    await client.project({ projectId: "p1", range: "7d" });
    firstWatch?.reject(hostWatchTimeout());
    await waitFor(() => fake.raw.watch.mock.calls.length === 2, "first renewed watch");

    const firstInput = fake.raw.watch.mock.calls[0]?.[0];
    expect(firstInput).toEqual({ scope: "analytics" });
    expect(fake.raw.watch.mock.calls[1]?.[0]).toEqual({ scope: "analytics" });
    expect(fake.raw.home).toHaveBeenCalledOnce();
    expect(fake.raw.project).toHaveBeenCalledOnce();
    expect(fake.raw.health).toHaveBeenCalledTimes(2);
    expect(fake.raw.health.mock.calls[1]?.[1]?.signal).toBe(attemptSignal);
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();
    expect(fake.streams[0]?.signal.aborted).toBe(false);
    expect(fake.activeWatches[1]?.signal).toBe(attemptSignal);
    expect(attemptSignal?.aborted).toBe(false);
    expect(fake.watchActivity()).toEqual({ active: 1, max: 1 });
    expect(client.connection()).toBe("live");
    expect(reconnect).not.toHaveBeenCalled();
    fake.streams[0]?.pushEvent({ topic: "quota.changed", at: 1 });
    await waitFor(() => seen.length === 1, "event delivery after first timeout");

    fake.activeWatches[1]?.reject(hostWatchTimeout());
    await waitFor(() => fake.raw.watch.mock.calls.length === 3, "second renewed watch");
    expect(fake.raw.watch.mock.calls[2]?.[0]).toEqual(fake.raw.watch.mock.calls[1]?.[0]);
    expect(fake.raw.home).toHaveBeenCalledOnce();
    expect(fake.raw.project).toHaveBeenCalledOnce();
    expect(fake.raw.health).toHaveBeenCalledTimes(3);
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();
    expect(fake.streams[0]?.signal.aborted).toBe(false);
    expect(fake.activeWatches[2]?.signal).toBe(attemptSignal);
    expect(fake.watchActivity()).toEqual({ active: 1, max: 1 });
    expect(client.connection()).toBe("live");
    expect(reconnect).not.toHaveBeenCalled();
    fake.streams[0]?.pushEvent({ topic: "settings.changed", at: 2 });
    await waitFor(() => seen.length === 2, "event delivery after repeated timeout");

    fake.streams[0]?.fail(new Error("event stream closed"));
    await waitFor(() => client.connection() === "reconnecting", "event failure reconnect state");
    expect(attemptSignal?.aborted).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();

    unsubscribe();
    client.dispose();
  });

  it("stops after the full recovery health check fails", async () => {
    const fake = createFakeCaller();
    const reconnect = vi.fn();
    const client = createNativeDashboardClient({ rpc: fake.caller });
    client.onReconnect(reconnect);
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    fake.raw.health.mockRejectedValueOnce(new Error("health unavailable"));

    fake.activeWatches[0]?.reject(hostWatchTimeout());
    await waitFor(
      () => fake.activeWatches[0]?.signal.aborted === true,
      "failed timeout watch abort",
    );

    expect(client.connection()).toBe("reconnecting");
    expect(fake.raw.health).toHaveBeenCalledTimes(2);
    expect(fake.raw.watch).toHaveBeenCalledOnce();
    expect(fake.streams[0]?.signal.aborted).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();
    expect(fake.activeWatches.filter((watch) => !watch.signal.aborted)).toHaveLength(0);

    unsubscribe();
    client.dispose();
  });

  it("does not notify success when a renewed watch rejects immediately", async () => {
    const fake = createFakeCaller();
    const reconnect = vi.fn();
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: reconnect });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    fake.raw.watch.mockRejectedValueOnce(new Error("replacement watch failed"));

    fake.activeWatches[0]?.reject(hostWatchTimeout());
    // The health check and replacement RPC resolve/reject through microtasks;
    // drain those turns directly rather than waiting on a timer.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.raw.watch).toHaveBeenCalledTimes(2);
    expect(client.connection()).toBe("reconnecting");
    expect(reconnect).not.toHaveBeenCalled();
    expect(fake.activeWatches.filter((watch) => !watch.signal.aborted)).toHaveLength(0);

    unsubscribe();
    client.dispose();
  });

  it("cancels initial health on suspension and only opens after resume", async () => {
    const fake = createFakeCaller();
    let resolveInitialHealth:
      | ((value: { app: "opencode-quota-gui"; contractVersion: number }) => void)
      | undefined;
    const client = createNativeDashboardClient({ rpc: fake.caller });
    fake.raw.health.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInitialHealth = resolve;
        }),
    );
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => resolveInitialHealth !== undefined, "initial health request");
    if (!resolveInitialHealth) {
      client.dispose();
      throw new Error("expected the initial health request to be pending");
    }
    const healthSignal = fake.raw.health.mock.calls[0]?.[1]?.signal;

    client.suspend();
    expect(healthSignal?.aborted).toBe(true);
    resolveInitialHealth({ app: "opencode-quota-gui", contractVersion: 2 });
    await Promise.resolve();
    expect(fake.raw.watch).not.toHaveBeenCalled();

    await client.resume();
    expect(client.connection()).toBe("live");
    expect(fake.raw.watch).toHaveBeenCalledOnce();
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();

    unsubscribe();
    client.dispose();
  });

  it("does not treat other watch transport errors as host timeouts", async () => {
    const fake = createFakeCaller();
    const reconnect = vi.fn();
    const client = createNativeDashboardClient({ rpc: fake.caller });
    client.onReconnect(reconnect);
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");

    fake.activeWatches[0]?.reject(
      Object.assign(new Error("transport closed"), {
        name: "ClientError",
        reason: "Transport",
        cause: new DOMException("The operation was aborted", "AbortError"),
      }),
    );
    await waitFor(() => fake.activeWatches[0]?.signal.aborted === true, "disconnected watch abort");

    expect(client.connection()).toBe("reconnecting");
    expect(fake.raw.health).toHaveBeenCalledOnce();
    expect(fake.raw.watch).toHaveBeenCalledOnce();
    expect(fake.streams[0]?.signal.aborted).toBe(true);
    expect(reconnect).not.toHaveBeenCalled();

    unsubscribe();
    client.dispose();
  });

  it("does not open a viewer when disposed during recovery health", async () => {
    const fake = createFakeCaller();
    const reconnect = vi.fn();
    let resolveHealth: (() => void) | undefined;
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: reconnect });
    client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    fake.raw.health.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHealth = () => resolve({ app: "opencode-quota-gui", contractVersion: 2 });
        }),
    );

    const timedOutWatch = fake.activeWatches[0];
    timedOutWatch?.reject(hostWatchTimeout());
    await waitFor(() => resolveHealth !== undefined, "pending timeout health check");
    const healthSignal = fake.raw.health.mock.calls[1]?.[1]?.signal;
    client.dispose();

    expect(client.connection()).toBe("closed");
    expect(healthSignal?.aborted).toBe(true);
    resolveHealth?.();
    await Promise.resolve();

    expect(fake.raw.watch).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
    expect(fake.activeWatches.every((watch) => watch.signal.aborted)).toBe(true);
  });

  it("does not open a viewer when the last subscriber leaves during recovery health", async () => {
    const fake = createFakeCaller();
    const reconnect = vi.fn();
    let resolveHealth: (() => void) | undefined;
    const client = createNativeDashboardClient({ rpc: fake.caller, onReconnect: reconnect });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    fake.raw.health.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHealth = () => resolve({ app: "opencode-quota-gui", contractVersion: 2 });
        }),
    );

    const timedOutWatch = fake.activeWatches[0];
    timedOutWatch?.reject(hostWatchTimeout());
    await waitFor(() => resolveHealth !== undefined, "pending timeout health check");
    const healthSignal = fake.raw.health.mock.calls[1]?.[1]?.signal;
    unsubscribe();

    expect(client.connection()).toBe("reconnecting");
    expect(healthSignal?.aborted).toBe(true);
    resolveHealth?.();
    await Promise.resolve();

    expect(fake.raw.watch).toHaveBeenCalledOnce();
    expect(reconnect).not.toHaveBeenCalled();
    expect(fake.activeWatches.every((watch) => watch.signal.aborted)).toBe(true);
    client.dispose();
  });
});
