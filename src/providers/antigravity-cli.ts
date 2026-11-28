/**
 * Antigravity official CLI (`agy`) provider wrapper.
 *
 * Antigravity's output carries no account identity, and nothing proves the CLI
 * uses the account named in `~/.gemini/google_accounts.json` "active", so this
 * source is deliberately its own card and is never merged with the existing
 * Google AGY companion provider. Both may appear; neither changes the other.
 */

import {
  AGY_MINIMUM_VERSION,
  AGY_USAGE_TIMEOUT_MS,
  AGY_VERSION_TIMEOUT_MS,
  type AgyUsageBucket,
  readAgyUsage,
  resolveAgyBinaryPath,
} from "../lib/antigravity-cli.js";
import type { QuotaProvider, QuotaProviderResult, QuotaToastEntry } from "../lib/entries.js";
import {
  attemptedErrorResult,
  attemptedResult,
  notAttemptedResult,
  statusDetailsFromRecord,
  withStatusDetails,
} from "./result-helpers.js";

export const ANTIGRAVITY_CLI_PROVIDER_ID = "antigravity-cli";
export const ANTIGRAVITY_CLI_LABEL = "Antigravity CLI";

/**
 * The CLI reports no account quota in this state (for example API-key mode).
 * Reported as a visible state, not a crash and not a notifiable failure.
 */
const ANTIGRAVITY_CLI_NO_QUOTA_MESSAGE =
  "Antigravity CLI reports no account quota (for example API-key mode). Sign in with an account to read subscription windows.";

/** Row identity is the provider bucket id; never a display name or position. */
export function antigravityCliRowKey(bucket: Pick<AgyUsageBucket, "bucketId">): string {
  return `named:${bucket.bucketId}`;
}

export function buildAntigravityCliEntries(params: {
  buckets: readonly AgyUsageBucket[];
  observedAtIso: string;
}): QuotaToastEntry[] {
  return params.buckets.map((bucket) => ({
    accounting: {
      resultType: "quota",
      acquisitionMethod: "local_cli",
      ownership: "maintained",
      authority: "provider_reported",
      observedAtIso: params.observedAtIso,
    },
    name: `${bucket.groupName} ${bucket.label}`,
    group: bucket.groupName,
    label: `${bucket.label}:`,
    rowKey: antigravityCliRowKey(bucket),
    percentRemaining: bucket.percentRemaining,
    // The CLI prints exact UTC reset instants; an unscheduled reset is absent.
    ...(bucket.resetTimeIso
      ? { resetTimeIso: bucket.resetTimeIso, resetPrecision: "exact" as const }
      : {}),
  }));
}

export const antigravityCliProvider: QuotaProvider = {
  id: ANTIGRAVITY_CLI_PROVIDER_ID,

  async isAvailable(): Promise<boolean> {
    try {
      return (await resolveAgyBinaryPath()) !== null;
    } catch {
      return false;
    }
  },

  /**
   * The CLI's windows belong to the Antigravity harness, not to an OpenCode
   * model, so this source never claims to match the current OpenCode selection.
   */
  matchesCurrentModel(): boolean {
    return false;
  },

  async fetch(): Promise<QuotaProviderResult> {
    const result = await readAgyUsage({
      usageTimeoutMs: AGY_USAGE_TIMEOUT_MS,
      versionTimeoutMs: AGY_VERSION_TIMEOUT_MS,
    });
    const statusDetails = statusDetailsFromRecord({
      cli_state: result.state,
      cli_bucket_count: result.state === "ok" ? String(result.buckets.length) : undefined,
      cli_exit_code:
        result.state === "error" && result.exitCode !== undefined
          ? String(result.exitCode)
          : undefined,
      cli_reported_version: result.state === "unsupported-version" ? result.version : undefined,
      cli_required_version: AGY_MINIMUM_VERSION,
    });

    switch (result.state) {
      case "not-installed":
        return withStatusDetails(notAttemptedResult(), statusDetails);
      case "unsupported-version":
        return withStatusDetails(
          attemptedErrorResult(
            ANTIGRAVITY_CLI_LABEL,
            `Antigravity CLI ${result.version} is older than the required ${AGY_MINIMUM_VERSION}. Update agy to read quota.`,
            { failureCategory: "local" },
          ),
          statusDetails,
        );
      case "no-quota":
        // No failure category: this is a known state, not a provider failure.
        return withStatusDetails(
          attemptedErrorResult(ANTIGRAVITY_CLI_LABEL, ANTIGRAVITY_CLI_NO_QUOTA_MESSAGE),
          statusDetails,
        );
      case "error":
        return withStatusDetails(
          attemptedErrorResult(ANTIGRAVITY_CLI_LABEL, result.message, {
            ...(result.failureCategory !== undefined
              ? { failureCategory: result.failureCategory }
              : {}),
          }),
          statusDetails,
        );
      default:
        return withStatusDetails(
          attemptedResult(
            buildAntigravityCliEntries({
              buckets: result.buckets,
              observedAtIso: result.observedAtIso,
            }),
            [],
          ),
          statusDetails,
        );
    }
  },
};
