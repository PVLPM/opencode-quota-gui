import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireStateFileLock, removeStateLockWithRetry } from "../src/lib/state-file-lock.js";

let stateDir = "";

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "ocq-state-lock-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

function statePath(): string {
  return join(stateDir, "state.json");
}

function lockPath(): string {
  return `${statePath()}.lock`;
}

function ownerPath(): string {
  return join(lockPath(), "owner.json");
}

async function writeOwner(owner: { token: string; pid: number; createdAtMs: number }) {
  await mkdir(lockPath(), { recursive: true });
  await writeFile(ownerPath(), JSON.stringify(owner), "utf8");
}

async function lockExists(): Promise<boolean> {
  try {
    await access(lockPath());
    return true;
  } catch {
    return false;
  }
}

describe("state file lock recovery", () => {
  it("reclaims a dead owner's lock", async () => {
    await writeOwner({
      token: "dead-owner",
      pid: 2_147_483_647,
      createdAtMs: Date.now(),
    });

    const release = await acquireStateFileLock(statePath(), { timeoutMs: 500 });
    expect(await lockExists()).toBe(true);
    await release();
    expect(await lockExists()).toBe(false);
  });

  it("reclaims a reused live PID only after the generous bound", async () => {
    const boundMs = 10_000;
    await writeOwner({
      token: "reused-pid",
      pid: process.pid,
      createdAtMs: Date.now() - boundMs - 1_000,
    });

    const release = await acquireStateFileLock(statePath(), {
      timeoutMs: 500,
      liveOwnerMaxAgeMs: boundMs,
    });
    await release();
    expect(await lockExists()).toBe(false);
  });

  it("never reclaims a fresh live claim", async () => {
    const boundMs = 10_000;
    await writeOwner({
      token: "fresh-live-owner",
      pid: process.pid,
      createdAtMs: Date.now(),
    });

    await expect(
      acquireStateFileLock(statePath(), { timeoutMs: 0, liveOwnerMaxAgeMs: boundMs }),
    ).rejects.toThrow(/Timed out/u);

    const owner = JSON.parse(await readFile(ownerPath(), "utf8")) as { token: string };
    expect(owner.token).toBe("fresh-live-owner");
  });

  it("retries a failed release and surfaces a permanent failure", async () => {
    await mkdir(lockPath(), { recursive: true });

    let attempts = 0;
    await removeStateLockWithRetry(lockPath(), {
      attempts: 3,
      retryDelayMs: 1,
      remove: async () => {
        attempts += 1;
        if (attempts < 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      },
    });
    expect(attempts).toBe(3);

    let permanentAttempts = 0;
    await expect(
      removeStateLockWithRetry(lockPath(), {
        attempts: 2,
        retryDelayMs: 1,
        remove: async () => {
          permanentAttempts += 1;
          throw new Error("release failed");
        },
      }),
    ).rejects.toThrow("release failed");
    expect(permanentAttempts).toBe(2);
  });
});
