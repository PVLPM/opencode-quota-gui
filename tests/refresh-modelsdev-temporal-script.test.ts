import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  assertRuntimeTemporalSnapshot,
  buildTemporalSnapshot,
  discoverLocalSourceRoutes,
  extractTemporalModel,
  parseTomlSubset,
  refreshTemporalSnapshot,
  resolveCurrentSourceRevision,
  resolveRevisionGeneratedAt,
  TEMPORAL_COMMITS_ATOM_URL,
  TEMPORAL_REVISION,
  TEMPORAL_REVISION_GENERATED_AT,
  temporalArchiveUrl,
  temporalSnapshotProvenance,
  temporalSourceUrl,
} from "../scripts/refresh-modelsdev-temporal.mjs";
import {
  evaluateTemporalCondition,
  getTemporalPolicy,
  normalizeTemporalSnapshot,
  resolveTemporalRates,
} from "../src/lib/modelsdev-temporal.js";
import { isolatedGitEnv, stubIsolatedGitEnv } from "./helpers/isolated-git-env.js";

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.write("        ", 148);
  header.write("0", 156);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  return header;
}

function makeTarGz(entries: { name: string; text: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.text, "utf8");
    blocks.push(tarHeader(entry.name, data.length), data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function makeTempSourceDir(): string {
  return mkdtempSync(join(tmpdir(), "modelsdev-temporal-source-"));
}

/**
 * Fixture git must never inherit hook-exported GIT_* variables (GIT_DIR, GIT_INDEX_FILE, ...),
 * or `git init`/`commit` silently target the hook's repository instead of the temp fixture.
 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: isolatedGitEnv(),
  }).trim();
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

const BUNDLED_SNAPSHOT = JSON.parse(
  readFileSync(new URL("../src/data/modelsdev-temporal.min.json", import.meta.url), "utf8"),
);

const SAMPLE_TOML = `
# Leading comment
schema = 2
base_model = "deepseek/deepseek-v4.1-flash-1017"

[cost.text.input]
price = 0.15
cache = { read = 0.003 }

[[cost.text.input.overrides]]
when = { utc_days = { in = ["sat", "sun"] } }
price = 0.15

[[cost.text.input.overrides]]
when = { utc_days = { in = ["mon", "tue", "wed", "thu", "fri"] }, all = [{ utc_hours = { gte = "01:00" } }, { utc_hours = { lt = "04:00" } }] }
price = 0.3
cache = { read = 0.006 }

[cost.text.output]
price = 0.6

[[cost.text.output.overrides]]
when = { any = [{ utc_hours = { gte = "15:00" } }, { utc_hours = { lt = "01:00" } }] }
price = 1.2
reasoning = 1.2

[[cost.multipliers]]
when = { utc_days = { in = ["mon", "tue", "wed", "thu", "fri"] }, not = { holiday = { equals = "CN" } } }
factor = { text = 2 }
`;

function sampleModel() {
  return extractTemporalModel(
    "openrouter",
    "deepseek/deepseek-v4.1-flash-1017",
    "providers/openrouter/models/deepseek/deepseek-v4.1-flash-1017.toml",
    SAMPLE_TOML,
  );
}

describe("refresh-modelsdev-temporal TOML subset parser", () => {
  it("parses tables, array-of-tables, arrays, inline tables and comments", () => {
    const parsed = parseTomlSubset(SAMPLE_TOML);
    expect(parsed.schema).toBe(2);
    expect(parsed.base_model).toBe("deepseek/deepseek-v4.1-flash-1017");
    expect(parsed.cost.text.input.price).toBe(0.15);
    expect(parsed.cost.text.input.cache).toEqual({ read: 0.003 });
    expect(parsed.cost.text.input.overrides).toHaveLength(2);
    expect(parsed.cost.text.input.overrides[0].when).toEqual({
      utc_days: { in: ["sat", "sun"] },
    });
    expect(parsed.cost.text.output.overrides[0].when.any).toHaveLength(2);
    expect(parsed.cost.multipliers[0].factor).toEqual({ text: 2 });
  });

  it("accepts arrays and inline tables that span lines", () => {
    const parsed = parseTomlSubset(`
schema = 2
[[cost.multipliers]]
when = {
  utc_days = { in = [
    "mon",
    "tue",
  ] },
  any = [
    { utc_hours = { gte = "01:00" } },
    { utc_hours = { lt = "04:00" } },
  ],
}
factor = 2
`);
    expect(parsed.cost.multipliers[0].when.utc_days.in).toEqual(["mon", "tue"]);
    expect(parsed.cost.multipliers[0].when.any).toHaveLength(2);
  });

  it("reports the actual unsupported escape sequence", () => {
    expect(() => parseTomlSubset('factor = "\\q"')).toThrow(/Unsupported TOML escape \\q/);
  });
});

describe("refresh-modelsdev-temporal extraction", () => {
  it("keeps exact provider/model route and narrow temporal overrides and multipliers", () => {
    const entry = sampleModel();
    expect(entry).toMatchObject({
      status: "supported",
      source: "providers/openrouter/models/deepseek/deepseek-v4.1-flash-1017.toml",
    });
    if (entry.status !== "supported") throw new Error("fixture must be supported");

    expect(entry.overrides).toHaveLength(3);
    expect(entry.overrides[0]).toMatchObject({
      id: "text.input.overrides[0]",
      field: "input",
      rates: { input: 0.15 },
      when: { type: "utc_days", op: "in", value: ["sat", "sun"] },
    });
    expect(entry.overrides[1]).toMatchObject({
      id: "text.input.overrides[1]",
      field: "input",
      rates: { input: 0.3, cache_read: 0.006 },
    });
    expect(entry.overrides[2]).toMatchObject({
      id: "text.output.overrides[0]",
      field: "output",
      rates: { output: 1.2, reasoning: 1.2 },
    });
    expect(entry.multipliers).toEqual([
      {
        id: "multipliers[0]",
        when: {
          type: "all",
          of: [
            { type: "utc_days", op: "in", value: ["fri", "mon", "thu", "tue", "wed"] },
            { type: "not", of: { type: "holiday", op: "equals", value: "CN" } },
          ],
        },
        factor: { text: 2 },
      },
    ]);
  });

  it("ignores non-temporal overrides instead of inventing a monetary policy", () => {
    const entry = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[cost.text.input]
price = 1
[[cost.text.input.overrides]]
when = { context = { gt = 100_000 } }
price = 2
`,
    );
    expect(entry).toBeNull();
  });

  it("fails closed for standalone date-based monetary temporal rules", () => {
    const entry = extractTemporalModel(
      "opencode-go",
      "gemini-4-argon",
      "providers/opencode-go/models/gemini-4-argon.toml",
      `
schema = 2
[cost.text.input]
price = 2
[[cost.multipliers]]
when = { date = { gte = "2026-12-01" } }
factor = 2
`,
    );
    expect(entry).toMatchObject({ status: "unsupported" });
    expect(entry.reason).toMatch(/date/);

    const nested = extractTemporalModel(
      "opencode-go",
      "gemini-4-argon",
      "providers/opencode-go/models/gemini-4-argon.toml",
      `
schema = 2
[cost.text.input]
price = 2
[[cost.multipliers]]
when = { all = [{ utc_hours = { gte = "14:00" } }, { utc_hours = { lt = "18:00" } }, { date = { gte = "2026-12-01" } }] }
factor = 2
`,
    );
    expect(nested).toMatchObject({ status: "unsupported" });
    expect(nested.reason).toMatch(/date/);
  });

  it("fails closed when a temporal rule mixes in an unsupported condition", () => {
    const entry = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[cost.text.input]
price = 1
[[cost.text.input.overrides]]
when = { context = { gt = 100_000 }, utc_hours = { gte = "14:00" } }
price = 2
`,
    );
    expect(entry).toMatchObject({ status: "unsupported" });
    expect(entry.reason).toMatch(/context/);
  });

  it("fails closed when a nested all under an outer temporal rule is unsupported", () => {
    const entry = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[cost.text.input]
price = 1
[[cost.text.input.overrides]]
when = { utc_hours = { gte = "14:00" }, all = [{ context = { gt = 100_000 } }] }
price = 2
`,
    );
    expect(entry).toMatchObject({ status: "unsupported" });
    expect(entry.reason).toMatch(/context/);

    const emptyNested = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[cost.text.input]
price = 1
[[cost.text.input.overrides]]
when = { utc_hours = { gte = "14:00" }, all = [{}] }
price = 2
`,
    );
    expect(emptyNested).toMatchObject({ status: "unsupported" });
    expect(emptyNested.reason).toMatch(/no temporal condition/);
  });

  it("fails closed for unsupported operators and factor shapes", () => {
    const operator = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[[cost.multipliers]]
when = { utc_hours = { min_items = 1 } }
factor = 2
`,
    );
    expect(operator).toMatchObject({ status: "unsupported" });

    const factor = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[[cost.multipliers]]
when = { utc_hours = { gte = "14:00" } }
factor = { audio = 2 }
`,
    );
    expect(factor).toMatchObject({ status: "unsupported" });
  });

  it("fails closed when a temporal model also has non-temporal monetary rules", () => {
    const entry = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[cost.text.input]
price = 1
[[cost.text.input.overrides]]
when = { context = { gt = 100_000 } }
price = 2
[[cost.multipliers]]
when = { utc_hours = { gte = "14:00" } }
factor = 0.5
`,
    );
    expect(entry).toMatchObject({ status: "unsupported" });
    expect(entry.reason).toMatch(/non-temporal/);
  });

  it("fails closed for unsupported override effect fields", () => {
    const entry = extractTemporalModel(
      "openai",
      "gpt-5.5",
      "providers/openai/models/gpt-5.5.toml",
      `
schema = 2
[[cost.text.input.overrides]]
when = { utc_hours = { gte = "14:00" } }
price = 1
unit = "token"
`,
    );
    expect(entry).toMatchObject({ status: "unsupported" });
    expect(entry.reason).toMatch(/unit/);
  });
});

describe("refresh-modelsdev-temporal deterministic snapshot build", () => {
  const files = [
    {
      provider: "deepseek",
      path: "providers/deepseek/models/deepseek-v4-pro.toml",
      text: `
schema = 2
[cost.text.input]
price = 0.66
[cost.text.output]
price = 1.98
[[cost.multipliers]]
when = { utc_days = { in = ["mon", "tue", "wed", "thu", "fri"] }, not = { holiday = { equals = "CN" } } }
factor = 2
`,
    },
    {
      provider: "alibaba",
      path: "providers/alibaba/models/deepseek-v4.1-flash.toml",
      text: `
schema = 2
[cost.text.input]
price = 1.2
[cost.text.output]
price = 6
[[cost.multipliers]]
when = { utc_hours = { gte = "14:00" } }
factor = { text = 0.5 }
`,
    },
  ];

  const BUILD_REVISION = "9".repeat(40);
  const BUILD_OPTIONS = {
    revision: BUILD_REVISION,
    generatedAt: 1_700_000_000_000,
  };

  it("is order-independent, derives source metadata, and passes full runtime validation", async () => {
    const first = await buildTemporalSnapshot(files, BUILD_OPTIONS);
    const second = await buildTemporalSnapshot([...files].reverse(), BUILD_OPTIONS);
    expect(second).toEqual(first);
    expect(first.revision).toBe(BUILD_REVISION);
    expect(first.source).toBe(temporalSourceUrl(BUILD_REVISION));
    expect(first.generatedAt).toBe(BUILD_OPTIONS.generatedAt);
    expect(Object.keys(first.providers)).toEqual(["alibaba", "deepseek"]);
    expect(first.providers.alibaba["deepseek-v4.1-flash"].source).toBe(
      "providers/alibaba/models/deepseek-v4.1-flash.toml",
    );
    expect(() => normalizeTemporalSnapshot(first)).not.toThrow();
  });

  it("derives source from a new revision and requires matching generatedAt", async () => {
    const revision = "a".repeat(40);
    const built = await buildTemporalSnapshot(files, {
      revision,
      generatedAt: 1_700_000_000_000,
    });
    expect(built.revision).toBe(revision);
    expect(built.source).toBe(temporalSourceUrl(revision));
    expect(() => normalizeTemporalSnapshot(built)).not.toThrow();
    await expect(buildTemporalSnapshot(files, { revision })).rejects.toThrow(/generatedAt/);
  });

  it("rejects duplicate routes, provider/path mismatches, and bad revision", async () => {
    await expect(buildTemporalSnapshot([files[0], files[0]], BUILD_OPTIONS)).rejects.toThrow(
      /duplicate/i,
    );
    await expect(
      buildTemporalSnapshot([{ ...files[0], provider: "openai" }], BUILD_OPTIONS),
    ).rejects.toThrow(/provider/i);
    await expect(buildTemporalSnapshot(files, { revision: "deadbeef" })).rejects.toThrow(
      /revision/i,
    );
  });

  it("rejects a candidate that the full runtime schema rejects", async () => {
    const built = await buildTemporalSnapshot(files, BUILD_OPTIONS);
    const invalid = structuredClone(built);
    invalid.providers.alibaba["deepseek-v4.1-flash"].unexpected = true;
    await expect(assertRuntimeTemporalSnapshot(invalid)).rejects.toThrow(/runtime schema/i);
  });
});

describe("refresh-modelsdev-temporal discovery", () => {
  it("discovers nested provider model TOMLs from a local source tree", async () => {
    const dir = makeTempSourceDir();
    try {
      mkdirSync(join(dir, "providers", "zeta", "models", "nested"), { recursive: true });
      mkdirSync(join(dir, "providers", "alpha", "models"), { recursive: true });
      writeFileSync(
        join(dir, "providers", "zeta", "models", "nested", "model.toml"),
        "schema = 2\n",
      );
      writeFileSync(join(dir, "providers", "alpha", "models", "a.toml"), "schema = 2\n");
      writeFileSync(join(dir, "providers", "alpha", "models", "notes.txt"), "ignored\n");
      writeFileSync(join(dir, "providers", "alpha", "readme.toml"), "schema = 2\n");
      expect(await discoverLocalSourceRoutes(dir)).toEqual([
        "providers/alpha/models/a.toml",
        "providers/zeta/models/nested/model.toml",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves the current revision and commit timestamp from the commits feed", async () => {
    const revision = "b".repeat(40);
    const atom = `<?xml version="1.0"?>
<feed>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/${revision}</id>
    <updated>2026-10-30T17:21:44Z</updated>
  </entry>
  <entry>
    <id>tag:github.com,2008:Grit::Commit/${"e".repeat(40)}</id>
    <updated>2026-10-29T00:00:00Z</updated>
  </entry>
</feed>`;
    const fetchImpl = async (url: string) => {
      expect(url).toBe(TEMPORAL_COMMITS_ATOM_URL);
      return new Response(atom, { status: 200 });
    };
    expect(await resolveCurrentSourceRevision(fetchImpl)).toEqual({
      revision,
      generatedAt: Date.parse("2026-10-30T17:21:44Z"),
    });
  });

  it("resolves a pinned revision timestamp from its commit patch", async () => {
    const revision = "e".repeat(40);
    const patch = `From ${revision} Mon Sep 17 00:00:00 2001
Date: Fri, 30 Oct 2026 16:24:42 +0000
Subject: [PATCH] test
`;
    const fetchImpl = async (url: string) => {
      expect(url).toBe(`https://github.com/anomalyco/models.dev/commit/${revision}.patch`);
      return new Response(patch, { status: 200 });
    };
    expect(await resolveRevisionGeneratedAt(revision, fetchImpl)).toBe(
      Date.parse("2026-10-30T16:24:42Z"),
    );
  });

  it("fetches the current source archive and discovers newly added routes", async () => {
    const revision = "c".repeat(40);
    const generatedAt = Date.parse("2026-10-30T17:21:44Z");
    const atom = `<feed><entry><id>tag:github.com,2008:Grit::Commit/${revision}</id><updated>${new Date(generatedAt).toISOString()}</updated></entry></feed>`;
    const tarball = makeTarGz([
      {
        name: `models.dev-${revision}/providers/newco/models/new-model.toml`,
        text: `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { equals = "14:00" } }
factor = 2
`,
      },
      {
        name: `models.dev-${revision}/providers/newco/models/non-temporal.toml`,
        text: `
schema = 2
[cost.text.input]
price = 1
[[cost.text.input.overrides]]
when = { context = { gt = 100_000 } }
price = 2
`,
      },
    ]);
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      if (url === TEMPORAL_COMMITS_ATOM_URL) return new Response(atom, { status: 200 });
      if (url === temporalArchiveUrl(revision)) return new Response(tarball, { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    };

    const snapshot = await refreshTemporalSnapshot({ fetchImpl });
    expect(calls).toEqual([TEMPORAL_COMMITS_ATOM_URL, temporalArchiveUrl(revision)]);
    expect(snapshot.revision).toBe(revision);
    expect(snapshot.source).toBe(temporalSourceUrl(revision));
    expect(snapshot.generatedAt).toBe(generatedAt);
    expect(Object.keys(snapshot.providers)).toEqual(["newco"]);
    expect(Object.keys(snapshot.providers.newco)).toEqual(["new-model"]);
    expect(snapshot.providers.newco["new-model"].source).toBe(
      "providers/newco/models/new-model.toml",
    );
    expect(() => normalizeTemporalSnapshot(snapshot)).not.toThrow();
  });

  it("requires explicit provenance for a non-git source directory", async () => {
    const dir = makeTempSourceDir();
    try {
      mkdirSync(join(dir, "providers", "localco", "models"), { recursive: true });
      writeFileSync(
        join(dir, "providers", "localco", "models", "local.toml"),
        `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { gte = "14:00" } }
factor = 2
`,
      );
      const revision = "d".repeat(40);
      await expect(refreshTemporalSnapshot({ sourceDir: dir })).rejects.toThrow(
        /revision|provenance/,
      );
      await expect(refreshTemporalSnapshot({ sourceDir: dir, revision })).rejects.toThrow(
        /generatedAt/,
      );
      const snapshot = await refreshTemporalSnapshot({
        sourceDir: dir,
        revision,
        generatedAt: 1_700_000_000_000,
      });
      expect(snapshot.revision).toBe(revision);
      expect(snapshot.source).toBe(temporalSourceUrl(revision));
      expect(snapshot.generatedAt).toBe(1_700_000_000_000);
      expect(snapshot.providers.localco.local.source).toBe("providers/localco/models/local.toml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives and verifies provenance from a git source checkout", async () => {
    const dir = makeTempSourceDir();
    try {
      mkdirSync(join(dir, "providers", "gitco", "models"), { recursive: true });
      writeFileSync(
        join(dir, "providers", "gitco", "models", "git.toml"),
        `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { lt = "04:00" } }
factor = 2
`,
      );
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "temporal-test@example.com"]);
      git(dir, ["config", "user.name", "Temporal Test"]);
      git(dir, ["config", "commit.gpgsign", "false"]);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-m", "fixture"]);
      const head = git(dir, ["rev-parse", "HEAD"]);
      const seconds = Number.parseInt(git(dir, ["show", "-s", "--format=%ct", "HEAD"]), 10);
      // refreshTemporalSnapshot spawns git with the inherited process.env.
      stubIsolatedGitEnv();
      const snapshot = await refreshTemporalSnapshot({ sourceDir: dir });
      expect(snapshot.revision).toBe(head);
      expect(snapshot.source).toBe(temporalSourceUrl(head));
      expect(snapshot.generatedAt).toBe(seconds * 1000);
      await expect(
        refreshTemporalSnapshot({ sourceDir: dir, revision: "a".repeat(40) }),
      ).rejects.toThrow(/does not match/);
      writeFileSync(join(dir, "providers", "gitco", "models", "git.toml"), "schema = 2\n# dirty\n");
      await expect(refreshTemporalSnapshot({ sourceDir: dir })).rejects.toThrow(
        /uncommitted|dirty/,
      );
    } finally {
      // stubIsolatedGitEnv() captured the inherited GIT_* values through vi.stubEnv();
      // unstub restores them, including when an assertion throws.
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("builds from a pinned offline archive and verifies the archive revision", async () => {
    const revision = "f".repeat(40);
    const generatedAt = 1_700_000_000_000;
    const archive = makeTarGz([
      {
        name: `models.dev-${revision}/providers/archiveco/models/archive.toml`,
        text: `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { lt = "04:00" } }
factor = 2
`,
      },
    ]);
    const dir = makeTempSourceDir();
    try {
      const archivePath = join(dir, "source.tar.gz");
      writeFileSync(archivePath, archive);
      const snapshot = await refreshTemporalSnapshot({
        archivePath,
        revision,
        generatedAt,
      });
      expect(snapshot.revision).toBe(revision);
      expect(snapshot.source).toBe(temporalSourceUrl(revision));
      expect(snapshot.generatedAt).toBe(generatedAt);
      expect(snapshot.providers.archiveco.archive.source).toBe(
        "providers/archiveco/models/archive.toml",
      );
      await expect(
        refreshTemporalSnapshot({
          archivePath,
          revision: "a".repeat(40),
          generatedAt,
        }),
      ).rejects.toThrow(/does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerates the pinned snapshot offline from its archive without network access", async () => {
    const archive = makeTarGz([
      {
        name: `models.dev-${TEMPORAL_REVISION}/providers/pinnedco/models/pinned.toml`,
        text: `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { lt = "04:00" } }
factor = 2
`,
      },
    ]);
    const dir = makeTempSourceDir();
    try {
      const archivePath = join(dir, "pinned.tar.gz");
      writeFileSync(archivePath, archive);
      const snapshot = await refreshTemporalSnapshot({ archivePath });
      expect(snapshot.revision).toBe(TEMPORAL_REVISION);
      expect(snapshot.source).toBe(temporalSourceUrl(TEMPORAL_REVISION));
      expect(snapshot.generatedAt).toBe(TEMPORAL_REVISION_GENERATED_AT);
      expect(snapshot.providers.pinnedco.pinned.source).toBe(
        "providers/pinnedco/models/pinned.toml",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an offline archive whose revision has no pinned timestamp", async () => {
    const revision = "a".repeat(40);
    const archive = makeTarGz([
      {
        name: `models.dev-${revision}/providers/unpinnedco/models/unpinned.toml`,
        text: `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { lt = "04:00" } }
factor = 2
`,
      },
    ]);
    const dir = makeTempSourceDir();
    try {
      const archivePath = join(dir, "unpinned.tar.gz");
      writeFileSync(archivePath, archive);
      await expect(refreshTemporalSnapshot({ archivePath })).rejects.toThrow(/generatedAt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refresh-modelsdev-temporal git fixture isolation", () => {
  it("keeps temp-repo git away from the repository named by inherited GIT_* variables", async () => {
    const root = mkdtempSync(join(tmpdir(), "modelsdev-temporal-git-isolation-"));
    const hostileRepo = join(root, "hostile-repo");
    const sourceDir = join(root, "source");
    try {
      // The hostile variables below point only at this disposable repository. If isolation
      // regresses, the fixture is damaged or misread, never the real product checkout.
      mkdirSync(hostileRepo);
      git(hostileRepo, ["init", "-q"]);
      git(hostileRepo, [
        "-c",
        "user.name=Hostile Repo",
        "-c",
        "user.email=hostile@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-qm",
        "hostile head",
      ]);
      const hostileBefore = headAndIndex(hostileRepo);

      // A git hook (lefthook pre-push) exports these for every git process it spawns.
      const hostileGitDir = join(hostileRepo, ".git");
      vi.stubEnv("GIT_DIR", hostileGitDir);
      vi.stubEnv("GIT_WORK_TREE", hostileRepo);
      vi.stubEnv("GIT_INDEX_FILE", join(hostileGitDir, "index"));
      vi.stubEnv("GIT_COMMON_DIR", hostileGitDir);
      vi.stubEnv("GIT_OBJECT_DIRECTORY", join(hostileGitDir, "objects"));
      vi.stubEnv("GIT_NAMESPACE", "hostile-hook");
      expect(process.env.GIT_DIR).toBe(hostileGitDir);

      // Fixture setup runs while the hostile variables are active. The helper env keeps
      // init/config/add/commit inside sourceDir instead of the hook's repository.
      mkdirSync(join(sourceDir, "providers", "isolatedco", "models"), { recursive: true });
      writeFileSync(
        join(sourceDir, "providers", "isolatedco", "models", "isolated.toml"),
        `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { lt = "04:00" } }
factor = 2
`,
      );
      git(sourceDir, ["init", "-q"]);
      git(sourceDir, ["config", "user.email", "temporal-test@example.invalid"]);
      git(sourceDir, ["config", "user.name", "Temporal Test"]);
      git(sourceDir, ["config", "commit.gpgsign", "false"]);
      git(sourceDir, ["add", "."]);
      git(sourceDir, ["commit", "-qm", "fixture"]);
      expect(realpathSync.native(git(sourceDir, ["rev-parse", "--show-toplevel"]))).toBe(
        realpathSync.native(sourceDir),
      );
      const sourceBefore = headAndIndex(sourceDir);
      const sourceSeconds = Number.parseInt(
        git(sourceDir, ["show", "-s", "--format=%ct", "HEAD"]),
        10,
      );

      // refreshTemporalSnapshot spawns git with the inherited process.env, so the operation
      // under test needs the same isolation the fixture commands receive.
      stubIsolatedGitEnv();
      const snapshot = await refreshTemporalSnapshot({ sourceDir });
      expect(snapshot.revision).toBe(sourceBefore.head);
      expect(snapshot.source).toBe(temporalSourceUrl(sourceBefore.head));
      expect(snapshot.generatedAt).toBe(sourceSeconds * 1000);

      // Neither repository was rewritten: source kept its commit and index, hostile stayed put.
      expect(headAndIndex(sourceDir)).toEqual(sourceBefore);
      expect(headAndIndex(hostileRepo)).toEqual(hostileBefore);
      expect(git(hostileRepo, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
      expect(git(hostileRepo, ["ls-files"])).toBe("");
      expect(git(hostileRepo, ["config", "--local", "--list"])).not.toContain("user.");
    } finally {
      // Restore the inherited GIT_* values captured by both vi.stubEnv() and
      // stubIsolatedGitEnv(), even when an assertion fails mid-test.
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("refresh-modelsdev-temporal isolated latest refresh", () => {
  it("derives pinned constants from the rewritten bundle in a fresh process", () => {
    const repo = mkdtempSync(join(tmpdir(), "modelsdev-temporal-repo-"));
    const realBundlePath = new URL("../src/data/modelsdev-temporal.min.json", import.meta.url);
    const realBundleBefore = readFileSync(realBundlePath, "utf8");
    const initialRevision = "1".repeat(40);
    const refreshedRevision = "7".repeat(40);
    const initialGeneratedAt = 1_700_000_000_000;
    const refreshedGeneratedAt = Date.parse("2026-10-31T12:00:00Z");
    try {
      mkdirSync(join(repo, "scripts"), { recursive: true });
      mkdirSync(join(repo, "src", "data"), { recursive: true });
      mkdirSync(join(repo, "src", "lib"), { recursive: true });
      writeFileSync(join(repo, "package.json"), `${JSON.stringify({ type: "module" })}\n`);

      const tempScriptPath = join(repo, "scripts", "refresh-modelsdev-temporal.mjs");
      writeFileSync(
        tempScriptPath,
        readFileSync(new URL("../scripts/refresh-modelsdev-temporal.mjs", import.meta.url)),
      );
      writeFileSync(
        join(repo, "src", "lib", "modelsdev-temporal.ts"),
        readFileSync(new URL("../src/lib/modelsdev-temporal.ts", import.meta.url)),
      );

      const tempBundlePath = join(repo, "src", "data", "modelsdev-temporal.min.json");
      writeFileSync(
        tempBundlePath,
        `${JSON.stringify(
          {
            version: 1,
            revision: initialRevision,
            source: temporalSourceUrl(initialRevision),
            generatedAt: initialGeneratedAt,
            jurisdictions: {},
            providers: {},
          },
          null,
          2,
        )}\n`,
      );

      const archivePath = join(repo, "fixture.tar.gz");
      writeFileSync(
        archivePath,
        makeTarGz([
          {
            name: `models.dev-${refreshedRevision}/providers/fixtureco/models/fixture-model.toml`,
            text: `
schema = 2
[cost.text.input]
price = 1
[[cost.multipliers]]
when = { utc_hours = { lt = "04:00" } }
factor = 2
`,
          },
        ]),
      );

      const scriptUrl = pathToFileURL(tempScriptPath).href;
      const atom = `<feed><entry><id>tag:github.com,2008:Grit::Commit/${refreshedRevision}</id><updated>${new Date(refreshedGeneratedAt).toISOString()}</updated></entry></feed>`;
      const refreshCode = `
import { readFileSync, writeFileSync } from "node:fs";
import {
  refreshTemporalSnapshot,
  TEMPORAL_COMMITS_ATOM_URL,
  temporalArchiveUrl,
} from ${JSON.stringify(scriptUrl)};
const archive = readFileSync(${JSON.stringify(archivePath)});
const revision = ${JSON.stringify(refreshedRevision)};
const fetchImpl = async (url) => {
  if (url === TEMPORAL_COMMITS_ATOM_URL) {
    return new Response(${JSON.stringify(atom)}, { status: 200 });
  }
  if (url === temporalArchiveUrl(revision)) return new Response(archive, { status: 200 });
  throw new Error("unexpected fetch " + url);
};
const snapshot = await refreshTemporalSnapshot({ fetchImpl });
writeFileSync(${JSON.stringify(tempBundlePath)}, JSON.stringify(snapshot, null, 2) + "\\n");
process.stdout.write(JSON.stringify({
  revision: snapshot.revision,
  generatedAt: snapshot.generatedAt,
  source: snapshot.source,
}));
`;

      const refreshed = JSON.parse(
        execFileSync(
          process.execPath,
          ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", refreshCode],
          { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 },
        ),
      );
      expect(refreshed).toEqual({
        revision: refreshedRevision,
        generatedAt: refreshedGeneratedAt,
        source: temporalSourceUrl(refreshedRevision),
      });

      const reloadCode = `
import {
  TEMPORAL_REVISION,
  TEMPORAL_REVISION_GENERATED_AT,
  TEMPORAL_SOURCE,
} from ${JSON.stringify(scriptUrl)};
process.stdout.write(JSON.stringify({
  revision: TEMPORAL_REVISION,
  generatedAt: TEMPORAL_REVISION_GENERATED_AT,
  source: TEMPORAL_SOURCE,
}));
`;
      const reloaded = JSON.parse(
        execFileSync(
          process.execPath,
          ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", reloadCode],
          { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 },
        ),
      );
      expect(reloaded).toEqual(refreshed);
      expect(reloaded).not.toEqual({
        revision: initialRevision,
        generatedAt: initialGeneratedAt,
        source: temporalSourceUrl(initialRevision),
      });
      expect(readFileSync(realBundlePath, "utf8")).toBe(realBundleBefore);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("bundled modelsdev temporal data", () => {
  const snapshot = normalizeTemporalSnapshot(BUNDLED_SNAPSHOT);

  it("derives the pinned constants from the bundled snapshot provenance", () => {
    expect(BUNDLED_SNAPSHOT.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(BUNDLED_SNAPSHOT.source).toBe(temporalSourceUrl(BUNDLED_SNAPSHOT.revision));
    expect(TEMPORAL_REVISION).toBe(BUNDLED_SNAPSHOT.revision);
    expect(TEMPORAL_REVISION_GENERATED_AT).toBe(BUNDLED_SNAPSHOT.generatedAt);
    expect(temporalSnapshotProvenance(BUNDLED_SNAPSHOT)).toEqual({
      revision: BUNDLED_SNAPSHOT.revision,
      source: temporalSourceUrl(BUNDLED_SNAPSHOT.revision),
      generatedAt: BUNDLED_SNAPSHOT.generatedAt,
    });
  });

  it("rejects provenance whose source or timestamp does not match its revision", () => {
    const revision = "a".repeat(40);
    const valid = {
      version: 1,
      revision,
      source: temporalSourceUrl(revision),
      generatedAt: 1_700_000_000_000,
    };
    expect(temporalSnapshotProvenance(valid)).toEqual({
      revision,
      source: temporalSourceUrl(revision),
      generatedAt: valid.generatedAt,
    });
    expect(() =>
      temporalSnapshotProvenance({ ...valid, source: temporalSourceUrl("b".repeat(40)) }),
    ).toThrow(/source/);
    expect(() => temporalSnapshotProvenance({ ...valid, revision: "deadbeef" })).toThrow(
      /revision/,
    );
    expect(() => temporalSnapshotProvenance({ ...valid, generatedAt: 0 })).toThrow(/generatedAt/);
  });

  it("retains only authoritative CN 2026", () => {
    expect(Object.keys(snapshot.jurisdictions)).toEqual(["CN"]);
    expect(Object.keys(snapshot.jurisdictions.CN)).toEqual(["2026"]);
    expect(snapshot.jurisdictions.CN["2026"].intervals).toHaveLength(7);
    expect(snapshot.jurisdictions.CN["2026"].makeupWorkdays).toEqual([
      "2026-01-04",
      "2026-02-14",
      "2026-02-28",
      "2026-05-09",
      "2026-09-20",
      "2026-10-10",
    ]);
  });

  it("retains route provenance for every bundled temporal entry", () => {
    let modelCount = 0;
    for (const [providerId, models] of Object.entries(snapshot.providers)) {
      for (const [modelId, entry] of Object.entries(models)) {
        modelCount += 1;
        expect(entry.source).toBe(`providers/${providerId}/models/${modelId}.toml`);
        expect(["supported", "unsupported"]).toContain(entry.status);
      }
    }
    expect(modelCount).toBeGreaterThan(0);
  });

  it("exposes runtime lookups from the bundled data", () => {
    expect(getTemporalPolicy("deepseek", "deepseek-v4-pro")).toMatchObject({
      status: "supported",
    });
    expect(getTemporalPolicy("openrouter", "deepseek/deepseek-v4.1-flash-1017")).toMatchObject({
      status: "supported",
    });
    expect(getTemporalPolicy("opencode-go", "gemini-4-argon")).toMatchObject({
      status: "unsupported",
    });
    expect(getTemporalPolicy("deepseek", "deepseek-v4-pro/does-not-exist")).toBeNull();
    expect(
      resolveTemporalRates(
        "opencode-go",
        "gemini-4-argon",
        Date.parse("2026-12-02T00:00:00.000Z"),
        { input: 2, output: 10 },
      ),
    ).toMatchObject({ status: "unsupported", rates: null });
  });

  it("evaluates bundled DeepSeek and Alibaba rules at exact boundaries", () => {
    const deepSeekBase = { input: 0.66, output: 1.98, cache_read: 0.022 };
    expect(
      resolveTemporalRates(
        "deepseek",
        "deepseek-v4-pro",
        Date.parse("2026-01-05T02:00:00.000Z"),
        deepSeekBase,
      ).rates,
    ).toEqual({ input: 1.32, output: 3.96, cache_read: 0.044 });
    expect(
      resolveTemporalRates(
        "deepseek",
        "deepseek-v4-pro",
        Date.parse("2026-10-01T02:00:00.000Z"),
        deepSeekBase,
      ).rates,
    ).toEqual(deepSeekBase);
    expect(
      resolveTemporalRates(
        "deepseek",
        "deepseek-v4-pro",
        Date.parse("2027-01-04T02:00:00.000Z"),
        deepSeekBase,
      ).status,
    ).toBe("unresolved");

    const alibabaBase = { input: 1.272, output: 3.816 };
    expect(
      resolveTemporalRates(
        "alibaba",
        "deepseek-v4.1-flash",
        Date.parse("2026-01-05T13:59:59.999Z"),
        alibabaBase,
      ).rates,
    ).toEqual(alibabaBase);
    expect(
      resolveTemporalRates(
        "alibaba",
        "deepseek-v4.1-flash",
        Date.parse("2026-01-05T14:00:00.000Z"),
        alibabaBase,
      ).rates,
    ).toEqual({ input: 0.636, output: 1.908 });
    expect(
      resolveTemporalRates(
        "alibaba",
        "deepseek-v4.1-flash",
        Date.parse("2026-01-06T00:00:00.000Z"),
        alibabaBase,
      ).rates,
    ).toEqual(alibabaBase);

    expect(
      evaluateTemporalCondition(
        { type: "holiday", op: "equals", value: "CN" },
        Date.parse("2026-10-01T02:00:00.000Z"),
      ).value,
    ).toBe(true);
  });
});
