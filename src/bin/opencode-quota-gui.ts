#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInitInstaller } from "../lib/init-installer.js";

const USAGE = [
  "Usage:",
  "  opencode-quota-gui init [--dry-run] [--sync-legacy-config]",
  "  opencode-quota-gui show [--provider <provider-id>] [--json] [--threshold <pct>]",
  "  opencode-quota-gui status [--provider <provider-id>] [--json]",
  "  opencode-quota-gui update [--dry-run] [--yes]",
  "  opencode-quota-gui provider add [--dry-run]",
  "  opencode-quota-gui --help",
  "",
  "Commands:",
  "  init    Run the interactive quota installer",
  "          --dry-run            Preview validated changes without writing files",
  "          --sync-legacy-config also writes experimental.quotaToast",
  "  show    Print a quick quota glance",
  "          --json               Machine-readable JSON output (reads from cache)",
  "          --threshold <pct>    With --json, exit 1 if below <pct>%, 2 if incomplete/not comparable",
  "          --provider <id>      Filter to one provider",
  "  status  Print Quota Status diagnostics (same data as /quota_status)",
  "          --json               Machine-readable JSON output",
  "          --provider <id>      Filter to one provider",
  "  update  Preview safe setting/package-cache changes and report legacy credential findings",
  "          Credential-specific audit sources and values are not read",
  "          Values encountered in normal config parsing are never printed, copied, or modified",
  "          --dry-run            Print the full responsible preview without changing anything",
  "          --yes                Apply only safe setting/cache work after printing the preview",
  "  provider add  Add or update one global quotaProviders definition",
  "          --dry-run            Preview the exact global OpenCode config without writing",
].join("\n");

function printUsage(): void {
  console.log(USAGE);
}

function resolveCliPath(filePath: string): string {
  try {
    return realpathSync.native(filePath);
  } catch {
    return resolve(filePath);
  }
}

export function cliShouldRunMain(
  argv1: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url),
  resolvePath: (filePath: string) => string = resolveCliPath,
): boolean {
  if (!argv1) {
    return false;
  }

  return resolvePath(modulePath) === resolvePath(argv1);
}

/**
 * `show` and `status` read OpenCode's database through node:sqlite, and Node prints
 * "ExperimentalWarning: SQLite is an experimental feature..." when it loads. Hide only
 * that warning; every other warning still prints. Call before node:sqlite loads.
 */
export function hideSqliteExperimentalWarning(): void {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (
      typeof warning === "string" &&
      rest[0] === "ExperimentalWarning" &&
      warning.startsWith("SQLite is an experimental feature")
    ) {
      return;
    }
    return (emitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;

  if (!command) {
    printUsage();
    return 1;
  }

  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return 0;
  }

  if (command === "init") {
    const allowed = new Set(["--dry-run", "--sync-legacy-config"]);
    if (rest.every((arg) => allowed.has(arg)) && new Set(rest).size === rest.length) {
      return await runInitInstaller({
        ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
        ...(rest.includes("--sync-legacy-config") ? { syncLegacyConfig: true } : {}),
      });
    }
  }

  if (command === "show") {
    const { runCliShowCommand } = await import("../lib/cli-show.js");
    return await runCliShowCommand({ argv: rest });
  }

  if (command === "status") {
    const { runCliStatusCommand } = await import("../lib/cli-status.js");
    return await runCliStatusCommand({ argv: rest });
  }

  if (command === "update") {
    const { runScopedUpdateCommand } = await import("../lib/scoped-update.js");
    return await runScopedUpdateCommand({ argv: rest });
  }

  if (command === "provider" && rest[0] === "add") {
    const { runProviderAddCommand } = await import("../lib/provider-add-command.js");
    return await runProviderAddCommand({ argv: rest.slice(1) });
  }

  printUsage();
  return 1;
}

if (cliShouldRunMain()) {
  hideSqliteExperimentalWarning();
  void main().then((code) => {
    process.exitCode = code;
  });
}
