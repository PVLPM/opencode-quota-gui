import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { QUOTA_PLUGIN_SPEC_ENV } from "../src/lib/init-installer.js";
import {
  applyScopedUpdatePlan,
  formatScopedUpdatePreview,
  isCanonicalQuotaUpdateSpec,
  LEGACY_QUOTA_PACKAGE_NAME,
  planScopedUpdate,
  QUOTA_LATEST_SPEC,
  QUOTA_PACKAGE_NAME,
  QUOTA_V4_SPEC,
  runScopedUpdateCommand,
} from "../src/lib/scoped-update.js";

interface OpenCodeMajorRef {
  value: 1 | 2 | undefined;
}

// Commands must not run a real `opencode` binary; undefined matches plans built without a version.
const openCodeMajor = vi.hoisted((): OpenCodeMajorRef => ({ value: undefined }));
vi.mock("../src/lib/opencode-version.js", () => ({
  detectOpenCodeMajor: async () => openCodeMajor.value,
}));

const LOCAL_PACK_SPEC = "file:./opencode-quota-gui-5.0.0.tgz";

const tempDirs: string[] = [];
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-gui-update-"));
  tempDirs.push(path);
  return path;
}
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function fixture() {
  const root = tempDir();
  const project = join(root, "project");
  const cache = join(root, "cache", "opencode");
  mkdirSync(join(project, ".git"), { recursive: true });
  return {
    root,
    project,
    cache,
    env: {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    } satisfies NodeJS.ProcessEnv,
  };
}
function planParams(f: ReturnType<typeof fixture>) {
  return { cwd: f.project, env: f.env, homeDir: join(f.root, "home"), platform: "linux" as const };
}
function cliParams(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv) {
  return { ...planParams(f), env, log: vi.fn() };
}

afterEach(() => {
  openCodeMajor.value = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("GUI update identity safety", () => {
  it("does not replace or remove a nonexistent archive merely because its filename matches", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.jsonc");
    const old = "file:./definitely-absent/opencode-quota-gui-1.2.3.tgz";
    const original = `${JSON.stringify({ plugins: [old, LOCAL_PACK_SPEC] })}\n`;
    write(config, original);
    const plan = await planScopedUpdate({
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
    });
    expect(plan.configEdits).toEqual([]);
    await applyScopedUpdatePlan(plan);
    expect(readFileSync(config, "utf8")).toBe(original);
  });
  it("explicit desired spec replaces moving npm specs and verified local dist, leaving lookalikes alone", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.jsonc");
    write(join(f.project, "checkout", "package.json"), '{"name":"opencode-quota-gui"}');
    write(
      config,
      JSON.stringify({
        plugins: [
          "opencode-quota-gui@latest",
          "./checkout/dist/index.js",
          "some-quota-helper",
          "./other-quota/dist/index.js",
        ],
      }),
    );
    const plan = await planScopedUpdate({
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
    });
    expect(plan.configEdits).toHaveLength(1);
    const preview = formatScopedUpdatePreview(plan).join("\n");
    expect(preview).toContain('"opencode-quota-gui@latest" ->');
    expect(preview).toContain(LOCAL_PACK_SPEC);
    await applyScopedUpdatePlan(plan);
    expect(JSON.parse(readFileSync(config, "utf8")).plugins).toEqual([
      LOCAL_PACK_SPEC,
      "some-quota-helper",
      "./other-quota/dist/index.js",
    ]);
    const second = await planScopedUpdate({
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
    });
    expect(second.configEdits).toEqual([]);
  });
  it("refuses explicit replacement when quota entries have conflicting options without writing", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.jsonc");
    const original = JSON.stringify({
      plugins: [
        { package: "opencode-quota-gui@latest", options: { one: true } },
        { package: LOCAL_PACK_SPEC, options: { two: true } },
      ],
    });
    write(config, original);
    await expect(
      planScopedUpdate({
        ...planParams(f),
        env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
      }),
    ).rejects.toThrow("different options");
    expect(readFileSync(config, "utf8")).toBe(original);
  });
  it("deduplicates identical option-bearing entries across both plugin arrays", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.jsonc");
    write(
      config,
      JSON.stringify({
        plugin: [{ package: "opencode-quota-gui@latest", options: { keep: true } }],
        plugins: ["before", { package: LOCAL_PACK_SPEC, options: { keep: true } }, "after"],
      }),
    );
    const plan = await planScopedUpdate({
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
    });
    await applyScopedUpdatePlan(plan);
    const result = JSON.parse(readFileSync(config, "utf8"));
    expect(result.plugin).toEqual([]);
    expect(result.plugins).toEqual([
      "before",
      { package: LOCAL_PACK_SPEC, options: { keep: true } },
      "after",
    ]);
  });
  it("uses the independent package identity and still recognizes legacy specs", () => {
    expect(QUOTA_PACKAGE_NAME).toBe("opencode-quota-gui");
    expect(LEGACY_QUOTA_PACKAGE_NAME).toBe("@slkiser/opencode-quota");
    expect(QUOTA_LATEST_SPEC).toBe("opencode-quota-gui@latest");
    expect(QUOTA_V4_SPEC).toBe("@slkiser/opencode-quota@4");

    for (const spec of [
      QUOTA_PACKAGE_NAME,
      QUOTA_LATEST_SPEC,
      "opencode-quota-gui@next",
      "opencode-quota-gui@5.0.0",
      LEGACY_QUOTA_PACKAGE_NAME,
      "@slkiser/opencode-quota@latest",
      "@slkiser/opencode-quota@next",
      QUOTA_V4_SPEC,
      "@slkiser/opencode-quota@3.11.1",
      "@slkiser/opencode-quota@3.11.2-beta.1+build.2",
    ]) {
      expect(isCanonicalQuotaUpdateSpec(spec), spec).toBe(true);
    }
    for (const spec of [
      "opencode-quota-gui@beta",
      "opencode-quota-gui@5",
      "opencode-quota-gui@^5.0.0",
      "@slkiser/opencode-quota@beta",
      "@slkiser/opencode-quota@^3.11.1",
      "file:../opencode-quota",
      "npm:@slkiser/opencode-quota@3.11.1",
      "workspace:*",
    ]) {
      expect(isCanonicalQuotaUpdateSpec(spec), spec).toBe(false);
    }
  });

  it.each([
    ["@slkiser/opencode-quota"],
    ["@slkiser/opencode-quota@3.11.1"],
    ["opencode-quota-gui"],
    ["opencode-quota-gui@5.0.0"],
  ])("migrates %s to the canonical package spec without an explicit pack", async (spec) => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["${spec}"]}`);

    const plan = await planScopedUpdate(planParams(f));

    expect(plan.configEdits).toHaveLength(1);
    expect(plan.configEdits[0]?.updated).toBe(`{"plugin":["${QUOTA_LATEST_SPEC}"]}`);
    expect(readFileSync(config, "utf8")).toBe(`{"plugin":["${spec}"]}`);

    await applyScopedUpdatePlan(plan);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ plugin: [QUOTA_LATEST_SPEC] });
  });

  it.each([
    { entry: "@slkiser/opencode-quota@3.11.1", expected: LOCAL_PACK_SPEC },
    {
      entry: { package: "opencode-quota-gui@5.0.0", options: { keep: true } },
      expected: { package: LOCAL_PACK_SPEC, options: { keep: true } },
    },
  ])("rewrites recognized non-moving specs to the explicit package spec, never upstream ($entry)", async ({
    entry,
    expected,
  }) => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, JSON.stringify({ plugins: [entry, "other-plugin"] }));

    const plan = await planScopedUpdate({
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
    });
    expect(plan.configEdits).toHaveLength(1);
    const updated = plan.configEdits[0]?.updated ?? "";
    expect(updated).not.toContain(LEGACY_QUOTA_PACKAGE_NAME);
    expect(updated).not.toContain(`${QUOTA_PACKAGE_NAME}@5.0.0`);

    await applyScopedUpdatePlan(plan);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      plugins: [expected, "other-plugin"],
    });
  });

  it("recognizes an upstream explicit spec as a refusal, not a target", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`;
    write(config, original);

    const error = await planScopedUpdate({
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: "@slkiser/opencode-quota@latest" },
    }).catch((reason: Error) => reason);

    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected an Error");
    expect(error.message).toMatch(/upstream @slkiser\/opencode-quota/i);
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("keeps both identities' moving specs as written and refreshes their verified caches", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@latest","opencode-quota-gui@latest","other-plugin"]}`;
    write(config, original);
    const legacyCache = join(f.cache, "packages", "@slkiser", "opencode-quota@latest");
    const independentCache = join(f.cache, "packages", "opencode-quota-gui@latest");
    write(
      join(legacyCache, "node_modules", "@slkiser", "opencode-quota", "package.json"),
      `{"name":"@slkiser/opencode-quota"}`,
    );
    write(
      join(independentCache, "node_modules", "opencode-quota-gui", "package.json"),
      `{"name":"opencode-quota-gui"}`,
    );

    const plan = await planScopedUpdate(planParams(f));
    expect(plan.configEdits).toEqual([]);
    expect(plan.foundSpecs).toEqual(
      expect.arrayContaining(["@slkiser/opencode-quota@latest", "opencode-quota-gui@latest"]),
    );
    expect(plan.cacheCandidates).toEqual(expect.arrayContaining([legacyCache, independentCache]));

    const result = await applyScopedUpdatePlan(plan);
    expect(result.removedCachePaths).toEqual(
      expect.arrayContaining([legacyCache, independentCache]),
    );
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("skips an unverified independent cache directory instead of deleting it", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@latest","other-plugin"]}`);
    const tamperedCache = join(f.cache, "packages", "opencode-quota-gui@latest");
    write(
      join(tamperedCache, "node_modules", "opencode-quota-gui", "package.json"),
      `{"name":"not-the-package"}`,
    );

    const result = await applyScopedUpdatePlan(await planScopedUpdate(planParams(f)));
    expect(result.removedCachePaths).toEqual([]);
    expect(result.skippedCachePaths).toEqual(expect.arrayContaining([tamperedCache]));
  });

  it("previews with --dry-run and migrates with --yes without writing an upstream spec", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@3.11.1"]}`;
    write(config, original);

    const dryRunParams = cliParams(f, f.env);
    expect(await runScopedUpdateCommand({ ...dryRunParams, argv: ["--dry-run"] })).toBe(0);
    const dryRunOutput = dryRunParams.log.mock.calls.flat().join("\n");
    expect(dryRunOutput).toContain("Responsible update preview complete");
    expect(readFileSync(config, "utf8")).toBe(original);

    const yesParams = cliParams(f, f.env);
    expect(await runScopedUpdateCommand({ ...yesParams, argv: ["--yes"] })).toBe(0);
    const yesOutput = yesParams.log.mock.calls.flat().join("\n");
    expect(yesOutput).toContain("OpenCode Quota update complete.");
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({ plugin: [QUOTA_LATEST_SPEC] });
  });

  it("applies an explicit-spec migration through update --yes without adding upstream specs", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["@slkiser/opencode-quota@3.11.1"],"unrelated":{"keep":true}}`);
    const params = {
      ...planParams(f),
      env: { ...f.env, [QUOTA_PLUGIN_SPEC_ENV]: LOCAL_PACK_SPEC },
    };
    const log = vi.fn();

    expect(await runScopedUpdateCommand({ ...params, argv: ["--yes"], log })).toBe(0);

    const updated = readFileSync(config, "utf8");
    expect(JSON.parse(updated)).toEqual({
      plugin: [LOCAL_PACK_SPEC],
      unrelated: { keep: true },
    });
    expect(updated).not.toContain(LEGACY_QUOTA_PACKAGE_NAME);
  });

  it("on OpenCode 1 refuses to pin plugin specs to the upstream package", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["@slkiser/opencode-quota@5.0.0"]}`;
    write(config, original);

    const error = await planScopedUpdate({ ...planParams(f), openCodeMajor: 1 }).catch(
      (reason: Error) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("expected an Error");
    expect(error.message).toMatch(/OpenCode 1/i);
    expect(error.message).toMatch(/upstream @slkiser\/opencode-quota/i);
    expect(error.message).not.toMatch(/npx @slkiser/);
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("on OpenCode 1 keeps recognized moving specs as written", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["${QUOTA_V4_SPEC}","@slkiser/opencode-quota@latest"]}`;
    write(config, original);

    const plan = await planScopedUpdate({ ...planParams(f), openCodeMajor: 1 });
    expect(plan.configEdits).toEqual([]);
    expect(readFileSync(config, "utf8")).toBe(original);
  });
});
