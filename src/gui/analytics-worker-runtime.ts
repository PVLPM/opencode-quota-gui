/**
 * Side-effect-free worker command runtime. The worker entry point wires this to
 * `parentPort` (Node) or `self` (Bun); focused tests drive the same handler
 * without a real thread.
 */

import { isAnalyticsGroupQuery } from "../contracts/analytics-entity.js";
import { isRangeKey } from "../contracts/ranges.js";
import { type AnalyticsEngine, createAnalyticsEngine } from "./analytics-engine.js";
import type {
  AnalyticsInitOptions,
  AnalyticsWorkerCommand,
  AnalyticsWorkerResult,
} from "./analytics-protocol.js";
import { type AnalyticsErrorCode, AnalyticsReadError } from "./analytics-protocol.js";

export interface AnalyticsWorkerRuntime {
  handle(command: AnalyticsWorkerCommand): Promise<AnalyticsWorkerResult>;
  close(): Promise<void>;
}

const ERROR_CODES: ReadonlySet<string> = new Set([
  "bad-request",
  "project-not-found",
  "session-not-found",
  "unavailable",
  "closed",
  "timeout",
]);

function errorCodeOf(error: unknown): AnalyticsErrorCode {
  if (error instanceof AnalyticsReadError) return error.code;
  if (error !== null && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && ERROR_CODES.has(code)) return code as AnalyticsErrorCode;
  }
  return "unavailable";
}

export function createAnalyticsWorkerRuntime(
  options: {
    createEngine?: (init: AnalyticsInitOptions) => AnalyticsEngine;
    onGeneration?: (generation: number) => void;
  } = {},
): AnalyticsWorkerRuntime {
  const createEngine =
    options.createEngine ??
    ((init: AnalyticsInitOptions) =>
      createAnalyticsEngine({
        ...(init.snapshotPath === undefined ? {} : { snapshotPath: init.snapshotPath }),
        ...(init.refreshIntervalMs === undefined
          ? {}
          : { refreshIntervalMs: init.refreshIntervalMs }),
        ...(options.onGeneration === undefined ? {} : { onGeneration: options.onGeneration }),
      }));

  let engine: AnalyticsEngine | undefined;
  let closed = false;

  async function handle(command: AnalyticsWorkerCommand): Promise<AnalyticsWorkerResult> {
    if (command.kind === "init") {
      if (!engine) engine = createEngine(command.options);
      return undefined;
    }
    if (command.kind === "close") {
      closed = true;
      if (engine) await engine.close();
      engine = undefined;
      return undefined;
    }
    if (closed || !engine) throw new AnalyticsReadError("closed");

    if (command.kind === "home") {
      if (!isRangeKey(command.range)) throw new AnalyticsReadError("bad-request");
      return await engine.home(command.range);
    }
    if (command.kind === "project") {
      if (!isRangeKey(command.range) || !command.projectId) {
        throw new AnalyticsReadError("bad-request");
      }
      return await engine.project(command.projectId, command.range);
    }
    if (command.kind === "session") {
      if (!command.sessionId) throw new AnalyticsReadError("bad-request");
      return await engine.session(command.sessionId);
    }
    if (command.kind === "groups") {
      if (!isAnalyticsGroupQuery(command.query)) throw new AnalyticsReadError("bad-request");
      return await engine.groups(command.query);
    }
    if (command.kind === "refresh") {
      await engine.refresh();
      return undefined;
    }
    if (command.kind === "stats") {
      return await engine.stats();
    }
    if (command.kind === "gc") {
      return await engine.gc();
    }
    return undefined;
  }

  return {
    async handle(command) {
      try {
        return await handle(command);
      } catch (error) {
        throw new AnalyticsReadError(errorCodeOf(error));
      }
    },
    async close() {
      closed = true;
      if (engine) await engine.close();
      engine = undefined;
    },
  };
}
