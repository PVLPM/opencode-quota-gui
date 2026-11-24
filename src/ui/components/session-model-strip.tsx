import type { JSX } from "solid-js";
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { ModelIdentity } from "../../contracts/dashboard";
import { fitModelIdentities } from "../session-model-fit";
import { InteractivePopover } from "./interactive-popover";
import { ModelIdentityLabel } from "./model-identity";

/** Separates ordered model identities, including the overflow bubble. */
const SEPARATOR = " → ";

/**
 * One ordered model line for an individual session header. A single identity
 * keeps a plain ellipsized line with the full value in `title`; several
 * identities fit as many complete entries as the header allows, then reuse the
 * dashboard's established `+N` disclosure and ordered list.
 */
export function SessionModelStrip(props: { identities: readonly ModelIdentity[] }): JSX.Element {
  const [visibleCount, setVisibleCount] = createSignal(props.identities.length);
  let host: HTMLParagraphElement | undefined;
  let measure: HTMLSpanElement | undefined;
  let disposed = false;

  const refit = (): void => {
    if (disposed) return;
    const total = props.identities.length;
    if (total <= 1 || host === undefined || measure === undefined) {
      setVisibleCount(total);
      return;
    }
    const availableWidth = host.getBoundingClientRect().width;
    if (!(availableWidth > 0)) return;
    const entryWidths = Array.from(
      measure.querySelectorAll<HTMLElement>("[data-fit-entry]"),
      (node) => node.getBoundingClientRect().width,
    );
    const separatorWidth =
      measure.querySelector<HTMLElement>("[data-fit-separator]")?.getBoundingClientRect().width ??
      0;
    const overflowWidth =
      measure.querySelector<HTMLElement>("[data-fit-overflow]")?.getBoundingClientRect().width ?? 0;
    setVisibleCount(
      fitModelIdentities({
        availableWidth,
        entryWidths,
        separatorWidth,
        overflowWidth,
      }).visibleCount,
    );
  };

  onMount(() => {
    refit();
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => refit());
    if (observer !== undefined && host !== undefined) observer.observe(host);
    onCleanup(() => {
      disposed = true;
      observer?.disconnect();
    });
    // Font loading can change text metrics after the first measurement.
    if (typeof document !== "undefined" && document.fonts !== undefined) {
      void document.fonts.ready.then(() => refit());
    }
  });
  createEffect(
    on(
      () => props.identities,
      () => refit(),
      { defer: true },
    ),
  );

  const overflowCount = () => props.identities.length - visibleCount();

  return (
    <Show
      when={props.identities.length > 1}
      fallback={
        <Show when={props.identities[0]}>
          {(identity) => (
            <p class="qg-page-head__models">
              <ModelIdentityLabel identity={identity()} />
            </p>
          )}
        </Show>
      }
    >
      <p class="qg-page-head__models" ref={host}>
        <For each={props.identities.slice(0, visibleCount())}>
          {(identity, index) => (
            <>
              <Show when={index() > 0}>
                <span class="qg-page-head__models-sep" aria-hidden="true">
                  {SEPARATOR}
                </span>
              </Show>
              <span class="qg-page-head__models-entry">
                <ModelIdentityLabel identity={identity} />
              </span>
            </>
          )}
        </For>
        <Show when={overflowCount() > 0}>
          <Show when={visibleCount() > 0}>
            <span class="qg-page-head__models-sep" aria-hidden="true">
              {SEPARATOR}
            </span>
          </Show>
          <InteractivePopover
            label={`${overflowCount()} more model configurations. Show all ${props.identities.length}.`}
            panelLabel="Model configurations used by this session, in first-use order"
            triggerClass="qg-node__more"
            contentClass="qg-temporal-popover"
            placement="bottom-start"
            content={
              <ol class="qg-node__model-list">
                <For each={props.identities}>
                  {(identity) => (
                    <li>
                      <ModelIdentityLabel identity={identity} />
                    </li>
                  )}
                </For>
              </ol>
            }
          >
            +{overflowCount()}
          </InteractivePopover>
        </Show>
        <span class="qg-page-head__models-measure" aria-hidden="true" ref={measure}>
          <For each={props.identities}>
            {(identity) => (
              <span data-fit-entry>
                <ModelIdentityLabel identity={identity} />
              </span>
            )}
          </For>
          <span data-fit-separator>{SEPARATOR}</span>
          <span data-fit-overflow>+{props.identities.length}</span>
        </span>
      </p>
    </Show>
  );
}
