import { describe, expect, it, vi } from "vitest";

import type { NativeCacheObserverModelMismatchTransition } from "../src/native/cache-observer-runtime.js";
import {
  type ModelMismatchNotificationSource,
  startModelMismatchNotificationSubscription,
} from "../src/native/model-mismatch-notifications.js";

function createHost() {
  return {
    toast: { show: vi.fn() },
    attention: { notify: vi.fn(async () => ({ ok: true, notification: true, sound: false })) },
  };
}

function createSource() {
  let listener: ((transition: NativeCacheObserverModelMismatchTransition) => void) | undefined;
  const source: ModelMismatchNotificationSource = {
    subscribeModelMismatchTransitions: (next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  return {
    source,
    emit: (transition: NativeCacheObserverModelMismatchTransition) => listener?.(transition),
  };
}

const transition: NativeCacheObserverModelMismatchTransition = {
  id: "model-mismatch:event-one",
  sessionId: "ses_main",
  atMs: 123,
  previous: {
    status: "matched",
    selectedModel: { providerID: "anthropic", id: "claude-cache" },
    cacheRoute: { providerID: "anthropic", id: "claude-cache" },
  },
  current: {
    status: "mismatched",
    selectedModel: { providerID: "openai", id: "gpt-next" },
    cacheRoute: { providerID: "anthropic", id: "claude-cache" },
  },
};

describe("native model mismatch notifications", () => {
  it("shows a focused toast only for the currently selected builtin session", () => {
    const { source, emit } = createSource();
    const host = createHost();
    let current: { id: string; builtin: boolean } | undefined = {
      id: "ses_child",
      builtin: true,
    };
    const stop = startModelMismatchNotificationSubscription({
      source,
      currentSession: () => current,
      host,
      focused: () => true,
    });

    emit({ ...transition, sessionId: "ses_main" });
    expect(host.toast.show).not.toHaveBeenCalled();
    expect(host.attention.notify).not.toHaveBeenCalled();

    current = { id: "ses_main", builtin: true };
    emit(transition);
    emit(transition);
    expect(host.toast.show).toHaveBeenCalledTimes(1);
    expect(host.toast.show).toHaveBeenCalledWith({
      title: "Selected model changed",
      description:
        "The selected model differs from the route of the last cache observation. The existing estimate is preserved until new cache activity is observed.",
      variant: "default",
    });
    expect(host.attention.notify).not.toHaveBeenCalled();

    emit({
      ...transition,
      id: "model-mismatch:return",
      atMs: 124,
      previous: transition.current,
      current: {
        status: "matched",
        selectedModel: { providerID: "anthropic", id: "claude-cache" },
        cacheRoute: { providerID: "anthropic", id: "claude-cache" },
      },
    });
    expect(host.toast.show).toHaveBeenCalledTimes(1);

    current = { id: "ses_main", builtin: false };
    emit({ ...transition, id: "model-mismatch:other-server", atMs: 125 });
    expect(host.toast.show).toHaveBeenCalledTimes(1);
    stop();
  });

  it("uses permission-aware background notifications without exposing model identifiers", () => {
    const { source, emit } = createSource();
    const host = createHost();
    const stop = startModelMismatchNotificationSubscription({
      source,
      currentSession: () => ({ id: "ses_main", builtin: true }),
      host,
      focused: () => false,
    });

    emit(transition);
    expect(host.toast.show).not.toHaveBeenCalled();
    expect(host.attention.notify).toHaveBeenCalledWith({
      id: expect.any(String),
      title: "Selected model changed",
      message:
        "The selected model differs from the route of the last cache observation. The existing estimate is preserved until new cache activity is observed.",
      variant: "default",
    });
    const notification = host.attention.notify.mock.calls[0]?.[0];
    expect(JSON.stringify(notification)).not.toContain("gpt-next");
    expect(JSON.stringify(notification)).not.toContain("claude-cache");

    stop();
    emit({ ...transition, atMs: 124 });
    expect(host.attention.notify).toHaveBeenCalledTimes(1);
  });
});
