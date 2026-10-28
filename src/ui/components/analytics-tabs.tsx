import type { JSX } from "solid-js";
import type { AnalyticsDimension } from "../../contracts/dashboard";
import type { RangeKey } from "../../contracts/ranges";
import { formatPath } from "../routing";

/**
 * Peer Analytics / Models tabs live in the Analytics frame header, beside the
 * global range selector. They are real links so middle-click, new-tab and
 * history behavior stay native; the range is carried into both hrefs.
 */
export function AnalyticsTabs(props: {
  active: "analytics" | "models";
  range: RangeKey;
  modelsDimension?: AnalyticsDimension;
}): JSX.Element {
  return (
    <nav class="qg-frame-tab qg-analytics-tabs" aria-label="Analytics views">
      <a
        href={formatPath({ name: "analytics" }, props.range)}
        aria-current={props.active === "analytics" ? "page" : undefined}
      >
        Analytics
      </a>
      <a
        href={formatPath(
          { name: "models", dimension: props.modelsDimension ?? "model" },
          props.range,
        )}
        aria-current={props.active === "models" ? "page" : undefined}
      >
        Models
      </a>
    </nav>
  );
}
