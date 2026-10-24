import { reorderedCardOrder } from "./settings-model";

export interface SortableCardNodes {
  slot: HTMLElement;
  card: HTMLElement;
  grip: HTMLButtonElement;
}

type PointerSample = Pick<PointerEvent, "pointerId" | "clientX" | "clientY" | "preventDefault">;
interface SorterOptions {
  ids(): readonly string[];
  nodes(id: string): SortableCardNodes | undefined;
  container(): HTMLElement | undefined;
  enabled(): boolean;
  preview(ids: string[] | undefined): void;
  active(id: string | undefined): void;
  commit(ids: string[], movedId: string): void;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (id: number) => void;
  reducedMotion?: () => boolean;
}

interface Drag {
  id: string;
  pointerId: number;
  original: string[];
  order: string[];
  nodes: SortableCardNodes;
  container: HTMLElement;
  rect: DOMRect;
  startX: number;
  startY: number;
  x: number;
  y: number;
  lifted: boolean;
}

/** Pointer mechanics only. Preview never edits settings; only a completed drop commits. */
export function createCardSorter(options: SorterOptions) {
  const request = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
  const reduced =
    options.reducedMotion ??
    (() =>
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  let drag: Drag | undefined;
  let frame: number | undefined;
  const animations = new Map<HTMLElement, Animation>();

  function animateReflow(
    before: Map<string, number>,
    ids: readonly string[],
    liftedId?: string,
  ): void {
    if (reduced()) return;
    for (const id of ids) {
      if (id === liftedId) continue;
      const nodes = options.nodes(id);
      const previous = before.get(id);
      if (!nodes || previous === undefined) continue;
      const delta = previous - nodes.slot.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) continue;
      animations.get(nodes.card)?.cancel();
      const animation = nodes.card.animate?.(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
      if (animation) animations.set(nodes.card, animation);
    }
  }

  function positions(ids: readonly string[]): Map<string, number> {
    return new Map(
      ids.flatMap((id) => {
        const node = options.nodes(id);
        return node ? [[id, node.card.getBoundingClientRect().top] as const] : [];
      }),
    );
  }

  function cleanup(current: Drag): void {
    for (const property of [
      "position",
      "top",
      "left",
      "width",
      "z-index",
      "transform",
      "pointer-events",
    ]) {
      current.nodes.card.style.removeProperty(property);
    }
    current.nodes.slot.style.removeProperty("height");
    options.active(undefined);
    if (current.container.hasPointerCapture?.(current.pointerId)) {
      current.container.releasePointerCapture(current.pointerId);
    }
    queueMicrotask(() => {
      if (current.nodes.grip.isConnected !== false)
        current.nodes.grip.focus?.({ preventScroll: true });
    });
    if (typeof window !== "undefined") {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", onEscapeKey);
    }
  }

  function finish(commit: boolean): void {
    const current = drag;
    if (!current) return;
    drag = undefined; // Releasing capture fires lostpointercapture; it must be a no-op.
    if (frame !== undefined) cancelFrame(frame);
    frame = undefined;
    const before = positions(current.order);
    if (
      commit &&
      current.lifted &&
      current.order.some((id, index) => id !== current.original[index])
    ) {
      options.commit([...current.order], current.id);
    }
    options.preview(undefined);
    cleanup(current);
    animateReflow(before, options.ids());
  }

  function cancel(): void {
    finish(false);
  }

  function onEscapeKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    cancel();
  }

  function schedule(): void {
    if (frame === undefined) frame = request(tick);
  }

  function tick(): void {
    frame = undefined;
    const current = drag;
    if (!current) return;
    if (!options.enabled() || options.ids().join("\0") !== current.original.join("\0")) {
      cancel();
      return;
    }
    const dx = current.x - current.startX;
    const dy = current.y - current.startY;
    if (!current.lifted && Math.hypot(dx, dy) < 4) return;
    if (!current.lifted) {
      current.lifted = true;
      const style = current.nodes.card.style;
      current.nodes.slot.style.setProperty("height", `${current.rect.height}px`);
      style.setProperty("position", "fixed");
      style.setProperty("top", `${current.rect.top}px`);
      style.setProperty("left", `${current.rect.left}px`);
      style.setProperty("width", `${current.rect.width}px`);
      style.setProperty("z-index", "20");
      style.setProperty("pointer-events", "none");
      options.active(current.id);
    }
    current.nodes.card.style.setProperty("transform", `translate3d(${dx}px, ${dy}px, 0)`);

    // Settings owns its scrollport. Small edge nudges avoid runaway page scrolling.
    const scroll = current.container.closest<HTMLElement>(".qg-settings__scroll");
    let scrolled = false;
    if (scroll) {
      const bounds = scroll.getBoundingClientRect();
      const edge = 40;
      const velocity =
        current.y < bounds.top + edge ? -5 : current.y > bounds.bottom - edge ? 5 : 0;
      const previous = scroll.scrollTop;
      if (velocity) scroll.scrollTop += velocity;
      scrolled = scroll.scrollTop !== previous;
    }
    const center = current.rect.top + dy + current.rect.height / 2;
    const others = current.order.filter((id) => id !== current.id);
    const toIndex = others.filter((id) => {
      const rect = options.nodes(id)?.slot.getBoundingClientRect();
      return rect !== undefined && center > rect.top + rect.height / 2;
    }).length;
    const next = reorderedCardOrder(current.order, current.id, toIndex);
    if (next.some((id, index) => id !== current.order[index])) {
      const before = positions(current.order);
      current.order = next;
      options.preview([...next]);
      animateReflow(before, next, current.id);
    }
    if (scrolled) schedule();
  }

  return {
    down(id: string, event: PointerSample & Pick<PointerEvent, "button" | "isPrimary">): void {
      if (drag || !options.enabled() || event.button !== 0 || event.isPrimary === false) return;
      const nodes = options.nodes(id);
      const container = options.container();
      if (!nodes || !container || !options.ids().includes(id)) return;
      const ids = [...options.ids()];
      drag = {
        id,
        nodes,
        container,
        pointerId: event.pointerId,
        original: ids,
        order: [...ids],
        rect: nodes.card.getBoundingClientRect(),
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        lifted: false,
      };
      container.setPointerCapture(event.pointerId);
      nodes.grip.focus?.({ preventScroll: true });
      event.preventDefault();
      if (typeof window !== "undefined") {
        window.addEventListener("blur", cancel);
        window.addEventListener("resize", cancel);
        window.addEventListener("keydown", onEscapeKey);
      }
    },
    move(event: PointerSample): void {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      event.preventDefault();
      schedule();
    },
    up(event: PointerSample): void {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      // Flush the last movement even if pointerup precedes its RAF.
      if (frame !== undefined) cancelFrame(frame);
      frame = undefined;
      tick();
      finish(true);
    },
    lost(event: Pick<PointerEvent, "pointerId">): void {
      if (event.pointerId === drag?.pointerId) cancel();
    },
    cancel,
    dispose(): void {
      cancel();
      for (const animation of animations.values()) animation.cancel();
      animations.clear();
    },
  };
}
