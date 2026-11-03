// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fitMeasuredHeaderTokens,
  measureHeaderBudget,
  measureStripGeometry,
  observeHeaderBudget,
} from "../src/native/session-header-measure.js";

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
  actions.style.gap = "8px";
  actions.style.marginLeft = "2px";
  const title = document.createElement("div");
  title.className = "session-header-title";
  const titleMeasure = document.createElement("div");
  titleMeasure.className = "session-header-title-measure";
  const titleSpan = document.createElement("span");
  titleMeasure.append(titleSpan);
  title.append(titleMeasure);
  const first = document.createElement("button");
  first.textContent = "Review";
  first.style.display = "block";
  const second = document.createElement("button");
  second.textContent = "Share";
  second.style.display = "block";
  const slot = document.createElement("div");
  slot.className = "qg-slot-strip";

  actions.append(first, second, slot);
  layout.append(location, title, actions);
  document.body.append(layout);
  setWidth(layout, 900);
  setWidth(location, 200);
  setWidth(titleSpan, 100);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session.header width measurement", () => {
  it("measures overflow in the host typography context without leaving layout children", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    fixture.actions.style.letterSpacing = "3px";
    fixture.slot.style.letterSpacing = "3px";
    fixture.slot.style.fontFamily = "serif";
    const original = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains("qg-slot-overflow")) {
          const probe = this.parentElement;
          const style = probe === null ? undefined : getComputedStyle(probe);
          return rect(
            probe?.parentElement === fixture.actions &&
              style?.letterSpacing === "3px" &&
              style.fontFamily === "serif"
              ? 48
              : 30,
          );
        }
        return original.call(this);
      });
    const before = fixture.actions.children.length;
    const metrics = measureStripGeometry(fixture.slot, 12);
    expect(metrics.chipWidths[12]).toBe(48);
    expect(fitMeasuredHeaderTokens(108, 12, 28, 4, (n) => metrics.chipWidths[n]).visibleCount).toBe(
      1,
    );
    expect(fixture.actions.children.length).toBe(before);
    fixture.slot.style.letterSpacing = "0px";
    expect(measureStripGeometry(fixture.slot, 12).chipWidths[12]).toBe(30);
    spy.mockRestore();
  });
  it("counts visible in-flow layout siblings and their gap rather than assuming three children", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    fixture.layout.style.gap = "10px";
    const extra = document.createElement("div");
    setWidth(extra, 40);
    fixture.layout.append(extra);
    const hidden = document.createElement("div");
    hidden.style.display = "none";
    fixture.layout.append(hidden);
    expect(measureHeaderBudget(fixture.slot)).toBe(312);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (value) => budgets.push(value));
    setWidth(extra, 60);
    resize(extra);
    expect(budgets.at(-1)).toBe(292);
    observer.dispose();
  });
  it("uses a conservative budget until an intrinsic title becomes measurable", async () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    fixture.layout.querySelector(".session-header-title")?.remove();
    const title = document.createElement("div");
    title.className = "session-header-title";
    fixture.layout.insertBefore(title, fixture.actions);
    fixture.actions.style.gap = "8px";
    fixture.actions.style.marginLeft = "2px";
    setWidth(title, 150);
    expect(measureHeaderBudget(fixture.slot)).toBe(0);
    setWidth(title, 0);
    expect(measureHeaderBudget(fixture.slot)).toBe(0);
    title.remove();
    expect(measureHeaderBudget(fixture.slot)).toBe(0);
    fixture.layout.insertBefore(title, fixture.actions);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (value) => budgets.push(value));
    const container = document.createElement("div");
    container.className = "session-header-title-measure";
    const span = document.createElement("span");
    setWidth(span, 150);
    container.append(span);
    title.append(container);
    await flushMutations();
    expect(budgets.at(-1)).toBe(332);
    expect(ControlledResizeObserver.instances[0]?.observed.has(span)).toBe(true);
    observer.dispose();
  });
  it("does not guess an unmeasurable overflow width and preserves a single fallback chip", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    const metrics = measureStripGeometry(fixture.slot, 12);
    expect(metrics.chipWidths[12]).toBeUndefined();
    expect(fitMeasuredHeaderTokens(70, 12, 28, 4, () => undefined)).toEqual({
      visibleCount: 0,
      hiddenCount: 12,
      overflowVisible: true,
    });
  });
  it("fits measured multi-digit chips, retains a narrow fallback and has no token cap", () => {
    const widths = (hidden: number) => (hidden >= 10 ? 44 : 30);
    expect(fitMeasuredHeaderTokens(108, 12, 28, 4, widths)).toEqual({
      visibleCount: 2,
      hiddenCount: 10,
      overflowVisible: true,
    });
    expect(fitMeasuredHeaderTokens(0, 12, 28, 4, widths)).toEqual({
      visibleCount: 0,
      hiddenCount: 12,
      overflowVisible: true,
    });
    expect(fitMeasuredHeaderTokens(2000, 50, 28, 4, widths).visibleCount).toBe(50);
  });
  it("reserves the intrinsic host title and computed spacing and observes title changes", () => {
    const fixture = headerFixture();
    fixtures.push(fixture.layout);
    fixture.layout.querySelector(".session-header-title")?.remove();
    const title = document.createElement("div");
    title.className = "session-header-title";
    const measure = document.createElement("div");
    measure.className = "session-header-title-measure";
    const span = document.createElement("span");
    measure.append(span);
    title.append(measure);
    fixture.layout.insertBefore(title, fixture.actions);
    fixture.layout.style.gap = "10px";
    fixture.actions.style.gap = "6px";
    setWidth(span, 240);
    const budgets: number[] = [];
    const observer = observeHeaderBudget(fixture.slot, (value) => budgets.push(value));
    expect(budgets.at(-1)).toBe(226);
    setWidth(span, 300);
    resize(span);
    expect(budgets.at(-1)).toBe(166);
    observer.dispose();
  });
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
