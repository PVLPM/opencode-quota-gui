import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdir, open, readFile, rm, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

const DEFAULT_LOCK_RETRY_DELAY_MS = 20;
const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const DEFAULT_STALE_LOCK_AGE_MS = 30_000;
const DEFAULT_RELEASE_ATTEMPTS = 3;
const DEFAULT_RELEASE_RETRY_DELAY_MS = 10;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_FILE = "reclaim";

export interface StateFileLockOptions {
  /** Give up after this long and throw; callers that must not block skip. */
  timeoutMs?: number;
  retryDelayMs?: number;
  /** A lock directory/owner this old without a live process is reclaimable. */
  staleMs?: number;
  /**
   * A still-live owner older than this bound is reclaimable because the PID may
   * have been reused by another process. A fresh live owner is never reclaimed.
   */
  liveOwnerMaxAgeMs?: number;
}

type StateLockOwner = {
  token: string;
  pid: number;
  createdAtMs: number;
};

function isFileSystemError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockOwner(value: string): StateLockOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<StateLockOwner>;
    if (
      typeof owner.token !== "string" ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid ?? 0) <= 0 ||
      !Number.isFinite(owner.createdAtMs)
    ) {
      return null;
    }
    return owner as StateLockOwner;
  } catch {
    return null;
  }
}

async function readLockOwner(lockPath: string): Promise<StateLockOwner | null> {
  try {
    return parseLockOwner(await readFile(join(lockPath, LOCK_OWNER_FILE), "utf8"));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

function ownerReclaimable(
  owner: StateLockOwner,
  nowMs: number,
  liveOwnerMaxAgeMs: number | undefined,
): boolean {
  if (!isProcessAlive(owner.pid)) return true;
  // PID reuse can leave a dead claim looking alive. A bound older than the
  // longest possible attempt is reclaimable; a fresh live claim never is.
  return liveOwnerMaxAgeMs !== undefined && nowMs - owner.createdAtMs > liveOwnerMaxAgeMs;
}

type ReclaimStatus = {
  reclaimable: boolean;
  allowMissingOwner: boolean;
  ownerToken?: string;
};

async function getReclaimStatus(
  lockPath: string,
  staleMs: number,
  liveOwnerMaxAgeMs: number | undefined,
): Promise<ReclaimStatus> {
  const owner = await readLockOwner(lockPath);
  if (owner) {
    return {
      reclaimable: ownerReclaimable(owner, Date.now(), liveOwnerMaxAgeMs),
      allowMissingOwner: false,
      ownerToken: owner.token,
    };
  }

  try {
    const lock = await stat(lockPath);
    const stale = Date.now() - lock.mtimeMs > staleMs;
    return { reclaimable: stale, allowMissingOwner: stale };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return { reclaimable: true, allowMissingOwner: true };
    }
    throw error;
  }
}

async function clearReclaimMarker(reclaimPath: string): Promise<void> {
  await unlink(reclaimPath).catch((error: unknown) => {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  });
}

async function tryReclaimStateLock(
  lockPath: string,
  status: ReclaimStatus,
  staleMs: number,
  liveOwnerMaxAgeMs: number | undefined,
): Promise<boolean> {
  const reclaimPath = join(lockPath, LOCK_RECLAIM_FILE);
  /**
   * Ownership fence: the owner observed before the reclaim attempt must still
   * be the same owner and still reclaimable. A new owner (different token) is
   * never removed.
   */
  const ownerStillMatches = (owner: StateLockOwner | null): boolean =>
    status.ownerToken !== undefined
      ? owner?.token === status.ownerToken && ownerReclaimable(owner, Date.now(), liveOwnerMaxAgeMs)
      : owner === null && status.allowMissingOwner;

  try {
    const handle = await open(reclaimPath, "wx", 0o600);
    await handle.close();
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return true;
    if (!isFileSystemError(error, "EEXIST")) throw error;

    try {
      const reclaim = await stat(reclaimPath);
      if (Date.now() - reclaim.mtimeMs <= staleMs) return false;
    } catch (statError) {
      if (isFileSystemError(statError, "ENOENT")) return false;
      throw statError;
    }

    const owner = await readLockOwner(lockPath);
    if (!ownerStillMatches(owner)) {
      await clearReclaimMarker(reclaimPath);
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  const owner = await readLockOwner(lockPath);
  if (ownerStillMatches(owner)) {
    await rm(lockPath, { recursive: true, force: true });
    return true;
  }

  await clearReclaimMarker(reclaimPath);
  return false;
}

/** Release retries a transient removal failure; a permanent failure is surfaced. */
export async function removeStateLockWithRetry(
  lockPath: string,
  options: {
    attempts?: number;
    retryDelayMs?: number;
    remove?: (path: string) => Promise<void>;
  } = {},
): Promise<void> {
  const attempts = Math.max(1, options.attempts ?? DEFAULT_RELEASE_ATTEMPTS);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RELEASE_RETRY_DELAY_MS;
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
  for (let attempt = 1; ; attempt += 1) {
    try {
      await remove(lockPath);
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await delay(retryDelayMs);
    }
  }
}

/**
 * Cross-process state-file lock: a lock directory next to the state file with a
 * PID/token owner. A dead owner or an ownerless lock older than `staleMs` is
 * reclaimed through a second exclusive file. Throws when the timeout expires so
 * callers that must stay responsive can catch it and skip the work.
 */
export async function acquireStateFileLock(
  statePath: string,
  options: StateFileLockOptions = {},
): Promise<() => Promise<void>> {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_LOCK_RETRY_DELAY_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  const liveOwnerMaxAgeMs = options.liveOwnerMaxAgeMs;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
  const lockPath = `${statePath}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const owner = { token, pid: process.pid, createdAtMs: Date.now() } satisfies StateLockOwner;
      try {
        writeFileSync(join(lockPath, LOCK_OWNER_FILE), JSON.stringify(owner), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        await rmdir(lockPath).catch(() => undefined);
        throw error;
      }

      return async () => {
        let currentOwner: StateLockOwner | null;
        try {
          currentOwner = await readLockOwner(lockPath);
        } catch {
          currentOwner = null;
        }
        if (currentOwner?.token !== token) return;
        await removeStateLockWithRetry(lockPath);
      };
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }

    const status = await getReclaimStatus(lockPath, staleMs, liveOwnerMaxAgeMs);
    if (
      status.reclaimable &&
      (await tryReclaimStateLock(lockPath, status, staleMs, liveOwnerMaxAgeMs))
    ) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out acquiring state file lock: ${lockPath}`);
    }
    await delay(retryDelayMs);
  }
}
