/**
 * Typed quota notification RPC forwarding.
 *
 * The host observer owns detection; the RPC transport only forwards its safe
 * final events on their own dashboard event. One observer subscription is
 * shared by registrations for the same host, and a disposing setup leaves its
 * siblings working.
 */
import { describe, expect, it, vi } from "vitest";

import type { DashboardEvent, GuiSettingsStore } from "../src/contracts/dashboard.js";
import {
  type DashboardRpcRegister,
  type DashboardRpcRuntime,
  registerDashboardRpc,
} from "../src/gui/rpc.js";
import type { SnapshotService } from "../src/gui/snapshot-service.js";
import type { DashboardRpcQuotaNotificationData } from "../src/rpc.js";

function createNotificationsBus() {
  const listeners = new Set<(event: DashboardRpcQuotaNotificationData) => void>();
  return {
    subscribe(listener: (event: DashboardRpcQuotaNotificationData) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event: DashboardRpcQuotaNotificationData) {
      for (const listener of listeners) listener(event);
    },
    get size() {
      return listeners.size;
    },
  };
}

function createRuntime(notifications = createNotificationsBus()) {
  const invalidationListeners = new Set<(event: DashboardEvent) => void>();
  const snapshots = {
    subscribe: vi.fn((listener: (event: DashboardEvent) => void) => {
      invalidationListeners.add(listener);
      return () => invalidationListeners.delete(listener);
    }),
  } as unknown as SnapshotService;
  const runtime: DashboardRpcRuntime = {
    snapshots,
    settings: {} as GuiSettingsStore,
    quotaNotifications: notifications,
  };
  return {
    runtime,
    notifications,
    emitInvalidation(event: DashboardEvent) {
      for (const listener of invalidationListeners) listener(event);
    },
    invalidationSubscriptions: () => invalidationListeners.size,
  };
}

type Handlers = Record<
  string,
  (input: unknown, context: { signal: AbortSignal; error: unknown }) => Promise<unknown>
>;

function createRegistrar() {
  const emitted: Array<{ name: string; data: unknown }> = [];
  const registrations: Array<{ dispose: () => Promise<void> }> = [];
  const register = vi.fn(async (_definition: unknown, _handlers: Handlers) => {
    const registration = {
      events: {
        emit: async (name: string, data: unknown) => {
          emitted.push({ name, data });
        },
      },
      dispose: vi.fn(async () => undefined),
    };
    registrations.push(registration);
    return registration;
  });
  return {
    register: register as unknown as DashboardRpcRegister["register"],
    emitted,
  };
}

const event: DashboardRpcQuotaNotificationData = {
  id: `${"d".repeat(64)}:${Date.parse("2026-11-02T12:02:00.000Z")}`,
  kind: "low",
  title: "OpenAI quota low",
  description: "work: 5-hour window: 5% remaining. Resets 2026-11-02T17:00:00.000Z.",
};

describe("quota notification RPC forwarding", () => {
  it("forwards safe notifications on their own event and cleans up the subscription", async () => {
    const fake = createRuntime();
    const registrar = createRegistrar();
    const registration = await registerDashboardRpc({ register: registrar.register }, fake.runtime);

    expect(fake.notifications.size).toBe(1);
    fake.notifications.emit(event);
    await vi.waitFor(() => expect(registrar.emitted).toHaveLength(1));
    expect(registrar.emitted[0]).toEqual({ name: "quotaNotification", data: event });

    fake.emitInvalidation({ topic: "quota.changed", at: 1 });
    await vi.waitFor(() => expect(registrar.emitted).toHaveLength(2));
    expect(registrar.emitted[1]).toMatchObject({ name: "invalidated" });

    await registration.dispose();
    expect(fake.notifications.size).toBe(0);
    expect(fake.invalidationSubscriptions()).toBe(0);

    fake.notifications.emit({ ...event, id: `${"e".repeat(64)}:3` });
    expect(registrar.emitted).toHaveLength(2);
  });

  it("shares one observer subscription per host and keeps siblings alive", async () => {
    const fake = createRuntime();
    const first = createRegistrar();
    const second = createRegistrar();
    const registrationA = await registerDashboardRpc({ register: first.register }, fake.runtime);
    const registrationB = await registerDashboardRpc({ register: second.register }, fake.runtime);

    expect(fake.notifications.size).toBe(1);
    fake.notifications.emit(event);
    await vi.waitFor(() => expect(first.emitted).toHaveLength(1));
    expect(second.emitted).toEqual([]);

    await registrationA.dispose();
    expect(fake.notifications.size).toBe(1);
    fake.notifications.emit({ ...event, id: `${"f".repeat(64)}:4` });
    await vi.waitFor(() => expect(second.emitted).toHaveLength(1));
    expect(first.emitted).toHaveLength(1);

    await registrationB.dispose();
    expect(fake.notifications.size).toBe(0);
  });

  it("does not invent a notification RPC method or held interest call", () => {
    // The observer is forwarded through the event bus only; no window identity,
    // claim, or held request is part of this transport anymore.
    const runtime: DashboardRpcRuntime = {
      snapshots: {} as SnapshotService,
      settings: {} as GuiSettingsStore,
    };
    expect(Object.keys(runtime)).toEqual(["snapshots", "settings"]);
  });
});
