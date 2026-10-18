/**
 * Server-sent events hub (design spec §5.3, §9; R7).
 *
 * Three topics, default-message frames `data: {"topic","at","scope?"}` so the
 * browser `EventSource.onmessage` consumer works, `retry:` once per stream,
 * 20 s heartbeat comments, per-client cleanup on disconnect. No sequence
 * numbers, replay, or durable resume exists (R7 deferred).
 */

import type { ServerResponse } from "node:http";
import type { DashboardEvent } from "../contracts/dashboard.js";
import { createGuiLogger, type GuiLogger } from "./log.js";

export const DEFAULT_SSE_HEARTBEAT_MS = 20_000;
export const DEFAULT_SSE_RETRY_MS = 3_000;

export interface SseHubOptions {
  /** Test seam; default 20 s (spec §5.3). */
  heartbeatMs?: number;
  /** Test seam; default 3000 ms. */
  retryMs?: number;
  /** Fires on every attach/detach with the current client count. */
  onClientCountChange?: (count: number) => void;
  logger?: GuiLogger;
}

export interface SseHub {
  /** Writes the SSE head and registers the response as a client. */
  attach(res: ServerResponse): void;
  broadcast(event: DashboardEvent): void;
  clientCount(): number;
  /** Ends every stream and stops the heartbeat. */
  close(): void;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function createSseHub(options: SseHubOptions = {}): SseHub {
  const heartbeatMs = positiveOrDefault(options.heartbeatMs, DEFAULT_SSE_HEARTBEAT_MS);
  const retryMs = positiveOrDefault(options.retryMs, DEFAULT_SSE_RETRY_MS);
  const logger = options.logger ?? createGuiLogger();
  const clients = new Set<ServerResponse>();
  let heartbeat: NodeJS.Timeout | undefined;
  let closed = false;

  function notify(): void {
    options.onClientCountChange?.(clients.size);
  }

  function stopHeartbeat(): void {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function detach(res: ServerResponse): void {
    if (!clients.delete(res)) return;
    if (clients.size === 0) stopHeartbeat();
    notify();
  }

  function startHeartbeat(): void {
    if (heartbeat || closed) return;
    heartbeat = setInterval(() => {
      for (const client of clients) writeFrame(client, ": heartbeat\n\n");
    }, heartbeatMs);
    heartbeat.unref();
  }

  function writeFrame(res: ServerResponse, frame: string): void {
    try {
      res.write(frame);
    } catch {
      logger.warn("sse write failed", "client-disconnected");
      detach(res);
    }
  }

  return {
    attach(res: ServerResponse): void {
      if (closed) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end();
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.flushHeaders();
      res.write(`retry: ${retryMs}\n\n`);

      clients.add(res);
      res.on("close", () => detach(res));
      if (clients.size === 1) startHeartbeat();
      notify();
    },

    broadcast(event: DashboardEvent): void {
      const payload: DashboardEvent = { topic: event.topic, at: event.at };
      if (event.scope) payload.scope = event.scope;
      const frame = `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of clients) writeFrame(client, frame);
    },

    clientCount: () => clients.size,

    close(): void {
      closed = true;
      stopHeartbeat();
      for (const client of clients) {
        try {
          client.end();
        } catch {
          // already closed
        }
      }
      clients.clear();
      notify();
    },
  };
}
