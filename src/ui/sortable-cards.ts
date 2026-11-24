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
  /** Pointer position inside the lifted card at grab time, in viewport pixels. */
  offsetX: number;
  offsetY: number;
  /** Rendered card height at grab time; the layout never changes during a drag. */
  height: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  lifted: boolean;
  /** Transform currently applied to the in-flow card; the layout box stays put. */
  translateX: number;
  translateY: number;
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

  /**
   * Move the in-flow card under the pointer with a transform.
   *
   * A viewport-fixed preview assumes its containing block is the viewport. In an
   * embedding host (or any ancestor with a transform/filter/contain/zoom) that
   * assumption is false, and the card lands offset by the ancestor's origin.
   * Instead, the layout box stays in its slot and the transform is corrected
   * against the card's live rect every frame: the viewport error is divided by
   * the rendered scale, so host translation and scaling both cancel out. The
   * same measurement keeps the card attached while a scroll container moves it.
   */
  function followPointer(current: Drag): void {
    const card = current.nodes.card;
    const rect = card.getBoundingClientRect();
    const width = card.offsetWidth;
    const height = card.offsetHeight;
    const scaleX = width > 0 && rect.width > 0 ? rect.width / width : 1;
    const scaleY = height > 0 && rect.height > 0 ? rect.height / height : 1;
    const errorX = (current.x - current.offsetX - rect.left) / scaleX;
    const errorY = (current.y - current.offsetY - rect.top) / scaleY;
    if (Math.abs(errorX) < 0.01 && Math.abs(errorY) < 0.01) return;
    current.translateX += errorX;
    current.translateY += errorY;
    card.style.setProperty(
      "transform",
      `translate3d(${current.translateX}px, ${current.translateY}px, 0)`,
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
      window.removeEventListener("scroll", onScroll, true);
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

  /** Wheel, keyboard, host-panel and auto-scroll all move the in-flow card. */
  function onScroll(): void {
    if (drag?.lifted) schedule();
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
      // A leftover FLIP animation would override the drag transform.
      animations.get(current.nodes.card)?.cancel();
      animations.delete(current.nodes.card);
      const style = current.nodes.card.style;
      style.setProperty("position", "relative");
      style.setProperty("z-index", "20");
      style.setProperty("pointer-events", "none");
      options.active(current.id);
    }

    // Settings owns its scrollport on the Web; the native host owns the pane.
    // Small edge nudges avoid runaway page scrolling.
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
    // After any scroll, re-anchor before the hit test so a nudged frame never
    // shows the card trailing the pointer by the scroll step.
    followPointer(current);
    // The preview's visual top is known from the pointer and the grab offset,
    // so the reorder test does not read back a transformed rect: not every DOM
    // reflects an inline transform immediately, and the layout box never moves.
    const center = current.y - current.offsetY + current.height / 2;
    const others = current.order.filter((id) => id !== current.id);
    const toIndex = others.filter((id) => {
      const slot = options.nodes(id)?.slot.getBoundingClientRect();
      return slot !== undefined && center > slot.top + slot.height / 2;
    }).length;
    const next = reorderedCardOrder(current.order, current.id, toIndex);
    if (next.some((id, index) => id !== current.order[index])) {
      const before = positions(current.order);
      current.order = next;
      options.preview([...next]);
      animateReflow(before, next, current.id);
      // The preview moved the slot; re-attach to the same pointer position.
      followPointer(current);
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
      const rect = nodes.card.getBoundingClientRect();
      drag = {
        id,
        nodes,
        container,
        pointerId: event.pointerId,
        original: ids,
        order: [...ids],
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        height: rect.height,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        lifted: false,
        translateX: 0,
        translateY: 0,
      };
      container.setPointerCapture(event.pointerId);
      nodes.grip.focus?.({ preventScroll: true });
      event.preventDefault();
      if (typeof window !== "undefined") {
        window.addEventListener("blur", cancel);
        window.addEventListener("resize", cancel);
        window.addEventListener("keydown", onEscapeKey);
        window.addEventListener("scroll", onScroll, true);
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
