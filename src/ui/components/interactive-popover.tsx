import type { Component, JSX } from "solid-js";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { loadPopover } from "../opencode-ui";

/**
 * The dashboard's one interactive disclosure surface.
 *
 * Hover and keyboard focus preview the content; a click pins it so the pointer
 * can travel into the popover, scroll it, and use its controls. Outside
 * pointerdown, Escape, and opening another disclosure close it. The public
 * `Popover` supplies viewport-aware placement; the wrapper adds no polling.
 */

const CLOSE_DELAY_MS = 140;

interface ActiveDisclosure {
  close: () => void;
  hasFocus: () => boolean;
}

let activeDisclosure: ActiveDisclosure | undefined;

export interface InteractivePopoverProps {
  /** Accessible name for the trigger; the visual content stays decorative. */
  label: string;
  /** Accessible name for the dialog; defaults to the trigger label. */
  panelLabel?: string;
  triggerClass?: string;
  contentClass?: string;
  placement?: "bottom" | "bottom-start" | "bottom-end" | "top" | "top-start" | "top-end";
  content: JSX.Element;
  children: JSX.Element;
}

interface LibraryPopoverProps {
  triggerAs?: string;
  trigger?: JSX.Element;
  triggerProps?: Record<string, unknown>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  placement?: string;
  gutter?: number;
  shift?: number;
  fitViewport?: boolean;
  flip?: boolean;
  class?: string;
  children?: JSX.Element;
}

type LibraryPopover = Component<LibraryPopoverProps>;

export function InteractivePopover(props: InteractivePopoverProps): JSX.Element {
  const [Popover, setPopover] = createSignal<LibraryPopover>();
  const [open, setOpen] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  onMount(() => {
    void loadPopover().then((module) => {
      setPopover(() => module.Popover as LibraryPopover);
    });
  });
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let ignoreToggle = false;
  let switchingFocus = false;
  let triggerElement: HTMLButtonElement | undefined;
  let contentElement: HTMLDivElement | undefined;
  let openReason: "hover" | "focus" | "click" | undefined;
  let suppressFocusOpenUntil = 0;

  /**
   * Hover is a preview, not a request to move keyboard focus. Kobalte's focus
   * scope asks the dialog before its automatic focus; cancel only that
   * automatic focus. The event does not bubble, so a document capture listener
   * catches it before the queued focus lands inside the content.
   */
  function onFocusScopeMount(event: Event): void {
    if (openReason !== "hover" || pinned() || !contentElement) return;
    const panel = contentElement.closest('[data-component="popover-content"]');
    if (panel === null || event.target !== panel) return;
    event.preventDefault();
  }

  onMount(() => {
    document.addEventListener("focusScope.autoFocusOnMount", onFocusScopeMount, true);
  });

  function setContentElement(element: HTMLDivElement | undefined): void {
    contentElement = element;
    if (element === undefined) return;
    // Kobalte names the dialog from a title it renders only when one is given.
    // This content is relayed by the trigger label, so give the dialog that
    // same name when no title element exists.
    queueMicrotask(() => {
      const panel = contentElement?.closest<HTMLElement>('[role="dialog"]');
      if (panel === undefined || panel === null) return;
      const labelledBy = panel.getAttribute("aria-labelledby");
      if (labelledBy !== null && document.getElementById(labelledBy) !== null) return;
      panel.removeAttribute("aria-labelledby");
      panel.setAttribute("aria-label", props.panelLabel ?? props.label);
    });
  }

  function clearClose(): void {
    if (closeTimer === undefined) return;
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function hasFocus(): boolean {
    return (
      (triggerElement !== undefined && document.activeElement === triggerElement) ||
      contentElement?.contains(document.activeElement) === true
    );
  }

  function closeNow(): void {
    clearClose();
    setOpen(false);
    setPinned(false);
    // Closing returns focus to the trigger; that restore must not read as a
    // fresh keyboard request to open the same disclosure again.
    suppressFocusOpenUntil = Date.now() + 300;
    if (activeDisclosure?.close === closeNow) activeDisclosure = undefined;
  }

  function openNow(reason: "hover" | "focus" | "click"): void {
    clearClose();
    if (open()) return;
    const previous = activeDisclosure;
    if (previous !== undefined && previous.close !== closeNow) {
      // Move focus to this trigger before the previous panel unmounts. The
      // previous panel then dismisses as an outside focus change and skips its
      // own focus restore, which would otherwise close this new panel.
      if (previous.hasFocus() && triggerElement !== undefined) {
        switchingFocus = true;
        triggerElement.focus({ preventScroll: true });
        switchingFocus = false;
      }
      previous.close();
    }
    openReason = reason;
    activeDisclosure = { close: closeNow, hasFocus };
    setOpen(true);
  }

  function scheduleClose(): void {
    if (pinned()) return;
    if (triggerElement !== undefined && document.activeElement === triggerElement) return;
    if (contentElement?.contains(document.activeElement)) return;
    clearClose();
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (!pinned()) closeNow();
    }, CLOSE_DELAY_MS);
  }

  function onOpenChange(next: boolean): void {
    if (ignoreToggle) {
      ignoreToggle = false;
      return;
    }
    if (next) {
      setPinned(true);
      openNow("click");
      return;
    }
    closeNow();
  }

  function onTriggerClick(): void {
    // Kobalte's trigger always toggles after this handler. A hover-open click
    // should pin, not close, so suppress exactly that synthetic toggle.
    ignoreToggle = true;
    queueMicrotask(() => {
      ignoreToggle = false;
    });
    if (pinned()) {
      closeNow();
      return;
    }
    setPinned(true);
    openNow("click");
  }

  onCleanup(() => {
    clearClose();
    document.removeEventListener("focusScope.autoFocusOnMount", onFocusScopeMount, true);
    if (activeDisclosure?.close === closeNow) activeDisclosure = undefined;
  });

  return (
    <Show
      when={Popover()}
      fallback={
        <button
          type="button"
          class={props.triggerClass}
          aria-label={props.label}
          aria-haspopup="dialog"
          aria-expanded="false"
        >
          {props.children}
        </button>
      }
    >
      {(component) => (
        <Dynamic
          component={component()}
          triggerAs="button"
          trigger={props.children}
          triggerProps={{
            type: "button",
            class: props.triggerClass,
            "aria-label": props.label,
            "aria-haspopup": "dialog",
            onPointerEnter: (event: PointerEvent & { currentTarget: HTMLButtonElement }) => {
              triggerElement = event.currentTarget;
              openNow("hover");
            },
            onPointerLeave: () => scheduleClose(),
            onFocus: (event: FocusEvent & { currentTarget: HTMLButtonElement }) => {
              triggerElement = event.currentTarget;
              if (switchingFocus || Date.now() < suppressFocusOpenUntil) return;
              openNow("focus");
            },
            onBlur: () => {
              requestAnimationFrame(() => {
                if (pinned()) return;
                if (contentElement?.contains(document.activeElement)) return;
                if (triggerElement?.matches(":hover")) return;
                scheduleClose();
              });
            },
            onClick: () => onTriggerClick(),
          }}
          open={open()}
          onOpenChange={onOpenChange}
          placement={props.placement ?? "bottom-start"}
          gutter={6}
          shift={8}
          fitViewport
          flip
          class={props.contentClass}
        >
          <div
            ref={setContentElement}
            class="qg-interactive-popover__content"
            onPointerEnter={() => clearClose()}
            onPointerLeave={() => scheduleClose()}
          >
            {props.content}
          </div>
        </Dynamic>
      )}
    </Show>
  );
}
