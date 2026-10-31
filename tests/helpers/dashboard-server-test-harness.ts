import type { GuiSettingsStore } from "../../src/contracts/dashboard.js";
import type { GuiLogger } from "../../src/gui/log.js";
import { createDashboardServer, type DashboardServerHandle } from "../../src/gui/server.js";
import { createSnapshotService, type SnapshotSource } from "../../src/gui/snapshot-service.js";

export interface TestDashboardServerOptions {
  port: number;
  source: SnapshotSource;
  settings: GuiSettingsStore;
  assetRoot?: string;
  heartbeatMs?: number;
  quotaIntervalMs?: number | (() => number);
  analyticsIntervalMs?: number | (() => number);
  logger?: GuiLogger;
}

/**
 * Direct-server test harness: mirrors the lifecycle-owned runtime by creating a
 * `SnapshotService` for the injected source and closing it after the transport
 * closes (the server itself never owns it).
 */
export async function startTestDashboardServer(
  options: TestDashboardServerOptions,
): Promise<DashboardServerHandle> {
  const { source, quotaIntervalMs, analyticsIntervalMs, ...serverOptions } = options;
  const snapshots = createSnapshotService({
    source,
    quotaIntervalMs,
    analyticsIntervalMs,
    logger: serverOptions.logger,
  });
  try {
    const handle = await createDashboardServer({ ...serverOptions, snapshots });
    return {
      ...handle,
      close: async () => {
        try {
          await handle.close();
        } finally {
          snapshots.close();
        }
      },
    };
  } catch (error) {
    snapshots.close();
    throw error;
  }
}
