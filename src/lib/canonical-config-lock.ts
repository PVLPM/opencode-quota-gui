import { resolve } from "node:path";

const CANONICAL_CONFIG_LOCKS = Symbol.for("opencode-quota-gui.canonical-config-locks.v1");

type LockRegistry = Map<string, Promise<void>>;

function registry(): LockRegistry {
  const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
  const existing = globalState[CANONICAL_CONFIG_LOCKS] as LockRegistry | undefined;
  if (existing) return existing;
  const created: LockRegistry = new Map();
  globalState[CANONICAL_CONFIG_LOCKS] = created;
  return created;
}

function lockKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * Serialize cooperating in-process writers of the same canonical file, even
 * when separate GUI and proposal-store instances perform asynchronous edits.
 * External editors/processes do not participate in this lock. Config document
 * writes recheck bytes and target after staging and immediately before rename,
 * which narrows but cannot eliminate a race with noncooperating writers.
 */
export function withCanonicalConfigLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  const locks = registry();
  const key = lockKey(path);
  const prior = locks.get(key) ?? Promise.resolve();
  const next = prior.then(run, run);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return next;
}
