// @vitest-environment happy-dom
import type { SlotMap } from "@opencode/plugin/gui";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardEvent, QuotaSnapshot } from "../src/contracts/dashboard.js";
import { DASHBOARD_CONTRACT_VERSION } from "../src/contracts/dashboard.js";
import { NativeSessionHeader } from "../src/native/session-header.js";
import { providerCard, settingsSnapshot } from "./fixtures/gui-ui-fixtures.js";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");

interface FakeHost {
  context: unknown;
  emit: (event: DashboardEvent) => void;
}

/**
 * The mounted `session.header` Slot against a host header with competing
 * actions. The Slot's real `onMount` measurement must follow a sibling action
 * whose width changes without resizing the layout, actions row or location —
 * the old observer set would leave the strip at its first width.
 *
 * The same mount proves the preview countdown follows a newer view: a quota
 * invalidation while the preview stays open moves the copy from 42m to 32m,
 * which the old captured clock did not.
 */

const pluginHost = vi.hoisted(() => ({ context: undefined as unknown }));

vi.mock("@opencode/plugin/gui", () => ({
  usePlugin: () => pluginHost.context,
}));

class ControlledResizeObserver implements ResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  readonly observed = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }
}

function rect(width: number): DOMRect {
  return {
    width,
    height: 28,
    top: 0,
    left: 0,
    right: width,
    bottom: 28,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

function setWidth(element: HTMLElement, width: number): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => rect(width),
  });
}

function resize(element: Element): void {
  for (const observer of ControlledResizeObserver.instances) {
    if (observer.observed.has(element)) observer.callback([], observer);
  }
}

function waitFor(check: () => void): Promise<void> {
  return vi.waitFor(check, { timeout: 5_000 });
}

function quotaSnapshot(): QuotaSnapshot {
  return {
    generatedAtMs: NOW,
    stale: false,
    timeZone: "UTC",
    providers: {
      cards: [providerCard()],
      enabledProviders: "auto",
      polledAtMs: NOW,
    },
    temporal: {
      generatedAtMs: NOW,
      providers: [
        {
          providerId: "synthetic-provider",
          providerLabel: "Synthetic Provider",
          discovered: true,
          phase: "offpeak",
          models: [
            {
              modelId: "synthetic/model",
              state: "offpeak",
              nextChangeAtMs: NOW + 42 * 60_000,
              nextState: "peak",
              intervals: [],
            },
          ],
          holidays: [],
        },
      ],
      snapshot: { revision: "test", generatedAtMs: NOW },
    },
  };
}

function fakeContext(): FakeHost {
  const subscribers = new Set<(event: DashboardEvent) => void>();
  const rpc = {
    health: async () => ({
      app: "opencode-quota-gui",
      contractVersion: DASHBOARD_CONTRACT_VERSION,
    }),
    settings: async () => settingsSnapshot(),
    quota: async () => quotaSnapshot(),
    watch: (_input: unknown, options: { signal: AbortSignal }) =>
      new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new Error("aborted"));
        if (options.signal.aborted) abort();
        else options.signal.addEventListener("abort", abort, { once: true });
      }),
    events: {
      subscribe: (_name: string, options: { signal: AbortSignal }) =>
        (async function* () {
          const queue: DashboardEvent[] = [];
          let wake: (() => void) | undefined;
          const push = (event: DashboardEvent) => {
            queue.push(event);
            wake?.();
            wake = undefined;
          };
          const onAbort = () => {
            wake?.();
            wake = undefined;
          };
          subscribers.add(push);
          options.signal.addEventListener("abort", onAbort, { once: true });
          try {
            while (!options.signal.aborted) {
              if (queue.length === 0) {
                await new Promise<void>((resolve) => {
                  wake = resolve;
                });
                continue;
              }
              const event = queue.shift();
              if (event !== undefined) yield { data: event };
            }
          } finally {
            subscribers.delete(push);
            options.signal.removeEventListener("abort", onAbort);
          }
        })(),
    },
  };
  return {
    context: {
      client: { rpc: () => rpc },
      servers: { list: () => [] as string[], get: (_id: string) => undefined },
    },
    emit: (event) => {
      for (const push of subscribers) push(event);
    },
  };
}

interface HeaderFixture {
  layout: HTMLDivElement;
  actions: HTMLDivElement;
  first: HTMLButtonElement;
  second: HTMLButtonElement;
  root: HTMLDivElement;
  dispose: () => void;
}

function mountSlot(): HeaderFixture {
  const layout = document.createElement("div");
  layout.className = "session-header-layout";
  const location = document.createElement("div");
  location.className = "session-header-location";
  const actions = document.createElement("div");
  actions.className = "session-header-actions";
  const first = document.createElement("button");
  first.textContent = "Review";
  first.style.display = "block";
  const second = document.createElement("button");
  second.textContent = "Share";
  second.style.display = "block";
  actions.append(first, second);
  layout.append(location, actions);
  document.body.append(layout);
  setWidth(layout, 900);
  setWidth(location, 200);
  setWidth(first, 120);
  setWidth(second, 80);

  const input = {
    screen: {},
    session: {},
    active: true,
  } as unknown as SlotMap["session.header"];
  const dispose = render(
    () =>
      createComponent(NativeSessionHeader, {
        input,
        onOpenPanel: () => undefined,
      }),
    actions,
  );
  const root = actions.querySelector(".qg-slot-strip");
  if (!(root instanceof HTMLDivElement)) throw new Error("the Slot did not mount a strip root");
  return { layout, actions, first, second, root, dispose };
}

let fixture: HeaderFixture | undefined;
let host: FakeHost;

beforeEach(() => {
  ControlledResizeObserver.instances = [];
  host = fakeContext();
  pluginHost.context = host.context;
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
});

afterEach(() => {
  fixture?.dispose();
  fixture?.layout.remove();
  fixture = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mounted session.header", () => {
  it("updates the strip when a competing host action widens", async () => {
    fixture = mountSlot();
    await waitFor(() => {
      expect(fixture?.root.style.maxWidth).toBe("382px");
      expect(fixture?.root.querySelectorAll(".qg-slot-token").length).toBe(1);
    });

    const resizeObserver = ControlledResizeObserver.instances[0];
    if (resizeObserver === undefined) throw new Error("the Slot did not observe the header");
    expect(resizeObserver.observed).toContain(fixture.first);
    expect(resizeObserver.observed).toContain(fixture.second);

    // Only the observer watching the first action fires; the layout, actions row
    // and location keep their width, as when a host button's label grows.
    setWidth(fixture.first, 220);
    resize(fixture.first);
    await waitFor(() => {
      expect(fixture?.root.style.maxWidth).toBe("282px");
    });
  });

  it("follows a competing action the host adds later", async () => {
    fixture = mountSlot();
    await waitFor(() => {
      expect(fixture?.root.style.maxWidth).toBe("382px");
    });

    const third = document.createElement("button");
    third.textContent = "More";
    third.style.display = "block";
    setWidth(third, 50);
    fixture.actions.insertBefore(third, fixture.root);
    await waitFor(() => {
      expect(fixture?.root.style.maxWidth).toBe("324px");
    });

    const resizeObserver = ControlledResizeObserver.instances[0];
    if (resizeObserver === undefined) throw new Error("the Slot did not observe the header");
    expect(resizeObserver.observed).toContain(third);
  });

  it("advances the mounted preview countdown when a newer view arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    fixture = mountSlot();
    await waitFor(() => {
      expect(fixture?.root.querySelectorAll(".qg-slot-token").length).toBe(1);
    });

    fixture.root.dispatchEvent(new Event("pointerenter"));
    await waitFor(() => {
      expect(document.querySelector(".qg-slot-preview")?.textContent).toContain("Peak in 42m");
    });

    // A newer quota snapshot at +10 min must move the countdown while the same
    // preview stays open; the old captured clock would remain at 42m.
    vi.setSystemTime(new Date(NOW + 10 * 60_000));
    host.emit({ topic: "quota.changed", at: NOW + 10 * 60_000 });
    await waitFor(() => {
      expect(document.querySelector(".qg-slot-preview")?.textContent).toContain("Peak in 32m");
    });
  });
});
