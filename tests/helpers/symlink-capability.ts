/**
 * Symlink capability gating for tests that need real symlinks.
 *
 * Symlink creation is a host capability, not a platform check: Windows without
 * Developer Mode, restricted sandboxes and some filesystems reject it with one
 * of a known set of errno codes. Cases that need a symlink report an honest
 * skip for exactly those codes and keep every assertion for capable hosts.
 * Any other failure is a real test failure and must propagate unchanged.
 */
import { symlinkSync } from "node:fs";

const SYMLINK_UNSUPPORTED_CODES = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP"]);

type SkipContext = { skip: (note?: string) => void };

/**
 * Returns the errno code when it means the host cannot create symlinks at all,
 * and `undefined` for every other value. Only these codes may become a skip;
 * anything else is a real failure.
 */
export function symlinkUnsupportedErrorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && SYMLINK_UNSUPPORTED_CODES.has(code) ? code : undefined;
}

/**
 * Creates a symlink for a test or reports a capability skip.
 *
 * Returns `false` after marking the test skipped; the caller must return
 * immediately so the unsupported path never falls through to assertions.
 */
export function symlinkOrSkip(
  context: SkipContext,
  target: string,
  linkPath: string,
  type?: "file" | "dir" | "junction",
): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    const code = symlinkUnsupportedErrorCode(error);
    if (!code) throw error;
    context.skip(
      `host cannot create symlinks (${code}); symlink-dependent assertions skipped. ` +
        `Rerun on linux/macOS or Windows with Developer Mode enabled.`,
    );
    return false;
  }
}
