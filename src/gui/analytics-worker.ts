/**
 * Worker entry point (Node worker_threads and Bun Worker).
 *
 * The bridge loads this file as `./analytics-worker.js` from the tsc build.
 * It owns all storage reads, the compact index, persistence, and aggregation;
 * only protocol frames and finished DTOs cross back to the host.
 */
import { AnalyticsReadError, type AnalyticsWorkerRequest } from "./analytics-protocol.js";
import { createAnalyticsWorkerRuntime } from "./analytics-worker-runtime.js";

interface MessagePortLike {
  postMessage(message: unknown, transferList?: unknown[]): void;
  on?(event: "message", listener: (value: unknown) => void): unknown;
  onmessage?: ((event: { data: unknown }) => void) | null;
}

function isRequest(value: unknown): value is AnalyticsWorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "number" && typeof record.command === "object" && record.command !== null
  );
}

async function resolvePort(): Promise<MessagePortLike | undefined> {
  if ((globalThis as { Bun?: unknown }).Bun === undefined) {
    try {
      const { parentPort } = await import("node:worker_threads");
      if (parentPort) return parentPort as unknown as MessagePortLike;
    } catch {
      return undefined;
    }
    return undefined;
  }
  const globalScope = globalThis as unknown as MessagePortLike & {
    postMessage?: MessagePortLike["postMessage"];
  };
  return typeof globalScope.postMessage === "function" ? globalScope : undefined;
}

async function main(): Promise<void> {
  const port = await resolvePort();
  if (!port) return;
  const runtime = createAnalyticsWorkerRuntime({
    onGeneration: (generation) => {
      port.postMessage({ type: "analytics-generation", generation });
    },
  });

  const respond = (request: AnalyticsWorkerRequest): void => {
    void (async () => {
      try {
        const result = await runtime.handle(request.command);
        port.postMessage({ id: request.id, ok: true, result });
      } catch (error) {
        const code = error instanceof AnalyticsReadError ? error.code : "unavailable";
        port.postMessage({ id: request.id, ok: false, error: { code } });
      }
    })();
  };

  const listener = (value: unknown): void => {
    if (isRequest(value)) respond(value);
  };

  if (typeof port.on === "function") {
    port.on("message", listener);
  } else {
    port.onmessage = (event: { data: unknown }) => listener(event.data);
  }
}

void main();
