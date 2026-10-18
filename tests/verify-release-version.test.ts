import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(new URL("../scripts/verify-release-version.mjs", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

interface VersionEnv {
  githubRef?: string;
  releaseTag?: string;
}

function runWithEnv({ githubRef, releaseTag }: VersionEnv) {
  const env = { ...process.env };
  if (githubRef === undefined) delete env.GITHUB_REF;
  else env.GITHUB_REF = githubRef;
  if (releaseTag === undefined) delete env.RELEASE_TAG;
  else env.RELEASE_TAG = releaseTag;

  return spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
}

function runWithRef(githubRef?: string) {
  return runWithEnv({ githubRef });
}

describe("release version verification", () => {
  it("skips successfully when no explicit tag and no tag ref is present", () => {
    const result = runWithRef();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No tag ref detected");
  });

  it("accepts v-prefixed and plain tags that match package.json", () => {
    for (const tag of [`v${pkg.version}`, pkg.version]) {
      const result = runWithRef(`refs/tags/${tag}`);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`matches package.json ${pkg.version}`);
    }
  });

  it("accepts an explicit dispatched RELEASE_TAG without a tag ref", () => {
    for (const tag of [`v${pkg.version}`, pkg.version]) {
      const result = runWithEnv({ githubRef: "refs/heads/main", releaseTag: tag });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`matches package.json ${pkg.version}`);
    }
  });

  it("lets the explicit RELEASE_TAG win over a mismatching tag ref", () => {
    const result = runWithEnv({
      githubRef: "refs/tags/v0.0.0-mismatch",
      releaseTag: `v${pkg.version}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`matches package.json ${pkg.version}`);
  });

  it("rejects a refused explicit tag that does not match package.json", () => {
    const result = runWithEnv({ releaseTag: `v${pkg.version}-mismatch` });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Version mismatch");
  });

  it("rejects a tag that does not match package.json", () => {
    const result = runWithRef(`refs/tags/v${pkg.version}-mismatch`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Version mismatch");
  });

  it("rejects an empty tag ref", () => {
    const result = runWithRef("refs/tags/");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to parse tag version");
  });

  it("rejects a bare v explicit tag", () => {
    const result = runWithEnv({ releaseTag: "v" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unable to parse tag version");
  });

  it("rejects a defined but blank explicit RELEASE_TAG instead of skipping", () => {
    for (const releaseTag of ["", "   "]) {
      const result = runWithEnv({ githubRef: "refs/heads/main", releaseTag });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unable to parse tag version from RELEASE_TAG");
      expect(result.stdout).not.toContain("No tag ref detected");
    }
  });
});
