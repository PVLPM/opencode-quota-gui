import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpDashboardClient } from "../src/ui/dashboard-client.js";
import * as viewModel from "../src/ui/view-model.js";
import { isolatedGitEnv } from "./helpers/isolated-git-env.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function generator() {
  return import(
    /* @vite-ignore */ pathToFileURL(join(process.cwd(), "scripts/build-identity.mjs")).href
  );
}

/** Fixture git must never inherit hook-exported GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ...). */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: isolatedGitEnv() }).trim();
}

function fixture(gitRepo = true) {
  const root = mkdtempSync(join(tmpdir(), "quota-build-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
  if (gitRepo) {
    git(root, ["init", "--quiet"]);
    git(root, ["add", "."]);
    git(root, [
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=synthetic@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
  }
  return root;
}

/** HEAD plus a digest of the index bytes, used to prove a repository was not touched. */
function headAndIndex(root: string): { head: string; index: string } {
  const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
  return {
    head: git(root, ["rev-parse", "HEAD"]),
    index: createHash("sha256")
      .update(readFileSync(join(gitDir, "index")))
      .digest("hex"),
  };
}

type HostileCasing = {
  label: string;
  keys: (parent: string) => Record<string, string>;
};

// Git on Windows reads environment names case-insensitively, so a hook variable can arrive as
// git_dir, Git_Dir, and so on. Every casing must be isolated, not just uppercase.
const HOSTILE_CASINGS: HostileCasing[] = [
  {
    label: "uppercase",
    keys: (parent) => ({
      GIT_DIR: join(parent, ".git"),
      GIT_WORK_TREE: parent,
      GIT_INDEX_FILE: join(parent, ".git", "index"),
      GIT_COMMON_DIR: join(parent, ".git"),
      GIT_OBJECT_DIRECTORY: join(parent, ".git", "objects"),
      GIT_NAMESPACE: "hostile-hook",
    }),
  },
  {
    label: "lowercase",
    keys: (parent) => ({
      git_dir: join(parent, ".git"),
      git_work_tree: parent,
      git_index_file: join(parent, ".git", "index"),
      git_common_dir: join(parent, ".git"),
      git_object_directory: join(parent, ".git", "objects"),
      git_namespace: "hostile-hook",
    }),
  },
  {
    label: "mixed-case",
    keys: (parent) => ({
      Git_Dir: join(parent, ".git"),
      git_WORK_TREE: parent,
      Git_Index_File: join(parent, ".git", "index"),
      GIT_Common_Dir: join(parent, ".git"),
      gIt_ObJeCt_DiReCtOrY: join(parent, ".git", "objects"),
      Git_Namespace: "hostile-hook",
    }),
  },
];

/**
 * Install exactly one GIT_* casing variant, then restore the inherited environment.
 * process.env aliases names case-insensitively on Windows, so clearing first prevents a
 * differently-cased inherited key from masking the variant under test.
 */
function withHostileGitEnv<T>(hostile: Record<string, string>, run: () => T): T {
  const inherited = Object.entries(process.env).filter(([key]) =>
    key.toUpperCase().startsWith("GIT_"),
  );
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
  }
  for (const [key, value] of Object.entries(hostile)) process.env[key] = value;
  try {
    return run();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.toUpperCase().startsWith("GIT_")) delete process.env[key];
    }
    for (const [key, value] of inherited) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

/** Spawn the shipped generator with an explicit env object so Windows keeps the exact key casing. */
function resolveInSpawnedEnv(root: string, hostile: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "quota-build-harness-"));
  roots.push(directory);
  const harness = join(directory, "resolve.mjs");
  const moduleUrl = JSON.stringify(
    pathToFileURL(join(repoRoot, "scripts/build-identity.mjs")).href,
  );
  writeFileSync(
    harness,
    [
      `import { resolveBuildIdentity } from ${moduleUrl};`,
      "try {",
      "  console.log(JSON.stringify(resolveBuildIdentity(process.argv[2], {})));",
      "} catch (error) {",
      "  console.error(error instanceof Error ? error.message : String(error));",
      "  process.exitCode = 1;",
      "}",
      "",
    ].join("\n"),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
  );
  return spawnSync(process.execPath, [harness, root], {
    encoding: "utf8",
    env: { ...env, ...hostile },
  });
}

async function assertHostileCasingsIsolated(): Promise<void> {
  const { resolveBuildIdentity } = await generator();
  const parent = fixture();
  const child = fixture();
  const archive = fixture(false);
  const parentBefore = headAndIndex(parent);
  // Guard: nothing in this test may write to the real product repository.
  const productBefore = headAndIndex(repoRoot);
  const childHead = git(child, ["rev-parse", "HEAD"]);
  const childBuild = git(child, ["rev-parse", "--short=12", "HEAD"]);
  const failures: { label: string; error: unknown }[] = [];

  // Every casing isolates the same environment variables, so one set of fixtures covers all
  // three; only the env spelling differs and that is what each iteration exercises.
  for (const casing of HOSTILE_CASINGS) {
    try {
      withHostileGitEnv(casing.keys(parent), () => {
        // Spawned env object: the casing survives the Windows env block; the shipped helper
        // must still resolve the child, not the parent named by the hostile GIT_* values.
        const spawned = resolveInSpawnedEnv(child, casing.keys(parent));
        expect(spawned.status, spawned.stderr).toBe(0);
        expect(JSON.parse(spawned.stdout)).toEqual({ version: "1.0.0", build: childBuild });

        // Fixture command env path: commits stay in the child while the inherited env is hostile.
        // realpath collapses the 8.3 temp root and git's long, forward-slash toplevel to one spelling.
        expect(realpathSync.native(git(child, ["rev-parse", "--show-toplevel"]))).toBe(
          realpathSync.native(child),
        );
        expect(resolveBuildIdentity(child, {})).toEqual({ version: "1.0.0", build: childBuild });

        // No git in the source archive: fail closed instead of borrowing the parent HEAD.
        expect(() => resolveBuildIdentity(archive, {})).toThrow(/identity/);
        expect(resolveBuildIdentity(archive, { CI_COMMIT_SHA: "b".repeat(40) })).toEqual({
          version: "1.0.0",
          build: "b".repeat(12),
        });
      });
    } catch (error) {
      failures.push({ label: casing.label, error });
    }
  }

  expect(childHead).toMatch(/^[a-f0-9]{40}$/);
  expect(headAndIndex(parent)).toEqual(parentBefore);
  expect(headAndIndex(repoRoot)).toEqual(productBefore);
  if (failures.length > 0) {
    const [{ label, error }] = failures;
    throw new Error(
      `${label} GIT_* casing failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

describe("build identity generation", () => {
  it("snapshots once for backend and browser even when build steps change the tree", async () => {
    const { runBuild } = await generator();
    const root = fixture(false);
    for (const dir of ["scripts", "node_modules/typescript/bin", "node_modules/vite/bin"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    const record =
      'import {appendFileSync,writeFileSync} from "node:fs"; appendFileSync("steps.jsonl", JSON.stringify({step:process.argv[1].replaceAll("\\\\","/").split("/").pop(), identity:JSON.parse(process.env.OPENCODE_QUOTA_BUILD_IDENTITY)})+"\\n");';
    for (const file of [
      "scripts/clean-dist.mjs",
      "scripts/copy-data.mjs",
      "scripts/prepare-tui-dist.mjs",
      "node_modules/typescript/bin/tsc",
      "node_modules/vite/bin/vite.js",
    ]) {
      writeFileSync(
        join(root, file),
        `${record}\nwriteFileSync("tree-changed.txt","build output");`,
      );
    }
    runBuild(root, { ...process.env, OPENCODE_QUOTA_BUILD_SHA: "abcdef0123456789" });
    const steps = readFileSync(join(root, "steps.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(steps.map((step) => step.step)).toEqual([
      "clean-dist.mjs",
      "tsc",
      "copy-data.mjs",
      "prepare-tui-dist.mjs",
      "vite.js",
      // The browser UI and the Desktop GUI are two Vite builds in one artifact.
      "vite.js",
    ]);
    for (const step of steps)
      expect(step.identity).toEqual({ version: "1.0.0", build: "abcdef012345" });
    expect(readFileSync(join(root, "dist/contracts/build-identity.js"), "utf8")).toContain(
      '"build":"abcdef012345"',
    );
  });
  it("rejects non-string or private metadata at the Vite snapshot seam", async () => {
    const { validateBuildIdentity } = await generator();
    for (const value of [
      null,
      { version: "1.0.0", build: 1234567 },
      { version: "1.0.0", build: "C:/private" },
    ]) {
      expect(() => validateBuildIdentity(value)).toThrow(/metadata/);
    }
  });
  it("uses package version and current short HEAD; dirty includes untracked files", async () => {
    const { resolveBuildIdentity } = await generator();
    const root = fixture();
    const sha = git(root, ["rev-parse", "--short=12", "HEAD"]);
    expect(resolveBuildIdentity(root, {})).toEqual({ version: "1.0.0", build: sha });
    writeFileSync(join(root, "change.txt"), "synthetic");
    expect(resolveBuildIdentity(root, {})).toEqual({ version: "1.0.0", build: `${sha}-dirty` });
  });

  it("validates CI overrides and detects dirty independently", async () => {
    const { resolveBuildIdentity } = await generator();
    const root = fixture();
    expect(resolveBuildIdentity(root, { OPENCODE_QUOTA_BUILD_SHA: "ABCDEF0123456789" }).build).toBe(
      "abcdef012345",
    );
    expect(resolveBuildIdentity(root, { GITHUB_SHA: "1234567890abcdef" }).build).toBe(
      "1234567890ab",
    );
    writeFileSync(join(root, "change.txt"), "synthetic");
    expect(resolveBuildIdentity(root, { OPENCODE_QUOTA_BUILD_SHA: "abcdef0" }).build).toBe(
      "abcdef0-dirty",
    );
    for (const value of ["", "main", "../secret", "abc\n1234", "1234567-dirty"]) {
      expect(() => resolveBuildIdentity(root, { OPENCODE_QUOTA_BUILD_SHA: value })).toThrow(/SHA/);
    }
  });

  it("does not guess identity without git; validated CI supports source archives", async () => {
    const { resolveBuildIdentity } = await generator();
    const root = fixture(false);
    expect(() => resolveBuildIdentity(root, {})).toThrow(/identity/);
    expect(resolveBuildIdentity(root, { CI_COMMIT_SHA: "a".repeat(40) }).build).toBe(
      "a".repeat(12),
    );
  });

  it("ignores hook GIT_* variables in uppercase, lowercase, and mixed case", async () => {
    await assertHostileCasingsIsolated();
  });

  it("writes a packed browser-safe literal that survives losing git and package.json", async () => {
    const { resolveBuildIdentity, writeBuildIdentity } = await generator();
    const root = fixture();
    const identity = resolveBuildIdentity(root, {});
    const target = writeBuildIdentity(root, identity);
    rmSync(join(root, ".git"), { recursive: true, force: true });
    rmSync(join(root, "package.json"));
    const source = readFileSync(target, "utf8");
    expect(source).not.toMatch(/node:|process|Date|timestamp|Synthetic|fixture|require\(/);
    expect(source).not.toContain(root);
    const packed = await import(/* @vite-ignore */ pathToFileURL(target).href);
    expect(packed.BUILD_IDENTITY).toEqual(identity);
  });
});

describe("identity comparison and health decoding", () => {
  const browser = { version: "1.0.0", build: "abcdef012345" };
  it("warns on different or absent old server identity, not same or unknown browser identity", () => {
    expect(
      viewModel.buildMismatchMessage({ ...browser, contractVersion: 2 }, browser),
    ).toBeUndefined();
    for (const server of [
      { build: "1111111" },
      {},
      { build: "unknown" },
      { ...browser, version: "0.9.0" },
    ]) {
      expect(viewModel.buildMismatchMessage({ ...server, contractVersion: 2 }, browser)).toBe(
        "Build mismatch · restart OpenCode",
      );
    }
    expect(
      viewModel.buildMismatchMessage(
        { contractVersion: 2 },
        { version: "unknown", build: "unknown" },
      ),
    ).toBeUndefined();
  });
  it("contract mismatch remains stronger and build-only mismatch does not gate compatible quota", () => {
    expect(viewModel.buildMismatchMessage({ contractVersion: 1 }, browser)).toBeUndefined();
    expect(viewModel.contractMismatchMessage(1)).toContain("contract version");
    expect(
      viewModel.resolveLoadState(
        { data: "quota", loading: false },
        viewModel.contractMismatchMessage(2),
      ),
    ).toEqual({ kind: "ready", data: "quota", stale: false, refreshing: false });
  });
  it("decodes additive metadata and tolerates old servers, rejects malformed present fields", async () => {
    for (const fields of [{}, browser]) {
      const client = createHttpDashboardClient({
        fetchImpl: async () =>
          Response.json({ app: "opencode-quota-gui", contractVersion: 2, ...fields }),
      });
      expect(await client.health()).toEqual({
        app: "opencode-quota-gui",
        contractVersion: 2,
        ...fields,
      });
    }
    const client = createHttpDashboardClient({
      fetchImpl: async () => Response.json({ contractVersion: 2, build: 42 }),
    });
    await expect(client.health()).rejects.toThrow(/build/);
  });
});
