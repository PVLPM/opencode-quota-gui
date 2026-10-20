import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createSyntheticDatabase } from "../scripts/analytics-benchmark-fixtures.mjs";
import {
  assertSanitized,
  BenchError,
  safeErrorCode,
} from "../scripts/analytics-benchmark-harness.mjs";
import {
  openRealSourceReadOnly,
  resolveRealSource,
  selectRealSource,
} from "../scripts/analytics-benchmark-real.mjs";

const ANCHOR_MS = Date.parse("2026-10-20T12:00:00.000Z");
const SMALL_DENSE = { sessions: 60, rows: 6_000 };
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ocq-analytics-benchmark-test-"));
  roots.push(root);
  return root;
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function smallSynthetic(root: string) {
  return createSyntheticDatabase({
    profileName: "dense-30d",
    root,
    anchorMs: ANCHOR_MS,
    overrides: SMALL_DENSE,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("analytics benchmark deterministic synthetic fixtures", () => {
  it("produces the same fixed-seed shape and anonymous selection", async () => {
    const first = await smallSynthetic(tempRoot());
    const second = await smallSynthetic(tempRoot());

    expect(first.synthetic).toEqual(second.synthetic);
    expect(first.selection.summary).toEqual(second.selection.summary);
    expect(first.synthetic.seed).toBe(0x0d3e5e1);
    expect(first.synthetic.sessions).toBe(60);
    expect(first.synthetic.rows).toBe(6_000);
  });
});

describe("analytics benchmark privacy and error boundaries", () => {
  it("rejects identifiers and private paths before output", () => {
    expect(() => assertSanitized({ counts: { sessions: 1 } })).not.toThrow();
    expect(() => assertSanitized({ id: "ses_bench_private" })).toThrowError(BenchError);
    expect(() => assertSanitized({ path: "C:\\synthetic\\private\\opencode.db" })).toThrowError(
      BenchError,
    );
  });

  it("reduces unknown errors and missing sources to fixed codes without leaking text", () => {
    expect(safeErrorCode(new BenchError("timeout"))).toBe("timeout");
    expect(safeErrorCode(new Error("C:\\synthetic\\private\\opencode.db failed"))).toBe(
      "internal-error",
    );

    const root = tempRoot();
    try {
      resolveRealSource(() => join(root, "missing.db"));
      expect.unreachable("missing source should fail");
    } catch (error) {
      expect(safeErrorCode(error)).toBe("real-source-missing");
    }
  });
});

describe("analytics benchmark real-source read-only isolation", () => {
  it("verifies query_only, rejects writes, and leaves a disposable source hash unchanged", async () => {
    const root = tempRoot();
    const fixture = await smallSynthetic(root);
    const beforeHash = hashFile(fixture.dbPath);

    const opened = await openRealSourceReadOnly(fixture.dbPath);
    try {
      expect(opened.queryOnly).toBe(true);
      expect(() => opened.conn.get('CREATE TABLE "benchmark_write_probe" (id INTEGER)')).toThrow();
    } finally {
      opened.conn.close();
    }

    const selected = await selectRealSource(fixture.dbPath, ANCHOR_MS);
    expect(selected.access).toEqual({ mode: "read-only", queryOnly: true });
    expect(selected.counts.sessions).toBeGreaterThan(0);
    expect(() =>
      assertSanitized({
        counts: selected.counts,
        selected: selected.selection.summary,
      }),
    ).not.toThrow();

    expect(hashFile(fixture.dbPath)).toBe(beforeHash);
  });
});

// Canonical `pnpm verify` builds first; source-only test runs may lack the CLI worker.
describe.skipIf(!existsSync(join(REPO_ROOT, "dist/gui/analytics-worker.js")))(
  "analytics benchmark CLI liveness (built worker)",
  () => {
    it("keeps a fresh child alive through cold resume and writes its JSON artifact", () => {
      const root = tempRoot();
      const outPath = join(root, "after-deep.json");
      const child = spawnSync(
        process.execPath,
        [
          join(REPO_ROOT, "scripts/benchmark-analytics.mjs"),
          "--profile",
          "deep-session-tree",
          "--json-out",
          outPath,
        ],
        {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            ANALYTICS_BENCH_SUITE_TIMEOUT_MS: "120000",
            OCQ_BENCH_TMP_DIR: join(root, "bench-tmp"),
          },
          encoding: "utf8",
          timeout: 180_000,
        },
      );

      expect(child.error).toBeUndefined();
      expect(child.status === 0 || child.status === 1).toBe(true);
      expect(existsSync(outPath)).toBe(true);
      const result = JSON.parse(readFileSync(outPath, "utf8"));
      assertSanitized(result);
      const profile = result.profiles[0];
      expect(profile.name).toBe("deep-session-tree");
      expect(profile.coldResume.status).toBe("applied");
      expect(profile.coldResume.passed).toBe(true);
      expect(profile.durationsMs.coldResumeHomeAfterRestart).toEqual(expect.any(Number));
      expect(profile.checks.coldResumeDeltaPassed).toBe(true);
      expect(profile.persistence.snapshotWritten).toBe(true);
      const failed = Object.entries(profile.checks)
        .filter(([, value]) => value === false)
        .map(([name]) => name);
      if (child.status === 1) expect(failed).toEqual(["workerRetainedBounded"]);
      else expect(failed).toEqual([]);
    }, 120_000);
  },
);
