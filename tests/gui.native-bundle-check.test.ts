import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkerPath = path.join(repoRoot, "scripts/verify-native-gui-bundle.mjs");
const tempDirs: string[] = [];

function verify(bundle: string): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(path.join(tmpdir(), "native-gui-bundle-check-"));
  tempDirs.push(directory);
  const bundlePath = path.join(directory, "gui-experimental.cjs");
  writeFileSync(bundlePath, bundle, "utf8");
  return spawnSync(process.execPath, [checkerPath, bundlePath], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Native GUI bundle verification", () => {
  it("accepts bundles without Node built-in requires", () => {
    const result = verify('module.exports = require("solid-js");');
    expect(result.status).toBe(0);
  });

  it.each([
    "node:child_process",
    "child_process",
    "node:test",
    "node:test/reporters",
    "node:sqlite",
  ])("rejects a bundle requiring the Node built-in %s", (specifier) => {
    const result = verify(`module.exports = require(${JSON.stringify(specifier)});`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(specifier);
  });
});
