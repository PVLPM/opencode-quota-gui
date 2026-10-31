import { describe, expect, it } from "vitest";

import {
  evaluateCodegraphAutoInit,
  isLinkedWorktree,
  runCodegraphAutoInit,
} from "../scripts/init-worktree-codegraph.mjs";

const ZERO_SHA = "0".repeat(40);

interface FakeSpawnOptions {
  gitDir?: string;
  commonDir?: string;
  gitStatus?: number;
  codegraphInstalled?: boolean;
  initStatus?: number;
}

function fakeSpawn({
  gitDir = "/repo/.git/worktrees/feature",
  commonDir = "/repo/.git",
  gitStatus = 0,
  codegraphInstalled = true,
  initStatus = 0,
}: FakeSpawnOptions = {}) {
  const calls: Array<{ command: string; args: string[]; options?: Record<string, unknown> }> = [];

  const spawn = (command: string, args: string[], options?: Record<string, unknown>) => {
    calls.push({ command, args, options });
    if (command === "git") {
      if (gitStatus !== 0) return { status: gitStatus, stdout: "" };
      const output = args.includes("--git-common-dir") ? commonDir : gitDir;
      return { status: 0, stdout: `${output}\n` };
    }
    if (command === "codegraph") {
      if (args[0] === "--version") return { status: codegraphInstalled ? 0 : 1 };
      return { status: initStatus };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  return { spawn, calls };
}

describe("init-worktree-codegraph decision", () => {
  const base = {
    previousHead: ZERO_SHA,
    checkoutFlag: "1",
    gitDir: "/repo/.git/worktrees/feature",
    commonDir: "/repo/.git",
    hasCodegraphDir: false,
    codegraphAvailable: true,
    cwd: "/repo/feature",
    platform: "linux",
  };

  it("initializes only on the first checkout of a linked worktree", () => {
    expect(evaluateCodegraphAutoInit(base)).toEqual({ init: true, reason: "new-worktree" });
    expect(evaluateCodegraphAutoInit({ ...base, previousHead: "a".repeat(40) })).toEqual({
      init: false,
      reason: "not-a-new-worktree",
    });
  });

  it("never initializes in the main worktree", () => {
    expect(
      evaluateCodegraphAutoInit({ ...base, gitDir: "/repo/.git", commonDir: "/repo/.git" }),
    ).toEqual({ init: false, reason: "not-a-linked-worktree" });
  });

  it("skips file checkouts and worktrees that already have an index", () => {
    expect(evaluateCodegraphAutoInit({ ...base, checkoutFlag: "0" })).toEqual({
      init: false,
      reason: "not-a-branch-checkout",
    });
    expect(evaluateCodegraphAutoInit({ ...base, hasCodegraphDir: true })).toEqual({
      init: false,
      reason: "codegraph-already-initialized",
    });
  });

  it("treats a missing codegraph CLI as a skip, not a failure", () => {
    expect(evaluateCodegraphAutoInit({ ...base, codegraphAvailable: false })).toEqual({
      init: false,
      reason: "codegraph-not-installed",
    });
  });

  it("compares Windows git directories case-insensitively after normalizing separators", () => {
    expect(
      isLinkedWorktree("C:\\repo\\.git\\worktrees\\Feature", "c:/repo/.git", {
        cwd: "C:/repo/feature",
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      isLinkedWorktree("C:\\REPO\\.git", "c:/repo/.git", {
        cwd: "C:/repo",
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("accepts zero object IDs from SHA-256 repositories", () => {
    expect(evaluateCodegraphAutoInit({ ...base, previousHead: "0".repeat(64) })).toEqual({
      init: true,
      reason: "new-worktree",
    });
  });
});

describe("init-worktree-codegraph runner", () => {
  const argv = [ZERO_SHA, "b".repeat(40), "1"];
  const cwd = "/repo/feature";
  const pathExists = () => false;
  const noop = () => {};

  it("runs codegraph init in the new worktree", () => {
    const { spawn, calls } = fakeSpawn();

    expect(
      runCodegraphAutoInit({
        argv,
        cwd,
        spawn,
        pathExists,
        platform: "linux",
        log: noop,
        warn: noop,
      }),
    ).toEqual({ status: "initialized", reason: "new-worktree" });
    expect(calls.map(({ command, args }) => `${command} ${args.join(" ")}`)).toEqual([
      "git rev-parse --git-dir",
      "git rev-parse --git-common-dir",
      "codegraph --version",
      "codegraph init . --yes",
    ]);
    expect(calls.at(-1)?.options?.cwd).toBe(cwd);
  });

  it("does not probe or run codegraph on an ordinary checkout", () => {
    const { spawn, calls } = fakeSpawn();

    expect(
      runCodegraphAutoInit({
        argv: ["c".repeat(40), "d".repeat(40), "1"],
        cwd,
        spawn,
        pathExists,
        platform: "linux",
        log: noop,
        warn: noop,
      }),
    ).toEqual({ status: "skipped", reason: "not-a-new-worktree" });
    expect(calls.some(({ command }) => command === "codegraph")).toBe(false);
  });

  it("skips safely when git or codegraph is unavailable", () => {
    const noGit = fakeSpawn({ gitStatus: 1 });
    expect(
      runCodegraphAutoInit({
        argv,
        cwd,
        spawn: noGit.spawn,
        pathExists,
        platform: "linux",
        log: noop,
        warn: noop,
      }),
    ).toEqual({ status: "skipped", reason: "git-unavailable" });
    expect(noGit.calls.some(({ command }) => command === "codegraph")).toBe(false);

    const noCodegraph = fakeSpawn({ codegraphInstalled: false });
    expect(
      runCodegraphAutoInit({
        argv,
        cwd,
        spawn: noCodegraph.spawn,
        pathExists,
        platform: "linux",
        log: noop,
        warn: noop,
      }),
    ).toEqual({ status: "skipped", reason: "codegraph-not-installed" });
    expect(noCodegraph.calls.some(({ args }) => args[0] === "init")).toBe(false);
  });

  it("reports a failed init without throwing", () => {
    const { spawn } = fakeSpawn({ initStatus: 1 });

    expect(
      runCodegraphAutoInit({
        argv,
        cwd,
        spawn,
        pathExists,
        platform: "linux",
        log: noop,
        warn: noop,
      }),
    ).toEqual({ status: "failed", reason: "codegraph-init-failed" });
  });
});
