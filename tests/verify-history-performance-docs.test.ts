import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Disposable-history coverage for the public docs/performance allowlist.
 *
 * Every fixture is a throwaway git repository with its own local identity.
 * The gate is always invoked through V4_HISTORY_REPO/V4_HISTORY_BASE, so the
 * real worktree's history, index, and git config are never read or written.
 */
const scriptPath = fileURLToPath(new URL("../scripts/verify-v4-history.mjs", import.meta.url));
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Never let CI git overrides redirect fixture commands at the real repository. */
function fixtureEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_NAMESPACE",
  ]) {
    delete env[key];
  }
  return env;
}

function git(repo: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: fixtureEnv() });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const absolutePath = join(repo, ...relativePath.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function createFixture(baseFiles: Record<string, string> = { "README.md": "# fixture\n" }): {
  directory: string;
  base: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "ocq-v4-history-"));
  fixtures.push(directory);
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.email", "fixture@example.invalid"]);
  git(directory, ["config", "user.name", "History Fixture"]);
  for (const [relativePath, content] of Object.entries(baseFiles)) {
    writeFile(directory, relativePath, content);
  }
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "--quiet", "-m", "base"]);
  return { directory, base: git(directory, ["rev-parse", "HEAD"]) };
}

function commitFiles(
  fixture: ReturnType<typeof createFixture>,
  files: Record<string, string>,
  message = "fixture change",
): void {
  for (const [relativePath, content] of Object.entries(files)) {
    writeFile(fixture.directory, relativePath, content);
    // Force-add so a fixture .gitignore cannot hide a would-be index violation.
    git(fixture.directory, ["add", "-f", relativePath]);
  }
  git(fixture.directory, ["commit", "--quiet", "-m", message]);
}

function deleteFile(fixture: ReturnType<typeof createFixture>, relativePath: string): void {
  rmSync(join(fixture.directory, ...relativePath.split("/")), { force: true });
  git(fixture.directory, ["rm", "--quiet", relativePath]);
  git(fixture.directory, ["commit", "--quiet", "-m", `remove ${relativePath}`]);
}

function runGate(fixture: ReturnType<typeof createFixture>) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: fixture.directory,
    encoding: "utf8",
    env: fixtureEnv({
      V4_HISTORY_REPO: fixture.directory,
      V4_HISTORY_BASE: fixture.base,
    }),
  });
}

function outputOf(result: ReturnType<typeof runGate>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

describe("verify-v4-history: public performance docs allowlist", () => {
  it("accepts exactly the approved public files under docs/performance", () => {
    const fixture = createFixture();
    commitFiles(fixture, {
      "docs/performance/README.md": "# Performance\n",
      "docs/performance/output-schema.md": "# Schema\n",
      "docs/performance/synchronization.md": "# Synchronization\n",
      // Existing docs/readme behavior must stay allowed.
      "docs/readme/guide.md": "# Guide\n",
    });

    const result = runGate(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("V4 history privacy verified");
  });

  it.each([
    "docs/performance/local/results.json",
    "docs/performance/before.json",
    "docs/performance/report.md",
    "docs/performance/local/README.md",
  ])("rejects a non-allowlisted performance artifact: %s", (relativePath) => {
    const fixture = createFixture();
    commitFiles(fixture, { [relativePath]: "{}\n" });

    const result = runGate(fixture);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain("Forbidden local-only files");
    expect(outputOf(result)).toContain(relativePath);
  });

  it("rejects a force-added forbidden file in the index before it is committed", () => {
    const fixture = createFixture({ ".gitignore": "docs/performance/local/\n" });
    const relativePath = "docs/performance/local/results.json";
    writeFile(fixture.directory, relativePath, "{}\n");
    git(fixture.directory, ["add", "-f", relativePath]);

    const result = runGate(fixture);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain(`index ${relativePath}`);
  });

  it("does not forget a forbidden file deleted in a later commit", () => {
    const fixture = createFixture();
    const relativePath = "docs/performance/local/results.json";
    commitFiles(fixture, { [relativePath]: "{}\n" }, "add local results");
    deleteFile(fixture, relativePath);

    const result = runGate(fixture);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain(relativePath);
  });

  it("preserves the trusted-base boundary for files committed before the base", () => {
    const relativePath = "docs/performance/local/old.json";
    const fixture = createFixture({
      "README.md": "# fixture\n",
      [relativePath]: "{}\n",
    });
    deleteFile(fixture, relativePath);

    const result = runGate(fixture);

    expect(result.status).toBe(0);
  });

  it.each([
    "AGENTS.md",
    "docs/readme/v4-release-readiness.md",
    "local-live-tests/raw.txt",
  ])("keeps the existing privacy rejection for %s", (relativePath) => {
    const fixture = createFixture();
    commitFiles(fixture, { [relativePath]: "private\n" });

    const result = runGate(fixture);

    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain(relativePath);
  });
});
