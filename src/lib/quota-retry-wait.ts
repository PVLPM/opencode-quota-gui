/**
 * `waitForQuotaReset` (on by default): when a model request hits a provider limit and the quota data
 * shows a used-up window for that model's provider, OpenCode retries once that window resets
 * instead of following its normal retry timing.
 */
import { isPercentEntry, type QuotaProviderResult } from "./entries.js";
import { readCredentialRows } from "./opencode-auth.js";
import { collectQuotaRenderData } from "./quota-render-data.js";
import {
  createQuotaRuntimeRequestContext,
  resolveQuotaRuntimeContext,
} from "./quota-runtime-context.js";
import type { QuotaSurfaceHost } from "./quota-surface-data.js";

/** Extra wait after the reset time, so the provider has reset the window when the retry runs. */
export const QUOTA_RESET_RETRY_BUFFER_MS = 60_000;
/** Longest single wait. If the window is still used up, the next retry waits again. */
export const QUOTA_RESET_RETRY_MAX_DELAY_MS = 5 * 60 * 60 * 1000;

/** The parts of OpenCode's retry event this feature reads. */
export type QuotaRetryEvent = {
  readonly model: { readonly id: string; readonly providerID: string };
  readonly error: { readonly type: string; readonly status?: number };
};

/** OpenCode's error types for a provider rate limit or used-up quota, or any HTTP 429. */
export function isQuotaLimitError(error: QuotaRetryEvent["error"]): boolean {
  return (
    error.type === "provider.rate-limit" || error.type === "provider.quota" || error.status === 429
  );
}

/**
 * Milliseconds until all used-up windows have reset, plus the buffer, at most the cap.
 */
export function getQuotaResetRetryDelayMs(
  results: readonly QuotaProviderResult[],
  nowMs: number,
  activeSourceId?: string,
): number | undefined {
  const sources = new Set(
    results.flatMap((result) => [
      ...result.entries.flatMap((entry) =>
        entry.accounting.sourceId ? [entry.accounting.sourceId] : [],
      ),
      ...(result.accounts?.map((account) => account.sourceId) ?? []),
    ]),
  );
  const marked = new Set(
    results.flatMap(
      (result) =>
        result.accounts?.filter((account) => account.active).map((account) => account.sourceId) ??
        [],
    ),
  );
  const active = activeSourceId ?? (marked.size === 1 ? [...marked][0] : undefined);
  if (sources.size > 1 && !active) {
    console.debug("[opencode-quota-gui] retry: active account is unknown");
    return undefined;
  }
  if (active && sources.size > 0 && !sources.has(active)) return undefined;
  let latestResetMs: number | undefined;
  for (const result of results) {
    if (
      !result.attempted ||
      result.errors.some((error) => !active || !error.sourceId || error.sourceId === active)
    )
      return undefined;
    for (const entry of result.entries) {
      if (sources.size > 1 && !entry.accounting.sourceId) return undefined;
      if (active && entry.accounting.sourceId && entry.accounting.sourceId !== active) continue;
      if (!isPercentEntry(entry)) continue;
      if (!Number.isFinite(entry.percentRemaining)) return undefined;
      if (entry.percentRemaining > 0) continue;
      if (!entry.resetTimeIso) return undefined;
      const resetMs = Date.parse(entry.resetTimeIso);
      if (!(resetMs > nowMs)) return undefined;
      if (latestResetMs === undefined || resetMs > latestResetMs) latestResetMs = resetMs;
    }
  }
  if (latestResetMs === undefined) return undefined;
  return Math.min(
    latestResetMs - nowMs + QUOTA_RESET_RETRY_BUFFER_MS,
    QUOTA_RESET_RETRY_MAX_DELAY_MS,
  );
}

/**
 * The retry delay for a limit error on `event.model`, or undefined to keep OpenCode's decision.
 * Quota comes from the same provider refresh path as the sidebar and toasts, but skips the cache:
 * the limit error itself shows the quota changed, so the provider is asked once for fresh data.
 */
export async function resolveQuotaResetRetryDelayMs(
  host: Pick<QuotaSurfaceHost, "client" | "roots">,
  event: QuotaRetryEvent,
): Promise<number | undefined> {
  if (!isQuotaLimitError(event.error)) return undefined;
  const runtime = await resolveQuotaRuntimeContext({
    client: host.client,
    roots: host.roots,
    sessionMeta: { modelID: event.model.id, providerID: event.model.providerID },
  });
  if (!runtime.config.waitForQuotaReset) return undefined;
  const collected = await collectQuotaRenderData({
    client: runtime.client,
    resolveRuntimeProviderIds: runtime.resolveRuntimeProviderIds,
    // Only the provider of the model that hit the limit counts, whatever onlyCurrentModel says.
    config: {
      ...runtime.config,
      onlyCurrentModel: true,
      opencodeGoWindows: ["rolling", "weekly", "monthly"],
    },
    configMeta: runtime.configMeta,
    request: createQuotaRuntimeRequestContext(runtime),
    workspaceRoot: runtime.roots.workspaceRoot,
    surfaceExplicitProviderIssues: false,
    bypassProviderCache: true,
    providers: runtime.providers,
  });
  const rows = await readCredentialRows([event.model.providerID], { firstOnly: true });
  if (rows.some((row) => row.resolveError !== undefined)) return undefined;
  const active = rows.find((row) => row.active)?.id;
  return getQuotaResetRetryDelayMs(
    collected.providerResults.map((probe) => probe.result),
    Date.now(),
    active,
  );
}
