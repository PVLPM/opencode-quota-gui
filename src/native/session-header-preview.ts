import { type Accessor, createSignal } from "solid-js";

/**
 * Hover/focus disclosure for the `session.header` combined preview (Stage 6).
 *
 * This is deliberately a small standalone controller: no DOM, no transport and
 * no timer while nothing is hovered or focused. A short close delay lets the
 * pointer travel from a token into the preview (and back) without the preview
 * flickering; focus moving between tokens cancels the same delay.
 */

export const PREVIEW_CLOSE_DELAY_MS = 120;

export interface PreviewDisclosure {
  open: Accessor<boolean>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusIn: () => void;
  onFocusOut: () => void;
  onPreviewPointerEnter: () => void;
  onPreviewPointerLeave: () => void;
  onEscape: () => void;
  close: () => void;
  dispose: () => void;
}

export interface PreviewDisclosureOptions {
  delayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * The preview must not outlive its trigger. The host keeps cached timelines
 * mounted while hidden, and the preview lives in a body portal, so an inactive
 * timeline has to close it explicitly. The same rule covers a strip with no
 * complete token (no hover/focus source and no anchor) and an empty card list.
 */
export function previewShouldClose(input: {
  active: boolean;
  hasVisibleToken: boolean;
  cardCount: number;
}): boolean {
  return !input.active || !input.hasVisibleToken || input.cardCount === 0;
}

export function createPreviewDisclosure(options: PreviewDisclosureOptions = {}): PreviewDisclosure {
  const delayMs = options.delayMs ?? PREVIEW_CLOSE_DELAY_MS;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));

  const [open, setOpen] = createSignal(false);
  let tokenHovered = false;
  let focused = false;
  let previewHovered = false;
  let closing: unknown;

  function cancelClose(): void {
    if (closing === undefined) return;
    clearTimer(closing);
    closing = undefined;
  }

  function sync(): void {
    const next = tokenHovered || focused || previewHovered;
    if (next) {
      cancelClose();
      setOpen(true);
      return;
    }
    if (!open() || closing !== undefined) return;
    closing = setTimer(() => {
      closing = undefined;
      if (!tokenHovered && !focused && !previewHovered) setOpen(false);
    }, delayMs);
  }

  function close(): void {
    cancelClose();
    tokenHovered = false;
    focused = false;
    previewHovered = false;
    setOpen(false);
  }

  return {
    open,
    onPointerEnter: () => {
      tokenHovered = true;
      sync();
    },
    onPointerLeave: () => {
      tokenHovered = false;
      sync();
    },
    onFocusIn: () => {
      focused = true;
      sync();
    },
    onFocusOut: () => {
      focused = false;
      sync();
    },
    onPreviewPointerEnter: () => {
      previewHovered = true;
      sync();
    },
    onPreviewPointerLeave: () => {
      previewHovered = false;
      sync();
    },
    onEscape: close,
    close,
    dispose: close,
  };
}
