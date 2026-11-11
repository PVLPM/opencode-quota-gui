import type { ComposerPill, ComposerPillProps, Sessions, Ui } from "@opencode/plugin/gui";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  Show,
} from "solid-js";
import type { CacheObserverClassification } from "../lib/cache-observer.js";
import type {
  NativeCacheObserverChild,
  NativeCacheObserverChildrenSnapshot,
  NativeCacheObserverSessionMeta,
} from "./cache-observer-runtime.js";
import type { NativeDashboardRuntime } from "./runtime.js";

/** One popup-wide detail overlay: at most one row's bubble is ever active. */
const DETAIL_CLOSE_DELAY_MS = 140;
const MISMATCH_DETAIL = "Selected model differs from the route of the last cache observation.";
const ATTENTION_FLASH_MS = 180;

function safeTitle(title: string | undefined, fallback: string): string {
  const clean = (title ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return clean || fallback;
}

/** Sanitize metadata without shortening the accessible value. */
function safeSegment(value: string | undefined): string | undefined {
  const clean = (value ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return undefined;
  return clean;
}

function sessionModel(meta: NativeCacheObserverSessionMeta | undefined): string | undefined {
  const provider = safeSegment(meta?.model?.providerID);
  const modelId = safeSegment(meta?.model?.id);
  if (provider !== undefined && modelId !== undefined) {
    const effort = safeSegment(meta?.model?.variant);
    return `${provider} / ${modelId}${effort === undefined ? "" : `#${effort}`}`;
  }
  return undefined;
}

function formatTime(ms: number | undefined): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return undefined;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : undefined;
}

/**
 * The traffic-light presentation of one classification. Colors render as
 * estimated states — green is a best-effort estimate within a configured or
 * documented retention window, never a claim about the provider's physical cache.
 */
function presentation(observed: CacheObserverClassification | undefined, reuseUncertain = false) {
  const tone = reuseUncertain
    ? ("warning" as const)
    : observed?.color === "green"
      ? ("success" as const)
      : observed?.color === "yellow"
        ? ("warning" as const)
        : observed?.color === "red"
          ? ("danger" as const)
          : undefined;
  const ratio = observed?.primaryCacheReadRatio?.value;
  const observedAt = observed?.primaryCacheReadRatio?.observedAtMs;
  const percent =
    typeof ratio === "number" &&
    Number.isFinite(ratio) &&
    ratio >= 0 &&
    ratio <= 1 &&
    typeof observedAt === "number" &&
    Number.isFinite(observedAt)
      ? `${Number((ratio * 100).toFixed(1))}%`
      : undefined;
  const source =
    percent !== undefined
      ? `Last completed primary call · host-reported cache read · ${formatTime(observedAt)}`
      : undefined;
  const detail = reuseUncertain ? "Prior cache reads; reuse uncertain" : detailFor(observed);
  // The estimate's provenance: when it expires, when the qualifying call
  // started, which source supplied the retention value, and what it assumes.
  const estimate = reuseUncertain ? undefined : observed?.ttlEstimate;
  const estimateLines: string[] = [];
  if (estimate !== undefined) {
    const expired = observed?.reason === "estimated-ttl-expired";
    const deadline = formatTime(estimate.deadlineAtMs);
    if (deadline !== undefined) {
      estimateLines.push(
        expired ? `Estimated expiry elapsed · ${deadline}` : `Estimated expiry · ${deadline}`,
      );
    }
    const dispatched = formatTime(estimate.dispatchAtMs);
    if (dispatched !== undefined) {
      estimateLines.push(`Last qualifying call started · ${dispatched}`);
    }
    const basis = safeSegment(estimate.source);
    if (basis !== undefined) estimateLines.push(`Retention basis · ${basis}`);
    const assumption = safeSegment(estimate.assumption);
    if (assumption !== undefined) estimateLines.push(assumption);
  }
  return { tone, percent, detail, source, estimateLines } as const;
}

function detailFor(observed: CacheObserverClassification | undefined): string | undefined {
  switch (observed?.reason) {
    case "known-invalidation":
      return "Invalidation observed";
    case "estimated-ttl-expired":
    case "ttl-expired":
      return "Estimated retention elapsed";
    case "estimated-ttl-near-expiry":
      return "Estimated near expiry";
    case "estimated-reuse-within-ttl":
    case "estimated-write-within-ttl":
      return "Estimated within retention";
    case "assumed-route-risk":
      return "Retention assumed, not verified";
    case "ambiguous-invocation":
      return "Latest call could not confirm reuse";
    case "out-of-order-invocation":
      return "Call order could not be confirmed";
    case "compaction-boundary-uncertain":
      return "Compaction changed the context";
    case "history-truncated":
      return "Cache history is incomplete";
    case "observation-gap":
      return "Event coverage was interrupted";
    case "route-unverified":
      return "Route not verified";
    case "dispatch-time-unavailable":
      return "Reuse observed · start time unknown";
    case "invalidation-unverified":
    case "ttl-unverified":
      return "Reuse not verified";
    case "observed-reuse-with-active-ttl":
    case "observed-write-with-active-ttl":
      return "Reuse observed";
    default:
      // Insufficient evidence stays a plain unknown dot; absence of evidence
      // is not a warning and needs no bubble.
      return undefined;
  }
}

/** Most recent activity last, so the newest child sits directly above the divider. */
function compareChildActivity(
  left: NativeCacheObserverChild,
  right: NativeCacheObserverChild,
  activityOf: (sessionId: string) => number,
): number {
  const leftAt = activityOf(left.sessionId);
  const rightAt = activityOf(right.sessionId);
  if (leftAt !== rightAt) return leftAt - rightAt;
  return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0;
}

/** One window-level coordinator owns all history batches for the selected session. */
export function createCacheComposerPill(
  sessions: Sessions,
  runtime: NativeDashboardRuntime,
  ui?: Pick<Ui, "Icon">,
  openSession?: (session: ComposerPillProps["session"], sessionId: string) => void,
): ComposerPill {
  const [transport, setTransport] = createSignal(runtime.cacheObserver.transport());
  const [revision, setRevision] = createSignal(0);
  const [gapRevision, setGapRevision] = createSignal(0);
  const [flashKey, setFlashKey] = createSignal<string>();
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const clearFlash = () => {
    if (flashTimer !== undefined) clearTimeout(flashTimer);
    flashTimer = undefined;
    setFlashKey(undefined);
  };
  onCleanup(
    runtime.cacheObserver.subscribeModelMismatchTransitions((transition) => {
      const current = sessions.current();
      if (
        !current?.server.builtin ||
        !current.server.connected ||
        current.id !== transition.sessionId
      )
        return;
      clearFlash();
      if (
        transition.current.status !== "mismatched" ||
        (typeof window !== "undefined" &&
          window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      )
        return;
      flashTimer = setTimeout(() => {
        setFlashKey(current.key);
        flashTimer = setTimeout(clearFlash, ATTENTION_FLASH_MS);
      }, 100);
    }),
  );
  onCleanup(clearFlash);
  const [children, setChildren] = createSignal<NativeCacheObserverChildrenSnapshot>();
  const [history, setHistory] = createSignal<{
    key: string;
    status: "loading" | "ready" | "error";
  }>();
  let inFlightHistoryKey: string | undefined;
  onCleanup(runtime.cacheObserver.subscribeTransport(setTransport));
  onCleanup(
    runtime.cacheObserver.subscribeGaps((id) => {
      const current = sessions.current();
      if (
        current &&
        (id === current.id || children()?.children.some((child) => child.sessionId === id))
      )
        setGapRevision((n) => n + 1);
    }),
  );

  // The selected session's observation lives for as long as the selection is
  // unchanged. A re-route of the same session (a new object with the same key)
  // must not release it: the release would fence the loaded history and force
  // a rediscovery on the next look.
  let mainRelease: (() => void) | undefined;
  let mainObservedKey: string | undefined;
  createEffect(() => {
    const current = sessions.current();
    const key =
      current?.server.builtin === true && current.server.connected === true
        ? current.key
        : undefined;
    if (key === mainObservedKey) return;
    clearFlash();
    mainRelease?.();
    mainRelease = undefined;
    mainObservedKey = key;
    if (current === undefined || key === undefined) return;
    runtime.retain();
    mainRelease = runtime.cacheObserver.subscribe(current.id, () => setRevision((n) => n + 1));
  });
  onCleanup(() => {
    mainRelease?.();
    mainRelease = undefined;
  });

  // Child discovery also lives with the selection: closing the popover neither
  // drops the list nor invalidates the children's history, so reopening never
  // rediscovers or flashes. Selection changes, disconnects, and lifecycle gaps
  // release and invalidate everything.
  let childrenRelease: (() => void) | undefined;
  let childrenObservedKey: string | undefined;
  createEffect(() => {
    const current = sessions.current();
    const key =
      current?.server.builtin === true && current.server.connected === true
        ? current.key
        : undefined;
    if (key !== childrenObservedKey) {
      childrenRelease?.();
      childrenObservedKey = key;
      setChildren(undefined);
      if (current === undefined || key === undefined) {
        childrenRelease = undefined;
        return;
      }
      let superseded = false;
      const release = runtime.cacheObserver.subscribeChildren(current.id, (snapshot) => {
        // A superseded subscription (mock or late callback) never writes here.
        if (superseded) return;
        setChildren(snapshot);
      });
      childrenRelease = () => {
        superseded = true;
        release();
      };
    }
  });
  onCleanup(() => {
    childrenRelease?.();
    childrenRelease = undefined;
  });

  // Per-child observation subscriptions, diffed against the snapshot so a list
  // refresh never releases and re-fences the children it already observes.
  const childReleases = new Map<string, () => void>();
  let childReleasesKey: string | undefined;
  createEffect(() => {
    const current = sessions.current();
    const snapshot = children();
    const key =
      current?.server.builtin === true && current.server.connected === true
        ? current.key
        : undefined;
    if (key !== childReleasesKey) {
      for (const release of childReleases.values()) release();
      childReleases.clear();
      childReleasesKey = key;
    }
    if (current === undefined || key === undefined || snapshot === undefined) return;
    const wanted = new Set(
      snapshot.children.map((child) => child.sessionId).filter((id) => id !== current.id),
    );
    for (const [sessionId, release] of [...childReleases]) {
      if (wanted.has(sessionId)) continue;
      release();
      childReleases.delete(sessionId);
    }
    for (const sessionId of wanted) {
      if (childReleases.has(sessionId)) continue;
      childReleases.set(
        sessionId,
        runtime.cacheObserver.subscribe(sessionId, () => setRevision((n) => n + 1)),
      );
    }
  });
  onCleanup(() => {
    for (const release of childReleases.values()) release();
    childReleases.clear();
  });

  // Authoritative main-session metadata lives in the runtime's store: seeded
  // once per selection from the public client, patched live by narrow update
  // events, refreshed after reconnects, and dropped on switch.

  // Collapse observation notifications to the set of sessions needing history.
  // A stream gap fences a previously available ratio, changing this key; ordinary
  // updates that do not change demand leave the active batch alone.
  const historyDemand = createMemo(() => {
    revision();
    const current = sessions.current();
    const snapshot = children();
    if (!current?.server.builtin || !current.server.connected) return "[]";
    const ids = [current.id, ...(snapshot?.children.map((child) => child.sessionId) ?? [])];
    const missing = [...new Set(ids)].filter(
      (id) => !runtime.cacheObserver.query(id)?.primaryCacheReadRatio,
    );
    return JSON.stringify(missing);
  });

  createEffect(() => {
    const current = sessions.current();
    const source = transport();
    const gap = gapRevision();
    const missing = JSON.parse(historyDemand()) as string[];
    if (!current?.server.builtin || !current.server.connected || source.rpc !== "live") {
      inFlightHistoryKey = undefined;
      setHistory((previous) => (previous?.status === "loading" ? undefined : previous));
      return;
    }
    if (!missing.length) {
      inFlightHistoryKey = undefined;
      setHistory({ key: current.key, status: "ready" });
      return;
    }
    // The gap epoch is part of the batch identity: an identical missing set
    // after a gap must re-bootstrap, while ordinary revision bumps that do not
    // change demand must not restart (or abort) the active batch.
    const batchKey = `${gap}|${current.key}|${missing.join(",")}`;
    if (batchKey === inFlightHistoryKey) return;
    inFlightHistoryKey = batchKey;
    const controller = new AbortController();
    let settled = false;
    setHistory({ key: current.key, status: "loading" });
    // Observer callbacks may fire while a stream gap is still invalidating its
    // old batch. Start after that synchronous invalidation has completed.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void runtime.cacheObserver
        .bootstrapHistory(missing, controller.signal)
        .then(() => {
          if (controller.signal.aborted) return;
          settled = true;
          setHistory({ key: current.key, status: "ready" });
          setRevision((n) => n + 1);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          // A failed batch stays retryable on the next triggering event.
          if (inFlightHistoryKey === batchKey) inFlightHistoryKey = undefined;
          setHistory({ key: current.key, status: "error" });
        });
    });
    onCleanup(() => {
      controller.abort();
      // A completed batch keeps its identity so the revision bump it caused
      // cannot re-enqueue it; an unfinished one is retryable.
      if (!settled && inFlightHistoryKey === batchKey) inFlightHistoryKey = undefined;
    });
  });

  function view(id: string) {
    revision();
    const observed = runtime.cacheObserver.query(id);
    const source = transport();
    const ratio = observed?.primaryCacheReadRatio;
    const reuseUncertain =
      observed?.color === "gray" &&
      observed.reason === "route-unverified" &&
      observed.primaryCacheReadTelemetry === "available" &&
      typeof ratio?.value === "number" &&
      Number.isFinite(ratio.value) &&
      ratio.value > 0 &&
      ratio.value <= 1 &&
      typeof ratio.observedAtMs === "number" &&
      Number.isFinite(ratio.observedAtMs) &&
      ratio.observedAtMs >= 0 &&
      runtime.cacheObserver.status(id) === "busy" &&
      source.rpc === "live" &&
      source.hostEvents === "observed";
    // A past green result is not current proof when event coverage has been lost.
    return presentation(
      observed?.color === "green" && (source.rpc !== "live" || source.hostEvents !== "observed")
        ? { ...observed, color: "yellow" }
        : observed,
      reuseUncertain,
    );
  }
  function summary(id: string) {
    const result = view(id);
    return result.percent ?? "";
  }

  return {
    id: "cache-observer",
    show(input: ComposerPillProps) {
      const session = input.session;
      const selected =
        sessions.current()?.key === session.key &&
        session.server.builtin &&
        session.server.connected;
      const result = selected ? view(session.id) : presentation(undefined);
      const mismatched =
        selected && runtime.cacheObserver.modelMismatch(session.id).status === "mismatched";
      const loading =
        selected &&
        history()?.key === session.key &&
        history()?.status === "loading" &&
        !result.percent;
      const hasError = selected && history()?.key === session.key && history()?.status === "error";
      return {
        label: loading ? "Cache · Loading…" : `Cache${result.percent ? ` ${result.percent}` : ""}`,
        icon: hasError ? "warning" : "server",
        ...(mismatched
          ? { tone: flashKey() === session.key ? ("warning" as const) : ("danger" as const) }
          : result.tone
            ? { tone: result.tone }
            : hasError
              ? { tone: "warning" as const }
              : {}),
        title: mismatched ? MISMATCH_DETAIL : "Cache observation",
      };
    },
    menu(input) {
      // One popup-wide detail overlay. Hovering a dot or deliberately pressing
      // it (click, Enter, Space) opens it; focus alone never does; Escape,
      // blur, scroll or a scheduled hover-out closes it. Moving from the dot
      // into the bubble keeps it open.
      let menuElement: HTMLDivElement | undefined;
      let childrenElement: HTMLDivElement | undefined;
      let initialScrollDone = false;
      let menuDisposed = false;
      onCleanup(() => {
        menuDisposed = true;
      });
      createEffect(() => {
        if (initialScrollDone || children()?.status !== "ready") return;
        initialScrollDone = true;
        queueMicrotask(() => {
          if (!menuDisposed && childrenElement)
            childrenElement.scrollTop = childrenElement.scrollHeight;
        });
      });
      const [detailId, setDetailId] = createSignal<string>();
      const [anchor, setAnchor] = createSignal<{ top: number; left: number }>();
      const [pinned, setPinned] = createSignal(false);
      const [infoPinned, setInfoPinned] = createSignal(false);
      const infoOpen = () => infoPinned();
      const infoId = createUniqueId();
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const tooltipId = createUniqueId();
      const clearCloseTimer = () => {
        if (closeTimer === undefined) return;
        clearTimeout(closeTimer);
        closeTimer = undefined;
      };
      const closeDetail = () => {
        clearCloseTimer();
        setDetailId(undefined);
        setPinned(false);
      };
      const scheduleClose = () => {
        if (pinned() || detailId() === undefined) return;
        clearCloseTimer();
        closeTimer = setTimeout(() => {
          closeTimer = undefined;
          closeDetail();
        }, DETAIL_CLOSE_DELAY_MS);
      };
      const anchorTo = (dot: HTMLElement) => {
        const menu = menuElement;
        if (menu === undefined) {
          setAnchor(undefined);
          return;
        }
        const menuRect = menu.getBoundingClientRect();
        const dotRect = dot.getBoundingClientRect();
        const left = Math.min(
          Math.max(dotRect.left - menuRect.left, 0),
          Math.max(menu.clientWidth - 336, 0),
        );
        setAnchor({ top: dotRect.bottom - menuRect.top + 4, left });
      };
      const openDetail = (id: string, dot: HTMLElement) => {
        clearCloseTimer();
        setPinned(false);
        anchorTo(dot);
        setDetailId(id);
      };
      const pinDetail = (id: string) => {
        clearCloseTimer();
        if (detailId() === id && pinned()) {
          closeDetail();
          return;
        }
        const dot = document.activeElement;
        if (dot instanceof HTMLElement) anchorTo(dot);
        else setAnchor(undefined);
        setPinned(true);
        setDetailId(id);
      };
      createEffect(() => {
        if (detailId() === undefined) return;
        const dismiss = (event: KeyboardEvent) => {
          if (event.key !== "Escape") return;
          closeDetail();
        };
        document.addEventListener("keydown", dismiss);
        onCleanup(() => document.removeEventListener("keydown", dismiss));
      });
      onCleanup(closeDetail);
      createEffect(() => {
        if (!infoOpen()) return;
        const dismiss = (event: KeyboardEvent) => {
          if (event.key !== "Escape") return;
          setInfoPinned(false);
        };
        document.addEventListener("keydown", dismiss);
        onCleanup(() => document.removeEventListener("keydown", dismiss));
      });

      // Identity metadata for any row, reactive through the revision signal:
      // the runtime notifies the session's listeners on every confirmed
      // status or metadata change.
      const meta = (sessionId: string) => {
        revision();
        return runtime.cacheObserver.metadata(sessionId);
      };
      const activityOf = (sessionId: string) => {
        const sessionMeta = runtime.cacheObserver.metadata(sessionId);
        return sessionMeta?.updatedAtMs ?? sessionMeta?.createdAtMs ?? 0;
      };
      const childBusy = (sessionId: string) => {
        revision();
        return runtime.cacheObserver.status(sessionId) === "busy";
      };

      const sortedChildren = createMemo(() => {
        revision();
        return [...(children()?.children ?? [])].sort((left, right) =>
          compareChildActivity(left, right, activityOf),
        );
      });

      // The one overlay's content; `detailId()` is always set while rendered.
      const mainMismatch = () => {
        revision();
        return (
          sessions.current()?.key === input.session.key &&
          runtime.cacheObserver.modelMismatch(input.session.id).status === "mismatched"
        );
      };
      const detailResult = () => {
        const result = view(detailId() ?? "");
        return detailId() === input.session.id && mainMismatch()
          ? { ...result, detail: MISMATCH_DETAIL }
          : result;
      };
      // A list refresh can remove the row whose bubble is open; the overlay
      // closes instead of lingering on a stale anchor.
      createEffect(() => {
        if (detailId() === undefined) return;
        const result = detailResult();
        if (result.detail === undefined && result.source === undefined) closeDetail();
      });

      const row = (
        id: () => string,
        fallback: () => string,
        child: boolean,
        busy: () => boolean,
      ) => {
        const descriptionId = createUniqueId();
        const rowMeta = () => meta(id());
        const label = () => safeTitle(rowMeta()?.title, fallback());
        const agent = () => safeSegment(rowMeta()?.agent);
        const model = () => sessionModel(rowMeta());
        const result = () => {
          const observed = view(id());
          return !child && mainMismatch()
            ? { ...observed, tone: "danger" as const, detail: MISMATCH_DETAIL }
            : observed;
        };
        const detail = () => result().detail || result().source;
        const open = () => detail() !== undefined && detailId() === id();
        return (
          <div class={`qg-cache-row${child ? " qg-cache-child" : ""}`}>
            <div class="qg-cache-row-heading">
              <Show when={child}>
                <span class="qg-cache-busy" data-busy={busy() ? "true" : "false"}>
                  <span class="qg-cache-visually-hidden">{busy() ? "Running" : ""}</span>
                </span>
              </Show>
              <Show
                when={detail()}
                fallback={
                  <span
                    class="qg-cache-indicator"
                    role="img"
                    aria-label="Cache observation unknown"
                  />
                }
              >
                <button
                  type="button"
                  class={`qg-cache-indicator qg-cache-${result().tone ?? "neutral"}`}
                  aria-label={`Cache details for ${label()}`}
                  aria-describedby={open() ? tooltipId : undefined}
                  onPointerEnter={(event) => openDetail(id(), event.currentTarget)}
                  onPointerLeave={() => scheduleClose()}
                  onBlur={() => {
                    if (detailId() === id()) closeDetail();
                  }}
                  onClick={() => pinDetail(id())}
                />
              </Show>
              <button
                type="button"
                class="qg-cache-identity"
                disabled={!openSession}
                aria-label={`Open ${label()} in dashboard`}
                aria-describedby={descriptionId}
                onClick={() => {
                  if (!openSession) return;
                  openSession(input.session, id());
                  input.close();
                }}
              >
                <span id={descriptionId} class="qg-cache-visually-hidden">
                  {agent() ? `Agent: ${agent()}. ` : ""}
                  {model() ? `Model: ${model()}. ` : ""}
                  {child && busy() ? "Running. " : ""}
                  {result().detail ? `${result().detail}. ` : "Cache observation unknown. "}
                  {summary(id()) ? `${summary(id())} hit. ` : ""}
                  {result().estimateLines[0] ?? ""}
                </span>
                <span class="qg-cache-identity-text">
                  <span class="qg-cache-primary">
                    <Show when={agent()}>
                      {(name) => (
                        <span class="qg-cache-agent" title={name()}>
                          {name()}
                        </span>
                      )}
                    </Show>
                    <span class="qg-cache-title" title={label()}>
                      {label()}
                    </span>
                  </span>
                  <Show when={model()}>
                    {(name) => (
                      <span class="qg-cache-model" title={name()}>
                        {name()}
                      </span>
                    )}
                  </Show>
                </span>
                <span class="qg-cache-metrics">
                  <Show when={summary(id())}>{(percent) => <span>{percent()} hit</span>}</Show>
                  <Show when={result().estimateLines[0]}>
                    {(expiry) => <span>{expiry()}</span>}
                  </Show>
                </span>
              </button>
            </div>
          </div>
        );
      };

      return (
        <div ref={menuElement} class="qg-cache-menu">
          <div class="qg-cache-heading">
            <button
              type="button"
              class="qg-cache-info"
              aria-label="About cache observations"
              aria-describedby={infoOpen() ? infoId : undefined}
              aria-expanded={infoOpen()}
              onBlur={() => {
                setInfoPinned(false);
              }}
              onClick={() => setInfoPinned((value) => !value)}
            >
              {ui ? <ui.Icon name="info" size="small" /> : "i"}
            </button>
            <Show when={infoOpen()}>
              <fieldset
                id={infoId}
                class="qg-cache-tooltip qg-cache-legend"
                aria-label="Cache status legend"
              >
                <span>
                  Hit % is the host-reported cache read share of the last completed primary call.
                </span>
                <span>
                  Green: estimated within retention. Yellow: uncertain or in the last 20% of
                  estimated retention.
                </span>
                <span>Red: estimated expiry, invalidation, or model change. Grey: unknown.</span>
                <span>
                  Retention and expiry are estimates, not proof of the provider's cache state.
                </span>
              </fieldset>
            </Show>
          </div>
          <div ref={childrenElement} class="qg-cache-children" onScroll={closeDetail}>
            <Show
              when={children()?.status === "loading" && (children()?.children.length ?? 0) === 0}
            >
              <output>Loading child sessions…</output>
            </Show>
            <Show when={children()?.status === "error"}>
              <p>Could not load child sessions.</p>
            </Show>
            <For each={sortedChildren()}>
              {(child) =>
                row(
                  () => child.sessionId,
                  () => safeTitle(child.label, "Untitled child session"),
                  true,
                  () => childBusy(child.sessionId),
                )
              }
            </For>
          </div>
          <hr />
          {row(
            () => input.session.id,
            () => "Loading session…",
            false,
            () => false,
          )}
          <Show
            when={
              history()?.key === input.session.key &&
              history()?.status === "loading" &&
              !view(input.session.id).percent
            }
          >
            <output>Loading cache history…</output>
          </Show>
          <Show when={history()?.key === input.session.key && history()?.status === "error"}>
            <p>Could not load cache history.</p>
          </Show>
          <Show when={detailId() !== undefined}>
            <span
              role="tooltip"
              id={tooltipId}
              class="qg-cache-tooltip"
              style={{
                top: `${anchor()?.top ?? 0}px`,
                left: `${anchor()?.left ?? 0}px`,
              }}
              onPointerEnter={clearCloseTimer}
              onPointerLeave={() => scheduleClose()}
            >
              <Show when={detailResult().detail}>
                <span>{detailResult().detail}</span>
              </Show>
              <For each={detailResult().estimateLines}>
                {(line) => <span class="qg-cache-tooltip-note">{line}</span>}
              </For>
              <Show when={detailResult().source}>
                <span class="qg-cache-tooltip-note">{detailResult().source}</span>
              </Show>
            </span>
          </Show>
        </div>
      );
    },
  };
}
