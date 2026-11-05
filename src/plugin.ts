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
import {
  AgentCustomProviderError,
  createAgentCustomProviderStore,
} from "./lib/agent-custom-providers.js";
import { projectOpenCodeCacheObserverEvent } from "./lib/cache-observer-ingestion.js";
import { resolveOpenCodeLocationRoots } from "./lib/config-file-utils.js";
import {
  bindCredentialSource,
  createIntegrationCredentialSource,
  notifyCredentialsChanged,
  scrubCredentialErrorText,
} from "./lib/opencode-auth.js";
import { getOpencodeRuntimeDirs } from "./lib/opencode-runtime-paths.js";
import { resolveQuotaResetRetryDelayMs } from "./lib/quota-retry-wait.js";
import type { QuotaSurfaceHost } from "./lib/quota-surface-data.js";

/** An error as one line that is safe to log: tokens redacted, at most 120 characters. */
function logReason(error: unknown): string {
  return scrubCredentialErrorText(error instanceof Error ? error.message : String(error));
}

const EMPTY_TOOL_INPUT = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const ID_TOOL_INPUT = {
  type: "object",
  properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
  required: ["id"],
  additionalProperties: false,
} as const;

const ADD_TOOL_INPUT = {
  type: "object",
  properties: {
    definition: {
      type: "object",
      properties: {
        id: { type: "string", minLength: 1, maxLength: 64 },
        providerId: { type: "string", minLength: 1, maxLength: 64 },
        label: { type: "string", minLength: 1, maxLength: 80 },
        mode: { enum: ["remote-api", "local-estimate"] },
        modelIds: { type: "array", items: { type: "string" } },
        url: { type: "string", maxLength: 2048 },
        format: { enum: ["quota-v1", "json-v1", "openrouter-key-v1"] },
        apiKeyEnv: { type: "string", maxLength: 128 },
        adapter: { type: "object" },
        windows: { type: "array" },
        pricingModelMap: { type: "object" },
      },
      required: ["id", "providerId", "label", "mode"],
      additionalProperties: false,
    },
  },
  required: ["definition"],
  additionalProperties: false,
} as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredToolId(input: unknown): string {
  if (isPlainObject(input) && typeof input.id === "string") return input.id;
  throw new AgentCustomProviderError("invalid-id", "Provider id is invalid");
}

async function customProviderToolResult(operation: () => Promise<unknown>) {
  try {
    return { content: JSON.stringify(await operation()) };
  } catch (error) {
    if (error instanceof AgentCustomProviderError) {
      return { content: JSON.stringify({ error: { code: error.code, message: error.message } }) };
    }
    return {
      content: JSON.stringify({
        error: { code: "unavailable", message: "Custom provider operation failed" },
      }),
    };
  }
}

export const QuotaToastPlugin = Plugin.define({
  id: "opencode-quota-gui",
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

    const agentCustomProviderStore = createAgentCustomProviderStore({
      configDir: getOpencodeRuntimeDirs().configDir,
    });

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
    let dashboardRpc: Awaited<ReturnType<typeof registerDashboardRpc>> | undefined;
    type HostEventSourceState = "unverified" | "observed" | "unavailable" | "stopped";
    let hostEventSourceState: HostEventSourceState = "unverified";
    let lastHostEventAtMs: number | undefined;
    const publishHostEventSourceState = (
      state: Exclude<HostEventSourceState, "unverified">,
      at: number,
    ): void => {
      hostEventSourceState = state;
      if (state === "observed") lastHostEventAtMs = at;
      if (!dashboardRpc) return;
      void dashboardRpc.events
        .emit("invalidated", {
          topic: "cache.observer",
          at,
          cacheObserverEvent: { type: "source.status", created: at, data: { state } },
        })
        .catch(() => undefined);
    };
    // Reuse the existing host stream for credential invalidation and narrowly projected cache
    // evidence. No Native-side OpenCode event subscription is opened.
    const hostEvents = new AbortController();
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: hostEvents.signal })) {
        if (hostEvents.signal.aborted) return;
        if (hostEventSourceState === "unverified") {
          publishHostEventSourceState(
            "observed",
            typeof event.created === "number" && Number.isFinite(event.created)
              ? event.created
              : Date.now(),
          );
        }
        if (event.type === "credential.updated" || event.type === "credential.switched") {
          notifyCredentialsChanged();
        }
        const cacheObserverEvent = projectOpenCodeCacheObserverEvent(event);
        if (
          cacheObserverEvent !== undefined &&
          dashboardRpc !== undefined &&
          typeof event.created === "number" &&
          Number.isFinite(event.created) &&
          event.created >= 0
        ) {
          void dashboardRpc.events
            .emit("invalidated", {
              topic: "cache.observer",
              at: event.created,
              cacheObserverEvent,
            })
            .catch(() => undefined);
        }
      }
      if (!hostEvents.signal.aborted) throw new Error("host event stream ended");
    })().catch((error) => {
      if (hostEvents.signal.aborted) return;
      publishHostEventSourceState("unavailable", Date.now());
      console.warn(`[opencode-quota-gui] host event subscription stopped: ${logReason(error)}`);
    });

    // The dashboard host binds last — after the retry hook and the credential binding — and it
    // never fails setup: every dashboard error stays a controlled log line and an `unavailable`
    // lease (spec §4.3). The first owner workspace supplies the config import root, and the
    // settings store reads the global canonical config. Binding is all that happens here; the
    // first snapshot is computed on the first request.
    let dashboardLease: DashboardLease | undefined;
    try {
      // Older hosts may not supply `ctx.app` at runtime; an absent or empty
      // version lets the lifecycle use its bounded `opencode --version` probe.
      const hostVersion = (ctx.app as { version?: string } | undefined)?.version;
      dashboardLease = await startDashboard({
        client,
        workspaceRoot: ctx.location.directory,
        ...(hostVersion !== undefined ? { hostVersion } : {}),
      });
    } catch (error) {
      console.warn(`[opencode-quota-gui] dashboard unavailable: ${logReason(error)}`);
    }

    // Attach the native RPC transport to the same host runtime the web
    // transport receives. It is available when web is disabled or its bind
    // failed, and it never constructs another source/snapshot/service.
    if (dashboardLease?.runtime && ctx.rpc) {
      try {
        dashboardRpc = await registerDashboardRpc(ctx.rpc, dashboardLease.runtime, {
          location: ctx.location,
        });
        if (hostEventSourceState !== "unverified") {
          publishHostEventSourceState(
            hostEventSourceState,
            hostEventSourceState === "observed" ? (lastHostEventAtMs ?? Date.now()) : Date.now(),
          );
        }
      } catch {
        console.warn(`[opencode-quota-gui] dashboard RPC unavailable: registration-failed`);
      }
    }

    let agentProviderTools: { dispose: () => Promise<void> } | undefined;
    try {
      agentProviderTools = await ctx.tool.transform((editor) => {
        editor.add({
          name: "quota_custom_provider_list",
          description:
            "List custom quota-provider proposals. Output omits endpoint URLs and credentials. Proposals are disabled and never start quota polling.",
          input: EMPTY_TOOL_INPUT,
          async execute() {
            return customProviderToolResult(() => agentCustomProviderStore.list());
          },
        });
        editor.add({
          name: "quota_custom_provider_read",
          description:
            "Read a custom quota-provider proposal by id. Output omits endpoint URLs and credentials. This does not approve or enable it.",
          input: ID_TOOL_INPUT,
          async execute(input) {
            return customProviderToolResult(() =>
              agentCustomProviderStore.read(requiredToolId(input)),
            );
          },
        });
        editor.add({
          name: "quota_custom_provider_add",
          description:
            "Save a disabled custom quota-provider proposal in the canonical dashboard config. Supply an environment-variable name, never a credential value. Adding does not approve it or enable quota polling.",
          input: ADD_TOOL_INPUT,
          async execute(input) {
            return customProviderToolResult(() =>
              agentCustomProviderStore.add(isPlainObject(input) ? input.definition : undefined),
            );
          },
        });
        editor.add({
          name: "quota_custom_provider_test",
          description:
            "Make one safe, non-redirecting HTTPS test request to a public endpoint for a proposal. Never provides approval or enables polling. Do not include credentials in tool arguments.",
          input: ID_TOOL_INPUT,
          async execute(input) {
            return customProviderToolResult(() =>
              agentCustomProviderStore.test(requiredToolId(input)),
            );
          },
        });
        editor.add({
          name: "quota_custom_provider_remove",
          description:
            "Remove a disabled custom quota-provider proposal by id. This does not change active quota providers or OpenCode configuration.",
          input: ID_TOOL_INPUT,
          async execute(input) {
            return customProviderToolResult(() =>
              agentCustomProviderStore.remove(requiredToolId(input)),
            );
          },
        });
      });
    } catch {
      console.warn(
        "[opencode-quota-gui] agent custom-provider tools unavailable: registration-failed",
      );
    }

    return async () => {
      hostEvents.abort();
      publishHostEventSourceState("stopped", Date.now());
      unbindCredentialSource();
      if (agentProviderTools) {
        try {
          await agentProviderTools.dispose();
        } catch {
          console.warn(
            "[opencode-quota-gui] agent custom-provider tools stop failed: dispose-failed",
          );
        }
      }
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
