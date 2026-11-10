import type { Attention, Toasts } from "@opencode/plugin/gui";
import type { NativeCacheObserverModelMismatchTransition } from "./cache-observer-runtime.js";

const MAX_REMEMBERED_TRANSITIONS = 128;
const TITLE = "Selected model changed";
const DESCRIPTION =
  "The selected model differs from the route of the last cache observation. The existing estimate is preserved until new cache activity is observed.";

export interface ModelMismatchNotificationSource {
  subscribeModelMismatchTransitions(
    listener: (transition: NativeCacheObserverModelMismatchTransition) => void,
  ): () => void;
}

export interface ModelMismatchNotificationHost {
  readonly toast: Pick<Toasts, "show">;
  readonly attention: Pick<Attention, "notify">;
}

/**
 * Delivers only live mismatch transitions for the selected builtin session.
 * Focused windows use a toast; background windows defer to the host's
 * permission-aware attention service without falling back when it suppresses.
 */
export function startModelMismatchNotificationSubscription(options: {
  readonly source: ModelMismatchNotificationSource;
  readonly currentSession: () => { readonly id: string; readonly builtin: boolean } | undefined;
  readonly host: ModelMismatchNotificationHost;
  readonly focused: () => boolean;
}): () => void {
  let stopped = false;
  const delivered = new Set<string>();

  const release = options.source.subscribeModelMismatchTransitions((transition) => {
    if (stopped || transition.current.status !== "mismatched") return;
    let current: ReturnType<typeof options.currentSession>;
    try {
      current = options.currentSession();
    } catch {
      return;
    }
    if (current?.builtin !== true || current.id !== transition.sessionId) return;
    if (delivered.has(transition.id)) return;
    delivered.add(transition.id);
    if (delivered.size > MAX_REMEMBERED_TRANSITIONS) {
      const oldest = delivered.values().next().value;
      if (oldest !== undefined) delivered.delete(oldest);
    }

    let focused = false;
    try {
      focused = options.focused();
    } catch {
      // Unknown focus is treated like background so host notification settings apply.
    }
    if (focused) {
      options.host.toast.show({ title: TITLE, description: DESCRIPTION, variant: "default" });
      return;
    }
    void options.host.attention
      .notify({
        id: transition.id,
        title: TITLE,
        message: DESCRIPTION,
        variant: "default",
      })
      .catch(() => undefined);
  });

  return () => {
    if (stopped) return;
    stopped = true;
    delivered.clear();
    release();
  };
}
