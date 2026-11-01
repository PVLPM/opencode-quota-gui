import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { ProviderLogo } from "./provider-logo.js";
import type { HeaderCard, HeaderRing } from "./session-header-model.js";

/**
 * The `session.header` token strip (Stage 6), split from the Slot host wiring so
 * its markup and event behavior can be tested against a real DOM.
 *
 * A token's rings use the server's explicit `slot`, never the ring array index:
 * 0 is the outer track, 1 the middle, 2 the inner. Hidden or missing windows
 * leave their track empty, so the weekly ring stays in the middle whether the
 * 5h window is present, hidden or absent. A zero-ring token draws only the
 * provider mark; it still opens the preview and the Panel.
 */

export interface SessionHeaderStripProps {
  cards: readonly HeaderCard[];
  visibleCount: number;
  hiddenCount: number;
  overflowVisible: boolean;
  previewOpen: boolean;
  previewId: string;
  maxWidth?: number;
  /**
   * Hidden while it has nothing to paint. The root stays mounted so the width
   * measurement still has an anchor, but a zero-content flex child would add
   * an extra gap between the host's other header actions.
   */
  hidden?: boolean;
  rootRef?: (element: HTMLDivElement) => void;
  onOpenPanel: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocusIn: () => void;
  onFocusOut: () => void;
  onEscape: () => void;
}

export function SessionHeaderStrip(props: SessionHeaderStripProps): JSX.Element {
  const visible = () => props.cards.slice(0, Math.max(0, props.visibleCount));
  const shownLabel = () =>
    `Quota usage, ${props.cards.length} ${props.cards.length === 1 ? "card" : "cards"}`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: the host header is a flex action row; a fieldset would add a form frame and legend, so the token strip is a labelled group.
    <div
      ref={props.rootRef}
      class="qg-native qg-slot-strip"
      role="group"
      aria-label={shownLabel()}
      style={
        props.hidden === true
          ? { display: "none" }
          : props.maxWidth === undefined
            ? undefined
            : { "max-width": `${Math.max(0, props.maxWidth)}px` }
      }
      onPointerEnter={props.onPointerEnter}
      onPointerLeave={props.onPointerLeave}
      onFocusIn={props.onFocusIn}
      onFocusOut={props.onFocusOut}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !props.previewOpen) return;
        event.preventDefault();
        props.onEscape();
      }}
    >
      <For each={visible()}>
        {(card) => (
          <button
            type="button"
            class="qg-slot-token"
            aria-label={card.ariaLabel}
            aria-describedby={props.previewOpen ? props.previewId : undefined}
            data-provider-id={card.providerId}
            data-ring-count={card.rings.length}
            onClick={() => {
              props.onOpenPanel();
            }}
          >
            <SlotTokenRings card={card} />
            <Show when={card.peak}>
              {(peak) => (
                <span
                  class="qg-slot-token__peak"
                  data-peak={peak()}
                  aria-hidden="true"
                  title={peak() === "now" ? "Peak now" : "Peak within an hour"}
                />
              )}
            </Show>
          </button>
        )}
      </For>
      <Show when={props.overflowVisible && props.hiddenCount > 0}>
        <button
          type="button"
          class="qg-slot-overflow"
          aria-label={`Show ${props.hiddenCount} more quota ${
            props.hiddenCount === 1 ? "card" : "cards"
          } in the dashboard`}
          aria-describedby={props.previewOpen ? props.previewId : undefined}
          onClick={() => {
            props.onOpenPanel();
          }}
        >
          {`+${props.hiddenCount}`}
        </button>
      </Show>
    </div>
  );
}

const RING_RADII = [12, 9.5, 7] as const;

function ringRadius(slot: HeaderRing["slot"]): (typeof RING_RADII)[number] {
  return RING_RADII[slot];
}

function SlotTokenRings(props: { card: HeaderCard }): JSX.Element {
  return (
    <span class="qg-slot-token__rings" aria-hidden="true">
      <Show when={props.card.rings.length > 0}>
        <svg viewBox="0 0 28 28" class="qg-slot-token__svg" aria-hidden="true">
          <For each={props.card.rings}>
            {(ring) => (
              <circle
                class="qg-slot-token__track"
                cx="14"
                cy="14"
                r={ringRadius(ring.slot)}
                data-ring-slot={ring.slot}
              />
            )}
          </For>
          <For each={props.card.rings}>
            {(ring) => (
              <circle
                class="qg-slot-token__ring"
                cx="14"
                cy="14"
                r={ringRadius(ring.slot)}
                pathLength="100"
                stroke-dasharray={`${ring.percent} ${100 - ring.percent}`}
                transform="rotate(-90 14 14)"
                data-ring-slot={ring.slot}
                data-row-id={ring.rowId}
                data-severity={ring.severity}
              />
            )}
          </For>
        </svg>
      </Show>
      <ProviderLogo providerId={props.card.providerId} class="qg-slot-token__logo" />
    </span>
  );
}
