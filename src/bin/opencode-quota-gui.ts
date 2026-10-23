#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runInitInstaller } from "../lib/init-installer.js";
import { getPackageVersion } from "../lib/version.js";

const USAGE = [
  "Usage:",
  "  opencode-quota-gui init [--dry-run]",
  "  opencode-quota-gui update [--dry-run] [--yes]",
  "  opencode-quota-gui --help",
  "  opencode-quota-gui --version",
  "",
  "Maintenance commands for the OpenCode Quota GUI dashboard:",
  "  init    Configure the dashboard, its GUI-owned settings, and the OpenCode plugin entry",
  "          --dry-run            Preview validated changes without writing files",
  "  update  Preview safe OpenCode plugin-entry and package-cache maintenance",
  "          Credential-specific audit sources and values are not read",
  "          Values encountered in normal config parsing are never printed, copied, or modified",
  "          --dry-run            Print the full responsible preview without changing anything",
  "          --yes                Apply only safe setting/cache work after printing the preview",
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

  if (command === "--version" || command === "-v" || command === "version") {
    const version = await getPackageVersion();
    console.log(version ?? "unknown");
    return version ? 0 : 1;
  }

  if (command === "init") {
    const allowed = new Set(["--dry-run"]);
    if (rest.every((arg) => allowed.has(arg)) && new Set(rest).size === rest.length) {
      return await runInitInstaller({
        ...(rest.includes("--dry-run") ? { dryRun: true } : {}),
      });
    }
  }

  if (command === "update") {
    const { runScopedUpdateCommand } = await import("../lib/scoped-update.js");
    return await runScopedUpdateCommand({ argv: rest });
  }

  printUsage();
  return 1;
}

if (cliShouldRunMain()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
