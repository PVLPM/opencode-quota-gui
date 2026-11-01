import { headerTokenBudget } from "./session-header-model.js";

/**
 * Header-width measurement for the `session.header` Slot (Stage 6).
 *
 * The Slot can only claim the space the host header has left after location,
 * title reserve and every other action. Competing actions can change width
 * without resizing the actions container (a label grows, a button is added, a
 * control is hidden), so the controller observes each sibling action as well as
 * the layout, actions row and location. That keeps the token budget current
 * without polling or a second host-specific layout path.
 */

export interface HeaderBudgetObserver {
  measure: () => void;
  dispose: () => void;
}

/** Direct action children that currently compete with the Slot for width. */
export function otherActionElements(element: HTMLElement, actions: Element): HTMLElement[] {
  return [...actions.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      child !== element &&
      getComputedStyle(child).display !== "none",
  );
}

function closestHeader(
  element: HTMLElement,
): { layout: HTMLElement; actions: HTMLElement } | undefined {
  const layout = element.closest(".session-header-layout");
  const actions = element.closest(".session-header-actions") ?? element.parentElement;
  if (!(layout instanceof HTMLElement) || !(actions instanceof HTMLElement)) return undefined;
  return { layout, actions };
}

/**
 * The width available to the Slot for the current header layout. The fallback
 * mirrors the host-less branch in the Slot: use the widest concrete ancestor
 * rather than inventing a fixed token count.
 */
export function measureHeaderBudget(element: HTMLElement): number {
  const header = closestHeader(element);
  if (header === undefined) {
    const fallback = Math.min(
      window.innerWidth,
      Math.max(0, element.parentElement?.clientWidth ?? window.innerWidth),
    );
    return headerTokenBudget({
      layoutWidth: fallback,
      locationWidth: 0,
      otherActionsWidth: 0,
      otherActionCount: 0,
    });
  }

  const location = header.layout.querySelector(".session-header-location");
  const others = otherActionElements(element, header.actions);
  return headerTokenBudget({
    layoutWidth: header.layout.getBoundingClientRect().width,
    locationWidth: location instanceof HTMLElement ? location.getBoundingClientRect().width : 0,
    otherActionsWidth: others.reduce(
      (total, child) => total + child.getBoundingClientRect().width,
      0,
    ),
    otherActionCount: others.length,
  });
}

/**
 * Keeps `onBudget` current for one mounted Slot root. Resize observation covers
 * the layout, the actions row, the location and every competing sibling;
 * mutations cover siblings being added, removed or restyled anywhere under the
 * actions row. The Slot's own subtree is never a ResizeObserver target, so a
 * budget update cannot feed back into a resize loop. The caller owns disposal.
 */
export function observeHeaderBudget(
  element: HTMLElement,
  onBudget: (budget: number) => void,
): HeaderBudgetObserver {
  let resizeObserver: ResizeObserver | undefined;
  let mutationObserver: MutationObserver | undefined;
  const observedSiblings = new Set<HTMLElement>();

  const measure = (): void => {
    onBudget(measureHeaderBudget(element));
  };

  const syncObservedSiblings = (): void => {
    if (resizeObserver === undefined) return;
    const header = closestHeader(element);
    if (header === undefined) return;
    const current = new Set(otherActionElements(element, header.actions));
    for (const sibling of observedSiblings) {
      if (current.has(sibling)) continue;
      resizeObserver.unobserve(sibling);
      observedSiblings.delete(sibling);
    }
    for (const sibling of current) {
      if (observedSiblings.has(sibling)) continue;
      resizeObserver.observe(sibling);
      observedSiblings.add(sibling);
    }
  };

  const measureAndSync = (): void => {
    syncObservedSiblings();
    measure();
  };

  measureAndSync();
  if (typeof ResizeObserver !== "undefined") {
    const header = closestHeader(element);
    resizeObserver = new ResizeObserver(() => measureAndSync());
    if (header !== undefined) {
      resizeObserver.observe(header.layout);
      resizeObserver.observe(header.actions);
      const location = header.layout.querySelector(".session-header-location");
      if (location instanceof HTMLElement) resizeObserver.observe(location);
    }
    syncObservedSiblings();
  }
  if (typeof MutationObserver !== "undefined") {
    const header = closestHeader(element);
    if (header !== undefined) {
      mutationObserver = new MutationObserver(() => measureAndSync());
      mutationObserver.observe(header.actions, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
    }
  }
  window.addEventListener("resize", measureAndSync);

  return {
    measure: measureAndSync,
    dispose: () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", measureAndSync);
    },
  };
}
