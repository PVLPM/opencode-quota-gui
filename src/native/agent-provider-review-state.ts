import type { AgentCustomProviderSnapshot } from "../contracts/dashboard.js";
import type { NativeDashboardClient } from "./dashboard-client.js";

type Client = Pick<
  NativeDashboardClient,
  "agentCustomProviders" | "approveAgentCustomProvider" | "setAgentCustomProviderEnabled"
>;
export interface ProviderReviewState {
  snapshot?: AgentCustomProviderSnapshot;
  busy: boolean;
  error?: string;
}

/** A failed or invalidated write must never leave an old definition approvable. */
export function createProviderReview(
  client: Client,
  changed: (state: ProviderReviewState) => void,
) {
  let state: ProviderReviewState = { busy: false };
  let generation = 0;
  const set = (next: ProviderReviewState) => {
    state = next;
    changed(state);
  };
  const invalidate = () => {
    generation++;
    set({ busy: false });
  };
  const refresh = async () => {
    const token = ++generation;
    set({ busy: true });
    try {
      const snapshot = await client.agentCustomProviders();
      if (token === generation) set({ snapshot, busy: false });
    } catch {
      if (token === generation)
        set({ busy: false, error: "Could not load provider proposals. Try again." });
    }
  };
  const act = async (id: string, enabled?: boolean) => {
    const snapshot = state.snapshot;
    const provider = snapshot?.providers.find((item) => item.id === id);
    if (state.busy || !snapshot || !provider || (enabled === true && !provider.approved)) return;
    const token = ++generation;
    set({ ...state, busy: true, error: undefined });
    try {
      const next =
        enabled === undefined
          ? await client.approveAgentCustomProvider({ id, expectedRevision: snapshot.revision })
          : await client.setAgentCustomProviderEnabled({
              id,
              enabled,
              expectedRevision: snapshot.revision,
            });
      if (token === generation) set({ snapshot: next, busy: false });
    } catch {
      if (token === generation)
        set({
          busy: false,
          error:
            "The proposal may have changed or the action could not be saved. Reload and review it again.",
        });
    }
  };
  return {
    current: () => state,
    refresh,
    invalidate,
    approve: (id: string) => act(id),
    enable: (id: string, enabled: boolean) => act(id, enabled),
  };
}
