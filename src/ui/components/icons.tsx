import type { JSX } from "solid-js";

/**
 * Inline SVG icons (design spec §10: inline-SVG icons only, no icon font, no
 * network request). Kept as plain data so a `createComponent`-based test can
 * render them without a JSX pragma. The two nav glyphs are the user-supplied
 * filled shapes on a 256 viewBox, scaled down to 16px; `fill="currentColor"` —
 * never the supplied black — keeps them responsive to the chrome state.
 */
function path(d: string): JSX.Element {
  return (
    <path
      d={d}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  );
}

function svg(children: JSX.Element, size: number): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

const CHART_LINE_THIN_PATH =
  "M228,208a4,4,0,0,1-4,4H32a4,4,0,0,1-4-4V48a4,4,0,0,1,8,0V151.19L93.37,101a4,4,0,0,1,5-.19l61.41,46.05L221.37,93a4,4,0,0,1,5.26,6l-64,56a4,4,0,0,1-5,.19l-61.41-46L36,161.81V204H224A4,4,0,0,1,228,208Z";

const FADERS_HORIZONTAL_THIN_PATH =
  "M180,80a4,4,0,0,1,4-4h32a4,4,0,0,1,0,8H184A4,4,0,0,1,180,80ZM40,84H148v20a4,4,0,0,0,8,0V56a4,4,0,0,0-8,0V76H40a4,4,0,0,0,0,8Zm176,88H120a4,4,0,0,0,0,8h96a4,4,0,0,0,0-8ZM88,148a4,4,0,0,0-4,4v20H40a4,4,0,0,0,0,8H84v20a4,4,0,0,0,8,0V152A4,4,0,0,0,88,148Z";

function filledIcon(d: string): JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 256 256"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/** Analytics tab: the user-supplied `chart-line-thin` shape. */
export function AnalyticsIcon(): JSX.Element {
  return filledIcon(CHART_LINE_THIN_PATH);
}

/** Quota tab: the user-supplied `faders-horizontal-thin` shape. */
export function QuotaIcon(): JSX.Element {
  return filledIcon(FADERS_HORIZONTAL_THIN_PATH);
}

/** A six-dot drag grip for the visibility provider cards. */
export function GripDotsIcon(): JSX.Element {
  return svg(
    <g fill="currentColor">
      <circle cx="7" cy="5" r="1.4" />
      <circle cx="13" cy="5" r="1.4" />
      <circle cx="7" cy="12" r="1.4" />
      <circle cx="13" cy="12" r="1.4" />
      <circle cx="7" cy="19" r="1.4" />
      <circle cx="13" cy="19" r="1.4" />
    </g>,
    16,
  );
}

/** Peak pricing: a compact upward arrow. */
export function PeakArrowIcon(props: { size?: number }): JSX.Element {
  return svg(path("M12 19V5M6.5 10.5 12 5l5.5 5.5"), props.size ?? 12);
}

/** Off-peak pricing: the matching downward arrow. */
export function OffpeakArrowIcon(props: { size?: number }): JSX.Element {
  return svg(path("M12 5v14M6.5 13.5 12 19l5.5-5.5"), props.size ?? 12);
}

export function RefreshIcon(props: { size?: number }): JSX.Element {
  return svg(
    <>
      {path("M20 11a8 8 0 1 0-2.3 5.7")}
      {path("M20 4.5V11h-6.5")}
    </>,
    props.size ?? 16,
  );
}

export function CloseIcon(props: { size?: number }): JSX.Element {
  return svg(path("M6 6l12 12M18 6L6 18"), props.size ?? 14);
}
