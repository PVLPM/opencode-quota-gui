/**
 * Viewport-aware placement for the native disclosure surfaces (Stage 4).
 *
 * The browser build delegates this to the public UI library's popover. The
 * Desktop bundle cannot load that library, so the same contract is expressed
 * as one pure function: prefer the requested side, flip when the content does
 * not fit, shift on the cross axis to stay inside the viewport, and report the
 * height still available so a short window caps the content instead of
 * clipping it. Keeping the geometry pure makes it testable without a DOM.
 */

export type Placement = "bottom" | "bottom-start" | "bottom-end" | "top" | "top-start" | "top-end";

export interface Rect {
  /** Distance from the viewport's left edge, in CSS pixels. */
  left: number;
  /** Distance from the viewport's top edge, in CSS pixels. */
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface PlacementInput {
  /** The trigger's viewport rectangle. */
  anchor: Rect;
  /** The content's measured size, before any cap. */
  content: Size;
  /** The layout viewport (`window.innerWidth`/`innerHeight`). */
  viewport: Size;
  placement: Placement;
  /** Space between the anchor and the content. */
  gutter: number;
  /** Minimum space kept from every viewport edge. */
  shift: number;
}

export interface PlacementResult {
  left: number;
  top: number;
  side: "top" | "bottom";
  /**
   * Set only when the content is taller than the space on its side. The caller
   * uses it as `max-height` so the overflow scrolls instead of being cut off.
   */
  maxHeight?: number;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/** Where the content lands, in fixed-position viewport coordinates. */
export function placePopover(input: PlacementInput): PlacementResult {
  const { anchor, content, viewport, placement, gutter, shift } = input;
  const preferred: "top" | "bottom" = placement.startsWith("top") ? "top" : "bottom";

  const belowTop = anchor.top + anchor.height + gutter;
  const aboveTop = anchor.top - gutter - content.height;
  const spaceBelow = viewport.height - shift - belowTop;
  const spaceAbove = anchor.top - gutter - shift;

  const fitsBelow = content.height <= spaceBelow;
  const fitsAbove = content.height <= spaceAbove;
  let side = preferred;
  if (preferred === "bottom" && !fitsBelow && fitsAbove) side = "top";
  else if (preferred === "top" && !fitsAbove && fitsBelow) side = "bottom";
  else if (!fitsBelow && !fitsAbove) side = spaceBelow >= spaceAbove ? "bottom" : "top";

  const available = side === "bottom" ? spaceBelow : spaceAbove;
  const maxHeight = content.height > available ? Math.max(available, 0) : undefined;

  // A clipped content keeps its anchored edge: below the trigger it grows down,
  // above it the bottom edge stays put and the top moves up.
  let top: number;
  if (side === "bottom") {
    top = belowTop;
  } else {
    top = maxHeight === undefined ? aboveTop : anchor.top - gutter - maxHeight;
  }
  top = clamp(
    top,
    shift,
    Math.max(shift, viewport.height - shift - Math.min(content.height, Math.max(available, 0))),
  );

  let left: number;
  if (placement.endsWith("-start")) left = anchor.left;
  else if (placement.endsWith("-end")) left = anchor.left + anchor.width - content.width;
  else left = anchor.left + (anchor.width - content.width) / 2;

  left = clamp(left, shift, Math.max(shift, viewport.width - shift - content.width));

  return maxHeight === undefined ? { left, top, side } : { left, top, side, maxHeight };
}
