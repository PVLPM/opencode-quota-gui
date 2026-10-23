import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const UPSTREAM_QUOTA_DIRNAME = "opencode-quota";
const UPSTREAM_QUOTA_FILENAMES = ["quota-toast.jsonc", "quota-toast.json"] as const;

export class GuiConfigTargetError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "GuiConfigTargetError";
  }
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function comparisonKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return comparisonKey(left) === comparisonKey(right);
}

function isInsidePath(child: string, parent: string): boolean {
  const childKey = comparisonKey(child);
  const parentKey = comparisonKey(parent);
  const rel = relative(parentKey, childKey);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve through the deepest existing ancestor so missing GUI files still detect a
 * symlinked/junctioned parent directory. Realpath failures other than ENOENT are left
 * to the existing config-write-target protections (dangling links, loops, permissions).
 */
function resolveThroughExistingAncestor(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return resolve(realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return absolute;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function upstreamQuotaPaths(configDir: string): {
  root: string;
  files: string[];
} {
  const root = join(resolve(configDir), UPSTREAM_QUOTA_DIRNAME);
  return {
    root,
    files: UPSTREAM_QUOTA_FILENAMES.map((filename) => join(root, filename)),
  };
}

/**
 * Reject a GUI canonical config target that resolves into upstream's quota directory or
 * one of its quota-toast files, directly or through a symlink/junction alias. Legitimate
 * symlinks elsewhere are allowed. Call this before planning a write and again before apply
 * so a retargeted link cannot turn a GUI write into an upstream-source write.
 */
export async function assertGuiConfigTargetIsIndependent(
  configPath: string,
  configDir: string,
): Promise<void> {
  const upstream = upstreamQuotaPaths(configDir);
  const targetPaths = [
    ...new Set([resolve(configPath), resolveThroughExistingAncestor(configPath)]),
  ];
  const upstreamRoots = [
    ...new Set([resolve(upstream.root), resolveThroughExistingAncestor(upstream.root)]),
  ];
  const upstreamFiles = [
    ...new Set(
      upstream.files.flatMap((file) => [resolve(file), resolveThroughExistingAncestor(file)]),
    ),
  ];

  for (const target of targetPaths) {
    if (upstreamRoots.some((root) => isInsidePath(target, root))) {
      throw new GuiConfigTargetError(
        `Refusing to write GUI config at ${configPath}: it resolves into upstream quota configuration at ${upstream.root}.`,
        configPath,
      );
    }
    if (upstreamFiles.some((file) => samePath(target, file))) {
      throw new GuiConfigTargetError(
        `Refusing to write GUI config at ${configPath}: it resolves to upstream quota configuration.`,
        configPath,
      );
    }
  }
}
