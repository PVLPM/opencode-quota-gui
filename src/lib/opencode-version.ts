import { execFile } from "node:child_process";

import {
  type OpenCodeMajor,
  type OpenCodeVersion,
  parseOpenCodeVersion,
} from "./opencode-version-core.js";

// Keep this legacy module path's public surface intact while the implementation
// of pure version helpers lives in a browser-safe module.
export * from "./opencode-version-core.js";

const OPENCODE_VERSION_TIMEOUT_MS = 5_000;

function runOpenCodeVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "opencode",
      ["--version"],
      { encoding: "utf8", timeout: OPENCODE_VERSION_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}

/** Returns undefined when `opencode` is not on PATH, fails, times out, or prints an unknown version. */
export async function detectOpenCodeVersion(
  runVersion: () => Promise<string> = runOpenCodeVersion,
): Promise<OpenCodeVersion | undefined> {
  try {
    return parseOpenCodeVersion(await runVersion());
  } catch {
    return undefined;
  }
}

/** Returns undefined when `opencode` is not on PATH, fails, times out, or prints an unknown version. */
export async function detectOpenCodeMajor(
  runVersion: () => Promise<string> = runOpenCodeVersion,
): Promise<OpenCodeMajor | undefined> {
  const version = await detectOpenCodeVersion(runVersion);
  if (version?.major === 1) return 1;
  if (version?.major === 2) return 2;
  return undefined;
}
