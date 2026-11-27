import type { JSX } from "solid-js";
import type { RangeKey } from "../../contracts/ranges";
import type { UsageRangeKey } from "../../contracts/usage";
import { formatPath } from "../routing";

/**
 * Peer Quota / Usage tabs inside the existing Quota area. The Usage href keeps
 * the selected history range; Quota keeps the remembered Analytics range so the
 * two range vocabularies never bleed into each other.
 */
export function QuotaUsageTabs(props: {
  active: "quota" | "usage";
  range: RangeKey;
  usageRange?: UsageRangeKey;
}): JSX.Element {
  return (
    <nav class="qg-frame-tab qg-quota-tabs" aria-label="Quota views">
      <a
        href={formatPath({ name: "home" }, props.range)}
        aria-current={props.active === "quota" ? "page" : undefined}
      >
        Quota
      </a>
      <a
        href={formatPath({ name: "usage", usageRange: props.usageRange ?? "current" }, props.range)}
        aria-current={props.active === "usage" ? "page" : undefined}
      >
        Usage
      </a>
    </nav>
  );
}
