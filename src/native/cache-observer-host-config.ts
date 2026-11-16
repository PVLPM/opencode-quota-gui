import type { Context } from "@opencode/plugin/gui";
import {
  type CacheConfiguredTtlMs,
  cacheConfiguredTtlMsFromHostValue,
  isCacheConfigurableProviderId,
} from "../lib/cache-observer.js";

/** Reads non-secret current metadata, not the invocation's effective settings. */
export function createHostRouteConfigurationReader(
  client: Pick<Context["client"], "model" | "provider">,
) {
  return async (route: {
    providerId: string;
    modelId: string;
  }): Promise<{ configuredTtlMs?: CacheConfiguredTtlMs }> => {
    if (!isCacheConfigurableProviderId(route.providerId)) return {};
    const [provider, models] = await Promise.all([
      client.provider.get({
        providerID: route.providerId as Parameters<typeof client.provider.get>[0]["providerID"],
      }),
      client.model.list(),
    ]);
    const model = models.data.find(
      (entry) => entry.providerID === route.providerId && entry.id === route.modelId,
    );
    const configuredTtlMs = cacheConfiguredTtlMsFromHostValue(
      model?.settings?.cache?.ttl ?? provider.data.settings?.cache?.ttl,
    );
    return configuredTtlMs === undefined ? {} : { configuredTtlMs };
  };
}
