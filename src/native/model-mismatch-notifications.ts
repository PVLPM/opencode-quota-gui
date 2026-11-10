import type { Attention, Toasts } from "@opencode/plugin/gui";
import type { SettingsSnapshot } from "../contracts/dashboard.js";
import type { NativeCacheObserverModelMismatchTransition } from "./cache-observer-runtime.js";
import type { NativeDashboardConnection } from "./dashboard-client.js";

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

export interface ModelChangeToastSettingsSource {
  settings(): Promise<SettingsSnapshot>;
  connection(): NativeDashboardConnection;
  onConnectionChange(listener: (state: NativeDashboardConnection) => void): () => void;
  subscribeSettingsChanged(listener: () => void): () => void;
  onReconnect(listener: () => void): () => void;
}

/** Keeps the focused-toast preference in step with the window's live settings lifecycle. */
export function createModelChangeToastSetting(source: ModelChangeToastSettingsSource): {
  enabled: () => boolean;
  stop: () => void;
} {
  let enabled = true;
  let stopped = false;
  let pending = false;
  let readVersion = 0;
  let hasConnected = source.connection() === "live";

  const refresh = () => {
    const version = ++readVersion;
    pending = true;
    try {
      void source.settings().then(
        (snapshot) => {
          if (stopped || version !== readVersion) return;
          const policy = snapshot.values.nativeQuotaNotifications;
          if (
            typeof policy === "object" &&
            policy !== null &&
            !Array.isArray(policy) &&
            typeof policy.modelChangeToastEnabled === "boolean"
          ) {
            enabled = policy.modelChangeToastEnabled;
          }
          pending = false;
        },
        () => {
          if (stopped || version !== readVersion) return;
          pending = false;
        },
      );
    } catch {
      // A failed settings read keeps the last known policy/default-on behavior.
      if (!stopped && version === readVersion) pending = false;
    }
  };

  const unsubscribe = source.subscribeSettingsChanged(refresh);
  const unsubscribeConnection = source.onConnectionChange((state) => {
    if (state !== "live" || hasConnected) return;
    hasConnected = true;
    refresh();
  });
  const unsubscribeReconnect = source.onReconnect(() => {
    hasConnected = true;
    refresh();
  });
  refresh();

  return {
    enabled: () => !pending && enabled,
    stop: () => {
      if (stopped) return;
      stopped = true;
      readVersion += 1;
      pending = false;
      unsubscribe();
      unsubscribeConnection();
      unsubscribeReconnect();
    },
  };
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
  /** Gates only the focused-window toast; detection and background notifications stay active. */
  readonly modelChangeToastEnabled?: () => boolean;
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
      try {
        if (options.modelChangeToastEnabled?.() === false) return;
      } catch {
        // Keep the existing default-on toast behavior if settings cannot be read.
      }
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
