import type { ModelIdentity, StepPoint } from "../contracts/dashboard";

/** One recorded change of model or reasoning effort between consecutive steps of a session. */
export interface ModelTransition {
  stepIndex: number;
  /** "model" covers any provider/model change, even with an effort change alongside; "effort" is effort alone. */
  kind: "model" | "effort";
  from: ModelIdentity;
  to: ModelIdentity;
}

/**
 * Transitions the recorded identities actually show for one session: each step
 * is compared with the session's previous step, so a switch back is a
 * transition too. A step or predecessor without a recorded identity yields
 * none; nothing is inferred across missing data.
 */
export function modelTransitions(
  steps: readonly StepPoint[],
  sessionId: string,
): ModelTransition[] {
  const found: ModelTransition[] = [];
  let previous: StepPoint | undefined;
  steps.forEach((step, stepIndex) => {
    if (step.sessionId !== sessionId) return;
    const from = previous?.model;
    const to = step.model;
    previous = step;
    if (from === undefined || to === undefined) return;
    if (from.providerId !== to.providerId || from.modelId !== to.modelId) {
      found.push({ stepIndex, kind: "model", from, to });
    } else if (from.effort !== to.effort) {
      found.push({ stepIndex, kind: "effort", from, to });
    }
  });
  return found;
}
