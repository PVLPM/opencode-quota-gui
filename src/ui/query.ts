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

export function createQuery<T>(fetcher: () => Promise<T>): Query<T> {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [error, setError] = createSignal<unknown>(undefined);
  const [loading, setLoading] = createSignal(false);
  let requestId = 0;

  async function run(): Promise<boolean> {
    const id = ++requestId;
    setLoading(true);
    try {
      const value = await fetcher();
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

  return { data, error, loading, run };
}
