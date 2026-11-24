import {
  type PricingRefreshResult,
  type PricingRoute,
  refreshAnalyticsPricing,
} from "../lib/modelsdev-pricing.js";
import type { AnalyticsUpkeepNotification } from "./analytics-protocol.js";

/**
 * Worker-side tracking for pricing upkeep started after an analytics reply.
 *
 * A refresh can outlive the read queue (the fetch timeout alone is 6 s). The
 * worker advertises start/end frames so the host bridge delays idle retirement
 * until the refresh settles, while the analytics reply itself is never awaited
 * on the refresh.
 */
export interface AnalyticsPricingUpkeep {
  begin(): void;
}

export function createAnalyticsPricingUpkeep(params: {
  postMessage: (message: AnalyticsUpkeepNotification) => void;
  routes: () => readonly PricingRoute[];
  refresh?: (options: {
    routes: readonly PricingRoute[];
  }) => Promise<void | PricingRefreshResult | undefined>;
}): AnalyticsPricingUpkeep {
  const refresh: (options: {
    routes: readonly PricingRoute[];
  }) => Promise<void | PricingRefreshResult | undefined> =
    params.refresh ?? refreshAnalyticsPricing;
  let active = 0;

  return {
    begin() {
      active += 1;
      if (active === 1) params.postMessage({ type: "analytics-upkeep", active: true });
      // Deferred one microtask: `begin` is called before the caller posts its
      // reply frame, so the refresh starts only after that frame is queued.
      void Promise.resolve()
        .then(() => refresh({ routes: params.routes() }))
        .catch(() => {})
        .finally(() => {
          active -= 1;
          if (active === 0) params.postMessage({ type: "analytics-upkeep", active: false });
        });
    },
  };
}
