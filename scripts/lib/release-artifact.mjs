import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const RELEASE_ARTIFACT_MANIFEST = "release-artifact.json";

const PACKAGE_MANAGER_CLI_FILES = { npm: "npm-cli.js", pnpm: "pnpm.cjs" };

function isPackageManagerCli(command, candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const name = path.basename(candidate).toLowerCase();
  if (command === "npm") return name === "npm-cli.js";
  return name.startsWith("pnpm") && /\.(?:cjs|mjs|js)$/.test(name);
}

/**
 * Resolves an `npm`/`pnpm` command to a direct Node invocation. On Windows both commands are
 * `.cmd` shims that `spawnSync` cannot execute (ENOENT), so the package manager's real JS CLI
 * runs with the current Node executable; every argument stays plain argv (no shell, no
 * quoting). Resolution order: `npm_execpath` (set by `npm run`/`pnpm run`/`npm exec`), a CLI
 * beside the running Node, the npm global prefix, and npm's default Windows global root. On
 * POSIX the plain command is kept when nothing matches, preserving existing behavior.
 */
export function resolvePackageManagerInvocation(command) {
  const cliFile = PACKAGE_MANAGER_CLI_FILES[command];
  if (!cliFile) throw new Error(`Unknown package manager: ${command}`);

  const candidates = [process.env.npm_execpath];
  candidates.push(
    path.join(path.dirname(process.execPath), "node_modules", command, "bin", cliFile),
  );
  if (process.env.npm_config_prefix) {
    candidates.push(
      path.join(process.env.npm_config_prefix, "node_modules", command, "bin", cliFile),
    );
  }
  if (process.platform === "win32" && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", command, "bin", cliFile));
  }

  for (const candidate of candidates) {
    if (isPackageManagerCli(command, candidate) && existsSync(candidate)) {
      return { command: process.execPath, args: [candidate] };
    }
  }

  if (process.platform !== "win32") {
    return { command, args: [] };
  }

  throw new Error(
    `Cannot resolve the ${command} CLI on Windows: the ${command}.cmd shim cannot be spawned directly. ` +
      `Run packaging through \`pnpm run\` or npm exec, or make ${cliFile} resolvable via npm_execpath, npm_config_prefix, or the Node installation.`,
  );
}

async function sha256(filePath) {
  const contents = await readFile(filePath);
  return createHash("sha256").update(contents).digest("hex");
}

export async function writeReleaseArtifactManifest(artifactDir, tarballPath) {
  const filename = path.basename(tarballPath);
  const manifest = {
    version: 1,
    filename,
    sha256: await sha256(tarballPath),
  };

  await writeFile(
    path.join(artifactDir, RELEASE_ARTIFACT_MANIFEST),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return manifest;
}

export async function verifyReleaseArtifact(inputDir) {
  const artifactDir = path.resolve(inputDir);
  const artifactStat = await stat(artifactDir);
  if (!artifactStat.isDirectory()) {
    throw new Error(`Release artifact input must be a directory: ${artifactDir}`);
  }

  const files = await readdir(artifactDir);
  const tarballs = files.filter((file) => file.endsWith(".tgz")).sort();
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one .tgz in ${artifactDir}; found ${tarballs.length}.`);
  }

  const rawManifest = await readFile(path.join(artifactDir, RELEASE_ARTIFACT_MANIFEST), "utf8");
  const manifest = JSON.parse(rawManifest);
  const keys = Object.keys(manifest).sort();
  if (
    keys.join(",") !== "filename,sha256,version" ||
    manifest.version !== 1 ||
    typeof manifest.filename !== "string" ||
    typeof manifest.sha256 !== "string"
  ) {
    throw new Error(`${RELEASE_ARTIFACT_MANIFEST} has an invalid shape.`);
  }

  const filename = tarballs[0];
  if (manifest.filename !== filename || path.basename(manifest.filename) !== manifest.filename) {
    throw new Error(
      `${RELEASE_ARTIFACT_MANIFEST} names ${manifest.filename}, but the artifact is ${filename}.`,
    );
  }

  if (!/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error(`${RELEASE_ARTIFACT_MANIFEST} has an invalid SHA-256 digest.`);
  }

  const tarballPath = path.join(artifactDir, filename);
  const actualSha256 = await sha256(tarballPath);
  if (actualSha256 !== manifest.sha256) {
    throw new Error(
      `Release artifact SHA-256 mismatch for ${filename}: expected ${manifest.sha256}, received ${actualSha256}.`,
    );
  }

  return {
    artifactDir,
    filename,
    sha256: actualSha256,
    tarballPath,
  };
}
