/**
 * Antigravity CLI (`agy`) usage reader.
 *
 * Every read is served by an injected process runner, and the default runner is
 * exercised only against a mocked `node:child_process`. No test starts the real
 * `agy` binary or touches a real account.
 */
import { describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile: execFileMock.execFile }));

import {
  AGY_MINIMUM_VERSION,
  AGY_USAGE_ARGS,
  AGY_VERSION_ARGS,
  type AgyProcessRequest,
  type AgyProcessResult,
  type AgyProcessRunner,
  compareAgyVersions,
  parseAgyResetTimeIso,
  parseAgyVersion,
  readAgyUsage,
  resolveAgyBinaryPath,
  runAgyProcess,
} from "../src/lib/antigravity-cli.js";

/** The documented usage envelope; it contains no account identifiers. */
const SUCCESS_ENVELOPE = {
  status: "SUCCESS",
  response: "Usage windows for your account.",
  command: {
    name: "usage",
    data: {
      description: "Usage limits for the signed-in account.",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-12-04T21:40:30Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude, GPT",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
  usage: { input_tokens: 0, output_tokens: 0 },
};

function result(overrides: Partial<AgyProcessResult> = {}): AgyProcessResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...overrides };
}

/** Serve the version probe, then the usage read, recording every request. */
function runnerStub(params: { version?: AgyProcessResult; usage?: AgyProcessResult }): {
  runner: AgyProcessRunner;
  requests: AgyProcessRequest[];
} {
  const requests: AgyProcessRequest[] = [];
  const runner: AgyProcessRunner = async (request) => {
    requests.push(request);
    if (request.args === AGY_VERSION_ARGS) return params.version ?? result({ stdout: "1.5.18\n" });
    return params.usage ?? result({ stdout: JSON.stringify(SUCCESS_ENVELOPE) });
  };
  return { runner, requests };
}

const BINARY = "/fixtures/agy";

describe("agy version gate", () => {
  it("parses a bare semver and compares against the minimum", () => {
    expect(parseAgyVersion("1.5.18")).toEqual({ major: 1, minor: 5, patch: 18 });
    expect(parseAgyVersion("v1.1.11\n")).toEqual({ major: 1, minor: 1, patch: 11 });
    expect(parseAgyVersion("1.5.18-beta.1")).toEqual({ major: 1, minor: 5, patch: 18 });
    expect(parseAgyVersion("1.5")).toBeUndefined();
    expect(parseAgyVersion("agy 1.5.18")).toBeUndefined();
    expect(parseAgyVersion("")).toBeUndefined();

    const minimum = parseAgyVersion(AGY_MINIMUM_VERSION);
    expect(minimum).toBeDefined();
    if (!minimum) return;
    expect(compareAgyVersions(parseAgyVersion("1.5.18")!, minimum)).toBeGreaterThan(0);
    expect(compareAgyVersions(parseAgyVersion("1.1.11")!, minimum)).toBe(0);
    expect(compareAgyVersions(parseAgyVersion("1.1.10")!, minimum)).toBeLessThan(0);
    expect(compareAgyVersions(parseAgyVersion("1.0.99")!, minimum)).toBeLessThan(0);
  });

  it("reports an unsupported version and makes no further call", async () => {
    const { runner, requests } = runnerStub({ version: result({ stdout: "1.1.10\n" }) });

    const read = await readAgyUsage({ runner, binaryPath: BINARY });

    expect(read).toEqual({ state: "unsupported-version", version: "1.1.10" });
    expect(requests.map((request) => request.args)).toEqual([AGY_VERSION_ARGS]);
  });

  it("reports an unparsable version and makes no further call", async () => {
    const { runner, requests } = runnerStub({ version: result({ stdout: "unknown build" }) });

    const read = await readAgyUsage({ runner, binaryPath: BINARY });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toContain("cannot parse");
    expect(read.failureCategory).toBe("local");
    expect(requests).toHaveLength(1);
  });

  it("reports a missing binary without a version probe", async () => {
    const { runner, requests } = runnerStub({});
    const read = await readAgyUsage({
      runner,
      platform: "linux",
      env: { PATH: "/definitely/not/here" },
      isFile: async () => false,
    });

    expect(read).toEqual({ state: "not-installed" });
    expect(requests).toEqual([]);
  });
});

describe("agy usage envelope", () => {
  it("reads only the trusted command and keys every bucket by its provider id", async () => {
    const { runner, requests } = runnerStub({});

    const read = await readAgyUsage({ runner, binaryPath: BINARY });

    expect(requests).toHaveLength(2);
    // The supported read is exactly the documented machine-readable slash command.
    expect(requests[1]?.args).toEqual(AGY_USAGE_ARGS);
    expect(requests[1]?.args).not.toContain("--disable-slash-commands");
    expect(requests[1]?.file).toBe(BINARY);

    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "gemini-weekly",
      "3p-weekly",
      "3p-5h",
    ]);
    expect(read.buckets.map((bucket) => bucket.label)).toEqual(["Weekly", "Weekly", "5h"]);
    expect(read.buckets.map((bucket) => bucket.groupName)).toEqual([
      "Gemini Models",
      "Claude and GPT models",
      "Claude and GPT models",
    ]);
    expect(read.buckets.map((bucket) => bucket.percentRemaining)).toEqual([100, 100, 100]);
    // Epoch zero means "no reset scheduled", never a past reset.
    expect(read.buckets.map((bucket) => bucket.resetTimeIso)).toEqual([
      "2026-12-04T21:40:30.000Z",
      undefined,
      undefined,
    ]);
  });

  it("keeps the reported fraction and skips a bucket without one", async () => {
    const envelope = structuredClone(SUCCESS_ENVELOPE);
    envelope.command.data.groups[0]!.buckets[0]!.remaining_fraction = 0.42;
    envelope.command.data.groups[1]!.buckets.push({
      id: "3p-monthly",
      name: "Monthly Limit Remaining",
      window: "monthly",
      // No remaining_fraction: nothing to report.
      reset_time: "2026-12-04T21:40:30Z",
    } as unknown as (typeof envelope.command.data.groups)[1]["buckets"][number]);

    const read = await readAgyUsage({
      runner: runnerStub({ usage: result({ stdout: JSON.stringify(envelope) }) }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "gemini-weekly",
      "3p-weekly",
      "3p-5h",
    ]);
    expect(read.buckets[0]?.percentRemaining).toBeCloseTo(42, 5);
  });

  it("skips a bucket that has no provider id instead of keying it by its label", async () => {
    const envelope = structuredClone(SUCCESS_ENVELOPE);
    envelope.command.data.groups[0]!.buckets.push({
      name: "Weekly Limit Remaining",
      window: "weekly",
      remaining_fraction: 0.5,
      reset_time: "2026-12-04T21:40:30Z",
    } as unknown as (typeof envelope.command.data.groups)[0]["buckets"][number]);

    const read = await readAgyUsage({
      runner: runnerStub({ usage: result({ stdout: JSON.stringify(envelope) }) }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("ok");
    if (read.state !== "ok") return;
    expect(read.buckets.map((bucket) => bucket.bucketId)).toEqual([
      "gemini-weekly",
      "3p-weekly",
      "3p-5h",
    ]);
  });

  it("reports no quota when the CLI succeeded but lists no reportable bucket", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({
        usage: result({
          stdout: JSON.stringify({
            status: "SUCCESS",
            command: { name: "usage", data: { groups: [] } },
          }),
        }),
      }).runner,
      binaryPath: BINARY,
    });

    expect(read).toEqual({ state: "no-quota" });
  });
});

describe("agy failure states", () => {
  it("reports a status ERROR envelope", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({
        usage: result({
          stdout: JSON.stringify({ status: "ERROR", error: "quota backend unavailable" }),
        }),
      }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toBe("Antigravity CLI error: quota backend unavailable");
  });

  it("reports exit 2 as a no-quota state, not a crash", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({ usage: result({ code: 2, stderr: "no account quota" }) }).runner,
      binaryPath: BINARY,
    });

    expect(read).toEqual({ state: "no-quota" });
  });

  it("surfaces the JSON .error of an exit 1 failure when stderr is empty", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({
        usage: result({ code: 1, stdout: JSON.stringify({ error: "model not available" }) }),
      }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toBe("Antigravity CLI error: model not available");
    expect(read.failureCategory).toBe("provider_api");
    expect(read.exitCode).toBe(1);
  });

  it("treats exit 3 as a failure after partial output", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({ usage: result({ code: 3 }) }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toContain("exit 3");
    expect(read.failureCategory).toBe("provider_api");
  });

  it("reports a timeout as a local failure", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({ usage: result({ timedOut: true }) }).runner,
      binaryPath: BINARY,
      usageTimeoutMs: 30_000,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toContain("timed out after 30s");
    expect(read.failureCategory).toBe("local");
  });

  it("treats a missing command name after a model turn as spent quota", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({
        usage: result({
          stdout: JSON.stringify({
            status: "SUCCESS",
            response: "Here is your usage summary.",
            num_turns: 2,
          }),
        }),
      }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toContain("may have spent quota");
    // Our own guard is not a provider verdict, so it never carries a category.
    expect(read.failureCategory).toBeUndefined();
  });

  it("treats a conversation id as proof that a model turn ran", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({
        usage: result({
          stdout: JSON.stringify({ status: "SUCCESS", conversation_id: "conv-1" }),
        }),
      }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toContain("may have spent quota");
  });

  it("reports unparsable output as an error", async () => {
    const read = await readAgyUsage({
      runner: runnerStub({ usage: result({ stdout: "not json" }) }).runner,
      binaryPath: BINARY,
    });

    expect(read.state).toBe("error");
    if (read.state !== "error") return;
    expect(read.message).toBe("Antigravity CLI returned unparsable output.");
    expect(read.failureCategory).toBeUndefined();
  });
});

describe("agy reset normalization", () => {
  it("treats epoch zero and unparsable values as no reset", () => {
    expect(parseAgyResetTimeIso("1970-01-01T00:00:00Z")).toBeUndefined();
    expect(parseAgyResetTimeIso("not-a-date")).toBeUndefined();
    expect(parseAgyResetTimeIso(undefined)).toBeUndefined();
    expect(parseAgyResetTimeIso("2026-12-04T21:40:30Z")).toBe("2026-12-04T21:40:30.000Z");
  });
});

describe("agy binary resolution", () => {
  it("finds agy on PATH", async () => {
    const found = await resolveAgyBinaryPath({
      platform: "win32",
      env: { PATH: "C:\\Tools;C:\\Other" },
      isFile: async (candidate) => candidate === "C:\\Other\\agy.exe",
    });

    expect(found).toBe("C:\\Other\\agy.exe");
  });

  it("falls back to the Windows installer location when PATH misses it", async () => {
    const found = await resolveAgyBinaryPath({
      platform: "win32",
      env: { PATH: "C:\\Tools", LOCALAPPDATA: "C:\\Users\\fixture\\AppData\\Local" },
      isFile: async (candidate) =>
        candidate === "C:\\Users\\fixture\\AppData\\Local\\agy\\bin\\agy.exe",
    });

    expect(found).toBe("C:\\Users\\fixture\\AppData\\Local\\agy\\bin\\agy.exe");
  });

  it("returns null when no candidate is a file", async () => {
    const found = await resolveAgyBinaryPath({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      isFile: async () => false,
    });

    expect(found).toBeNull();
  });
});

describe("agy default runner", () => {
  it("spawns a hidden, shellless child with a timeout", async () => {
    execFileMock.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, "1.5.18\n", "");
      },
    );

    const read = await runAgyProcess({ file: BINARY, args: AGY_USAGE_ARGS, timeoutMs: 30_000 });

    expect(read).toEqual({ code: 0, stdout: "1.5.18\n", stderr: "", timedOut: false });
    expect(execFileMock.execFile).toHaveBeenCalledWith(
      BINARY,
      ["--output-format", "json", "-p", "/usage"],
      expect.objectContaining({ timeout: 30_000, windowsHide: true, shell: false }),
      expect.any(Function),
    );
  });

  it("keeps a failed exit code instead of throwing", async () => {
    execFileMock.execFile.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (
          error: Error & { code?: number; killed?: boolean },
          stdout: string,
          stderr: string,
        ) => void,
      ) => {
        callback(Object.assign(new Error("Command failed"), { code: 2 }), "", "no account");
      },
    );

    const read = await runAgyProcess({ file: BINARY, args: AGY_USAGE_ARGS, timeoutMs: 1_000 });

    expect(read.code).toBe(2);
    expect(read.timedOut).toBe(false);
  });
});
