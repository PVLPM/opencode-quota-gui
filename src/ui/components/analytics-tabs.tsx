import type { JSX } from "solid-js";
import { For } from "solid-js";
import type { AnalyticsDimension } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import type { UsageRangeKey } from "../../contracts/usage";
import { formatPath } from "../routing";

/**
 * Peer tabs live in the frame header, beside the global range selector. They
 * are real links so middle-click, new-tab and history behavior stay native; the
 * range is carried into every href.
 *
 * One `FrameTabs` draws every peer row, so Analytics/Models and Quota/Usage
 * share the same markup, gap and active underline by construction: the Native
 * panel styles `.qg-frame-tab:not(.qg-analytics-tabs)` with a full-width bottom
 * border, and a second implementation would draw an underline Analytics never
 * has. `href` and `active` stay accessors so a route or range change updates
 * the mounted row without remounting it.
 */
export interface FrameTab {
  label: string;
  href: () => string;
  active: () => boolean;
}

export function FrameTabs(props: { label: string; tabs: readonly FrameTab[] }): JSX.Element {
  return (
    <nav class="qg-frame-tab qg-analytics-tabs" aria-label={props.label}>
      <For each={props.tabs}>
        {(tab) => (
          <a href={tab.href()} aria-current={tab.active() ? "page" : undefined}>
            {tab.label}
          </a>
        )}
      </For>
    </nav>
  );
}

export function AnalyticsTabs(props: {
  active: "analytics" | "models";
  range: RangeKey;
  modelsDimension?: AnalyticsDimension;
}): JSX.Element {
  return (
    <FrameTabs
      label="Analytics views"
      tabs={[
        {
          label: "Analytics",
          href: () => formatPath({ name: "analytics" }, props.range),
          active: () => props.active === "analytics",
        },
        {
          label: "Models",
          href: () =>
            formatPath(
              { name: "models", dimension: props.modelsDimension ?? "model" },
              props.range,
            ),
          active: () => props.active === "models",
        },
      ]}
    />
  );
}

/**
 * Quota / Usage are peers inside the Quota area. The Usage href keeps the
 * selected history range; Quota keeps the remembered Analytics range so the two
 * range vocabularies never bleed into each other.
 */
export function QuotaUsageTabs(props: {
  active: "quota" | "usage";
  range: RangeKey;
  usageRange?: UsageRangeKey;
}): JSX.Element {
  return (
    <FrameTabs
      label="Quota views"
      tabs={[
        {
          label: "Quota",
          href: () => formatPath({ name: "home" }, props.range),
          active: () => props.active === "quota",
        },
        {
          label: "Usage",
          href: () =>
            formatPath({ name: "usage", usageRange: props.usageRange ?? "current" }, props.range),
          active: () => props.active === "usage",
        },
      ]}
    />
  );
}
