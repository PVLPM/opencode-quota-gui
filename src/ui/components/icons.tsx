import type { JSX } from "solid-js";

/**
 * Inline SVG icons (design spec §10: inline-SVG icons only, no icon font, no
 * network request). Kept as plain data so a `createComponent`-based test can
 * render them without a JSX pragma.
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

export function EyeIcon(props: { size?: number }): JSX.Element {
  return svg(
    <>
      {path("M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z")}
      {path("M12 14.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z")}
    </>,
    props.size ?? 16,
  );
}

/** The public window-analytics glyph depicts windows, not a chart. */
export function AnalyticsIcon(): JSX.Element {
  return svg(
    <>
      {path("M4 4v16h17")}
      {path("M8 16v-5M13 16V7M18 16v-8")}
    </>,
    16,
  );
}

export function EyeOffIcon(props: { size?: number }): JSX.Element {
  return svg(
    <>
      {path("M3 3l18 18")}
      {path("M10.6 5.7A10.6 10.6 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.2 4")}
      {path("M6.3 7.9A17.4 17.4 0 0 0 2 12s3.6 6.5 10 6.5a10.9 10.9 0 0 0 4.2-.8")}
    </>,
    props.size ?? 16,
  );
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
