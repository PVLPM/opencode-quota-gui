import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
