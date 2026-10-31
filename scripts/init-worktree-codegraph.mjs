#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { pathToFileURL } from "node:url";

const CODEGRAPH_COMMAND = "codegraph";
const CODEGRAPH_INIT_ARGS = ["init", ".", "--yes"];
const ZERO_OID = /^0+$/;

function normalizePath(value, cwd, platform) {
  const pathApi = platform === "win32" ? win32 : posix;
  const absolute = pathApi.isAbsolute(value) ? value : pathApi.resolve(cwd, value);
  const normalized = absolute.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isLinkedWorktree(
  gitDir,
  commonDir,
  { cwd = process.cwd(), platform = process.platform } = {},
) {
  if (!gitDir || !commonDir) return false;
  return normalizePath(gitDir, cwd, platform) !== normalizePath(commonDir, cwd, platform);
}

export function evaluateCodegraphAutoInit({
  previousHead,
  checkoutFlag,
  gitDir,
  commonDir,
  hasCodegraphDir,
  codegraphAvailable,
  cwd = process.cwd(),
  platform = process.platform,
}) {
  if (checkoutFlag !== "1") return { init: false, reason: "not-a-branch-checkout" };
  if (!isLinkedWorktree(gitDir, commonDir, { cwd, platform })) {
    return { init: false, reason: "not-a-linked-worktree" };
  }
  // Git reports the null object ID for the first checkout of a worktree, including
  // `git worktree add`. Ordinary checkouts report the previous HEAD instead.
  if (!previousHead || !ZERO_OID.test(previousHead)) {
    return { init: false, reason: "not-a-new-worktree" };
  }
  if (hasCodegraphDir) return { init: false, reason: "codegraph-already-initialized" };
  if (!codegraphAvailable) return { init: false, reason: "codegraph-not-installed" };
  return { init: true, reason: "new-worktree" };
}

function gitOutput(spawn, args, cwd) {
  const result = spawn("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return null;
  return result.stdout.trim();
}

function isCodegraphAvailable({ spawn, cwd, platform }) {
  const result = spawn(CODEGRAPH_COMMAND, ["--version"], {
    cwd,
    stdio: "ignore",
    shell: platform === "win32",
    windowsHide: true,
  });
  return !result.error && result.status === 0;
}

export function runCodegraphAutoInit({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  spawn = spawnSync,
  pathExists = existsSync,
  platform = process.platform,
  log = console.log,
  warn = console.warn,
} = {}) {
  const previousHead = argv[0] ?? "";
  const checkoutFlag = argv[2] ?? "";
  if (checkoutFlag !== "1") return { status: "skipped", reason: "not-a-branch-checkout" };

  const gitDir = gitOutput(spawn, ["rev-parse", "--git-dir"], cwd);
  const commonDir = gitOutput(spawn, ["rev-parse", "--git-common-dir"], cwd);
  if (gitDir === null || commonDir === null) {
    return { status: "skipped", reason: "git-unavailable" };
  }

  const decision = evaluateCodegraphAutoInit({
    previousHead,
    checkoutFlag,
    gitDir,
    commonDir,
    hasCodegraphDir: pathExists(join(cwd, ".codegraph")),
    codegraphAvailable: true,
    cwd,
    platform,
  });
  if (!decision.init) return { status: "skipped", reason: decision.reason };
  if (!isCodegraphAvailable({ spawn, cwd, platform })) {
    return { status: "skipped", reason: "codegraph-not-installed" };
  }

  log(`[codegraph] New worktree detected; initializing the index in ${cwd}`);
  const result = spawn(CODEGRAPH_COMMAND, CODEGRAPH_INIT_ARGS, {
    cwd,
    stdio: "inherit",
    shell: platform === "win32",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    warn("[codegraph] Auto-init failed. Run `codegraph init . --yes` in this worktree to retry.");
    return { status: "failed", reason: "codegraph-init-failed" };
  }

  log("[codegraph] Worktree index initialized.");
  return { status: "initialized", reason: "new-worktree" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCodegraphAutoInit();
}
