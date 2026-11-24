import { describe, expect, it, vi } from "vitest";
import { createCardSorter } from "../src/ui/sortable-cards";

/**
 * Layout-aware stand-in for the real DOM.
 *
 * Each card has a layout slot (top = 100px × position) and an optional inline
 * transform. Rectangles are reported in viewport pixels, including a host
 * offset and scale, which is what an embedded host's transform does. The
 * controller must place the card at the same viewport point the pointer is
 * holding, so cardTop() below includes both the host mapping and the transform.
 */
function rig(reducedMotion = false) {
  const original = ["anthropic:a", "openrouter:a", "anthropic:b"];
  let order = [...original];
  let active: string | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const commits = vi.fn();
  const host = { left: 0, top: 0, scale: 1 };
  let reflectTransform = true;
  const declarations = new Map<string, Map<string, string>>();

  const styleFor = (key: string) => {
    let values = declarations.get(key);
    if (values === undefined) {
      values = new Map<string, string>();
      declarations.set(key, values);
    }
    return {
      setProperty: vi.fn((name: string, value: string) => values.set(name, value)),
      removeProperty: vi.fn((name: string) => values.delete(name)),
    };
  };
  const translateFor = (id: string) => {
    const raw = declarations.get(`${id}:card`)?.get("transform") ?? "";
    const found = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/u.exec(raw);
    return { x: found ? Number(found[1]) : 0, y: found ? Number(found[2]) : 0 };
  };
  const layoutTop = (id: string) => host.top + order.indexOf(id) * 100 * host.scale;
  const cardTop = (id: string) => layoutTop(id) + translateFor(id).y * host.scale;
  const cardRect = (id: string) => {
    const translate = reflectTransform ? translateFor(id) : { x: 0, y: 0 };
    return {
      top: layoutTop(id) + translate.y * host.scale,
      bottom: layoutTop(id) + translate.y * host.scale + 90 * host.scale,
      left: host.left + (20 + translate.x) * host.scale,
      width: 400 * host.scale,
      height: 90 * host.scale,
    };
  };
  const slotRect = (id: string) => ({
    top: layoutTop(id),
    bottom: layoutTop(id) + 90 * host.scale,
    left: host.left + 20 * host.scale,
    width: 400 * host.scale,
    height: 90 * host.scale,
  });
  const node = (id: string, kind: "slot" | "card" | "grip") => ({
    style: styleFor(`${id}:${kind}`),
    offsetWidth: kind === "grip" ? 24 : 400,
    offsetHeight: kind === "grip" ? 28 : 90,
    getBoundingClientRect: () =>
      kind === "slot"
        ? slotRect(id)
        : kind === "card"
          ? cardRect(id)
          : { ...cardRect(id), top: cardRect(id).top + 10, height: 28, width: 24 },
    animate: vi.fn(() => ({ cancel: vi.fn() })),
    focus: vi.fn(),
    isConnected: true,
  });
  const nodes = new Map(
    original.map((id) => [
      id,
      { slot: node(id, "slot"), card: node(id, "card"), grip: node(id, "grip") },
    ]),
  );
  const capture = {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
    closest: () => null,
  };
  const sorter = createCardSorter({
    ids: () => original,
    nodes: (id) => nodes.get(id) as never,
    container: () => capture as never,
    enabled: () => true,
    preview: (ids) => {
      order = ids === undefined ? [...original] : ids;
    },
    active: (id) => {
      active = id;
    },
    commit: commits,
    requestFrame: (callback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    reducedMotion: () => reducedMotion,
  });
  const event = (y: number) => ({
    pointerId: 1,
    button: 0,
    isPrimary: true,
    clientX: 40,
    clientY: y,
    preventDefault: vi.fn(),
  });
  const flush = () => {
    const current = [...frames.values()];
    frames.clear();
    for (const callback of current) callback(16);
  };
  return {
    sorter,
    original,
    nodes,
    capture,
    commits,
    event,
    flush,
    frames,
    host,
    order: () => order,
    active: () => active,
    cardTop,
    transform: (id: string) => declarations.get(`${id}:card`)?.get("transform"),
    /** Report only the layout box, as a DOM that has not applied the inline transform yet. */
    ignoreTransformInRects: () => {
      reflectTransform = false;
    },
  };
}

/** Stub a window that records both bubbling and capture-phase listeners. */
function stubWindow() {
  const listeners = new Map<
    string,
    { listener: (event: unknown) => void; capture: boolean | undefined }
  >();
  vi.stubGlobal("window", {
    addEventListener: (
      name: string,
      listener: (event: unknown) => void,
      capture?: boolean | { capture?: boolean },
    ) => {
      listeners.set(name, {
        listener,
        capture: typeof capture === "boolean" ? capture : capture?.capture,
      });
    },
    removeEventListener: (name: string) => listeners.delete(name),
  });
  return listeners;
}

describe("whole-card pointer sorting controller", () => {
  it("captures from the stable list and reflows siblings before committing once on drop", () => {
    const r = rig();
    r.sorter.down("anthropic:a", r.event(20));
    expect(r.capture.setPointerCapture).toHaveBeenCalledWith(1);
    r.sorter.move(r.event(225));
    expect(r.commits).not.toHaveBeenCalled();
    r.flush();
    expect(r.active()).toBe("anthropic:a");
    expect(r.order()).toEqual(["openrouter:a", "anthropic:b", "anthropic:a"]);
    expect(r.nodes.get("anthropic:a")?.card.style.setProperty).toHaveBeenCalledWith(
      "position",
      "relative",
    );
    // The card is never taken out of flow: a viewport-fixed preview resolves
    // against a transformed host ancestor and lands away from the pointer.
    expect(r.nodes.get("anthropic:a")?.card.style.setProperty).not.toHaveBeenCalledWith(
      "position",
      "fixed",
    );
    expect(r.nodes.get("openrouter:a")?.card.animate).toHaveBeenCalled();
    // Grab point was 20px into the card; after the preview moves the slot the
    // rendered top still holds the pointer, not the slot's new position.
    expect(r.cardTop("anthropic:a")).toBeCloseTo(205);
    expect(r.transform("anthropic:a")).toBe("translate3d(0px, 5px, 0)");
    expect(r.commits).not.toHaveBeenCalled();
    r.sorter.up(r.event(225));
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(r.commits).toHaveBeenCalledWith(
      ["openrouter:a", "anthropic:b", "anthropic:a"],
      "anthropic:a",
    );
    expect(r.capture.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(r.active()).toBeUndefined();
    expect(r.transform("anthropic:a")).toBeUndefined();
  });

  it("reorders from the grab geometry when a DOM rect omits the inline transform", () => {
    const r = rig();
    // A DOM or test double may report only the layout box, without the inline
    // transform. The preview's visual top is pointer - grabOffset regardless,
    // so the reorder test must not depend on reading that transform back.
    r.ignoreTransformInRects();
    r.sorter.down("anthropic:a", r.event(20));
    r.sorter.move(r.event(225));
    r.flush();
    expect(r.active()).toBe("anthropic:a");
    expect(r.order()).toEqual(["openrouter:a", "anthropic:b", "anthropic:a"]);
    r.sorter.up(r.event(225));
    expect(r.commits).toHaveBeenCalledWith(
      ["openrouter:a", "anthropic:b", "anthropic:a"],
      "anthropic:a",
    );
  });

  it.each([
    "cancel",
    "lost",
  ])("restores original order and cancels outstanding RAF on %s", (method) => {
    const r = rig();
    r.sorter.down("anthropic:a", r.event(20));
    r.sorter.move(r.event(225));
    r.flush();
    r.sorter.move(r.event(230));
    if (method === "lost") r.sorter.lost(r.event(230));
    else r.sorter.cancel();
    expect(r.order()).toEqual(r.original);
    expect(r.commits).not.toHaveBeenCalled();
    expect(r.frames.size).toBe(0);
    expect(r.active()).toBeUndefined();
    expect(r.transform("anthropic:a")).toBeUndefined();
    expect(r.cardTop("anthropic:a")).toBeCloseTo(0);
  });

  it("ignores other pointers and a click without movement never changes the draft", () => {
    const r = rig();
    r.sorter.down("anthropic:a", r.event(20));
    r.sorter.move({ ...r.event(225), pointerId: 2 });
    r.sorter.up(r.event(20));
    expect(r.commits).not.toHaveBeenCalled();
    expect(r.order()).toEqual(r.original);
    expect(r.transform("anthropic:a")).toBeUndefined();
  });

  it("coalesces pointer moves into one frame and suppresses FLIP for reduced motion", () => {
    const r = rig(true);
    r.sorter.down("anthropic:a", r.event(20));
    for (const y of [150, 180, 225]) r.sorter.move(r.event(y));
    expect(r.frames.size).toBe(1);
    r.flush();
    expect(r.order()).toEqual(["openrouter:a", "anthropic:b", "anthropic:a"]);
    expect(r.nodes.get("openrouter:a")?.card.animate).not.toHaveBeenCalled();
    expect(r.cardTop("anthropic:a")).toBeCloseTo(205);
    r.sorter.dispose();
    expect(r.commits).not.toHaveBeenCalled();
    expect(r.order()).toEqual(r.original);
  });

  it("keeps the grab point under the pointer inside an offset, scaled host", () => {
    const r = rig();
    // An embedded host maps the whole page through a 1.5× transform that starts
    // 300px down. Viewport rects include that mapping; the card's own translate
    // is in local pixels, so the controller must divide the error by the scale.
    r.host.top = 300;
    r.host.left = 10;
    r.host.scale = 1.5;
    const grabY = r.cardTop("anthropic:a") + 40;
    r.sorter.down("anthropic:a", r.event(grabY));
    r.sorter.move(r.event(grabY + 30));
    r.flush();
    expect(r.order()).toEqual(r.original);
    expect(r.cardTop("anthropic:a")).toBeCloseTo(grabY + 30 - 40);
    // 30 viewport pixels of travel at 1.5× is 20 local pixels.
    expect(r.transform("anthropic:a")).toBe("translate3d(0px, 20px, 0)");
    r.sorter.cancel();
  });

  it("uses modest scrollport nudges rather than scrolling the page", () => {
    const r = rig();
    const scroll = { scrollTop: 0, getBoundingClientRect: () => ({ top: 0, bottom: 260 }) };
    r.capture.closest = () => scroll as never;
    r.sorter.down("anthropic:a", r.event(20));
    r.sorter.move(r.event(250));
    r.flush();
    expect(scroll.scrollTop).toBe(5);
    expect(r.frames.size).toBe(1);
    r.sorter.cancel();
    expect(r.frames.size).toBe(0);
    expect(r.commits).not.toHaveBeenCalled();
  });

  it("tracks scroll of any ancestor so the card stays with the pointer", () => {
    const listeners = stubWindow();
    const r = rig();
    try {
      r.sorter.down("anthropic:a", r.event(20));
      r.sorter.move(r.event(60));
      r.flush();
      expect(r.frames.size).toBe(0);
      expect(listeners.get("scroll")?.capture).toBe(true);
      listeners.get("scroll")?.listener({});
      expect(r.frames.size).toBe(1);
      r.sorter.cancel();
      expect(listeners.size).toBe(0);
    } finally {
      r.sorter.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("handles Escape globally when moving the captured card temporarily removes focus", () => {
    const listeners = stubWindow();
    const r = rig();
    try {
      r.sorter.down("anthropic:a", r.event(20));
      r.sorter.move(r.event(225));
      r.flush();
      (
        listeners.get("keydown")?.listener as (event: {
          key: string;
          preventDefault(): void;
        }) => void
      )?.({
        key: "Escape",
        preventDefault: () => {},
      });
      expect(r.order()).toEqual(r.original);
      expect(r.commits).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    } finally {
      r.sorter.dispose();
      vi.unstubAllGlobals();
    }
  });
});
