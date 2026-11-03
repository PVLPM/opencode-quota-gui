import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-fA-F0-9]{7,40}$/;
const BUILD_PATTERN = /^[a-f0-9]{7,40}(?:-dirty)?$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function git(root, args) {
  // Git hooks export GIT_DIR/GIT_INDEX_FILE/GIT_CONFIG_PARAMETERS and friends.
  // A child git that inherits them ignores `root` and can read or write the
  // hook's repository, so resolve the identity with a clean git context.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }).trim();
}

/**
 * Windows hands out 8.3 paths (`C:\Users\RUNNER~1\...`) from tmpdir() while git prints the long
 * canonical form, so compare the real on-disk path when it exists. Nonexistent paths (a source
 * archive's parent) fall back to the plain resolution for the caller's comparison.
 */
function canonicalPath(value) {
  const resolved = resolve(value);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(a, b) {
  const left = canonicalPath(a);
  const right = canonicalPath(b);
  // Windows paths are case-insensitive and drive-letter casing varies between short and long forms.
  if (process.platform === "win32")
    return left.replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
  return left === right;
}

/** Only public, bounded literals are allowed across the build/browser seam. */
export function validateBuildIdentity(value) {
  if (
    !value ||
    typeof value.version !== "string" ||
    typeof value.build !== "string" ||
    !VERSION_PATTERN.test(value.version) ||
    !BUILD_PATTERN.test(value.build)
  ) {
    throw new Error("Invalid build identity metadata");
  }
  return { version: value.version, build: value.build };
}

export function resolveBuildIdentity(root, env = process.env) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const override = env.OPENCODE_QUOTA_BUILD_SHA ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA;
  if (override !== undefined && !SHA_PATTERN.test(override)) {
    throw new Error("Build SHA must contain 7–40 hexadecimal characters");
  }
  let sha = override;
  let dirty = false;
  try {
    // Do not borrow a parent repository's HEAD for a source archive.
    if (!samePath(git(root, ["rev-parse", "--show-toplevel"]), root)) {
      throw new Error("Not the build repository");
    }
    sha ??= git(root, ["rev-parse", "--short=12", "HEAD"]);
    dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]).length > 0;
  } catch {
    if (override === undefined)
      throw new Error("Cannot resolve build identity: git HEAD or a CI SHA is required");
  }
  return validateBuildIdentity({
    version,
    build: `${sha.toLowerCase().slice(0, 12)}${dirty ? "-dirty" : ""}`,
  });
}

/** Replace only ignored compiler output, never tracked/generated source. */
export function writeBuildIdentity(root, identity) {
  const target = join(root, "dist/contracts/build-identity.js");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `export const BUILD_IDENTITY = Object.freeze(${JSON.stringify(validateBuildIdentity(identity))});\n`,
  );
  // tsc's map described the unbuilt placeholder, not this emitted literal.
  rmSync(`${target}.map`, { force: true });
  return target;
}

/** Resolve once before any output changes, then give backend and Vite the same snapshot. */
export function runBuild(root, env = process.env) {
  const identity = resolveBuildIdentity(root, env);
  const options = {
    cwd: root,
    stdio: "inherit",
    env: { ...env, OPENCODE_QUOTA_BUILD_IDENTITY: JSON.stringify(identity) },
  };
  const run = (script, ...args) =>
    execFileSync(process.execPath, [join(root, script), ...args], options);
  run("scripts/clean-dist.mjs");
  run("node_modules/typescript/bin/tsc");
  writeBuildIdentity(root, identity);
  run("scripts/copy-data.mjs");
  run("scripts/prepare-tui-dist.mjs");
  run("node_modules/vite/bin/vite.js", "build", "--config", "vite.ui.config.mjs");
  // The Desktop bundle is part of the same artifact: one package, one server
  // plugin, one `./gui-experimental` entry. It is built after the browser UI so
  // a failure there still leaves the recovery surface intact.
  run("node_modules/vite/bin/vite.js", "build", "--config", "vite.native.config.mjs");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runBuild(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
}
