import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface WorkflowStep {
  id?: string;
  name?: string;
  env?: Record<string, string>;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  "runs-on"?: string;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  strategy?: {
    matrix?: Record<string, unknown[]>;
  };
}

interface Workflow {
  on?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
  name?: string;
  version?: string;
  description?: string;
  keywords?: string[];
  homepage?: string;
  bugs?: { url?: string };
  repository?: { type?: string; url?: string };
  main?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { default?: string; types?: string }>;
  "oc-plugin"?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  files?: string[];
  packageManager?: string;
  scripts?: Record<string, string>;
  pnpm?: {
    peerDependencyRules?: unknown;
    strictPeerDependencies?: boolean;
  };
};

const pnpmWorkspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");
const pnpmWorkspaceConfig = parse(pnpmWorkspace) as {
  allowBuilds?: Record<string, boolean>;
};
const tsconfig = JSON.parse(
  await readFile(new URL("../tsconfig.json", import.meta.url), "utf8"),
) as {
  compilerOptions?: { types?: string[] };
};
const typescriptValidator = await readFile(
  new URL("../scripts/verify-typescript-version.mjs", import.meta.url),
  "utf8",
);
const biomeConfig = JSON.parse(
  await readFile(new URL("../biome.json", import.meta.url), "utf8"),
) as {
  $schema?: string;
  linter?: {
    domains?: Record<string, string>;
    rules?: { recommended?: boolean };
  };
  overrides?: Array<{
    includes?: string[];
    linter?: { domains?: Record<string, string> };
  }>;
};
const lefthookConfig = parse(
  await readFile(new URL("../lefthook.yml", import.meta.url), "utf8"),
) as Record<
  "pre-commit" | "pre-push" | "post-checkout",
  {
    commands?: Record<string, { glob?: string; run?: string; stage_fixed?: boolean }>;
  }
>;
const packageScriptSources = await Promise.all(
  [
    "../scripts/pack-release-package.mjs",
    "../scripts/verify-package-contents.mjs",
    "../scripts/verify-release-package.mjs",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
);
const ciWorkflow = parse(
  await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
) as Workflow;
const publishWorkflow = parse(
  await readFile(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8"),
) as Workflow;
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const packedSmoke = await readFile(
  new URL("../scripts/smoke-packed-package.mjs", import.meta.url),
  "utf8",
);
const packedRealOtelFixture = await readFile(
  new URL("../scripts/fixtures/smoke-packed-real-otel.mjs", import.meta.url),
  "utf8",
);

const VERIFY_COMMAND =
  "pnpm run check && pnpm run verify:typescript-version && pnpm run verify:v4-history && pnpm run typecheck && pnpm run build && pnpm test && pnpm run test:four-surfaces && pnpm run verify:package-contents";
const NPM_PUBLISH_GUARD = "${{ vars.NPM_PUBLISH_ENABLED == 'true' && inputs.publish == true }}";
const TAG_REF = "refs/tags/${{ inputs.tag }}";
// Use Git Bash on Windows, not the WSL launcher that can reinterpret native paths.
const bash =
  process.platform === "win32"
    ? join(
        execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(),
        "../../..",
        "bin",
        "bash.exe",
      )
    : "bash";
const VERIFY_COMPONENT_COMMANDS = [
  "pnpm run check",
  "pnpm run verify:typescript-version",
  "pnpm run verify:v4-history",
  "pnpm run typecheck",
  "pnpm run build",
  "pnpm test",
  "pnpm run test:four-surfaces",
  "pnpm run verify:package-contents",
];

function namedStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as WorkflowStep;
}

function stepIndex(job: WorkflowJob, name: string): number {
  return job.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
}

function runLines(job: WorkflowJob): string[] {
  return (
    job.steps?.flatMap((step) =>
      step.run
        ? step.run
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : [],
    ) ?? []
  );
}

function expectCanonicalVerificationOnly(job: WorkflowJob): void {
  const lines = runLines(job);
  expect(lines.filter((line) => line === "pnpm verify")).toEqual(["pnpm verify"]);
  for (const component of VERIFY_COMPONENT_COMMANDS) {
    expect(lines).not.toContain(component);
  }
}

// Minimal 1.x range check: the repository has no direct semver dependency and the
// manifest only needs to prove which minor line a fresh install may resolve.
function allowsVersion(specifier: string, version: string): boolean {
  const range = specifier.match(/^([~^])(\d+)\.(\d+)\.(\d+)$/u);
  const candidate = version.match(/^(\d+)\.(\d+)\.(\d+)$/u);
  if (!range || !candidate) return false;

  const [, operator, major, minor, patch] = range;
  const [, candidateMajor, candidateMinor, candidatePatch] = candidate;
  if (candidateMajor !== major) return false;
  if (operator === "~") {
    return candidateMinor === minor && Number(candidatePatch) >= Number(patch);
  }
  return (
    Number(candidateMinor) > Number(minor) ||
    (candidateMinor === minor && Number(candidatePatch) >= Number(patch))
  );
}

describe("package manifest compatibility", () => {
  it("requires pnpm 11+ development tooling while requiring Node 22+ at runtime", () => {
    const packageManagerMatch = pkg.packageManager?.match(/^pnpm@(\d+)\.\d+\.\d+(?:[+-].*)?$/);

    expect(packageManagerMatch).not.toBeNull();
    expect(Number(packageManagerMatch?.[1])).toBeGreaterThanOrEqual(11);
    expect(pkg.engines?.node).toBe("^22.13.0 || >=23.4.0");
    expect(pkg.devDependencies?.typescript).toBe("7.0.2");
    expect(pkg.devDependencies?.yaml).toBe("^2.8.3");
  });

  it("reflects the local OpenCode V2 plugin dependency override", () => {
    expect(pkg.peerDependencies?.["@opencode/plugin"]).toBe("2.0.16");
    expect(pkg.devDependencies?.["@opencode/plugin"]).toBe("2.0.16");
    expect(pkg.dependencies?.["@opentui/core"]).toBe("^0.5.10");
    expect(pkg.dependencies?.["@opentui/solid"]).toBe("^0.5.10");
    expect(readme).toContain("Node.js `22.13+` or `23.4+`");
    expect(readme).not.toContain("OpenCode `>= 1.4.3`");
    expect(pkg.engines).not.toHaveProperty("opencode");
  });

  it("keeps the TypeScript 7 toolchain explicit without suppressing the known peer mismatch", () => {
    expect(tsconfig.compilerOptions?.types).toEqual(["node"]);
    expect(typescriptValidator).toContain('const EXPECTED_TYPESCRIPT_VERSION = "7.0.2";');
    expect(typescriptValidator).toContain('const EXPECTED_PLUGIN_VERSION = "2.0.16";');
    expect(typescriptValidator).toContain('const EXPECTED_OPENTUI_SPECIFIER = "^0.5.10";');
    expect(typescriptValidator).toContain('const EXPECTED_OPENTUI_VERSION = "0.5.10";');
    expect(typescriptValidator).toContain('const BUN_FFI_STRUCTS_VERSION = "0.3.1";');
    expect(typescriptValidator).toContain('const BUN_FFI_TYPESCRIPT_PEER = "^5";');
    expect(typescriptValidator).toContain("Known unmet peer:");
    expect(typescriptValidator).not.toMatch(/TypeScript v4 freeze|\^5\.9/);
    expect(pkg.pnpm?.peerDependencyRules).toBeUndefined();
    expect(pkg.pnpm?.strictPeerDependencies).not.toBe(false);
    expect(pnpmWorkspace).not.toMatch(
      /peerDependencyRules|allowedVersions|ignoreMissing|strictPeerDependencies:\s*false/,
    );
  });

  it("uses pinned Biome as the sole formatter and linter", async () => {
    expect(pkg.devDependencies?.["@biomejs/biome"]).toBe("2.3.11");
    expect(pkg.devDependencies).not.toHaveProperty("prettier");
    expect(pkg.devDependencies).not.toHaveProperty("eslint");

    expect(pkg.scripts?.format).toBe("biome format --write .");
    expect(pkg.scripts?.["format:check"]).toBe("biome format .");
    expect(pkg.scripts?.lint).toBe("biome lint .");
    expect(pkg.scripts?.check).toBe("biome check .");
    expect(pkg.scripts).not.toHaveProperty("verify:v4-formatting");

    expect(biomeConfig.$schema).toBe("https://biomejs.dev/schemas/2.3.11/schema.json");
    expect(biomeConfig.linter?.rules?.recommended).toBe(true);
    expect(biomeConfig.linter?.domains?.solid).toBe("recommended");
    expect(
      biomeConfig.overrides?.some(
        (override) =>
          override.includes?.includes("tests/**/*.test.ts") &&
          override.linter?.domains?.test === "recommended",
      ),
    ).toBe(true);

    for (const path of [
      "../.prettierignore",
      "../.prettierrc.json",
      "../scripts/verify-v4-formatting.mjs",
    ]) {
      await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
    }
  });

  it("uses Lefthook for staged Biome fixes and canonical pre-push verification", async () => {
    expect(pkg.devDependencies?.lefthook).toBe("2.0.15");
    expect(pkg.devDependencies).not.toHaveProperty("husky");
    expect(pkg.devDependencies).not.toHaveProperty("lint-staged");
    expect(pkg.scripts?.prepare).toBe("lefthook install");

    expect(lefthookConfig["pre-commit"]?.commands).toEqual({
      biome: {
        glob: "**/*.{js,cjs,mjs,jsx,ts,tsx,json,jsonc,css}",
        run: "pnpm exec biome check --write --no-errors-on-unmatched {staged_files}",
        stage_fixed: true,
      },
    });
    expect(lefthookConfig["pre-push"]?.commands).toEqual({
      verify: {
        run: "pnpm verify",
      },
    });
    expect(lefthookConfig["post-checkout"]?.commands).toEqual({
      codegraph: {
        run: "node scripts/init-worktree-codegraph.mjs {1} {2} {3}",
      },
    });

    const packageScripts = packageScriptSources.join("\n");
    expect(packageScripts).not.toContain("HUSKY");
    expect(packageScripts).not.toContain("LEFTHOOK");

    for (const path of ["../.husky", "../.lintstagedrc"]) {
      await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
    }
  });

  it("ships the OpenTelemetry API while keeping the metrics SDK host-owned", () => {
    expect(pkg).not.toHaveProperty("optionalDependencies");
    expect(pkg.dependencies?.["@opentelemetry/api"]).toBe("~1.9.1");
    for (const dependencyType of [pkg.devDependencies, pkg.peerDependencies]) {
      expect(dependencyType).not.toHaveProperty("@opentelemetry/api");
    }
    expect(pkg.peerDependenciesMeta?.["@opentelemetry/api"]).toBeUndefined();

    expect(pkg.devDependencies?.["@opentelemetry/sdk-metrics"]).toBe("2.10.0");
    for (const dependencyType of [pkg.dependencies, pkg.peerDependencies]) {
      expect(dependencyType).not.toHaveProperty("@opentelemetry/sdk-metrics");
    }
  });

  it("keeps the OpenTelemetry API on the host-compatible 1.9 minor for fresh installs", () => {
    const apiRange = pkg.dependencies?.["@opentelemetry/api"];

    expect(allowsVersion(apiRange ?? "", "1.9.1")).toBe(true);
    expect(allowsVersion(apiRange ?? "", "1.9.4")).toBe(true);
    // A 1.10.x package copy rejects a global registered by the 1.9.0 host API,
    // so the published range must exclude it even when the lock resolves 1.9.1.
    expect(allowsVersion(apiRange ?? "", "1.10.0")).toBe(false);
    expect(allowsVersion(apiRange ?? "", "2.0.0")).toBe(false);
    expect(apiRange).toBe("~1.9.1");
  });

  it("hardens pnpm dependency resolution against fresh-package supply-chain attacks", () => {
    expect(pnpmWorkspace).toContain("minimumReleaseAge: 1440");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeStrict: true");
    expect(pnpmWorkspace).toContain("minimumReleaseAgeIgnoreMissingTime: false");
    expect(pnpmWorkspace).toContain("blockExoticSubdeps: true");
    expect(pnpmWorkspaceConfig.allowBuilds).toEqual({
      esbuild: true,
      lefthook: true,
      "msgpackr-extract": true,
      protobufjs: false,
    });
  });

  it("defines one ordered canonical repository gate and a release-only compatibility check", () => {
    expect(pkg.scripts?.build).toBe("node scripts/build-identity.mjs");
    expect(pkg.scripts?.verify).toBe(VERIFY_COMMAND);
    expect(pkg.scripts?.verify).not.toContain("lint:oxlint");
    expect(pkg.scripts?.verify).not.toContain("knip");
    expect(pkg.scripts?.verify).not.toContain("verify:release-version");
    expect(pkg.scripts?.verify).not.toContain("verify:release-package");
    expect(pkg.scripts?.["release:check"]).toBe("pnpm verify && pnpm run verify:release-version");
    expect(pkg.scripts?.prepublishOnly).toBe("pnpm run release:check");
    for (const script of ["verify", "release:check", "prepublishOnly", "build"]) {
      expect(pkg.scripts?.[script]).not.toMatch(/npm publish|pnpm publish/u);
    }
  });

  it("appends the browser UI build and covers both TypeScript projects", async () => {
    // Identity is captured once; the runner retains the backend order and appends Vite.
    // gui.build-identity.test.ts additionally executes this order with synthetic tools.
    expect(pkg.scripts?.build).toBe("node scripts/build-identity.mjs");
    const runner = await readFile(
      new URL("../scripts/build-identity.mjs", import.meta.url),
      "utf8",
    );
    const steps = [
      "const identity = resolveBuildIdentity(root, env)",
      'run("scripts/clean-dist.mjs")',
      'run("node_modules/typescript/bin/tsc")',
      "writeBuildIdentity(root, identity)",
      'run("scripts/copy-data.mjs")',
      'run("scripts/prepare-tui-dist.mjs")',
      'run("node_modules/vite/bin/vite.js", "build", "--config", "vite.ui.config.mjs")',
    ];
    let previous = -1;
    for (const step of steps) {
      const position = runner.indexOf(step, previous + 1);
      expect(position, `build step must follow its predecessor: ${step}`).toBeGreaterThan(previous);
      previous = position;
    }
    expect(pkg.scripts?.["build:ui"]).toBe("vite build --config vite.ui.config.mjs");
    expect(pkg.scripts?.["verify:ui-bundle"]).toBe("node scripts/verify-ui-bundle.mjs");
    // Typecheck runs the backend project and the browser-only UI project.
    expect(pkg.scripts?.typecheck).toBe("tsc --noEmit && tsc -p tsconfig.ui.json");
  });

  it("renames the package identity while preserving upstream attribution", async () => {
    expect(pkg.name).toBe("opencode-quota-gui");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/PVLPM/opencode-quota-gui.git",
    });
    expect(pkg.bugs).toEqual({ url: "https://github.com/PVLPM/opencode-quota-gui/issues" });
    expect(pkg.homepage).toBe("https://github.com/PVLPM/opencode-quota-gui#readme");
    expect(pkg.description).toContain("opencode-quota-gui");

    // The bin, RPC, and plugin ids carry the renamed package identity.
    expect(pkg.bin).toEqual({ "opencode-quota-gui": "./dist/bin/opencode-quota-gui.js" });
    const [rpcSource, pluginSource] = await Promise.all([
      readFile(new URL("../src/rpc.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/plugin.ts", import.meta.url), "utf8"),
    ]);
    expect(rpcSource).toContain('"opencode-quota-gui"');
    expect(pluginSource).toContain('"opencode-quota-gui.server"');

    // README yields the renamed identity and the explicit local-pack install rule.
    expect(readme).toContain("opencode-quota-gui");
    expect(readme).toContain("OPENCODE_QUOTA_PLUGIN_SPEC");
    // Upstream attribution stays.
    expect(readme).toContain("https://github.com/slkiser/opencode-quota");
  });

  it("ships only the server/dashboard and init bin entrypoints for OpenCode", () => {
    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.bin).toEqual({
      "opencode-quota-gui": "./dist/bin/opencode-quota-gui.js",
    });
    expect(pkg["oc-plugin"]).toBeUndefined();
    expect(pkg.dependencies?.["@clack/prompts"]).toBeTruthy();
    expect(pkg.exports?.["."]).toEqual({
      default: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports?.["./server"]).toEqual({
      default: "./dist/index.js",
      types: "./dist/index.d.ts",
    });
    expect(pkg.exports).not.toHaveProperty("./tui");
  });

  it("describes a GUI-only product and advertises no terminal surfaces", () => {
    expect(pkg.description).toContain("opencode-quota-gui");
    expect(pkg.description?.toLowerCase()).toContain("dashboard");
    expect(pkg.description).not.toMatch(/independent|continuation/i);
    expect(pkg.keywords).toEqual(expect.arrayContaining(["opencode", "quota", "gui", "dashboard"]));
    expect(pkg.keywords).not.toContain("toast");
    for (const keyword of ["tui", "terminal", "sidebar", "statusline"]) {
      expect(pkg.keywords).not.toContain(keyword);
    }
  });

  it("packs no TUI artifact and rejects the removed public TUI subpath", async () => {
    const pnpmCli = [
      process.env.npm_execpath,
      join(dirname(process.execPath), "node_modules", "pnpm", "bin", "pnpm.cjs"),
      process.env.APPDATA
        ? join(process.env.APPDATA, "npm", "node_modules", "pnpm", "bin", "pnpm.cjs")
        : undefined,
    ].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
    expect(pnpmCli, "the pnpm CLI must be resolvable for the pack check").toBeDefined();
    const raw = execFileSync(
      process.execPath,
      [pnpmCli as string, "--config.ignore-scripts=true", "pack", "--json", "--dry-run"],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const manifest = JSON.parse(raw.slice(raw.indexOf("{"))) as {
      files: Array<{ path: string }>;
    };
    const packedPaths = manifest.files.map(({ path }) => path);

    expect(packedPaths).toContain("dist/index.js");
    expect(packedPaths).not.toContain("dist/tui.js");
    expect(packedPaths).not.toContain("dist/tui.d.ts");
    expect(packedPaths).not.toContain("dist/tui.d.ts.map");
    expect(packedPaths.some((path) => /^dist\/tui(?:-|\.)/u.test(path))).toBe(false);

    const subpathProbe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import("opencode-quota-gui/tui").then(() => console.log("resolved"), (error) => console.log(error.code));',
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
      },
    );
    expect(subpathProbe.stderr).toBe("");
    expect(subpathProbe.stdout.trim()).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  it("keeps the legacy MiniMax result types in generated public declarations", async () => {
    const [indexDeclarations, typesDeclarations] = await Promise.all([
      readFile(new URL("../dist/index.d.ts", import.meta.url), "utf8"),
      readFile(new URL("../dist/lib/types.d.ts", import.meta.url), "utf8"),
    ]);

    expect(indexDeclarations).toMatch(/MiniMaxResult[\s\S]*MiniMaxResultEntry/u);
    expect(typesDeclarations).toContain("export interface MiniMaxResultEntry {");
    expect(typesDeclarations).toContain('window: "five_hour" | "weekly";');
    expect(typesDeclarations).toContain("export type MiniMaxResult = {");
    expect(typesDeclarations).toContain("entries: MiniMaxResultEntry[];");
  });

  it("does not leave stale Crof generated artifacts in active dist", async () => {
    const staleCrofDistPaths = [
      "../dist/lib/crof-config.d.ts",
      "../dist/lib/crof-config.d.ts.map",
      "../dist/lib/crof-config.js",
      "../dist/lib/crof-config.js.map",
      "../dist/lib/crof.d.ts",
      "../dist/lib/crof.d.ts.map",
      "../dist/lib/crof.js",
      "../dist/lib/crof.js.map",
      "../dist/providers/crof.d.ts",
      "../dist/providers/crof.d.ts.map",
      "../dist/providers/crof.js",
      "../dist/providers/crof.js.map",
    ];

    await Promise.all(
      staleCrofDistPaths.map(async (path) => {
        await expect(access(new URL(path, import.meta.url))).rejects.toThrow();
      }),
    );
  });

  it("runs canonical verification once on Ubuntu, only Windows-specific tests on Windows, and reuses the artifact for smoke", () => {
    expect(Object.keys(ciWorkflow.jobs).sort()).toEqual([
      "pnpm-quality",
      "runtime-smoke",
      "windows-platform",
    ]);

    const quality = ciWorkflow.jobs["pnpm-quality"];
    const checkout = quality.steps?.find((step) => step.uses === "actions/checkout@v6");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(
      quality.steps?.find((step) => step.uses === "actions/setup-node@v6")?.with?.["node-version"],
    ).toBe("24.x");

    for (const [name, run] of [
      ["Install dependencies", "pnpm install --frozen-lockfile"],
      ["Run canonical verification", "pnpm verify"],
      ["Pack and audit exact npm artifact once", "pnpm run pack:release-package package-artifacts"],
    ]) {
      expect(namedStep(quality, name).run).toBe(run);
    }

    expectCanonicalVerificationOnly(quality);
    expect(stepIndex(quality, "Run canonical verification")).toBeGreaterThan(
      stepIndex(quality, "Install dependencies"),
    );
    expect(stepIndex(quality, "Pack and audit exact npm artifact once")).toBeGreaterThan(
      stepIndex(quality, "Run canonical verification"),
    );
    expect(
      quality.steps?.filter((step) => step.run?.includes("pnpm run pack:release-package")),
    ).toHaveLength(1);

    const windows = ciWorkflow.jobs["windows-platform"];
    expect(windows["runs-on"]).toBe("windows-latest");
    expect(
      windows.steps?.find((step) => step.uses === "actions/checkout@v6")?.with?.["fetch-depth"],
    ).toBe(0);
    expect(
      windows.steps?.find((step) => step.uses === "actions/setup-node@v6")?.with?.["node-version"],
    ).toBe("24.x");
    expect(namedStep(windows, "Install dependencies").run).toBe("pnpm install --frozen-lockfile");
    expect(namedStep(windows, "Windows platform-specific tests").run).toBe(
      "pnpm run test:windows-platform",
    );
    // The Windows lane adds platform-specific signal only; the canonical gate
    // runs exactly once, on Ubuntu.
    const windowsRunLines = runLines(windows);
    expect(windowsRunLines).not.toContain("pnpm verify");
    for (const component of VERIFY_COMPONENT_COMMANDS) {
      expect(windowsRunLines).not.toContain(component);
    }

    expect(namedStep(quality, "Upload exact npm artifact")).toEqual(
      expect.objectContaining({
        uses: "actions/upload-artifact@v7",
        with: expect.objectContaining({
          name: "package-tarball",
          path: "package-artifacts/*",
          "if-no-files-found": "error",
        }),
      }),
    );

    const smoke = ciWorkflow.jobs["runtime-smoke"];
    expect(smoke.needs).toBe("pnpm-quality");
    // One runner smokes the single uploaded artifact on both supported Node lines.
    expect(smoke.strategy).toBeUndefined();
    expect(
      smoke.steps
        ?.filter((step) => step.uses === "actions/setup-node@v6")
        .map((step) => step.with?.["node-version"]),
    ).toEqual(["22.x", "24.x"]);
    expect(namedStep(smoke, "Download exact npm artifact").with).toEqual({
      name: "package-tarball",
      path: "package-artifacts",
    });
    for (const version of ["22.x", "24.x"]) {
      expect(namedStep(smoke, `Smoke exact npm artifact on Node ${version}`).run).toBe(
        "node scripts/smoke-packed-package.mjs package-artifacts",
      );
    }
    // Never rebuild or repack the prerequisite artifact once per Node version.
    expect(runLines(smoke).filter((line) => line.startsWith("pnpm "))).toEqual([]);
    expect(smoke.steps?.filter((step) => step.run?.includes("pack:release-package"))).toEqual([]);
  });

  it("keeps npm publication on a strict root allowlist and excludes the dormant TUI entry", () => {
    expect(pkg.files).toEqual([
      "dist",
      "!dist/tui.js",
      "!dist/tui.js.map",
      "!dist/tui.d.ts",
      "!dist/tui.d.ts.map",
      "!dist/tui-v2.jsx",
      "!dist/tui-v2.jsx.map",
      "!dist/tui-v2.d.ts",
      "!dist/tui-v2.d.ts.map",
      "README.md",
      "LICENSE",
    ]);
    expect(pkg.scripts?.["verify:package-contents"]).toBe(
      "node scripts/verify-package-contents.mjs",
    );
    expect(pkg.scripts?.["pack:release-package"]).toBe("node scripts/pack-release-package.mjs");
    expect(pkg.scripts?.["verify:release-package"]).toBe("node scripts/verify-release-package.mjs");
  });

  it("smoke-tests public imports, GUI-only CLI commands, and the absent TUI export", () => {
    expect(packedSmoke).toContain('await import("opencode-quota-gui");');
    expect(packedSmoke).toContain('await import("opencode-quota-gui/server");');
    expect(packedSmoke).toContain('"opencode-quota-gui init"');
    expect(packedSmoke).toContain('"opencode-quota-gui update"');
    expect(packedSmoke).toContain('"opencode-quota-gui --version"');
    expect(packedSmoke).toContain('import("opencode-quota-gui/tui")');
    expect(packedSmoke).toContain("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(packedSmoke).toContain('"dist", "tui.js"');
    expect(packedSmoke).not.toContain('[cliPath, "show"');
    expect(packedSmoke).not.toContain('[cliPath, "status"');
    expect(packedSmoke).not.toContain('["show", "--json"');
    expect(packedSmoke).toContain('const { metrics } = await import("@opentelemetry/api");');
    expect(packedSmoke).toContain('assert.equal(typeof metrics.getMeter, "function");');
    expect(packedSmoke).toContain(
      'assert.equal(pkg.dependencies?.["@opentelemetry/api"], "~1.9.1");',
    );
    expect(packedSmoke).toContain(
      '["devDependencies", "optionalDependencies", "peerDependencies"]',
    );
    expect(packedSmoke).toContain(
      'assert.equal(pkg.peerDependenciesMeta?.["@opentelemetry/api"], undefined);',
    );
    expect(packedSmoke).toContain('rootPackage.devDependencies?.["@opentelemetry/sdk-metrics"]');
    expect(packedSmoke).toContain(
      '[...npm.args, "install", "--omit=dev", `@opentelemetry/sdk-metrics@${sdkMetricsVersion}`]',
    );
    expect(packedSmoke).toContain("smoke-packed-real-otel.mjs");
    expect(packedSmoke).toContain('"happy"');
    expect(packedSmoke).toContain('"disabled"');
    expect(packedSmoke).toContain('"no-global-provider"');
    expect(packedSmoke).toContain('"failing-infrastructure"');
    expect(packedSmoke).toContain('"read-production-openrouter-cache"');
    expect(packedSmoke).toContain('identity: "packed-runtime-dependency"');

    const tarballInstallIndex = packedSmoke.indexOf(
      'run(npm.command, [...npm.args, "install", "--omit=dev", tarball], workdir);',
    );
    const moduleSmokeRunIndex = packedSmoke.indexOf(
      'run(process.execPath, ["--input-type=module", "--eval", moduleSmoke], workdir);',
    );
    const sdkInstallIndex = packedSmoke.indexOf(
      "`@opentelemetry/sdk-metrics@${sdkMetricsVersion}`",
    );
    expect(tarballInstallIndex).toBeGreaterThanOrEqual(0);
    expect(moduleSmokeRunIndex).toBeGreaterThan(tarballInstallIndex);
    expect(sdkInstallIndex).toBeGreaterThan(moduleSmokeRunIndex);

    expect(packedSmoke).not.toContain("@opentelemetry/api@");
    expect(packedSmoke).not.toContain('assert.rejects(import("@opentelemetry/api"))');
    expect(packedSmoke).not.toContain('identity: "packed-absent"');
    expect(packedSmoke).not.toContain("absentOptionalDependencySmoke");
    expect(packedSmoke).not.toContain('"node_modules", "@opentelemetry", "api"');

    expect(packedRealOtelFixture).toContain("new MeterProvider({ readers: [reader] })");
    expect(packedRealOtelFixture).toContain("new PeriodicExportingMetricReader");
    expect(packedRealOtelFixture).toContain("new InMemoryMetricExporter");
    expect(packedRealOtelFixture).toContain("metrics.setGlobalMeterProvider(provider)");
    expect(packedRealOtelFixture).toContain("await provider.forceFlush()");
    expect(packedRealOtelFixture).toContain("await sdk.provider.shutdown()");
    expect(packedRealOtelFixture).toContain("buildQuotaExport");
    expect(packedRealOtelFixture).toContain("disposeQuotaTelemetryOwner");
  });

  it("keeps a minimal manual tag-dispatch release path with the exact packed artifact", () => {
    expect(Object.keys(publishWorkflow.on ?? {})).toEqual(["workflow_dispatch"]);
    expect(Object.keys(publishWorkflow.jobs).sort()).toEqual([
      "publish",
      "release-package",
      "runtime-smoke",
    ]);

    const releasePackage = publishWorkflow.jobs["release-package"];
    const releaseCheckout = namedStep(releasePackage, "Checkout release tag");
    expect(releaseCheckout.uses).toBe("actions/checkout@v6");
    expect(releaseCheckout.with).toEqual({
      ref: TAG_REF,
      "fetch-depth": 0,
      "fetch-tags": true,
    });
    expect(
      releasePackage.steps?.find((step) => step.uses === "actions/setup-node@v6")?.with?.[
        "node-version"
      ],
    ).toBe(24);

    const orderedSteps = [
      "Assert tag, commit, and package version match",
      "Install dependencies",
      "Run canonical verification",
      "Pack and audit the release artifact once",
      "Upload exact release artifact",
    ];
    for (const name of orderedSteps) {
      expect(
        stepIndex(releasePackage, name),
        `Missing ordered release step: ${name}`,
      ).toBeGreaterThanOrEqual(0);
    }
    for (let index = 1; index < orderedSteps.length; index += 1) {
      expect(stepIndex(releasePackage, orderedSteps[index])).toBeGreaterThan(
        stepIndex(releasePackage, orderedSteps[index - 1]),
      );
    }

    const identityStep = namedStep(releasePackage, "Assert tag, commit, and package version match");
    expect(identityStep.env).toEqual({ RELEASE_TAG: "${{ inputs.tag }}" });
    const identityRun = identityStep.run ?? "";
    expect(identityRun).toContain('CHECKED_OUT_SHA="$(git rev-parse HEAD)"');
    expect(identityRun).toContain('TAG_SHA="$(git rev-parse "refs/tags/$RELEASE_TAG^{commit}")"');
    expect(identityRun).toContain("pnpm run verify:release-version");
    expect(namedStep(releasePackage, "Run canonical verification").run).toBe("pnpm verify");
    expectCanonicalVerificationOnly(releasePackage);
    expect(namedStep(releasePackage, "Pack and audit the release artifact once").run).toBe(
      "pnpm run pack:release-package package-artifacts",
    );
    expect(
      releasePackage.steps?.filter((step) => step.run?.includes("pnpm run pack:release-package")),
    ).toHaveLength(1);
    expect(namedStep(releasePackage, "Upload exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts/*",
      "if-no-files-found": "error",
    });

    const smoke = publishWorkflow.jobs["runtime-smoke"];
    expect(smoke.needs).toBe("release-package");
    expect(smoke.strategy?.matrix?.["node-version"]).toEqual(["22.x", "24.x"]);
    expect(namedStep(smoke, "Download exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts",
    });
    expect(
      namedStep(smoke, "Smoke exact release artifact on Node ${{ matrix.node-version }}").run,
    ).toBe("node scripts/smoke-packed-package.mjs package-artifacts");

    const publish = publishWorkflow.jobs.publish;
    expect(publish.if).toBe(NPM_PUBLISH_GUARD);
    expect(publish.needs).toEqual(["release-package", "runtime-smoke"]);
    expect(publish.permissions).toEqual({
      contents: "read",
      "id-token": "write",
    });
    expect(namedStep(publish, "Download exact release artifact").with).toEqual({
      name: "release-package",
      path: "package-artifacts",
    });
    expect(stepIndex(publish, "Choose npm dist-tag")).toBeLessThan(
      stepIndex(publish, "Verify and publish exact release artifact"),
    );
    const publishStep = namedStep(publish, "Verify and publish exact release artifact");
    expect(publishStep.env).toEqual({ DIST_TAG: "${{ steps.dist-tag.outputs.dist-tag }}" });
    const publishRun = publishStep.run ?? "";
    expect(publishRun).toContain("node scripts/verify-release-artifact.mjs package-artifacts");
    expect(publishRun).toContain(
      'npm publish "./${TARBALLS[0]}" --tag "$DIST_TAG" --access public --provenance --ignore-scripts',
    );
    expect(publishRun).not.toContain('npm publish "${TARBALLS[0]}"');
    expect(publishRun).not.toContain("pnpm pack");
    expect(publishRun).not.toContain("pnpm run build");

    for (const job of [releasePackage, smoke, publish]) {
      const checkouts = job.steps?.filter((step) => step.uses === "actions/checkout@v6") ?? [];
      expect(checkouts.length).toBeGreaterThan(0);
      for (const checkout of checkouts) {
        expect(checkout.with?.ref).toBe(TAG_REF);
      }
    }

    // The remote-backfill and retag jobs are gone: no job writes to the repository.
    expect(publishWorkflow.jobs["backfill-version"]).toBeUndefined();
    expect(publishWorkflow.jobs["point-next-at-stable"]).toBeUndefined();
  });

  it("publishes prereleases to the npm next tag and stable releases to latest", () => {
    const chooseTag = namedStep(publishWorkflow.jobs.publish, "Choose npm dist-tag");
    expect(chooseTag.id).toBe("dist-tag");
    expect(chooseTag.env).toEqual({
      RELEASE_TAG: "${{ inputs.tag }}",
    });

    const distTagFor = (tag: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "opencode-quota-dist-tag-"));
      try {
        const output = join(dir, "github-output");
        execFileSync(bash, ["-e", "-c", chooseTag.run ?? "exit 1"], {
          cwd: dir,
          env: {
            ...process.env,
            RELEASE_TAG: tag,
            GITHUB_OUTPUT: "github-output",
          },
          stdio: "ignore",
        });
        return readFileSync(output, "utf8");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(distTagFor("v5.0.0-beta.1")).toBe("dist-tag=next\n");
    expect(distTagFor("v5.0.0")).toBe("dist-tag=latest\n");
  });
});
