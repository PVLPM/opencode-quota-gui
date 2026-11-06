import type { ComposerPill, ComposerPillProps, Sessions } from "@opencode/plugin/gui";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { CacheObserverClassification } from "../lib/cache-observer.js";
import type { NativeCacheObserverChild } from "./cache-observer-runtime.js";
import type { NativeDashboardRuntime } from "./runtime.js";

const reasons: Record<CacheObserverClassification["reason"], string> = {
  "insufficient-evidence": "Not enough evidence",
  "observed-reuse-with-active-ttl": "Cache reuse observed",
  "observed-write-with-active-ttl": "Cache write observed",
  "ambiguous-invocation": "Invocation could not be classified",
  "history-truncated": "Observation history incomplete",
  "ttl-unverified": "Cache lifetime not verified",
  "ttl-expired": "Verified cache lifetime expired",
  "route-unverified": "Provider or model not verified",
  "invalidation-unverified": "Invalidation coverage not verified",
  "known-invalidation": "Cache invalidation observed",
  "compaction-boundary-uncertain": "Cache state after compaction unknown",
};

function childLabel(label: string): string {
  // Treat session names as untrusted display text, including bidi controls.
  const clean = label
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(clean || "Child session");
  return chars.length > 40 ? `${chars.slice(0, 39).join("")}…` : chars.join("");
}

function presentation(observed: CacheObserverClassification | undefined, now = Date.now()) {
  const expires = observed?.verifiedExpiresAtMs;
  const recheck = observed?.recheckAtMs;
  const verified =
    observed?.color === "green" &&
    typeof expires === "number" &&
    Number.isFinite(expires) &&
    Number.isFinite(new Date(expires).getTime()) &&
    typeof recheck === "number" &&
    Number.isFinite(recheck) &&
    expires > now &&
    recheck > now &&
    recheck - now <= 2_147_483_647;
  const tone = verified
    ? "success"
    : observed?.color === "green" || observed?.color === "yellow"
      ? "warning"
      : observed?.color === "red"
        ? "danger"
        : undefined;
  const ratio = observed?.primaryCacheReadRatio?.value;
  const observedAt = observed?.primaryCacheReadRatio?.observedAtMs;
  const validRatio =
    ratio !== undefined &&
    Number.isFinite(ratio) &&
    ratio >= 0 &&
    ratio <= 1 &&
    observedAt !== undefined &&
    Number.isFinite(observedAt) &&
    Number.isFinite(new Date(observedAt).getTime())
      ? `${Number((ratio * 100).toFixed(1))}%`
      : undefined;
  const primaryRead =
    validRatio === undefined
      ? "Primary read unavailable"
      : `Last primary read: ${validRatio} at ${new Date(observedAt!).toISOString()}`;
  const countdown =
    verified && expires !== undefined ? `${Math.ceil((expires - now) / 60_000)}m` : undefined;
  return {
    tone,
    summary: `${validRatio ?? "?"}${countdown === undefined ? "" : ` · TTL ${countdown}`}`,
    detail:
      observed === undefined
        ? "Not enough evidence"
        : observed.color === "green" && !verified
          ? `${reasons[observed.reason]}; current state unknown`
          : reasons[observed.reason],
    primaryRead,
    expiry:
      verified && expires !== undefined
        ? `Expires at ${new Date(expires).toISOString()} (${Math.ceil((expires - now) / 60_000)}m remaining)`
        : "Expiry time unavailable",
  } as const;
}

/** Observe host-exposed sessions on the window-lived Native transport. */
export function createCacheComposerPill(
  sessions: Sessions,
  runtime: NativeDashboardRuntime,
): ComposerPill {
  const [transport, setTransport] = createSignal(runtime.cacheObserver.transport());
  const rpc = createMemo(() => transport().rpc);
  const [revision, setRevision] = createSignal(0);
  const [discovery, setDiscovery] = createSignal<{
    key: string;
    status: "loading" | "ready" | "error";
    children: NativeCacheObserverChild[];
  }>();
  onCleanup(runtime.cacheObserver.subscribeTransport(setTransport));

  createEffect(() => {
    const current = sessions.current();
    if (current === undefined || !current.server.builtin || !current.server.connected) {
      setDiscovery(undefined);
      return;
    }
    // The idle composer pill is itself a window surface that needs host events;
    // retain the existing transport instead of waiting for the dashboard Panel.
    runtime.retain();
    const key = current.key;
    let cancelled = false;
    setDiscovery({ key, status: "loading", children: [] });
    const release = runtime.cacheObserver.subscribeChildren(current.id, (snapshot) => {
      if (!cancelled) setDiscovery({ key, status: snapshot.status, children: snapshot.children });
    });
    onCleanup(() => {
      cancelled = true;
      release();
    });
  });

  // One shared wakeup for minute countdown changes and evidence deadlines.
  // This reads local observer state only; it never polls the transport.
  createEffect(() => {
    revision();
    const current = sessions.current();
    const source = transport();
    const discovered = discovery();
    if (
      current === undefined ||
      !current.server.builtin ||
      !current.server.connected ||
      source.rpc !== "live" ||
      source.hostEvents !== "observed"
    )
      return;
    const ids = [
      current.id,
      ...(discovered?.key === current.key
        ? discovered.children.map((child) => child.sessionId)
        : []),
    ];
    const now = Date.now();
    const deadlines = ids.flatMap((id) => {
      const classification = runtime.cacheObserver.query(id);
      const deadline = classification?.recheckAtMs;
      const expiry = classification?.verifiedExpiresAtMs;
      if (
        classification?.color !== "green" ||
        typeof deadline !== "number" ||
        !Number.isFinite(deadline) ||
        typeof expiry !== "number" ||
        !Number.isFinite(expiry)
      )
        return [];
      const next = Math.min(deadline, expiry);
      if (next <= now || next - now > 2_147_483_647) return [];
      const minuteChange = expiry - (Math.ceil((expiry - now) / 60_000) - 1) * 60_000;
      return [Math.min(next, minuteChange)];
    });
    if (deadlines.length === 0) return;
    const timer = setTimeout(() => setRevision((value) => value + 1), Math.min(...deadlines) - now);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(() => {
    const current = sessions.current();
    if (
      current === undefined ||
      !current.server.builtin ||
      !current.server.connected ||
      rpc() !== "live"
    )
      return;
    onCleanup(runtime.cacheObserver.subscribe(current.id, () => setRevision((value) => value + 1)));
  });

  createEffect(() => {
    const current = sessions.current();
    if (
      current === undefined ||
      !current.server.builtin ||
      !current.server.connected ||
      rpc() !== "live"
    )
      return;
    const releases = new Map<string, () => void>();
    createEffect(() => {
      const discovered = discovery();
      const children = discovered?.key === current.key ? discovered.children : [];
      const ids = new Set(
        children.map((child) => child.sessionId).filter((id) => id !== current.id),
      );
      for (const [id, release] of releases) {
        if (!ids.has(id)) {
          release();
          releases.delete(id);
        }
      }
      for (const id of ids) {
        if (!releases.has(id))
          releases.set(
            id,
            runtime.cacheObserver.subscribe(id, () => setRevision((value) => value + 1)),
          );
      }
    });
    onCleanup(() =>
      releases.forEach((release) => {
        release();
      }),
    );
  });

  return {
    id: "cache-observer",
    show(input: ComposerPillProps) {
      revision();
      const session = input.session;
      const current = sessions.current();
      const selected = current?.key === session.key;
      const state = transport();
      const active =
        selected &&
        state.rpc === "live" &&
        session.server.builtin &&
        session.server.connected &&
        state.hostEvents === "observed";
      const observed = active ? runtime.cacheObserver.query(session.id) : undefined;
      const view = presentation(observed);
      const discovered = selected && discovery()?.key === session.key ? discovery() : undefined;
      const detail = (id: string) => {
        if (!active)
          return state.rpc !== "live"
            ? "Observation stream inactive · Primary read unavailable · Expiry time unavailable"
            : "Host event status unverified · Primary read unavailable · Expiry time unavailable";
        const result = presentation(runtime.cacheObserver.query(id));
        return `${result.detail} · ${result.primaryRead} · ${result.expiry} · Live status unknown`;
      };
      return {
        label: `▤ Cache ${view.summary}`,
        icon: "status",
        ...(view.tone === undefined ? {} : { tone: view.tone }),
        title: "Cache observation (last observed state)",
        rows: [
          ...(discovered?.status === "ready"
            ? discovered.children.map((child) => {
                const childView = presentation(
                  active ? runtime.cacheObserver.query(child.sessionId) : undefined,
                );
                return {
                  id: `child:${child.sessionId}`,
                  label: `${childLabel(child.label)} · ${childView.summary}`,
                  icon: "status" as const,
                  ...(childView.tone === undefined ? {} : { tone: childView.tone }),
                  detail: detail(child.sessionId),
                };
              })
            : [
                {
                  id: "children-status",
                  icon: "status" as const,
                  label:
                    discovered?.status === "error"
                      ? "Child sessions unavailable"
                      : "Loading child sessions",
                  detail:
                    discovered?.status === "error"
                      ? "Could not load children"
                      : "Discovery pending",
                },
              ]),
          {
            id: "main",
            label: `Main · ${view.summary}`,
            icon: "status",
            ...(view.tone === undefined ? {} : { tone: view.tone }),
            detail: detail(session.id),
          },
        ],
      };
    },
  };
}
