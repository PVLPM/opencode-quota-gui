import { type MountedSession, type SlotMap, usePlugin } from "@opencode/plugin/gui";
import type { JSX } from "solid-js";
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import { QuotaBar } from "../ui/components/quota-card.js";
import type { DisplayPreferences } from "../ui/quota-semantics.js";
import { inlineAccountLabel } from "../ui/quota-semantics.js";
import { createNativeDashboardClient } from "./dashboard-client.js";
import { placePopover } from "./popover-position.js";
import { ProviderLogo } from "./provider-logo.js";
import { createGuiRpcCaller } from "./rpc.js";
import {
  fitMeasuredHeaderTokens,
  measureStripGeometry,
  observeHeaderBudget,
} from "./session-header-measure.js";
import { type HeaderCard, peakPreviewText } from "./session-header-model.js";
import { createPreviewDisclosure, previewShouldClose } from "./session-header-preview.js";
import { createSessionHeaderSource } from "./session-header-source.js";
import { SessionHeaderStrip } from "./session-header-strip.js";

export type { SessionHeaderStripProps } from "./session-header-strip.js";
export { SessionHeaderStrip } from "./session-header-strip.js";

/**
 * The `session.header` Slot (Stage 6).
 *
 * One compact token per eligible visible quota card; its zero-to-three rings
 * use the shared card semantics and each ring's stable server-assigned slot,
 * its Peak dot is derived from the existing temporal snapshot, and `+N`
 * accounts for cards the header width cannot show.
 * A card with no classified primary window keeps a zero-ring, logo-only token;
 * eligibility and preview inclusion never depend on the optional metadata.
 * Hover/focus opens one combined preview for every eligible card; click reveals
 * the dashboard Panel without resetting its route.
 *
 * Data uses the same shared runtime and scoped viewer as the Panel: one
 * `quota` viewer, one settings read, one event stream. The Slot owns no
 * analytics, timer, heartbeat or poller.
 */

const PREVIEW_GUTTER = 6;
const PREVIEW_SHIFT = 8;

/* ------------------------------------------------------------- presentation */

export interface SessionHeaderPreviewBodyProps {
  cards: readonly HeaderCard[];
  preferences: DisplayPreferences;
  nowMs: number;
  id?: string;
}

/** The combined preview's content; deliberately portal-free for string rendering. */
export function SessionHeaderPreviewBody(props: SessionHeaderPreviewBodyProps): JSX.Element {
  return (
    <div class="qg-slot-preview" role="tooltip" id={props.id}>
      <For each={props.cards}>
        {(card) => {
          const peak = () => peakPreviewText(card.peak, card.peakAtMs, props.nowMs);
          return (
            <article class="qg-slot-preview__card" data-provider-id={card.providerId}>
              <header class="qg-slot-preview__head">
                <ProviderLogo providerId={card.providerId} class="qg-slot-preview__logo" />
                <span class="qg-slot-preview__provider">{card.providerLabel}</span>
                <Show when={card.planLabel}>
                  {(plan) => <span class="qg-slot-preview__meta">{plan()}</span>}
                </Show>
                <Show when={card.accountLabel}>
                  {(account) => (
                    <span class="qg-slot-preview__meta">
                      {inlineAccountLabel(card.providerLabel, account())}
                    </span>
                  )}
                </Show>
                <Show when={peak()}>
                  {(text) => (
                    <span class="qg-slot-preview__peak" data-peak={card.peak}>
                      {text()}
                    </span>
                  )}
                </Show>
              </header>
              <ul class="qg-slot-preview__rows">
                <For each={card.previewRows}>
                  {(row) => (
                    <li
                      class="qg-slot-preview__row"
                      data-row-id={row.rowId}
                      data-severity={row.severity}
                    >
                      <span class="qg-slot-preview__label">{row.label}</span>
                      <span class="qg-slot-preview__value">{row.valueText}</span>
                      <Show when={row.countdown}>
                        {(countdown) => (
                          <span class="qg-slot-preview__reset">Resets in {countdown()}</span>
                        )}
                      </Show>
                      <QuotaBar
                        label={row.label}
                        displayPercent={row.percent}
                        displayMode={props.preferences.percentMode}
                      />
                    </li>
                  )}
                </For>
              </ul>
            </article>
          );
        }}
      </For>
    </div>
  );
}

/* ------------------------------------------------------------------ view */

export interface NativeSessionHeaderProps {
  input: SlotMap["session.header"];
  onOpenPanel: (session: MountedSession) => void;
}

export function NativeSessionHeader(props: NativeSessionHeaderProps): JSX.Element {
  const ctx = usePlugin();
  const client = createNativeDashboardClient({
    rpc: createGuiRpcCaller(ctx),
    scope: "quota",
  });
  onCleanup(() => client.dispose());

  const hostServer = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .find((server) => server?.builtin);
  const hostConnected = () => hostServer()?.connected ?? true;
  const source = createSessionHeaderSource({
    client,
    active: () => props.input.active,
    hostConnected,
  });
  const disclosure = createPreviewDisclosure();
  onCleanup(() => disclosure.dispose());
  const previewId = createUniqueId();
  const [budget, setBudget] = createSignal<number>();
  const [geometryRevision, setGeometryRevision] = createSignal(0);
  let root: HTMLDivElement | undefined;
  let remeasure: (() => void) | undefined;

  const geometry = createMemo(() => {
    const count = source.view().cards.length;
    budget(); // Font/zoom and host resizing can change the rendered chip widths.
    geometryRevision();
    return root === undefined || typeof document === "undefined"
      ? { tokenWidth: 28, gap: 4, chipWidths: [] as (number | undefined)[] }
      : measureStripGeometry(root, count);
  });
  const fit = createMemo(() => {
    const metrics = geometry();
    return fitMeasuredHeaderTokens(
      budget() ?? 0,
      source.view().cards.length,
      metrics.tokenWidth,
      metrics.gap,
      (hidden) => metrics.chipWidths[hidden],
    );
  });
  const stripVisible = () => {
    const current = fit();
    return current.visibleCount > 0 || current.overflowVisible;
  };

  createEffect(() => {
    // A cached timeline stays mounted while hidden, and the preview is a body
    // portal, so an inactive timeline must close it explicitly. No visible token
    // also means no hover/focus source and no usable anchor.
    if (
      previewShouldClose({
        active: props.input.active,
        hasVisibleToken: stripVisible(),
        cardCount: source.view().cards.length,
      })
    ) {
      disclosure.close();
    }
  });

  onMount(() => {
    const element = root;
    if (element === undefined) return;
    const observer = observeHeaderBudget(element, setBudget);
    // Observe rendered controls, not the strip width: a font or zoom change can
    // alter +N without changing the available host width.
    const controls = new Set<Element>();
    const controlObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => setGeometryRevision((value) => value + 1));
    const syncControls = () => {
      const current = new Set(element.querySelectorAll(".qg-slot-token, .qg-slot-overflow"));
      for (const control of controls)
        if (!current.has(control)) {
          controlObserver?.unobserve(control);
          controls.delete(control);
        }
      for (const control of current)
        if (!controls.has(control)) {
          controls.add(control);
          controlObserver?.observe(control);
        }
    };
    const controlMutations =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(syncControls);
    controlMutations?.observe(element, { childList: true, subtree: true });
    syncControls();
    const onFontsLoaded = () => setGeometryRevision((value) => value + 1);
    document.fonts?.addEventListener("loadingdone", onFontsLoaded);
    remeasure = observer.measure;
    onCleanup(() => {
      remeasure = undefined;
      observer.dispose();
      controlObserver?.disconnect();
      controlMutations?.disconnect();
      document.fonts?.removeEventListener("loadingdone", onFontsLoaded);
    });
  });

  // A cached timeline can mount while its header has no layout; measuring again
  // when it becomes the visible timeline avoids keeping an empty strip.
  createEffect(() => {
    if (props.input.active) remeasure?.();
  });

  const view = () => source.view();
  const preferences = (): DisplayPreferences =>
    source.preferences() ?? {
      // Unreachable while cards are rendered: the model only builds cards from
      // a real settings payload. The direction stays the product's default.
      percentMode: "remaining",
      showRunway: false,
      detailed: false,
    };

  return (
    <>
      <SessionHeaderStrip
        cards={view().cards}
        visibleCount={fit().visibleCount}
        hiddenCount={fit().hiddenCount}
        overflowVisible={fit().overflowVisible}
        previewOpen={disclosure.open()}
        previewId={previewId}
        hidden={!stripVisible()}
        {...(budget() === undefined ||
        (fit().visibleCount === 0 &&
          fit().overflowVisible &&
          geometry().chipWidths[fit().hiddenCount] === undefined)
          ? {}
          : {
              maxWidth: Math.max(
                budget() ?? 0,
                fit().visibleCount === 0 && fit().overflowVisible
                  ? (geometry().chipWidths[fit().hiddenCount] ?? 0)
                  : 0,
              ),
            })}
        rootRef={(element) => {
          root = element;
        }}
        onOpenPanel={() => {
          disclosure.close();
          props.onOpenPanel(props.input.session);
        }}
        onPointerEnter={disclosure.onPointerEnter}
        onPointerLeave={disclosure.onPointerLeave}
        onFocusIn={disclosure.onFocusIn}
        onFocusOut={disclosure.onFocusOut}
        onEscape={disclosure.onEscape}
      />
      <Show when={disclosure.open() && view().cards.length > 0}>
        <SessionHeaderPreviewLayer
          anchor={() => root}
          id={previewId}
          cards={view().cards}
          preferences={preferences()}
          nowMs={view().nowMs}
          onPointerEnter={disclosure.onPreviewPointerEnter}
          onPointerLeave={disclosure.onPreviewPointerLeave}
        />
      </Show>
    </>
  );
}

/* --------------------------------------------------------------- preview layer */

function SessionHeaderPreviewLayer(props: {
  anchor: () => HTMLElement | undefined;
  id: string;
  cards: readonly HeaderCard[];
  preferences: DisplayPreferences;
  /** The timestamp of the latest view; no local clock or per-minute timer. */
  nowMs: number;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}): JSX.Element {
  const [content, setContent] = createSignal<HTMLDivElement>();
  const [left, setLeft] = createSignal(0);
  const [top, setTop] = createSignal(0);
  const [maxHeight, setMaxHeight] = createSignal<number>();
  const [ready, setReady] = createSignal(false);

  function measure(): void {
    const anchor = props.anchor();
    const box = content();
    if (anchor === undefined || box === undefined) return;
    const anchorRect = anchor.getBoundingClientRect();
    const contentRect = box.getBoundingClientRect();
    const result = placePopover({
      anchor: {
        left: anchorRect.left,
        top: anchorRect.top,
        width: anchorRect.width,
        height: anchorRect.height,
      },
      content: { width: contentRect.width, height: contentRect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      placement: "bottom-start",
      gutter: PREVIEW_GUTTER,
      shift: PREVIEW_SHIFT,
    });
    setLeft(result.left);
    setTop(result.top);
    setMaxHeight(result.maxHeight);
    setReady(true);
  }

  onMount(() => {
    measure();
    const onViewportChange = () => measure();
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => measure());
    const box = content();
    if (box !== undefined) observer?.observe(box);
    onCleanup(() => {
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
      observer?.disconnect();
    });
  });

  return (
    <Portal>
      <div
        class="qg-native qg-native-portal qg-slot-preview-layer"
        style={{
          left: `${left()}px`,
          top: `${top()}px`,
          visibility: ready() ? undefined : "hidden",
        }}
        onPointerEnter={props.onPointerEnter}
        onPointerLeave={props.onPointerLeave}
      >
        <div
          ref={setContent}
          style={
            maxHeight() === undefined
              ? undefined
              : { "max-height": `${maxHeight()}px`, "overflow-y": "auto" }
          }
        >
          <SessionHeaderPreviewBody
            id={props.id}
            cards={props.cards}
            preferences={props.preferences}
            nowMs={props.nowMs}
          />
        </div>
      </div>
    </Portal>
  );
}
