import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardError } from "../src/ui/dashboard-client.js";
import { createQuery } from "../src/ui/query.js";
import {
  isHostRpcTimeout,
  isRecoverableReadFailure,
  rejoinAnalyticsRead,
  shouldRejoinAnalyticsRead,
} from "../src/ui/view-model.js";

const hostTimeout = {
  name: "ClientError",
  reason: "Transport",
  cause: new DOMException("The operation timed out", "TimeoutError"),
};

// The same predicate AnalyticsRoute passes to createQuery.
const retryHostTimeout = shouldRejoinAnalyticsRead;

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

  it("probes the server cache once after the budget and applies a late result", async () => {
    vi.useFakeTimers();
    const deadlineFailure = async (): Promise<string> => {
      vi.advanceTimersByTime(60_000);
      throw hostTimeout;
    };
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(deadlineFailure)
      .mockImplementationOnce(deadlineFailure)
      .mockImplementationOnce(deadlineFailure)
      .mockResolvedValueOnce("late");
    const real = createQuery(
      () => fetcher(),
      retryHostTimeout,
      (failure, elapsedMs) => isHostRpcTimeout(failure) && elapsedMs >= 180_000,
    );

    expect(await real.run()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(real.data()).toBe("late");
  });

  it("surfaces the host timeout when the final probe also fails", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<() => Promise<string>>().mockImplementation(async () => {
      vi.advanceTimersByTime(60_000);
      throw hostTimeout;
    });
    const real = createQuery(
      () => fetcher(),
      retryHostTimeout,
      (failure, elapsedMs) => isHostRpcTimeout(failure) && elapsedMs >= 180_000,
    );

    expect(await real.run()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(isHostRpcTimeout(real.error())).toBe(true);
  });

  it("does not probe after an unmount invalidates the run", async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn<() => Promise<string>>().mockReturnValue(pending.promise);
    const real = createQuery(
      () => fetcher(),
      retryHostTimeout,
      (failure, elapsedMs) => isHostRpcTimeout(failure) && elapsedMs >= 180_000,
    );

    const run = real.run();
    real.invalidate();
    pending.reject(hostTimeout);
    expect(await run).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a worker timeout as terminal, never as a host timeout", async () => {
    const workerTimeout = { type: "internal", message: "Internal dashboard error" };
    const fetcher = vi.fn<() => Promise<string>>().mockRejectedValue(workerTimeout);
    const query = createQuery(fetcher, retryHostTimeout, () => false);

    expect(await query.run()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(query.error()).toBe(workerTimeout);
    vi.useRealTimers();
  });

  it("never retries without a predicate (other routes)", async () => {
    const fetcher = vi.fn<() => Promise<string>>().mockRejectedValue(hostTimeout);
    const query = createQuery(fetcher);

    expect(await query.run()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("prefetch re-join and recoverable classification", () => {
  it("re-joins a host timeout for a background prefetch", async () => {
    const read = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(hostTimeout)
      .mockResolvedValueOnce("lifetime");

    await expect(rejoinAnalyticsRead(read)).resolves.toBe("lifetime");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops on a non-host failure without a second call", async () => {
    const terminal = { type: "internal", message: "Internal dashboard error" };
    const read = vi.fn<() => Promise<string>>().mockRejectedValue(terminal);

    await expect(rejoinAnalyticsRead(read)).rejects.toBe(terminal);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("stops issuing reads once the owning shell is gone", async () => {
    let cancelled = false;
    let calls = 0;
    const read = async (): Promise<string> => {
      calls += 1;
      cancelled = true;
      throw hostTimeout;
    };

    await expect(rejoinAnalyticsRead(read, () => cancelled)).rejects.toThrow(
      "analytics read cancelled",
    );
    expect(calls).toBe(1);
  });

  it("classifies retryable and permanent read failures", () => {
    expect(isRecoverableReadFailure(hostTimeout)).toBe(true);
    expect(isRecoverableReadFailure(new DashboardError("internal", 500, "boom"))).toBe(true);
    expect(isRecoverableReadFailure(new DashboardError("not-found", 404, "missing"))).toBe(false);
    expect(isRecoverableReadFailure(new DashboardError("bad-request", 400, "bad"))).toBe(false);
    expect(isRecoverableReadFailure({ type: "internal", message: "worker gone" })).toBe(true);
    expect(isRecoverableReadFailure({ type: "project-not-found", message: "missing" })).toBe(false);
    expect(isRecoverableReadFailure(new Error("socket closed"))).toBe(true);
  });
});
