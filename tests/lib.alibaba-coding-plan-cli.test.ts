import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => ({
  taskkillSpawn: undefined as (() => unknown) | undefined,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (
        childProcessMock.taskkillSpawn &&
        String(args[0]).toLowerCase().endsWith("taskkill.exe")
      ) {
        return childProcessMock.taskkillSpawn() as ReturnType<typeof actual.spawn>;
      }
      return actual.spawn(...args);
    },
  };
});

import {
  ALIBABA_CODING_PLAN_ARGS,
  ALIBABA_CODING_PLAN_STDERR_LIMIT_BYTES,
  ALIBABA_CODING_PLAN_STDOUT_LIMIT_BYTES,
  buildAlibabaCodingPlanWindowsShimInvocation,
  parseAlibabaCodingPlanUsageJson,
  queryAlibabaCodingPlanQuota,
  runAlibabaCodingPlanProcess,
} from "../src/lib/alibaba-coding-plan-cli.js";

const temporaryRoots: string[] = [];

async function makeCliPath(name = process.platform === "win32" ? "bl.exe" : "bl") {
  const root = await mkdtemp(path.join(os.tmpdir(), "alibaba-coding-plan-cli-"));
  temporaryRoots.push(root);
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  const cliPath = path.join(root, name);
  await writeFile(cliPath, "fixture; the injected process runner prevents execution", "utf8");
  return { root, workspace, cliPath };
}

async function makeDescendantFixture(detached: boolean) {
  const root = await mkdtemp(path.join(os.tmpdir(), "alibaba-coding-plan-descendant-"));
  temporaryRoots.push(root);
  const descendantPidPath = path.join(root, "descendant.pid");
  const descendantMarkerPath = path.join(root, "descendant-activity");
  const descendantScript = [
    'const fs = require("node:fs");',
    `const marker = ${JSON.stringify(descendantMarkerPath)};`,
    "fs.writeFileSync(marker, String(Date.now()));",
    "setInterval(() => {",
    "  fs.writeFileSync(marker, String(Date.now()));",
    "}, 20);",
  ].join("\n");
  const script = [
    'const { spawn } = require("node:child_process");',
    'const fs = require("node:fs");',
    "const descendant = spawn(process.execPath, [",
    '  "-e",',
    `  ${JSON.stringify(descendantScript)},`,
    `], { detached: ${detached}, stdio: "inherit" });`,
    `fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return { descendantMarkerPath, descendantPidPath, script };
}

async function descendantActivityIsFresh(markerPath: string, maxAgeMs = 250): Promise<boolean> {
  const lastActivity = Number(await readFile(markerPath, "utf8").catch(() => "0"));
  return Date.now() - lastActivity < maxAgeMs;
}

async function stopDescendantIfActive(pidPath: string, markerPath: string): Promise<void> {
  const pid = Number(await readFile(pidPath, "utf8").catch(() => "0"));
  if (Number.isInteger(pid) && pid > 0 && (await descendantActivityIsFresh(markerPath, 200))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The descendant may have exited between the activity check and kill.
    }
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Alibaba Coding Plan CLI JSON parser", () => {
  it("maps the official windows, derives a missing ratio from used and total, and preserves reset times", () => {
    const resetTime = Date.UTC(2026, 3, 1, 12);
    const parsed = parseAlibabaCodingPlanUsageJson(
      JSON.stringify({
        instanceType: "pro",
        per5Hour: {
          usedQuota: 25,
          totalQuota: 200,
          percentage: 0.125,
          resetTime,
        },
        perWeek: { usedQuota: 40, totalQuota: 500, resetTime },
        perBillMonth: { usedQuota: 60, totalQuota: 900, percentage: 0.2 },
      }),
    );

    expect(parsed).toEqual({
      state: "success",
      usage: {
        instanceType: "pro",
        fiveHour: {
          used: 25,
          total: 200,
          percentage: 0.125,
          resetTimeIso: "2026-04-01T12:00:00.000Z",
        },
        weekly: {
          used: 40,
          total: 500,
          percentage: 0.08,
          resetTimeIso: "2026-04-01T12:00:00.000Z",
        },
        monthly: { used: 60, total: 900, percentage: 0.2 },
      },
    });
  });

  it("treats an empty JSON object as no subscription", () => {
    expect(parseAlibabaCodingPlanUsageJson("{}")).toEqual({ state: "no-subscription" });
  });

  it.each([
    ["invalid JSON", "{", "invalid_json"],
    ["non-object JSON", "[]", "invalid_schema"],
    ["missing quota windows", JSON.stringify({ instanceType: "pro" }), "invalid_schema"],
    ["negative usage", JSON.stringify({ per5Hour: { usedQuota: -1 } }), "invalid_schema"],
    ["invalid ratio", JSON.stringify({ perWeek: { percentage: 1.01 } }), "invalid_schema"],
    ["invalid reset", JSON.stringify({ perBillMonth: { resetTime: "later" } }), "invalid_schema"],
  ])("rejects %s rather than interpreting it as a subscription", (_name, input, kind) => {
    expect(parseAlibabaCodingPlanUsageJson(input)).toMatchObject({
      state: "error",
      error: { kind },
    });
  });
});

describe("Alibaba Coding Plan CLI execution", () => {
  it("runs exactly the read-only usage command with bounded, isolated process settings", async () => {
    const { root, workspace, cliPath } = await makeCliPath();
    const spawn = vi.fn(async () => ({
      code: 0,
      stdout: Buffer.from(JSON.stringify({ per5Hour: { usedQuota: 1, totalQuota: 10 } })),
      stderr: Buffer.alloc(0),
      timedOut: false,
      truncated: false,
    }));

    const result = await queryAlibabaCodingPlanQuota({
      requestTimeoutMs: 90_000,
      runtime: {
        cwd: workspace,
        pathEnv: root,
        tmpdir: root,
        platform: process.platform,
        spawn,
      },
    });

    expect(result).toMatchObject({ state: "success" });
    expect(spawn).toHaveBeenCalledTimes(1);
    const request = spawn.mock.calls[0]?.[0] as any;
    expect(request.args).toEqual(ALIBABA_CODING_PLAN_ARGS);
    expect(request.shell).toBe(false);
    expect(request.stdin).toBe("ignore");
    expect(request.timeoutMs).toBe(15_000);
    expect(request.stdoutLimitBytes).toBe(ALIBABA_CODING_PLAN_STDOUT_LIMIT_BYTES);
    expect(request.stderrLimitBytes).toBe(ALIBABA_CODING_PLAN_STDERR_LIMIT_BYTES);
    expect(request.env.PATH).toBe(root);
    expect(path.resolve(request.cwd)).not.toBe(path.resolve(workspace));
    expect(path.resolve(request.file)).toBe(path.resolve(cliPath));
  });

  it("reports a missing CLI without exposing child output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "alibaba-coding-plan-empty-path-"));
    temporaryRoots.push(root);
    const result = await queryAlibabaCodingPlanQuota({
      runtime: { cwd: root, pathEnv: root, platform: process.platform },
    });

    expect(result).toMatchObject({
      state: "error",
      error: { kind: "executable_not_found", message: expect.stringContaining('"bl"') },
    });
  });

  it("recognizes CLI authentication failure and discards stderr", async () => {
    const { root, workspace } = await makeCliPath();
    const result = await queryAlibabaCodingPlanQuota({
      runtime: {
        cwd: workspace,
        pathEnv: root,
        tmpdir: root,
        platform: process.platform,
        spawn: async () => ({
          code: 3,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("secret account detail"),
          timedOut: false,
          truncated: false,
        }),
      },
    });

    expect(result).toMatchObject({
      state: "error",
      error: { kind: "not_authenticated", message: expect.stringContaining("Console account") },
    });
    expect(JSON.stringify(result)).not.toContain("secret account detail");
  });

  it("builds a quoted fixed Windows npm-shim invocation and rejects shell metacharacters", () => {
    expect(
      buildAlibabaCodingPlanWindowsShimInvocation(
        "C:\\Program Files\\Bailian CLI\\bl.cmd",
        "C:\\Windows",
      ),
    ).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\Program Files\\Bailian CLI\\bl.cmd" usage coding-plan --output json"',
      ],
    });
    expect(
      buildAlibabaCodingPlanWindowsShimInvocation("C:\\tools\\bl.cmd & whoami", "C:\\Windows"),
    ).toBeNull();
    expect(
      buildAlibabaCodingPlanWindowsShimInvocation("C:\\tools\\bl.cmd", "C:\\Windows%TEMP%"),
    ).toBeNull();
  });

  it.skipIf(process.platform !== "win32")(
    "starts Windows npm shims through fixed cmd.exe arguments",
    async () => {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) return;
      const { root, workspace } = await makeCliPath("bl.cmd");
      const spawn = vi.fn(async () => ({
        code: 0,
        stdout: Buffer.from("{}"),
        stderr: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
      }));

      await queryAlibabaCodingPlanQuota({
        runtime: {
          cwd: workspace,
          pathEnv: root,
          tmpdir: root,
          env: process.env,
          platform: "win32",
          spawn,
        },
      });

      const request = spawn.mock.calls[0]?.[0] as any;
      expect(request.file.toLowerCase()).toBe(
        path.win32.join(systemRoot, "System32", "cmd.exe").toLowerCase(),
      );
      expect(request.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
      expect(request.args[3]).toContain('bl.cmd" usage coding-plan --output json');
      expect(request.shell).toBe(false);
    },
  );
});

describe("bounded Alibaba Coding Plan child process", () => {
  it.skipIf(process.platform !== "win32")(
    "terminates a timed-out Windows child and its descendant tree",
    async () => {
      const fixture = await makeDescendantFixture(false);
      const startedAt = Date.now();
      let deadline: ReturnType<typeof setTimeout> | undefined;

      try {
        const result = await Promise.race([
          runAlibabaCodingPlanProcess({
            file: process.execPath,
            args: ["-e", fixture.script],
            cwd: os.tmpdir(),
            env: process.env,
            timeoutMs: 250,
            stdoutLimitBytes: 1024,
            stderrLimitBytes: 1024,
            stdin: "ignore",
            shell: false,
            platform: "win32",
            killGraceMs: 100,
          }),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Windows process tree did not settle")),
              2000,
            );
          }),
        ]);

        expect(result.timedOut).toBe(true);
        expect(Number(await readFile(fixture.descendantPidPath, "utf8"))).toBeGreaterThan(0);
        const observationDeadline = startedAt + 1500;
        while (
          Date.now() < observationDeadline &&
          (await descendantActivityIsFresh(fixture.descendantMarkerPath, 300))
        ) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await descendantActivityIsFresh(fixture.descendantMarkerPath, 300)).toBe(false);
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        await stopDescendantIfActive(fixture.descendantPidPath, fixture.descendantMarkerPath);
      }
    },
  );

  it.skipIf(process.platform !== "win32")(
    "settles at the kill deadline when mocked tree cleanup misses an escaped descendant",
    async () => {
      const fixture = await makeDescendantFixture(true);
      const treeKiller = Object.assign(new EventEmitter(), { unref: vi.fn() });
      const mockedTaskkill = vi.fn(() => {
        setImmediate(() => treeKiller.emit("close", 0, null));
        return treeKiller;
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const startedAt = Date.now();
      childProcessMock.taskkillSpawn = mockedTaskkill;

      try {
        const result = await Promise.race([
          runAlibabaCodingPlanProcess({
            file: process.execPath,
            args: ["-e", fixture.script],
            cwd: os.tmpdir(),
            env: process.env,
            timeoutMs: 250,
            stdoutLimitBytes: 1024,
            stderrLimitBytes: 1024,
            stdin: "ignore",
            shell: false,
            platform: "win32",
            killGraceMs: 100,
          }),
          new Promise<never>((_resolve, reject) => {
            deadline = setTimeout(
              () => reject(new Error("escaped child process did not settle")),
              550,
            );
          }),
        ]);

        expect(result.timedOut).toBe(true);
        expect(mockedTaskkill).toHaveBeenCalledOnce();
        const descendantPid = Number(await readFile(fixture.descendantPidPath, "utf8"));
        expect(descendantPid).toBeGreaterThan(0);
        const markerDeadline = startedAt + 800;
        const remainingWait = markerDeadline - Date.now();
        if (remainingWait > 0) await new Promise((resolve) => setTimeout(resolve, remainingWait));
        expect(await descendantActivityIsFresh(fixture.descendantMarkerPath)).toBe(true);
      } finally {
        childProcessMock.taskkillSpawn = undefined;
        if (deadline !== undefined) clearTimeout(deadline);
        await stopDescendantIfActive(fixture.descendantPidPath, fixture.descendantMarkerPath);
      }
    },
  );

  it("terminates a timed-out native child", async () => {
    const result = await runAlibabaCodingPlanProcess({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: os.tmpdir(),
      env: process.env,
      timeoutMs: 50,
      stdoutLimitBytes: 1024,
      stderrLimitBytes: 1024,
      stdin: "ignore",
      shell: false,
      platform: process.platform,
      killGraceMs: 50,
    });

    expect(result.timedOut).toBe(true);
  });

  it("caps captured output and terminates an over-producing child", async () => {
    const result = await runAlibabaCodingPlanProcess({
      file: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(100_000))"],
      cwd: os.tmpdir(),
      env: process.env,
      timeoutMs: 5000,
      stdoutLimitBytes: 32,
      stderrLimitBytes: 32,
      stdin: "ignore",
      shell: false,
      platform: process.platform,
      killGraceMs: 50,
    });

    expect(result.truncated).toBe(true);
    expect(result.stdout.byteLength).toBeLessThanOrEqual(32);
  });
});
