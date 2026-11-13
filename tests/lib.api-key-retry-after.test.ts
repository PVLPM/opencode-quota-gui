import { describe, expect, it, vi } from "vitest";
import { createApiKeyRetryGuard } from "../src/lib/api-key-retry-after.js";

describe("API key retry guard", () => {
  it("clones a joined result", async () => {
    const guard = createApiKeyRetryGuard<{ success: true; nested: { value: number } }>(() => ({
      success: true,
      nested: { value: 0 },
    }));
    let resolve!: (value: { success: true; nested: { value: number } }) => void;
    const request = vi.fn(
      () =>
        new Promise<{ success: true; nested: { value: number } }>((r) => {
          resolve = r;
        }),
    );
    const first = guard("key", request);
    const joined = guard("key", request);
    resolve({ success: true, nested: { value: 1 } });
    const [a, b] = await Promise.all([first, joined]);
    a.nested.value = 2;
    expect(b.nested.value).toBe(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a request made with a different timeout", async () => {
    const guard = createApiKeyRetryGuard<{ success: true; timeout: number }>(() => ({
      success: true,
      timeout: 0,
    }));
    let finish!: (value: { success: true; timeout: number }) => void;
    const first = guard(
      "key",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      100,
    );
    const secondRequest = vi.fn(async () => ({ success: true as const, timeout: 200 }));
    const second = guard("key", secondRequest, 200);
    finish({ success: true, timeout: 100 });
    expect(await second).toEqual({ success: true, timeout: 200 });
    await first;
    expect(secondRequest).toHaveBeenCalledOnce();
  });

  it("rechecks an observed deadline before starting a differently timed request", async () => {
    const retryAtMs = Date.now() + 60_000;
    const guard = createApiKeyRetryGuard<{ success: false; retryAtMs: number }>((deadline) => ({
      success: false,
      retryAtMs: deadline,
    }));
    let finish!: (value: { success: false; retryAtMs: number }) => void;
    const first = guard(
      "key",
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      100,
    );
    const secondRequest = vi.fn(async () => ({ success: false as const, retryAtMs }));
    const second = guard("key", secondRequest, 200);
    finish({ success: false, retryAtMs });
    expect(await second).toEqual({ success: false, retryAtMs });
    await first;
    expect(secondRequest).not.toHaveBeenCalled();
  });

  it("keeps requests distinct while sharing Retry-After cooldown per credential", async () => {
    const retryAtMs = Date.now() + 60_000;
    const guard = createApiKeyRetryGuard<{ success: boolean; retryAtMs?: number }>((deadline) => ({
      success: false,
      retryAtMs: deadline,
    }));
    let resolveFirst!: (value: { success: false; retryAtMs: number }) => void;
    const firstRequest = vi.fn(
      () =>
        new Promise<{ success: false; retryAtMs: number }>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const secondRequest = vi.fn(async () => ({ success: true as const }));

    const first = guard("credential", firstRequest, 1000, undefined, "target-a");
    const second = guard("credential", secondRequest, 1000, undefined, "target-b");
    expect(secondRequest).toHaveBeenCalledOnce();

    resolveFirst({ success: false, retryAtMs });
    expect(await Promise.all([first, second])).toEqual([
      { success: false, retryAtMs },
      { success: true },
    ]);

    const blockedRequest = vi.fn(async () => ({ success: true as const }));
    expect(await guard("credential", blockedRequest, 1000, undefined, "target-c")).toEqual({
      success: false,
      retryAtMs,
    });
    expect(blockedRequest).not.toHaveBeenCalled();
  });
});
