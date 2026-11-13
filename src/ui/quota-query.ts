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
  let followUp: { after: Promise<boolean>; promise: Promise<boolean> } | undefined;

  /**
   * A quota change during an ordinary in-flight read may postdate that read, so
   * one follow-up read is owed after it. A forced refresh already asked the
   * provider, and a retired read is superseded, so neither owes one.
   */
  function readChanged(): Promise<boolean> {
    const current = active;
    if (!current || current.forced) return run();
    if (followUp?.after === current.promise) return followUp.promise;
    const requestEpoch = epoch;
    const promise = current.promise.then((applied) => (requestEpoch === epoch ? run() : applied));
    followUp = { after: current.promise, promise };
    return promise;
  }

  function read(options?: { changed?: boolean }): Promise<boolean> {
    const go = options?.changed ? readChanged : run;
    return readsHeld ? readsHeld.then(() => go()) : go();
  }
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
    read,
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
