/**
 * OpenCode V2 server plugin for the GUI-only product: it starts the shared
 * dashboard runtime, attaches the typed dashboard RPC transport, and keeps the
 * credential and quota-reset retry lifecycle working. Inherited terminal
 * surfaces (commands, tool, the TUI quota RPC and report hooks) are retained in
 * their source modules but are not registered by this product.
 */
import { Plugin } from "@opencode/plugin";
import { type DashboardLease, startDashboard } from "./gui/lifecycle.js";
import { scrubLogReason } from "./gui/log.js";
import { registerDashboardRpc } from "./gui/rpc.js";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
  scrubCredentialErrorText,
} from "./lib/opencode-auth.js";
import { resolveQuotaResetRetryDelayMs } from "./lib/quota-retry-wait.js";
import type { QuotaSurfaceHost } from "./lib/quota-surface-data.js";

/** An error as one line that is safe to log: tokens redacted, at most 120 characters. */
function logReason(error: unknown): string {
  return scrubCredentialErrorText(error instanceof Error ? error.message : String(error));
}

export const QuotaToastPlugin = Plugin.define({
  id: "opencode-quota-gui.server",
  async setup(ctx) {
    const roots = resolveOpenCodeLocationRoots(ctx.location.directory);
    // The quota collector accepts a small V1-shaped configuration client. V2
    // does not expose a mutable global config to plugins; runtime settings are
    // read from the canonical GUI config file by the collector.
    const client = {
      config: {
        get: async () => ({ data: {} }),
        providers: async () => ({
          data: {
            providers: (await ctx.provider.list()).data.map((provider) => ({ id: provider.id })),
          },
        }),
      },
    };

    // With waitForQuotaReset on, a request that hit a provider limit is retried after the
    // used-up quota window resets. Any failure keeps OpenCode's own retry decision.
    const retryHost: Pick<QuotaSurfaceHost, "client" | "roots"> = { client, roots };
    await ctx.session.hook("retry", async (event) => {
      try {
        const delay = await resolveQuotaResetRetryDelayMs(retryHost, event);
        if (delay !== undefined) event.decision = { retry: true, delay };
      } catch (error) {
        console.warn(`[opencode-quota-gui] retry hook failed: ${logReason(error)}`);
      }
    });

    // Every login read in this process goes through this location's `ctx.integration`. Bound
    // last, so a setup that fails part way leaves no binding behind. OpenCode routes the
    // retained hooks only after setup, so no read comes earlier.
    const unbindCredentialSource = bindCredentialSource(
      createIntegrationCredentialSource(ctx.integration),
    );
    // A login added, changed or switched in OpenCode drops cached logins and failed-login
    // entries, so the next read asks OpenCode again. If the subscription fails, cached logins
    // stay until they expire; the log says why. The cleanup's abort ends it silently.
    const credentialEvents = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: credentialEvents.signal })) {
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          notifyCredentialsChanged();
        }
      }
    })().catch((error) => {
      if (credentialEvents.signal.aborted) return;
      console.warn(
        `[opencode-quota-gui] credential event subscription stopped: ${logReason(error)}`,
      );
    });

    // The dashboard host binds last — after the retry hook and the credential binding — and it
    // never fails setup: every dashboard error stays a controlled log line and an `unavailable`
    // lease (spec §4.3). The first owner workspace supplies the config import root, and the
    // settings store reads the global canonical config. Binding is all that happens here; the
    // first snapshot is computed on the first request.
    let dashboardLease: DashboardLease | undefined;
    try {
      dashboardLease = await startDashboard({
        client,
        workspaceRoot: ctx.location.directory,
      });
    } catch (error) {
      console.warn(`[opencode-quota-gui] dashboard unavailable: ${logReason(error)}`);
    }

    // Attach the native RPC transport to the same host runtime the web
    // transport receives. It is available when web is disabled or its bind
    // failed, and it never constructs another source/snapshot/service.
    let dashboardRpc: Awaited<ReturnType<typeof registerDashboardRpc>> | undefined;
    if (dashboardLease?.runtime && ctx.rpc) {
      try {
        dashboardRpc = await registerDashboardRpc(ctx.rpc, dashboardLease.runtime, {
          location: ctx.location,
        });
      } catch {
        console.warn(`[opencode-quota-gui] dashboard RPC unavailable: registration-failed`);
      }
    }

    return async () => {
      credentialEvents.abort();
      unbindCredentialSource();
      if (dashboardRpc) {
        try {
          await dashboardRpc.dispose();
        } catch (error) {
          console.warn(
            `[opencode-quota-gui] dashboard RPC stop failed: ${scrubLogReason(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        }
      }
      if (dashboardLease) {
        try {
          await dashboardLease.dispose();
        } catch (error) {
          console.warn(`[opencode-quota-gui] dashboard stop failed: ${logReason(error)}`);
        }
      }
    };
  },
});

export default QuotaToastPlugin;
