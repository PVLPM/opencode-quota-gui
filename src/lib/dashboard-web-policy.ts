/**
 * Effective localhost web dashboard switch.
 *
 * The full Native GUI is the primary surface from OpenCode 2.2.1, so the compatibility
 * web transport follows the host version when the canonical key is absent:
 * supported hosts below 2.2.1 keep it on (including 2.2.0), and 2.2.1+ keeps it off.
 * An explicit `dashboard.enabled` value always wins. Missing or unparseable host
 * versions, a malformed canonical file, and an invalid `dashboard.enabled` value
 * all fail closed. The listener itself stays loopback-only at `dashboard.port`.
 */
import type { LoadConfigMeta } from "./config.js";
import { isPreNativeGuiVersion, type OpenCodeVersion } from "./opencode-version-core.js";

export interface DashboardWebPolicyInput {
  /** Canonical `dashboard.enabled` when the key is present and valid. */
  explicitEnabled?: boolean;
  /** Running OpenCode host version; missing or unparseable fails closed. */
  hostVersion?: string | OpenCodeVersion;
  /** A malformed canonical file or an invalid `dashboard.enabled` fails closed. */
  invalidConfig?: boolean;
}

/** Explicit config wins; otherwise only a parseable pre-2.2.1 host defaults on. */
export function resolveDashboardWebEnabled(input: DashboardWebPolicyInput): boolean {
  if (input.invalidConfig) return false;
  if (input.explicitEnabled !== undefined) return input.explicitEnabled;
  return isPreNativeGuiVersion(input.hostVersion);
}

/**
 * The canonical value when the loader actually applied it. The setting-source
 * map is the explicit-presence proof: an absent or invalid value records no
 * source, which keeps the version default in charge.
 */
export function getDashboardEnabledSetting(
  config: { dashboard?: { enabled?: unknown } } | null | undefined,
  meta: Pick<LoadConfigMeta, "settingSources">,
): boolean | undefined {
  if (meta.settingSources["dashboard.enabled"] === undefined) return undefined;
  return config?.dashboard?.enabled === true;
}

/** A malformed root or an invalid `dashboard.enabled` value must not enable web. */
export function hasInvalidDashboardWebConfig(meta: Pick<LoadConfigMeta, "configIssues">): boolean {
  return meta.configIssues.some(
    (issue) => issue.key === "$root" || issue.key === "dashboard.enabled",
  );
}
