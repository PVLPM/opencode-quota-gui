import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpDashboardClient } from "../src/ui/dashboard-client";
import { createDashboardRestart } from "../src/ui/dashboard-restart";

afterEach(() => vi.useRealTimers());

describe("dashboard restart client", () => {
  it("waits for a valid acknowledgement before checking health", async () => {
    let acknowledge!: (response: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const client = createHttpDashboardClient({ fetchImpl });
    const flow = client.restartDashboard!(new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const failure = expect(flow).rejects.toThrow();
    acknowledge(Response.json({ restartId: "" }, { status: 202 }));
    await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending health interval without another request", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      Response.json(
        {
          restartId: String(url).endsWith("/restart") ? "new" : "old",
        },
        { status: 202 },
      ),
    );
    const client = createHttpDashboardClient({ fetchImpl });
    const controller = new AbortController();
    const flow = client.restartDashboard!(controller.signal);
    const failure = expect(flow).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    controller.abort();
    await failure;
    await vi.runAllTimersAsync();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("posts an empty body then ignores old healthy listeners until the acknowledged generation is healthy", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ restartId: "replacement" }, { status: 202 }))
      .mockResolvedValueOnce(Response.json({ restartId: "old" }))
      .mockResolvedValueOnce(Response.json({ restartId: "replacement" }));
    const client = createHttpDashboardClient({ fetchImpl });
    const flow = client.restartDashboard!(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(500);
    await flow;
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "/api/v1/dashboard/restart",
      "/api/v1/health",
      "/api/v1/health",
    ]);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
      cache: "no-store",
    });
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.cache).toBe("no-store");
    }
  });

  it("bounds unavailable replacement polling and permits a fresh retry", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).endsWith("/restart")
        ? Response.json({ restartId: "new" }, { status: 202 })
        : Response.json({ restartId: "old" }),
    );
    const client = createHttpDashboardClient({ fetchImpl });
    const failure = expect(
      client.restartDashboard!(new AbortController().signal),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(51);
    fetchImpl.mockImplementation(async () => Response.json({ restartId: "new" }, { status: 202 }));
    await client.restartDashboard!(new AbortController().signal);
  });

  it("times out a stalled request and cancels health polling on disposal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("private path")), {
            once: true,
          });
        }),
    );
    const client = createHttpDashboardClient({ fetchImpl });
    const failure = expect(
      client.restartDashboard!(new AbortController().signal),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("times out stalled health requests within the bounded recovery window", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const fetchImpl = vi.fn<typeof fetch>((url, init) => {
      if (String(url).endsWith("/restart"))
        return Promise.resolve(Response.json({ restartId: "new" }, { status: 202 }));
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("unavailable")), {
          once: true,
        });
      });
    });
    const client = createHttpDashboardClient({ fetchImpl });
    const failure = expect(
      client.restartDashboard!(new AbortController().signal),
    ).rejects.toThrow();
    await vi.runAllTimersAsync();
    await failure;
    expect(fetchImpl).toHaveBeenCalledTimes(17);
    expect(Date.now() - started).toBeLessThanOrEqual(25_000);
  });
});

describe("restart interaction", () => {
  it("blocks duplicate clicks and reloads the current location exactly once after recovery", async () => {
    let acknowledge!: () => void;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const location = { href: "http://localhost/session/focus?range=7d#chart", reload: vi.fn() };
    const states: string[] = [];
    const restart = createDashboardRestart(
      operation,
      () => location.reload(),
      (state) => states.push(state),
    );
    const first = restart.run();
    await restart.run();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["restarting"]);
    expect(location.reload).not.toHaveBeenCalled();
    acknowledge();
    await first;
    expect(location.reload).toHaveBeenCalledTimes(1);
    expect(location.href).toBe("http://localhost/session/focus?range=7d#chart");
    await restart.run();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("enables retry after failure without leaking errors, and aborts on dispose", async () => {
    const states: string[] = [];
    const reload = vi.fn();
    let signal: AbortSignal | undefined;
    const operation = vi.fn(async (value: AbortSignal) => {
      signal = value;
      throw new Error("private path");
    });
    const restart = createDashboardRestart(operation, reload, (state) => states.push(state));
    await restart.run();
    await restart.run();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(states).toEqual(["restarting", "failed", "restarting", "failed"]);
    let finish!: () => void;
    operation.mockImplementationOnce((value) => {
      signal = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const pending = restart.run();
    restart.dispose();
    expect(signal?.aborted).toBe(true);
    finish();
    await pending;
    expect(reload).not.toHaveBeenCalled();
  });
});
