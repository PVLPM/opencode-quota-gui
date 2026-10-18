import type { JSX } from "solid-js";
import { createSignal, For } from "solid-js";
import { CloseIcon } from "./icons";

/**
 * Dashboard toasts (design spec §10).
 *
 * Reserved for meaningful events only — save success, save failure, and SSE
 * disconnect/reconnect. Invalidation events never toast: a busy workspace would
 * produce a stream of them and say nothing.
 */

export type ToastTone = "success" | "error" | "info";

export interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

export interface Toaster {
  toasts: () => Toast[];
  push: (tone: ToastTone, message: string) => void;
  dismiss: (id: number) => void;
}

const DISMISS_AFTER_MS = 6000;

export function createToaster(): Toaster {
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  let nextId = 1;

  return {
    toasts,
    push(tone, message) {
      const id = nextId++;
      setToasts((current) => [...current, { id, tone, message }]);
      // Only meaningful events reach here, so a short life keeps them from piling up.
      setTimeout(() => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      }, DISMISS_AFTER_MS);
    },
    dismiss(id) {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    },
  };
}

export function ToastRegion(props: { toaster: Toaster }): JSX.Element {
  return (
    <div class="qg-toasts" aria-live="polite" aria-atomic="false">
      <For each={props.toaster.toasts()}>
        {(toast) => (
          <div
            class="qg-toast"
            data-tone={toast.tone}
            role={toast.tone === "error" ? "alert" : "status"}
          >
            <span>{toast.message}</span>
            <button
              type="button"
              class="qg-eye"
              aria-label="Dismiss"
              title="Dismiss"
              onClick={() => props.toaster.dismiss(toast.id)}
            >
              <CloseIcon />
            </button>
          </div>
        )}
      </For>
    </div>
  );
}
