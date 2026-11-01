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
}

function createFakeCaller() {
  const activeWatches: ActiveWatch[] = [];
  const streams: Array<ReturnType<typeof createEventStream>> = [];
  const caller = {
    health: vi.fn(async () => ({ app: "opencode-quota-gui", contractVersion: 2 })),
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
        new Promise<{ active: boolean }>((resolve) => {
          const signal = options?.signal ?? new AbortController().signal;
          activeWatches.push({ scope: input.scope, signal, resolve });
          signal.addEventListener("abort", () => resolve({ active: false }), { once: true });
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
  };
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

  it("reopens only the held viewer when the active surface changes", async () => {
    const fake = createFakeCaller();
    const client = createNativeDashboardClient({ rpc: fake.caller, scope: "quota" });
    const unsubscribe = client.subscribe(() => {});
    await waitFor(() => client.connection() === "live", "live connection");
    const firstWatch = fake.activeWatches[0];

    await client.setActiveView("analytics");
    await waitFor(() => fake.raw.watch.mock.calls.length === 2, "second watch");
    expect(firstWatch?.signal.aborted).toBe(true);
    expect(fake.activeWatches[1]?.scope).toBe("analytics");
    expect(fake.raw.events.subscribe).toHaveBeenCalledOnce();
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
    expect(observed).toContain("connecting");
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
      fake.raw.watch.mockRejectedValueOnce(new Error("immediate watch failure"));
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
});
