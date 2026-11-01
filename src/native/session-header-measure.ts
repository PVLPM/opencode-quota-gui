import type { TokenFit } from "./session-header-model.js";

/** Use measured chip widths for each candidate, including digit-boundary changes. */
export function fitMeasuredHeaderTokens(
  available: number,
  count: number,
  tokenWidth: number,
  gap: number,
  chipWidth: (hidden: number) => number | undefined,
): TokenFit {
  const total = Math.max(0, Math.floor(count));
  if (total === 0) return { visibleCount: 0, hiddenCount: 0, overflowVisible: false };
  if (total * tokenWidth + (total - 1) * gap <= available) {
    return { visibleCount: total, hiddenCount: 0, overflowVisible: false };
  }
  for (let visible = total - 1; visible >= 0; visible--) {
    const hidden = total - visible;
    const width = chipWidth(hidden);
    if (
      width !== undefined &&
      Number.isFinite(width) &&
      width > 0 &&
      visible * (tokenWidth + gap) + width <= available
    ) {
      return { visibleCount: visible, hiddenCount: hidden, overflowVisible: true };
    }
  }
  // The single natural-width chip is the only bounded concession to the title.
  // At zero host space it must compete with the title or be clipped by the host;
  // suppressing it would make the overflow inaccessible.
  return { visibleCount: 0, hiddenCount: total, overflowVisible: true };
}

/** Measure in the actual inherited host context, without taking flex space. */
export function measureStripGeometry(
  root: HTMLElement,
  count: number,
): {
  tokenWidth: number;
  gap: number;
  chipWidths: (number | undefined)[];
} {
  const probe = document.createElement("div");
  probe.className = "qg-native qg-slot-strip";
  probe.style.cssText =
    "position:fixed;visibility:hidden;pointer-events:none;inset:auto;max-width:none;width:max-content";
  probe.setAttribute("aria-hidden", "true");
  probe.inert = true;
  const rootStyle = getComputedStyle(root);
  probe.style.font = rootStyle.font;
  probe.style.letterSpacing = rootStyle.letterSpacing;
  probe.style.wordSpacing = rootStyle.wordSpacing;
  probe.style.fontKerning = rootStyle.fontKerning;
  probe.style.fontFeatureSettings = rootStyle.fontFeatureSettings;
  probe.style.fontVariationSettings = rootStyle.fontVariationSettings;
  probe.style.textTransform = rootStyle.textTransform;
  const token = document.createElement("button");
  token.className = "qg-slot-token";
  const chip = document.createElement("button");
  chip.className = "qg-slot-overflow";
  probe.append(token, chip);
  const parent = root.parentElement;
  if (parent === null) return { tokenWidth: 28, gap: 4, chipWidths: [] };
  parent.append(probe);
  const style = getComputedStyle(probe);
  const measuredGap = Number.parseFloat(style.columnGap || style.gap);
  const gap = Number.isFinite(measuredGap) ? measuredGap : 4;
  const tokenWidth = token.getBoundingClientRect().width || 28;
  const chipWidths: (number | undefined)[] = [undefined];
  for (let hidden = 1; hidden <= count; hidden++) {
    chip.textContent = `+${hidden}`;
    const width = chip.getBoundingClientRect().width;
    chipWidths.push(Number.isFinite(width) && width > 0 ? width : undefined);
  }
  probe.remove();
  return { tokenWidth, gap, chipWidths };
}

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
 * is conservative when the host or title cannot be measured.
 */
export function measureHeaderBudget(element: HTMLElement): number {
  const header = closestHeader(element);
  if (header === undefined) return 0;

  const location = header.layout.querySelector(".session-header-location");
  const others = otherActionElements(element, header.actions);
  const title = header.layout.querySelector(".session-header-title-measure > span");
  const titleContainer = header.layout.querySelector(".session-header-title");
  const intrinsicWidth = title instanceof HTMLElement ? title.getBoundingClientRect().width : 0;
  // A rendered title may already have been compressed by our own strip. Using
  // that width would grow the budget as the title shrinks, stealing more space.
  const titleWidth = intrinsicWidth;
  if (Number.isFinite(titleWidth) && titleWidth > 0) {
    const number = (value: string): number => Number.parseFloat(value) || 0;
    const layoutStyle = getComputedStyle(header.layout);
    const actionsStyle = getComputedStyle(header.actions);
    const titleStyle =
      titleContainer instanceof HTMLElement ? getComputedStyle(titleContainer) : undefined;
    const locationStyle = location instanceof HTMLElement ? getComputedStyle(location) : undefined;
    const locationWidth =
      location instanceof HTMLElement ? location.getBoundingClientRect().width : 0;
    const layoutGap = number(layoutStyle.columnGap || layoutStyle.gap);
    const actionGap = number(actionsStyle.columnGap || actionsStyle.gap);
    const layoutChildren = [...header.layout.children].filter((child): child is HTMLElement => {
      if (!(child instanceof HTMLElement)) return false;
      const style = getComputedStyle(child);
      return (
        style.display !== "none" && style.position !== "absolute" && style.position !== "fixed"
      );
    });
    const extraWidth = layoutChildren.reduce((sum, child) => {
      if (
        child.contains(header.actions) ||
        child.contains(title) ||
        (location && child.contains(location))
      )
        return sum;
      const style = getComputedStyle(child);
      return (
        sum +
        child.getBoundingClientRect().width +
        number(style.marginLeft) +
        number(style.marginRight)
      );
    }, 0);
    return Math.max(
      0,
      Math.floor(
        header.layout.getBoundingClientRect().width -
          locationWidth -
          titleWidth -
          others.reduce(
            (sum, child) =>
              sum +
              child.getBoundingClientRect().width +
              number(getComputedStyle(child).marginLeft) +
              number(getComputedStyle(child).marginRight),
            0,
          ) -
          layoutGap * Math.max(0, layoutChildren.length - 1) -
          extraWidth -
          actionGap * others.length -
          number(actionsStyle.marginLeft) -
          number(actionsStyle.marginRight) -
          number(locationStyle?.marginLeft ?? "") -
          number(locationStyle?.marginRight ?? "") -
          number(titleStyle?.marginLeft ?? "") -
          number(titleStyle?.marginRight ?? "") -
          (intrinsicWidth > 0 ? number(titleStyle?.paddingLeft ?? "") : 0) -
          (intrinsicWidth > 0 ? number(titleStyle?.paddingRight ?? "") : 0) -
          number(layoutStyle.paddingLeft) -
          number(layoutStyle.paddingRight) -
          number(actionsStyle.paddingLeft) -
          number(actionsStyle.paddingRight),
      ),
    );
  }
  return 0;
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
  const observedTitles = new Set<HTMLElement>();
  const observedLayoutExtras = new Set<HTMLElement>();

  const measure = (): void => {
    onBudget(measureHeaderBudget(element));
  };

  const syncObservedSiblings = (): void => {
    if (resizeObserver === undefined) return;
    const header = closestHeader(element);
    if (header === undefined) return;
    const location = header.layout.querySelector(".session-header-location");
    const titleMeasure = header.layout.querySelector(".session-header-title-measure > span");
    const titleContainer = header.layout.querySelector(".session-header-title");
    const extras = new Set(
      [...header.layout.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          !child.contains(header.actions) &&
          !child.contains(titleMeasure) &&
          !child.contains(titleContainer) &&
          !(location && child.contains(location)),
      ),
    );
    for (const extra of observedLayoutExtras) {
      if (extras.has(extra)) continue;
      resizeObserver.unobserve(extra);
      observedLayoutExtras.delete(extra);
    }
    for (const extra of extras) {
      if (observedLayoutExtras.has(extra)) continue;
      resizeObserver.observe(extra);
      observedLayoutExtras.add(extra);
    }
    const titles = new Set(
      [
        ...header.layout.querySelectorAll(
          ".session-header-title, .session-header-title-measure > span",
        ),
      ].filter((item): item is HTMLElement => item instanceof HTMLElement),
    );
    for (const title of observedTitles) {
      if (titles.has(title)) continue;
      resizeObserver.unobserve(title);
      observedTitles.delete(title);
    }
    for (const title of titles) {
      if (observedTitles.has(title)) continue;
      resizeObserver.observe(title);
      observedTitles.add(title);
    }
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
      mutationObserver.observe(header.layout, {
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
