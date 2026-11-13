import { describe, expect, it, vi } from "vitest";
import { createHostRouteConfigurationReader } from "../src/native/cache-observer-host-config.js";

describe("host route configuration reader", () => {
  it("prefers the matching model TTL over the provider TTL", async () => {
    const client = {
      provider: {
        get: vi.fn().mockResolvedValue({ data: { settings: { cache: { ttl: "5m" } } } }),
      },
      model: {
        list: vi.fn().mockResolvedValue({
          data: [
            { providerID: "other", id: "claude", settings: { cache: { ttl: "5m" } } },
            { providerID: "anthropic", id: "claude", settings: { cache: { ttl: "1h" } } },
          ],
        }),
      },
    } as unknown as Parameters<typeof createHostRouteConfigurationReader>[0];
    const read = createHostRouteConfigurationReader(client);

    await expect(read({ providerId: "anthropic", modelId: "claude" })).resolves.toEqual({
      configuredTtlMs: 3_600_000,
    });
  });

  it("does not query host configuration for a non-configurable provider", async () => {
    const get = vi.fn();
    const list = vi.fn();
    const client = { provider: { get }, model: { list } } as unknown as Parameters<
      typeof createHostRouteConfigurationReader
    >[0];
    const read = createHostRouteConfigurationReader(client);

    await expect(read({ providerId: "openai", modelId: "gpt-test" })).resolves.toEqual({});
    expect(get).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps concurrent same-route lookups independent and reads again after settlement", async () => {
    let resolveProvider!: (value: { data: { settings: { cache: { ttl: string } } } }) => void;
    const pending = new Promise<{ data: { settings: { cache: { ttl: string } } } }>((resolve) => {
      resolveProvider = resolve;
    });
    const provider = vi
      .fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValue({ data: { settings: { cache: { ttl: "5m" } } } });
    const models = vi.fn().mockResolvedValue({ data: [] });
    const client = {
      provider: { get: provider },
      model: { list: models },
    } as unknown as Parameters<typeof createHostRouteConfigurationReader>[0];
    const read = createHostRouteConfigurationReader(client);
    const route = {
      providerId: "anthropic",
      modelId: "claude",
    };
    const first = read(route);
    const second = read(route);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(models).toHaveBeenCalledTimes(2);
    resolveProvider({ data: { settings: { cache: { ttl: "1h" } } } });
    expect(await first).toEqual({ configuredTtlMs: 3_600_000 });
    expect(await second).toEqual({ configuredTtlMs: 300_000 });
    expect(await read(route)).toEqual({ configuredTtlMs: 300_000 });
    expect(provider).toHaveBeenCalledTimes(3);
  });
});
