// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureHeaderBudget, observeHeaderBudget } from "../src/native/session-header-measure.js";

/**
 * The `session.header` width controller against a realistic host header.
 *
 * The fixture has a fixed-width location, a constrained actions row and several
 * competing action children. A controlled ResizeObserver lets the test fire
 * only the observers that actually watch the resized element, so a sibling width
 * change proves the controller observes that sibling (the old layout/actions/
 * location-only observer set would stay stale here). Child-list mutations use
 * happy-dom's real observer; attribute delivery is simulated because this
 * happy-dom version does not implement it, and the simulation only fires for
 * configurations that would cover the changed sibling.
 */

const NativeMutationObserver = globalThis.MutationObserver;

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

/**
 * Wraps happy-dom's MutationObserver so child-list mutations stay real while
 * attribute changes can be delivered explicitly: happy-dom's attribute
 * observation is a no-op in this version, and the controller must still be
 * shown to react to the class/style/hidden changes it subscribes to.
 */
class ControlledMutationObserver implements MutationObserver {
  static instances: ControlledMutationObserver[] = [];
  readonly observed = new Map<Node, MutationObserverInit>();
  #native: MutationObserver | undefined;

  constructor(readonly callback: MutationObserverCallback) {
    ControlledMutationObserver.instances.push(this);
  }

  observe(target: Node, options?: MutationObserverInit): void {
    this.observed.set(target, options ?? {});
    if (this.#native === undefined) {
      this.#native = new NativeMutationObserver((records) => this.callback(records, this));
    }
    this.#native.observe(target, options);
  }

  disconnect(): void {
    this.#native?.disconnect();
  }

  takeRecords(): MutationRecord[] {
    return this.#native?.takeRecords() ?? [];
  }

  /**
   * happy-dom does not deliver attribute records. Deliver the callback only to
   * observers whose real options would have covered this target, so a missing
   * `subtree` or `attributes` flag fails the test instead of being masked.
   */
  mutateAttribute(target: Element): void {
    for (const [observed, options] of this.observed) {
      if (observed !== target && !(options.subtree === true && observed.contains(target))) continue;
      if (options.attributes !== true) continue;
      if (options.attributeFilter !== undefined && !options.attributeFilter.includes("style")) {
        continue;
      }
      this.callback([], this);
    }
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
  // A real ResizeObserver only fires for elements it observes, not for every
  // observer in the page.
  for (const observer of ControlledResizeObserver.instances) {
    if (observer.observed.has(element)) observer.callback([], observer);
  }
}

function flushMutations(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function headerFixture(): {
  layout: HTMLDivElement;
  location: HTMLDivElement;
  actions: HTMLDivElement;
  first: HTMLButtonElement;
  second: HTMLButtonElement;
  slot: HTMLDivElement;
} {
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
  const slot = document.createElement("div");
  slot.className = "qg-slot-strip";

  actions.append(first, second, slot);
  layout.append(location, actions);
  document.body.append(layout);
  setWidth(layout, 900);
  setWidth(location, 200);
  setWidth(first, 120);
  setWidth(second, 80);
  setWidth(slot, 0);
  return { layout, location, actions, first, second, slot };
}

let fixtures: HTMLElement[] = [];

beforeEach(() => {
  ControlledResizeObserver.instances = [];
  ControlledMutationObserver.instances = [];
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
  vi.stubGlobal("MutationObserver", ControlledMutationObserver);
});

afterEach(() => {
  for (const element of fixtures) element.remove();
  fixtures = [];
  vi.unstubAllGlobals();
});

describe("session.header width measurement", () => {
  it("observes the layout, location and every competing sibling action", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (budget) => budgets.push(budget));
    const resizeObserver = ControlledResizeObserver.instances[0];
    if (resizeObserver === undefined) throw new Error("no ResizeObserver created");

    expect(budgets.at(-1)).toBe(382);
    expect(measureHeaderBudget(fixture.slot)).toBe(382);
    expect(resizeObserver.observed).toContain(fixture.layout);
    expect(resizeObserver.observed).toContain(fixture.actions);
    expect(resizeObserver.observed).toContain(fixture.location);
    expect(resizeObserver.observed).toContain(fixture.first);
    expect(resizeObserver.observed).toContain(fixture.second);
    expect(resizeObserver.observed).not.toContain(fixture.slot);

    // Only the observer watching the sibling fires, as the browser would.
    setWidth(fixture.first, 220);
    resize(fixture.first);
    expect(budgets.at(-1)).toBe(282);

    observer.dispose();
    expect(resizeObserver.observed.size).toBe(0);
  });

  it("observes a newly added competing action and releases a removed one", async () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (budget) => budgets.push(budget));
    const resizeObserver = ControlledResizeObserver.instances[0];
    if (resizeObserver === undefined) throw new Error("no ResizeObserver created");
    const third = document.createElement("button");
    third.textContent = "More";
    third.style.display = "block";
    setWidth(third, 50);

    fixture.actions.insertBefore(third, fixture.slot);
    await flushMutations();
    expect(resizeObserver.observed).toContain(third);
    expect(budgets.at(-1)).toBe(324);

    fixture.actions.removeChild(third);
    await flushMutations();
    expect(resizeObserver.observed).not.toContain(third);
    expect(budgets.at(-1)).toBe(382);

    observer.dispose();
  });

  it("drops a hidden competing action from the budget and observation", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (budget) => budgets.push(budget));
    const resizeObserver = ControlledResizeObserver.instances[0];
    const mutationObserver = ControlledMutationObserver.instances[0];
    if (resizeObserver === undefined || mutationObserver === undefined) {
      throw new Error("observers were not created");
    }

    expect(mutationObserver.observed.get(fixture.actions)).toMatchObject({
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden"],
    });

    fixture.second.style.display = "none";
    mutationObserver.mutateAttribute(fixture.second);
    expect(resizeObserver.observed).not.toContain(fixture.second);
    expect(budgets.at(-1)).toBe(470);

    observer.dispose();
  });

  it("remeasures when the host layout itself resizes", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (budget) => budgets.push(budget));

    setWidth(fixture.layout, 800);
    resize(fixture.layout);
    expect(budgets.at(-1)).toBe(282);

    observer.dispose();
  });
});
