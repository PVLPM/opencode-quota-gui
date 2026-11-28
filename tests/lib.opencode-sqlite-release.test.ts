import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { openOpenCodeSqliteWritable } from "../src/lib/opencode-sqlite.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");

/**
 * Exercises every statement shape a writable connection hands out (one-off
 * run/all/get, a reused prepared statement, an abandoned iterator), closes it,
 * then deletes the database directory. On Windows an unreleased statement keeps
 * the file locked, which would also block replacing a corrupt analytics store.
 * Plain JavaScript so the same body runs in-process and under Bun.
 */
function probeSource(moduleUrl: string): string {
  return `import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { openOpenCodeSqliteWritable } = await import(${JSON.stringify(moduleUrl)});
const dir = mkdtempSync(join(tmpdir(), "ocq-sqlite-release-"));
const conn = await openOpenCodeSqliteWritable(join(dir, "store.sqlite"));
conn.exec("CREATE TABLE t (a INTEGER)");
conn.run("INSERT INTO t (a) VALUES (?)", [1]);
const insert = conn.prepare("INSERT INTO t (a) VALUES (?)");
insert.run([2]);
insert.run([3]);
conn.all("SELECT a FROM t");
conn.get("SELECT a FROM t WHERE a = ?", [2]);
for (const _row of conn.prepare("SELECT a FROM t ORDER BY a").iterate()) break;
conn.close();
rmSync(dir, { recursive: true });
console.log("released");
`;
}

/**
 * A spawnable Bun executable: `BUN_BINARY`, `bun` on PATH, or on Windows the
 * real `bun.exe` behind an npm `bun.cmd` shim (Node cannot spawn a .cmd shim
 * without a shell).
 */
function resolveBun(): string | undefined {
  const candidates = [process.env.BUN_BINARY, "bun"];
  if (process.platform === "win32") {
    for (const entry of (process.env.PATH ?? "").split(delimiter)) {
      if (entry && existsSync(join(entry, "bun.cmd"))) {
        candidates.push(join(entry, "node_modules", "bun", "bin", "bun.exe"));
      }
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  return undefined;
}

const bun = resolveBun();

function runProbe(command: string, moduleUrl: string) {
  const dir = mkdtempSync(join(tmpdir(), "ocq-sqlite-release-probe-"));
  try {
    const script = join(dir, "probe.mjs");
    writeFileSync(script, probeSource(moduleUrl));
    return spawnSync(command, [script], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("writable SQLite connections release their file on close", () => {
  it("under node:sqlite", async () => {
    const target = mkdtempSync(join(tmpdir(), "ocq-sqlite-release-"));
    try {
      const conn = await openOpenCodeSqliteWritable(join(target, "store.sqlite"));
      conn.exec("CREATE TABLE t (a INTEGER)");
      conn.run("INSERT INTO t (a) VALUES (?)", [1]);
      const insert = conn.prepare("INSERT INTO t (a) VALUES (?)");
      insert.run([2]);
      conn.all("SELECT a FROM t");
      conn.get("SELECT a FROM t WHERE a = ?", [2]);
      for (const _row of conn.prepare("SELECT a FROM t ORDER BY a").iterate()) break;
      conn.close();
      expect(() => rmSync(target, { recursive: true })).not.toThrow();
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  // OpenCode loads the plugin in Bun, which runs the TypeScript source
  // directly. Skipped where no bun binary is installed.
  it.skipIf(bun === undefined)("under bun:sqlite", () => {
    const moduleUrl = pathToFileURL(join(REPO_ROOT, "src/lib/opencode-sqlite.ts")).href;
    const result = runProbe(bun as string, moduleUrl);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("released");
  });
});
