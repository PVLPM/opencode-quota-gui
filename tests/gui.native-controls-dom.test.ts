import { createComponent, createEffect, createRoot, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { expect, it, vi } from "vitest";
import { createDashboardPanelState } from "../src/native/panel-state";
import { NativeSettingsPage } from "../src/native/settings-page";
import {
  Button,
  NativeUiProvider,
  SegmentedControl,
  SegmentedControlItem,
  Switch,
} from "../src/native/ui";
import { createQuotaQuery } from "../src/ui/quota-query";
import { QuotaRoute } from "../src/ui/routes";
import { displayPreferencesFromValues } from "../src/ui/settings-model";
import { homeSnapshot } from "./fixtures/gui-ui-fixtures";

vi.mock("../src/native/dashboard-client.js", () => ({
  createNativeDashboardClient: () => ({ dispose() {} }),
}));
vi.mock("../src/native/rpc.js", () => ({ createGuiRpcCaller: () => ({}) }));
vi.mock("../src/native/settings-page-state.js", () => ({
  createSettingsPageState: () => ({
    query: { data: () => undefined, error: () => undefined },
    quota: () => undefined,
    quotaStale: () => true,
    loading: () => false,
    stale: () => true,
    connection: () => "live",
    retryable: () => true,
    retry() {},
  }),
}));

it("applies the forced quota response even when its invalidation event is missed", async () => {
  const home = homeSnapshot();
  const stale = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...home.providers, cards: [] },
  };
  const fresh = { ...stale, generatedAtMs: 2, stale: false };
  let resolveRefresh!: (snapshot: typeof fresh) => void;
  let pending: Promise<typeof fresh> | undefined;
  let upstream = 0;
  const requests: Array<boolean> = [];
  const client = {
    quota: (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      if (!input?.refresh) return Promise.resolve(stale);
      if (!pending) {
        upstream += 1;
        pending = new Promise((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return pending;
    },
  };
  const target = document.createElement("div");
  document.body.append(target);
  const snapshots: number[] = [];
  const dispose = render(
    () =>
      createComponent(QuotaRoute, {
        client: client as never,
        preferences: displayPreferencesFromValues({}),
        hiddenCards: [],
        hiddenRows: [],
        reloadToken: 0,
        reconnectEpoch: 0,
        onSnapshot: (snapshot) => {
          if (snapshot) snapshots.push(snapshot.generatedAtMs);
        },
        onStale: () => {},
        onRetryShell: () => {},
      }),
    target,
  );
  try {
    await vi.waitFor(() => expect(target.textContent).toContain("Quota data is unavailable"));
    target.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(requests.filter(Boolean)).toHaveLength(1));
    expect(upstream).toBe(1);
    resolveRefresh(fresh);
    await vi.waitFor(() => expect(snapshots).toContain(2));
  } finally {
    dispose();
    target.remove();
  }
});

it("rereads once and shows the newer quota when a change arrives during the route's read", async () => {
  const stale = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  const fresh = { ...stale, generatedAtMs: 2, stale: false };
  const resolvers: Array<(value: typeof stale) => void> = [];
  const requests: boolean[] = [];
  const client = {
    quota: (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      return new Promise<typeof stale>((resolve) => resolvers.push(resolve));
    },
  };
  const [token, setToken] = createSignal(0);
  const snapshots: number[] = [];
  let routeStale = false;
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(QuotaRoute, {
        client: client as never,
        preferences: displayPreferencesFromValues({}),
        hiddenCards: [],
        hiddenRows: [],
        get reloadToken() {
          return token();
        },
        reconnectEpoch: 0,
        onSnapshot: (snapshot) => {
          if (snapshot) snapshots.push(snapshot.generatedAtMs);
        },
        onStale: (value) => {
          routeStale = value;
        },
        onRetryShell: () => {},
      }),
    target,
  );
  try {
    await vi.waitFor(() => expect(requests).toEqual([false]));
    // The event lands while the first read is still pending.
    setToken(1);
    await Promise.resolve();
    expect(requests).toEqual([false]);
    resolvers[0]?.(stale);
    await vi.waitFor(() => expect(requests).toEqual([false, false]));
    expect(snapshots).toContain(1);
    resolvers[1]?.(fresh);
    await vi.waitFor(() => expect(snapshots.at(-1)).toBe(2));
    await vi.waitFor(() => expect(routeStale).toBe(false));
    expect(target.textContent).not.toContain("Quota data is unavailable");
    expect(requests).toEqual([false, false]);
  } finally {
    dispose();
    target.remove();
  }
});

it("marks a successful manual retry fresh when it replaces a reconnect read", async () => {
  const snapshot = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  let resolveRead!: (value: typeof snapshot) => void;
  const requests: boolean[] = [];
  const client = {
    quota: (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      if (input?.refresh) return Promise.resolve({ ...snapshot, generatedAtMs: 2, stale: false });
      if (requests.length === 1) return Promise.resolve(snapshot);
      return new Promise<typeof snapshot>((resolve) => {
        resolveRead = resolve;
      });
    },
  };
  const target = document.createElement("div");
  document.body.append(target);
  let setEpoch!: (value: number) => number;
  let stale = false;
  const onFresh = vi.fn();
  const dispose = render(() => {
    const [epoch, set] = createSignal(0);
    setEpoch = set;
    return createComponent(QuotaRoute, {
      client: client as never,
      preferences: displayPreferencesFromValues({}),
      hiddenCards: [],
      hiddenRows: [],
      reloadToken: 0,
      get reconnectEpoch() {
        return epoch();
      },
      onSnapshot: () => {},
      onStale: (value) => {
        stale = value;
      },
      onFresh,
    });
  }, target);
  try {
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledOnce());
    setEpoch(1);
    await vi.waitFor(() => expect(requests).toEqual([false, false]));
    expect(stale).toBe(true);
    target.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(requests).toEqual([false, false, true]));
    await vi.waitFor(() => expect(stale).toBe(false));
    expect(onFresh).toHaveBeenCalledTimes(2);
    resolveRead(snapshot);
    await Promise.resolve();
    expect(stale).toBe(false);
  } finally {
    dispose();
    target.remove();
  }
});

it.each([
  "failure",
  "stale",
  "new epoch",
] as const)("does not mark a manual retry fresh after %s", async (outcome) => {
  const snapshot = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  let resolveRefresh!: (value: typeof snapshot) => void;
  let rejectRefresh!: (reason: Error) => void;
  const requests: boolean[] = [];
  const client = {
    quota: (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      if (input?.refresh) {
        return new Promise<typeof snapshot>((resolve, reject) => {
          resolveRefresh = resolve;
          rejectRefresh = reject;
        });
      }
      if (requests.length === 1) return Promise.resolve(snapshot);
      return new Promise<typeof snapshot>(() => {});
    },
  };
  const target = document.createElement("div");
  document.body.append(target);
  let setEpoch!: (value: number) => number;
  const onFresh = vi.fn();
  const dispose = render(() => {
    const [epoch, set] = createSignal(0);
    setEpoch = set;
    return createComponent(QuotaRoute, {
      client: client as never,
      preferences: displayPreferencesFromValues({}),
      hiddenCards: [],
      hiddenRows: [],
      reloadToken: 0,
      get reconnectEpoch() {
        return epoch();
      },
      onSnapshot: () => {},
      onStale: () => {},
      onFresh,
    });
  }, target);
  try {
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledOnce());
    setEpoch(1);
    await vi.waitFor(() => expect(requests).toEqual([false, false]));
    target.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(requests).toEqual([false, false, true]));
    const resolveOriginal = resolveRefresh;
    if (outcome === "new epoch") setEpoch(2);
    if (outcome === "failure") rejectRefresh(new Error("failed"));
    else resolveOriginal({ ...snapshot, stale: outcome === "stale" });
    await vi.waitFor(() => {
      if (outcome === "failure") expect(target.textContent).toContain("Retry");
      else if (outcome === "stale")
        expect(target.textContent).toContain("Quota data is unavailable");
      else expect(requests).toEqual([false, false, true, true]);
    });
    await Promise.resolve();
    expect(onFresh).toHaveBeenCalledOnce();
  } finally {
    dispose();
    target.remove();
  }
});

it("shows a shell refresh that finished before the quota route mounted", async () => {
  const stale = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  const fresh = { ...stale, generatedAtMs: 2, stale: false };
  const requests: boolean[] = [];
  const client = {
    quota: async (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      return input?.refresh ? fresh : stale;
    },
  };
  const query = createQuotaQuery((refresh) =>
    client.quota(refresh ? { refresh: true } : undefined),
  );
  await query.refresh();
  const target = document.createElement("div");
  document.body.append(target);
  const snapshots: number[] = [];
  const onFresh = vi.fn();
  const dispose = render(
    () =>
      createComponent(QuotaRoute, {
        client: client as never,
        quotaQuery: query,
        preferences: displayPreferencesFromValues({}),
        hiddenCards: [],
        hiddenRows: [],
        reloadToken: 0,
        reconnectEpoch: 0,
        onFresh,
        onSnapshot: (snapshot) => {
          if (snapshot) snapshots.push(snapshot.generatedAtMs);
        },
        onStale: () => {},
      }),
    target,
  );
  try {
    await vi.waitFor(() => expect(snapshots).toContain(2));
    await Promise.resolve();
    expect(requests).toEqual([true]);
    expect(snapshots.at(-1)).toBe(2);
    expect(onFresh).toHaveBeenCalledOnce();
  } finally {
    dispose();
    target.remove();
  }
});

it("revalidates a shell refresh after host recovery before marking the route fresh", async () => {
  const snapshot = {
    generatedAtMs: 42,
    stale: false,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  let reconnect = () => {};
  let resolveRead!: (value: typeof snapshot) => void;
  const requests: boolean[] = [];
  const client = {
    quota: (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      return input?.refresh
        ? Promise.resolve(snapshot)
        : new Promise<typeof snapshot>((resolve) => {
            resolveRead = resolve;
          });
    },
    settings: async () => ({ values: {}, visibility: { hiddenCards: [], hiddenRows: [] } }),
    health: async () => ({}),
    connection: () => "live" as const,
    subscribe: () => () => {},
    onConnectionChange: () => () => {},
    onReconnect: (listener: () => void) => {
      reconnect = listener;
      return () => {};
    },
    reconnect: async () => {
      reconnect();
    },
  };
  let setHost!: (value: boolean) => boolean;
  let disposeState!: () => void;
  const panel = createRoot((dispose) => {
    disposeState = dispose;
    const [host, set] = createSignal(true);
    setHost = set;
    return createDashboardPanelState({
      client: client as never,
      visible: () => true,
      hostConnected: host,
    });
  });
  const target = document.createElement("div");
  document.body.append(target);
  let disposeRoute = () => {};
  try {
    panel.retry();
    await vi.waitFor(() => expect(panel.quotaQuery.data()?.generatedAtMs).toBe(42));
    setHost(false);
    setHost(true);
    disposeRoute = render(
      () =>
        createComponent(QuotaRoute, {
          client: client as never,
          quotaQuery: panel.quotaQuery,
          preferences: displayPreferencesFromValues({}),
          hiddenCards: [],
          hiddenRows: [],
          reloadToken: 0,
          get reconnectEpoch() {
            return panel.reconnectEpoch();
          },
          onFresh: panel.markFresh,
          onSnapshot: () => {},
          onStale: () => {},
        }),
      target,
    );
    await vi.waitFor(() => expect(requests).toEqual([true, false]));
    expect(panel.hostStale()).toBe(true);
    resolveRead(snapshot);
    await vi.waitFor(() => expect(panel.hostStale()).toBe(false));
  } finally {
    disposeRoute();
    disposeState();
    target.remove();
  }
});

it("does not force again on an ordinary invalidation after a failed refresh", async () => {
  const snapshot = {
    generatedAtMs: 1,
    stale: false,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  const requests: boolean[] = [];
  const query = createQuotaQuery(async (refresh) => {
    requests.push(refresh);
    if (refresh && requests.length === 1) throw new Error("failed");
    return snapshot;
  });
  expect(await query.refresh()).toBe(false);
  expect(await query.read()).toBe(true);
  expect(requests).toEqual([true, false]);
  query.invalidate();
  query.reconnected();
  expect(await query.read()).toBe(true);
  expect(requests).toEqual([true, false, true]);
});

it("starts a fresh read without waiting for a retired request and ignores its late failure", async () => {
  const snapshot = {
    generatedAtMs: 42,
    stale: false,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  let rejectOld!: (error: Error) => void;
  let resolveNew!: (value: typeof snapshot) => void;
  const requests: boolean[] = [];
  const query = createQuotaQuery((refresh) => {
    requests.push(refresh);
    return requests.length === 1
      ? new Promise<typeof snapshot>((_, reject) => {
          rejectOld = reject;
        })
      : new Promise<typeof snapshot>((resolve) => {
          resolveNew = resolve;
        });
  });
  const old = query.refresh();
  query.invalidate();
  query.reconnected();
  expect(query.isRefreshing()).toBe(false);
  const current = query.afterReconnect();
  const joined = query.read();
  expect(requests).toEqual([true, true]);
  resolveNew(snapshot);
  expect(await current).toBe(true);
  expect(await joined).toBe(true);
  rejectOld(new Error("old failure"));
  expect(await old).toBe(false);
  expect(query.data()).toBe(snapshot);
  expect(query.error()).toBeUndefined();
});

it("does not surface a retired failure before a replacement request starts", async () => {
  let reject!: (error: Error) => void;
  const query = createQuotaQuery(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  const pending = query.read();
  query.invalidate();
  reject(new Error("old failure"));
  expect(await pending).toBe(false);
  expect(query.error()).toBeUndefined();
  expect(query.loading()).toBe(false);
});

it("rereads once when a quota change arrives during an ordinary in-flight read", async () => {
  const snapshot = (generatedAtMs: number) => ({
    generatedAtMs,
    stale: false,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  });
  const resolvers: Array<(value: ReturnType<typeof snapshot>) => void> = [];
  const requests: boolean[] = [];
  const query = createQuotaQuery((refresh) => {
    requests.push(refresh);
    return new Promise<ReturnType<typeof snapshot>>((resolve) => resolvers.push(resolve));
  });
  const first = query.read();
  const joined = query.read();
  const changed = query.read({ changed: true });
  const changedAgain = query.read({ changed: true });
  expect(requests).toEqual([false]);
  resolvers[0]?.(snapshot(1));
  expect(await first).toBe(true);
  expect(await joined).toBe(true);
  await vi.waitFor(() => expect(requests).toEqual([false, false]));
  resolvers[1]?.(snapshot(2));
  expect(await changed).toBe(true);
  expect(await changedAgain).toBe(true);
  expect(query.data()?.generatedAtMs).toBe(2);
  expect(requests).toEqual([false, false]);
});

it("does not reread after a quota change during a forced refresh or a retired read", async () => {
  const requests: boolean[] = [];
  const resolvers: Array<(value: never) => void> = [];
  const query = createQuotaQuery((refresh) => {
    requests.push(refresh);
    return new Promise<never>((resolve) => resolvers.push(resolve));
  });
  const forced = query.refresh();
  void query.read({ changed: true });
  resolvers[0]?.({ generatedAtMs: 1 } as never);
  await forced;
  await Promise.resolve();
  expect(requests).toEqual([true]);

  const ordinary = query.read();
  const changed = query.read({ changed: true });
  query.invalidate();
  resolvers[1]?.({ generatedAtMs: 2 } as never);
  expect(await ordinary).toBe(false);
  expect(await changed).toBe(false);
  expect(requests).toEqual([true, false]);
});

it("does not force again when quota invalidation arrives before the retry response", async () => {
  const home = homeSnapshot();
  const stale = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...home.providers, cards: [] },
  };
  const fresh = { ...stale, generatedAtMs: 2, stale: false };
  let resolveRefresh!: (snapshot: typeof fresh) => void;
  const forced = new Promise<typeof fresh>((resolve) => {
    resolveRefresh = resolve;
  });
  const requests: boolean[] = [];
  const [reload, setReload] = createSignal(0);
  const snapshots: number[] = [];
  const client = {
    quota: (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      if (input?.refresh) return forced;
      return Promise.resolve(stale);
    },
  };
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(QuotaRoute, {
        client: client as never,
        preferences: displayPreferencesFromValues({}),
        hiddenCards: [],
        hiddenRows: [],
        get reloadToken() {
          return reload();
        },
        reconnectEpoch: 0,
        onSnapshot: (snapshot) => {
          if (snapshot) snapshots.push(snapshot.generatedAtMs);
        },
        onStale: () => {},
        onRetryShell: () => {},
      }),
    target,
  );
  try {
    await vi.waitFor(() => expect(target.textContent).toContain("Quota data is unavailable"));
    target.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(requests).toEqual([false, true]));
    setReload(1);
    await Promise.resolve();
    expect(requests).toEqual([false, true]);
    resolveRefresh(fresh);
    await vi.waitFor(() => expect(snapshots).toContain(2));
    expect(snapshots.at(-1)).toBe(2);
    expect(requests.filter(Boolean)).toHaveLength(1);
  } finally {
    dispose();
    target.remove();
  }
});

it("retries a disconnected manual refresh once after native reconnect", async () => {
  const home = homeSnapshot();
  const stale = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...home.providers, cards: [] },
  };
  const fresh = { ...stale, generatedAtMs: 2, stale: false };
  let connected = false;
  const requests: boolean[] = [];
  const client = {
    quota: async (input?: { refresh?: boolean }) => {
      requests.push(input?.refresh === true);
      if (!input?.refresh) return stale;
      if (!connected) throw new Error("disconnected");
      return fresh;
    },
  };
  const [epoch, setEpoch] = createSignal(0);
  const snapshots: number[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(QuotaRoute, {
        client: client as never,
        preferences: displayPreferencesFromValues({}),
        hiddenCards: [],
        hiddenRows: [],
        reloadToken: 0,
        get reconnectEpoch() {
          return epoch();
        },
        onSnapshot: (snapshot) => {
          if (snapshot) snapshots.push(snapshot.generatedAtMs);
        },
        onStale: () => {},
        onRetryShell: () => {},
      }),
    target,
  );
  try {
    await vi.waitFor(() => expect(target.textContent).toContain("Quota data is unavailable"));
    target.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(requests).toEqual([false, true]));
    connected = true;
    setEpoch(1);
    await vi.waitFor(() => expect(snapshots).toContain(2));
    expect(requests).toEqual([false, true, true]);
  } finally {
    dispose();
    target.remove();
  }
});

it("retries a failed forced read when reconnect arrives before its rejection", async () => {
  const stale = {
    generatedAtMs: 1,
    stale: true,
    timeZone: "UTC",
    providers: { ...homeSnapshot().providers, cards: [] },
  };
  const fresh = { ...stale, generatedAtMs: 2, stale: false };
  let reject!: (error: Error) => void;
  const requests: boolean[] = [];
  const [epoch, setEpoch] = createSignal(0);
  const snapshots: number[] = [];
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(QuotaRoute, {
        client: {
          quota: (input?: { refresh?: boolean }) => {
            requests.push(input?.refresh === true);
            if (requests.length === 1) return Promise.resolve(stale);
            if (requests.length === 2)
              return new Promise<typeof fresh>((_, fail) => {
                reject = fail;
              });
            return Promise.resolve(fresh);
          },
        } as never,
        preferences: displayPreferencesFromValues({}),
        hiddenCards: [],
        hiddenRows: [],
        reloadToken: 0,
        get reconnectEpoch() {
          return epoch();
        },
        onSnapshot: (snapshot) => {
          if (snapshot) snapshots.push(snapshot.generatedAtMs);
        },
        onStale: () => {},
      }),
    target,
  );
  try {
    await vi.waitFor(() => expect(target.textContent).toContain("Quota data is unavailable"));
    target.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(requests).toEqual([false, true]));
    setEpoch(1);
    reject(new Error("connection lost"));
    await vi.waitFor(() => expect(snapshots).toContain(2));
    expect(requests).toEqual([false, true, true]);
  } finally {
    dispose();
    target.remove();
  }
});

it("keeps diagnostics in About and shows copy, check and failure feedback", async () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const target = document.createElement("div");
  document.body.append(target);
  const Icon = (props: { name: string }) => {
    const element = document.createElement("span");
    createEffect(() => {
      element.dataset.icon = props.name;
    });
    return element;
  };
  const dispose = render(
    () =>
      createComponent(NativeSettingsPage, {
        ctx: {
          app: { version: "2.2.1" },
          client: {},
          servers: { list: () => [] },
          ui: { Icon },
        } as never,
      }),
    target,
  );
  try {
    const about = target.querySelector('section[aria-labelledby="qg-settings-about"]')!;
    const button = about.querySelector<HTMLButtonElement>('button[aria-label="Copy diagnostics"]')!;
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    await vi.waitFor(() => expect(button.querySelector('[data-icon="check"]')).not.toBeNull());
    expect(document.activeElement).toBe(button);
    expect(target.textContent).toContain("Diagnostics copied to clipboard.");
    writeText.mockRejectedValueOnce(new Error("denied"));
    button.click();
    await vi.waitFor(() => expect(target.textContent).toContain("Could not copy diagnostics"));
    expect(button.querySelector('[data-icon="copy"]')).not.toBeNull();
  } finally {
    dispose();
    target.remove();
    if (original) Object.defineProperty(navigator, "clipboard", original);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("delegates settings controls to the host with reactive state", () => {
  const changed = vi.fn();
  const clicked = vi.fn();
  const hostSwitch = vi.fn(
    (props: { label: string; checked: boolean; onChange: (value: boolean) => void }) => {
      const button = document.createElement("button");
      button.setAttribute("aria-label", props.label);
      button.onclick = () => props.onChange(!props.checked);
      return button;
    },
  );
  const hostButton = vi.fn((props: { onClick?: (event: MouseEvent) => void }) => {
    const button = document.createElement("button");
    button.onclick = (event) => props.onClick?.(event);
    return button;
  });
  const target = document.createElement("div");
  const [checked, setChecked] = createSignal(false);
  const dispose = render(
    () =>
      createComponent(NativeUiProvider, {
        ui: { Switch: hostSwitch, Button: hostButton } as never,
        get children() {
          return [
            createComponent(Switch, {
              get checked() {
                return checked();
              },
              onChange(value) {
                changed(value);
                setChecked(value);
              },
              hideLabel: true,
              children: "Show quota",
            }),
            createComponent(Button, { variant: "contrast", onClick: clicked, children: "Save" }),
          ];
        },
      }),
    target,
  );
  expect(hostSwitch).toHaveBeenCalledOnce();
  expect(hostButton).toHaveBeenCalledOnce();
  expect(target.querySelector("button")?.getAttribute("aria-label")).toBe("Show quota");
  target.querySelector("button")?.click();
  expect(changed).toHaveBeenCalledWith(true);
  target.querySelectorAll("button")[1]?.click();
  expect(clicked).toHaveBeenCalledOnce();
  dispose();
});

it("moves selection and focus with arrow keys in segmented choices", () => {
  const [value, setValue] = createSignal("one");
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(SegmentedControl, {
        get value() {
          return value();
        },
        onChange: setValue,
        "aria-label": "Range",
        get children() {
          return [
            createComponent(SegmentedControlItem, { value: "one", children: "One" }),
            createComponent(SegmentedControlItem, { value: "two", children: "Two" }),
          ];
        },
      }),
    target,
  );
  const buttons = target.querySelectorAll("button");
  expect(buttons[0]?.tabIndex).toBe(0);
  expect(buttons[1]?.tabIndex).toBe(-1);
  buttons[0]?.focus();
  buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(value()).toBe("two");
  expect(document.activeElement).toBe(buttons[1]);
  expect(buttons[1]?.tabIndex).toBe(0);
  dispose();
  target.remove();
});

it("disables every segment and restores keyboard interaction when writable again", () => {
  const [value, setValue] = createSignal("auto");
  const [disabled, setDisabled] = createSignal(true);
  const change = vi.fn((next: string) => setValue(next));
  const target = document.createElement("div");
  document.body.append(target);
  const dispose = render(
    () =>
      createComponent(SegmentedControl, {
        get value() {
          return value();
        },
        get disabled() {
          return disabled();
        },
        onChange: change,
        "aria-label": "Provider selection",
        get children() {
          return [
            createComponent(SegmentedControlItem, { value: "auto", children: "Automatic" }),
            createComponent(SegmentedControlItem, { value: "manual", children: "Manual" }),
          ];
        },
      }),
    target,
  );
  const [automatic, manual] = target.querySelectorAll("button");
  expect(target.querySelector('[role="radiogroup"]')?.getAttribute("aria-disabled")).toBe("true");
  expect(automatic?.disabled).toBe(true);
  expect(manual?.disabled).toBe(true);
  expect(automatic?.tabIndex).toBe(-1);
  automatic?.focus();
  expect(document.activeElement).not.toBe(automatic);
  manual?.click();
  automatic?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(change).not.toHaveBeenCalled();
  expect(value()).toBe("auto");
  setDisabled(false);
  expect(automatic?.disabled).toBe(false);
  expect(manual?.disabled).toBe(false);
  expect(automatic?.tabIndex).toBe(0);
  automatic?.focus();
  automatic?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  expect(value()).toBe("manual");
  expect(document.activeElement).toBe(manual);
  dispose();
  target.remove();
});

it("preserves the real settings switch label forms", () => {
  const labels: string[] = [];
  const hostSwitch = (props: { label: string }) => {
    labels.push(props.label);
    return document.createElement("button");
  };
  const target = document.createElement("div");
  const fieldLabel = "Show runway";
  const providerLabel = "OpenAI";
  const dispose = render(
    () =>
      createComponent(NativeUiProvider, {
        ui: { Switch: hostSwitch } as never,
        get children() {
          return [
            createComponent(Switch, {
              checked: true,
              onChange: () => {},
              hideLabel: true,
              children: fieldLabel,
            }),
            createComponent(Switch, {
              checked: true,
              onChange: () => {},
              hideLabel: true,
              get children() {
                return ["Show peak and off-peak pricing for ", providerLabel, " on Quota"];
              },
            }),
          ];
        },
      }),
    target,
  );
  expect(labels).toEqual(["Show runway", "Show peak and off-peak pricing for OpenAI on Quota"]);
  dispose();
});
