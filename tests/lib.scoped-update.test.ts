import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseJsonOrJsonc } from "../src/lib/jsonc.js";
import {
  applyScopedUpdatePlan,
  formatScopedUpdatePreview,
  isCanonicalQuotaUpdateSpec,
  planScopedUpdate,
  QUOTA_LATEST_SPEC,
  runScopedUpdateCommand,
  sanitizeOpenCodePackageSpec,
} from "../src/lib/scoped-update.js";

import { symlinkOrSkip } from "./helpers/symlink-capability.js";

// Commands must not run a real `opencode` binary; undefined matches plans built without a version.
const openCodeMajor = vi.hoisted(() => ({ value: undefined as 1 | 2 | undefined }));
vi.mock("../src/lib/opencode-version.js", () => ({
  detectOpenCodeMajor: async () => openCodeMajor.value,
}));

const tempDirs: string[] = [];
function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "opencode-quota-update-"));
  tempDirs.push(path);
  return path;
}
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function hasControlCharacter(text: string): boolean {
  return Array.from(text).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159);
  });
}
function fixture() {
  const root = tempDir();
  const project = join(root, "project");
  const global = join(root, "config", "opencode");
  const cache = join(root, "cache", "opencode");
  mkdirSync(join(project, ".git"), { recursive: true });
  return {
    root,
    project,
    global,
    cache,
    env: {
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    } satisfies NodeJS.ProcessEnv,
  };
}

afterEach(() => {
  openCodeMajor.value = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

// These tests pin the explicit spec override; without one, update uses the canonical release tag.
const EXPLICIT_UPDATE_SPEC = "file:./opencode-quota-gui-5.0.0.tgz";
function withUpdateSpec(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, OPENCODE_QUOTA_PLUGIN_SPEC: EXPLICIT_UPDATE_SPEC };
}

describe("scoped update specs and paths", () => {
  it("accepts only this package's bare, latest, next, and exact SemVer specs", () => {
    for (const spec of [
      "opencode-quota-gui",
      "opencode-quota-gui@latest",
      "opencode-quota-gui@next",
      "opencode-quota-gui@5.0.0",
      "opencode-quota-gui@5.0.0-beta.1+build.2",
    ])
      expect(isCanonicalQuotaUpdateSpec(spec)).toBe(true);
    for (const spec of [
      "@slkiser/opencode-quota",
      "@slkiser/opencode-quota@latest",
      "@slkiser/opencode-quota@next",
      "@slkiser/opencode-quota@4",
      "@slkiser/opencode-quota@3.11.1",
      "opencode-quota-gui@beta",
      "opencode-quota-gui@5",
      "opencode-quota-gui@^5.0.0",
      "opencode-quota-gui@~5.0.0",
      "npm:opencode-quota-gui@3.11.1",
      "file:../opencode-quota",
      "workspace:*",
      "https://example.test/opencode-quota.tgz",
    ])
      expect(isCanonicalQuotaUpdateSpec(spec)).toBe(false);
  });

  it("matches OpenCode Windows sanitization without changing slashes", () => {
    expect(sanitizeOpenCodePackageSpec("@scope/pkg@1.0.0", "linux")).toBe("@scope/pkg@1.0.0");
    expect(sanitizeOpenCodePackageSpec("@scope/pkg@file:C:\\pkg?x", "win32")).toBe(
      "@scope/pkg@file_C_\\pkg_x",
    );
  });

  it.each([
    ["linux", "/home/u/.config", "/home/u/.cache"],
    ["darwin", "/Users/u/Library/Application Support", "/Users/u/Library/Caches"],
    ["win32", "C:/Users/u/AppData/Roaming", "C:/Users/u/AppData/Local"],
  ] as const)("uses primary %s runtime roots", async (platform, configBase, cacheBase) => {
    const root = tempDir();
    const project = join(root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    const env: NodeJS.ProcessEnv = {
      XDG_CONFIG_HOME: configBase,
      XDG_CACHE_HOME: cacheBase,
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    };
    const plan = await planScopedUpdate({
      cwd: project,
      env,
      homeDir: join(root, "home"),
      platform,
    });
    expect(plan.configPaths).toEqual([]);
    expect(plan.cacheCandidates.some((path) => path.startsWith(join(cacheBase, "opencode")))).toBe(
      true,
    );
  });
});

describe("scoped update config planning", () => {
  it.each([
    { entry: "opencode-quota-gui@3.11.1", expected: EXPLICIT_UPDATE_SPEC },
    {
      entry: ["opencode-quota-gui", { setting: true }],
      expected: [EXPLICIT_UPDATE_SPEC, { setting: true }],
    },
    { entry: "opencode-quota-gui@next", expected: EXPLICIT_UPDATE_SPEC },
  ])("prefers JSONC, preserves comments/format/options, and leaves custom specs untouched ($entry)", async ({
    entry,
    expected,
  }) => {
    const f = fixture();
    const jsonc = join(f.project, "opencode.jsonc");
    const ignoredJson = join(f.project, "opencode.json");
    const original = `{\n  // keep this comment\n  "plugin": [\n    ${JSON.stringify(entry)},\n    "other-plugin",\n  ],\n  "unrelated": { "keep": true },\n}\n`;
    write(jsonc, original);
    write(ignoredJson, `{"plugin":["opencode-quota-gui@1.0.0"]}`);
    const plan = await planScopedUpdate({
      cwd: join(f.project, "nested"),
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
      platform: "linux",
    });
    expect(plan.configPaths).toEqual([jsonc]);
    const updated = plan.configEdits[0]!.updated;
    expect(updated).toContain("// keep this comment");
    expect(parseJsonOrJsonc(updated, true).plugin).toEqual([expected, "other-plugin"]);

    expect(updated).toContain('"other-plugin"');
    expect(updated).toContain('"unrelated": { "keep": true }');
    expect(readFileSync(ignoredJson, "utf8")).toContain("@1.0.0");
  });

  it.each([
    { entry: "opencode-quota-gui@3.11.1", expected: EXPLICIT_UPDATE_SPEC },
    {
      entry: { package: "opencode-quota-gui@3.11.1", options: { setting: true } },
      expected: { package: EXPLICIT_UPDATE_SPEC, options: { setting: true } },
    },
    {
      entry: { package: "opencode-quota-gui@next" },
      expected: { package: EXPLICIT_UPDATE_SPEC },
    },
  ])("updates OpenCode 2 native plugins entries and keeps their options ($entry)", async ({
    entry,
    expected,
  }) => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, JSON.stringify({ plugins: [entry, "other"] }));
    const params = { cwd: f.project, env: withUpdateSpec(f.env), homeDir: join(f.root, "home") };
    const plan = await planScopedUpdate(params);
    expect(plan.foundSpecs).toEqual([typeof entry === "string" ? entry : entry.package]);
    await applyScopedUpdatePlan(plan);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      plugins: [expected, "other"],
    });
  });

  it.each([
    "opencode-quota-gui@next",
  ])("keeps %s as written and refreshes its package cache", async (spec) => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["${spec}"]}`;
    write(config, original);
    const cache = join(f.cache, "packages", ...spec.split("/"));
    const manifest = join(cache, "node_modules", "opencode-quota-gui", "package.json");
    write(manifest, `{"name":"opencode-quota-gui"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });
    expect(plan.configEdits).toEqual([]);
    expect(plan.foundSpecs).toEqual([spec]);
    expect(plan.authoritativeLatest).toBe(true);

    const result = await applyScopedUpdatePlan(plan);
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(result.writtenPaths).toEqual([]);
    expect(result.removedCachePaths).toEqual([cache]);
  });

  it("leaves tui.json files untouched", async () => {
    const f = fixture();
    const projectTui = join(f.project, "tui.json");
    const globalTui = join(f.global, "tui.jsonc");
    const original = `{"plugin":["opencode-quota-gui@3.11.1"]}`;
    write(projectTui, original);
    write(globalTui, original);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
    });
    expect(plan.configPaths).toEqual([]);
    expect(plan.configEdits).toEqual([]);
    expect(readFileSync(projectTui, "utf8")).toBe(original);
    expect(readFileSync(globalTui, "utf8")).toBe(original);
  });

  it("honors OPENCODE_CONFIG_DIR and deduplicates project/global real paths", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.jsonc");
    write(config, `{"plugin":["opencode-quota-gui@latest"]}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: { ...f.env, OPENCODE_CONFIG_DIR: f.project },
      homeDir: join(f.root, "home"),
    });
    expect(plan.configPaths).toEqual([config]);
  });

  it("aborts planning before writes when any selected config is unparseable", async () => {
    const f = fixture();
    const valid = join(f.project, "opencode.json");
    write(valid, `{"plugin":["opencode-quota-gui@latest"]}`);
    write(join(f.global, "opencode.jsonc"), `{ nope`);
    await expect(
      planScopedUpdate({ cwd: f.project, env: f.env, homeDir: join(f.root, "home") }),
    ).rejects.toThrow("unparseable");
    expect(readFileSync(valid, "utf8")).toContain("@latest");
  });

  it("is idempotent after applying its targeted edits", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@3.11.1","other"]}`);
    const params = { cwd: f.project, env: withUpdateSpec(f.env), homeDir: join(f.root, "home") };
    await applyScopedUpdatePlan(await planScopedUpdate(params));
    expect((await planScopedUpdate(params)).configEdits).toEqual([]);
    expect(readFileSync(config, "utf8")).toBe(`{"plugin":["${EXPLICIT_UPDATE_SPEC}","other"]}`);
  });

  it("uses injected runtime roots and the enclosing Git worktree, not ambient env", async () => {
    const f = fixture();
    const injectedRoot = join(f.root, "injected-config");
    const ambientRoot = join(f.root, "ambient-config");
    const injectedConfig = join(injectedRoot, "opencode.json");
    const ambientConfig = join(ambientRoot, "opencode.json");
    write(injectedConfig, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    write(ambientConfig, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    vi.stubEnv("OPENCODE_CONFIG_DIR", ambientRoot);

    const plan = await planScopedUpdate({
      cwd: join(f.project, "nested", "deeper"),
      env: { ...withUpdateSpec(f.env), OPENCODE_CONFIG_DIR: injectedRoot },
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.configPaths).toEqual([injectedConfig]);
    expect(plan.configSnapshots.map((snapshot) => snapshot.path)).toEqual([injectedConfig]);
    expect(plan.configSnapshots.some((snapshot) => snapshot.path === ambientConfig)).toBe(false);
  });

  it("attaches presence-only credential findings without secret values", async () => {
    const f = fixture();
    const obsoleteFile = join(f.global, "opencode-quota", "opencode-go.json");
    write(obsoleteFile, `{"authCookie":"file-secret-canary"}`);

    const plan = await planScopedUpdate({
      cwd: f.project,
      env: {
        ...f.env,
        OPENCODE_GO_AUTH_COOKIE: "go-secret-canary",
        OPENCODE_WORKSPACE_ID: "zen-secret-canary",
      },
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    expect(plan.manualFindings).toEqual(
      expect.arrayContaining([
        { kind: "obsolete-go-env", name: "OPENCODE_GO_AUTH_COOKIE" },
        { kind: "obsolete-go-file", path: obsoleteFile },
        { kind: "ambiguous-zen-env", names: ["OPENCODE_WORKSPACE_ID"] },
      ]),
    );
    expect(JSON.stringify(plan.manualFindings)).not.toContain("secret-canary");
  });

  it("redacts every credential and parser canary from public planner and CLI surfaces", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const malformedSidecar = join(f.project, "opencode-quota", "quota-toast.jsonc");
    const obsoleteGoFile = join(f.global, "opencode-quota", "opencode-go.json");
    const obsoleteZenFile = join(f.global, "opencode-quota", "opencode.json");
    const authFile = join(f.global, "auth.json");
    const canaries = [
      "go-workspace-value-canary",
      "go-cookie-value-canary",
      "zen-workspace-value-canary",
      "zen-cookie-value-canary",
      "legacy-go-file-content-canary",
      "obsolete-zen-file-content-canary",
      "provider-api-key-canary",
      "auth-json-key-canary",
      "invalid-display-value-canary",
      "migration-parser-content-canary",
    ];
    write(
      config,
      `{"plugin":["opencode-quota-gui@3.11.1"],"provider":{"opencode-go":{"options":{"apiKey":"provider-api-key-canary"}}},"experimental":{"quotaToast":{"opencodeZenDisplay":"invalid-display-value-canary"}}}`,
    );
    write(malformedSidecar, `{"opencodeZenDisplay":"migration-parser-content-canary",`);
    write(obsoleteGoFile, `{"authCookie":"legacy-go-file-content-canary"}`);
    write(
      obsoleteZenFile,
      `{"workspaceId":"obsolete-zen-file-content-canary","consoleSessionCookie":"obsolete-zen-file-content-canary"}`,
    );
    write(authFile, `{"opencode-go":{"type":"api","key":"auth-json-key-canary"}}`);
    const env = withUpdateSpec({
      ...f.env,
      OPENCODE_GO_WORKSPACE_ID: "go-workspace-value-canary",
      OPENCODE_GO_AUTH_COOKIE: "go-cookie-value-canary",
      OPENCODE_WORKSPACE_ID: "zen-workspace-value-canary",
      OPENCODE_AUTH_COOKIE: "zen-cookie-value-canary",
    });
    const params = {
      cwd: f.project,
      env,
      homeDir: join(f.root, "home"),
      platform: "linux" as const,
    };

    const plan = await planScopedUpdate(params);
    const preview = formatScopedUpdatePreview(plan);
    const log = vi.fn();
    expect(await runScopedUpdateCommand({ ...params, argv: ["--dry-run"], log })).toBe(0);
    const publicSuccess = JSON.stringify({
      safeActions: plan.safeActions,
      manualFindings: plan.manualFindings,
      preview,
      logs: log.mock.calls,
    });
    for (const canary of canaries) expect(publicSuccess).not.toContain(canary);
    expect(plan.manualFindings).toContainEqual({
      kind: "obsolete-zen-file",
      path: obsoleteZenFile,
    });
    expect(preview.join("\n")).toContain("run opencode auth login opencode");
    expect(preview.join("\n")).not.toContain("opencode-quota-gui status");
    expect(preview.join("\n")).not.toContain("create and protect");

    const failed = fixture();
    write(
      join(failed.project, "opencode.jsonc"),
      `{"provider":{"x":{"apiKey":"raw-parser-error-canary"}}, invalid`,
    );
    const failedParams = {
      cwd: failed.project,
      env: failed.env,
      homeDir: join(failed.root, "home"),
      platform: "linux" as const,
    };
    const planningError = await planScopedUpdate(failedParams).catch((error: unknown) => error);
    expect(String(planningError)).not.toContain("raw-parser-error-canary");
    const errorLog = vi.fn();
    expect(await runScopedUpdateCommand({ ...failedParams, log: errorLog })).toBe(1);
    expect(errorLog.mock.calls.flat().join("\n")).not.toContain("raw-parser-error-canary");
  });
});

describe("scoped update application safety", () => {
  it("rejects a race in an unchanged @latest config before cache deletion", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@latest"]}`);
    const cache = join(f.cache, "packages", "opencode-quota-gui@latest");
    const manifest = join(cache, "node_modules", "opencode-quota-gui", "package.json");
    write(manifest, `{"name":"opencode-quota-gui"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
    });

    write(config, `{"plugin":["other-plugin"]}`);

    await expect(applyScopedUpdatePlan(plan)).rejects.toThrow("changed since preview");
    expect(readFileSync(manifest, "utf8")).toContain("opencode-quota-gui");
  });

  it("revalidates @latest authority immediately before deleting cache", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const cache = join(f.cache, "packages", "opencode-quota-gui@latest");
    const manifest = join(cache, "node_modules", "opencode-quota-gui", "package.json");
    write(manifest, `{"name":"opencode-quota-gui"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
    });

    await expect(
      applyScopedUpdatePlan(plan, {
        beforeCacheDeletion: async () => {
          write(config, `{"plugin":["other-plugin"]}`);
        },
      }),
    ).rejects.toThrow("changed before cache deletion");
    expect(readFileSync(manifest, "utf8")).toContain("opencode-quota-gui");
  });

  it("reports completed writes when pre-cache work fails", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const cache = join(f.cache, "packages", "opencode-quota-gui@latest");
    const manifest = join(cache, "node_modules", "opencode-quota-gui", "package.json");
    write(manifest, `{"name":"opencode-quota-gui"}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
      platform: "linux",
    });

    const error = await applyScopedUpdatePlan(plan, {
      beforeCacheDeletion: async () => {
        throw new Error("hook failed");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ details: { writtenPaths: [config] } });
    expect(String(error)).toContain("Changed before failure");
    expect(readFileSync(config, "utf8")).toContain(EXPLICIT_UPDATE_SPEC);
    expect(readFileSync(manifest, "utf8")).toContain("opencode-quota-gui");
  });

  it("preflights every snapshot before the first write", async () => {
    const f = fixture();
    const first = join(f.project, "opencode.json");
    const second = join(f.global, "opencode.json");
    const original = `{"plugin":["opencode-quota-gui@3.11.1"]}`;
    write(first, original);
    write(second, original);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
      platform: "linux",
    });
    const writeText = vi.fn();
    let reads = 0;

    await expect(
      applyScopedUpdatePlan(plan, {
        readBytes: async (path) => {
          reads++;
          if (reads === 2) return Buffer.from(`${readFileSync(path, "utf8")} `);
          return readFileSync(path);
        },
        writeText,
      }),
    ).rejects.toThrow("changed since preview");

    expect(writeText).not.toHaveBeenCalled();
    expect(readFileSync(first, "utf8")).toBe(original);
    expect(readFileSync(second, "utf8")).toBe(original);
  });

  it.each([
    "read",
    "write",
  ] as const)("reports earlier writes when a later config %s fails", async (failureKind) => {
    const f = fixture();
    const first = join(f.project, "opencode.json");
    const second = join(f.global, "opencode.json");
    write(first, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    write(second, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
    });
    let reads = 0;
    let writes = 0;

    const promise = applyScopedUpdatePlan(plan, {
      readBytes: async (path) => {
        reads++;
        if (failureKind === "read" && reads === 4) throw new Error("read failed");
        return readFileSync(path);
      },
      writeText: async (path, content) => {
        writes++;
        if (failureKind === "write" && writes === 2) throw new Error("write failed");
        write(path, content);
      },
    });

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      details: { writtenPaths: [first] },
    });
    expect(String(error)).toContain("Changed before failure");
    expect(readFileSync(first, "utf8")).toContain(EXPLICIT_UPDATE_SPEC);
    expect(readFileSync(second, "utf8")).toContain("@3.11.1");
  });

  it("detects raw-byte races before writing", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
    });
    write(config, `{"plugin":["opencode-quota-gui@3.11.1"],"raced":true}`);
    await expect(applyScopedUpdatePlan(plan)).rejects.toThrow("changed since preview");
    expect(readFileSync(config, "utf8")).toContain('"raced":true');
  });

  it("removes only manifest-verified derived cache directories", async () => {
    const f = fixture();
    write(
      join(f.project, "opencode.json"),
      `{"plugin":["opencode-quota-gui@latest","opencode-quota-gui@3.11.1","other-plugin"]}`,
    );
    const quotaCache = join(f.cache, "packages", "opencode-quota-gui@3.11.1");
    const latestCache = join(f.cache, "packages", "opencode-quota-gui@latest");
    const otherCache = join(f.cache, "packages", "other-plugin");
    for (const path of [quotaCache, latestCache])
      write(
        join(path, "node_modules", "opencode-quota-gui", "package.json"),
        `{"name":"opencode-quota-gui"}`,
      );
    write(
      join(otherCache, "node_modules", "other-plugin", "package.json"),
      `{"name":"other-plugin"}`,
    );
    const result = await applyScopedUpdatePlan(
      await planScopedUpdate({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
      }),
    );
    expect(result.removedCachePaths).toEqual(expect.arrayContaining([quotaCache, latestCache]));
    expect(() =>
      readFileSync(join(otherCache, "node_modules", "other-plugin", "package.json")),
    ).not.toThrow();
  });

  it("keeps wrong manifests out of cache deletion", async () => {
    const f = fixture();
    write(
      join(f.project, "opencode.json"),
      `{"plugin":["opencode-quota-gui@latest","opencode-quota-gui@3.11.1"]}`,
    );
    const exact = join(f.cache, "packages", "opencode-quota-gui@3.11.1");
    const latest = join(f.cache, "packages", "opencode-quota-gui@latest");
    const manifests = [exact, latest].map((dir) =>
      join(dir, "node_modules", "opencode-quota-gui", "package.json"),
    );
    for (const manifest of manifests) write(manifest, `{"name":"not-the-package"}`);

    const result = await applyScopedUpdatePlan(
      await planScopedUpdate({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
      }),
    );

    expect(result.removedCachePaths).toEqual([]);
    expect(result.skippedCachePaths).toEqual(expect.arrayContaining([exact, latest]));
    for (const manifest of manifests) {
      expect(readFileSync(manifest, "utf8")).toContain("not-the-package");
    }
  });

  it("skips a symlinked cache entry without broadening deletion", async (context) => {
    const f = fixture();
    write(
      join(f.project, "opencode.json"),
      `{"plugin":["opencode-quota-gui@latest","opencode-quota-gui@3.11.1"]}`,
    );
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    const exact = join(f.cache, "packages", "opencode-quota-gui@3.11.1");
    mkdirSync(dirname(exact), { recursive: true });
    if (!symlinkOrSkip(context, outside, exact)) return;
    const latest = join(f.cache, "packages", "opencode-quota-gui@latest");
    write(
      join(latest, "node_modules", "opencode-quota-gui", "package.json"),
      `{"name":"not-the-package"}`,
    );

    const result = await applyScopedUpdatePlan(
      await planScopedUpdate({
        cwd: f.project,
        env: withUpdateSpec(f.env),
        homeDir: join(f.root, "home"),
      }),
    );

    expect(result.removedCachePaths).toEqual([]);
    expect(result.skippedCachePaths).toEqual(expect.arrayContaining([exact, latest]));
    expect(lstatSync(exact).isSymbolicLink()).toBe(true);
    expect(existsSync(outside)).toBe(true);
  });

  it("prints the complete preview before dry-run completion or confirmation", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["opencode-quota-gui@3.11.1"]}`;
    write(config, original);
    const cache = join(f.cache, "packages", "opencode-quota-gui@latest");
    const manifest = join(cache, "node_modules", "opencode-quota-gui", "package.json");
    write(manifest, `{"name":"opencode-quota-gui"}`);
    const base = {
      cwd: f.project,
      env: withUpdateSpec(f.env),
      homeDir: join(f.root, "home"),
      platform: "linux" as const,
    };
    const preview = formatScopedUpdatePreview(await planScopedUpdate(base));
    const log = vi.fn();

    expect(await runScopedUpdateCommand({ ...base, argv: ["--dry-run"], log })).toBe(0);
    expect(log.mock.calls.map(([message]) => message).slice(0, preview.length)).toEqual(preview);
    expect(log).toHaveBeenCalledWith(
      "Responsible update preview complete — no configuration or package-cache changes were made.",
    );
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(readFileSync(manifest, "utf8")).toContain("opencode-quota-gui");

    log.mockClear();
    const confirm = vi.fn(async (message: string) => {
      expect(message).toBe(
        "Apply the safe config changes above and remove only manifest-verified package-cache directories?",
      );
      expect(log.mock.calls.map(([logged]) => logged)).toEqual(preview);
      expect(readFileSync(config, "utf8")).toBe(original);
      expect(readFileSync(manifest, "utf8")).toContain("opencode-quota-gui");
      return false;
    });
    expect(await runScopedUpdateCommand({ ...base, confirm, log })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("OpenCode Quota update cancelled — no files changed.");
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("keeps responsible preview sections ordered and identical for dry-run and --yes", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["opencode-quota-gui@3.11.1"],"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`;
    write(config, original);
    const env = withUpdateSpec({ ...f.env, OPENCODE_GO_AUTH_COOKIE: "preview-secret-canary" });
    const base = {
      cwd: f.project,
      env,
      homeDir: join(f.root, "home"),
      platform: "linux" as const,
    };
    const preview = formatScopedUpdatePreview(await planScopedUpdate(base));
    const safeIndex = preview.indexOf("Safe changes this command can make:");
    const manualIndex = preview.indexOf(
      "Manual actions — this command will not change these sources:",
    );
    const cacheIndex = preview.indexOf(
      "Package-cache candidates (removed only after verification):",
    );
    expect(safeIndex).toBeGreaterThan(0);
    expect(manualIndex).toBeGreaterThan(safeIndex);
    expect(cacheIndex).toBeGreaterThan(manualIndex);
    expect(preview.join("\n")).not.toContain("preview-secret-canary");

    const dryLog = vi.fn();
    expect(await runScopedUpdateCommand({ ...base, argv: ["--dry-run"], log: dryLog })).toBe(0);
    expect(dryLog.mock.calls.map(([message]) => message).slice(0, preview.length)).toEqual(preview);

    let previewLines = 0;
    const yesLog = vi.fn((message: string) => {
      if (previewLines >= preview.length) return;
      expect(message).toBe(preview[previewLines]);
      expect(readFileSync(config, "utf8")).toBe(original);
      previewLines++;
    });
    expect(await runScopedUpdateCommand({ ...base, argv: ["--yes"], log: yesLog })).toBe(0);
    expect(previewLines).toBe(preview.length);
    expect(yesLog.mock.calls.map(([message]) => message).slice(0, preview.length)).toEqual(preview);
    expect(readFileSync(config, "utf8")).toContain(EXPLICIT_UPDATE_SPEC);
    expect(readFileSync(config, "utf8")).toContain('"opencodeZenDisplay":"default"');
    expect(readFileSync(config, "utf8")).not.toContain('"accountingDetail"');
  });

  it("does not prompt when only manual findings exist", async () => {
    const f = fixture();
    const log = vi.fn();
    const confirm = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: { ...f.env, OPENCODE_GO_AUTH_COOKIE: "manual-secret-canary" },
        homeDir: join(f.root, "home"),
        platform: "linux",
        confirm,
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Manual actions — this command will not change these sources:");
    expect(output).not.toContain("Safe changes this command can make:");
    expect(output).not.toContain("Package-cache candidates");
    expect(output).not.toContain("manual-secret-canary");
    expect(output).toContain(
      "No automatic changes are available. Complete the manual actions above, then rerun update.",
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retains the already-current no-op result when the preview has no work or findings", async () => {
    const f = fixture();
    const log = vi.fn();
    const confirm = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        confirm,
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Responsible OpenCode Quota update preview");
    expect(output).not.toContain("Safe changes this command can make:");
    expect(output).not.toContain("Manual actions");
    expect(output).not.toContain("Package-cache candidates");
    expect(output).toContain("OpenCode Quota update is already current. No files changed.");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps --yes credential-blind and leaves secret-bearing sources untouched", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const goFile = join(f.global, "opencode-quota", "opencode-go.json");
    const zenFile = join(f.global, "opencode-quota", "opencode.json");
    const authFile = join(f.global, "auth.json");
    const shellFile = join(f.root, ".zshrc");
    const goFileContent = `{"authCookie":"go-file-secret-canary"}`;
    const zenFileContent = `{"workspaceId":"zen-file-secret-canary"}`;
    const authFileContent = `{"opencode-go":{"key":"auth-file-secret-canary"}}`;
    const shellFileContent = `export OPENCODE_API_KEY="shell-secret-canary"\n`;
    write(
      config,
      `{"plugin":["opencode-quota-gui@3.11.1"],"provider":{"opencode-go":{"options":{"apiKey":"provider-secret-canary"}}},"experimental":{"quotaToast":{"opencodeZenDisplay":"default"}}}`,
    );
    write(goFile, goFileContent);
    write(zenFile, zenFileContent);
    write(authFile, authFileContent);
    write(shellFile, shellFileContent);
    const env = withUpdateSpec({
      ...f.env,
      OPENCODE_GO_AUTH_COOKIE: "go-env-secret-canary",
      OPENCODE_WORKSPACE_ID: "zen-env-secret-canary",
    });
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        argv: ["--yes"],
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    for (const canary of [
      "go-file-secret-canary",
      "zen-file-secret-canary",
      "auth-file-secret-canary",
      "shell-secret-canary",
      "provider-secret-canary",
      "go-env-secret-canary",
      "zen-env-secret-canary",
    ]) {
      expect(output).not.toContain(canary);
    }
    expect(env.OPENCODE_GO_AUTH_COOKIE).toBe("go-env-secret-canary");
    expect(env.OPENCODE_WORKSPACE_ID).toBe("zen-env-secret-canary");
    expect(readFileSync(goFile, "utf8")).toBe(goFileContent);
    expect(readFileSync(zenFile, "utf8")).toBe(zenFileContent);
    expect(readFileSync(authFile, "utf8")).toBe(authFileContent);
    expect(readFileSync(shellFile, "utf8")).toBe(shellFileContent);
    expect(readFileSync(config, "utf8")).toContain("provider-secret-canary");
  });

  it("sanitizes preview, failure, and final-result paths without Windows-invalid names", async () => {
    const root = tempDir();
    // Windows permits C1 controls in filenames; the display sanitizer still removes them.
    const project = join(root, "project \u0085unsafe");
    mkdirSync(join(project, ".git"), { recursive: true });
    const config = join(project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const env = withUpdateSpec({
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_STATE_HOME: join(root, "state"),
    } satisfies NodeJS.ProcessEnv);
    const params = {
      cwd: project,
      env,
      homeDir: join(root, "home"),
      platform: "linux" as const,
    };
    const log = vi.fn();

    expect(await runScopedUpdateCommand({ ...params, argv: ["--yes"], log })).toBe(0);
    for (const message of log.mock.calls.flat()) {
      expect(hasControlCharacter(message)).toBe(false);
    }
    expect(log.mock.calls.flat().join("\n")).toContain("project unsafe");

    write(config, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const plan = await planScopedUpdate(params);
    const unsafePath = `${config}\n\u001b[31munsafe`;
    const unsafePlan = {
      ...plan,
      configPaths: plan.configPaths.map((path) => (path === config ? unsafePath : path)),
      configEdits: plan.configEdits.map((edit) =>
        edit.path === config ? { ...edit, path: unsafePath } : edit,
      ),
      configSnapshots: plan.configSnapshots.map((snapshot) =>
        snapshot.path === config ? { ...snapshot, path: unsafePath } : snapshot,
      ),
      safeActions: plan.safeActions.map((action) =>
        action.path === config ? { ...action, path: unsafePath } : action,
      ),
    };

    const previewLines = formatScopedUpdatePreview(unsafePlan);
    for (const line of previewLines) {
      expect(hasControlCharacter(line)).toBe(false);
    }
    expect(previewLines.join("\n")).toContain("opencode.json unsafe");

    const error = await applyScopedUpdatePlan(unsafePlan, {
      readBytes: async () => {
        throw new Error("simulated read failure");
      },
    }).catch((caught: unknown) => caught);
    expect(hasControlCharacter(String(error))).toBe(false);
    expect(String(error)).toContain("opencode.json unsafe");
  });

  it("keeps accepted update flags and two-code exits unchanged", async () => {
    const f = fixture();
    expect(
      await runScopedUpdateCommand({
        argv: ["--migrate"],
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
      }),
    ).toBe(1);
    expect(
      await runScopedUpdateCommand({
        argv: ["--dry-run", "--yes"],
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        log: vi.fn(),
      }),
    ).toBe(0);
  });

  it("reports successful update paths, restart guidance, and the secondary star request", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@3.11.1"]}`);
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: withUpdateSpec(f.env),
        homeDir: join(f.root, "home"),
        argv: ["--yes"],
        log,
      }),
    ).toBe(0);

    expect(log).toHaveBeenCalledWith("OpenCode Quota update complete.");
    expect(log).toHaveBeenCalledWith(`Configured paths: ${config}`);
    expect(log).toHaveBeenCalledWith("Restart OpenCode and run /quota.");
    expect(log).toHaveBeenCalledWith(
      "If OpenCode Quota helps, please consider a star: https://github.com/PVLPM/opencode-quota-gui",
    );
  });

  it("reports update planning failures as no-write outcomes without asking for a star", async () => {
    const f = fixture();
    write(
      join(f.project, "opencode.jsonc"),
      `{"provider":{"x":{"apiKey":"failure-secret-canary"}}, nope`,
    );
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        log,
      }),
    ).toBe(1);

    expect(log).toHaveBeenCalledWith(expect.stringContaining("OpenCode Quota update failed:"));
    expect(log).toHaveBeenCalledWith("No files changed. Fix the reason above, then rerun update.");
    expect(log.mock.calls.flat().join("\n")).not.toContain("failure-secret-canary");
    expect(log.mock.calls.flat().join("\n")).not.toContain("star");
  });
});

describe("scoped update OpenCode version handling", () => {
  it("on OpenCode 1 keeps moving specs as written and never pins a GUI entry", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["opencode-quota-gui@latest","opencode-quota-gui@next","other"]}`;
    write(config, original);
    const plan = await planScopedUpdate({
      cwd: f.project,
      env: f.env,
      homeDir: join(f.root, "home"),
      platform: "linux",
      openCodeMajor: 1,
    });
    expect(plan.configEdits).toEqual([]);
    expect(plan.cacheCandidates).toContain(join(f.cache, "packages", QUOTA_LATEST_SPEC));
    expect(formatScopedUpdatePreview(plan).join("\n")).toContain(
      "never pins the GUI entry to a release spec.",
    );

    await applyScopedUpdatePlan(plan);
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("update --yes on OpenCode 1 leaves specs as written and prints the version note", async () => {
    openCodeMajor.value = 1;
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["opencode-quota-gui@latest"]}`;
    write(config, original);
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        argv: ["--yes"],
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("You're on OpenCode 1.");
    expect(output).toContain("never pins the GUI entry to a release spec");
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("on OpenCode 2 keeps moving specs and prints no version note", async () => {
    openCodeMajor.value = 2;
    const f = fixture();
    const config = join(f.project, "opencode.json");
    const original = `{"plugin":["${QUOTA_LATEST_SPEC}"]}`;
    write(config, original);
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        argv: ["--dry-run"],
        cwd: f.project,
        env: f.env,
        homeDir: join(f.root, "home"),
        platform: "linux",
        log,
      }),
    ).toBe(0);

    const output = log.mock.calls.flat().join("\n");
    expect(output).not.toContain("OpenCode 1");
    expect(output).not.toContain("Could not detect");
    expect(readFileSync(config, "utf8")).toBe(original);
  });

  it("with an unknown OpenCode version updates as OpenCode 2 and prints a note", async () => {
    const f = fixture();
    const config = join(f.project, "opencode.json");
    write(config, `{"plugin":["opencode-quota-gui@4.10.3"]}`);
    const log = vi.fn();

    expect(
      await runScopedUpdateCommand({
        argv: ["--yes"],
        cwd: f.project,
        env: withUpdateSpec(f.env),
        homeDir: join(f.root, "home"),
        platform: "linux",
        log,
      }),
    ).toBe(0);

    expect(log).toHaveBeenCalledWith(
      "Could not detect your OpenCode version; assuming OpenCode 2 (opencode-quota-gui requires OpenCode 2).",
    );
    expect(readFileSync(config, "utf8")).toBe(`{"plugin":["${EXPLICIT_UPDATE_SPEC}"]}`);
  });
});
