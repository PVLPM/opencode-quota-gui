import { describe, expect, it } from "vitest";
import { type PlacementInput, placePopover } from "../src/native/popover-position.js";

/**
 * Native disclosure geometry (Stage 4).
 *
 * The Desktop bundle cannot use the public UI library's popover, so the same
 * contract is implemented once as a pure function. These cases pin the parts a
 * side region makes fragile: the preferred side, the flip when the panel is
 * near a viewport edge, the cross-axis shift that keeps a 380px temporal panel
 * inside a narrow window, and the height cap that turns clipping into scrolling.
 */

const VIEWPORT = { width: 800, height: 600 };
const CONTENT = { width: 200, height: 100 };

function input(overrides: Partial<PlacementInput> = {}): PlacementInput {
  return {
    anchor: { left: 100, top: 50, width: 40, height: 28 },
    content: CONTENT,
    viewport: VIEWPORT,
    placement: "bottom-start",
    gutter: 6,
    shift: 8,
    ...overrides,
  };
}

describe("native popover placement", () => {
  it("places bottom-start directly under the trigger", () => {
    expect(placePopover(input())).toEqual({ left: 100, top: 84, side: "bottom" });
  });

  it("aligns bottom-end to the trigger's right edge", () => {
    const result = placePopover(
      input({ anchor: { left: 700, top: 50, width: 40, height: 28 }, placement: "bottom-end" }),
    );
    expect(result.left).toBe(540);
    expect(result.top).toBe(84);
  });

  it("shifts left to stay inside the viewport's right edge", () => {
    const result = placePopover(
      input({ anchor: { left: 780, top: 50, width: 20, height: 28 }, placement: "bottom-end" }),
    );
    expect(result.left).toBe(592);
  });

  it("shifts right at the viewport's left edge", () => {
    const result = placePopover(
      input({ anchor: { left: 0, top: 50, width: 40, height: 28 }, placement: "bottom-start" }),
    );
    expect(result.left).toBe(8);
  });

  it("centres a bare placement on the trigger and clamps it", () => {
    const result = placePopover(input({ placement: "bottom" }));
    expect(result.left).toBe(20);
  });

  it("flips above the trigger when the content does not fit below", () => {
    const result = placePopover(input({ anchor: { left: 100, top: 500, width: 40, height: 28 } }));
    expect(result).toEqual({ left: 100, top: 394, side: "top" });
  });

  it("flips down when a top placement has no room above", () => {
    const result = placePopover(
      input({ anchor: { left: 100, top: 0, width: 40, height: 28 }, placement: "top-start" }),
    );
    expect(result.side).toBe("bottom");
    expect(result.top).toBe(34);
  });

  it("caps the height instead of clipping when neither side fits", () => {
    const result = placePopover(
      input({
        anchor: { left: 100, top: 140, width: 40, height: 20 },
        content: { width: 200, height: 400 },
        viewport: { width: 800, height: 300 },
      }),
    );
    expect(result).toEqual({ left: 100, top: 166, side: "bottom", maxHeight: 126 });
  });

  it("keeps a capped top placement anchored above the trigger", () => {
    const result = placePopover(
      input({
        anchor: { left: 100, top: 500, width: 40, height: 28 },
        content: { width: 200, height: 600 },
        placement: "top-start",
      }),
    );
    expect(result.side).toBe("top");
    expect(result.maxHeight).toBe(486);
    expect(result.top).toBe(8);
  });

  it("never leaves a gap larger than the requested gutter", () => {
    const result = placePopover(input({ placement: "bottom", gutter: 0 }));
    expect(result.top).toBe(78);
  });
});
