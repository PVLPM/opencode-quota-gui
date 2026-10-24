import { describe, expect, it, vi } from "vitest";
import { createCardSorter } from "../src/ui/sortable-cards";

function rig(reducedMotion = false) {
  const original = ["anthropic:a", "openrouter:a", "anthropic:b"];
  let order = [...original];
  let active: string | undefined;
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const commits = vi.fn();
  const node = (id: string) => ({
    style: { setProperty: vi.fn(), removeProperty: vi.fn() },
    getBoundingClientRect: () => ({
      top: order.indexOf(id) * 100,
      bottom: order.indexOf(id) * 100 + 90,
      left: 20,
      width: 400,
      height: 90,
    }),
    animate: vi.fn(() => ({ cancel: vi.fn() })),
    focus: vi.fn(),
  });
  const nodes = new Map(
    original.map((id) => [id, { slot: node(id), card: node(id), grip: node(id) }]),
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
    order: () => order,
    active: () => active,
  };
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
      "fixed",
    );
    expect(r.nodes.get("openrouter:a")?.card.animate).toHaveBeenCalled();
    expect(r.commits).not.toHaveBeenCalled();
    r.sorter.up(r.event(225));
    expect(r.commits).toHaveBeenCalledTimes(1);
    expect(r.commits).toHaveBeenCalledWith(
      ["openrouter:a", "anthropic:b", "anthropic:a"],
      "anthropic:a",
    );
    expect(r.capture.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(r.active()).toBeUndefined();
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
  });

  it("ignores other pointers and a click without movement never changes the draft", () => {
    const r = rig();
    r.sorter.down("anthropic:a", r.event(20));
    r.sorter.move({ ...r.event(225), pointerId: 2 });
    r.sorter.up(r.event(20));
    expect(r.commits).not.toHaveBeenCalled();
    expect(r.order()).toEqual(r.original);
  });

  it("coalesces pointer moves into one frame and suppresses FLIP for reduced motion", () => {
    const r = rig(true);
    r.sorter.down("anthropic:a", r.event(20));
    for (const y of [150, 180, 225]) r.sorter.move(r.event(y));
    expect(r.frames.size).toBe(1);
    r.flush();
    expect(r.order()).toEqual(["openrouter:a", "anthropic:b", "anthropic:a"]);
    expect(r.nodes.get("openrouter:a")?.card.animate).not.toHaveBeenCalled();
    r.sorter.dispose();
    expect(r.commits).not.toHaveBeenCalled();
    expect(r.order()).toEqual(r.original);
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

  it("handles Escape globally when moving the captured card temporarily removes focus", () => {
    const listeners = new Map<string, (event: { key: string; preventDefault(): void }) => void>();
    vi.stubGlobal("window", {
      addEventListener: (
        name: string,
        listener: (event: { key: string; preventDefault(): void }) => void,
      ) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name),
    });
    const r = rig();
    try {
      r.sorter.down("anthropic:a", r.event(20));
      r.sorter.move(r.event(225));
      r.flush();
      listeners.get("keydown")?.({ key: "Escape", preventDefault: () => {} });
      expect(r.order()).toEqual(r.original);
      expect(r.commits).not.toHaveBeenCalled();
      expect(listeners.size).toBe(0);
    } finally {
      r.sorter.dispose();
      vi.unstubAllGlobals();
    }
  });
});
