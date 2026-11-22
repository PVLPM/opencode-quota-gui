import { afterEach, describe, expect, it, vi } from "vitest";

import { ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS } from "../src/gui/analytics-protocol.js";
import { createQuery } from "../src/ui/query.js";
import { isHostRpcTimeout } from "../src/ui/view-model.js";

const hostTimeout = {
  name: "ClientError",
  reason: "Transport",
  cause: new DOMException("The operation timed out", "TimeoutError"),
};

// The exact predicate AnalyticsRoute passes to createQuery.
const retryHostTimeout = (failure: unknown, elapsedMs: number): boolean =>
  isHostRpcTimeout(failure) && elapsedMs < ANALYTICS_DEFAULT_REQUEST_TIMEOUT_MS;

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (failure: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createQuery host-timeout re-join", () => {
  it("keeps loading across a host timeout and applies the joined read", async () => {
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(hostTimeout)
      .mockResolvedValueOnce("home");
    const query = createQuery(fetcher, retryHostTimeout);

    const applied = await query.run();

    expect(applied).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(query.data()).toBe("home");
    expect(query.error()).toBeUndefined();
    expect(query.loading()).toBe(false);
  });

  it("stays loading between the timeout and the re-issued request", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const query = createQuery(fetcher, retryHostTimeout);

    const run = query.run();
    first.reject(hostTimeout);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(query.loading()).toBe(true);
    expect(query.error()).toBeUndefined();
    second.resolve("home");
    await run;
    expect(query.data()).toBe("home");
  });

  it("surfaces a non-timeout server error from the re-issued request", async () => {
    const serverError = { type: "internal", message: "Internal dashboard error" };
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(hostTimeout)
      .mockRejectedValueOnce(serverError);
    const query = createQuery(fetcher, retryHostTimeout);

    expect(await query.run()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(query.error()).toBe(serverError);
    expect(query.data()).toBeUndefined();
  });

  it("stops re-issuing once the server read budget has elapsed", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      vi.advanceTimersByTime(60_000);
      throw hostTimeout;
    });
    const query = createQuery(fetcher, retryHostTimeout);

    expect(await query.run()).toBe(false);
    // 60 s per aborted request: the third failure lands at the 180 s budget.
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(isHostRpcTimeout(query.error())).toBe(true);
  });

  it("does not re-issue after the route invalidates (unmount or navigation)", async () => {
    const first = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>().mockReturnValue(first.promise);
    const query = createQuery(fetcher, retryHostTimeout);

    const run = query.run();
    query.invalidate();
    first.reject(hostTimeout);

    expect(await run).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(query.error()).toBeUndefined();
  });

  it("does not re-issue when a newer run supersedes the timed-out one", async () => {
    const timedOut = deferred<string>();
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(timedOut.promise)
      .mockResolvedValueOnce("newer");
    const query = createQuery(fetcher, retryHostTimeout);

    const first = query.run();
    const second = query.run();
    timedOut.reject(hostTimeout);

    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(query.data()).toBe("newer");
  });

  it("leaves the warm path unchanged: one request, no retry", async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockResolvedValue("home");
    const query = createQuery(fetcher, retryHostTimeout);

    expect(await query.run()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("never retries without a predicate (other routes)", async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockRejectedValue(hostTimeout);
    const query = createQuery(fetcher);

    expect(await query.run()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
