import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpDashboardClient } from "../src/ui/dashboard-client.js";
import * as viewModel from "../src/ui/view-model.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function generator() {
  return import(
    /* @vite-ignore */ pathToFileURL(join(process.cwd(), "scripts/build-identity.mjs")).href
  );
}

function fixture(git = true) {
  const root = mkdtempSync(join(tmpdir(), "quota-build-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0", type: "module" }));
  if (git) {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Synthetic",
        "-c",
        "user.email=synthetic@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
  }
  return root;
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
    const sha = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
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
