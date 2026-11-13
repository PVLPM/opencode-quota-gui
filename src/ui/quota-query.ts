import type { QuotaSnapshot } from "../contracts/dashboard";
import { createQuery } from "./query";

/** Shared by the shell and the quota route so a manual refresh is not discarded. */
export function createQuotaQuery(fetchQuota: (refresh: boolean) => Promise<QuotaSnapshot>) {
  let forceNext = false;
  let retryForce = false;
  let retryForceEpoch = 0;
  let epoch = 0;
  let reconnectedEpoch = 0;
  let unconsumedRefresh = false;
  let active: { forced: boolean; epoch: number; promise: Promise<boolean> } | undefined;
  let readsHeld: Promise<void> | undefined;
  const query = createQuery(async () => {
    const forced = forceNext;
    const requestEpoch = epoch;
    forceNext = false;
    const result = await fetchQuota(forced);
    if (requestEpoch !== epoch) throw new Error("Quota connection changed");
    return result;
  });

  function run(force = false, reconnect = false): Promise<boolean> {
    if (active && (!force || active.forced)) return active.promise;
    const forced = force || (retryForce && (reconnect || reconnectedEpoch > retryForceEpoch));
    const requestEpoch = epoch;
    if (forced) retryForce = false;
    forceNext = forced;
    const promise = query.run().then((applied) => {
      if (active?.promise === promise) {
        active = undefined;
        if (forced && !applied) {
          retryForce = true;
          retryForceEpoch = requestEpoch;
        }
        if (forced && applied) unconsumedRefresh = true;
        if (!forced && applied) unconsumedRefresh = false;
      }
      return applied;
    });
    active = { forced, epoch: requestEpoch, promise };
    return promise;
  }

  function retire(): void {
    if (active?.forced) {
      retryForce = true;
      retryForceEpoch = active.epoch;
    }
    active = undefined;
    query.invalidate();
    epoch++;
    unconsumedRefresh = false;
  }

  return {
    data: query.data,
    error: query.error,
    loading: query.loading,
    read: () => (readsHeld ? readsHeld.then(() => run()) : run()),
    refresh: () => run(true),
    afterReconnect: () => (readsHeld ? readsHeld.then(() => run(false, true)) : run(false, true)),
    isRefreshing: () => active?.forced === true,
    consumeRefresh: () => {
      const available = unconsumedRefresh;
      unconsumedRefresh = false;
      return available;
    },
    invalidate: retire,
    reconnected: () => {
      retire();
      reconnectedEpoch = epoch;
    },
    holdReads: () => {
      let release!: () => void;
      readsHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        readsHeld = undefined;
        release();
      };
    },
  };
}

export type QuotaQuery = ReturnType<typeof createQuotaQuery>;
