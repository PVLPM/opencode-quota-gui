import type { JSX } from "solid-js";
import { For, Show } from "solid-js";

/**
 * Canonical chart chrome (design spec §2; R31).
 *
 * Analytics, Project, Session and the model/provider surfaces all read as one
 * instrument: a heading row, one bordered panel, a summary strip and the plot.
 * The shell owns that hierarchy only; each chart keeps its own data, axes,
 * legends and inspection behavior. The `qg-summary` and `qg-usage` classes stay
 * on the intended nodes because the older focused tests anchor on them.
 */

export interface ChartSummaryItem {
  label: string;
  value: string;
  /** Rendered beside the label, e.g. the API-equivalent estimate disclosure. */
  info?: JSX.Element;
  /** Primary numbers lead; secondary values stay quieter. */
  emphasis?: "primary" | "secondary";
  /** Exact unformatted value for a hover title, when one is useful. */
  title?: string;
}

export function ChartSummary(props: { items: ChartSummaryItem[] }): JSX.Element {
  return (
    <div class="qg-summary">
      <For each={props.items}>
        {(item) => (
          <div class="qg-chart-shell__stat">
            <span class="qg-chart-shell__label">
              {item.label}
              <Show when={item.info}>{item.info}</Show>
            </span>
            <span
              class="qg-chart-shell__value"
              data-emphasis={item.emphasis === "primary" ? "primary" : "secondary"}
              title={item.title}
            >
              {item.value}
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

export function ChartShell(props: {
  title: string;
  /** Id for the section's own h2, also used as `aria-labelledby`. */
  headingId?: string;
  /** Optional right-side controls, such as the Models dimension switch. */
  actions?: JSX.Element;
  summary?: JSX.Element;
  children: JSX.Element;
  aside?: JSX.Element;
  /** Session charts add their modifier here without inventing a second shell. */
  bodyClass?: string;
}): JSX.Element {
  return (
    <section class="qg-section qg-chart-shell" aria-labelledby={props.headingId}>
      <header class="qg-chart-shell__head">
        <h2 class="qg-chart-shell__title" id={props.headingId}>
          <span class="qg-chart__title">{props.title}</span>
        </h2>
        <Show when={props.actions}>
          <div class="qg-chart-shell__actions">{props.actions}</div>
        </Show>
      </header>
      <div class="qg-chart-shell__panel">
        <Show when={props.summary}>{props.summary}</Show>
        <div class={props.bodyClass ?? "qg-usage"}>
          {props.children}
          <Show when={props.aside}>
            <aside class="qg-usage__aside">{props.aside}</aside>
          </Show>
        </div>
      </div>
    </section>
  );
}
