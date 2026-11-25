export interface WarmingRefresh {
  sessionID: string;
  dispatchMs: number;
  evidence: "warming-inferred";
  route?: { providerID: string; id: string; variant?: string };
}

interface WarmingRoute {
  providerID: string;
  id: string;
  variant?: string;
}

interface SessionState {
  route?: WarmingRoute;
  baseline?: number;
  requests: number;
  generate: boolean;
  candidate?: { route: WarmingRoute; dispatchMs: number };
  step: boolean;
  tainted: boolean;
}

const MAX_TRACKED_SESSIONS = 256;
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelRoute(value: unknown): WarmingRoute | undefined {
  const model = record(value);
  const providerID = text(model?.providerID);
  const id = text(model?.id) ?? text(model?.modelID);
  if (providerID === undefined || id === undefined) return undefined;
  const variant = text(model?.variant);
  return variant === undefined || variant === "default"
    ? { providerID, id }
    : { providerID, id, variant };
}

function routeKey(route: WarmingRoute): string {
  return JSON.stringify([route.providerID, route.id, route.variant ?? null]);
}

export class OpencodeWarmingRefreshTracker {
  private readonly sessions = new Map<string, SessionState>();

  private session(id: string): SessionState {
    let state = this.sessions.get(id);
    if (state === undefined) {
      state = { requests: 0, generate: false, step: false, tainted: false };
      this.sessions.set(id, state);
      if (this.sessions.size > MAX_TRACKED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    return state;
  }

  onModelRequest(
    input: { sessionID?: unknown; kind?: unknown; model?: unknown },
    nowMs: number,
  ): void {
    const request = record(input);
    const id = text(request?.sessionID);
    if (id === undefined) return;
    const state = this.session(id);
    state.requests++;
    if (request?.kind === "generate") {
      state.generate = true;
      const route = modelRoute(request.model);
      if (route !== undefined && Number.isFinite(nowMs))
        state.candidate = { route, dispatchMs: nowMs };
    }
  }

  private onStep(event: unknown, started: boolean): void {
    const data = record(record(event)?.data);
    const id = text(data?.sessionID);
    if (id === undefined) return;
    const state = this.session(id);
    state.step = true;
    if (started) state.route = modelRoute(data?.model);
    else state.tainted = false;
  }

  onStepStarted(event: unknown): void {
    this.onStep(event, true);
  }

  onStepEnded(event: unknown): void {
    this.onStep(event, false);
  }

  onUsageUpdated(event: unknown): WarmingRefresh | undefined {
    const data = record(record(event)?.data);
    const id = text(data?.sessionID);
    if (id === undefined) return undefined;
    const state = this.session(id);
    const read = record(record(data?.tokens)?.cache)?.read;
    const cacheRead = typeof read === "number" && Number.isFinite(read) ? read : undefined;
    // Cumulative, source-less usage may under-detect refreshes and should rarely over-detect them.
    const accepted =
      !state.tainted &&
      !state.step &&
      state.requests === 1 &&
      state.generate &&
      state.candidate !== undefined &&
      state.route !== undefined &&
      routeKey(state.candidate.route) === routeKey(state.route) &&
      state.baseline !== undefined &&
      cacheRead !== undefined &&
      cacheRead > state.baseline;
    const result: WarmingRefresh | undefined =
      accepted && state.candidate !== undefined
        ? {
            sessionID: id,
            dispatchMs: state.candidate.dispatchMs,
            evidence: "warming-inferred",
            route: state.candidate.route,
          }
        : undefined;
    if (!accepted && state.generate) state.tainted = true;
    state.baseline = cacheRead;
    state.requests = 0;
    state.generate = false;
    state.candidate = undefined;
    state.step = false;
    return result;
  }
}
