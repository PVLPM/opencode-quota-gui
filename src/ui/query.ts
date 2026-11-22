import { createSignal } from "solid-js";

/**
 * The dashboard's small request-state primitive (design spec §10 "States").
 *
 * One in-flight request wins: a superseded response is dropped, so a slow
 * range change can never overwrite a newer one. The browser shell and the
 * native Desktop panel share it rather than each keeping a private copy that
 * can drift.
 */

export interface Query<T> {
  data: () => T | undefined;
  error: () => unknown;
  loading: () => boolean;
  /** Resolves `true` when the fetched payload was applied (not superseded or failed). */
  run: () => Promise<boolean>;
}

/**
 * `shouldRetry` re-issues the same fetch inside one `run` while it returns true,
 * so the loading state and its elapsed clock continue. A superseded, invalidated
 * or unmounted run never retries.
 */
export function createQuery<T>(
  fetcher: () => Promise<T>,
  shouldRetry?: (failure: unknown, elapsedMs: number) => boolean,
): Query<T> & { invalidate: () => void } {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(false);
  let requestId = 0;

  async function run(): Promise<boolean> {
    const id = ++requestId;
    setLoading(true);
    const startedAt = Date.now();
    try {
      let value: T;
      for (;;) {
        try {
          value = await fetcher();
          break;
        } catch (failure) {
          if (id !== requestId || !shouldRetry?.(failure, Date.now() - startedAt)) throw failure;
        }
      }
      if (id !== requestId) return false;
      setData(() => value);
      setError(undefined);
      return true;
    } catch (failure) {
      if (id !== requestId) return false;
      setError(failure);
      return false;
    } finally {
      if (id === requestId) setLoading(false);
    }
  }

  function invalidate(): void {
    requestId++;
    setLoading(false);
  }

  return { data, error, loading, run, invalidate };
}
