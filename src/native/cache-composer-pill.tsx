import type { ComposerPill, ComposerPillProps, Context, Sessions } from "@opencode/plugin/gui";
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
import type { NativeCacheObserverChildrenSnapshot } from "./cache-observer-runtime.js";
import type { NativeDashboardRuntime } from "./runtime.js";

type SessionClient = Pick<Context["client"]["session"], "get">;

function safeTitle(title: string | undefined, fallback: string): string {
  const clean = (title ?? "")
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const chars = Array.from(clean || fallback);
  return chars.length > 80 ? `${chars.slice(0, 79).join("")}…` : chars.join("");
}

function presentation(observed: CacheObserverClassification | undefined) {
  // The classifier's configured-minimum deadline is not bound to a verified
  // invocation and is not a physical expiry or proof of current reuse.
  const tone =
    observed?.color === "yellow" || observed?.color === "green"
      ? "warning"
      : observed?.color === "red" && observed.reason === "known-invalidation"
        ? "danger"
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
  const date = typeof observedAt === "number" ? new Date(observedAt) : undefined;
  const source =
    percent && date && Number.isFinite(date.getTime())
      ? `Last completed primary call · host-reported cache read · ${date.toLocaleString()}`
      : undefined;
  const detail =
    tone === "danger"
      ? "Invalidation observed"
      : tone === "warning"
        ? "Reuse not verified"
        : undefined;
  return { tone, percent, detail, source } as const;
}

/** One window-level coordinator owns all history batches for the selected session. */
export function createCacheComposerPill(
  sessions: Sessions,
  runtime: NativeDashboardRuntime,
  sessionClient: SessionClient,
): ComposerPill {
  const [transport, setTransport] = createSignal(runtime.cacheObserver.transport());
  const [revision, setRevision] = createSignal(0);
  const [gapRevision, setGapRevision] = createSignal(0);
  const [openKey, setOpenKey] = createSignal<string>();
  const [children, setChildren] = createSignal<NativeCacheObserverChildrenSnapshot>();
  const [title, setTitle] = createSignal<string>();
  const [history, setHistory] = createSignal<{
    key: string;
    status: "loading" | "ready" | "error";
  }>();
  onCleanup(runtime.cacheObserver.subscribeTransport(setTransport));
  onCleanup(
    runtime.cacheObserver.subscribeGaps((id) => {
      const current = sessions.current();
      if (
        current &&
        (id === current.id ||
          (current.key === openKey() &&
            children()?.children.some((child) => child.sessionId === id)))
      )
        setGapRevision((n) => n + 1);
    }),
  );

  createEffect(() => {
    const current = sessions.current();
    if (!current?.server.builtin || !current.server.connected) return;
    runtime.retain();
    const release = runtime.cacheObserver.subscribe(current.id, () => setRevision((n) => n + 1));
    onCleanup(release);
  });

  createEffect(() => {
    const current = sessions.current();
    if (
      !current ||
      current.key !== openKey() ||
      !current.server.builtin ||
      !current.server.connected
    ) {
      setChildren(undefined);
      setTitle(undefined);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setTitle(undefined);
    setChildren({ status: "loading", children: [] });
    const release = runtime.cacheObserver.subscribeChildren(current.id, (snapshot) => {
      if (active) setChildren(snapshot);
    });
    void sessionClient
      .get({ sessionID: current.id }, { signal: controller.signal })
      .then((info) => {
        if (!controller.signal.aborted) setTitle(safeTitle(info.title, "Untitled session"));
      })
      .catch(() => {
        if (!controller.signal.aborted) setTitle("Untitled session");
      });
    onCleanup(() => {
      active = false;
      controller.abort();
      release();
    });
  });

  createEffect(() => {
    const current = sessions.current();
    const snapshot = children();
    if (!current || current.key !== openKey() || !snapshot) return;
    const releases = snapshot.children
      .filter((child) => child.sessionId !== current.id)
      .map((child) =>
        runtime.cacheObserver.subscribe(child.sessionId, () => setRevision((n) => n + 1)),
      );
    onCleanup(() => {
      for (const release of releases) release();
    });
  });

  // Collapse observation notifications to the set of sessions needing history.
  // A stream gap fences a previously available ratio, changing this key; ordinary
  // updates that do not change demand leave the active batch alone.
  const historyDemand = createMemo(() => {
    revision();
    const current = sessions.current();
    const snapshot = children();
    const popupOpen = current?.key === openKey();
    if (!current?.server.builtin || !current.server.connected) return "[]";
    const ids = [
      current.id,
      ...(popupOpen ? (snapshot?.children.map((child) => child.sessionId) ?? []) : []),
    ];
    const missing = [...new Set(ids)].filter(
      (id) => !runtime.cacheObserver.query(id)?.primaryCacheReadRatio,
    );
    return JSON.stringify(missing);
  });

  createEffect(() => {
    const current = sessions.current();
    const source = transport();
    gapRevision();
    const missing = JSON.parse(historyDemand()) as string[];
    if (!current?.server.builtin || !current.server.connected || source.rpc !== "live") {
      setHistory((previous) => (previous?.status === "loading" ? undefined : previous));
      return;
    }
    if (!missing.length) {
      setHistory({ key: current.key, status: "ready" });
      return;
    }
    const controller = new AbortController();
    setHistory({ key: current.key, status: "loading" });
    // Observer callbacks may fire while a stream gap is still invalidating its
    // old batch. Start after that synchronous invalidation has completed.
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      void runtime.cacheObserver
        .bootstrapHistory(missing, controller.signal)
        .then(() => {
          if (!controller.signal.aborted) {
            setHistory({ key: current.key, status: "ready" });
            setRevision((n) => n + 1);
          }
        })
        .catch(() => {
          if (!controller.signal.aborted) setHistory({ key: current.key, status: "error" });
        });
    });
    onCleanup(() => controller.abort());
  });

  function view(id: string) {
    revision();
    const observed = runtime.cacheObserver.query(id);
    const source = transport();
    // A past green result is not current proof when event coverage has been lost.
    return presentation(
      observed?.color === "green" && (source.rpc !== "live" || source.hostEvents !== "observed")
        ? { ...observed, color: "yellow" }
        : observed,
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
      const loading =
        selected &&
        history()?.key === session.key &&
        history()?.status === "loading" &&
        !result.percent;
      const hasError = selected && history()?.key === session.key && history()?.status === "error";
      return {
        label: loading ? "Cache · Loading…" : `Cache${result.percent ? ` ${result.percent}` : ""}`,
        icon: hasError ? "warning" : "archive",
        ...(result.tone ? { tone: result.tone } : hasError ? { tone: "warning" as const } : {}),
        title: "Cache observation",
      };
    },
    menu(input) {
      let ownedKey: string | undefined;
      createEffect(() => {
        ownedKey = input.session.key;
        setOpenKey(ownedKey);
      });
      onCleanup(() => setOpenKey((key) => (key === ownedKey ? undefined : key)));
      const row = (id: () => string, label: () => string, child: boolean) => {
        const tooltipId = createUniqueId();
        const [hovered, setHovered] = createSignal(false);
        const [focused, setFocused] = createSignal(false);
        const [pinned, setPinned] = createSignal(false);
        const details = () => view(id()).detail || view(id()).source;
        createEffect(() => {
          if (!hovered() && !focused() && !pinned()) return;
          const dismiss = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            setHovered(false);
            setFocused(false);
            setPinned(false);
          };
          document.addEventListener("keydown", dismiss);
          onCleanup(() => document.removeEventListener("keydown", dismiss));
        });
        return (
          <div class={`qg-cache-row${child ? " qg-cache-child" : ""}`}>
            <div class="qg-cache-row-heading">
              <Show
                when={details()}
                fallback={
                  <span
                    class="qg-cache-indicator"
                    role="img"
                    aria-label="Cache observation unknown"
                  />
                }
              >
                <fieldset
                  class="qg-cache-info"
                  aria-label={`Cache details for ${label()}`}
                  onMouseEnter={() => setHovered(true)}
                  onMouseLeave={() => setHovered(false)}
                >
                  <button
                    type="button"
                    class={`qg-cache-indicator qg-cache-${view(id()).tone ?? "neutral"}`}
                    aria-label={`Cache details for ${label()}`}
                    aria-describedby={tooltipId}
                    onFocus={() => setFocused(true)}
                    onBlur={() => {
                      setFocused(false);
                      setPinned(false);
                    }}
                    onClick={() => setPinned((value) => !value)}
                  />
                  <span
                    id={tooltipId}
                    role="tooltip"
                    class="qg-cache-tooltip"
                    hidden={!hovered() && !focused() && !pinned()}
                  >
                    <Show when={view(id()).detail}>
                      <span>{view(id()).detail}</span>
                    </Show>
                    <Show when={view(id()).source}>
                      <span>{view(id()).source}</span>
                    </Show>
                  </span>
                </fieldset>
              </Show>
              <span class="qg-cache-title">{label()}</span>
              <span>{summary(id())}</span>
            </div>
          </div>
        );
      };
      return (
        <div class="qg-cache-menu">
          <Show when={children()?.status === "loading"}>
            <output>Loading child sessions…</output>
          </Show>
          <Show when={children()?.status === "error"}>
            <p>Could not load child sessions.</p>
          </Show>
          <For each={children()?.children}>
            {(child) =>
              row(
                () => child.sessionId,
                () => safeTitle(child.label, "Untitled child session"),
                true,
              )
            }
          </For>
          <hr />
          {row(
            () => input.session.id,
            () => title() ?? "Loading session…",
            false,
          )}
          <Show when={history()?.key === input.session.key && history()?.status === "loading"}>
            <output>Loading cache history…</output>
          </Show>
          <Show when={history()?.key === input.session.key && history()?.status === "error"}>
            <p>Could not load cache history.</p>
          </Show>
        </div>
      );
    },
  };
}
